/**
 * tests/commerce-connection-compatibility.test.ts
 *
 * PHASE 14C-A: the legacy READ-side fallback (`mapLegacyBrandToConnectionSummary`,
 * `LegacyBrandShopifyFields`, `CommerceConnectionResolverDeps.findLegacyBrandFields`,
 * `safeSyncShopifyCommerceConnection`) was removed from
 * `connection-resolver.ts` / `connection-sync.ts` — every live Shopify
 * merchant already has a canonical `CommerceConnection` row
 * (operator-verified), so those tests were removed with the code they
 * covered, not left to rot.
 *
 * PHASE 14C-B1: the WRITE-side Brand-sourced dual-write machinery
 * (`buildShopifyConnectionSyncInput`, `syncShopifyCommerceConnectionForBrand`,
 * `rebuildShopifyConnectionSecretForBrand`, `LegacyBrandForShopifySync`) has
 * been removed from `connection-sync.ts` along with the pre-column-drop
 * reconciliation tool it existed solely to serve
 * (`connection-reconciliation.ts` / `scripts/reconcile-commerce-connections.ts`,
 * both deleted). The tests that used to exercise that machinery now exercise
 * `applyShopifyConnectionSyncFromInstall` instead — the ONLY remaining writer
 * of a `CommerceConnection`/`CommerceConnectionSecret` pair, built exclusively
 * from authenticated install facts (`ShopifyInstallFacts`), never from
 * `Brand.shopify*`. The underlying transactional core these tests actually
 * exercise (`applyShopifyConnectionSync`, `applyDeleteShopifyConnectionByShopDomain`)
 * is unchanged — only the caller/input shape moved.
 *
 * No real DB, no real network anywhere in this file. `connection-sync.ts`'s
 * transactional core is exercised against a hand-rolled in-memory fake `tx`
 * (same idiom as tests/shopify-connection-transitions.test.ts's `makeFakeTx`)
 * that mimics Prisma's `commerceConnection` / `commerceConnectionSecret`
 * model methods closely enough to genuinely exercise the
 * @@unique([provider, externalAccountId]) upsert-key behavior, the relink
 * reassignment, and single-primary clearing — these are not hand-waved
 * assertions, the fake actually enforces uniqueness the way Postgres would.
 *
 * Covered cases (numbered to match the review checklist; numbers 2, 13, and
 * 23/24/26 now describe their PHASE 14C-A/14C-B1 replacement, not the
 * original legacy behavior — see each test for why):
 *  1.  Resolver prefers an existing CommerceConnection row.
 *  2.  No connection row -> null. No legacy fallback (see test comment).
 *  3.  Resolver returns null for a brand with no Shopify connection at all.
 *  4.  Multi-connection tiebreak: isPrimary wins, then most recent installedAt.
 *  5.  (removed — PHASE 14C-B1) `mapLegacyShopifyStatusToCommerceStatus` was deleted; it had zero remaining callers once the Brand-sourced dual-write path it existed for was retired, and was the last runtime dependency on the Prisma `ShopifyConnectionStatus` enum.
 *  6.  grantedScopes normalization: comma string, Json array, null, non-array Json.
 *  7.  Idempotency: installing twice produces one connection (upsert, not a second create).
 *  8.  Relink: same shop domain, different brand -> brandId reassigned, no duplicate.
 *  9.  Single-primary enforcement: a new primary clears isPrimary on other connections.
 *  10. Secret encryption: encryptedPayload round-trips via decryptSecret; keyVersion is set.
 *  11. Secret exclusion: JSON.stringify(summary) never matches /token|secret|encrypted|password/i.
 *  12. (removed — an install-facts write always carries a token; the "secret deleted, not written empty" branch is exercised via disconnect/uninstall paths, covered in tests/shopify-credential-store.test.ts.)
 *  13. (removed — see the note above `safeSyncShopifyCommerceConnection`'s old describe block.)
 *  14. Idempotency across repeated installs: looping the install twice against a shared fake store creates nothing new on the second pass.
 *  15. GDPR redaction delete is keyed on (provider, externalAccountId), not brandId.
 *  16. Redaction delete still finds and removes the row when it's "orphaned" from the
 *      brand's current externalAccountId (the shape of the missed-deletion bug: a stale
 *      domain's connection row survives a relink to a different domain).
 *  17. Redaction delete removes only the redacted domain's row; a brand's other Shopify
 *      connection is untouched (the shape of the over-deletion bug).
 *  18. Redaction delete is a no-op, not an error, when no row matches the domain.
 *  19. safeDeleteShopifyCommerceConnectionByShopDomain swallows a thrown error, never rethrows.
 *  20. Normalization symmetry: a mixed-case / whitespace-padded shop domain written via
 *      the install is matched by the redaction delete keyed on a differently-cased /
 *      differently-padded form of the SAME domain — write and delete agree on the key
 *      because both go through the single exported `normalizeExternalAccountId` helper.
 *  21. Route wiring (source-inspection, same idiom as tests/shopify-scope-drift.test.ts):
 *      the shop/redact route calls `safeDeleteShopifyCommerceConnectionByShopDomain`
 *      unconditionally, regardless of whether any historical brand was resolved — see
 *      the test for the PHASE 14C-B1 route shape this now checks.
 *  22-26. Primary-assignment ordering/conflict handling — 22 and 25 exercise
 *      `applyShopifyConnectionSyncFromInstall`'s live ordering directly; 23/24/26
 *      (the bounded-retry-specific cases) are replaced by a single test proving a
 *      primary-conflict P2002 now propagates UNCAUGHT to the caller, since the retry
 *      that used to live in `syncShopifyCommerceConnectionForBrand` is gone — retrying
 *      is the installations route's own responsibility now (it already maps P2002/P2034
 *      onto a 409 the client retries).
 *  27. (removed — rebuildShopifyConnectionSecretForBrand was retired with the reconciliation tool.)
 */

process.env.APP_ENCRYPTION_KEY ||= "test-encryption-key-for-commerce-sync-tests";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CommerceProvider, Prisma } from "@prisma/client";
import { decryptSecret } from "../src/lib/crypto";

import {
  mapCommerceConnectionToSummary,
  extractCurrencyCodeFromProviderMetadata,
  normalizeGrantedScopes,
  normalizeGrantedScopesJson,
  pickPreferredConnectionRow,
  resolveCommerceConnectionForBrand,
  type CommerceConnectionRow,
} from "../src/lib/commerce/connection-resolver";

import {
  applyShopifyConnectionSyncFromInstall,
  buildShopifyConnectionSyncInputFromInstall,
  deleteShopifyCommerceConnectionByShopDomain,
  safeDeleteShopifyCommerceConnectionByShopDomain,
  normalizeExternalAccountId,
  type ShopifyInstallFacts,
  type ShopifyConnectionSecretPayload,
} from "../src/lib/commerce/connection-sync";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeConnectionRow(
  overrides: Partial<CommerceConnectionRow> = {},
): CommerceConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "acme",
    externalAccountId: "acme.myshopify.com",
    storefrontUrl: "https://acme.myshopify.com",
    isPrimary: true,
    grantedScopes: ["read_products"],
    installedAt: new Date("2026-01-01T00:00:00Z"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: "USD" },
    ...overrides,
  };
}

