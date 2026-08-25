// ---------------------------------------------------------------------------
// PHASE 19 REPAIR (real-lock round) — real PostgreSQL proof for
// `lockCommerceConnectionForTransaction` (src/lib/commerce/connection-row-lock.ts)
// and the two correctness properties it underpins: the atomic same-connection
// sync claim (`claimProductSyncRun`, P1-2) and the per-write config-freshness
// fence (`applyProductWrite`, P1-1).
//
// A DI-mocked test can prove ORCHESTRATION is correct (the right functions
// are called in the right order with the right arguments) but CANNOT prove
// that a lock primitive actually blocks a concurrent PostgreSQL transaction
// — that is a property of the real database engine, not of this codebase's
// logic. This file is the required real-database proof; it never runs
// against the configured production/dev DATABASE_URL and is SKIPPED by
// default so `npm test` stays fully mockable and safe without any database
// available.
//
// The documented invariant (mirrors tests/point-account-concurrency.test.ts
// — do not weaken this without updating both): setting
// COMMERCE_CONNECTION_LOCK=true alone is NOT sufficient to run these tests
// for real. Running against a real database additionally requires the full
// three-part opt-in from src/lib/db-safety.ts's canUseRealDatabaseUnderTest
// — (a) ALLOW_REAL_DATABASE_TESTS=true, (b) a loopback/local DATABASE_URL
// host (never a production Supabase host), and (c) a database name ending
// in "_test". canUseRealDatabaseUnderTest's three conditions are evaluated
// UNCONDITIONALLY (no test-mode-detection dependency), so a production or
// non-"_test" DATABASE_URL is refused regardless of how this file is
// invoked — see db-safety.ts's own header for the full rationale.
//
// To run it against a disposable local Postgres:
//
//   1. Start a throwaway cluster with SSL enabled (src/lib/prisma.ts
//      requires SSL by default; PG_SSL_REJECT_UNAUTHORIZED=false + a
//      self-signed cert is sufficient), e.g.:
//        initdb -D /tmp/sqratch-lock-pgdata --no-locale
//        cd /tmp/sqratch-lock-pgdata
//        openssl req -new -x509 -days 3 -nodes -text \
//          -out server.crt -keyout server.key -subj "/CN=localhost"
//        chmod 600 server.key
//        printf '\nssl = on\nssl_cert_file = %s\nssl_key_file = %s\n' \
//          "'server.crt'" "'server.key'" >> postgresql.conf
//        pg_ctl -D /tmp/sqratch-lock-pgdata \
//          -o "-p 55432 -k /tmp/sqratch-lock-sock -h 127.0.0.1" start
//        createdb -h 127.0.0.1 -p 55432 sqratch_lock_test
//   2. Sync the schema (no migration files, disposable DB only):
//        npx prisma db push --accept-data-loss \
//          --url postgresql://postgres@127.0.0.1:55432/sqratch_lock_test
//   3. Run (database name ends in "_test" — required condition (c);
//      ALLOW_REAL_DATABASE_TESTS=true is required condition (a);
//      the loopback host satisfies condition (b)):
//        DATABASE_URL=postgresql://postgres@127.0.0.1:55432/sqratch_lock_test \
//        DIRECT_URL=postgresql://postgres@127.0.0.1:55432/sqratch_lock_test \
//        PG_SSL_REJECT_UNAUTHORIZED=false \
//        ALLOW_REAL_DATABASE_TESTS=true \
//        COMMERCE_CONNECTION_LOCK=true \
//        npx tsx --test tests/commerce-connection-lock.test.ts
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { CommerceProvider } from "@prisma/client";
import { canUseRealDatabaseUnderTest } from "../src/lib/db-safety";
import type { CommerceAdapter } from "../src/lib/commerce/adapter";
import type { CommerceCapabilities, ProductSyncResult } from "../src/lib/commerce/types";

const realDbDecision = canUseRealDatabaseUnderTest({
  connectionString: process.env.DATABASE_URL ?? "",
  allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS,
});

const ENABLED =
  process.env.COMMERCE_CONNECTION_LOCK === "true" && realDbDecision.allowed;

