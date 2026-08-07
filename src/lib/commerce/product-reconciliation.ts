/**
 * src/lib/commerce/product-reconciliation.ts
 *
 * Phase-3 reconciliation / health-check LOGIC for the provider-neutral
 * product catalog (`ConnectedCommerceProduct` + `BrandCommerceProduct`).
 * Same separation as `./connection-reconciliation.ts` (Phase 2) behind
 * `scripts/reconcile-commerce-connections.ts`: this file is a pure,
 * dependency-injected module — every exported entry point takes an explicit
 * `deps` object and returns a typed report, so it is fully unit-testable
 * with in-memory fakes and requires no real DB or network (see
 * `tests/commerce-product-reconciliation.test.ts`). The thin CLI wrapper is
 * `scripts/reconcile-commerce-products.ts` — argument parsing, wiring the
 * real Prisma-backed deps, and printing only; no logic lives there.
 *
 * ---------------------------------------------------------------------------
 * DETECTION CATEGORIES
 * ---------------------------------------------------------------------------
 *   1. duplicate_external_key — more than one `ConnectedCommerceProduct` row
 *      shares the same `(connectionId, externalKey)`. The DB's
 *      `@@unique([connectionId, externalKey])` constraint should prevent
 *      this going forward; detecting it here is a PREFLIGHT signal against
 *      pre-constraint data, never something this tool can safely fix (see
 *      "REPAIRS" below).
 *   2. cross_brand_selection — a `BrandCommerceProduct.brandId` differs from
 *      its `connectedProduct.brandId`. SECURITY-RELEVANT: it means a brand
 *      is curating (and, if `isVisibleInShop`, publicly displaying) a
 *      product it does not own. Always reported as a WARNING, in both dry
 *      run and apply, and never auto-repaired.
 *   3. wrong_brand_product — a `ConnectedCommerceProduct`'s denormalized
 *      `brandId` differs from its `connection.brandId`. The connection is
 *      authoritative (a product is only ever fetched through its
 *      connection's adapter for that connection's brand), so this is
 *      deterministically repairable: reset the product's `brandId` to match
 *      `connection.brandId`.
 *   4. unavailable_but_visible — `isAvailable === false` (provider-removed
 *      or soft-unavailable, per `./product-sync.ts`) while a
 *      `BrandCommerceProduct` selecting it still has `isVisibleInShop ===
 *      true`. Deterministically repairable: the product cannot be shown
 *      regardless, so clearing `isVisibleInShop` is always safe.
 *
 * ---------------------------------------------------------------------------
 * REPAIRS (only with `--apply`; only the two DETERMINISTIC categories)
 * ---------------------------------------------------------------------------
 *   - wrong_brand_product      -> `deps.updateProductBrandId` resets the
 *     product's `brandId` to `connectionBrandId`.
 *   - unavailable_but_visible  -> `deps.clearVisibility` sets
 *     `isVisibleInShop: false` on the offending `BrandCommerceProduct` row.
 *
 * `cross_brand_selection` and `duplicate_external_key` are DELIBERATELY
 * NEVER auto-repaired, even with `--apply`:
 *   - A cross-brand selection could mean either "this `BrandCommerceProduct`
 *     row should be deleted" or "the product's denormalized `brandId` is
 *     actually the one that's wrong" — this tool cannot tell which without
 *     guessing, and guessing wrong either destroys a brand's curation
 *     (`displayOrder`, `titleOverride`, campaign eligibility, approval
 *     history) or leaves a real cross-brand security hole in place. It is
 *     reported prominently instead, for manual investigation.
 *   - A duplicate external key has no principled "winner": both rows are
 *     equally "real" `ConnectedCommerceProduct` history (created before the
 *     unique constraint existed, or from a since-fixed sync bug), and this
 *     tool NEVER hard-deletes a historical product row — picking one to
 *     keep would require deleting (or merging) the other, which is exactly
 *     the operation this tool refuses to perform.
 *
 * This tool NEVER hard-deletes a `ConnectedCommerceProduct` or
 * `BrandCommerceProduct` row, under any flag, in any category.
 *
 * ---------------------------------------------------------------------------
 * SANITIZED OUTPUT
 * ---------------------------------------------------------------------------
 * Every line this module builds (`report.lines`) is composed only from ids,
 * brand ids, connection ids, provider names, external keys, and boolean/enum
 * outcome tags — never a token, encrypted payload, credential, or database
 * URL. Nothing in this module ever reads a secret-shaped column in the first
 * place (see the DB row types below), so there is nothing sensitive to
 * accidentally print.
 */

