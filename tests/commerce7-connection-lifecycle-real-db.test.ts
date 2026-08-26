// ---------------------------------------------------------------------------
// PHASE 20 HOTFIX (Part 7) — real PostgreSQL proof for the Commerce7
// disconnect/reconnect lifecycle's multi-tenant / cross-Brand invariants:
//
//   1. Brand A disconnects Tenant X (SQRATCH-side DISCONNECTED, app still
//      installed at Commerce7).
//   2. A DIFFERENT Commerce7 Tenant Y links to the SAME Brand A via the
//      EXISTING, unmodified install/link flow
//      (`src/lib/commerce/link-connection.ts`) — this hotfix does not touch
//      that flow; this test only proves it still composes correctly with
//      the new disconnect/reconnect actions.
//   3. Tenant X's row (and all its history) is completely untouched by
//      linking Y — no shared mutable state between the two.
//   4. Tenant Y becomes usable (CONNECTED) for Brand A.
//   5. A SEPARATE attempt to link Tenant Y to a DIFFERENT Brand B is
//      rejected — the existing `@@unique([provider, externalAccountId])`
//      backstop (enforced explicitly by `linkProviderInstallationToBrand`)
//      continues to prevent one Commerce7 tenant being silently attached to
//      two Brands.
//   6. Reconnecting Tenant X later returns the SAME `CommerceConnection.id`
//      — never a second row.
//
// PHASE 20 (settings sync / one-active-Commerce7-store round) added the
// active-slot invariant proof to the SAME scenario above (X and Y can never
// both be active for Brand A at once — reconnecting X while Y is still
// active is rejected), and a SEPARATE "Part 22" test below proves the
// Brand-level serialization primitive itself under genuine Postgres
// concurrency: two DIFFERENT, not-yet-connected tenants racing to become
// the SAME Brand's first active Commerce7 connection.
//
// A DI-mocked test can prove ORCHESTRATION is correct but cannot prove two
// independent, already-reviewed subsystems (this hotfix's lifecycle service,
// and the pre-existing link-connection flow) genuinely compose against a
// real database with real unique-constraint enforcement. This file is that
// proof; it never runs against the configured production/dev DATABASE_URL
// and is SKIPPED by default — see `tests/commerce-connection-lock.test.ts`'s
// header for the full disposable-Postgres setup ritual (identical here).
//
// To run it against a disposable local Postgres (same cluster used for
// tests/commerce-connection-lock.test.ts is fine — this file needs no
// separate database, only its own feature flag):
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/sqratch_lock_test \
//   DIRECT_URL=postgresql://postgres@127.0.0.1:55432/sqratch_lock_test \
//   PG_SSL_REJECT_UNAUTHORIZED=false \
//   ALLOW_REAL_DATABASE_TESTS=true \
//   COMMERCE7_CONNECTION_LIFECYCLE=true \
//   npx tsx --test tests/commerce7-connection-lifecycle-real-db.test.ts
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { CommerceInstallationStatus, CommerceProvider, type Prisma } from "@prisma/client";
import { canUseRealDatabaseUnderTest } from "../src/lib/db-safety";

const realDbDecision = canUseRealDatabaseUnderTest({
  connectionString: process.env.DATABASE_URL ?? "",
  allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS,
});

const ENABLED = process.env.COMMERCE7_CONNECTION_LIFECYCLE === "true" && realDbDecision.allowed;

const SKIP_REASON = realDbDecision.allowed
  ? "requires COMMERCE7_CONNECTION_LIFECYCLE=true and a real disposable Postgres (see file header)"
  : `requires COMMERCE7_CONNECTION_LIFECYCLE=true and the full db-safety opt-in (${realDbDecision.reason}) — see file header`;

async function cleanup(
  prisma: typeof import("../src/lib/prisma").default,
  brandIds: string[],
  connectionIds: string[],
  installationIds: string[],
) {
  await prisma.commerceConnectionEvent.deleteMany({ where: { brandId: { in: brandIds } } });
  await prisma.commerceConnectionLinkIntent.deleteMany({ where: { installationId: { in: installationIds } } });
  await prisma.commerceConnection.deleteMany({ where: { id: { in: connectionIds } } });
  await prisma.commerceProviderInstallation.deleteMany({ where: { id: { in: installationIds } } });
  await prisma.brand.deleteMany({ where: { id: { in: brandIds } } });
}