const SKIP_REASON = realDbDecision.allowed
  ? "requires COMMERCE_CONNECTION_LOCK=true and a real disposable Postgres (see file header)"
  : `requires COMMERCE_CONNECTION_LOCK=true and the full db-safety opt-in (${realDbDecision.reason}) — see file header`;

function zeroCapabilities(overrides: Partial<CommerceCapabilities> = {}): CommerceCapabilities {
  return {
    products: { sync: true, publicDestinations: true },
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
    ...overrides,
  };
}

async function makeBrandAndConnection(prisma: typeof import("../src/lib/prisma").default) {
  const brand = await prisma.brand.create({
    data: { name: `Lock Test Brand ${Date.now()}-${Math.random()}`, slug: `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const connection = await prisma.commerceConnection.create({
    data: {
      brandId: brand.id,
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "Lock Test Store",
      externalAccountId: `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
      providerMetadata: { currencyCode: "USD" },
    },
  });
  return { brand, connection };
}

async function cleanup(
  prisma: typeof import("../src/lib/prisma").default,
  brandId: string,
  connectionId: string,
) {
  await prisma.commerceProductSyncRun.deleteMany({ where: { connectionId } });
  await prisma.connectedCommerceProduct.deleteMany({ where: { connectionId } });
  await prisma.commerceConnection.deleteMany({ where: { id: connectionId } });
  await prisma.brand.deleteMany({ where: { id: brandId } });
}

// ---------------------------------------------------------------------------
// 3A/14A — the lock call must emit a REAL UPDATE, not a SELECT-only no-op.
// ---------------------------------------------------------------------------
test(
  "3A/14A: lockCommerceConnectionForTransaction emits a real UPDATE and genuinely changes updatedAt",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { lockCommerceConnectionForTransaction } = await import(
      "../src/lib/commerce/connection-row-lock"
    );
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      const before = connection.updatedAt.getTime();
      // Real DB round-trip time is >= 1ms; a short pause guarantees a
      // distinguishable timestamp even on a very fast local disk.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = await prisma.$transaction((tx) =>
        lockCommerceConnectionForTransaction(tx, connection.id),
      );

      assert.ok(
        result.updatedAt.getTime() > before,
        "the lock call must have genuinely changed updatedAt — proof that a real UPDATE, not a SELECT-only no-op, was emitted",
      );

      const reread = await prisma.commerceConnection.findUniqueOrThrow({
        where: { id: connection.id },
        select: { updatedAt: true },
      });
      assert.equal(
        reread.updatedAt.getTime(),
        result.updatedAt.getTime(),
        "the write must be durably committed, not merely returned in-memory",
      );
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);

// ---------------------------------------------------------------------------
// 3B/14B — same-connection blocking: T2 must not complete while T1 holds
// the lock, and must proceed only after T1 commits.
// ---------------------------------------------------------------------------
test(
  "3B/14B: T2 locking the SAME connection blocks until T1 commits",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { lockCommerceConnectionForTransaction } = await import(
      "../src/lib/commerce/connection-row-lock"
    );
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      let releaseT1: () => void = () => {};
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      let signalT1Locked: () => void = () => {};
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });

      const t1Promise = prisma.$transaction(async (tx) => {
        await lockCommerceConnectionForTransaction(tx, connection.id);
        signalT1Locked();
        await t1Gate;
      });

      await t1Locked;

      let t2Completed = false;
      let t2CompletedAt = 0;
      const t2Promise = prisma
        .$transaction((tx) => lockCommerceConnectionForTransaction(tx, connection.id))
        .then(() => {
          t2Completed = true;
          t2CompletedAt = Date.now();
        });

      // Deterministic negative proof (not the primary proof — see the
      // timestamp-ordering assertion below): if T2 were NOT actually
      // blocked by a real row lock, its round trip against a local
      // Postgres instance completes in low single-digit milliseconds. A
      // 150ms window is a wide, non-flaky margin to observe "still not
      // done" for a genuinely blocked transaction, while remaining far
      // shorter than a human would notice — this is a safety margin for
      // the negative check, not a sleep used AS the proof of blocking.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        t2Completed,
        false,
        "T2 must still be blocked while T1 holds the real row lock open",
      );

      const t1ReleasedAt = Date.now();
      releaseT1();
      await t1Promise;
      await t2Promise;

      assert.equal(t2Completed, true, "T2 must proceed once T1 releases the lock");
      assert.ok(
        t2CompletedAt >= t1ReleasedAt,
        "T2's completion must be causally AFTER T1's release — the definitive (non-timing-based) proof of real blocking",
      );
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);