function makeInstallFacts(
  overrides: Partial<ShopifyInstallFacts> = {},
): ShopifyInstallFacts {
  return {
    shopDomain: "acme.myshopify.com",
    brandDisplayName: "Acme",
    providerClientId: null,
    authMode: "LEGACY_OFFLINE",
    currencyCode: "CAD",
    grantedScopes: "read_products,write_discounts",
    installedAt: new Date("2026-01-01T00:00:00Z"),
    lastProductSyncAt: null,
    accessToken: "shpat_live_token",
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake transactional Prisma client for connection-sync.ts
// ---------------------------------------------------------------------------

type FakeConnectionRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: string;
  displayName: string;
  externalAccountId: string;
  storefrontUrl: string | null;
  providerClientId: string | null;
  isPrimary: boolean;
  grantedScopes: unknown;
  providerMetadata: unknown;
  installedAt: Date | null;
  uninstalledAt: Date | null;
  lastProductSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeSecretRow = {
  id: string;
  connectionId: string;
  encryptedPayload: string;
  keyVersion: number;
  rotatedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  refreshLockId: string | null;
  refreshLockedUntil: Date | null;
};

type WhereClause = Record<string, unknown>;

function fieldMatches(actual: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (
    condition !== null &&
    typeof condition === "object" &&
    !(condition instanceof Date)
  ) {
    const cond = condition as { not?: unknown; in?: unknown[] };
    if ("not" in cond) return actual !== cond.not;
    if ("in" in cond && Array.isArray(cond.in)) return cond.in.includes(actual);
  }
  return actual === condition;
}

function matchesWhere(
  row: Record<string, unknown>,
  where: WhereClause | undefined,
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) =>
    fieldMatches(row[key], condition),
  );
}

/**
 * Builds a Prisma-shaped conflict error matching what the real partial
 * unique index `CommerceConnection_brandId_provider_primary_key` (added by
 * migration 20260806130000_commerce_connection_single_primary) would raise
 * — a genuine `Prisma.PrismaClientKnownRequestError` (not a hand-rolled
 * duck-typed object), so `isPrimaryConflictError` in connection-sync.ts
 * exercises its real `instanceof` check, not a test-only shortcut.
 */
function makePrimaryConflictError(
  code: "P2002" | "P2034" = "P2002",
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `simulated ${code} unique-violation on CommerceConnection_brandId_provider_primary_key`,
    { code, clientVersion: "test" },
  );
}

