/**
 * scripts/reconcile-commerce-connections.ts
 *
 * Phase-2 reconciliation / health-check CLI for the provider-neutral
 * `CommerceConnection` (+ `CommerceConnectionSecret`) mirror. Where
 * `scripts/backfill-commerce-connections.ts` (Phase 1) is a one-shot "bring
 * every brand up to date" sweep, this tool additionally DETECTS and reports
 * every category of drift the mirror can develop after that backfill,
 * including duplicate-primary rows — the exact condition the partial unique
 * index added by migration `20260806130000_commerce_connection_single_primary`
 * rejects, so running this in dry-run mode is the PRE-FLIGHT for that
 * migration.
 *
 * This file is a THIN CLI WRAPPER ONLY: argument parsing, wiring the real
 * Prisma-backed dependencies, and printing. All reconciliation LOGIC lives
 * in `src/lib/commerce/connection-reconciliation.ts` (a pure,
 * dependency-injected module — see its header comment for the full
 * detection/repair matrix), which is exercised without a real DB by
 * `tests/commerce-connection-reconciliation.test.ts`. This mirrors the
 * separation `src/lib/reward-reconciliation.ts` already establishes for the
 * reward reconciliation job.
 *
 * Conventions match `scripts/backfill-commerce-connections.ts`:
 *   - `--flag=value` args parsed with `getArg`.
 *   - DRY RUN BY DEFAULT — `--apply` is REQUIRED to write anything. A dry
 *     run calls the exact same detection path as an apply run, but the
 *     underlying reconciliation module never invokes a write-shaped
 *     dependency function unless `apply: true` is passed in
 *     (`src/lib/commerce/connection-reconciliation.ts`'s `reconcileOneBrand`
 *     branches on it before ever calling `syncBrand` / `rebuildSecret` /
 *     `clearPrimaryFlags`).
 *   - Logs progress/counts to stdout; exits non-zero on unexpected failure.
 *   - NEVER logs a token, encrypted payload, decrypted payload, secret, or
 *     encryption key — every line printed here comes from
 *     `report.lines`/`report.totals`, which are constructed that way by
 *     construction (see the reconciliation module's header comment).
 *
 * Usage:
 *   npx tsx scripts/reconcile-commerce-connections.ts                # dry run, all brands
 *   npx tsx scripts/reconcile-commerce-connections.ts --apply         # writes
 *   npx tsx scripts/reconcile-commerce-connections.ts --apply --limit=50
 *   npx tsx scripts/reconcile-commerce-connections.ts --brand-id=abc123
 *   npx tsx scripts/reconcile-commerce-connections.ts --shop-domain=acme.myshopify.com --apply
 *   npx tsx scripts/reconcile-commerce-connections.ts --help
 *
 * Exit codes (see HELP_TEXT below for the user-facing copy):
 *   0  success — nothing failed while computing the report (dry run), or
 *      every attempted repair succeeded (apply).
 *   1  one or more per-brand operations failed; the run still completed for
 *      every other brand (see `report.totals.failed` and the printed
 *      per-brand ERROR lines).
 *   2  invalid command-line usage (e.g. a malformed --limit value); nothing
 *      was read or written.
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const HELP_TEXT = `Usage:
  npx tsx scripts/reconcile-commerce-connections.ts [options]

Detects (and, with --apply, repairs) drift between legacy Brand.shopify*
columns and the provider-neutral CommerceConnection / CommerceConnectionSecret
mirror. DRY RUN by default -- no database writes happen unless --apply is
passed explicitly.

Options:
  --apply                 Perform repairs. Without this flag, the tool only
                           reports what it WOULD do; zero writes occur.
  --limit=N                Only scan the first N candidate brands (ordered by
                            id ascending) -- same convention as
                            scripts/backfill-commerce-connections.ts.
  --brand-id=<id>          Restrict to a single brand id.
  --shop-domain=<domain>   Restrict to brands whose Shopify shop domain
                           matches (normalized: trimmed + lowercased).
  --help, -h               Print this message and exit 0.

Detections reported:
  1. missing_connection_row     brand has legacy Shopify state but no
                                 CommerceConnection row.
  2. stale_connection_metadata  a CommerceConnection row exists but one or
                                 more synced fields disagree with legacy
                                 Brand.shopify* truth.
  3. missing_secret             the connection has no
                                 CommerceConnectionSecret even though the
                                 brand currently holds credentials.
  4. stale_secret_mirror        the secret exists but its decrypted
                                 contents no longer match the brand's
                                 current credentials.
  5. duplicate_primary          more than one CommerceConnection row is
                                 marked isPrimary for the same
                                 (brandId, provider) -- exactly what the
                                 partial unique index added by migration
                                 20260806130000_commerce_connection_single_primary
                                 rejects. Always reported, prominently, as a
                                 WARNING -- in both dry-run and apply.

Repairs performed with --apply (never otherwise):
  - missing/stale connection row  -> syncShopifyCommerceConnectionForBrand
                                      (src/lib/commerce/connection-sync.ts)
  - missing/stale secret mirror   -> rebuildShopifyConnectionSecretForBrand
                                      (src/lib/commerce/connection-sync.ts)
  - duplicate primaries           -> keep whichever row's externalAccountId
                                      matches the brand's CURRENT shop domain
                                      (falling back to whichever row
                                      pickPreferredConnectionRow would choose
                                      only when none match), clear isPrimary
                                      on the rest (never transiently creates
                                      a second primary)

Never prints a token, encrypted payload, decrypted payload, secret, or
encryption key -- only brand ids, shop domains, connection ids, and outcome
tags.

Idempotent: running with --apply a second time immediately after the first
reports zero repairs needed (every detection is re-derived from current
state, not cached).

Exit codes:
  0  success -- (dry run) nothing failed while computing the report, or
     (apply) every repair attempted succeeded.
  1  one or more per-brand operations failed (see the printed "Failed"
     total and per-brand ERROR lines); the run still completed for every
     other brand.
  2  invalid command-line usage (e.g. a malformed --limit value); nothing
     was read or written.

Examples:
  npx tsx scripts/reconcile-commerce-connections.ts
  npx tsx scripts/reconcile-commerce-connections.ts --apply
  npx tsx scripts/reconcile-commerce-connections.ts --apply --limit=50
  npx tsx scripts/reconcile-commerce-connections.ts --brand-id=abc123
  npx tsx scripts/reconcile-commerce-connections.ts --shop-domain=acme.myshopify.com --apply
`;

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }

  const apply = process.argv.includes("--apply");

  const limitArg = getArg("limit");
  const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;
  if (limitArg && (!Number.isFinite(limit) || (limit as number) <= 0)) {
    console.error(`Invalid --limit value: "${limitArg}". Must be a positive integer.`);
    process.exitCode = 2;
    return;
  }

  const brandIdArg = getArg("brand-id");
  const shopDomainArg = getArg("shop-domain");

  const { default: prisma } = await import("../src/lib/prisma");
  const { normalizeExternalAccountId } = await import("../src/lib/commerce/connection-sync");
  const { reconcileCommerceConnections, buildProductionReconciliationDeps } = await import(
    "../src/lib/commerce/connection-reconciliation"
  );

  try {
    const shopDomain = shopDomainArg ? normalizeExternalAccountId(shopDomainArg) : undefined;

    console.log("Mode:", apply ? "APPLY" : "DRY RUN");
    if (limit) {
      console.log("Limit:", limit);
    }
    if (brandIdArg) {
      console.log("Brand filter:", brandIdArg);
    }
    if (shopDomain) {
      console.log("Shop domain filter:", shopDomain);
    }

    const deps = buildProductionReconciliationDeps();
    const report = await reconcileCommerceConnections(deps, {
      apply,
      limit,
      brandId: brandIdArg ?? undefined,
      shopDomain,
    });

    for (const line of report.lines) {
      console.log(line);
    }

    console.log("Reconciliation complete.");
    console.log("Mode:", report.mode === "apply" ? "APPLY" : "DRY RUN");
    console.log("Brands scanned:", report.totals.brandsScanned);
    console.log("Created:", report.totals.created);
    console.log("Updated:", report.totals.updated);
    console.log("Skipped:", report.totals.skipped);
    console.log("Warnings:", report.totals.warnings);
    console.log("Failed:", report.totals.failed);

    if (!apply) {
      console.log("Dry run complete. No DB changes made. Pass --apply to write.");
    }

    process.exitCode = report.totals.failed > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