// ---------------------------------------------------------------------------
// 3C — different-connection independence: locking Y never waits on X.
// ---------------------------------------------------------------------------
test(
  "3C: locking a DIFFERENT connection never waits on another connection's held lock",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { lockCommerceConnectionForTransaction } = await import(
      "../src/lib/commerce/connection-row-lock"
    );
    const { brand: brandX, connection: connectionX } = await makeBrandAndConnection(prisma);
    const { brand: brandY, connection: connectionY } = await makeBrandAndConnection(prisma);

    try {
      let releaseX: () => void = () => {};
      const xGate = new Promise<void>((resolve) => {
        releaseX = resolve;
      });
      let signalXLocked: () => void = () => {};
      const xLocked = new Promise<void>((resolve) => {
        signalXLocked = resolve;
      });

      const xPromise = prisma.$transaction(async (tx) => {
        await lockCommerceConnectionForTransaction(tx, connectionX.id);
        signalXLocked();
        await xGate;
      });

      await xLocked;

      const yStartedAt = Date.now();
      await prisma.$transaction((tx) => lockCommerceConnectionForTransaction(tx, connectionY.id));
      const yCompletedAt = Date.now();

      assert.ok(
        yCompletedAt - yStartedAt < 150,
        `locking connection Y must complete quickly while X is held (took ${yCompletedAt - yStartedAt}ms) — proves per-row, not global, locking`,
      );

      releaseX();
      await xPromise;
    } finally {
      await cleanup(prisma, brandX.id, connectionX.id);
      await cleanup(prisma, brandY.id, connectionY.id);
    }
  },
);

// ---------------------------------------------------------------------------
// Part 7/7A — real atomic same-connection claim via the actual service
// entry point, with a fake adapter (no real provider HTTP) but REAL DB
// persistence for the claim/lock/run-row logic.
// ---------------------------------------------------------------------------
test(
  "Part 7/7A: two concurrent syncCommerceConnectionById calls for the SAME connection — exactly one claims, one is ALREADY_RUNNING, provider fetch count is 1",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { syncCommerceConnectionById } = await import("../src/lib/commerce/product-sync");
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      let fetchCallCount = 0;
      let releaseFetch: () => void = () => {};
      const fetchGate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      let signalFetchStarted: () => void = () => {};
      const fetchStarted = new Promise<void>((resolve) => {
        signalFetchStarted = resolve;
      });

      const fakeAdapter: CommerceAdapter = {
        provider: CommerceProvider.SHOPIFY,
        getCapabilities: () => zeroCapabilities(),
        async getConnection() {
          throw new Error("not used in this test");
        },
        async syncProducts(connectionId): Promise<ProductSyncResult> {
          fetchCallCount += 1;
          signalFetchStarted();
          await fetchGate;
          return {
            connectionId,
            provider: CommerceProvider.SHOPIFY,
            products: [],
            productCount: 0,
            syncedAt: new Date(),
            hasNextPage: false,
            limit: 50,
          };
        },
      };

      const callA = syncCommerceConnectionById(
        { brandId: brand.id, provider: CommerceProvider.SHOPIFY, connectionId: connection.id },
        {},
        { getAdapter: () => fakeAdapter },
      );

      // Proves A's claim already committed (the claim happens strictly
      // BEFORE the provider fetch in runProductSync) — a real signal, not
      // a sleep.
      await fetchStarted;

      const outcomeB = await syncCommerceConnectionById(
        { brandId: brand.id, provider: CommerceProvider.SHOPIFY, connectionId: connection.id },
        {},
        { getAdapter: () => fakeAdapter },
      );

      assert.equal(outcomeB.status, "ALREADY_RUNNING");
      assert.equal(fetchCallCount, 1, "B must never reach the provider fetch while A's claim is active");

      const runningRowsWhileActive = await prisma.commerceProductSyncRun.findMany({
        where: { connectionId: connection.id, status: "RUNNING" },
      });
      assert.equal(runningRowsWhileActive.length, 1, "exactly one fresh RUNNING run must exist for X");

      releaseFetch();
      const outcomeA = await callA;
      assert.equal(outcomeA.status, "SUCCEEDED");
      assert.equal(fetchCallCount, 1, "still exactly one fetch total");

      const runningRowsAfter = await prisma.commerceProductSyncRun.findMany({
        where: { connectionId: connection.id, status: "RUNNING" },
      });
      assert.equal(runningRowsAfter.length, 0, "A's run must have exited RUNNING on completion — no orphan row");
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);