test(
  "Part 7: real Postgres — disconnect X, link a DIFFERENT tenant Y to the SAME Brand, X untouched, Y usable, cross-Brand Y rejected, reconnect X preserves its id",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { disconnectCommerce7Connection, reconnectCommerce7Connection } = await import(
      "../src/lib/commerce/providers/commerce7-connection-lifecycle"
    );
    const { linkProviderInstallationToBrand } = await import("../src/lib/commerce/link-connection");
    const { createLinkIntent, hashLinkToken } = await import("../src/lib/commerce/provider-installation");

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const brandA = await prisma.brand.create({
      data: { name: `Lifecycle Brand A ${unique}`, slug: `lifecycle-a-${unique}` },
    });
    const brandB = await prisma.brand.create({
      data: { name: `Lifecycle Brand B ${unique}`, slug: `lifecycle-b-${unique}` },
    });

    const tenantX = `tenant-x-${unique}`;
    const tenantY = `tenant-y-${unique}`;

    const installationX = await prisma.commerceProviderInstallation.create({
      data: { provider: CommerceProvider.COMMERCE7, externalAccountId: tenantX, status: CommerceInstallationStatus.INSTALLED },
    });
    const installationY = await prisma.commerceProviderInstallation.create({
      data: { provider: CommerceProvider.COMMERCE7, externalAccountId: tenantY, status: CommerceInstallationStatus.INSTALLED },
    });

    const connectionX = await prisma.commerceConnection.create({
      data: {
        brandId: brandA.id,
        provider: CommerceProvider.COMMERCE7,
        status: "CONNECTED",
        displayName: "Tenant X Store",
        externalAccountId: tenantX,
      },
    });

    const brandIds = [brandA.id, brandB.id];
    const connectionIds = [connectionX.id];
    const installationIds = [installationX.id, installationY.id];

    try {
      // 1. Disconnect X.
      const disconnectResult = await disconnectCommerce7Connection({
        brandId: brandA.id,
        connectionId: connectionX.id,
      });
      assert.equal(disconnectResult.status, "DISCONNECTED");

      const xAfterDisconnect = await prisma.commerceConnection.findUniqueOrThrow({ where: { id: connectionX.id } });
      assert.equal(xAfterDisconnect.status, "DISCONNECTED");

      // 2. Link a DIFFERENT tenant Y to the SAME Brand A via the existing,
      // unmodified link flow.
      const linkIntentY = await createLinkIntent(prisma as unknown as Prisma.TransactionClient, {
        installationId: installationY.id,
      });
      const linkIntentYRow = await prisma.commerceConnectionLinkIntent.findUniqueOrThrow({
        where: { tokenHash: hashLinkToken(linkIntentY.rawToken) },
        select: { id: true },
      });
      const linkResult = await prisma.$transaction((tx) =>
        linkProviderInstallationToBrand(tx, {
          intentId: linkIntentYRow.id,
          installationId: installationY.id,
          provider: CommerceProvider.COMMERCE7,
          externalAccountId: tenantY,
          brandId: brandA.id,
          displayName: "Tenant Y Store",
        }),
      );
      assert.equal(linkResult.ok, true);
      const connectionYId = linkResult.ok ? linkResult.connectionId : null;
      assert.ok(connectionYId);
      assert.notEqual(connectionYId, connectionX.id, "Y must be a genuinely separate connection row from X");
      connectionIds.push(connectionYId!);

      // 3. X is completely untouched by linking Y.
      const xAfterLinkY = await prisma.commerceConnection.findUniqueOrThrow({ where: { id: connectionX.id } });
      assert.equal(xAfterLinkY.status, "DISCONNECTED", "X's data survives Y being linked — no shared mutable state");
      assert.equal(xAfterLinkY.externalAccountId, tenantX);

      // 4. Y is usable.
      const yRow = await prisma.commerceConnection.findUniqueOrThrow({ where: { id: connectionYId! } });
      assert.equal(yRow.status, "CONNECTED");
      assert.equal(yRow.brandId, brandA.id);

      // 5. Attempting to link the SAME tenant Y to a DIFFERENT Brand B is
      // rejected — the existing cross-Brand backstop.
      const linkIntentYAgain = await createLinkIntent(prisma as unknown as Prisma.TransactionClient, {
        installationId: installationY.id,
      });
      const secondIntentRow = await prisma.commerceConnectionLinkIntent.findUniqueOrThrow({
        where: { tokenHash: hashLinkToken(linkIntentYAgain.rawToken) },
        select: { id: true },
      });
      const crossBrandResult = await prisma.$transaction((tx) =>
        linkProviderInstallationToBrand(tx, {
          intentId: secondIntentRow.id,
          installationId: installationY.id,
          provider: CommerceProvider.COMMERCE7,
          externalAccountId: tenantY,
          brandId: brandB.id,
          displayName: "Tenant Y Store (attempted second Brand)",
        }),
      );
      assert.equal(crossBrandResult.ok, false);
      assert.equal(!crossBrandResult.ok && crossBrandResult.reason, "OWNED_BY_OTHER_BRAND");
      const yAfterRejectedCrossLink = await prisma.commerceConnection.findUniqueOrThrow({ where: { id: connectionYId! } });
      assert.equal(yAfterRejectedCrossLink.brandId, brandA.id, "Y must remain owned by Brand A — never silently transferred");

      // 5b. Y is still the Brand's active Commerce7 connection, so
      // reconnecting X right now must be rejected by the one-active-store
      // invariant — never silently create two live Commerce7 connections.
      const blockedReconnect = await reconnectCommerce7Connection(
        { brandId: brandA.id, connectionId: connectionX.id },
        { fetchSettings: async () => ({ storefrontUrl: "https://x.example.com", currencyCode: "USD", productRoute: "/product" }) },
      );
      assert.equal(blockedReconnect.status, "COMMERCE7_STORE_ALREADY_CONNECTED");
      const xStillBlocked = await prisma.commerceConnection.findUniqueOrThrow({ where: { id: connectionX.id } });
      assert.equal(xStillBlocked.status, "DISCONNECTED", "X must remain DISCONNECTED while Y occupies the active slot");

      // 6. Disconnect Y, freeing the slot, THEN reconnecting X preserves the
      // SAME connection id. (fetchSettings is injected here — this is a
      // disposable test cluster, not a real Commerce7 sandbox; the Setting
      // API call itself is proven separately, against a real HTTP fake, in
      // tests/commerce7-settings.test.ts.)
      const disconnectY = await disconnectCommerce7Connection({ brandId: brandA.id, connectionId: connectionYId! });
      assert.equal(disconnectY.status, "DISCONNECTED");

      const reconnectResult = await reconnectCommerce7Connection(
        { brandId: brandA.id, connectionId: connectionX.id },
        {
          fetchSettings: async () => ({
            storefrontUrl: "https://x-reconnected.example.com",
            currencyCode: "USD",
            productRoute: "/product",
          }),
        },
      );
      assert.equal(reconnectResult.status, "CONNECTED");
      assert.equal(reconnectResult.connectionId, connectionX.id, "reconnect must return the SAME id, never a new row");

      const xAfterReconnect = await prisma.commerceConnection.findUniqueOrThrow({ where: { id: connectionX.id } });
      assert.equal(xAfterReconnect.status, "CONNECTED");
      assert.equal(xAfterReconnect.id, connectionX.id);
      assert.equal(xAfterReconnect.storefrontUrl, "https://x-reconnected.example.com", "the freshly-fetched settings were applied");
    } finally {
      await cleanup(prisma, brandIds, connectionIds, installationIds);
    }
  },
);

