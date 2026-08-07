/**
 * scripts/reconcile-commerce-products.ts
 *
 * Phase-3 reconciliation / health-check CLI for the provider-neutral
 * product catalog (`ConnectedCommerceProduct` + `BrandCommerceProduct`).
 * Where `src/lib/commerce/product-sync.ts` fetches and persists a brand's
 * catalog, this tool DETECTS (and, with `--apply`, deterministically
 * repairs) drift and inconsistency the catalog can develop afterward —
 * duplicate rows, cross-brand security holes, denormalization drift, and
 * stale visibility on unavailable products.
 *
 * This file is a THIN CLI WRAPPER ONLY: argument parsing, wiring the real
 * Prisma-backed dependencies, and printing. All reconciliation LOGIC lives
 * in `src/lib/commerce/product-reconciliation.ts` (a pure, dependency-
 * injected module — see its header comment for the full detection/repair
 * matrix), which is exercised without a real DB by
 * `tests/commerce-product-reconciliation.test.ts`. This mirrors the
 * separation `scripts/reconcile-commerce-connections.ts` /
 * `src/lib/commerce/connection-reconciliation.ts` already establish for the
 * Phase-2 connection mirror.
 *
 * Conventions match `scripts/reconcile-commerce-connections.ts`:
 *   - `--flag=value` args parsed with `getArg`.
 *   - DRY RUN BY DEFAULT — `--apply` is REQUIRED to write anything. A dry
 *     run calls the exact same detection path as an apply run; the
 *     underlying reconciliation module never invokes a write-shaped
 *     dependency function (`updateProductBrandId` / `clearVisibility`)
 *     unless `apply: true` is passed in.
 *   - Logs progress/counts to stdout; exits non-zero on unexpected failure.
 *   - NEVER logs a token, encrypted payload, credential, or database URL —
 *     every line printed here comes from `report.lines`/`report.totals`,
 *     which are constructed that way by construction (see the
 *     reconciliation module's header comment). Ids, brand ids, connection
 *     ids, provider names, and external keys are fine to print.
 *   - NEVER hard-deletes a product row, under any flag.
 *
 * Usage:
 *   npx tsx scripts/reconcile-commerce-products.ts                          # dry run, all products
 *   npx tsx scripts/reconcile-commerce-products.ts --apply                  # writes
 *   npx tsx scripts/reconcile-commerce-products.ts --apply --limit=50
 *   npx tsx scripts/reconcile-commerce-products.ts --brand-id=abc123
 *   npx tsx scripts/reconcile-commerce-products.ts --connection-id=def456 --apply
 *   npx tsx scripts/reconcile-commerce-products.ts --provider=SHOPIFY
 *   npx tsx scripts/reconcile-commerce-products.ts --help
 *
 * Exit codes (see HELP_TEXT below for the user-facing copy):
 *   0  success — nothing failed while computing the report (dry run), or
 *      every attempted repair succeeded (apply).
 *   1  one or more per-row repairs failed; the run still completed for
 *      every other row (see `report.totals.failed` and the printed
 *      per-row ERROR lines).
 *   2  invalid command-line usage (e.g. a malformed --limit value, or an
 *      unrecognized --provider); nothing was read or written.
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const VALID_PROVIDERS = ["SHOPIFY", "COMMERCE7"] as const;
type ValidProvider = (typeof VALID_PROVIDERS)[number];

const HELP_TEXT = `Usage:
  npx tsx scripts/reconcile-commerce-products.ts [options]

Detects (and, with --apply, repairs) drift and inconsistency in the
provider-neutral product catalog (ConnectedCommerceProduct +
BrandCommerceProduct). DRY RUN by default -- no database writes happen
unless --apply is passed explicitly.

Options:
  --apply                  Perform repairs. Without this flag, the tool only
                            reports what it WOULD do; zero writes occur.
  --limit=N                 Only scan the first N candidate rows (ordered by
                             id ascending) per table (ConnectedCommerceProduct
                             and BrandCommerceProduct are scanned
                             independently).
  --brand-id=<id>           Restrict ConnectedCommerceProduct rows to this
                             (denormalized) brandId, and BrandCommerceProduct
                             rows to this (selecting) brandId.
  --connection-id=<id>      Restrict to rows attached to this connectionId.
  --provider=<SHOPIFY|COMMERCE7>
                             Restrict to this provider.
  --help, -h                Print this message and exit 0.

Detections reported:
  1. duplicate_external_key    more than one ConnectedCommerceProduct row
                                shares the same (connectionId, externalKey).
                                The DB unique constraint should prevent this
                                going forward; this is a preflight signal
                                against pre-constraint data. NEVER repaired
                                -- there is no principled way to pick a
                                winner, and this tool never hard-deletes a
                                historical product row.
  2. cross_brand_selection     [SECURITY] a BrandCommerceProduct's brandId
                                differs from its connected product's
                                brandId -- a brand curating (and possibly
                                publicly showing) a product it does not own.
                                Always reported prominently as a WARNING.
                                NEVER repaired -- deleting the selection or
                                reassigning the product is ambiguous and
                                this tool refuses to guess.
  3. wrong_brand_product        a ConnectedCommerceProduct's denormalized
                                brandId differs from its connection's
                                brandId. The connection is authoritative, so
                                this IS repaired with --apply: the product's
                                brandId is corrected to match
                                connection.brandId.
  4. unavailable_but_visible    a product is isAvailable=false but a
                                BrandCommerceProduct selecting it still has
                                isVisibleInShop=true. This IS repaired with
                                --apply: isVisibleInShop is cleared (the
                                product cannot be shown regardless).

Never prints a token, encrypted payload, credential, or database URL --
only ids, brand ids, connection ids, provider names, external keys, and
outcome tags.

Idempotent: running with --apply a second time immediately after the first
reports zero repairs needed (every detection is re-derived from current
state, not cached).

Never hard-deletes a ConnectedCommerceProduct or BrandCommerceProduct row,
under any flag.

Exit codes:
  0  success -- (dry run) nothing failed while computing the report, or
     (apply) every repair attempted succeeded.
  1  one or more per-row repairs failed (see the printed "Failed" total and
     per-row ERROR lines); the run still completed for every other row.
  2  invalid command-line usage (e.g. a malformed --limit value, or an
     unrecognized --provider); nothing was read or written.

Examples:
  npx tsx scripts/reconcile-commerce-products.ts
  npx tsx scripts/reconcile-commerce-products.ts --apply
  npx tsx scripts/reconcile-commerce-products.ts --apply --limit=50
  npx tsx scripts/reconcile-commerce-products.ts --brand-id=abc123
  npx tsx scripts/reconcile-commerce-products.ts --connection-id=def456 --apply
  npx tsx scripts/reconcile-commerce-products.ts --provider=SHOPIFY
`;

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function isValidProvider(value: string): value is ValidProvider {
  return (VALID_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Bounded, sanitized rendering of an unexpected top-level failure (e.g. a
 * `PrismaClientInitializationError` thrown before/outside
 * `reconcileCommerceProducts`'s own per-row error handling). Every other
 * line this script prints already comes from `report.lines`/`report.totals`,
 * which are sanitized by construction (see the file header) — this is the
 * one place an arbitrary thrown value could otherwise reach stdout
 * unfiltered.
 *
 * Deliberately prints ONLY `error.name` (a fixed, non-sensitive class name
 * like "PrismaClientInitializationError"), matching the exact
 * `error instanceof Error ? error.name : "unknown error"` convention already
 * used by `product-reconciliation.ts` / `connection-reconciliation.ts` for
 * per-row failures — NEVER `error.message` or the error object itself. A raw
 * `PrismaClientInitializationError.message` embeds the database host and
 * port (e.g. "Can't reach database server at `host`:`port`"), so even a
 * truncated slice of it would still leak that; the name alone carries no
 * connection info and needs no separate length bound.
 */
