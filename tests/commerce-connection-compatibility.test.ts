/**
 * tests/commerce-connection-compatibility.test.ts
 *
 * Unit tests for the Phase-1 legacy/neutral commerce-connection
 * compatibility layer:
 *   - src/lib/commerce/connection-resolver.ts (read-side resolver + pure
 *     mapping helpers)
 *   - src/lib/commerce/connection-sync.ts (idempotent dual-write, relink,
 *     single-primary enforcement, secret mirror, best-effort wrapper)
 *   - scripts/backfill-commerce-connections.ts (idempotency of the loop
 *     that reuses syncShopifyCommerceConnectionForBrand — the script
 *     itself is a thin CLI wrapper with no additional business logic to
 *     unit test, matching the precedent of
 *     scripts/import-legacy-printed-stickers.ts, which also has no
 *     dedicated test file)
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
 * Covered cases (numbered to match the review checklist):
 *  1.  Resolver prefers an existing CommerceConnection row over legacy Brand fields.
 *  2.  Resolver falls back to legacy Brand fields when no connection row exists.
 *  3.  Resolver returns null for a brand with no Shopify connection at all.
 *  4.  Multi-connection tiebreak: isPrimary wins, then most recent installedAt.
 *  5.  Legacy status mapping for all four ShopifyConnectionStatus values.
 *  6.  grantedScopes normalization: comma string, Json array, null, non-array Json.
 *  7.  Idempotency: syncing twice produces one connection (upsert, not a second create).
 *  8.  Relink: same shop domain, different brand -> brandId reassigned, no duplicate.
 *  9.  Single-primary enforcement: a new primary clears isPrimary on other connections.
 *  10. Secret encryption: encryptedPayload round-trips via decryptSecret; keyVersion is set.
 *  11. Secret exclusion: JSON.stringify(summary) never matches /token|secret|encrypted|password/i.
 *  12. Disconnected/uninstalled brand -> secret row deleted, not written empty.
 *  13. safeSyncShopifyCommerceConnection swallows a thrown error, never rethrows.
 *  14. Backfill idempotency: looping the sync twice against a shared fake store creates nothing new.
 *  15. GDPR redaction delete is keyed on (provider, externalAccountId), not brandId.
 *  16. Redaction delete still finds and removes the row when it's "orphaned" from the
 *      brand's current shopifyShopDomain (the shape of the missed-deletion bug: a stale
 *      domain's connection row survives a relink to a different domain).
 *  17. Redaction delete removes only the redacted domain's row; a brand's other Shopify
 *      connection is untouched (the shape of the over-deletion bug).
 *  18. Redaction delete is a no-op, not an error, when no row matches the domain.
 *  19. safeDeleteShopifyCommerceConnectionByShopDomain swallows a thrown error, never rethrows.
 *  20. Normalization symmetry: a mixed-case / whitespace-padded shop domain written via
 *      the sync is matched by the redaction delete keyed on a differently-cased /
 *      differently-padded form of the SAME domain — write and delete agree on the key
 *      because both go through the single exported `normalizeExternalAccountId` helper.
 *  21. Route wiring (source-inspection, same idiom as tests/shopify-scope-drift.test.ts):
 *      the shop/redact route calls `safeDeleteShopifyCommerceConnectionByShopDomain`
 *      unconditionally — NOT nested inside the `if (brand)` block — so the delete still
 *      fires for the relinked-away scenario where the brand lookup finds nothing.
 */

process.env.APP_ENCRYPTION_KEY ||= "test-encryption-key-for-commerce-sync-tests";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CommerceProvider, type Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

import {
  mapLegacyBrandToConnectionSummary,
  mapCommerceConnectionToSummary,
  mapLegacyShopifyStatusToCommerceStatus,
  normalizeLegacyGrantedScopes,
  normalizeGrantedScopesJson,
  pickPreferredConnectionRow,
  resolveCommerceConnectionForBrand,
  type CommerceConnectionRow,
  type LegacyBrandShopifyFields,
} from "../src/lib/commerce/connection-resolver";