function makeFakeConnectionSyncTx(
  options: { failPrimarySetTimes?: number } = {},
) {
  let nextId = 1;
  const connections = new Map<string, FakeConnectionRow>();
  const secrets = new Map<string, FakeSecretRow>();
  const calls = {
    upsertConnection: 0,
    createConnection: 0,
    updateConnection: 0,
    upsertSecret: 0,
    secretDeleteMany: 0,
    clearPrimaryUpdateMany: 0,
    primaryConflictsRaised: 0,
  };
  // Records, in order, only the two operations the single-primary ordering
  // rule cares about: "clearPrimary" (the updateMany that clears siblings)
  // and "upsert" (the upsert that (re)writes this row's isPrimary value) —
  // see test 1 below.
  const order: string[] = [];
  let primarySetFailuresRemaining = options.failPrimarySetTimes ?? 0;
  // FIFO queue of callbacks run exactly when a queued conflict fires, so a
  // test can materialize "the concurrent transaction that won the race"
  // into the store at the precise moment its own conflict is simulated —
  // see `armPrimaryConflict` below.
  const primaryConflictSideEffects: Array<() => void> = [];

  function findByExternalId(
    provider: CommerceProvider,
    externalAccountId: string,
  ): FakeConnectionRow | undefined {
    for (const row of connections.values()) {
      if (row.provider === provider && row.externalAccountId === externalAccountId) {
        return row;
      }
    }
    return undefined;
  }

  const tx = {
    commerceConnection: {
      async findUnique({ where }: { where: { provider_externalAccountId?: { provider: CommerceProvider; externalAccountId: string } } }) {
        const key = where.provider_externalAccountId;
        if (!key) return null;
        return findByExternalId(key.provider, key.externalAccountId) ?? null;
      },
      async count({ where }: { where: WhereClause }) {
        return [...connections.values()].filter((row) => matchesWhere(row, where)).length;
      },
      async findMany({ where }: { where: WhereClause }) {
        return [...connections.values()].filter((row) => matchesWhere(row, where));
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { provider_externalAccountId: { provider: CommerceProvider; externalAccountId: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        const isSettingPrimary = create.isPrimary === true || update.isPrimary === true;
        if (isSettingPrimary && primarySetFailuresRemaining > 0) {
          primarySetFailuresRemaining -= 1;
          calls.primaryConflictsRaised += 1;
          order.push("upsert:conflict");
          primaryConflictSideEffects.shift()?.();
          throw makePrimaryConflictError();
        }
        order.push("upsert");

        calls.upsertConnection += 1;
        const existing = findByExternalId(
          where.provider_externalAccountId.provider,
          where.provider_externalAccountId.externalAccountId,
        );
        if (existing) {
          calls.updateConnection += 1;
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        calls.createConnection += 1;
        const row = {
          id: `conn-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        } as FakeConnectionRow;
        connections.set(row.id, row);
        return row;
      },
      async updateMany({ where, data }: { where: WhereClause; data: Record<string, unknown> }) {
        const isClearPrimary = where.isPrimary === true && data.isPrimary === false;
        order.push(isClearPrimary ? "clearPrimary" : "updateMany");
        if (isClearPrimary) {
          calls.clearPrimaryUpdateMany += 1;
        }

        let count = 0;
        for (const row of connections.values()) {
          if (matchesWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      async deleteMany({ where }: { where: WhereClause }) {
        let count = 0;
        for (const [id, row] of [...connections.entries()]) {
          if (matchesWhere(row, where)) {
            connections.delete(id);
            secrets.delete(id);
            count += 1;
          }
        }
        return { count };
      },
    },
    commerceConnectionSecret: {
      async findUnique({ where }: { where: { connectionId: string } }) {
        return secrets.get(where.connectionId) ?? null;
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: { connectionId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        calls.upsertSecret += 1;
        const existing = secrets.get(where.connectionId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = {
          id: `secret-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        } as FakeSecretRow;
        secrets.set(where.connectionId, row);
        return row;
      },
      async deleteMany({ where }: { where: { connectionId: string | { in: string[] } } }) {
        calls.secretDeleteMany += 1;
        const ids =
          typeof where.connectionId === "string"
            ? [where.connectionId]
            : where.connectionId.in;
        let count = 0;
        for (const id of ids) {
          if (secrets.delete(id)) count += 1;
        }
        return { count };
      },
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    connections,
    secrets,
    calls,
    order,
    /**
     * Arms the next `n` upsert calls that would set `isPrimary: true` to
     * throw a simulated P2002 instead of writing — models a concurrent
     * transaction winning the race to become primary for the same
     * (brandId, provider) between this sync's `count()` read and its
     * `upsert()` write. `onConflict`, if given, runs exactly once per
     * conflict at the moment it fires (FIFO across multiple `armPrimaryConflict`
     * calls) — a test uses this to materialize the "winning" competing row
     * into the store right when the conflict happens, so a subsequent retry
     * sees it via a fresh `count()` read, exactly like a real transaction
     * retried after losing a unique-index race.
     */
    armPrimaryConflict(times = 1, onConflict?: () => void) {
      primarySetFailuresRemaining += times;
      if (onConflict) {
        for (let i = 0; i < times; i++) {
          primaryConflictSideEffects.push(onConflict);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1-3: resolver precedence + fallback + null
// ---------------------------------------------------------------------------

describe("resolveCommerceConnectionForBrand — canonical-only (PHASE 14C-A: no legacy fallback)", () => {
  test("1. prefers an existing CommerceConnection row", async () => {
    const row = makeConnectionRow({ id: "conn-real", displayName: "real-connection" });

    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [row],
      },
    );

    assert.ok(result);
    assert.equal(result?.id, "conn-real");
    assert.equal(result?.displayName, "real-connection");
  });

  // No canonical row means no connection.
  test("2. no connection row -> null, no legacy fallback", async () => {
    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [],
      },
    );

    assert.equal(result, null);
  });

  test("3. returns null for a brand with no Shopify connection at all", async () => {
    const result = await resolveCommerceConnectionForBrand(
      "brand-no-shopify",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [],
      },
    );

    assert.equal(result, null);
  });

  test("3b. returns null when the brand itself does not exist", async () => {
    const result = await resolveCommerceConnectionForBrand(
      "missing-brand",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [],
      },
    );

    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Phase 13: one Brand, MULTIPLE providers.
//
// This is the Commerce7-readiness contract at the resolver level. Nothing
// here implements Commerce7 or calls it — it asserts only that the canonical
// resolution path is genuinely keyed on (brandId, provider) and that the
// SHOPIFY-only legacy fallback can never bleed into another provider's
// answer. If a future Commerce7 adapter is added, these are the invariants
// it must not break.
// ---------------------------------------------------------------------------

describe("Phase 13: a single Brand may hold Shopify AND Commerce7 connections simultaneously", () => {
  const shopifyRow = makeConnectionRow({
    id: "conn-shopify",
    provider: CommerceProvider.SHOPIFY,
    displayName: "acme-shopify",
    externalAccountId: "acme.myshopify.com",
    storefrontUrl: "https://acme.myshopify.com",
  });
  const commerce7Row = makeConnectionRow({
    id: "conn-c7",
    provider: CommerceProvider.COMMERCE7,
    displayName: "acme-winery",
    externalAccountId: "acme-winery-tenant",
    storefrontUrl: "https://shop.acmewinery.com",
    grantedScopes: [],
  });

  /** Stands in for the real (brandId, provider)-scoped query. */
  function findRowsScopedByProvider(rows: CommerceConnectionRow[]) {
    return async (brandId: string, provider: CommerceProvider) =>
      rows.filter((r) => r.brandId === brandId && r.provider === provider);
  }

  test("resolving SHOPIFY returns only the Shopify connection, never the Commerce7 row", async () => {
    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: findRowsScopedByProvider([shopifyRow, commerce7Row]),
      },
    );

    assert.ok(result);
    assert.equal(result?.id, "conn-shopify");
    assert.equal(result?.provider, CommerceProvider.SHOPIFY);
    assert.equal(result?.externalAccountId, "acme.myshopify.com");
  });

  test("resolving COMMERCE7 returns only the Commerce7 connection, with no Shopify identifiers leaking in", async () => {
    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.COMMERCE7,
      {
        findConnectionRows: findRowsScopedByProvider([shopifyRow, commerce7Row]),
      },
    );

    assert.ok(result);
    assert.equal(result?.id, "conn-c7");
    assert.equal(result?.provider, CommerceProvider.COMMERCE7);
    assert.equal(result?.externalAccountId, "acme-winery-tenant");
    assert.doesNotMatch(String(result?.externalAccountId), /myshopify/);
  });

  // PHASE 14C-A: no legacy fallback exists for any provider anymore — a
  // Brand with only a Commerce7 connection resolves SHOPIFY to bare `null`,
  // never a legacy-derived summary.
  test("a Brand with ONLY a Commerce7 connection resolves SHOPIFY to null without ever returning the Commerce7 row", async () => {
    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: findRowsScopedByProvider([commerce7Row]),
      },
    );

    assert.equal(result, null);
  });

  test("cross-brand isolation holds per provider: brand-2's Commerce7 row is never returned for brand-1", async () => {
    const otherBrandC7 = makeConnectionRow({
      id: "conn-c7-other",
      brandId: "brand-2",
      provider: CommerceProvider.COMMERCE7,
      externalAccountId: "other-tenant",
    });

    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.COMMERCE7,
      {
        findConnectionRows: findRowsScopedByProvider([otherBrandC7]),
      },
    );

    assert.equal(result, null);
  });

  test("the CommerceProvider enum already carries COMMERCE7, so no schema change is needed to attach one", () => {
    assert.ok(
      Object.values(CommerceProvider).includes(CommerceProvider.COMMERCE7),
      "CommerceConnection.provider must already support COMMERCE7",
    );
  });
});

// ---------------------------------------------------------------------------
// 4: multi-connection tiebreak
// ---------------------------------------------------------------------------

describe("pickPreferredConnectionRow tiebreak", () => {
  test("4a. isPrimary wins over a more recently installed non-primary row", () => {
    const primary = makeConnectionRow({
      id: "conn-primary",
      isPrimary: true,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newerNonPrimary = makeConnectionRow({
      id: "conn-newer",
      isPrimary: false,
      installedAt: new Date("2026-06-01T00:00:00Z"),
    });

    const picked = pickPreferredConnectionRow([newerNonPrimary, primary]);
    assert.equal(picked?.id, "conn-primary");
  });

  test("4b. among equally-primary rows, most recent installedAt wins", () => {
    const older = makeConnectionRow({
      id: "conn-older",
      isPrimary: false,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = makeConnectionRow({
      id: "conn-newer",
      isPrimary: false,
      installedAt: new Date("2026-03-01T00:00:00Z"),
    });

    const picked = pickPreferredConnectionRow([older, newer]);
    assert.equal(picked?.id, "conn-newer");
  });

  test("4c. final tiebreak is most recent createdAt when isPrimary and installedAt both tie", () => {
    const a = makeConnectionRow({
      id: "conn-a",
      isPrimary: false,
      installedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const b = makeConnectionRow({
      id: "conn-b",
      isPrimary: false,
      installedAt: null,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });

    const picked = pickPreferredConnectionRow([a, b]);
    assert.equal(picked?.id, "conn-b");
  });

  test("4d. empty input returns null", () => {
    assert.equal(pickPreferredConnectionRow([]), null);
  });

  test("Part 16: a CONNECTED row wins over a DISCONNECTED row even when the DISCONNECTED row is isPrimary and has a NEWER installedAt — this is the exact live-vs-stale-history bug the disconnect/reconnect lifecycle makes possible", () => {
    // Tenant X linked first, was isPrimary, then was disconnected —
    // installedAt/isPrimary are both untouched by disconnect.
    const disconnectedButOlderFieldsWin = makeConnectionRow({
      id: "conn-x-disconnected",
      status: "DISCONNECTED",
      isPrimary: true,
      installedAt: new Date("2026-06-01T00:00:00Z"),
    });
    // Tenant Y linked LATER, is the Brand's genuinely live connection right
    // now, but never became isPrimary and has an OLDER installedAt than X.
    const connectedButNominallyLosingFields = makeConnectionRow({
      id: "conn-y-connected",
      status: "CONNECTED",
      isPrimary: false,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const picked = pickPreferredConnectionRow([
      disconnectedButOlderFieldsWin,
      connectedButNominallyLosingFields,
    ]);
    assert.equal(
      picked?.id,
      "conn-y-connected",
      "the CONNECTED row must always win, regardless of isPrimary/installedAt on a historical row",
    );
  });
});

// ---------------------------------------------------------------------------
// 5: (removed — PHASE 14C-B1) `mapLegacyShopifyStatusToCommerceStatus` was
// the last runtime dependency on the Prisma `ShopifyConnectionStatus` enum;
// with the Brand-sourced dual-write path it existed for gone, it had zero
// remaining callers and was deleted from connection-resolver.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6: grantedScopes normalization
// ---------------------------------------------------------------------------

describe("grantedScopes normalization", () => {
  test("6a. comma-separated legacy string trims and drops empties", () => {
    assert.deepEqual(
      normalizeGrantedScopes("read_products, write_discounts,,  "),
      ["read_products", "write_discounts"],
    );
  });

  test("6b. null legacy string normalizes to []", () => {
    assert.deepEqual(normalizeGrantedScopes(null), []);
  });

  test("6c. Json array normalizes to string[]", () => {
    assert.deepEqual(normalizeGrantedScopesJson(["read_products", "write_discounts"]), [
      "read_products",
      "write_discounts",
    ]);
  });

  test("6d. null Json value normalizes to []", () => {
    assert.deepEqual(normalizeGrantedScopesJson(null), []);
  });

  test("6e. a non-array Json value (object) normalizes to [] without throwing", () => {
    assert.deepEqual(normalizeGrantedScopesJson({ not: "an array" } as unknown as Prisma.JsonValue), []);
  });

  test("6f. a non-array Json value (number) normalizes to [] without throwing", () => {
    assert.deepEqual(normalizeGrantedScopesJson(42 as unknown as Prisma.JsonValue), []);
  });
});

// ---------------------------------------------------------------------------
// mapCommerceConnectionToSummary
//
// Only persisted CommerceConnection rows map to summaries.
// ---------------------------------------------------------------------------

describe("pure mapping helpers", () => {
  test("mapCommerceConnectionToSummary maps canonical fields", () => {
    const row = makeConnectionRow();
    const summary = mapCommerceConnectionToSummary(row);
    assert.equal(summary.id, row.id);
    assert.equal(summary.brandId, row.brandId);
    assert.deepEqual(summary.grantedScopes, ["read_products"]);
  });

  // ---------------------------------------------------------------------
  // M. PHASE 14B.4B — currency comes from the SINGLE canonical
  // representation: `CommerceConnection.providerMetadata.currencyCode` for a
  // persisted connection metadata. No duplicate currency authority exists.
  // ---------------------------------------------------------------------
  test("M. mapCommerceConnectionToSummary sources currencyCode from providerMetadata.currencyCode", () => {
    const row = makeConnectionRow({
      providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: "CAD" },
    });
    assert.equal(mapCommerceConnectionToSummary(row).currencyCode, "CAD");
  });

  test("M. extractCurrencyCodeFromProviderMetadata tolerates malformed providerMetadata shapes without throwing", () => {
    assert.equal(extractCurrencyCodeFromProviderMetadata(null), null);
    assert.equal(extractCurrencyCodeFromProviderMetadata(undefined), null);
    assert.equal(extractCurrencyCodeFromProviderMetadata("not-an-object"), null);
    assert.equal(extractCurrencyCodeFromProviderMetadata(["array", "not", "object"]), null);
    assert.equal(extractCurrencyCodeFromProviderMetadata({}), null);
    assert.equal(extractCurrencyCodeFromProviderMetadata({ currencyCode: 123 }), null);
    assert.equal(extractCurrencyCodeFromProviderMetadata({ currencyCode: "" }), null);
    assert.equal(
      extractCurrencyCodeFromProviderMetadata({ authMode: "LEGACY_OFFLINE", currencyCode: "USD" }),
      "USD",
    );
  });
});

// ---------------------------------------------------------------------------
// buildShopifyConnectionSyncInput
// ---------------------------------------------------------------------------

describe("buildShopifyConnectionSyncInputFromInstall", () => {
  test("returns null when shopDomain is empty", () => {
    assert.equal(
      buildShopifyConnectionSyncInputFromInstall(makeInstallFacts({ shopDomain: "" })),
      null,
    );
  });

  test("returns null when accessToken is empty — an install always carries a token", () => {
    assert.equal(
      buildShopifyConnectionSyncInputFromInstall(makeInstallFacts({ accessToken: "" })),
      null,
    );
  });

  test("derives a secretPayload with the plaintext credential, always CONNECTED, uninstalledAt cleared", () => {
    const input = buildShopifyConnectionSyncInputFromInstall(makeInstallFacts());
    assert.ok(input);
    assert.ok(input?.secretPayload);
    assert.equal(input?.secretPayload?.accessToken, "shpat_live_token");
    assert.equal(input?.externalAccountId, "acme.myshopify.com");
    assert.equal(input?.storefrontUrl, "https://acme.myshopify.com");
    assert.equal(input?.status, "CONNECTED");
    assert.equal(input?.uninstalledAt, null);
  });
});

// ---------------------------------------------------------------------------
// 7-9: applyShopifyConnectionSyncFromInstall via the fake tx
// ---------------------------------------------------------------------------

describe("applyShopifyConnectionSyncFromInstall", () => {
  test("7. installing twice for the same brand produces one connection (upsert, not a second create)", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const facts = makeInstallFacts();

    const first = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);
    const second = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);

    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "updated");
    assert.equal(fakeTx.connections.size, 1);
    assert.equal(fakeTx.calls.createConnection, 1);
    assert.equal(fakeTx.calls.updateConnection, 1);
    assert.equal(fakeTx.calls.upsertConnection, 2);
  });

  test("8. relink: the same shop domain moving to a different brand reassigns brandId, no duplicate", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const facts = makeInstallFacts();

    const installedToA = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-A", facts);
    assert.equal(installedToA.outcome, "created");

    // Same shopDomain, different brand — mirrors the install route's relink
    // semantics (brand A's row loses the domain, brand B's install links it).
    const relinkedToB = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-B", facts);

    assert.equal(relinkedToB.outcome, "updated");
    assert.equal(fakeTx.connections.size, 1, "no duplicate row for the same shop domain");
    const [row] = [...fakeTx.connections.values()];
    assert.equal(row.brandId, "brand-B");
  });

  test("9. single-primary enforcement: a new primary connection clears isPrimary on the brand's other (non-CONNECTED, stale-primary) connections", async () => {
    const fakeTx = makeFakeConnectionSyncTx();

    // Seed a stale UNINSTALLED connection for brand-1 that is still marked
    // isPrimary: true from before it was uninstalled (nothing has cleared
    // it yet) — a realistic pre-existing-data scenario, since only a
    // CONNECTED row participates in the "does the brand already have a
    // primary" check.
    fakeTx.connections.set("conn-old", {
      id: "conn-old",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "UNINSTALLED",
      displayName: "old-shop",
      externalAccountId: "old-shop.myshopify.com",
      storefrontUrl: "https://old-shop.myshopify.com",
      providerClientId: null,
      isPrimary: true,
      grantedScopes: [],
      providerMetadata: {},
      installedAt: new Date("2025-01-01T00:00:00Z"),
      uninstalledAt: new Date("2025-06-01T00:00:00Z"),
      lastProductSyncAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-06-01T00:00:00Z"),
    });

    const facts = makeInstallFacts({ shopDomain: "new-shop.myshopify.com" });

    const result = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);

    assert.equal(result.outcome, "created");
    assert.equal(
      result.isPrimary,
      true,
      "no OTHER connection is CONNECTED, so the new one becomes primary",
    );
    assert.equal(
      fakeTx.connections.get("conn-old")?.isPrimary,
      false,
      "the stale primary flag on the old, now-UNINSTALLED connection must be cleared",
    );
  });

  test("9b. a second CONNECTED shop for the same brand is not primary, and does not clear the existing primary", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    fakeTx.connections.set("conn-existing", {
      id: "conn-existing",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "existing-shop",
      externalAccountId: "existing-shop.myshopify.com",
      storefrontUrl: "https://existing-shop.myshopify.com",
      providerClientId: null,
      isPrimary: true,
      grantedScopes: [],
      providerMetadata: {},
      installedAt: new Date("2025-01-01T00:00:00Z"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    });

    const facts = makeInstallFacts({ shopDomain: "second-shop.myshopify.com" });

    const result = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);

    assert.equal(result.isPrimary, false);
    assert.equal(fakeTx.connections.get("conn-existing")?.isPrimary, true);
  });

  test("P1 FIX (independent review): a fresh credential write clears a HELD refresh lease, so a stale-writer CAS can no longer match", async () => {
    // Models exactly the race the review flagged: a refresh was acquired
    // against the connection's PRIOR credential (an in-flight rotation, or a
    // leftover lease from before a relink) and is still outstanding when a
    // fresh install/relink writes a brand-new secret payload.
    const fakeTx = makeFakeConnectionSyncTx();
    const facts = makeInstallFacts();

    const first = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);
    const secretRow = fakeTx.secrets.get(first.connectionId!)!;
    // Simulate an outstanding lease acquired before the fresh sync below —
    // e.g. a refresher that called acquireCredentialRefreshLease moments ago
    // and hasn't rotated yet.
    secretRow.refreshLockId = "stale-refresher-lock";
    secretRow.refreshLockedUntil = new Date(Date.now() + 60_000);

    // A second install writes a brand-new credential for the SAME
    // connection — the exact shape of an install/relink landing while that
    // lease is held.
    const second = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);

    assert.equal(second.secretWritten, true);
    const updatedSecret = fakeTx.secrets.get(second.connectionId!)!;
    assert.equal(
      updatedSecret.refreshLockId,
      null,
      "the lease must be cleared by the fresh write, or the old holder's stale-writer CAS would still match and could overwrite this credential",
    );
    assert.equal(updatedSecret.refreshLockedUntil, null);
  });
});