import type { CommerceProvider } from "@prisma/client";

// ---------------------------------------------------------------------------
// DB row shapes (select-shaped, never the full Prisma model, never a secret column)
// ---------------------------------------------------------------------------

export type ConnectedProductRow = {
  id: string;
  connectionId: string;
  /** Denormalized on `ConnectedCommerceProduct` — may be WRONG; that's category 3. */
  brandId: string;
  /** Authoritative: `connection.brandId`, joined at fetch time. */
  connectionBrandId: string;
  provider: CommerceProvider;
  externalKey: string;
  isAvailable: boolean;
  unavailableSince: Date | null;
};

export type BrandSelectionRow = {
  id: string;
  /** `BrandCommerceProduct.brandId` — the brand doing the selecting. */
  brandId: string;
  connectedProductId: string;
  isVisibleInShop: boolean;
  /** `connectedProduct.brandId`, joined at fetch time — for the cross-brand check. */
  connectedProductBrandId: string;
  /** `connectedProduct.isAvailable`, joined at fetch time — for the unavailable-but-visible check. */
  connectedProductIsAvailable: boolean;
};

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type ProductReconciliationFindingKind =
  | "duplicate_external_key"
  | "cross_brand_selection"
  | "wrong_brand_product"
  | "unavailable_but_visible";

/**
 * One detected issue. `detail` is always built from non-sensitive data (ids,
 * counts, provider names). `repaired` is true only when this run actually
 * performed the fix (always false in dry-run mode, and always false for
 * `duplicate_external_key` / `cross_brand_selection`, which are never
 * auto-repaired).
 */
export type ProductReconciliationFinding = {
  kind: ProductReconciliationFindingKind;
  brandId: string;
  connectionId: string | null;
  detail: string;
  repaired: boolean;
};

export type ProductReconciliationTotals = {
  productsScanned: number;
  selectionsScanned: number;
  /** Deterministic repairs performed (or, in dry-run, that WOULD be performed). */
  created: number;
  updated: number;
  /** Rows with nothing to report. */
  skipped: number;
  /** Anomalies surfaced regardless of repair outcome: duplicate keys + cross-brand selections. */
  warnings: number;
  /** Repair attempts that threw; the run continues with the next row. */
  failed: number;
};

export type ProductReconciliationReport = {
  mode: "dry_run" | "apply";
  totals: ProductReconciliationTotals;
  findings: ProductReconciliationFinding[];
  /** Fully-formatted, sanitized lines ready to print as-is. */
  lines: string[];
};

export type ProductReconciliationOptions = {
  apply: boolean;
  limit?: number;
  brandId?: string;
  connectionId?: string;
  provider?: CommerceProvider;
};

// ---------------------------------------------------------------------------
// Dependency injection (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type ProductReconciliationFilter = {
  brandId?: string;
  connectionId?: string;
  provider?: CommerceProvider;
  limit?: number;
};

