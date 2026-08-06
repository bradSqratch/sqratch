/**
 * src/lib/commerce/connection-reconciliation.ts
 *
 * Phase-2 reconciliation / health-check LOGIC for the provider-neutral
 * `CommerceConnection` (+ `CommerceConnectionSecret`) mirror. This is the
 * pure, dependency-injected core behind `scripts/reconcile-commerce-connections.ts`
 * — same separation as `src/lib/reward-reconciliation.ts` /
 * its route: every exported function here takes an explicit `deps` object
 * and returns a typed report, so it is fully unit-testable with in-memory
 * fakes and requires no real DB or network (see
 * `tests/commerce-connection-reconciliation.test.ts`).
 *
 * DELIBERATELY REUSES, NEVER RE-IMPLEMENTS:
 *   - `buildShopifyConnectionSyncInput` / `syncShopifyCommerceConnectionForBrand`
 *     / `rebuildShopifyConnectionSecretForBrand` / `normalizeExternalAccountId`
 *     / `determineShopifySecretRebuildOutcome` (`./connection-sync.ts`) — the
 *     Phase-1 dual-write and its secret-rebuild helper. This module never
 *     hand-rolls a second "is the secret stale" comparison; it reuses the
 *     exact decrypt-and-compare predicate `rebuildShopifyConnectionSecretForBrand`
 *     itself uses (see the header comment on `determineShopifySecretRebuildOutcome`
 *     for why that small, purely-additive export was necessary).
 *   - `detectConnectionDrift` (`./connection-service.ts`) — the existing
 *     domain-level (externalAccountId) drift signal between a
 *     `CommerceConnection` row and legacy `Brand.shopifyShopDomain` truth.
 *     Called here with in-memory-backed deps (the brand + rows this module
 *     already fetched for the current brand) rather than a second DB round
 *     trip.
 *   - `pickPreferredConnectionRow` (`./connection-resolver.ts`) — the same
 *     tiebreak used everywhere else in this codebase to pick which
 *     `CommerceConnection` row wins when more than one exists for a
 *     (brandId, provider) pair. Duplicate-primary resolution below (see
 *     `pickDuplicatePrimaryWinner`) first prefers whichever candidate row's
 *     `externalAccountId` matches the brand's CURRENT normalized
 *     `Brand.shopifyShopDomain` — the row that is actually live right now —
 *     and only falls back to whichever row `pickPreferredConnectionRow`
 *     would choose (never a second, divergent ordering of its own) when no
 *     candidate matches that current domain. It then clears `isPrimary` on
 *     the rest.
 *
 * DETECTION CATEGORIES (mirrors the CLI's --help text):
 *   1. missing_connection_row    — brand has legacy Shopify state (a shop
 *      domain on record) but no `CommerceConnection` row exists for it yet.
 *      Surfaced via `detectConnectionDrift`'s `LEGACY_DOMAIN_WITHOUT_ROW`.
 *   2. stale_connection_metadata — a row exists for the brand's CURRENT shop
 *      domain, but one or more synced fields (status, displayName,
 *      storefrontUrl, grantedScopes, installedAt, uninstalledAt,
 *      lastProductSyncAt) disagree with what `buildShopifyConnectionSyncInput`
 *      derives from legacy truth right now. Also covers
 *      `detectConnectionDrift`'s `ROW_LEGACY_MISMATCH` case (the preferred
 *      row belongs to a stale/relinked-away domain) — re-syncing upserts the
 *      row keyed on the CURRENT domain, exactly like a normal relink.
 *   3. missing_secret            — the connection has no
 *      `CommerceConnectionSecret` even though the brand currently holds
 *      credentials. Reported via `determineShopifySecretRebuildOutcome`
 *      returning `"created"`.
 *   4. stale_secret_mirror       — the secret exists but no longer matches
 *      the brand's current credentials (decrypt-and-compare, never exposed).
 *      Reported via `determineShopifySecretRebuildOutcome` returning
 *      `"rebuilt"`.
 *   5. duplicate_primary         — more than one `CommerceConnection` row is
 *      `isPrimary: true` for the same (brandId, SHOPIFY) — exactly the
 *      condition the partial unique index added by migration
 *      `20260806130000_commerce_connection_single_primary` rejects. Always
 *      reported (both dry-run and apply) so it surfaces prominently even
 *      when this run's repair fixes it.
 *
 * REPAIR / DECISION SHAPE: every repairable finding is decided FIRST as a
 * pure "what would happen" outcome (`created` / `updated` / `up_to_date` /
 * `no_credentials` / ...), independent of whether `--apply` was passed. In
 * dry-run mode the decision alone drives the report's totals (nothing is
 * written). In apply mode the SAME decision path additionally invokes the
 * injected write function and re-derives the outcome from what it actually
 * returned — so `report.totals` in apply mode always reflects real work
 * done, never a stale prediction (see test 7 in the accompanying test file).
 *
 * NEVER logs, returns, or otherwise exposes a token, encrypted payload,
 * decrypted payload, secret, or encryption key. `findConnectionSecretPayload`
 * below is the one place this module reads an `encryptedPayload` string at
 * all, and it flows ONLY into `determineShopifySecretRebuildOutcome` (which
 * itself never returns the value it was given) — never into a log line,
 * finding, or the returned report.
 */