import {
  buildShopifyConnectionSyncInput,
  syncShopifyCommerceConnectionForBrand,
  safeSyncShopifyCommerceConnection,
  deleteShopifyCommerceConnectionByShopDomain,
  safeDeleteShopifyCommerceConnectionByShopDomain,
  normalizeExternalAccountId,
  type ConnectionSyncDeps,
  type LegacyBrandForShopifySync,
  type ShopifyConnectionSecretPayload,
} from "../src/lib/commerce/connection-sync";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeLegacyBrandFields(
  overrides: Partial<LegacyBrandShopifyFields> = {},
): LegacyBrandShopifyFields {
  return {
    id: "brand-1",
    name: "Acme",
    shopifyShopDomain: "acme.myshopify.com",
    shopifyConnectionStatus: "CONNECTED",
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products,write_discounts",
    ...overrides,
  };
}

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
    ...overrides,
  };
}

function makeLegacyBrandForSync(
  overrides: Partial<LegacyBrandForShopifySync> = {},
): LegacyBrandForShopifySync {
  return {
    id: "brand-1",
    name: "Acme",
    shopifyShopDomain: "acme.myshopify.com",
    shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_live_token"),
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyConnectionStatus: "CONNECTED",
    shopifyLastProductSyncAt: null,
    shopifyCurrencyCode: "CAD",
    shopifyAccessTokenExpiresAt: null,
    shopifyRefreshTokenEncrypted: null,
    shopifyRefreshTokenExpiresAt: null,
    shopifyGrantedScopes: "read_products,write_discounts",
    shopifyClientId: null,
    shopifyAuthMode: "LEGACY_OFFLINE",
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

function makeFakeConnectionSyncTx() {
  let nextId = 1;
  const connections = new Map<string, FakeConnectionRow>();
  const secrets = new Map<string, FakeSecretRow>();
  const calls = { upsertConnection: 0, createConnection: 0, updateConnection: 0, upsertSecret: 0, secretDeleteMany: 0 };

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
  };
}

function makeSyncDeps(
  brand: LegacyBrandForShopifySync,
  fakeTx: ReturnType<typeof makeFakeConnectionSyncTx>,
): Partial<ConnectionSyncDeps> {
  return {
    findBrandForSync: async () => brand,
    runTransaction: (fn) => fn(fakeTx.tx),
  };
}

// ---------------------------------------------------------------------------
// 1-3: resolver precedence + fallback + null
// ---------------------------------------------------------------------------

describe("resolveCommerceConnectionForBrand precedence", () => {
  test("1. prefers an existing CommerceConnection row over legacy Brand fields", async () => {
    const row = makeConnectionRow({ id: "conn-real", displayName: "real-connection" });

    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [row],
        findLegacyBrandFields: async () => {
          throw new Error("must not be called when a connection row exists");
        },
      },
    );

    assert.ok(result);
    assert.equal(result?.id, "conn-real");
    assert.equal(result?.isLegacyFallback, false);
    assert.equal(result?.displayName, "real-connection");
  });

  test("2. falls back to legacy Brand fields when no connection row exists", async () => {
    const legacyBrand = makeLegacyBrandFields();

    const result = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [],
        findLegacyBrandFields: async () => legacyBrand,
      },
    );

    assert.ok(result);
    assert.equal(result?.id, null);
    assert.equal(result?.isLegacyFallback, true);
    assert.equal(result?.externalAccountId, "acme.myshopify.com");
  });

  test("3. returns null for a brand with no Shopify connection at all", async () => {
    const result = await resolveCommerceConnectionForBrand(
      "brand-no-shopify",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [],
        findLegacyBrandFields: async () =>
          makeLegacyBrandFields({ shopifyShopDomain: null }),
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
        findLegacyBrandFields: async () => null,
      },
    );

    assert.equal(result, null);
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
});

// ---------------------------------------------------------------------------
// 5: legacy status mapping
// ---------------------------------------------------------------------------

describe("mapLegacyShopifyStatusToCommerceStatus", () => {
  test("5. maps all four legacy statuses 1:1, and an unknown value to ERROR", () => {
    assert.equal(mapLegacyShopifyStatusToCommerceStatus("DISCONNECTED"), "DISCONNECTED");
    assert.equal(mapLegacyShopifyStatusToCommerceStatus("CONNECTED"), "CONNECTED");
    assert.equal(mapLegacyShopifyStatusToCommerceStatus("UNINSTALLED"), "UNINSTALLED");
    assert.equal(
      mapLegacyShopifyStatusToCommerceStatus("REQUIRES_RECONNECT"),
      "REQUIRES_RECONNECT",
    );
    assert.equal(mapLegacyShopifyStatusToCommerceStatus("SOMETHING_UNEXPECTED"), "ERROR");
  });
});

// ---------------------------------------------------------------------------
// 6: grantedScopes normalization
// ---------------------------------------------------------------------------