// ---------------------------------------------------------------------------
// 22-26: single-primary partial-unique-index hardening
// (prisma/migrations/20260806130000_commerce_connection_single_primary +
// the corresponding ordering/retry changes in connection-sync.ts).
//
// The fake tx's `upsert` (see `makeFakeConnectionSyncTx` above) can be armed
// via `armPrimaryConflict(n)` to throw a real
// `Prisma.PrismaClientKnownRequestError` (code P2002) on the next `n`
// upserts that would set `isPrimary: true` — modeling the partial unique
// index `CommerceConnection_brandId_provider_primary_key` rejecting a
// second `isPrimary: true` row for the same (brandId, provider) written by
// a genuinely concurrent transaction. `fakeTx.order` records only the two
// operations the ordering rule cares about ("clearPrimary" / "upsert"), in
// call order.
// ---------------------------------------------------------------------------

describe("applyShopifyConnectionSyncFromInstall — primary-assignment ordering and conflict handling", () => {
  test("22. clearing siblings happens BEFORE setting the target row primary (operation ordering)", async () => {
    const fakeTx = makeFakeConnectionSyncTx();

    // A stale primary sibling that is no longer CONNECTED — same shape as
    // test 9's seed — so the new install both (a) computes isPrimary: true
    // (no OTHER *CONNECTED* sibling) and (b) has a real isPrimary: true row
    // to clear, so the ordering is actually exercised, not vacuous.
    fakeTx.connections.set("conn-old", {
      id: "conn-old",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "UNINSTALLED",
      displayName: "old-shop",
      externalAccountId: "old-shop.myshopify.com",
      storefrontUrl: "https://old-shop.myshopify.com",
      providerClientId: null,
      isPrimary: true,
      grantedScopes: [],
      providerMetadata: {},
      installedAt: new Date("2025-01-01T00:00:00Z"),
      uninstalledAt: new Date("2025-06-01T00:00:00Z"),
      lastProductSyncAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-06-01T00:00:00Z"),
    });

    const facts = makeInstallFacts({ shopDomain: "new-shop.myshopify.com" });

    const result = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);

    assert.equal(result.isPrimary, true);
    assert.deepEqual(
      fakeTx.order,
      ["clearPrimary", "upsert"],
      "the sibling-clearing updateMany must run BEFORE the upsert that (re)writes this row's isPrimary value",
    );
  });

  test("25. multiple NON-primary connections for the same brand+provider are still permitted (no false conflict)", async () => {
    const fakeTx = makeFakeConnectionSyncTx();

    // Two already-existing, non-primary CONNECTED connections for the same
    // brand+provider — allowed today (multi-store) and must remain allowed;
    // the partial unique index only constrains isPrimary: true rows, so
    // this must never be treated as a conflict.
    fakeTx.connections.set("conn-existing-1", {
      id: "conn-existing-1",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "shop-1",
      externalAccountId: "shop-1.myshopify.com",
      storefrontUrl: "https://shop-1.myshopify.com",
      providerClientId: null,
      isPrimary: true,
      grantedScopes: [],
      providerMetadata: {},
      installedAt: new Date("2025-01-01T00:00:00Z"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    });
    fakeTx.connections.set("conn-existing-2", {
      id: "conn-existing-2",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "shop-2",
      externalAccountId: "shop-2.myshopify.com",
      storefrontUrl: "https://shop-2.myshopify.com",
      providerClientId: null,
      isPrimary: false,
      grantedScopes: [],
      providerMetadata: {},
      installedAt: new Date("2025-02-01T00:00:00Z"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2025-02-01T00:00:00Z"),
      updatedAt: new Date("2025-02-01T00:00:00Z"),
    });

    const facts = makeInstallFacts({ shopDomain: "shop-3.myshopify.com" });

    const result = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);

    assert.equal(result.outcome, "created");
    assert.equal(result.isPrimary, false, "a third CONNECTED shop is not primary either");
    assert.equal(fakeTx.calls.primaryConflictsRaised, 0, "no conflict for a non-primary write");
    assert.equal(fakeTx.connections.get("conn-existing-1")?.isPrimary, true);
    assert.equal(fakeTx.connections.get("conn-existing-2")?.isPrimary, false);
    const newRow = [...fakeTx.connections.values()].find(
      (row) => row.externalAccountId === "shop-3.myshopify.com",
    );
    assert.equal(newRow?.isPrimary, false, "the newly synced third connection is also non-primary");
    assert.equal(fakeTx.connections.size, 3, "all three non-primary-or-single-primary rows coexist");
  });

  // PHASE 14C-B1: 23/24/26 (the bounded-retry-specific cases) tested
  // `syncShopifyCommerceConnectionForBrand`'s own retry loop, which no
  // longer exists — `applyShopifyConnectionSyncFromInstall` never retries
  // (see its doc comment). A primary-conflict P2002 now propagates straight
  // to the installations route, which already maps P2002/P2034 onto a 409
  // the client retries (`tests/integration-coverage.test.ts` covers that
  // route-level mapping for the shop-ownership-conflict case). This single
  // test proves the boundary moved correctly: no retry happens in this file
  // any more.
  test("23/24/26 (replacement). a primary-conflict P2002 propagates UNCAUGHT — no retry lives here any more", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    fakeTx.armPrimaryConflict(1);

    const facts = makeInstallFacts({ shopDomain: "shop-b.myshopify.com" });

    await assert.rejects(
      () => applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
      "the conflict must propagate to the caller, not be retried internally",
    );
    assert.equal(fakeTx.calls.primaryConflictsRaised, 1, "exactly one attempt, no retry");
  });
});