import { CommerceProvider } from "@prisma/client";
import {
  buildShopifyConnectionSyncInput,
  determineShopifySecretRebuildOutcome,
  normalizeExternalAccountId,
  rebuildShopifyConnectionSecretForBrand,
  syncShopifyCommerceConnectionForBrand,
  type LegacyBrandForShopifySync,
  type RebuildShopifyConnectionSecretResult,
  type ShopifyConnectionSyncInput,
  type ShopifyConnectionSyncResult,
} from "./connection-sync";
import {
  detectConnectionDrift,
  type CommerceConnectionRow,
  type CommerceConnectionServiceDeps,
} from "./connection-service";
import {
  normalizeGrantedScopesJson,
  pickPreferredConnectionRow,
} from "./connection-resolver";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type ReconciliationFindingKind =
  | "missing_connection_row"
  | "stale_connection_metadata"
  | "missing_secret"
  | "stale_secret_mirror"
  | "duplicate_primary";

/**
 * One detected issue for one brand. `detail` is always built from
 * non-sensitive data (field names, counts, connection ids, outcome tags) —
 * never a credential value. `repaired` is true only when this run actually
 * performed the fix (always false in dry-run mode).
 */
export type ReconciliationFinding = {
  brandId: string;
  shopDomain: string;
  kind: ReconciliationFindingKind;
  detail: string;
  repaired: boolean;
};

export type ReconciliationTotals = {
  brandsScanned: number;
  /** Connection rows / secrets created (or, in dry-run, that WOULD be created). */
  created: number;
  /** Connection rows / secrets refreshed, or duplicate-primary rows cleared (or WOULD be, in dry-run). */
  updated: number;
  /** Brands with no Shopify state, or with nothing to reconcile. */
  skipped: number;
  /** Notable anomalies surfaced regardless of repair outcome — currently only duplicate-primary groups. */
  warnings: number;
  /** Brands whose processing threw; the run continues with the next brand. */
  failed: number;
};

export type ReconciliationReport = {
  mode: "dry_run" | "apply";
  totals: ReconciliationTotals;
  findings: ReconciliationFinding[];
  /**
   * Fully-formatted, sanitized lines ready to print as-is — the CLI wrapper
   * does no further string-building of its own beyond totals/mode, matching
   * the "thin wrapper" requirement.
   */
  lines: string[];
};

export type ReconciliationOptions = {
  apply: boolean;
  limit?: number;
  brandId?: string;
  /** Already normalized (trim + lowercase) — the CLI wrapper normalizes via `normalizeExternalAccountId` before calling in. */
  shopDomain?: string;
};