test(
  "Part 6C/7: two DIFFERENT connections claim independently and concurrently",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { syncCommerceConnectionById } = await import("../src/lib/commerce/product-sync");
    const { brand: brandX, connection: connectionX } = await makeBrandAndConnection(prisma);
    const { brand: brandY, connection: connectionY } = await makeBrandAndConnection(prisma);

    try {
      const fakeAdapter: CommerceAdapter = {
        provider: CommerceProvider.SHOPIFY,
        getCapabilities: () => zeroCapabilities(),
        async getConnection() {
          throw new Error("not used in this test");
        },
        async syncProducts(connectionId): Promise<ProductSyncResult> {
          return {
            connectionId,
            provider: CommerceProvider.SHOPIFY,
            products: [],
            productCount: 0,
            syncedAt: new Date(),
            hasNextPage: false,
            limit: 50,
          };
        },
      };

      const [outcomeX, outcomeY] = await Promise.all([
        syncCommerceConnectionById(
          { brandId: brandX.id, provider: CommerceProvider.SHOPIFY, connectionId: connectionX.id },
          {},
          { getAdapter: () => fakeAdapter },
        ),
        syncCommerceConnectionById(
          { brandId: brandY.id, provider: CommerceProvider.SHOPIFY, connectionId: connectionY.id },
          {},
          { getAdapter: () => fakeAdapter },
        ),
      ]);

      assert.equal(outcomeX.status, "SUCCEEDED");
      assert.equal(outcomeY.status, "SUCCEEDED");
    } finally {
      await cleanup(prisma, brandX.id, connectionX.id);
      await cleanup(prisma, brandY.id, connectionY.id);
    }
  },
);

// ---------------------------------------------------------------------------
// Part 5/14D — stale config/product-write serialization against the real
// row lock: either ordering (stale write commits first, or config-save
// commits first) must leave a safe final state.
// ---------------------------------------------------------------------------
test(
  "Part 5/14D ORDER 1: a stale product write that commits BEFORE a config-save transaction is safely invalidated by that config-save",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { lockCommerceConnectionForTransaction } = await import(
      "../src/lib/commerce/connection-row-lock"
    );
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      const product = await prisma.connectedCommerceProduct.create({
        data: {
          connectionId: connection.id,
          brandId: brand.id,
          provider: CommerceProvider.SHOPIFY,
          externalKey: "prod-1",
          externalId: "prod-1",
          title: "Test Product",
          productUrl: "https://example.com/p/1",
          images: [],
          externalVariantIds: [],
          currencyCode: "USD",
          priceMinMinor: 1000,
          priceMaxMinor: 1000,
          priceMinorUnitExponent: 2,
          isAvailable: true,
          hasPublicStorefrontUrl: true,
          lastSeenAt: new Date(),
          providerMetadata: {},
        },
      });

      // The "stale write" transaction: lock, then persist real values —
      // committing BEFORE the config-save below.
      await prisma.$transaction(async (tx) => {
        await lockCommerceConnectionForTransaction(tx, connection.id);
        await tx.connectedCommerceProduct.update({
          where: { id: product.id },
          data: { currencyCode: "USD", priceMinMinor: 1000, priceMaxMinor: 1000, hasPublicStorefrontUrl: true },
        });
      });

      // The "config-save" transaction commits afterward and invalidates —
      // mirrors configureCommerce7Storefront's real shape (lock via a real
      // config UPDATE, then invalidate).
      await prisma.$transaction(async (tx) => {
        await tx.commerceConnection.update({
          where: { id: connection.id },
          data: { providerMetadata: { currencyCode: "CAD" } },
        });
        await tx.connectedCommerceProduct.updateMany({
          where: { connectionId: connection.id },
          data: { currencyCode: null, priceMinMinor: null, priceMaxMinor: null, priceMinorUnitExponent: null, hasPublicStorefrontUrl: false },
        });
      });

      const final = await prisma.connectedCommerceProduct.findUniqueOrThrow({ where: { id: product.id } });
      assert.equal(final.currencyCode, null, "ORDER 1 must leave no authoritative stale currency");
      assert.equal(final.hasPublicStorefrontUrl, false, "ORDER 1 must leave no authoritative stale public destination");
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);