describe("grantedScopes normalization", () => {
  test("6a. comma-separated legacy string trims and drops empties", () => {
    assert.deepEqual(
      normalizeLegacyGrantedScopes("read_products, write_discounts,,  "),
      ["read_products", "write_discounts"],
    );
  });

  test("6b. null legacy string normalizes to []", () => {
    assert.deepEqual(normalizeLegacyGrantedScopes(null), []);
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
// mapLegacyBrandToConnectionSummary / mapCommerceConnectionToSummary
// ---------------------------------------------------------------------------

describe("pure mapping helpers", () => {
  test("mapLegacyBrandToConnectionSummary returns null when there is no shop domain", () => {
    assert.equal(
      mapLegacyBrandToConnectionSummary(makeLegacyBrandFields({ shopifyShopDomain: null })),
      null,
    );
  });

  test("mapLegacyBrandToConnectionSummary derives isPrimary: true and isLegacyFallback: true", () => {
    const summary = mapLegacyBrandToConnectionSummary(makeLegacyBrandFields());
    assert.ok(summary);
    assert.equal(summary?.isPrimary, true);
    assert.equal(summary?.isLegacyFallback, true);
    assert.equal(summary?.id, null);
    assert.equal(summary?.provider, CommerceProvider.SHOPIFY);
  });

  test("mapCommerceConnectionToSummary maps every field and sets isLegacyFallback: false", () => {
    const row = makeConnectionRow();
    const summary = mapCommerceConnectionToSummary(row);
    assert.equal(summary.isLegacyFallback, false);
    assert.equal(summary.id, row.id);
    assert.equal(summary.brandId, row.brandId);
    assert.deepEqual(summary.grantedScopes, ["read_products"]);
  });
});

// ---------------------------------------------------------------------------
// buildShopifyConnectionSyncInput
// ---------------------------------------------------------------------------

describe("buildShopifyConnectionSyncInput", () => {
  test("returns null when the brand has no shop domain", () => {
    assert.equal(
      buildShopifyConnectionSyncInput(makeLegacyBrandForSync({ shopifyShopDomain: null })),
      null,
    );
  });

  test("derives a secretPayload with decrypted credentials when a token is present", () => {
    const input = buildShopifyConnectionSyncInput(makeLegacyBrandForSync());
    assert.ok(input);
    assert.ok(input?.secretPayload);
    assert.equal(input?.secretPayload?.accessToken, "shpat_live_token");
    assert.equal(input?.externalAccountId, "acme.myshopify.com");
    assert.equal(input?.storefrontUrl, "https://acme.myshopify.com");
    assert.equal(input?.status, "CONNECTED");
  });

  test("secretPayload is null when the brand has no access token", () => {
    const input = buildShopifyConnectionSyncInput(
      makeLegacyBrandForSync({ shopifyAdminAccessTokenEncrypted: null }),
    );
    assert.ok(input);
    assert.equal(input?.secretPayload, null);
  });
});

// ---------------------------------------------------------------------------
// 7-9, 12: syncShopifyCommerceConnectionForBrand via the fake tx
// ---------------------------------------------------------------------------

describe("syncShopifyCommerceConnectionForBrand", () => {
  test("7. running the sync twice for the same brand produces one connection (upsert, not a second create)", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const brand = makeLegacyBrandForSync();

    const first = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(brand, fakeTx),
    );
    const second = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(brand, fakeTx),
    );

    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "updated");
    assert.equal(fakeTx.connections.size, 1);
    assert.equal(fakeTx.calls.createConnection, 1);
    assert.equal(fakeTx.calls.updateConnection, 1);
    assert.equal(fakeTx.calls.upsertConnection, 2);
  });

  test("8. relink: the same shop domain moving to a different brand reassigns brandId, no duplicate", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const brandA = makeLegacyBrandForSync({ id: "brand-A" });

    const installedToA = await syncShopifyCommerceConnectionForBrand(
      "brand-A",
      makeSyncDeps(brandA, fakeTx),
    );
    assert.equal(installedToA.outcome, "created");

    // Same externalAccountId (shop domain), different brand — mirrors the
    // install route's relink semantics (brand A's row loses the domain,
    // brand B's install links it).
    const brandB = makeLegacyBrandForSync({ id: "brand-B" });
    const relinkedToB = await syncShopifyCommerceConnectionForBrand(
      "brand-B",
      makeSyncDeps(brandB, fakeTx),
    );

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

    const brand = makeLegacyBrandForSync({
      id: "brand-1",
      shopifyShopDomain: "new-shop.myshopify.com",
    });

    const result = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(brand, fakeTx),
    );

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

    const brand = makeLegacyBrandForSync({
      id: "brand-1",
      shopifyShopDomain: "second-shop.myshopify.com",
    });

    const result = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(brand, fakeTx),
    );

    assert.equal(result.isPrimary, false);
    assert.equal(fakeTx.connections.get("conn-existing")?.isPrimary, true);
  });

  test("12. a disconnected/uninstalled brand with no token has its secret deleted, not written empty", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const connectedBrand = makeLegacyBrandForSync();

    const created = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(connectedBrand, fakeTx),
    );
    assert.equal(created.secretWritten, true);
    assert.equal(fakeTx.secrets.size, 1);

    const uninstalledBrand = makeLegacyBrandForSync({
      shopifyAdminAccessTokenEncrypted: null,
      shopifyRefreshTokenEncrypted: null,
      shopifyConnectionStatus: "UNINSTALLED",
    });
    const updated = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(uninstalledBrand, fakeTx),
    );

    assert.equal(updated.secretWritten, false);
    assert.equal(fakeTx.secrets.size, 0, "secret row must be deleted, never written empty");
  });
});