// ---------------------------------------------------------------------------
// Dependency injection (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type CandidateBrandFilter = {
  brandId?: string;
  shopDomain?: string;
  limit?: number;
};

export type ConnectionReconciliationDeps = {
  /**
   * Loads candidate brands. With no filter, this is every brand with a
   * non-null `shopifyShopDomain` (the same universe
   * `scripts/backfill-commerce-connections.ts` scans), ordered by id
   * ascending. `brandId`/`shopDomain`, when given, narrow (AND) rather than
   * replace that default — and may return a brand with NO shop domain at
   * all when filtered by id, which the reconciliation loop below treats as
   * "skipped: no Shopify state", not an error.
   */
  listCandidateBrands(filter: CandidateBrandFilter): Promise<LegacyBrandForShopifySync[]>;

  /** Loads every `CommerceConnection` row for (brandId, provider). */
  findConnectionRows(
    brandId: string,
    provider: CommerceProvider,
  ): Promise<CommerceConnectionRow[]>;

  /**
   * Reads ONLY the encrypted secret blob for a connection (or `null`), for
   * the dry-run staleness PREVIEW — never decrypted or logged here. Fed
   * straight into `determineShopifySecretRebuildOutcome`.
   */
  findConnectionSecretPayload(
    connectionId: string,
  ): Promise<{ encryptedPayload: string } | null>;

  /** Repair: idempotent connection (+secret) sync — reused unchanged from `./connection-sync.ts`. */
  syncBrand(brandId: string): Promise<ShopifyConnectionSyncResult>;

  /** Repair: idempotent secret-mirror rebuild — reused unchanged from `./connection-sync.ts`. */
  rebuildSecret(brandId: string): Promise<RebuildShopifyConnectionSecretResult>;

  /** Repair: clears `isPrimary` on the given connection ids (duplicate-primary resolution). */
  clearPrimaryFlags(connectionIds: string[]): Promise<{ count: number }>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

/** Mirrors `defaultFindBrandForSync`'s select in `./connection-sync.ts` — kept in sync manually since that select is not exported. */
const LEGACY_BRAND_FOR_SYNC_SELECT = {
  id: true,
  name: true,
  shopifyShopDomain: true,
  shopifyAdminAccessTokenEncrypted: true,
  shopifyInstalledAt: true,
  shopifyUninstalledAt: true,
  shopifyConnectionStatus: true,
  shopifyLastProductSyncAt: true,
  shopifyCurrencyCode: true,
  shopifyAccessTokenExpiresAt: true,
  shopifyRefreshTokenEncrypted: true,
  shopifyRefreshTokenExpiresAt: true,
  shopifyGrantedScopes: true,
  shopifyClientId: true,
  shopifyAuthMode: true,
} as const;

/** Mirrors `CONNECTION_ROW_SELECT` in `./connection-service.ts` — kept in sync manually since that select is not exported. */
const CONNECTION_ROW_SELECT = {
  id: true,
  brandId: true,
  provider: true,
  status: true,
  displayName: true,
  externalAccountId: true,
  storefrontUrl: true,
  isPrimary: true,
  grantedScopes: true,
  installedAt: true,
  uninstalledAt: true,
  lastProductSyncAt: true,
  createdAt: true,
} as const;

async function defaultListCandidateBrands(
  filter: CandidateBrandFilter,
): Promise<LegacyBrandForShopifySync[]> {
  const prisma = await getPrisma();

  const where = filter.brandId
    ? filter.shopDomain
      ? { id: filter.brandId, shopifyShopDomain: filter.shopDomain }
      : { id: filter.brandId }
    : filter.shopDomain
      ? { shopifyShopDomain: filter.shopDomain }
      : { shopifyShopDomain: { not: null } };

  return prisma.brand.findMany({
    where,
    select: LEGACY_BRAND_FOR_SYNC_SELECT,
    orderBy: { id: "asc" },
    ...(filter.limit ? { take: filter.limit } : {}),
  });
}

async function defaultFindConnectionRows(
  brandId: string,
  provider: CommerceProvider,
): Promise<CommerceConnectionRow[]> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findMany({
    where: { brandId, provider },
    select: CONNECTION_ROW_SELECT,
  });
}

