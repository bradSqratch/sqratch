/**
 * src/lib/commerce/connection-service.ts
 *
 * The provider-neutral commerce connection SERVICE — the single entry point
 * routes should use to ask "what is brand X's commerce connection", "is it
 * usable", and "what can this provider's adapter do", instead of each route
 * re-implementing provider selection logic by hand.
 *
 * This module is built ON TOP OF `./connection-resolver.ts` (never rewrites
 * or removes it): it reuses `mapCommerceConnectionToSummary` and
 * `pickPreferredConnectionRow` unchanged.
 *
 * ---------------------------------------------------------------------------
 * CANONICAL IS THE ONLY AUTHORITY (`getActiveCommerceConnection`)
 * ---------------------------------------------------------------------------
 * PHASE 14C-A: `CommerceConnection` is the SOLE runtime connection
 * identity/status/account authority. Every currently installed Shopify merchant has
 * a canonical connection, while each provider owns its own credential policy.
 * (operator-verified live DB evidence — see the Phase 14C-A brief) — there
 * is no legitimate legacy source of truth left to fall back to:
 *
 *   - A `CommerceConnection` row exists -> it is used, unconditionally.
 *   - No row exists -> `null`. `Brand.shopify*` is never read.
 *
 * PHASE 14C-B1: the diagnostic drift-reporting machinery
 * (`computeConnectionDrift`/`detectConnectionDrift`/`LegacyBrandShopifyFields`)
 * that used to live here has been removed along with the pre-column-drop
 * reconciliation tool it existed solely to serve — there is nothing left
 * anywhere in this file that reads `Brand.shopify*`.
 *
 * Multiple `CommerceConnection` rows for the same (brandId, provider) are
 * resolved with `pickPreferredConnectionRow`'s existing tiebreak — this
 * module does not invent a second, divergent ordering.
 *
 * ---------------------------------------------------------------------------
 * WHY `isConnectionUsable` DOESN'T CHECK A TOKEN FIELD
 * ---------------------------------------------------------------------------
 * `CommerceConnectionSummary` never carries a credential field by
 * construction (see `./types.ts`). Connection usability is therefore a
 * status/account predicate only; the provider adapter enforces its own
 * credential policy before transport. Shopify requires a connection-bound
 * `CommerceConnectionSecret`; the Commerce7 adapter (registered since
 * Phase 16C1 — `./providers/commerce7-commerce-adapter.ts`) uses an
 * app-global backend credential together with the exact tenant connection
 * identity instead, without requiring a connection secret merely because
 * status is `CONNECTED`.
 *
 * For Shopify, the following write-path invariant remains relevant:
 *   - `CommerceConnection.status` is set to `CONNECTED` ONLY in the same
 *     transaction that also writes a `CommerceConnectionSecret` row
 *     (`applyShopifyConnectionSyncFromInstall` in `./connection-sync.ts`),
 *     or while healing a status-only scope-drift `REQUIRES_RECONNECT` where
 *     a secret is already known to exist by construction
 *     (`healShopifyCredentialConnected`, which never itself writes
 *     CONNECTED without a pre-existing secret — see
 *     `./providers/shopify-credential-store.ts`).
 *   - Every path that moves status AWAY from `CONNECTED` deletes the secret
 *     in the SAME transaction: `invalidateShopifyCredential` (disconnect /
 *     `app/uninstalled` / `shop/redact` / embedded disconnect) and
 *     `markShopifyCredentialRequiresReconnect` (`invalid_grant`) — both in
 *     `./providers/shopify-credential-store.ts`.
 * Shopify's adapter verifies its credential at use time; this generic service
 * intentionally does not infer that rule for other providers.
 *
 * ---------------------------------------------------------------------------
 * `getCommerceCapabilities` NEVER THROWS (a deliberate, consistent choice)
 * ---------------------------------------------------------------------------
 * `getCommerceCapabilities` returns an all-`false` `CommerceCapabilities`
 * for an unregistered provider (every `CommerceProvider` enum value has a
 * registered adapter today — SHOPIFY and, since Phase 16C1, COMMERCE7 — so
 * this path only fires for a future provider value added to the enum before
 * an adapter for it exists) rather than throwing — chosen because "what can
 * this provider do" is a query callers should be able to branch on freely
 * (e.g. to grey out a button) without a provider-support try/catch at every
 * call site. `getAdapterForConnection` makes the OPPOSITE choice
 * deliberately: it throws `UnsupportedProviderError` for an unregistered
 * provider, because "give me the adapter to actually call a method on" has
 * no sane non-throwing fallback value — returning `null` would just move the
 * crash to the next line (`adapter.syncProducts(...)`)
 * with a worse error. Both behaviors are achieved via the registry's own
 * `tryGet` (non-throwing) / `get` (throwing) methods respectively — this
 * file does not re-implement that choice, only picks which one each function
 * uses.
 *
 * ---------------------------------------------------------------------------
 * READS NEVER WRITE
 * ---------------------------------------------------------------------------
 * Every exported function in this file is read-only: the default
 * dependencies only ever call `findMany` / `findUnique` on `prisma.brand`
 * and `prisma.commerceConnection`. Nothing here creates, updates, upserts,
 * or deletes a row, and nothing here reads `CommerceConnectionSecret`.
 *
 * TESTABILITY: dependency-injectable in the same idiom as
 * `CommerceConnectionResolverDeps` in `./connection-resolver.ts` and
 * `ConnectionSyncDeps` in `./connection-sync.ts` — the default DB-backed
 * deps lazily import `@/lib/prisma` (only resolved when a lookup actually
 * runs), so importing this module never requires `DATABASE_URL`.
 */