// ---------------------------------------------------------------------------
// 10-11: secret payload shape + credential exclusion from the summary
// ---------------------------------------------------------------------------

describe("secret payload", () => {
  test("10. encryptedPayload round-trips through decryptSecret to the expected JSON, and keyVersion is set", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const facts = makeInstallFacts({
      refreshToken: "shpat_refresh_token",
      refreshTokenExpiresAt: new Date("2026-12-01T00:00:00Z"),
      accessTokenExpiresAt: new Date("2026-08-01T00:00:00Z"),
      authMode: "EXPIRING_OFFLINE",
    });

    const result = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);

    if (!result.connectionId) {
      throw new Error("expected applyShopifyConnectionSyncFromInstall to return a connectionId");
    }
    const secretRow = fakeTx.secrets.get(result.connectionId);
    if (!secretRow) {
      throw new Error("expected a secret row to have been written for this connection");
    }
    assert.equal(secretRow.keyVersion, 1);

    const decrypted = JSON.parse(
      decryptSecret(secretRow.encryptedPayload),
    ) as ShopifyConnectionSecretPayload;
    assert.equal(decrypted.accessToken, "shpat_live_token");
    assert.equal(decrypted.refreshToken, "shpat_refresh_token");
    assert.equal(decrypted.authMode, "EXPIRING_OFFLINE");
    assert.equal(decrypted.accessTokenExpiresAt, "2026-08-01T00:00:00.000Z");
    assert.equal(decrypted.refreshTokenExpiresAt, "2026-12-01T00:00:00.000Z");
    const connection = [...fakeTx.connections.values()].find(
      (row) => row.id === result.connectionId,
    );
    assert.deepEqual(
      connection?.providerMetadata,
      { currencyCode: "CAD" },
      "install writes auth mode only into the encrypted credential payload",
    );
  });

  // PHASE 14C-A: the legacy-fallback half of this test (a summary derived
  // from `findLegacyBrandFields`) was removed along with that fallback
  // path — there is no longer a second summary shape to prove secret
  // exclusion for. The canonical-row half is unchanged.
  test("11. JSON.stringify of the resolver's returned summary never contains token/secret/encrypted/password", async () => {
    const summaryFromRow = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [makeConnectionRow()],
      },
    );
    assert.ok(summaryFromRow);
    assert.doesNotMatch(JSON.stringify(summaryFromRow), /token|secret|encrypted|password/i);
  });
});