test(
  "Part 5/14D ORDER 2: a config-save that commits FIRST is observed by a subsequent stale write's live re-read, which then refuses to persist stale authority",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { lockCommerceConnectionForTransaction } = await import(
      "../src/lib/commerce/connection-row-lock"
    );
    const { deriveProductConfigurationFingerprint } = await import(
      "../src/lib/commerce/product-config-fingerprint"
    );
    const { sanitizeDecisionForUntrustedConfig, decideProductWrite } = await import(
      "../src/lib/commerce/product-sync"
    );
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      const baselineRow = await prisma.commerceConnection.findUniqueOrThrow({
        where: { id: connection.id },
        select: { provider: true, storefrontUrl: true, providerMetadata: true },
      });
      const expectedFingerprint = deriveProductConfigurationFingerprint(baselineRow);

      // Config-save commits FIRST, changing the currency.
      await prisma.$transaction(async (tx) => {
        await tx.commerceConnection.update({
          where: { id: connection.id },
          data: { providerMetadata: { currencyCode: "CAD" } },
        });
      });

      // The stale write's transaction now runs — locks, re-reads, observes
      // the NEW fingerprint, and must sanitize before persisting.
      const decision = decideProductWrite(
        null,
        {
          externalKey: "prod-2",
          externalId: "prod-2",
          title: "Test Product 2",
          handle: null,
          productUrl: "https://example.com/p/2",
          imageUrl: null,
          images: [],
          externalVariantIds: [],
          descriptionText: null,
          sku: null,
          isAvailable: true,
          hasPublicStorefrontUrl: true,
          providerCreatedAt: null,
          providerUpdatedAt: null,
          providerMetadata: {},
          currencyCode: "USD",
          priceMinMinor: 1000,
          priceMaxMinor: 1000,
          priceMinorUnitExponent: 2,
        },
        new Date(),
        "run-x",
      );

      await prisma.$transaction(async (tx) => {
        await lockCommerceConnectionForTransaction(tx, connection.id);
        const liveRow = await tx.commerceConnection.findUniqueOrThrow({
          where: { id: connection.id },
          select: { provider: true, storefrontUrl: true, providerMetadata: true },
        });
        const liveFingerprint = deriveProductConfigurationFingerprint(liveRow);
        const trustworthy = liveFingerprint === expectedFingerprint;
        assert.equal(trustworthy, false, "the live re-read must observe the config-save's committed change");
        const finalDecision = trustworthy ? decision : sanitizeDecisionForUntrustedConfig(decision);
        if (finalDecision.kind === "CREATE") {
          await tx.connectedCommerceProduct.create({
            data: {
              connectionId: connection.id,
              brandId: brand.id,
              provider: CommerceProvider.SHOPIFY,
              externalKey: "prod-2",
              ...finalDecision.data,
            },
          });
        }
      });

      const written = await prisma.connectedCommerceProduct.findFirstOrThrow({
        where: { connectionId: connection.id, externalKey: "prod-2" },
      });
      assert.equal(written.currencyCode, null, "ORDER 2 must never persist A-derived stale currency");
      assert.equal(written.hasPublicStorefrontUrl, false, "ORDER 2 must never persist A-derived stale public destination");
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);