import { CommerceProvider, type Prisma } from "@prisma/client";
import type { CommerceAdapter } from "./adapter";
import { defaultCommerceAdapterRegistry } from "./default-registry";
import type { CommerceAdapterRegistry } from "./registry";
import {
  mapCommerceConnectionToSummary,
  pickPreferredConnectionRow,
  type CommerceConnectionRow,
} from "./connection-resolver";
import type { CommerceCapabilities, CommerceConnectionSummary } from "./types";

export type { CommerceConnectionRow } from "./connection-resolver";

// ---------------------------------------------------------------------------
// Dependency injection (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type CommerceConnectionServiceDeps = {
  /** Loads every `CommerceConnection` row for (brandId, provider). */
  findConnectionRows(
    brandId: string,
    provider: CommerceProvider,
  ): Promise<CommerceConnectionRow[]>;
  /** Loads a single `CommerceConnection` row by its own id, or `null` if it does not exist. */
  findConnectionRowById(connectionId: string): Promise<CommerceConnectionRow | null>;
  /** The adapter registry used by `getCommerceCapabilities` / `getAdapterForConnection`. */
  registry: CommerceAdapterRegistry;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

/** Shared `select` shape for a `CommerceConnectionRow` — kept in one place so the two default readers below can never drift apart field-by-field. */
export const CONNECTION_ROW_SELECT = {
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
  providerMetadata: true,
} as const;

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

async function defaultFindConnectionRowById(
  connectionId: string,
): Promise<CommerceConnectionRow | null> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findUnique({
    where: { id: connectionId },
    select: CONNECTION_ROW_SELECT,
  });
}

const DEFAULT_SERVICE_DEPS: CommerceConnectionServiceDeps = {
  findConnectionRows: defaultFindConnectionRows,
  findConnectionRowById: defaultFindConnectionRowById,
  registry: defaultCommerceAdapterRegistry,
};

function resolveServiceDeps(
  deps: Partial<CommerceConnectionServiceDeps>,
): CommerceConnectionServiceDeps {
  return { ...DEFAULT_SERVICE_DEPS, ...deps };
}

// ---------------------------------------------------------------------------
// Internal: canonical-only resolution shared by getActiveCommerceConnection
// / getPrimaryCommerceConnection
// ---------------------------------------------------------------------------

/**
 * PHASE 14C-A: canonical-only. A `CommerceConnection` row is authoritative
 * the moment it exists; no row means not connected, full stop — no legacy
 * `Brand.shopify*` fallback (every live Shopify install already has a
 * canonical row, operator-verified). A throw from the row lookup (e.g. a
 * transient outage isolated to the `CommerceConnection` table) is treated
 * the same as "no row" — this must never take down an availability-sensitive
 * caller (like reward redemption) merely because this table hiccupped, and
 * per the file header, "unknown" must fail closed (not connected), never be
 * upgraded to "assume connected."
 */
async function resolvePreferredConnection(
  brandId: string,
  provider: CommerceProvider,
  deps: CommerceConnectionServiceDeps,
  rowFilter?: (row: CommerceConnectionRow) => boolean,
): Promise<CommerceConnectionSummary | null> {
  const rows = await deps.findConnectionRows(brandId, provider).catch(() => []);
  const candidateRows = rowFilter ? rows.filter(rowFilter) : rows;
  const preferredRow = pickPreferredConnectionRow(candidateRows);
  return preferredRow ? mapCommerceConnectionToSummary(preferredRow) : null;
}

