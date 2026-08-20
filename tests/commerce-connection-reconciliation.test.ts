process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/commerce-connection-reconciliation.test.ts
 *
 * Unit tests for the Phase-2 reconciliation / health-check LOGIC
 * (`src/lib/commerce/connection-reconciliation.ts`) behind
 * `scripts/reconcile-commerce-connections.ts`.
 *
 * No real DB, no real network anywhere in this file. `DATABASE_URL` above is
 * the deliberately-unreachable blocked placeholder (port 1 is never a live
 * Postgres listener) — same convention as every other test file, required
 * by `src/lib/db-safety.ts`'s guard, which now refuses a non-local host
 * under test at `src/lib/prisma.ts` module-load time.
 *
 * The repair functions under test (`syncBrand` / `rebuildSecret`) are wired
 * to the REAL `syncShopifyCommerceConnectionForBrand` /
 * `rebuildShopifyConnectionSecretForBrand` from `connection-sync.ts` —
 * dependency-injected with an in-memory fake `tx` (same idiom as
 * `tests/commerce-connection-compatibility.test.ts`'s `makeFakeConnectionSyncTx`)
 * bound to a SHARED store, so a repair genuinely mutates the same data the
 * next detection pass reads. This is not a hand-waved assertion: it proves
 * the reconciliation module composes correctly with the real Phase-1
 * dual-write, not a reimplementation of it.
 *
 * Covered cases (numbered to match the task's review checklist):
 *  1.  Dry run by default: with no --apply, ZERO writes occur.
 *  2.  Detects a missing connection row.
 *  3.  Detects stale metadata.
 *  4.  Detects a missing secret.
 *  5.  Detects a stale secret mirror via the rebuild helper's outcome, without exposing any payload.
 *  6.  Detects duplicate primaries.
 *  7.  --apply performs the repairs and the reported totals match what was actually done.
 *  8.  Idempotency: running twice in apply mode yields zero repairs on the second run.
 *  9.  Brand-id and shop-domain filters narrow the working set correctly.
 *  10. --limit is respected.
 *  11. Failures are counted and produce a non-zero exit contract without aborting the whole run.
 *  12. No output line contains anything matching /token|secret|encrypted|password/i.
 *  13. A brand with no Shopify state at all is skipped cleanly, not reported as broken.
 */

process.env.APP_ENCRYPTION_KEY ||= "test-encryption-key-for-commerce-reconciliation-tests";

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider, Prisma } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

import {
  reconcileCommerceConnections,
  findStaleConnectionFields,
  pickDuplicatePrimaryWinner,
  type ConnectionReconciliationDeps,
  type ReconciliationOptions,
} from "../src/lib/commerce/connection-reconciliation";
import {
  syncShopifyCommerceConnectionForBrand,
  rebuildShopifyConnectionSecretForBrand,
  normalizeExternalAccountId,
  type LegacyBrandForShopifySync,
  type ConnectionSyncDeps,
} from "../src/lib/commerce/connection-sync";
import type { CommerceConnectionRow } from "../src/lib/commerce/connection-resolver";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeBrand(overrides: Partial<LegacyBrandForShopifySync> = {}): LegacyBrandForShopifySync {
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
// Shared in-memory store + fake tx (bound to the store, unlike
// commerce-connection-compatibility.test.ts's per-call fresh maps — here a
// repair must be visible to the NEXT read, e.g. to prove idempotency).
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
  if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
    const cond = condition as { not?: unknown; in?: unknown[] };
    if ("not" in cond) return actual !== cond.not;
    if ("in" in cond && Array.isArray(cond.in)) return cond.in.includes(actual);
  }
  return actual === condition;
}

function matchesWhere(row: Record<string, unknown>, where: WhereClause | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => fieldMatches(row[key], condition));
}

class FakeStore {
  nextId = 1;
  brands = new Map<string, LegacyBrandForShopifySync>();
  connections = new Map<string, FakeConnectionRow>();
  secrets = new Map<string, FakeSecretRow>();
  calls = { creates: 0, updates: 0, upserts: 0, deletes: 0, secretWrites: 0, secretDeletes: 0 };

  putBrand(brand: LegacyBrandForShopifySync) {
    this.brands.set(brand.id, brand);
  }