// ---------------------------------------------------------------------------
// PHASE 20 REPAIR (stale-run lease repair, P1) — Parts 7/8/10: real
// PostgreSQL proof that `claimProductSyncRun` no longer reclaims a RUNNING
// row based on age. Before this repair, `defaultClaimProductSyncRun`
// filtered on `startedAt: { gte: notBefore }` (a 5-minute window); a row
// older than that was invisible to the claim query and a second concurrent
// claim would succeed, reaching the provider fetch while the first
// (still-genuinely-live) run was also fetching — the exact overlap this P1
// describes. These tests seed a RUNNING row directly (no wall-clock
// sleeping) with a `startedAt` set to 20 minutes and, separately, 24 hours
// in the past — both far past the OLD 5-minute cutoff AND the OLD 10-minute
// `maxDurationMs` ceiling — and prove the real claim transaction still
// refuses a concurrent request at any age, with the database never showing
// two RUNNING rows for the same connection as a result.
// ---------------------------------------------------------------------------
async function assertOldRunningRowStillBlocksClaim(
  prisma: typeof import("../src/lib/prisma").default,
  provider: CommerceProvider,
  ageMs: number,
) {
  const { syncCommerceConnectionById } = await import("../src/lib/commerce/product-sync");
  const { brand, connection } = await makeBrandAndConnection(prisma);
  // makeBrandAndConnection always creates a SHOPIFY connection; overwrite
  // the provider directly when a COMMERCE7 case is requested.
  if (provider !== connection.provider) {
    await prisma.commerceConnection.update({ where: { id: connection.id }, data: { provider } });
  }

  try {
    const oldRun = await prisma.commerceProductSyncRun.create({
      data: { connectionId: connection.id, brandId: brand.id, provider, status: "RUNNING" },
    });
    await prisma.commerceProductSyncRun.update({
      where: { id: oldRun.id },
      data: { startedAt: new Date(Date.now() - ageMs) },
    });

    let fetchCallCount = 0;
    const fakeAdapter: CommerceAdapter = {
      provider,
      getCapabilities: () => zeroCapabilities(),
      async getConnection() {
        throw new Error("not used in this test");
      },
      async syncProducts(connectionId): Promise<ProductSyncResult> {
        fetchCallCount += 1;
        return {
          connectionId,
          provider,
          products: [],
          productCount: 0,
          syncedAt: new Date(),
          hasNextPage: false,
          limit: 50,
        };
      },
    };

    const outcome = await syncCommerceConnectionById(
      { brandId: brand.id, provider, connectionId: connection.id },
      {},
      { getAdapter: () => fakeAdapter },
    );

    assert.equal(
      outcome.status,
      "ALREADY_RUNNING",
      `a ${ageMs}ms-old RUNNING row must still block a new claim through the real DB path — age alone must never prove abandonment`,
    );
    assert.equal(
      fetchCallCount,
      0,
      "Part 8: the second caller's provider fetch count must be zero — only the (simulated) first run may be doing provider I/O",
    );

    const runningRows = await prisma.commerceProductSyncRun.findMany({
      where: { connectionId: connection.id, status: "RUNNING" },
    });
    assert.equal(
      runningRows.length,
      1,
      "the database must show exactly one RUNNING row — the original, never reclaimed, never duplicated",
    );
    assert.equal(runningRows[0].id, oldRun.id, "the original run must still be the one RUNNING row");
  } finally {
    await cleanup(prisma, brand.id, connection.id);
  }
}

test(
  "Part 7/8: real Postgres — SHOPIFY, a RUNNING row 20 minutes old (past the OLD 5-minute stale cutoff) still blocks a concurrent claim; exactly one RUNNING row, zero provider fetches for the refused caller",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    await assertOldRunningRowStillBlocksClaim(prisma, CommerceProvider.SHOPIFY, 20 * 60 * 1000);
  },
);

test(
  "Part 7/8/10: real Postgres — COMMERCE7, a RUNNING row 20 minutes old still blocks a concurrent claim identically (claim policy is provider-agnostic)",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    await assertOldRunningRowStillBlocksClaim(prisma, CommerceProvider.COMMERCE7, 20 * 60 * 1000);
  },
);

test(
  "Part 7: real Postgres — a RUNNING row 24 HOURS old still blocks a concurrent claim; there is no age at which automatic reclaim occurs (Option B: no auto-reclaim, by design)",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    await assertOldRunningRowStillBlocksClaim(prisma, CommerceProvider.SHOPIFY, 24 * 60 * 60 * 1000);
  },
);