// ---------------------------------------------------------------------------
// Public connection lookups
// ---------------------------------------------------------------------------

/**
 * Resolves the commerce connection SQRATCH should treat as authoritative for
 * (brandId, provider) using the consistency-checked preference described in
 * the file header. Returns `null` when the brand has no connection at all
 * for this provider.
 */
export async function getActiveCommerceConnection(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  return resolvePreferredConnection(brandId, provider, resolveServiceDeps(deps));
}

/**
 * PHASE 16C2: resolves the ONE commerce connection a provider-neutral surface
 * (e.g. a "Commerce" dashboard card) should show for a brand, without the
 * caller having to already know which provider that brand uses.
 *
 * Queries every `CommerceProvider` value in parallel via the SAME
 * `getActiveCommerceConnection` this file already exposes per-provider — this
 * is a thin fan-out/pick, never a second connection-resolution policy. A
 * brand is expected to have at most one REAL active provider at a time today,
 * but the schema does not forbid rows under two providers, so ties are broken
 * deterministically:
 *   1. `CONNECTED` beats any other status.
 *   2. Among equally-(dis)connected candidates, the most recently installed
 *      wins (a null `installedAt` sorts last).
 * Returns `null` only when the brand has no connection under ANY provider.
 */
export async function getActiveCommerceConnectionAnyProvider(
  brandId: string,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  const resolvedDeps = resolveServiceDeps(deps);
  const results = await Promise.all(
    Object.values(CommerceProvider).map((provider) =>
      resolvePreferredConnection(brandId, provider, resolvedDeps),
    ),
  );
  const candidates = results.filter(
    (summary): summary is CommerceConnectionSummary => summary !== null,
  );

  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "CONNECTED") return -1;
      if (b.status === "CONNECTED") return 1;
    }
    const aInstalledAt = a.installedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bInstalledAt = b.installedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    return bInstalledAt - aInstalledAt;
  })[0];
}

/**
 * PHASE 16 BIG ROUND / SUBPHASE 3: resolves EVERY `CommerceConnection` row
 * for a brand, across every provider — unlike
 * `getActiveCommerceConnectionAnyProvider`, which picks the single
 * preferred row, this is the full list a multi-provider/multi-account
 * selector UI needs to let a Brand Admin choose explicitly. Reuses the exact
 * same `findConnectionRows` dep and `mapCommerceConnectionToSummary`
 * mapping as every other lookup in this file — no second query path. A
 * per-provider read failure is treated as "no rows for that provider" so one
 * provider's outage never hides another's working connections.
 */
/**
 * PHASE 18 REPAIR (P2-4B): the prior shape silently converted a per-provider
 * query FAILURE into "this provider simply has zero connections" — a caller
 * had no way to tell "Commerce7 genuinely has no connection" apart from
 * "Commerce7's query blew up and we don't actually know." That distinction
 * matters: an operational UI that auto-selects when exactly one connection
 * is visible could auto-select a Shopify connection while silently hiding a
 * real, live Commerce7 one whose read merely failed.
 */
export type CommerceConnectionListResult = {
  connections: CommerceConnectionSummary[];
  /** `false` whenever ANY provider's read failed — the list may be incomplete. */
  complete: boolean;
  /** Which provider(s) failed to read, if any — for diagnostics, never swallowed silently. */
  failedProviders: CommerceProvider[];
};