// ---------------------------------------------------------------------------
// PHASE 14C-A: `safeSyncShopifyCommerceConnection` was deleted from
// connection-sync.ts — its only callers were runtime reverse-mirror writes
// (shopify-token-manager.ts, the app/uninstalled webhook), all of which
// were removed once nothing read `Brand.shopify*` at runtime anymore.
// PHASE 14C-B1: `syncShopifyCommerceConnectionForBrand` itself (the function
// that write used) has since been deleted too, along with the
// pre-column-drop reconciliation tool that was its last caller. The
// underlying transactional core it shared with the install path
// (`applyShopifyConnectionSync`) remains covered below via
// `applyShopifyConnectionSyncFromInstall` (test 14 and the
// primary-assignment-ordering suite).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 14: idempotency across repeated installs (loop reusing applyShopifyConnectionSyncFromInstall)
// ---------------------------------------------------------------------------

describe("idempotency across repeated installs", () => {
  test("14. running the install loop twice against a shared fake store creates nothing new on the second pass", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const brandInstalls: Array<{ brandId: string; facts: ShopifyInstallFacts }> = [
      { brandId: "brand-1", facts: makeInstallFacts({ shopDomain: "shop-one.myshopify.com" }) },
      { brandId: "brand-2", facts: makeInstallFacts({ shopDomain: "shop-two.myshopify.com" }) },
    ];

    async function runInstallPass() {
      const outcomes: string[] = [];
      for (const { brandId, facts } of brandInstalls) {
        const result = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, brandId, facts);
        outcomes.push(result.outcome);
      }
      return outcomes;
    }

    const firstPass = await runInstallPass();
    assert.deepEqual(firstPass, ["created", "created"]);
    assert.equal(fakeTx.connections.size, 2);

    const secondPass = await runInstallPass();
    assert.deepEqual(secondPass, ["updated", "updated"]);
    assert.equal(fakeTx.connections.size, 2, "second pass must not create additional rows");
    assert.equal(fakeTx.calls.createConnection, 2, "create must never be called again on the second pass");
  });
});

// ---------------------------------------------------------------------------
// 15-19: deleteShopifyCommerceConnectionByShopDomain / safe wrapper
//
// Regression coverage for the GDPR redaction bug: the delete used to be
// keyed on brandId (via a brand lookup on the brand's *current*
// externalAccountId), which both missed deletions (a stale domain's
// connection row survives when the brand has since relinked to a different
// domain, so no brand's externalAccountId matches the redacted domain
// anymore) and over-deleted (once a brand can hold more than one Shopify
// connection, a redact for one shop deleted ALL of that brand's rows). The
// fix keys the delete on (provider, externalAccountId) — the redacted shop
// domain itself — which is independent of any brand lookup entirely.
// ---------------------------------------------------------------------------