export type ProductReconciliationDeps = {
  /**
   * Loads candidate `ConnectedCommerceProduct` rows (joined with their
   * connection's `brandId`), ordered by id ascending, narrowed by `filter`.
   * `filter.brandId` matches the product's OWN (possibly wrong)
   * denormalized `brandId` — this is deliberate: category 3 exists
   * precisely because that column can be wrong, so filtering on it must
   * still surface the offending row.
   */
  listConnectedProducts(filter: ProductReconciliationFilter): Promise<ConnectedProductRow[]>;

  /**
   * Loads candidate `BrandCommerceProduct` rows (joined with their
   * connected product's `brandId` + `isAvailable`), ordered by id
   * ascending, narrowed by `filter`. `filter.brandId` matches the
   * SELECTION's own `brandId` (the brand doing the curating);
   * `filter.connectionId` / `filter.provider` narrow via the joined
   * `connectedProduct`.
   */
  listBrandSelections(filter: ProductReconciliationFilter): Promise<BrandSelectionRow[]>;

  /** Repair (category 3): resets the product's denormalized `brandId` to `connectionBrandId`. */
  updateProductBrandId(productId: string, connectionBrandId: string): Promise<{ updated: boolean }>;

  /** Repair (category 4): clears `isVisibleInShop` on the given `BrandCommerceProduct` row. */
  clearVisibility(brandCommerceProductId: string): Promise<{ updated: boolean }>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

async function defaultListConnectedProducts(
  filter: ProductReconciliationFilter,
): Promise<ConnectedProductRow[]> {
  const prisma = await getPrisma();
  const rows = await prisma.connectedCommerceProduct.findMany({
    where: {
      ...(filter.brandId ? { brandId: filter.brandId } : {}),
      ...(filter.connectionId ? { connectionId: filter.connectionId } : {}),
      ...(filter.provider ? { provider: filter.provider } : {}),
    },
    select: {
      id: true,
      connectionId: true,
      brandId: true,
      provider: true,
      externalKey: true,
      isAvailable: true,
      unavailableSince: true,
      connection: { select: { brandId: true } },
    },
    orderBy: { id: "asc" },
    ...(filter.limit ? { take: filter.limit } : {}),
  });

  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connectionId,
    brandId: row.brandId,
    connectionBrandId: row.connection.brandId,
    provider: row.provider,
    externalKey: row.externalKey,
    isAvailable: row.isAvailable,
    unavailableSince: row.unavailableSince,
  }));
}