export async function getAllCommerceConnectionsForBrand(
  brandId: string,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionListResult> {
  const resolvedDeps = resolveServiceDeps(deps);
  const failedProviders: CommerceProvider[] = [];
  const results = await Promise.all(
    Object.values(CommerceProvider).map(async (provider) => {
      try {
        return await resolvedDeps.findConnectionRows(brandId, provider);
      } catch {
        failedProviders.push(provider);
        return [];
      }
    }),
  );
  return {
    connections: results.flat().map(mapCommerceConnectionToSummary),
    complete: failedProviders.length === 0,
    failedProviders,
  };
}

/**
 * Resolves one historical provider account to its exact current canonical
 * connection. This is deliberately not the preferred/primary lookup: reward
 * reconciliation must never pair an X redemption with a Y credential after a
 * relink.
 */
export async function resolveCommerceConnectionForExternalAccount(
  input: { brandId: string; provider: CommerceProvider; externalAccountId: string },
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  const resolvedDeps = resolveServiceDeps(deps);
  const wanted = input.externalAccountId.trim().toLowerCase();
  const rows = await resolvedDeps.findConnectionRows(input.brandId, input.provider).catch(() => []);
  const exact = rows.filter((row) => row.externalAccountId.trim().toLowerCase() === wanted);
  const preferred = pickPreferredConnectionRow(exact);
  return preferred ? mapCommerceConnectionToSummary(preferred) : null;
}

/**
 * Minimal structural shape a Prisma client (or `$transaction` callback's
 * `tx`) must satisfy to resolve a canonical connection — deliberately NOT
 * `PrismaClient`, so a `Prisma.TransactionClient` participating in an
 * enclosing transaction satisfies it too.
 */
export type CommerceConnectionQueryClient = {
  commerceConnection: {
    findMany(args: {
      where: { brandId: string; provider: CommerceProvider };
      select: typeof CONNECTION_ROW_SELECT;
    }): Promise<CommerceConnectionRow[]>;
  };
};

/**
 * PHASE 14C-A: resolves the canonical connection using an EXPLICITLY passed
 * client instead of the module-singleton `prisma` — the only way a
 * SERIALIZABLE business transaction (e.g. reward redemption's reservation
 * transaction) can re-check canonical connection state INSIDE its own
 * transaction, participating in its isolation/locking, rather than reading a
 * pre-transaction snapshot that could have gone stale by the time the
 * transaction commits. Reuses the exact same row select, tiebreak, and
 * mapping the non-transactional lookups use — never a second, divergent
 * selection policy. There is no legacy fallback here (see the file header:
 * every live Shopify install already has a canonical row as of Phase 14C) —
 * no row simply means not connected.
 */
export async function resolveCommerceConnectionSummaryWithClient(
  client: CommerceConnectionQueryClient,
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
): Promise<CommerceConnectionSummary | null> {
  const rows = await client.commerceConnection.findMany({
    where: { brandId, provider },
    select: CONNECTION_ROW_SELECT,
  });
  const preferredRow = pickPreferredConnectionRow(rows);
  return preferredRow ? mapCommerceConnectionToSummary(preferredRow) : null;
}

// ---------------------------------------------------------------------------
// Batch resolution — PHASE 14B.4C
// ---------------------------------------------------------------------------

/** Dependencies for the batch/bulk resolver — exactly one query total, never one per brand. */
export type BatchCommerceConnectionServiceDeps = {
  /** Loads every `CommerceConnection` row for ALL of `brandIds` at once. */
  findConnectionRowsForBrands(
    brandIds: string[],
    provider: CommerceProvider,
  ): Promise<CommerceConnectionRow[]>;
};

async function defaultFindConnectionRowsForBrands(
  brandIds: string[],
  provider: CommerceProvider,
): Promise<CommerceConnectionRow[]> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findMany({
    where: { brandId: { in: brandIds }, provider },
    select: CONNECTION_ROW_SELECT,
  });
}

const DEFAULT_BATCH_SERVICE_DEPS: BatchCommerceConnectionServiceDeps = {
  findConnectionRowsForBrands: defaultFindConnectionRowsForBrands,
};

/**
 * Batch/bulk canonical-only resolution for MANY brands in one call — no
 * legacy `Brand.shopify*` fallback (Phase 14C-A) — with exactly ONE query
 * total regardless of how many brand ids are passed, never one
 * `CommerceConnection` query per brand/offer. Built for listing routes that
 * must resolve connectivity across many brands at once (e.g. the public
 * rewards feed) without an N+1 query pattern.
 *
 * A throw from the underlying query is treated the same as "found nothing
 * for that batch" — never breaks the whole listing; "unknown" fails closed
 * (not connected), it must never be upgraded to "assume connected."
 *
 * Returns a `Map<brandId, CommerceConnectionSummary>` — a brand absent from
 * the map has no `CommerceConnection` row for this provider at all.
 */