async function defaultFindConnectionSecretPayload(
  connectionId: string,
): Promise<{ encryptedPayload: string } | null> {
  const prisma = await getPrisma();
  return prisma.commerceConnectionSecret.findUnique({
    where: { connectionId },
    select: { encryptedPayload: true },
  });
}

async function defaultClearPrimaryFlags(
  connectionIds: string[],
): Promise<{ count: number }> {
  if (connectionIds.length === 0) {
    return { count: 0 };
  }
  const prisma = await getPrisma();
  const result = await prisma.commerceConnection.updateMany({
    where: { id: { in: connectionIds } },
    data: { isPrimary: false },
  });
  return { count: result.count };
}

/** Real Prisma + connection-sync-backed deps, for the CLI wrapper. Lazily imports `@/lib/prisma` — importing this module never requires `DATABASE_URL`. */
export function buildProductionReconciliationDeps(): ConnectionReconciliationDeps {
  return {
    listCandidateBrands: defaultListCandidateBrands,
    findConnectionRows: defaultFindConnectionRows,
    findConnectionSecretPayload: defaultFindConnectionSecretPayload,
    syncBrand: (brandId) => syncShopifyCommerceConnectionForBrand(brandId),
    rebuildSecret: (brandId) => rebuildShopifyConnectionSecretForBrand(brandId),
    clearPrimaryFlags: defaultClearPrimaryFlags,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function dateTimeDiffers(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return a.getTime() !== b.getTime();
}

function stringArraysDiffer(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((value, index) => value !== b[index]);
}

/**
 * Pure comparison: which of `row`'s synced fields disagree with `expected`
 * (derived from CURRENT legacy Brand truth via `buildShopifyConnectionSyncInput`).
 * Only called once the row's `externalAccountId` is already known to match
 * the current shop domain — a domain mismatch is `detectConnectionDrift`'s
 * job, not this function's. Returns the list of disagreeing field names
 * (empty when nothing is stale) — never a field VALUE, only its name, so a
 * caller can safely log the result.
 */
export function findStaleConnectionFields(
  row: CommerceConnectionRow,
  expected: ShopifyConnectionSyncInput,
): string[] {
  const stale: string[] = [];
  if (row.status !== expected.status) stale.push("status");
  if (row.displayName !== expected.displayName) stale.push("displayName");
  if ((row.storefrontUrl ?? null) !== expected.storefrontUrl) stale.push("storefrontUrl");
  if (stringArraysDiffer(normalizeGrantedScopesJson(row.grantedScopes), expected.grantedScopes)) {
    stale.push("grantedScopes");
  }
  if (dateTimeDiffers(row.installedAt, expected.installedAt)) stale.push("installedAt");
  if (dateTimeDiffers(row.uninstalledAt, expected.uninstalledAt)) stale.push("uninstalledAt");
  if (dateTimeDiffers(row.lastProductSyncAt, expected.lastProductSyncAt)) {
    stale.push("lastProductSyncAt");
  }
  return stale;
}

/**
 * Which of a duplicate-primary group `--apply` should keep (and dry-run
 * should preview keeping). Prefers the row whose (normalized)
 * `externalAccountId` equals the brand's CURRENT normalized
 * `Brand.shopifyShopDomain` — the store that is actually live right now —
 * over `pickPreferredConnectionRow`'s generic `installedAt`/`createdAt`
 * tiebreak, which has no notion of "current" and can otherwise prefer a
 * stale relinked-away row simply because it happens to have a more recent
 * `installedAt` (the exact post-relink scenario this detection category
 * exists to repair). Falls back to `pickPreferredConnectionRow` — never
 * reimplemented, only reused — when no candidate matches the current domain
 * (including when `shopDomain` is `null`, i.e. the brand has no shop domain
 * on record at all).
 */
export function pickDuplicatePrimaryWinner(
  primaryRows: readonly CommerceConnectionRow[],
  shopDomain: string | null,
): CommerceConnectionRow | null {
  if (shopDomain) {
    const domainMatch = primaryRows.find(
      (row) => normalizeExternalAccountId(row.externalAccountId) === shopDomain,
    );
    if (domainMatch) {
      return domainMatch;
    }
  }
  return pickPreferredConnectionRow(primaryRows);
}

function formatLine(
  level: "INFO" | "WARN" | "ERROR",
  brandId: string,
  shopDomain: string | null,
  message: string,
): string {
  return `[${level}] brand=${brandId} shop=${shopDomain ?? "-"} ${message}`;
}

// ---------------------------------------------------------------------------
// Per-brand reconciliation
// ---------------------------------------------------------------------------

async function reconcileOneBrand(
  brand: LegacyBrandForShopifySync,
  apply: boolean,
  deps: ConnectionReconciliationDeps,
  totals: ReconciliationTotals,
  findings: ReconciliationFinding[],
  lines: string[],
): Promise<void> {
  const shopDomain = brand.shopifyShopDomain
    ? normalizeExternalAccountId(brand.shopifyShopDomain)
    : null;

  if (!shopDomain) {
    totals.skipped += 1;
    lines.push(formatLine("INFO", brand.id, null, "skipped: no Shopify state on record"));
    return;
  }

  const rows = await deps.findConnectionRows(brand.id, CommerceProvider.SHOPIFY);
  let anyIssue = false;

  // --- 5. Duplicate primaries — checked first and always reported, per the
  // "report prominently" requirement, independent of the other checks below. ---
  const primaryRows = rows.filter((row) => row.isPrimary);
  if (primaryRows.length > 1) {
    anyIssue = true;
    totals.warnings += 1;
    const winner = pickDuplicatePrimaryWinner(primaryRows, shopDomain);
    const loserIds = primaryRows
      .filter((row) => row.id !== winner?.id)
      .map((row) => row.id);

    lines.push(
      formatLine(
        "WARN",
        brand.id,
        shopDomain,
        `duplicate primary connections detected (${primaryRows.length}) for provider=SHOPIFY; ` +
          `preferred connectionId=${winner?.id ?? "unknown"}`,
      ),
    );

    let repaired = false;
    if (apply && winner && loserIds.length > 0) {
      const result = await deps.clearPrimaryFlags(loserIds);
      totals.updated += result.count;
      repaired = result.count === loserIds.length;
      // Keep this pass's in-memory `rows` snapshot consistent with what was
      // just written: downstream `detectConnectionDrift` below reads this
      // SAME `rows` array (via `driftDeps`), and its own domain-unaware
      // `pickPreferredConnectionRow` tiebreak could otherwise still land on
      // a loser we just cleared (e.g. it has a more recent `installedAt`),
      // report a spurious legacy mismatch, and trigger a full `syncBrand`
      // re-sync that recomputes `isPrimary` from a CONNECTED-sibling count
      // that still includes that loser — undoing this repair in the same
      // pass. Only done in apply mode: dry-run performs no write, so the
      // unmodified snapshot correctly reflects the DB's current (unrepaired)
      // state for the other detections below.
      const loserIdSet = new Set(loserIds);
      for (const row of rows) {
        if (loserIdSet.has(row.id)) {
          row.isPrimary = false;
        }
      }
      lines.push(
        formatLine(
          "INFO",
          brand.id,
          shopDomain,
          `cleared isPrimary on ${result.count} duplicate connection(s), kept connectionId=${winner.id}`,
        ),
      );
    } else if (winner && loserIds.length > 0) {
      totals.updated += loserIds.length;
    }

    findings.push({
      brandId: brand.id,
      shopDomain,
      kind: "duplicate_primary",
      detail: `${primaryRows.length} isPrimary rows; would keep connectionId=${winner?.id ?? "unknown"}`,
      repaired,
    });
  }

  // --- 1 & 2. Missing / stale connection row (domain-level via detectConnectionDrift, field-level via findStaleConnectionFields) ---
  const driftDeps: Partial<CommerceConnectionServiceDeps> = {
    findConnectionRows: async () => rows,
    findLegacyBrandFields: async () => brand,
  };
  const drift = await detectConnectionDrift(brand.id, CommerceProvider.SHOPIFY, driftDeps);

  const matchingRow =
    rows.find((row) => normalizeExternalAccountId(row.externalAccountId) === shopDomain) ?? null;

  const syncInput = buildShopifyConnectionSyncInput(brand);
  // Unreachable: shopDomain !== null above guarantees buildShopifyConnectionSyncInput
  // returns non-null (its only null case is a missing shop domain).
  if (!syncInput) {
    totals.skipped += 1;
    lines.push(formatLine("INFO", brand.id, shopDomain, "skipped: no Shopify state on record"));
    return;
  }

  const staleFields = matchingRow ? findStaleConnectionFields(matchingRow, syncInput) : [];
  const connectionMissing = !matchingRow;
  const connectionStale = matchingRow !== null && staleFields.length > 0;
  const isDriftMismatch = drift.driftDetected && drift.reason === "ROW_LEGACY_MISMATCH";

  let connectionId: string | null = matchingRow?.id ?? null;

  if (connectionMissing || connectionStale || isDriftMismatch) {
    anyIssue = true;
    const kind: ReconciliationFindingKind = connectionMissing
      ? "missing_connection_row"
      : "stale_connection_metadata";
    const detail = connectionMissing
      ? "no CommerceConnection row for this brand's current shop domain"
      : isDriftMismatch && staleFields.length === 0
        ? "preferred connection row belongs to a stale/relinked-away domain"
        : `stale fields: ${staleFields.join(", ")}`;

    lines.push(formatLine("WARN", brand.id, shopDomain, `${kind}: ${detail}`));

    let repaired = false;
    if (apply) {
      const result = await deps.syncBrand(brand.id);
      connectionId = result.connectionId;
      if (result.outcome === "created") {
        totals.created += 1;
        repaired = true;
      } else if (result.outcome === "updated") {
        totals.updated += 1;
        repaired = true;
      }
      lines.push(
        formatLine("INFO", brand.id, shopDomain, `synced connection: outcome=${result.outcome}`),
      );
    } else if (connectionMissing) {
      totals.created += 1;
    } else {
      totals.updated += 1;
    }

    findings.push({ brandId: brand.id, shopDomain, kind, detail, repaired });
  }

  // --- 3 & 4. Missing / stale credential mirror (CommerceConnectionSecret) ---
  //
  // Printed lines below deliberately say "credential mirror" rather than the
  // literal word this row's type name contains — never a token, encrypted
  // payload, decrypted payload, or that literal word itself reaches stdout,
  // matching the CLI's documented guarantee (see the test asserting no
  // output line matches /token|secret|encrypted|password/i). The `kind` tag
  // on each finding below keeps its precise internal name; only `detail`
  // strings and printed lines are reworded.
  const hasCredentials = brand.shopifyAdminAccessTokenEncrypted !== null;
  const connectionWasJustRepaired = apply && (connectionMissing || connectionStale || isDriftMismatch);

  if (connectionWasJustRepaired) {
    // syncBrand's own transaction already created/updated/deleted the
    // credential mirror as part of the same sync (see
    // applyShopifyConnectionSync) — calling rebuildSecret again here would
    // be redundant (and, while harmless since it's idempotent, would
    // double-count totals). Nothing further to do.
  } else if (connectionId) {
    if (apply) {
      const result = await deps.rebuildSecret(brand.id);
      if (result.outcome === "created") {
        anyIssue = true;
        totals.created += 1;
        findings.push({
          brandId: brand.id,
          shopDomain,
          kind: "missing_secret",
          detail: "connection had no credential mirror; created",
          repaired: true,
        });
        lines.push(formatLine("INFO", brand.id, shopDomain, "credential mirror created"));
      } else if (result.outcome === "rebuilt") {
        anyIssue = true;
        totals.updated += 1;
        findings.push({
          brandId: brand.id,
          shopDomain,
          kind: "stale_secret_mirror",
          detail: "credential mirror contents disagreed with current credentials; rebuilt",
          repaired: true,
        });
        lines.push(formatLine("INFO", brand.id, shopDomain, "credential mirror rebuilt"));
      }
      // "up_to_date" / "no_credentials" / skipped_* -> nothing to report.
    } else if (hasCredentials) {
      const existingSecret = await deps.findConnectionSecretPayload(connectionId);
      const preview = determineShopifySecretRebuildOutcome(
        existingSecret?.encryptedPayload ?? null,
        syncInput.secretPayload,
      );
      if (preview === "created") {
        anyIssue = true;
        totals.created += 1;
        findings.push({
          brandId: brand.id,
          shopDomain,
          kind: "missing_secret",
          detail: "connection has no credential mirror for a brand with credentials",
          repaired: false,
        });
        lines.push(
          formatLine("WARN", brand.id, shopDomain, "missing_credential_mirror: no linked credential record"),
        );
      } else if (preview === "rebuilt") {
        anyIssue = true;
        totals.updated += 1;
        findings.push({
          brandId: brand.id,
          shopDomain,
          kind: "stale_secret_mirror",
          detail: "credential mirror contents disagree with current credentials",
          repaired: false,
        });
        lines.push(
          formatLine(
            "WARN",
            brand.id,
            shopDomain,
            "stale_credential_mirror: linked credential record no longer matches current credentials",
          ),
        );
      }
      // "up_to_date" / "no_credentials" -> nothing to report.
    }
  }

  if (!anyIssue) {
    totals.skipped += 1;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scans candidate brands (see `listCandidateBrands`), reports every
 * detection category described in the file header, and — only when
 * `opts.apply` is true — performs the corresponding repair. Never throws for
 * a single brand's failure: each brand is processed independently and a
 * thrown error is counted in `totals.failed` and logged, so one bad brand
 * never aborts the run (see the CLI wrapper's exit-code contract).
 */
export async function reconcileCommerceConnections(
  deps: ConnectionReconciliationDeps,
  opts: ReconciliationOptions,
): Promise<ReconciliationReport> {
  const totals: ReconciliationTotals = {
    brandsScanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    warnings: 0,
    failed: 0,
  };
  const findings: ReconciliationFinding[] = [];
  const lines: string[] = [];

  const brands = await deps.listCandidateBrands({
    brandId: opts.brandId,
    shopDomain: opts.shopDomain,
    limit: opts.limit,
  });

  for (const brand of brands) {
    totals.brandsScanned += 1;
    try {
      await reconcileOneBrand(brand, opts.apply, deps, totals, findings, lines);
    } catch (error) {
      totals.failed += 1;
      // Sanitized: brand id + shop domain + error NAME only — never the
      // error's message/stack, which could in principle embed details from
      // a crypto/DB driver failure.
      lines.push(
        formatLine(
          "ERROR",
          brand.id,
          brand.shopifyShopDomain,
          `failed: ${error instanceof Error ? error.name : "unknown error"}`,
        ),
      );
    }
  }

  return {
    mode: opts.apply ? "apply" : "dry_run",
    totals,
    findings,
    lines,
  };
}
