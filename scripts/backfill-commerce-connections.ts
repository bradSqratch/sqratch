/**
 * scripts/backfill-commerce-connections.ts
 *
 * One-off / re-runnable backfill that brings every Brand with a Shopify
 * connection up to date in the provider-neutral `CommerceConnection` (+
 * `CommerceConnectionSecret`) mirror, using the exact same idempotent sync
 * (`syncShopifyCommerceConnectionForBrand`) the Phase-1 dual-write uses at
 * install time. Safe to run repeatedly: the upsert is keyed on
 * `CommerceConnection`'s `@@unique([provider, externalAccountId])`
 * constraint, so a second run against an already-synced brand always
 * resolves to "updated" for that brand's row, never a duplicate "created".
 *
 * Also the intended remedy for the Phase-1 secret-staleness caveat
 * documented in `src/lib/commerce/connection-sync.ts`: an EXPIRING_OFFLINE
 * brand whose access token rotates between lifecycle events will have a
 * stale `CommerceConnectionSecret` until either the next lifecycle event or
 * a re-run of this script.
 *
 * Conventions follow `scripts/import-legacy-printed-stickers.ts`:
 *   - `--flag=value` args parsed with `getArg`.
 *   - Defaults to `--apply` being REQUIRED to write; without it, this is a
 *     dry run. This is the SAFER of the two options the task called out,
 *     and matches `import-legacy-printed-stickers.ts` exactly (`const apply
 *     = process.argv.includes("--apply"); const dryRun = !apply;`) — a
 *     backfill script should never mutate data by default.
 *   - Logs progress/counts to stdout; exits non-zero on unexpected failure.
 *   - Never logs a token, encrypted payload, or the encryption key. Shop
 *     domains and brand ids are fine (same sensitivity level as the
 *     existing sanitized route/webhook logs in this codebase).
 *
 * Usage:
 *   npx tsx scripts/backfill-commerce-connections.ts                # dry run
 *   npx tsx scripts/backfill-commerce-connections.ts --apply         # writes
 *   npx tsx scripts/backfill-commerce-connections.ts --apply --limit=50
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

function getArg(name: string) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  const { default: prisma } = await import("../src/lib/prisma");
  const { syncShopifyCommerceConnectionForBrand } = await import(
    "../src/lib/commerce/connection-sync"
  );

  try {
    const apply = process.argv.includes("--apply");
    const dryRun = !apply;
    const limitArg = getArg("limit");
    const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;

    if (limitArg && (!Number.isFinite(limit) || (limit as number) <= 0)) {
      throw new Error(`Invalid --limit value: "${limitArg}". Must be a positive integer.`);
    }

    console.log("Mode:", dryRun ? "DRY RUN" : "APPLY");
    if (limit) {
      console.log("Limit:", limit);
    }

    const brands = await prisma.brand.findMany({
      where: { shopifyShopDomain: { not: null } },
      select: { id: true, shopifyShopDomain: true },
      orderBy: { id: "asc" },
      ...(limit ? { take: limit } : {}),
    });

    console.log("Brands with a Shopify shop domain:", brands.length);

    if (dryRun) {
      // Dry run reports what WOULD be synced without calling the writer at
      // all, so a dry run can never write — not even accidentally via a
      // code path inside the sync function.
      for (const brand of brands) {
        console.log(`  would sync brand=${brand.id} shop=${brand.shopifyShopDomain}`);
      }
      console.log("Dry run complete. No DB changes made. Pass --apply to write.");
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const brand of brands) {
      try {
        const result = await syncShopifyCommerceConnectionForBrand(brand.id);
        if (result.outcome === "created") {
          created += 1;
        } else if (result.outcome === "updated") {
          updated += 1;
        } else {
          skipped += 1;
          console.log(
            `  skipped brand=${brand.id} shop=${brand.shopifyShopDomain} reason=${result.outcome}`,
          );
        }
      } catch (error) {
        failed += 1;
        // Sanitized: brand id + shop domain only — never the caught error
        // object (could in principle wrap a crypto/DB driver message).
        console.error(
          `  failed brand=${brand.id} shop=${brand.shopifyShopDomain}`,
          error instanceof Error ? error.name : "unknown error",
        );
      }
    }

    console.log("Backfill complete.");
    console.log("Created:", created);
    console.log("Updated:", updated);
    console.log("Skipped:", skipped);
    console.log("Failed:", failed);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