// ---------------------------------------------------------------------------
// C4 — real Postgres: the FINAL defense-in-depth invalidation is forced to
// FAIL, and the product row must ALREADY be safe purely because of the
// per-write transactional config fence. This runs the REAL service
// (`syncCommerceConnectionById` -> real `defaultApplyProductWrite`, real
// row lock, real Postgres transaction) and then inspects the ACTUAL STORED
// COLUMNS — deliberately NOT accepting `run.status === "FAILED"` as proof,
// since the whole point of the P1-1 repair is that stale data can never
// become authoritative even when the cleanup that used to be responsible
// for removing it never runs successfully.
//
// The config change is committed from inside the adapter's own fetch, i.e.
// strictly AFTER the run captured its pre-fetch fingerprint baseline and
// strictly BEFORE any product write — the exact window the fence guards.
// ---------------------------------------------------------------------------
test(
  "C4: real Postgres — when the final invalidation itself FAILS, the stored product columns are already fail-closed by the per-write fence (money null, public destination false)",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { syncCommerceConnectionById } = await import("../src/lib/commerce/product-sync");
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      const fakeAdapter: CommerceAdapter = {
        provider: CommerceProvider.SHOPIFY,
        getCapabilities: () => zeroCapabilities(),
        async getConnection() {
          throw new Error("not used in this test");
        },
        async syncProducts(connectionId): Promise<ProductSyncResult> {
          // Commit a REAL config change mid-run: after the baseline
          // fingerprint was captured, before any product write happens.
          await prisma.commerceConnection.update({
            where: { id: connection.id },
            data: { providerMetadata: { currencyCode: "CAD" } },
          });
          return {
            connectionId,
            provider: CommerceProvider.SHOPIFY,
            products: [
              {
                externalId: "c4-prod-1",
                title: "C4 Product",
                handle: "c4-product",
                productUrl: "https://example.com/products/c4-product",
                imageUrl: null,
                images: [],
                priceText: "10.00",
                currency: "USD",
                priceRange: { min: 10, max: 10 },
                priceRangeRaw: { min: "10.00", max: "10.00" },
                externalVariantIds: [],
                hasProviderStorefrontPublication: true,
                hasProviderSuppliedStorefrontUrl: true,
              },
            ],
            productCount: 1,
            syncedAt: new Date(),
            hasNextPage: false,
            limit: 50,
          };
        },
      };

      let invalidationAttempts = 0;
      const outcome = await syncCommerceConnectionById(
        { brandId: brand.id, provider: CommerceProvider.SHOPIFY, connectionId: connection.id },
        {},
        {
          getAdapter: () => fakeAdapter,
          // Force the final defense-in-depth cleanup to fail outright.
          async invalidateStaleConfigDerivedFields() {
            invalidationAttempts += 1;
            throw new Error("forced invalidation failure (C4)");
          },
        },
      );

      assert.equal(
        invalidationAttempts,
        1,
        "the config change must have been detected, so the final invalidation was genuinely attempted (and forced to fail)",
      );
      assert.equal(
        outcome.status,
        "FAILED",
        "a failed REQUIRED invalidation must downgrade the run status — observability stays accurate",
      );

      // THE ACTUAL PROOF: inspect the real stored columns. These are safe
      // ONLY because `defaultApplyProductWrite`'s row-locked live re-read
      // observed the new fingerprint and sanitized BEFORE committing — the
      // cleanup that would otherwise have fixed them never succeeded.
      const stored = await prisma.connectedCommerceProduct.findFirstOrThrow({
        where: { connectionId: connection.id, externalKey: "c4-prod-1" },
      });
      assert.equal(stored.currencyCode, null, "C4: stored currency must be null despite the failed cleanup");
      assert.equal(stored.priceMinMinor, null, "C4: stored min price must be null despite the failed cleanup");
      assert.equal(stored.priceMaxMinor, null, "C4: stored max price must be null despite the failed cleanup");
      assert.equal(
        stored.priceMinorUnitExponent,
        null,
        "C4: stored minor-unit exponent must be null despite the failed cleanup",
      );
      assert.equal(
        stored.hasPublicStorefrontUrl,
        false,
        "C4: stored public destination must be fail-closed despite the failed cleanup",
      );
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);