  findByExternalId(provider: CommerceProvider, externalAccountId: string): FakeConnectionRow | undefined {
    for (const row of this.connections.values()) {
      if (row.provider === provider && row.externalAccountId === externalAccountId) return row;
    }
    return undefined;
  }

  /** Seeds a connection row directly (bypassing sync) — used to set up pre-existing drift/staleness/duplicates. */
  seedConnection(overrides: Partial<FakeConnectionRow> & { id: string }): FakeConnectionRow {
    const row: FakeConnectionRow = {
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "acme",
      externalAccountId: "acme.myshopify.com",
      storefrontUrl: "https://acme.myshopify.com",
      providerClientId: null,
      isPrimary: true,
      grantedScopes: ["read_products", "write_discounts"],
      providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: "CAD" },
      installedAt: new Date("2026-01-01T00:00:00Z"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
    this.connections.set(row.id, row);
    return row;
  }

  /**
   * Seeds a secret row whose encrypted payload is a genuine
   * `ShopifyConnectionSecretPayload` JSON blob (accessToken + auth mode etc.)
   * — matching exactly what `applyShopifyConnectionSync` / the real rebuild
   * path write, so `shopifySecretPayloadMatches`'s decrypt-and-compare
   * (reused via `determineShopifySecretRebuildOutcome`) sees a genuinely
   * comparable value instead of failing to `JSON.parse` a bare string.
   */
  seedSecret(
    connectionId: string,
    accessToken: string,
    overrides: Partial<{
      accessTokenExpiresAt: string | null;
      refreshToken: string | null;
      refreshTokenExpiresAt: string | null;
      authMode: string;
    }> = {},
  ): FakeSecretRow {
    const payloadJson = JSON.stringify({
      accessToken,
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      authMode: "LEGACY_OFFLINE",
      ...overrides,
    });
    const row: FakeSecretRow = {
      id: `secret-${this.nextId++}`,
      connectionId,
      encryptedPayload: encryptSecret(payloadJson),
      keyVersion: 1,
      rotatedAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
    this.secrets.set(connectionId, row);
    return row;
  }

  /** A Prisma-shaped transaction client bound to THIS store — writes are visible to subsequent reads/repairs. */
  tx(): Prisma.TransactionClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- captured for the closures below, which run outside this method's `this` binding.
    const store = this;
    return {
      commerceConnection: {
        async findUnique({
          where,
        }: {
          where: { provider_externalAccountId?: { provider: CommerceProvider; externalAccountId: string } };
        }) {
          const key = where.provider_externalAccountId;
          if (!key) return null;
          return store.findByExternalId(key.provider, key.externalAccountId) ?? null;
        },
        async count({ where }: { where: WhereClause }) {
          return [...store.connections.values()].filter((row) => matchesWhere(row, where)).length;
        },
        async findMany({ where }: { where?: WhereClause } = {}) {
          return [...store.connections.values()].filter((row) => matchesWhere(row, where));
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
          store.calls.upserts += 1;
          const existing = store.findByExternalId(
            where.provider_externalAccountId.provider,
            where.provider_externalAccountId.externalAccountId,
          );
          if (existing) {
            store.calls.updates += 1;
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          store.calls.creates += 1;
          const row = {
            id: `conn-${store.nextId++}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          } as FakeConnectionRow;
          store.connections.set(row.id, row);
          return row;
        },
        async updateMany({ where, data }: { where: WhereClause; data: Record<string, unknown> }) {
          store.calls.updates += 1;
          let count = 0;
          for (const row of store.connections.values()) {
            if (matchesWhere(row, where)) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return { count };
        },
        async deleteMany({ where }: { where: WhereClause }) {
          store.calls.deletes += 1;
          let count = 0;
          for (const [id, row] of [...store.connections.entries()]) {
            if (matchesWhere(row, where)) {
              store.connections.delete(id);
              store.secrets.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      },
      commerceConnectionSecret: {
        async findUnique({ where }: { where: { connectionId: string } }) {
          return store.secrets.get(where.connectionId) ?? null;
        },
        async upsert({
          where,
          create,
        }: {
          where: { connectionId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) {
          store.calls.secretWrites += 1;
          const row = {
            id: `secret-${store.nextId++}`,
            connectionId: where.connectionId,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          } as FakeSecretRow;
          store.secrets.set(where.connectionId, row);
          return row;
        },
        async deleteMany({ where }: { where: { connectionId: string | { in: string[] } } }) {
          store.calls.secretDeletes += 1;
          const ids = typeof where.connectionId === "string" ? [where.connectionId] : where.connectionId.in;
          let count = 0;
          for (const id of ids) {
            if (store.secrets.delete(id)) count += 1;
          }
          return { count };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Prisma.TransactionClient;
  }

  syncDeps(): ConnectionSyncDeps {
    return {
      findBrandForSync: async (brandId) => this.brands.get(brandId) ?? null,
      runTransaction: async (fn) => fn(this.tx()),
    };
  }

  toConnectionRow(row: FakeConnectionRow): CommerceConnectionRow {
    return {
      id: row.id,
      brandId: row.brandId,
      provider: row.provider,
      status: row.status as CommerceConnectionRow["status"],
      displayName: row.displayName,
      externalAccountId: row.externalAccountId,
      storefrontUrl: row.storefrontUrl,
      isPrimary: row.isPrimary,
      grantedScopes: row.grantedScopes as Prisma.JsonValue,
      installedAt: row.installedAt,
      uninstalledAt: row.uninstalledAt,
      lastProductSyncAt: row.lastProductSyncAt,
      createdAt: row.createdAt,
      providerMetadata: row.providerMetadata as Prisma.JsonValue,
    };
  }

  /** Builds a full `ConnectionReconciliationDeps` wired to this store's real sync/rebuild functions. */
  reconciliationDeps(options: { failBrandIds?: Set<string> } = {}): ConnectionReconciliationDeps {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- captured for the closures below, which run outside this method's `this` binding.
    const store = this;
    const syncDeps = this.syncDeps();
    return {
      async listCandidateBrands(filter) {
        let brands = [...store.brands.values()];
        if (filter.brandId) {
          brands = brands.filter((b) => b.id === filter.brandId);
        }
        if (filter.shopDomain) {
          brands = brands.filter(
            (b) => b.shopifyShopDomain && normalizeExternalAccountId(b.shopifyShopDomain) === filter.shopDomain,
          );
        }
        if (!filter.brandId && !filter.shopDomain) {
          brands = brands.filter((b) => b.shopifyShopDomain !== null);
        }
        brands = [...brands].sort((a, b) => a.id.localeCompare(b.id));
        if (filter.limit) {
          brands = brands.slice(0, filter.limit);
        }
        return brands;
      },
      async findConnectionRows(brandId, provider) {
        if (options.failBrandIds?.has(brandId)) {
          throw new Error("simulated findConnectionRows failure");
        }
        return [...store.connections.values()]
          .filter((row) => row.brandId === brandId && row.provider === provider)
          .map((row) => store.toConnectionRow(row));
      },
      async findConnectionSecretPayload(connectionId) {
        const secret = store.secrets.get(connectionId);
        return secret ? { encryptedPayload: secret.encryptedPayload } : null;
      },
      async syncBrand(brandId) {
        return syncShopifyCommerceConnectionForBrand(brandId, syncDeps);
      },
      async rebuildSecret(brandId) {
        return rebuildShopifyConnectionSecretForBrand(brandId, syncDeps);
      },
      async clearPrimaryFlags(connectionIds) {
        store.calls.updates += 1;
        let count = 0;
        for (const id of connectionIds) {
          const row = store.connections.get(id);
          if (row && row.isPrimary) {
            row.isPrimary = false;
            count += 1;
          }
        }
        return { count };
      },
    };
  }
}

async function run(store: FakeStore, opts: Partial<ReconciliationOptions> = {}, depsOptions: { failBrandIds?: Set<string> } = {}) {
  return reconcileCommerceConnections(store.reconciliationDeps(depsOptions), { apply: false, ...opts });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connection-reconciliation", () => {
  test("1. dry run by default performs ZERO writes", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    // No connection/secret seeded -> missing_connection_row AND, once repaired,
    // a secret would be needed too. Dry run must still never write.

    const report = await run(store, { apply: false });

    assert.equal(report.mode, "dry_run");
    assert.equal(store.calls.creates, 0);
    assert.equal(store.calls.updates, 0);
    assert.equal(store.calls.upserts, 0);
    assert.equal(store.calls.deletes, 0);
    assert.equal(store.calls.secretWrites, 0);
    assert.equal(store.calls.secretDeletes, 0);
    assert.equal(store.connections.size, 0);
    assert.equal(store.secrets.size, 0);
  });

  test("2. detects a missing connection row", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());

    const report = await run(store, { apply: false });

    const finding = report.findings.find((f) => f.kind === "missing_connection_row");
    assert.ok(finding, "expected a missing_connection_row finding");
    assert.equal(finding?.brandId, "brand-1");
    assert.equal(finding?.repaired, false);
    assert.equal(report.totals.created, 1);
    assert.equal(store.connections.size, 0, "dry run must not create anything");
  });

  test("3. detects stale metadata", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand({ shopifyLastProductSyncAt: new Date("2026-02-01T00:00:00Z") }));
    // Row exists but lastProductSyncAt disagrees with the brand's current value.
    const row = store.seedConnection({ id: "conn-1", lastProductSyncAt: null });
    store.seedSecret(row.id, "shpat_live_token");

    const report = await run(store, { apply: false });

    const finding = report.findings.find((f) => f.kind === "stale_connection_metadata");
    assert.ok(finding, "expected a stale_connection_metadata finding");
    assert.match(finding!.detail, /lastProductSyncAt/);
    assert.equal(report.totals.updated, 1);
  });

  test("4. detects a missing secret", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    store.seedConnection({ id: "conn-1" });
    // No secret seeded.

    const report = await run(store, { apply: false });

    const finding = report.findings.find((f) => f.kind === "missing_secret");
    assert.ok(finding, "expected a missing_secret finding");
    assert.equal(finding?.repaired, false);
    assert.equal(report.totals.created, 1);
    // No connection-level finding should also fire — metadata itself is fine.
    assert.ok(!report.findings.some((f) => f.kind === "stale_connection_metadata"));
    assert.ok(!report.findings.some((f) => f.kind === "missing_connection_row"));
  });

  test("5. detects a stale secret mirror via the rebuild helper's outcome, without exposing any payload", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    const row = store.seedConnection({ id: "conn-1" });
    store.seedSecret(row.id, "shpat_OLD_STALE_TOKEN_VALUE");

    const report = await run(store, { apply: false });

    const finding = report.findings.find((f) => f.kind === "stale_secret_mirror");
    assert.ok(finding, "expected a stale_secret_mirror finding");
    assert.equal(finding?.repaired, false);
    assert.equal(report.totals.updated, 1);
    // The finding/detail/lines must never contain the stale or current token value.
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /shpat_OLD_STALE_TOKEN_VALUE/);
    assert.doesNotMatch(serialized, /shpat_live_token/);
  });

  test("6. detects duplicate primaries", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    store.seedConnection({
      id: "conn-1",
      externalAccountId: "acme.myshopify.com", // matches Brand.shopifyShopDomain -> preferred winner
      isPrimary: true,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });
    store.seedConnection({
      id: "conn-2",
      externalAccountId: "other-acme.myshopify.com", // stale/relinked-away domain
      isPrimary: true,
      installedAt: new Date("2026-03-01T00:00:00Z"), // more recent installedAt, but NOT the brand's current domain -> must still lose
    });
    store.seedSecret("conn-1", "shpat_live_token");

    const report = await run(store, { apply: false });

    const finding = report.findings.find((f) => f.kind === "duplicate_primary");
    assert.ok(finding, "expected a duplicate_primary finding");
    assert.match(finding!.detail, /connectionId=conn-1/);
    assert.equal(report.totals.warnings, 1);
    // Dry run: nothing actually cleared yet.
    assert.equal(store.connections.get("conn-1")!.isPrimary, true);
    assert.equal(store.connections.get("conn-2")!.isPrimary, true);
  });

  test("7. --apply performs the repairs and the reported totals match what was actually done", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    // Missing connection row AND (transitively) missing secret — both should
    // be created by a single syncBrand call during apply.

    const report = await run(store, { apply: true });

    assert.equal(report.mode, "apply");
    assert.equal(report.totals.created, 1, "one connection created");
    assert.equal(report.totals.failed, 0);
    assert.equal(store.connections.size, 1);
    const created = [...store.connections.values()][0];
    assert.equal(created.externalAccountId, "acme.myshopify.com");
    assert.equal(store.secrets.size, 1, "secret should be written as part of the same sync");

    // Repair matches what the tool reported: a repaired finding is present and marked repaired.
    const finding = report.findings.find((f) => f.kind === "missing_connection_row");
    assert.equal(finding?.repaired, true);
  });

  test("7b. --apply resolves duplicate primaries by keeping the row matching the brand's CURRENT shop domain, even when another duplicate has a more recent installedAt", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand()); // shopifyShopDomain: "acme.myshopify.com"
    store.seedConnection({
      id: "conn-1",
      externalAccountId: "acme.myshopify.com", // matches Brand.shopifyShopDomain: the store that is actually live right now
      isPrimary: true,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });
    store.seedConnection({
      id: "conn-2",
      externalAccountId: "other-acme.myshopify.com", // stale, relinked-away domain
      isPrimary: true,
      installedAt: new Date("2026-03-01T00:00:00Z"), // more recent installedAt than conn-1 -- must NOT win on that basis alone
    });
    store.seedSecret("conn-1", "shpat_live_token");

    const report = await run(store, { apply: true });

    assert.equal(
      store.connections.get("conn-1")!.isPrimary,
      true,
      "row matching the brand's current shop domain keeps isPrimary despite conn-2's more recent installedAt",
    );
    assert.equal(store.connections.get("conn-2")!.isPrimary, false, "stale relinked-away row loses isPrimary");
    assert.ok(report.totals.updated >= 1);
    const finding = report.findings.find((f) => f.kind === "duplicate_primary");
    assert.equal(finding?.repaired, true);
    assert.match(finding!.detail, /connectionId=conn-1/);
  });

  test("7c. duplicate-primary resolution falls back to pickPreferredConnectionRow when NO row matches the current shop domain", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand({ shopifyShopDomain: "acme.myshopify.com" }));
    // Neither candidate's externalAccountId matches "acme.myshopify.com" -- e.g.
    // both are stale rows from earlier relinks the mirror never cleaned up.
    store.seedConnection({
      id: "conn-1",
      externalAccountId: "foo.myshopify.com",
      isPrimary: true,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });
    store.seedConnection({
      id: "conn-2",
      externalAccountId: "bar.myshopify.com",
      isPrimary: true,
      installedAt: new Date("2026-03-01T00:00:00Z"), // most recent -> pickPreferredConnectionRow's tiebreak winner
    });

    const report = await run(store, { apply: false });

    const finding = report.findings.find((f) => f.kind === "duplicate_primary");
    assert.ok(finding, "expected a duplicate_primary finding");
    assert.match(
      finding!.detail,
      /connectionId=conn-2/,
      "no candidate matches the current domain, so resolution falls back to pickPreferredConnectionRow's most-recent-installedAt tiebreak",
    );
  });

  test("pickDuplicatePrimaryWinner: falls back to pickPreferredConnectionRow when the brand has no shopifyShopDomain at all (shopDomain is null)", () => {
    const store = new FakeStore();
    const rowA = store.toConnectionRow(
      store.seedConnection({
        id: "conn-1",
        externalAccountId: "foo.myshopify.com",
        isPrimary: true,
        installedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    const rowB = store.toConnectionRow(
      store.seedConnection({
        id: "conn-2",
        externalAccountId: "bar.myshopify.com",
        isPrimary: true,
        installedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    );

    const winner = pickDuplicatePrimaryWinner([rowA, rowB], null);
    assert.equal(
      winner?.id,
      "conn-2",
      "no shopDomain to match against -> falls back to pickPreferredConnectionRow's most-recent-installedAt tiebreak",
    );
  });

  test("duplicate-primary dry-run previews the exact same kept row that --apply would actually keep, and still writes nothing", async () => {
    function seed(store: FakeStore) {
      store.putBrand(makeBrand());
      store.seedConnection({
        id: "conn-1",
        externalAccountId: "acme.myshopify.com",
        isPrimary: true,
        installedAt: new Date("2026-01-01T00:00:00Z"),
      });
      store.seedConnection({
        id: "conn-2",
        externalAccountId: "other-acme.myshopify.com",
        isPrimary: true,
        installedAt: new Date("2026-03-01T00:00:00Z"),
      });
      store.seedSecret("conn-1", "shpat_live_token");
    }

    const dryStore = new FakeStore();
    seed(dryStore);
    const dryReport = await run(dryStore, { apply: false });
    const dryFinding = dryReport.findings.find((f) => f.kind === "duplicate_primary");
    assert.ok(dryFinding);
    assert.equal(dryStore.connections.get("conn-1")!.isPrimary, true, "dry run writes nothing");
    assert.equal(dryStore.connections.get("conn-2")!.isPrimary, true, "dry run writes nothing");
    assert.equal(dryStore.calls.updates, 0, "dry run performs zero writes");

    const applyStore = new FakeStore();
    seed(applyStore);
    const applyReport = await run(applyStore, { apply: true });
    const applyFinding = applyReport.findings.find((f) => f.kind === "duplicate_primary");
    assert.ok(applyFinding);
    assert.equal(applyStore.connections.get("conn-1")!.isPrimary, true);
    assert.equal(applyStore.connections.get("conn-2")!.isPrimary, false);

    // The dry-run preview names the exact same connectionId that --apply actually kept.
    assert.match(dryFinding!.detail, /connectionId=conn-1/);
    assert.equal(dryFinding!.detail, applyFinding!.detail);
  });

  test("duplicate-primary resolution is idempotent: a second --apply run reports zero repairs", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    store.seedConnection({
      id: "conn-1",
      externalAccountId: "acme.myshopify.com",
      isPrimary: true,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });
    store.seedConnection({
      id: "conn-2",
      externalAccountId: "other-acme.myshopify.com",
      status: "DISCONNECTED",
      isPrimary: true,
      // Earlier than conn-1 so detectConnectionDrift's own (domain-unaware)
      // preferred-row pick also lands on conn-1 -- isolates this test to the
      // duplicate-primary repair alone, same reasoning as test 8 above.
      installedAt: new Date("2025-06-01T00:00:00Z"),
    });
    store.seedSecret("conn-1", "shpat_live_token");

    const first = await run(store, { apply: true });
    assert.equal(store.connections.get("conn-1")!.isPrimary, true);
    assert.equal(store.connections.get("conn-2")!.isPrimary, false);
    assert.ok(first.totals.updated >= 1, "first run clears the duplicate");

    const second = await run(store, { apply: true });
    assert.equal(second.totals.created, 0, "second run: nothing left to create");
    assert.equal(second.totals.updated, 0, "second run: nothing left to update");
    assert.equal(second.totals.warnings, 0, "second run: no duplicate primaries remain");
    assert.equal(second.findings.length, 0, "second run: no findings at all");
  });

  test("8. idempotency: running twice in apply mode yields zero repairs on the second run", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    // conn-1 matches the brand's CURRENT legacy shop domain exactly (same
    // installedAt etc.) and is CONNECTED -> no metadata staleness, so
    // resolving the duplicate never has to re-trigger a full metadata sync
    // (which would recompute isPrimary from CONNECTED-sibling count and
    // could undo the duplicate-primary fix — see connection-sync.ts's
    // SINGLE-PRIMARY ENFORCEMENT doc comment). conn-2 models the realistic
    // shape of this bug: a stale, no-longer-CONNECTED second store that was
    // left marked isPrimary=true from a prior relink/race.
    store.seedConnection({
      id: "conn-1",
      externalAccountId: "acme.myshopify.com",
      isPrimary: true,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });
    store.seedConnection({
      id: "conn-2",
      externalAccountId: "other-acme.myshopify.com",
      status: "DISCONNECTED",
      isPrimary: true,
      installedAt: new Date("2025-06-01T00:00:00Z"),
    });
    // No secret at all yet -> first run should create one for conn-1.

    const first = await run(store, { apply: true });
    assert.ok(first.totals.created + first.totals.updated > 0, "first run should report repairs");
    assert.equal(store.connections.get("conn-1")!.isPrimary, true);
    assert.equal(store.connections.get("conn-2")!.isPrimary, false);

    const second = await run(store, { apply: true });
    assert.equal(second.totals.created, 0, "second run: nothing left to create");
    assert.equal(second.totals.updated, 0, "second run: nothing left to update");
    assert.equal(second.totals.warnings, 0, "second run: no duplicate primaries remain");
    assert.equal(second.findings.length, 0, "second run: no findings at all");
  });

  test("9. brand-id and shop-domain filters narrow the working set correctly", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand({ id: "brand-1", shopifyShopDomain: "acme.myshopify.com" }));
    store.putBrand(makeBrand({ id: "brand-2", shopifyShopDomain: "other.myshopify.com" }));

    const byBrandId = await run(store, { apply: false, brandId: "brand-2" });
    assert.equal(byBrandId.totals.brandsScanned, 1);
    assert.ok(byBrandId.findings.every((f) => f.brandId === "brand-2"));

    const byShopDomain = await run(store, {
      apply: false,
      shopDomain: normalizeExternalAccountId("ACME.MyShopify.com  ".trim()),
    });
    assert.equal(byShopDomain.totals.brandsScanned, 1);
    assert.ok(byShopDomain.findings.every((f) => f.brandId === "brand-1"));
  });

  test("10. --limit is respected", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand({ id: "brand-1", shopifyShopDomain: "a.myshopify.com" }));
    store.putBrand(makeBrand({ id: "brand-2", shopifyShopDomain: "b.myshopify.com" }));
    store.putBrand(makeBrand({ id: "brand-3", shopifyShopDomain: "c.myshopify.com" }));

    const report = await run(store, { apply: false, limit: 2 });

    assert.equal(report.totals.brandsScanned, 2);
  });

  test("11. failures are counted and produce a non-zero exit contract without aborting the whole run", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand({ id: "brand-1", shopifyShopDomain: "a.myshopify.com" }));
    store.putBrand(makeBrand({ id: "brand-2", shopifyShopDomain: "b.myshopify.com" }));

    const report = await run(store, { apply: false }, { failBrandIds: new Set(["brand-1"]) });

    assert.equal(report.totals.failed, 1);
    assert.equal(report.totals.brandsScanned, 2, "the run continued to brand-2 despite brand-1 failing");
    assert.ok(report.findings.some((f) => f.brandId === "brand-2"), "brand-2 was still processed");
    assert.ok(
      report.lines.some((line) => line.includes("[ERROR]") && line.includes("brand=brand-1")),
      "an ERROR line was recorded for the failing brand",
    );
    // Exit-code contract (mirrored by the CLI wrapper): totals.failed > 0 => exit 1.
    const wouldExitNonZero = report.totals.failed > 0;
    assert.equal(wouldExitNonZero, true);
  });

  test("12. no output line contains anything matching /token|secret|encrypted|password/i", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand());
    const row = store.seedConnection({ id: "conn-1" });
    store.seedSecret(row.id, "shpat_super_secret_password_token_value");

    const dryRun = await run(store, { apply: false });

    const store2 = new FakeStore();
    store2.putBrand(makeBrand());
    const row2 = store2.seedConnection({ id: "conn-1" });
    store2.seedSecret(row2.id, "shpat_super_secret_password_token_value");
    const appliedReport = await run(store2, { apply: true });

    for (const line of [...dryRun.lines, ...appliedReport.lines]) {
      assert.doesNotMatch(line, /token|secret|encrypted|password/i, `offending line: ${line}`);
    }
  });

  test("13. a brand with no Shopify state at all is skipped cleanly, not reported as broken", async () => {
    const store = new FakeStore();
    store.putBrand(makeBrand({ id: "brand-1", shopifyShopDomain: null, shopifyAdminAccessTokenEncrypted: null }));

    const report = await run(store, { apply: false, brandId: "brand-1" });

    assert.equal(report.totals.brandsScanned, 1);
    assert.equal(report.totals.skipped, 1);
    assert.equal(report.totals.failed, 0);
    assert.equal(report.totals.warnings, 0);
    assert.equal(report.findings.length, 0);
    assert.ok(report.lines.some((line) => line.includes("skipped: no Shopify state")));
  });

  test("findStaleConnectionFields: pure comparison reports only field names, never values", async () => {
    const brand = makeBrand({ shopifyLastProductSyncAt: new Date("2026-02-01T00:00:00Z") });
    const { buildShopifyConnectionSyncInput } = await import("../src/lib/commerce/connection-sync");
    const input = buildShopifyConnectionSyncInput(brand);
    assert.ok(input);

    const store = new FakeStore();
    const row = store.seedConnection({ id: "conn-1", lastProductSyncAt: null, status: "DISCONNECTED" });

    const stale = findStaleConnectionFields(store.toConnectionRow(row), input!);
    assert.ok(stale.includes("lastProductSyncAt"));
    assert.ok(stale.includes("status"));
    for (const field of stale) {
      assert.equal(typeof field, "string");
      assert.doesNotMatch(field, /\d{4}-\d{2}-\d{2}/); // no serialized date VALUE leaking through
    }
  });
});