export async function getActiveCommerceConnectionsForBrands(
  brandIds: string[],
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  deps: Partial<BatchCommerceConnectionServiceDeps> = {},
): Promise<Map<string, CommerceConnectionSummary>> {
  const result = new Map<string, CommerceConnectionSummary>();
  const uniqueBrandIds = [...new Set(brandIds)];
  if (uniqueBrandIds.length === 0) {
    return result;
  }

  const resolvedDeps: BatchCommerceConnectionServiceDeps = {
    ...DEFAULT_BATCH_SERVICE_DEPS,
    ...deps,
  };

  const rows = await resolvedDeps
    .findConnectionRowsForBrands(uniqueBrandIds, provider)
    .catch(() => [] as CommerceConnectionRow[]);

  const rowsByBrand = new Map<string, CommerceConnectionRow[]>();
  for (const row of rows) {
    const existing = rowsByBrand.get(row.brandId);
    if (existing) {
      existing.push(row);
    } else {
      rowsByBrand.set(row.brandId, [row]);
    }
  }

  for (const brandId of uniqueBrandIds) {
    const preferredRow = pickPreferredConnectionRow(rowsByBrand.get(brandId) ?? []);
    if (preferredRow) {
      result.set(brandId, mapCommerceConnectionToSummary(preferredRow));
    }
  }

  return result;
}

/**
 * PHASE 14B.4C: records a freshly-learned currency code onto the canonical
 * connection's `providerMetadata` — the exact same key
 * `extractCurrencyCodeFromProviderMetadata` reads (see `./connection-resolver.ts`
 * and `CommerceConnectionSummary.currencyCode`'s doc comment in `./types.ts`).
 * Every canonical row is supposed to have this populated at install/sync time
 * (`buildShopifyConnectionSyncInput(FromInstall)`), but a row synced from a
 * legacy `Brand` that itself predates currency tracking can still have
 * `currencyCode: null`. Callers use this to self-heal that gap in place,
 * WITHOUT going through the full install/sync rewrite (which would also
 * require re-supplying credential/scope/status facts this caller doesn't
 * have) and WITHOUT adding a second currency field. Credential semantics
 * such as Shopify auth mode deliberately do not live in this JSON projection.
 * Best-effort: a failure here should never fail the caller's own request,
 * since the freshly-fetched currency value is still usable in-memory for
 * that one response even if persisting it for future reads fails.
 */
export type RecordCommerceConnectionCurrencyCodeDeps = {
  findProviderMetadata(connectionId: string): Promise<unknown>;
  updateProviderMetadata(connectionId: string, providerMetadata: Record<string, unknown>): Promise<void>;
};

async function defaultFindProviderMetadata(connectionId: string): Promise<unknown> {
  const prisma = await getPrisma();
  const row = await prisma.commerceConnection.findUnique({
    where: { id: connectionId },
    select: { providerMetadata: true },
  });
  return row?.providerMetadata ?? null;
}

async function defaultUpdateProviderMetadata(
  connectionId: string,
  providerMetadata: Record<string, unknown>,
): Promise<void> {
  const prisma = await getPrisma();
  await prisma.commerceConnection.update({
    where: { id: connectionId },
    data: { providerMetadata: providerMetadata as Prisma.InputJsonValue },
  });
}

export async function recordCommerceConnectionCurrencyCode(
  connectionId: string,
  currencyCode: string,
  deps: Partial<RecordCommerceConnectionCurrencyCodeDeps> = {},
): Promise<void> {
  const findProviderMetadata = deps.findProviderMetadata ?? defaultFindProviderMetadata;
  const updateProviderMetadata = deps.updateProviderMetadata ?? defaultUpdateProviderMetadata;

  const raw = await findProviderMetadata(connectionId);
  const existing =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Auth mode belongs exclusively to the encrypted provider credential. Strip
  // the retired projection when a connection receives a currency self-heal so
  // pre-Phase-15 rows naturally converge without a JSON rewrite migration.
  const providerFacts = { ...existing };
  delete providerFacts.authMode;
  await updateProviderMetadata(connectionId, { ...providerFacts, currencyCode });
}

/**
 * Looks up a connection by its own `CommerceConnection.id`. Unlike
 * `getActiveCommerceConnection`, this resolves only the requested persisted
 * row. Returns `null` if no row with this id exists.
 */
export async function getCommerceConnectionById(
  connectionId: string,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  const resolvedDeps = resolveServiceDeps(deps);
  const row = await resolvedDeps.findConnectionRowById(connectionId);
  return row ? mapCommerceConnectionToSummary(row) : null;
}

/**
 * Resolves the connection marked primary for (brandId, provider) (restricted
 * to rows with `isPrimary: true` before the tiebreak). Returns `null` when
 * nothing is marked primary — no legacy fallback (Phase 14C-A).
 */