async function defaultListBrandSelections(
  filter: ProductReconciliationFilter,
): Promise<BrandSelectionRow[]> {
  const prisma = await getPrisma();
  const rows = await prisma.brandCommerceProduct.findMany({
    where: {
      ...(filter.brandId ? { brandId: filter.brandId } : {}),
      ...(filter.connectionId || filter.provider
        ? {
            connectedProduct: {
              ...(filter.connectionId ? { connectionId: filter.connectionId } : {}),
              ...(filter.provider ? { provider: filter.provider } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      brandId: true,
      connectedProductId: true,
      isVisibleInShop: true,
      connectedProduct: { select: { brandId: true, isAvailable: true } },
    },
    orderBy: { id: "asc" },
    ...(filter.limit ? { take: filter.limit } : {}),
  });

  return rows.map((row) => ({
    id: row.id,
    brandId: row.brandId,
    connectedProductId: row.connectedProductId,
    isVisibleInShop: row.isVisibleInShop,
    connectedProductBrandId: row.connectedProduct.brandId,
    connectedProductIsAvailable: row.connectedProduct.isAvailable,
  }));
}

async function defaultUpdateProductBrandId(
  productId: string,
  connectionBrandId: string,
): Promise<{ updated: boolean }> {
  const prisma = await getPrisma();
  await prisma.connectedCommerceProduct.update({
    where: { id: productId },
    data: { brandId: connectionBrandId },
  });
  return { updated: true };
}

async function defaultClearVisibility(
  brandCommerceProductId: string,
): Promise<{ updated: boolean }> {
  const prisma = await getPrisma();
  await prisma.brandCommerceProduct.update({
    where: { id: brandCommerceProductId },
    data: { isVisibleInShop: false },
  });
  return { updated: true };
}

/** Real Prisma-backed deps, for the CLI wrapper. Lazily imports `@/lib/prisma` — importing this module never requires `DATABASE_URL`. */
export function buildProductionReconciliationDeps(): ProductReconciliationDeps {
  return {
    listConnectedProducts: defaultListConnectedProducts,
    listBrandSelections: defaultListBrandSelections,
    updateProductBrandId: defaultUpdateProductBrandId,
    clearVisibility: defaultClearVisibility,
  };
}

// ---------------------------------------------------------------------------
// Pure detection helpers
// ---------------------------------------------------------------------------

/** Groups rows sharing `(connectionId, externalKey)` where more than one row exists. Pure, no I/O. */
export function findDuplicateExternalKeyGroups(
  rows: readonly ConnectedProductRow[],
): ConnectedProductRow[][] {
  const groups = new Map<string, ConnectedProductRow[]>();
  for (const row of rows) {
    const key = `${row.connectionId}::${row.externalKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/** Rows whose selecting brand differs from the connected product's brand. Pure, no I/O. */
export function findCrossBrandSelections(
  rows: readonly BrandSelectionRow[],
): BrandSelectionRow[] {
  return rows.filter((row) => row.brandId !== row.connectedProductBrandId);
}

/** Rows whose denormalized `brandId` differs from their connection's `brandId`. Pure, no I/O. */
export function findWrongBrandProducts(
  rows: readonly ConnectedProductRow[],
): ConnectedProductRow[] {
  return rows.filter((row) => row.brandId !== row.connectionBrandId);
}

/** Selections that are visible in shop while the underlying product is unavailable. Pure, no I/O. */
export function findUnavailableButVisible(
  rows: readonly BrandSelectionRow[],
): BrandSelectionRow[] {
  return rows.filter((row) => !row.connectedProductIsAvailable && row.isVisibleInShop);
}

function formatLine(
  level: "INFO" | "WARN" | "ERROR",
  brandId: string,
  connectionId: string | null,
  message: string,
): string {
  return `[${level}] brand=${brandId} connection=${connectionId ?? "-"} ${message}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scans candidate `ConnectedCommerceProduct` / `BrandCommerceProduct` rows
 * (see `listConnectedProducts` / `listBrandSelections`), reports every
 * detection category described in the file header, and — only when
 * `opts.apply` is true — performs the two DETERMINISTIC repairs
 * (`wrong_brand_product`, `unavailable_but_visible`). A single repair
 * attempt that throws is counted in `totals.failed` and logged; it never
 * aborts the run (see the CLI wrapper's exit-code contract).
 *
 * Dry run (the default) NEVER calls `updateProductBrandId` or
 * `clearVisibility` — findings are computed purely from what was already
 * fetched, and totals reflect what WOULD happen.
 */
export async function reconcileCommerceProducts(
  deps: ProductReconciliationDeps,
  opts: ProductReconciliationOptions,
): Promise<ProductReconciliationReport> {
  const totals: ProductReconciliationTotals = {
    productsScanned: 0,
    selectionsScanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    warnings: 0,
    failed: 0,
  };
  const findings: ProductReconciliationFinding[] = [];
  const lines: string[] = [];

  const filter: ProductReconciliationFilter = {
    brandId: opts.brandId,
    connectionId: opts.connectionId,
    provider: opts.provider,
    limit: opts.limit,
  };

  const [productRows, selectionRows] = await Promise.all([
    deps.listConnectedProducts(filter),
    deps.listBrandSelections(filter),
  ]);
  totals.productsScanned = productRows.length;
  totals.selectionsScanned = selectionRows.length;

  const touchedProductIds = new Set<string>();
  const touchedSelectionIds = new Set<string>();

  // --- 1. Duplicate external keys — report only, never repaired. ---
  const duplicateGroups = findDuplicateExternalKeyGroups(productRows);
  for (const group of duplicateGroups) {
    totals.warnings += 1;
    const ids = group.map((row) => row.id).join(", ");
    const first = group[0];
    lines.push(
      formatLine(
        "WARN",
        first.brandId,
        first.connectionId,
        `duplicate_external_key: ${group.length} rows share externalKey="${first.externalKey}" ` +
          `(productIds=${ids}); never auto-resolved, manual review required`,
      ),
    );
    findings.push({
      kind: "duplicate_external_key",
      brandId: first.brandId,
      connectionId: first.connectionId,
      detail: `${group.length} rows share (connectionId, externalKey); productIds=${ids}`,
      repaired: false,
    });
    for (const row of group) {
      touchedProductIds.add(row.id);
    }
  }

  // --- 2. Cross-brand selections — SECURITY-RELEVANT, report only, never repaired. ---
  const crossBrandSelections = findCrossBrandSelections(selectionRows);
  for (const row of crossBrandSelections) {
    totals.warnings += 1;
    lines.push(
      formatLine(
        "WARN",
        row.brandId,
        null,
        `cross_brand_selection [SECURITY]: BrandCommerceProduct id=${row.id} brandId=${row.brandId} ` +
          `selects connectedProductId=${row.connectedProductId} owned by brandId=${row.connectedProductBrandId}; ` +
          `never auto-resolved, manual review required`,
      ),
    );
    findings.push({
      kind: "cross_brand_selection",
      brandId: row.brandId,
      connectionId: null,
      detail:
        `BrandCommerceProduct id=${row.id} (brandId=${row.brandId}) selects a product owned by ` +
        `brandId=${row.connectedProductBrandId}`,
      repaired: false,
    });
    touchedSelectionIds.add(row.id);
  }

  // --- 3. Wrong-brand products — deterministic, repaired only with --apply. ---
  const wrongBrandProducts = findWrongBrandProducts(productRows);
  for (const row of wrongBrandProducts) {
    const detail =
      `ConnectedCommerceProduct id=${row.id} brandId=${row.brandId} does not match ` +
      `connection.brandId=${row.connectionBrandId}`;
    lines.push(formatLine("WARN", row.brandId, row.connectionId, `wrong_brand_product: ${detail}`));

    let repaired = false;
    try {
      if (opts.apply) {
        const result = await deps.updateProductBrandId(row.id, row.connectionBrandId);
        repaired = result.updated;
        if (repaired) {
          totals.updated += 1;
          lines.push(
            formatLine(
              "INFO",
              row.connectionBrandId,
              row.connectionId,
              `repaired: productId=${row.id} brandId corrected to ${row.connectionBrandId}`,
            ),
          );
        }
      } else {
        totals.updated += 1;
      }
    } catch (error) {
      totals.failed += 1;
      lines.push(
        formatLine(
          "ERROR",
          row.brandId,
          row.connectionId,
          `failed to repair wrong_brand_product for productId=${row.id}: ` +
            `${error instanceof Error ? error.name : "unknown error"}`,
        ),
      );
    }

    findings.push({
      kind: "wrong_brand_product",
      brandId: row.brandId,
      connectionId: row.connectionId,
      detail,
      repaired,
    });
    touchedProductIds.add(row.id);
  }

  // --- 4. Unavailable-but-visible — deterministic, repaired only with --apply. ---
  const unavailableButVisible = findUnavailableButVisible(selectionRows);
  for (const row of unavailableButVisible) {
    const detail = `BrandCommerceProduct id=${row.id} isVisibleInShop=true but connectedProductId=${row.connectedProductId} isAvailable=false`;
    lines.push(formatLine("WARN", row.brandId, null, `unavailable_but_visible: ${detail}`));

    let repaired = false;
    try {
      if (opts.apply) {
        const result = await deps.clearVisibility(row.id);
        repaired = result.updated;
        if (repaired) {
          totals.updated += 1;
          lines.push(
            formatLine(
              "INFO",
              row.brandId,
              null,
              `repaired: BrandCommerceProduct id=${row.id} isVisibleInShop cleared`,
            ),
          );
        }
      } else {
        totals.updated += 1;
      }
    } catch (error) {
      totals.failed += 1;
      lines.push(
        formatLine(
          "ERROR",
          row.brandId,
          null,
          `failed to repair unavailable_but_visible for BrandCommerceProduct id=${row.id}: ` +
            `${error instanceof Error ? error.name : "unknown error"}`,
        ),
      );
    }

    findings.push({
      kind: "unavailable_but_visible",
      brandId: row.brandId,
      connectionId: null,
      detail,
      repaired,
    });
    touchedSelectionIds.add(row.id);
  }

  totals.skipped =
    productRows.length -
    touchedProductIds.size +
    (selectionRows.length - touchedSelectionIds.size);

  return {
    mode: opts.apply ? "apply" : "dry_run",
    totals,
    findings,
    lines,
  };
}