// ---------------------------------------------------------------------------
// 10-11: secret payload shape + credential exclusion from the summary
// ---------------------------------------------------------------------------

describe("secret payload", () => {
  test("10. encryptedPayload round-trips through decryptSecret to the expected JSON, and keyVersion is set", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const brand = makeLegacyBrandForSync({
      shopifyRefreshTokenEncrypted: encryptSecret("shpat_refresh_token"),
      shopifyRefreshTokenExpiresAt: new Date("2026-12-01T00:00:00Z"),
      shopifyAccessTokenExpiresAt: new Date("2026-08-01T00:00:00Z"),
      shopifyAuthMode: "EXPIRING_OFFLINE",
    });

    const result = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(brand, fakeTx),
    );

    if (!result.connectionId) {
      throw new Error("expected syncShopifyCommerceConnectionForBrand to return a connectionId");
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
  });

  test("11. JSON.stringify of the resolver's returned summary never contains token/secret/encrypted/password", async () => {
    const legacyBrand = makeLegacyBrandFields();
    const summaryFromLegacy = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [],
        findLegacyBrandFields: async () => legacyBrand,
      },
    );
    assert.ok(summaryFromLegacy);
    assert.doesNotMatch(JSON.stringify(summaryFromLegacy), /token|secret|encrypted|password/i);

    const summaryFromRow = await resolveCommerceConnectionForBrand(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {
        findConnectionRows: async () => [makeConnectionRow()],
        findLegacyBrandFields: async () => {
          throw new Error("must not be called");
        },
      },
    );
    assert.ok(summaryFromRow);
    assert.doesNotMatch(JSON.stringify(summaryFromRow), /token|secret|encrypted|password/i);
  });
});

// ---------------------------------------------------------------------------
// 13: safeSyncShopifyCommerceConnection never throws
// ---------------------------------------------------------------------------