// ---------------------------------------------------------------------------
// Part 22 — real Postgres concurrency proof for the Brand-level
// serialization primitive (`lockBrandForTransaction`,
// `src/lib/commerce/brand-row-lock.ts`). Two DIFFERENT, already-installed
// Commerce7 tenants (X, Y) race to become the SAME Brand's first active
// Commerce7 connection — NEITHER has an existing connection row, so this is
// exactly the race a per-connection lock structurally cannot prevent (see
// that file's header). Exactly one must win.
// ---------------------------------------------------------------------------
test(
  "Part 22: real Postgres — two different tenants racing to link the SAME Brand concurrently: exactly one becomes active, the loser gets a controlled conflict, then disconnect winner + connect loser succeeds",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { disconnectCommerce7Connection } = await import(
      "../src/lib/commerce/providers/commerce7-connection-lifecycle"
    );
    const { linkProviderInstallationToBrand } = await import("../src/lib/commerce/link-connection");
    const { createLinkIntent, hashLinkToken } = await import("../src/lib/commerce/provider-installation");

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const brandA = await prisma.brand.create({
      data: { name: `Race Brand A ${unique}`, slug: `race-brand-a-${unique}` },
    });

    const tenantX = `race-tenant-x-${unique}`;
    const tenantY = `race-tenant-y-${unique}`;

    const installationX = await prisma.commerceProviderInstallation.create({
      data: { provider: CommerceProvider.COMMERCE7, externalAccountId: tenantX, status: CommerceInstallationStatus.INSTALLED },
    });
    const installationY = await prisma.commerceProviderInstallation.create({
      data: { provider: CommerceProvider.COMMERCE7, externalAccountId: tenantY, status: CommerceInstallationStatus.INSTALLED },
    });

    const intentX = await createLinkIntent(prisma as unknown as Prisma.TransactionClient, {
      installationId: installationX.id,
    });
    const intentXRow = await prisma.commerceConnectionLinkIntent.findUniqueOrThrow({
      where: { tokenHash: hashLinkToken(intentX.rawToken) },
      select: { id: true },
    });
    const intentY = await createLinkIntent(prisma as unknown as Prisma.TransactionClient, {
      installationId: installationY.id,
    });
    const intentYRow = await prisma.commerceConnectionLinkIntent.findUniqueOrThrow({
      where: { tokenHash: hashLinkToken(intentY.rawToken) },
      select: { id: true },
    });

    const brandIds = [brandA.id];
    const connectionIds: string[] = [];
    const installationIds = [installationX.id, installationY.id];

    try {
      // Force genuine concurrency: both transactions start, both reach
      // `lockBrandForTransaction` at roughly the same time — Postgres
      // itself (not application code) decides which one's real row lock
      // wins and which one genuinely waits.
      const [resultX, resultY] = await Promise.all([
        prisma.$transaction((tx) =>
          linkProviderInstallationToBrand(tx, {
            intentId: intentXRow.id,
            installationId: installationX.id,
            provider: CommerceProvider.COMMERCE7,
            externalAccountId: tenantX,
            brandId: brandA.id,
            displayName: "Tenant X",
          }),
        ),
        prisma.$transaction((tx) =>
          linkProviderInstallationToBrand(tx, {
            intentId: intentYRow.id,
            installationId: installationY.id,
            provider: CommerceProvider.COMMERCE7,
            externalAccountId: tenantY,
            brandId: brandA.id,
            displayName: "Tenant Y",
          }),
        ),
      ]);

      const outcomes = [resultX, resultY];
      const winners = outcomes.filter((r) => r.ok);
      const losers = outcomes.filter((r) => !r.ok);

      assert.equal(winners.length, 1, "EXACTLY ONE of X/Y must become active");
      assert.equal(losers.length, 1, "the other must receive a controlled conflict");
      assert.equal(
        !losers[0].ok && losers[0].reason,
        "COMMERCE7_STORE_ALREADY_CONNECTED",
        "the loser's conflict must be the active-slot invariant, not an accidental error",
      );

      const winnerConnectionId = winners[0].ok ? winners[0].connectionId : null;
      assert.ok(winnerConnectionId);
      connectionIds.push(winnerConnectionId!);

      // Exactly one CONNECTED Commerce7 row for this Brand — never two.
      const liveRows = await prisma.commerceConnection.findMany({
        where: { brandId: brandA.id, provider: CommerceProvider.COMMERCE7, status: "CONNECTED" },
      });
      assert.equal(liveRows.length, 1, "exactly one live Commerce7 connection must exist for this Brand");
      assert.equal(liveRows[0].id, winnerConnectionId);

      // Disconnect the winner, then the loser's tenant can connect.
      const disconnectWinner = await disconnectCommerce7Connection({
        brandId: brandA.id,
        connectionId: winnerConnectionId!,
      });
      assert.equal(disconnectWinner.status, "DISCONNECTED");

      const xLost = !resultX.ok;
      const loserInstallationId = xLost ? installationX.id : installationY.id;
      const loserExternalAccountId = xLost ? tenantX : tenantY;

      const retryIntent = await createLinkIntent(prisma as unknown as Prisma.TransactionClient, {
        installationId: loserInstallationId,
      });
      const retryIntentRow = await prisma.commerceConnectionLinkIntent.findUniqueOrThrow({
        where: { tokenHash: hashLinkToken(retryIntent.rawToken) },
        select: { id: true },
      });
      const retryResult = await prisma.$transaction((tx) =>
        linkProviderInstallationToBrand(tx, {
          intentId: retryIntentRow.id,
          installationId: loserInstallationId,
          provider: CommerceProvider.COMMERCE7,
          externalAccountId: loserExternalAccountId,
          brandId: brandA.id,
          displayName: "Loser tenant, retried",
        }),
      );
      assert.equal(retryResult.ok, true, "after disconnecting the winner, the loser's tenant can connect");
      if (retryResult.ok) connectionIds.push(retryResult.connectionId);
    } finally {
      await cleanup(prisma, brandIds, connectionIds, installationIds);
    }
  },
);