function makeFakeConnectionRow(
  overrides: Partial<FakeConnectionRow> = {},
): FakeConnectionRow {
  return {
    id: "conn-fixture",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "fixture-shop",
    externalAccountId: "fixture-shop.myshopify.com",
    storefrontUrl: "https://fixture-shop.myshopify.com",
    providerClientId: null,
    isPrimary: true,
    grantedScopes: [],
    providerMetadata: {},
    installedAt: new Date("2026-01-01T00:00:00Z"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("deleteShopifyCommerceConnectionByShopDomain", () => {
  test("15. deletes the row keyed on (provider, externalAccountId), not brandId — two connections sharing a brandId, deleting one domain leaves the other's same-brand row untouched", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    fakeTx.connections.set(
      "conn-x",
      makeFakeConnectionRow({
        id: "conn-x",
        brandId: "brand-shared",
        externalAccountId: "shop-x.myshopify.com",
      }),
    );
    fakeTx.connections.set(
      "conn-y",
      makeFakeConnectionRow({
        id: "conn-y",
        brandId: "brand-shared",
        externalAccountId: "shop-y.myshopify.com",
      }),
    );

    const result = await deleteShopifyCommerceConnectionByShopDomain(
      "shop-x.myshopify.com",
      { runTransaction: (fn) => fn(fakeTx.tx) },
    );

    assert.equal(result.outcome, "deleted");
    assert.equal(result.count, 1);
    assert.equal(fakeTx.connections.has("conn-x"), false, "the redacted domain's row is gone");
    assert.equal(
      fakeTx.connections.has("conn-y"),
      true,
      "a same-brandId row for a DIFFERENT domain must survive — if the delete were keyed on brandId instead of the domain, this row would have been removed too",
    );
  });

  test("16. scenario (a) — missed deletion: the delete still finds and removes a domain's row even though it is orphaned from the brand's current externalAccountId (no brand lookup is involved at all)", async () => {
    // Models the documented failure: Brand A installed shop X, then later
    // relinked to shop Y before X's shop/redact webhook arrived. Brand A's
    // row for shop Y is CONNECTED/primary; its row for shop X is a stale
    // UNINSTALLED leftover that a brandId-keyed, brand-lookup-gated delete
    // would never reach (no brand's externalAccountId equals X anymore).
    const fakeTx = makeFakeConnectionSyncTx();
    fakeTx.connections.set(
      "conn-stale-x",
      makeFakeConnectionRow({
        id: "conn-stale-x",
        brandId: "brand-A",
        externalAccountId: "shop-x.myshopify.com",
        status: "UNINSTALLED",
        isPrimary: false,
      }),
    );
    fakeTx.connections.set(
      "conn-current-y",
      makeFakeConnectionRow({
        id: "conn-current-y",
        brandId: "brand-A",
        externalAccountId: "shop-y.myshopify.com",
        status: "CONNECTED",
        isPrimary: true,
      }),
    );

    // No brand lookup / findBrandForSync dependency is provided at all —
    // deleteShopifyCommerceConnectionByShopDomain never needs one, which is
    // exactly why it is reachable in the route even when the route's own
    // `prisma.brand.findFirst({ where: { externalAccountId: shopDomain } })`
    // lookup returns null.
    const result = await deleteShopifyCommerceConnectionByShopDomain(
      "shop-x.myshopify.com",
      { runTransaction: (fn) => fn(fakeTx.tx) },
    );

    assert.equal(result.outcome, "deleted");
    assert.equal(result.count, 1);
    assert.equal(fakeTx.connections.has("conn-stale-x"), false);
    assert.equal(
      fakeTx.connections.has("conn-current-y"),
      true,
      "the brand's current, unrelated connection must be untouched",
    );
  });

  test("17. scenario (b) — over-deletion guard: a brand with two Shopify connections keeps the non-redacted one", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    fakeTx.connections.set(
      "conn-primary",
      makeFakeConnectionRow({
        id: "conn-primary",
        brandId: "brand-multi",
        externalAccountId: "primary-shop.myshopify.com",
        isPrimary: true,
      }),
    );
    fakeTx.connections.set(
      "conn-secondary",
      makeFakeConnectionRow({
        id: "conn-secondary",
        brandId: "brand-multi",
        externalAccountId: "secondary-shop.myshopify.com",
        isPrimary: false,
      }),
    );

    const result = await deleteShopifyCommerceConnectionByShopDomain(
      "secondary-shop.myshopify.com",
      { runTransaction: (fn) => fn(fakeTx.tx) },
    );

    assert.equal(result.outcome, "deleted");
    assert.equal(result.count, 1);
    assert.equal(fakeTx.connections.has("conn-secondary"), false);
    const survivor = fakeTx.connections.get("conn-primary");
    assert.ok(survivor, "the brand's other Shopify connection must survive the redact");
    assert.equal(survivor?.isPrimary, true, "the surviving row's fields must be untouched");
  });

  test("18. is a no-op, not an error, when no row matches the domain", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    fakeTx.connections.set(
      "conn-unrelated",
      makeFakeConnectionRow({ id: "conn-unrelated", externalAccountId: "unrelated-shop.myshopify.com" }),
    );

    const result = await deleteShopifyCommerceConnectionByShopDomain(
      "never-installed-shop.myshopify.com",
      { runTransaction: (fn) => fn(fakeTx.tx) },
    );

    assert.equal(result.outcome, "noop");
    assert.equal(result.count, 0);
    assert.equal(fakeTx.connections.size, 1, "the unrelated row must be untouched");
  });
});

// ---------------------------------------------------------------------------
// 19: safeDeleteShopifyCommerceConnectionByShopDomain never throws
// ---------------------------------------------------------------------------