describe("safeSyncShopifyCommerceConnection", () => {
  test("13. swallows a thrown error from the underlying sync and does not rethrow", async () => {
    let threw = false;
    try {
      await safeSyncShopifyCommerceConnection("brand-1", {
        findBrandForSync: async () => {
          throw new Error("simulated DB failure");
        },
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "safeSyncShopifyCommerceConnection must never throw");
  });

  test("13b. swallows a failure inside the transaction itself", async () => {
    let threw = false;
    try {
      await safeSyncShopifyCommerceConnection("brand-1", {
        findBrandForSync: async () => makeLegacyBrandForSync(),
        runTransaction: async () => {
          throw new Error("simulated transaction failure");
        },
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "safeSyncShopifyCommerceConnection must never throw");
  });
});

// ---------------------------------------------------------------------------
// 14: backfill idempotency (loop reusing syncShopifyCommerceConnectionForBrand)
// ---------------------------------------------------------------------------

describe("backfill idempotency", () => {
  test("14. running the sync loop twice against a shared fake store creates nothing new on the second pass", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const brands: LegacyBrandForShopifySync[] = [
      makeLegacyBrandForSync({ id: "brand-1", shopifyShopDomain: "shop-one.myshopify.com" }),
      makeLegacyBrandForSync({ id: "brand-2", shopifyShopDomain: "shop-two.myshopify.com" }),
    ];

    async function runBackfillPass() {
      const outcomes: string[] = [];
      for (const brand of brands) {
        const result = await syncShopifyCommerceConnectionForBrand(brand.id, {
          findBrandForSync: async () => brand,
          runTransaction: (fn) => fn(fakeTx.tx),
        });
        outcomes.push(result.outcome);
      }
      return outcomes;
    }

    const firstPass = await runBackfillPass();
    assert.deepEqual(firstPass, ["created", "created"]);
    assert.equal(fakeTx.connections.size, 2);

    const secondPass = await runBackfillPass();
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
// shopifyShopDomain), which both missed deletions (a stale domain's
// connection row survives when the brand has since relinked to a different
// domain, so no brand's shopifyShopDomain matches the redacted domain
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

  test("16. scenario (a) — missed deletion: the delete still finds and removes a domain's row even though it is orphaned from the brand's current shopifyShopDomain (no brand lookup is involved at all)", async () => {
    // Models the documented failure: Brand A installed shop X, then later
    // relinked to shop Y before X's shop/redact webhook arrived. Brand A's
    // row for shop Y is CONNECTED/primary; its row for shop X is a stale
    // UNINSTALLED leftover that a brandId-keyed, brand-lookup-gated delete
    // would never reach (no brand's shopifyShopDomain equals X anymore).
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
    // `prisma.brand.findFirst({ where: { shopifyShopDomain: shopDomain } })`
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

  test("20. a mixed-case / whitespace-padded domain written via the sync is matched by the redaction delete", async () => {
    const fakeTx = makeFakeConnectionSyncTx();
    const brand = makeLegacyBrandForSync({
      // Deliberately mixed-case and whitespace-padded, as a manual DB edit
      // or a future writer that skips `normalizeShopDomain` might produce.
      shopifyShopDomain: "  Acme.MyShopify.com  ",
    });

    const syncResult = await syncShopifyCommerceConnectionForBrand(
      "brand-1",
      makeSyncDeps(brand, fakeTx),
    );
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
// tests/shopify-scope-drift.test.ts). The library-level tests above (15-19)
// exercise deleteShopifyCommerceConnectionByShopDomain directly against a
// fake tx; they would pass identically even if the route never called it,
// or called it only inside `if (brand)`. This test reads the actual route
// source and asserts the call exists and is NOT gated on `brand` being
// found — the precise wiring that must hold for the relinked-away scenario
// (no brand currently holds the redacted domain) to still redact the
// CommerceConnection mirror.
// ---------------------------------------------------------------------------

describe("shop/redact route wiring", () => {
  test("21. calls safeDeleteShopifyCommerceConnectionByShopDomain(shopDomain) outside the `if (brand)` block", () => {
    const routeSource = readFileSync(
      "src/app/api/shopify/webhooks/shop/redact/route.ts",
      "utf8",
    );

    const callMatch = routeSource.match(
      /safeDeleteShopifyCommerceConnectionByShopDomain\(([^)]*)\)/,
    );
    assert.ok(
      callMatch,
      "shop/redact route must call safeDeleteShopifyCommerceConnectionByShopDomain",
    );
    assert.equal(
      callMatch?.[1].trim(),
      "shopDomain",
      "must be called with the redacted shop domain",
    );

    const ifBrandOpenIndex = routeSource.indexOf("if (brand) {");
    assert.ok(ifBrandOpenIndex >= 0, "route must still have an `if (brand) {` block");

    // Find the matching close brace for `if (brand) { ... }` via simple
    // brace counting, then confirm the call site is NOT between the two.
    let depth = 0;
    let ifBrandCloseIndex = -1;
    for (let i = ifBrandOpenIndex; i < routeSource.length; i++) {
      const char = routeSource[i];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          ifBrandCloseIndex = i;
          break;
        }
      }
    }
    assert.ok(ifBrandCloseIndex > ifBrandOpenIndex, "must find the closing brace of `if (brand)`");

    const callIndex = routeSource.indexOf("safeDeleteShopifyCommerceConnectionByShopDomain(");
    assert.ok(
      callIndex < ifBrandOpenIndex || callIndex > ifBrandCloseIndex,
      "safeDeleteShopifyCommerceConnectionByShopDomain must be called OUTSIDE the `if (brand)` block, " +
        "so it still runs for the relinked-away scenario where no brand currently holds the redacted domain",
    );
  });
});