export async function getPrimaryCommerceConnection(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  return resolvePreferredConnection(
    brandId,
    provider,
    resolveServiceDeps(deps),
    (row) => row.isPrimary,
  );
}

// ---------------------------------------------------------------------------
// Capabilities / adapter access
// ---------------------------------------------------------------------------

/**
 * Reports which optional operations `provider` supports. Never throws — an
 * UNREGISTERED provider (no live example today: both SHOPIFY and COMMERCE7
 * have registered adapters as of Phase 16C1) reports every capability
 * `false` rather than raising `UnsupportedProviderError`. A REGISTERED
 * provider's own `getCapabilities()` answers instead — for COMMERCE7 that is
 * `products.sync: true`, `products.publicDestinations: false`, and every
 * reward capability `false` (see `./providers/commerce7-commerce-adapter.ts`),
 * NOT all-false. See the file header for why the unregistered-provider
 * fallback is the opposite choice from `getAdapterForConnection`.
 */
export function getCommerceCapabilities(
  provider: CommerceProvider,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): CommerceCapabilities {
  const { registry } = resolveServiceDeps(deps);
  const adapter = registry.tryGet(provider);

  if (!adapter) {
    return {
      products: { sync: false, publicDestinations: false },
      rewards: {
        create: false,
        lookup: false,
        usageLookup: false,
        revoke: false,
        fixedAmount: false,
        percentage: false,
        minimumSubtotal: false,
        productSpecific: false,
        singleUse: false,
      },
    };
  }

  return adapter.getCapabilities();
}

/**
 * Returns the `CommerceAdapter` for `summary.provider`. Throws
 * `UnsupportedProviderError` for a provider with no registered adapter (no
 * live example today: SHOPIFY and COMMERCE7 are both registered as of Phase
 * 16C1) — see the file header for why this, unlike `getCommerceCapabilities`,
 * throws rather than returning a fallback value.
 * Never makes a network call: the registry only constructs (and memoizes)
 * the adapter object, which itself only stores its dependencies at
 * construction time.
 */
export function getAdapterForConnection(
  summary: CommerceConnectionSummary,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): CommerceAdapter {
  const { registry } = resolveServiceDeps(deps);
  return registry.get(summary.provider);
}

// ---------------------------------------------------------------------------
// Status predicates (provider-neutral, pure — see the file header for why
// these don't check a token field)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral usability checks only connection state and account
 * identity. Each provider implementation owns any credential requirement.
 */
export function isConnectionUsable(summary: CommerceConnectionSummary): boolean {
  return summary.status === "CONNECTED" && summary.externalAccountId.trim().length > 0;
}

/** True when `summary` is in a state where the user must reconnect (re-authenticate) before it can be used again. */
export function connectionRequiresReconnect(summary: CommerceConnectionSummary): boolean {
  return summary.status === "REQUIRES_RECONNECT";
}

/**
 * Serialization-safe boundary marker. `CommerceConnectionSummary` already
 * excludes every credential field by construction (see `./types.ts`), so
 * there is nothing for this function to strip today — it is an identity
 * function. It exists so a route can write
 * `NextResponse.json(toSafeConnectionSummary(summary))` as an explicit,
 * greppable assertion of intent ("this object is safe to serialize")
 * instead of relying on every future summary field being manually
 * re-audited. If a field that could carry sensitive data is ever proposed
 * for `CommerceConnectionSummary`, THIS is the function to turn into a real
 * narrowing/redaction step.
 */
export function toSafeConnectionSummary(
  summary: CommerceConnectionSummary,
): CommerceConnectionSummary {
  return summary;
}

/**
 * Derives the storefront URL SQRATCH displays for a Shopify shop domain,
 * exposed standalone for a caller that only needs the URL (not a full
 * connectivity decision) from an already-fetched shop domain — e.g.
 * `src/app/api/rewards/shopify/redemptions/route.ts`'s `shopUrl` field,
 * derived from the redemption's OWN historical shop-domain snapshot. No
 * I/O — pure, synchronous. Deliberately does not trim/normalize
 * `shopDomain` — reproduces the literal `domain ? \`https://${domain}\` :
 * null` expression exactly, byte for byte.
 */
export function deriveShopifyStorefrontUrl(
  shopDomain: string | null | undefined,
): string | null {
  return shopDomain ? `https://${shopDomain}` : null;
}