describe("safeDeleteShopifyCommerceConnectionByShopDomain", () => {
  test("19. swallows a thrown error from the underlying delete and does not rethrow", async () => {
    let threw = false;
    try {
      await safeDeleteShopifyCommerceConnectionByShopDomain("shop-x.myshopify.com", {
        runTransaction: async () => {
          throw new Error("simulated transaction failure");
        },
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "safeDeleteShopifyCommerceConnectionByShopDomain must never throw");
  });
});

// ---------------------------------------------------------------------------
// 20: write-side / delete-side normalization symmetry on externalAccountId.
// buildShopifyConnectionSyncInput (write) and
// deleteShopifyCommerceConnectionByShopDomain (delete) both key off
// normalizeExternalAccountId now, so a mixed-case / whitespace-padded domain
// written by the sync must still be found by a redaction delete that
// receives a differently-cased / differently-padded form of the same
// domain. Before this fix, the write side only trimmed (no lowercasing),
// so a mixed-case write would silently survive a lowercase-keyed delete —
// reproducing the missed-erase bug covered by tests 15-19.
// ---------------------------------------------------------------------------

describe("normalizeExternalAccountId write/delete symmetry", () => {
  test("normalizeExternalAccountId trims and lowercases", () => {
    assert.equal(normalizeExternalAccountId("  Acme.MyShopify.com  "), "acme.myshopify.com");
  });

  test("20. a mixed-case / whitespace-padded domain written via the install is matched by the redaction delete", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    // Deliberately mixed-case and whitespace-padded, as a manual DB edit or
    // a future writer that skips `normalizeShopDomain` might produce.
    const facts = makeInstallFacts({ shopDomain: "  Acme.MyShopify.com  " });

    const syncResult = await applyShopifyConnectionSyncFromInstall(fakeTx.tx, "brand-1", facts);
    assert.equal(syncResult.outcome, "created");

    // The stored row's key must already be normalized (this is what makes
    // the delete below able to find it via an exact-match fake tx).
    const stored = [...fakeTx.connections.values()][0];
    assert.equal(stored?.externalAccountId, "acme.myshopify.com");

    // Redact using a DIFFERENT casing/padding of the same domain — exactly
    // what an inbound Shopify webhook or a case-varying manual write could
    // supply — and confirm the delete still finds and removes the row.
    const deleteResult = await deleteShopifyCommerceConnectionByShopDomain(
      "ACME.myshopify.com  ",
      { runTransaction: (fn) => fn(fakeTx.tx) },
    );

    assert.equal(deleteResult.outcome, "deleted");
    assert.equal(deleteResult.count, 1);
    assert.equal(fakeTx.connections.size, 0, "the write-side row must be gone after redaction");
  });
});

// ---------------------------------------------------------------------------
// 21: shop/redact route wiring (source-inspection test — same idiom as
// tests/shopify-scope-drift.test.ts). PHASE 14C-B1: the route no longer
// resolves identity via a single `if (brand)` block (see the P1 fix in
// route.ts's own header comment) — it resolves historical brand ids from
// domain-scoped history, and separately determines which of those brands'
// legacy mirrors still need clearing (`mirrorBrands`). This test asserts the
// invariant that actually matters now: the CommerceConnection erasure call
// is gated ONLY on the canonical-invalidation outcome (never STALE), never
// on whether any historical brand or legacy mirror was found — and never
// keyed on `Brand.externalAccountId` for routing.
// ---------------------------------------------------------------------------

describe("shop/redact route wiring", () => {
  test("21. calls strict deleteShopifyCommerceConnectionByShopDomain(shopDomain) unconditionally within the non-stale branch, never gated on a brand/mirror match", () => {
    const routeSource = readFileSync(
      "src/app/api/shopify/webhooks/shop/redact/route.ts",
      "utf8",
    );

    const callMatch = routeSource.match(
      /deleteShopifyCommerceConnectionByShopDomain\(([^)]*)\)/,
    );
    assert.ok(
      callMatch,
      "shop/redact route must call the strict connection deleter",
    );
    assert.equal(
      callMatch?.[1].trim(),
      "shopDomain",
      "must be called with the redacted shop domain",
    );

    const outerGateOpenIndex = routeSource.indexOf(
      'if (canonicalInvalidation.outcome !== "STALE_EVENT_IGNORED") {',
    );
    assert.ok(
      outerGateOpenIndex >= 0,
      "route must gate the whole scrub on the canonical invalidation NOT being a stale, superseded event",
    );

    // Find the matching close brace for the outer gate via brace counting.
    let depth = 0;
    let outerGateCloseIndex = -1;
    for (let i = outerGateOpenIndex; i < routeSource.length; i++) {
      const char = routeSource[i];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          outerGateCloseIndex = i;
          break;
        }
      }
    }
    assert.ok(outerGateCloseIndex > outerGateOpenIndex, "must find the closing brace of the outer gate");

    const callIndex = routeSource.indexOf("deleteShopifyCommerceConnectionByShopDomain(");
    assert.ok(
      callIndex > outerGateOpenIndex && callIndex < outerGateCloseIndex,
      "the erasure call must be inside the outer (non-stale) gate",
    );

    assert.doesNotMatch(
      routeSource,
      /safeDeleteShopifyCommerceConnectionByShopDomain/,
      "redaction must never acknowledge a swallowed canonical-delete failure",
    );

    // It must NOT additionally be nested inside the per-brand mirror loop —
    // that loop only decides which legacy Brand rows to clear, and must
    // never gate the canonical CommerceConnection erasure itself.
    const mirrorLoopOpenIndex = routeSource.indexOf("for (const mirrorBrand of mirrorBrands)");
    if (mirrorLoopOpenIndex >= 0) {
      const loopBraceIndex = routeSource.indexOf("{", mirrorLoopOpenIndex);
      let loopDepth = 0;
      let mirrorLoopCloseIndex = -1;
      for (let i = loopBraceIndex; i < routeSource.length; i++) {
        const char = routeSource[i];
        if (char === "{") loopDepth += 1;
        if (char === "}") {
          loopDepth -= 1;
          if (loopDepth === 0) {
            mirrorLoopCloseIndex = i;
            break;
          }
        }
      }
      assert.ok(
        callIndex < loopBraceIndex || callIndex > mirrorLoopCloseIndex,
        "the erasure call must not be nested inside the per-brand legacy-mirror loop",
      );
    }

    // Routing must never key off `Brand.externalAccountId` — only the
    // legacy-mirror-clearing `prisma.brand.findMany` (scoped to
    // `historicalBrandIds`) may still reference it, and that call must
    // filter on `id: { in: historicalBrandIds }`, not resolve identity by
    // domain alone.
    assert.doesNotMatch(
      routeSource,
      /prisma\.brand\.findFirst\(\{\s*where:\s*\{\s*externalAccountId/,
      "must never resolve identity via a direct Brand.externalAccountId findFirst",
    );
  });

  test("22. brandRewardOffer.updateMany is scoped to sourceExternalAccountId, never to brandId IN historicalBrandIds (PHASE 14C-B1.1)", () => {
    const routeSource = readFileSync(
      "src/app/api/shopify/webhooks/shop/redact/route.ts",
      "utf8",
    );

    // The over-broad predicate from Phase 14C-B1 must be gone entirely.
    assert.doesNotMatch(
      routeSource,
      /brandRewardOffer\.updateMany\(\{\s*where:\s*\{\s*brandId/,
      "must never deactivate offers by brandId IN historicalBrandIds — that touches offers unrelated to the redacted shop",
    );

    const callMatch = routeSource.match(
      /brandRewardOffer\.updateMany\(\{\s*where:\s*\{([^}]*)\},\s*data:\s*\{([^}]*)\}/,
    );
    assert.ok(callMatch, "shop/redact route must call brandRewardOffer.updateMany");
    assert.match(
      callMatch![1],
      /sourceExternalAccountId:\s*shopDomain/,
      "the offer predicate must filter on sourceExternalAccountId === the redacted domain",
    );
    assert.doesNotMatch(
      callMatch![1],
      /appliesTo/,
      "the offer predicate must not special-case appliesTo — sourceExternalAccountId is populated for every offer type",
    );
    assert.match(
      callMatch![2],
      /isActive:\s*false/,
      "matched offers must be deactivated",
    );
    assert.match(
      callMatch![2],
      /sourceExternalAccountId:\s*null/,
      "matched offers must have their now-dangling sourceExternalAccountId scrubbed",
    );

    // Exactly one brandRewardOffer.updateMany call in the whole route — the
    // old two-call shape (broad deactivate + narrow scrub) is now a single
    // combined call.
    const allCalls = routeSource.match(/brandRewardOffer\.updateMany\(/g) ?? [];
    assert.equal(
      allCalls.length,
      1,
      "exactly one brandRewardOffer.updateMany call — deactivation and scrub are combined into a single shop-scoped operation",
    );
  });
});