function formatUnhandledError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
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
  const connectionIdArg = getArg("connection-id");
  const providerArg = getArg("provider");

  if (providerArg && !isValidProvider(providerArg)) {
    console.error(
      `Invalid --provider value: "${providerArg}". Must be one of: ${VALID_PROVIDERS.join(", ")}.`,
    );
    process.exitCode = 2;
    return;
  }
  const validatedProvider: ValidProvider | undefined =
    providerArg && isValidProvider(providerArg) ? providerArg : undefined;

  const { default: prisma } = await import("../src/lib/prisma");
  const { CommerceProvider } = await import("@prisma/client");
  const { reconcileCommerceProducts, buildProductionReconciliationDeps } = await import(
    "../src/lib/commerce/product-reconciliation"
  );

  try {
    console.log("Mode:", apply ? "APPLY" : "DRY RUN");
    if (limit) {
      console.log("Limit:", limit);
    }
    if (brandIdArg) {
      console.log("Brand filter:", brandIdArg);
    }
    if (connectionIdArg) {
      console.log("Connection filter:", connectionIdArg);
    }
    if (providerArg) {
      console.log("Provider filter:", providerArg);
    }

    const deps = buildProductionReconciliationDeps();
    const report = await reconcileCommerceProducts(deps, {
      apply,
      limit,
      brandId: brandIdArg ?? undefined,
      connectionId: connectionIdArg ?? undefined,
      provider: validatedProvider ? CommerceProvider[validatedProvider] : undefined,
    });

    for (const line of report.lines) {
      console.log(line);
    }

    console.log("Reconciliation complete.");
    console.log("Mode:", report.mode === "apply" ? "APPLY" : "DRY RUN");
    console.log("Products scanned:", report.totals.productsScanned);
    console.log("Selections scanned:", report.totals.selectionsScanned);
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
  console.error("Unhandled error:", formatUnhandledError(error));
  process.exitCode = 1;
});
