process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "phase-14-credential-store-test-key-4f2a";

/**
 * tests/shopify-credential-store.test.ts
 *
 * Phase 14. Proves the CANONICAL Shopify credential store
 * (`src/lib/commerce/providers/shopify-credential-store.ts`) — the module that
 * moves live credential authority off `Brand.shopify*` onto
 * `CommerceConnection` + `CommerceConnectionSecret`.
 *
 * Every test injects a hand-written in-memory client via the module's `deps`
 * seam: no Prisma, no database, no network. Encryption is REAL
 * (`encryptSecret`/`decryptSecret` with the key pinned on line 2) — a stubbed
 * cipher would defeat the corruption tests entirely.
 *
 * Covered (letters match the phase's required-test list):
 *  E/F/G. Lease compare-and-swap: one winner, superseded writer rejected,
 *         expired lease is takeable, a loser cannot release the winner's lease.
 *  H.     Unrelated connections never contend for one another's lease.
 *  I.     Permanent failure clears the canonical credential + REQUIRES_RECONNECT.
 *  N.     No credential/ciphertext is returned or serialized outside the module.
 *  Q.     A corrupt canonical secret classifies CORRUPT_SECRET — the caller is
 *         given the information it needs to FAIL CLOSED rather than silently
 *         resurrecting a possibly-stale Brand token.
 *  R/S.   A Commerce7 connection is never selected by the Shopify credential
 *         path, and two providers on one Brand stay isolated.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CommerceProvider } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";
import {
  loadShopifyCredential,
  getShopifyCredentialAuthMode,
  acquireCredentialRefreshLease,
  releaseCredentialRefreshLease,
  persistRotatedShopifyCredential,
  markShopifyCredentialRequiresReconnect,
  writeShopifyCredential,
  invalidateShopifyCredential,
  healShopifyCredentialConnected,
  type ShopifyCredentialStoreClient,
} from "../src/lib/commerce/providers/shopify-credential-store";

const LOCK_MS = 60_000;

type ConnRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: string;
  externalAccountId: string;
  providerClientId: string | null;
  grantedScopes: unknown;
  isPrimary: boolean;
  installedAt: Date | null;
  createdAt: Date;
  providerMetadata: unknown;
};

type SecretRow = {
  connectionId: string;
  encryptedPayload: string;
  rotatedAt: Date | null;
  expiresAt: Date | null;
  refreshLockId: string | null;
  refreshLockedUntil: Date | null;
};

/**
 * A deliberately small, hand-written stand-in for the exact Prisma calls this
 * module makes. It implements the CAS predicates for real (matching on
 * `refreshLockId`, and on `refreshLockedUntil` being null/expired) — that is
 * the behavior under test, so faking it away would prove nothing.
 */
function makeStore(conns: ConnRow[], secrets: SecretRow[]) {
  const state = { conns, secrets };

  const client: ShopifyCredentialStoreClient = {
    commerceConnection: {
      async findFirst(args: unknown) {
        const a = args as {
          where: {
            id?: string;
            brandId?: string;
            externalAccountId?: string;
            provider: CommerceProvider;
          };
        };
        // Honors BOTH selectors for real, because which one a caller uses is
        // itself under test: webhooks select by shop domain, brand-admin
        // paths by brandId.
        const matches = state.conns
          .filter(
            (c) =>
              c.provider === a.where.provider &&
              (a.where.id === undefined || c.id === a.where.id) &&
              (a.where.brandId === undefined || c.brandId === a.where.brandId) &&
              (a.where.externalAccountId === undefined ||
                c.externalAccountId === a.where.externalAccountId),
          )
          .sort(
            (x, y) =>
              Number(y.isPrimary) - Number(x.isPrimary) ||
              (y.installedAt?.getTime() ?? 0) - (x.installedAt?.getTime() ?? 0) ||
              y.createdAt.getTime() - x.createdAt.getTime(),
          );
        const row = matches[0];
        if (!row) return null;
        const secret = state.secrets.find((s) => s.connectionId === row.id);
        return {
          id: row.id,
          brandId: row.brandId,
          status: row.status,
          externalAccountId: row.externalAccountId,
          providerClientId: row.providerClientId,
          grantedScopes: row.grantedScopes,
          providerMetadata: row.providerMetadata,
          secret: secret ? { encryptedPayload: secret.encryptedPayload } : null,
        };
      },
      async update(args: unknown) {
        const a = args as { where: { id: string }; data: Record<string, unknown> };
        const row = state.conns.find((c) => c.id === a.where.id);
        if (!row) throw new Error("connection not found");
        Object.assign(row, a.data);
        return row;
      },
      async findUnique(args: unknown) {
        const a = args as { where: { id: string } };
        const row = state.conns.find((c) => c.id === a.where.id);
        if (!row) return null;
        return { id: row.id, brandId: row.brandId, installedAt: row.installedAt };
      },
      // Implements the status compare-and-swap for real — the predicate IS
      // what stops a heal from resurrecting a status a newer write chose.
      async updateMany(args: unknown) {
        const a = args as {
          where: { id: string; status?: string };
          data: Record<string, unknown>;
        };
        const row = state.conns.find((c) => c.id === a.where.id);
        if (!row) return { count: 0 };
        if (a.where.status !== undefined && row.status !== a.where.status) {
          return { count: 0 };
        }
        Object.assign(row, a.data);
        return { count: 1 };
      },
    },
    commerceConnectionSecret: {
      async findUnique(args: unknown) {
        const a = args as { where: { connectionId: string } };
        return state.secrets.find((s) => s.connectionId === a.where.connectionId) ?? null;
      },
      async updateMany(args: unknown) {
        const a = args as {
          where: {
            connectionId: string;
            refreshLockId?: string;
            OR?: Array<{ refreshLockedUntil: null | { lt: Date } }>;
          };
          data: Record<string, unknown>;
        };
        const row = state.secrets.find((s) => s.connectionId === a.where.connectionId);
        if (!row) return { count: 0 };

        if (a.where.refreshLockId !== undefined && row.refreshLockId !== a.where.refreshLockId) {
          return { count: 0 };
        }
        if (a.where.OR) {
          const free =
            row.refreshLockedUntil === null ||
            row.refreshLockedUntil.getTime() <
              (a.where.OR.find((c) => c.refreshLockedUntil !== null)
                ?.refreshLockedUntil as { lt: Date }).lt.getTime();
          if (!free) return { count: 0 };
        }
        Object.assign(row, a.data);
        return { count: 1 };
      },
      async deleteMany(args: unknown) {
        const a = args as { where: { connectionId: string; refreshLockId?: string } };
        const idx = state.secrets.findIndex((s) => s.connectionId === a.where.connectionId);
        if (idx === -1) return { count: 0 };
        if (
          a.where.refreshLockId !== undefined &&
          state.secrets[idx].refreshLockId !== a.where.refreshLockId
        ) {
          return { count: 0 };
        }
        state.secrets.splice(idx, 1);
        return { count: 1 };
      },
      async upsert(args: unknown) {
        const a = args as {
          where: { connectionId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        };
        const row = state.secrets.find((s) => s.connectionId === a.where.connectionId);
        if (row) {
          Object.assign(row, a.update);
          return row;
        }
        const created = {
          connectionId: a.where.connectionId,
          encryptedPayload: "",
          rotatedAt: null,
          expiresAt: null,
          refreshLockId: null,
          refreshLockedUntil: null,
          ...a.create,
        } as SecretRow;
        state.secrets.push(created);
        return created;
      },
    },
    async $transaction<T>(fn: (tx: ShopifyCredentialStoreClient) => Promise<T>): Promise<T> {
      return fn(client);
    },
  };

  return { client, state };
}

function shopifyConn(overrides: Partial<ConnRow> = {}): ConnRow {
  return {
    id: "conn-shopify",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    externalAccountId: "acme.myshopify.com",
    providerClientId: "client-abc",
    grantedScopes: ["read_products", "read_orders"],
    isPrimary: true,
    installedAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    providerMetadata: { currencyCode: "USD" },
    ...overrides,
  };
}

function secretFor(
  connectionId: string,
  payload: Record<string, unknown>,
  overrides: Partial<SecretRow> = {},
): SecretRow {
  return {
    connectionId,
    encryptedPayload: encryptSecret(JSON.stringify(payload)),
    rotatedAt: null,
    expiresAt: null,
    refreshLockId: null,
    refreshLockedUntil: null,
    ...overrides,
  };
}

const LIVE_PAYLOAD = {
  accessToken: "shpat_live_access",
  accessTokenExpiresAt: new Date("2099-01-01T00:00:00Z").toISOString(),
  refreshToken: "shprt_live_refresh",
  refreshTokenExpiresAt: new Date("2099-06-01T00:00:00Z").toISOString(),
  authMode: "EXPIRING_OFFLINE",
};

// ---------------------------------------------------------------------------
// Load + classification
// ---------------------------------------------------------------------------

describe("loadShopifyCredential classification", () => {
  test("OK: returns the decrypted canonical credential joined to its connection", async () => {
    const { client } = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);
    const result = await loadShopifyCredential("brand-1", { client });

    assert.equal(result.outcome, "OK");
    if (result.outcome !== "OK") return;
    assert.equal(result.credential.connectionId, "conn-shopify");
    assert.equal(result.credential.shopDomain, "acme.myshopify.com");
    assert.equal(result.credential.providerClientId, "client-abc");
    assert.equal(result.credential.accessToken, "shpat_live_access");
    assert.equal(result.credential.refreshToken, "shprt_live_refresh");
    assert.equal(result.credential.authMode, "EXPIRING_OFFLINE");
    // Canonical grantedScopes is a JSON array; the legacy scope predicates
    // take CSV, so it is normalized exactly once, here.
    assert.equal(result.credential.grantedScopes, "read_products,read_orders");
  });

  test("stale providerMetadata.authMode cannot alter the credential presented to token refresh", async () => {
    const { client } = makeStore(
      [shopifyConn({ providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: "USD" } })],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const result = await loadShopifyCredential("brand-1", { client });

    assert.equal(result.outcome, "OK");
    if (result.outcome !== "OK") return;
    assert.equal(result.credential.authMode, "EXPIRING_OFFLINE");
  });

  test("NO_CONNECTION: no canonical row at all — the ONLY state where a caller may consult legacy Brand", async () => {
    const { client } = makeStore([], []);
    assert.deepEqual(await loadShopifyCredential("brand-1", { client }), {
      outcome: "NO_CONNECTION",
    });
  });

  test("NO_SECRET: connection exists but carries no canonical secret — also a permitted compatibility state", async () => {
    const { client } = makeStore([shopifyConn()], []);
    const result = await loadShopifyCredential("brand-1", { client });

    assert.equal(result.outcome, "NO_SECRET");
    if (result.outcome !== "NO_SECRET") return;
    assert.equal(result.connectionId, "conn-shopify");
    assert.equal(result.shopDomain, "acme.myshopify.com");
  });

  test("Q. CORRUPT_SECRET: undecryptable ciphertext is classified, NOT reported as absent — so the caller fails closed instead of resurrecting a stale Brand token", async () => {
    const { client } = makeStore(
      [shopifyConn()],
      [
        {
          connectionId: "conn-shopify",
          encryptedPayload: "this-is-not-valid-base64-gcm-ciphertext",
          rotatedAt: null,
          expiresAt: null,
          refreshLockId: null,
          refreshLockedUntil: null,
        },
      ],
    );
    const result = await loadShopifyCredential("brand-1", { client });

    assert.equal(result.outcome, "CORRUPT_SECRET");
    if (result.outcome !== "CORRUPT_SECRET") return;
    assert.equal(result.connectionId, "conn-shopify");
    // Critically: NOT "NO_SECRET". Conflating the two is exactly how a
    // corrupt canonical secret would silently fall back to a stale
    // credential and break rotation/stale-writer guarantees.
    assert.notEqual(result.outcome as string, "NO_SECRET");
  });

  test("Q. CORRUPT_SECRET: decryptable but non-JSON payload is also corrupt, never a partial credential", async () => {
    const { client } = makeStore(
      [shopifyConn()],
      [
        {
          connectionId: "conn-shopify",
          encryptedPayload: encryptSecret("{not json at all"),
          rotatedAt: null,
          expiresAt: null,
          refreshLockId: null,
          refreshLockedUntil: null,
        },
      ],
    );
    const result = await loadShopifyCredential("brand-1", { client });
    assert.equal(result.outcome, "CORRUPT_SECRET");
  });

  test("a transient database error PROPAGATES — it is never silently classified as absent", async () => {
    const { client } = makeStore([shopifyConn()], []);
    client.commerceConnection.findFirst = async () => {
      throw new Error("P1001: can't reach database server");
    };
    await assert.rejects(() => loadShopifyCredential("brand-1", { client }));
  });
});

describe("getShopifyCredentialAuthMode", () => {
  test("returns only the canonical secret auth mode, never provider metadata or tokens", async () => {
    const { client } = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);
    const result = await getShopifyCredentialAuthMode("conn-shopify", { client });
    assert.deepEqual(result, { outcome: "OK", authMode: "EXPIRING_OFFLINE" });
    assert.doesNotMatch(JSON.stringify(result), /access|refresh|token|secret/i);
  });

  test("fails closed for a corrupt credential payload", async () => {
    const { client } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", { ...LIVE_PAYLOAD, authMode: "EXPIRING_OFFLINE" }, {
        encryptedPayload: "corrupt-ciphertext",
      })],
    );
    assert.deepEqual(
      await getShopifyCredentialAuthMode("conn-shopify", { client }),
      { outcome: "CORRUPT_SECRET" },
    );
  });

  test("fails closed when the Shopify connection has no canonical secret", async () => {
    const { client } = makeStore([shopifyConn()], []);
    assert.deepEqual(
      await getShopifyCredentialAuthMode("conn-shopify", { client }),
      { outcome: "NO_SECRET" },
    );
  });

  test("never projects a syntactically Shopify-like Commerce7 credential", async () => {
    const commerce7 = shopifyConn({
      id: "commerce7-connection",
      provider: CommerceProvider.COMMERCE7,
      externalAccountId: "acme-winery-tenant",
    });
    const { client } = makeStore(
      [commerce7],
      [secretFor("commerce7-connection", LIVE_PAYLOAD)],
    );

    const result = await getShopifyCredentialAuthMode("commerce7-connection", { client });
    assert.deepEqual(result, { outcome: "NO_SECRET" });
    assert.equal("authMode" in result, false);
  });
});

// ---------------------------------------------------------------------------
// R / S: provider isolation
// ---------------------------------------------------------------------------

describe("R/S. provider isolation on a multi-provider Brand", () => {
  const commerce7Conn: ConnRow = {
    id: "conn-c7",
    brandId: "brand-1",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    externalAccountId: "acme-winery-tenant",
    providerClientId: "c7-client",
    grantedScopes: [],
    isPrimary: true,
    installedAt: new Date("2026-02-01T00:00:00Z"),
    createdAt: new Date("2026-02-01T00:00:00Z"),
    providerMetadata: { currencyCode: "USD" },
  };

  test("R. a Brand whose ONLY connection is Commerce7 yields NO_CONNECTION for the Shopify credential path — Commerce7 can never enter Shopify token logic", async () => {
    const { client } = makeStore(
      [commerce7Conn],
      [secretFor("conn-c7", { accessToken: "c7-token", authMode: "OTHER" })],
    );
    assert.deepEqual(await loadShopifyCredential("brand-1", { client }), {
      outcome: "NO_CONNECTION",
    });
  });

  test("S. with BOTH providers on one Brand, the Shopify path selects only the Shopify connection and its own secret", async () => {
    const { client } = makeStore(
      [shopifyConn(), commerce7Conn],
      [
        secretFor("conn-shopify", LIVE_PAYLOAD),
        secretFor("conn-c7", { accessToken: "c7-token", authMode: "OTHER" }),
      ],
    );
    const result = await loadShopifyCredential("brand-1", { client });

    assert.equal(result.outcome, "OK");
    if (result.outcome !== "OK") return;
    assert.equal(result.credential.connectionId, "conn-shopify");
    assert.equal(result.credential.accessToken, "shpat_live_access");
    assert.notEqual(result.credential.accessToken, "c7-token");
  });
});

// ---------------------------------------------------------------------------
// E / F / G / H: the refresh lease
// ---------------------------------------------------------------------------

describe("E/F/G/H. refresh lease compare-and-swap", () => {
  test("E. exactly one caller wins a free lease; the second gets null", async () => {
    const { client } = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);
    const now = Date.now();

    const first = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });
    const second = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });

    assert.ok(first, "first caller must win");
    assert.equal(second, null, "second caller must lose while the lease is live");
  });

  test("E. a superseded writer persists NOTHING — persistRotatedShopifyCredential returns false and leaves the winner's payload intact", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const now = Date.now();

    const staleLock = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });
    assert.ok(staleLock);

    // The lease expires and another caller takes it over.
    state.secrets[0].refreshLockedUntil = new Date(now - 1);
    const winnerLock = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, {
      client,
    });
    assert.ok(winnerLock);
    assert.notEqual(winnerLock, staleLock);

    const winnerOk = await persistRotatedShopifyCredential(
      {
        connectionId: "conn-shopify",
        lockId: winnerLock!,
        write: {
          authMode: "EXPIRING_OFFLINE",
          accessToken: "winner-access",
          accessTokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
          refreshToken: "winner-refresh",
          refreshTokenExpiresAt: null,
        },
        grantedScopes: "read_products",
      },
      { client },
    );
    assert.equal(winnerOk, true);

    const staleOk = await persistRotatedShopifyCredential(
      {
        connectionId: "conn-shopify",
        lockId: staleLock!,
        write: {
          authMode: "EXPIRING_OFFLINE",
          accessToken: "STALE-MUST-NOT-LAND",
          accessTokenExpiresAt: null,
          refreshToken: "STALE-REFRESH",
          refreshTokenExpiresAt: null,
        },
        grantedScopes: null,
      },
      { client },
    );
    assert.equal(staleOk, false, "the superseded writer must be rejected");

    const after = await loadShopifyCredential("brand-1", { client });
    assert.equal(after.outcome, "OK");
    if (after.outcome !== "OK") return;
    assert.equal(after.credential.accessToken, "winner-access");
    assert.equal(after.credential.refreshToken, "winner-refresh");
  });

  test("F. a rotation releases the lease atomically, so the next caller reads the winner's token and can acquire cleanly", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const now = Date.now();
    const lock = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });

    await persistRotatedShopifyCredential(
      {
        connectionId: "conn-shopify",
        lockId: lock!,
        write: {
          authMode: "EXPIRING_OFFLINE",
          accessToken: "rotated-access",
          accessTokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
          refreshToken: "rotated-refresh",
          refreshTokenExpiresAt: null,
        },
        grantedScopes: null,
      },
      { client },
    );

    assert.equal(state.secrets[0].refreshLockId, null, "lease released with the rotation");
    assert.equal(state.secrets[0].refreshLockedUntil, null);

    const loaded = await loadShopifyCredential("brand-1", { client });
    assert.equal(loaded.outcome, "OK");
    if (loaded.outcome !== "OK") return;
    assert.equal(loaded.credential.accessToken, "rotated-access");
    // And the connection was proven healthy by the successful rotation.
    assert.equal(loaded.credential.status, "CONNECTED");
  });

  test("G. an EXPIRED lease is takeable — a crashed holder can never deadlock the connection", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const now = Date.now();
    await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });

    // Holder crashes; its lease ages out.
    state.secrets[0].refreshLockedUntil = new Date(now - 1);

    const takeover = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });
    assert.ok(takeover, "an expired lease must be acquirable");
  });

  test("G. releasing with a lock id you do NOT hold frees nothing — a loser cannot release the winner's lease", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const winner = await acquireCredentialRefreshLease("conn-shopify", Date.now(), LOCK_MS, {
      client,
    });

    await releaseCredentialRefreshLease("conn-shopify", "some-other-lock-id", { client });

    assert.equal(state.secrets[0].refreshLockId, winner, "winner's lease must survive");
    assert.notEqual(state.secrets[0].refreshLockedUntil, null);
  });

  test("H. unrelated connections hold independent leases and never contend", async () => {
    const other = shopifyConn({
      id: "conn-other",
      brandId: "brand-2",
      externalAccountId: "other.myshopify.com",
    });
    const { client } = makeStore(
      [shopifyConn(), other],
      [secretFor("conn-shopify", LIVE_PAYLOAD), secretFor("conn-other", LIVE_PAYLOAD)],
    );
    const now = Date.now();

    const a = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });
    const b = await acquireCredentialRefreshLease("conn-other", now, LOCK_MS, { client });

    assert.ok(a);
    assert.ok(b, "a lease on one connection must not block another");
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// I: permanent failure
// ---------------------------------------------------------------------------

describe("I. permanent failure clears canonical credentials and requires reconnect", () => {
  test("the lease holder clears the secret and moves the connection to REQUIRES_RECONNECT", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const lock = await acquireCredentialRefreshLease("conn-shopify", Date.now(), LOCK_MS, {
      client,
    });

    const marked = await markShopifyCredentialRequiresReconnect(
      { connectionId: "conn-shopify", lockId: lock! },
      { client },
    );

    assert.equal(marked, true);
    assert.equal(state.secrets.length, 0, "canonical credential must be gone");
    assert.equal(state.conns[0].status, "REQUIRES_RECONNECT");
  });

  test("a SUPERSEDED holder cannot disconnect a merchant whose credential someone else just refreshed", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const now = Date.now();
    const staleLock = await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });
    state.secrets[0].refreshLockedUntil = new Date(now - 1);
    await acquireCredentialRefreshLease("conn-shopify", now, LOCK_MS, { client });

    const marked = await markShopifyCredentialRequiresReconnect(
      { connectionId: "conn-shopify", lockId: staleLock! },
      { client },
    );

    assert.equal(marked, false, "a superseded holder must not disconnect the merchant");
    assert.equal(state.secrets.length, 1, "the credential must survive");
    assert.equal(state.conns[0].status, "CONNECTED");
  });
});

// ---------------------------------------------------------------------------
// Install-time canonical write
// ---------------------------------------------------------------------------

describe("writeShopifyCredential (install / reconnect / token exchange)", () => {
  test("creates a canonical secret when none exists, readable back as the live credential", async () => {
    const { client, state } = makeStore([shopifyConn()], []);

    await writeShopifyCredential(
      {
        connectionId: "conn-shopify",
        write: {
          authMode: "EXPIRING_OFFLINE",
          accessToken: "fresh-install-access",
          accessTokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
          refreshToken: "fresh-install-refresh",
          refreshTokenExpiresAt: null,
        },
      },
      undefined,
      { client },
    );

    assert.equal(state.secrets.length, 1);
    const loaded = await loadShopifyCredential("brand-1", { client });
    assert.equal(loaded.outcome, "OK");
    if (loaded.outcome !== "OK") return;
    assert.equal(loaded.credential.accessToken, "fresh-install-access");
    assert.equal(loaded.credential.refreshToken, "fresh-install-refresh");
  });

  test("overwrites an existing canonical secret on reconnect without needing a lease", async () => {
    const { client } = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);

    await writeShopifyCredential(
      {
        connectionId: "conn-shopify",
        write: {
          authMode: "LEGACY_OFFLINE",
          accessToken: "reconnected-access",
          accessTokenExpiresAt: null,
          refreshToken: null,
          refreshTokenExpiresAt: null,
        },
      },
      undefined,
      { client },
    );

    const loaded = await loadShopifyCredential("brand-1", { client });
    assert.equal(loaded.outcome, "OK");
    if (loaded.outcome !== "OK") return;
    assert.equal(loaded.credential.accessToken, "reconnected-access");
    assert.equal(loaded.credential.authMode, "LEGACY_OFFLINE");
    assert.equal(loaded.credential.refreshToken, null);
  });

  test("P1 FIX (independent review): overwriting an existing secret clears a HELD refresh lease", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [
        secretFor("conn-shopify", LIVE_PAYLOAD, {
          refreshLockId: "outstanding-refresh",
          refreshLockedUntil: new Date(Date.now() + LOCK_MS),
        }),
      ],
    );

    await writeShopifyCredential(
      {
        connectionId: "conn-shopify",
        write: {
          authMode: "LEGACY_OFFLINE",
          accessToken: "reconnected-access",
          accessTokenExpiresAt: null,
          refreshToken: null,
          refreshTokenExpiresAt: null,
        },
      },
      undefined,
      { client },
    );

    assert.equal(
      state.secrets[0].refreshLockId,
      null,
      "the outstanding lease must be cleared, or its holder's CAS could still overwrite this write",
    );
    assert.equal(state.secrets[0].refreshLockedUntil, null);
  });
});

// ---------------------------------------------------------------------------
// N: no credential leakage
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("N. the credential store never leaks a token, ciphertext, or key", () => {
  test("its CODE contains no logging call of any kind", () => {
    const codeOnly = readSource("src/lib/commerce/providers/shopify-credential-store.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    assert.doesNotMatch(codeOnly, /console\./);
    assert.doesNotMatch(codeOnly, /logger|log\(/i);
  });

  test("the encrypted payload is never returned from an exported function", () => {
    const codeOnly = readSource("src/lib/commerce/providers/shopify-credential-store.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // `encryptedPayload` may only ever be WRITTEN (in data/create/update) or
    // read into a local for decryption — never placed on a returned object.
    assert.doesNotMatch(codeOnly, /return\s*\{[^}]*encryptedPayload/);
    assert.doesNotMatch(codeOnly, /credential:\s*\{[^}]*encryptedPayload/);
  });

  test("the ShopifyCredential surface exposes no ciphertext field", async () => {
    const { client } = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);
    const result = await loadShopifyCredential("brand-1", { client });
    assert.equal(result.outcome, "OK");
    if (result.outcome !== "OK") return;

    const keys = Object.keys(result.credential);
    assert.ok(!keys.includes("encryptedPayload"));
    assert.ok(!keys.some((k) => /encrypted|cipher/i.test(k)));
  });
});

/**
 * PHASE 14B.3 — CANONICAL-FIRST INVALIDATION.
 *
 * Every credential-DESTRUCTION path (brand-admin disconnect, `app/uninstalled`,
 * `shop/redact`, embedded disconnect, permanent credential failure) now routes
 * through `invalidateShopifyCredential`. These tests pin the guarantees the
 * rest of the phase depends on.
 */
describe("invalidateShopifyCredential — canonical-first revocation", () => {
  test("M. transitions the canonical status AND deletes the secret in one transaction", async () => {
    const { client, state } = makeStore(
      [shopifyConn()],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );

    const result = await invalidateShopifyCredential(
      { brandId: "brand-1", status: "DISCONNECTED" },
      { client },
    );

    assert.equal(result.outcome, "INVALIDATED");
    if (result.outcome !== "INVALIDATED") return;
    assert.equal(result.connectionId, "conn-shopify");
    assert.equal(result.brandId, "brand-1");
    assert.equal(state.conns[0].status, "DISCONNECTED");
    assert.equal(state.secrets.length, 0);
  });

  test("N. UNINSTALLED stamps uninstalledAt; DISCONNECTED does not", async () => {
    const uninstalled = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);
    await invalidateShopifyCredential(
      { brandId: "brand-1", status: "UNINSTALLED" },
      { client: uninstalled.client },
    );
    assert.equal(uninstalled.state.conns[0].status, "UNINSTALLED");
    assert.ok(
      (uninstalled.state.conns[0] as unknown as { uninstalledAt?: Date }).uninstalledAt
        instanceof Date,
    );

    const disconnected = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);
    await invalidateShopifyCredential(
      { brandId: "brand-1", status: "DISCONNECTED" },
      { client: disconnected.client },
    );
    assert.equal(
      (disconnected.state.conns[0] as unknown as { uninstalledAt?: Date }).uninstalledAt,
      undefined,
    );
  });

  test("O. selecting by SHOP DOMAIN revokes the right row after a relink moved the brand's domain", async () => {
    // The brand has relinked to shop B; shop A's terminal webhook arrives late.
    // A brandId-keyed lookup would pick the CURRENT (shop B) connection and
    // revoke the wrong store — the domain selector must not.
    const { client, state } = makeStore(
      [
        shopifyConn({
          id: "conn-old",
          externalAccountId: "old-shop.myshopify.com",
          isPrimary: false,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }),
        shopifyConn({
          id: "conn-new",
          externalAccountId: "new-shop.myshopify.com",
          isPrimary: true,
          createdAt: new Date("2026-02-01T00:00:00Z"),
        }),
      ],
      [
        secretFor("conn-old", LIVE_PAYLOAD),
        secretFor("conn-new", LIVE_PAYLOAD),
      ],
    );

    const result = await invalidateShopifyCredential(
      { shopDomain: "old-shop.myshopify.com", status: "UNINSTALLED" },
      { client },
    );

    assert.equal(result.outcome, "INVALIDATED");
    if (result.outcome !== "INVALIDATED") return;
    assert.equal(result.connectionId, "conn-old");
    assert.equal(state.conns.find((c) => c.id === "conn-old")?.status, "UNINSTALLED");
    // The live connection is untouched — status and credential both intact.
    assert.equal(state.conns.find((c) => c.id === "conn-new")?.status, "CONNECTED");
    assert.ok(state.secrets.some((s) => s.connectionId === "conn-new"));
    assert.ok(!state.secrets.some((s) => s.connectionId === "conn-old"));
  });

  test("R. a HELD refresh lease cannot block revocation", async () => {
    // Revocation deliberately outranks an in-flight rotation: a merchant who
    // disconnected must not have a refresh land afterwards, and an attacker
    // must not be able to hold a lease to keep a credential alive.
    const { client, state } = makeStore(
      [shopifyConn()],
      [
        secretFor("conn-shopify", LIVE_PAYLOAD, {
          refreshLockId: "someone-elses-lease",
          refreshLockedUntil: new Date(Date.now() + LOCK_MS),
        }),
      ],
    );

    const result = await invalidateShopifyCredential(
      { brandId: "brand-1", status: "REQUIRES_RECONNECT" },
      { client },
    );

    assert.equal(result.outcome, "INVALIDATED");
    assert.equal(state.secrets.length, 0);
    assert.equal(state.conns[0].status, "REQUIRES_RECONNECT");
  });

  test("S. the onInvalidated hook runs INSIDE the transaction, with the resolved brandId", async () => {
    const { client, state } = makeStore(
      [shopifyConn({ brandId: "brand-owner" })],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );

    const observed: Array<{ brandId: string; secretsRemaining: number; status: string }> = [];

    await invalidateShopifyCredential(
      {
        shopDomain: "acme.myshopify.com",
        status: "UNINSTALLED",
        onInvalidated: async (_tx, connection) => {
          // The hook must see a state where the revocation has ALREADY been
          // applied — that is what makes the connection-loss event and the
          // revocation atomic rather than merely adjacent.
          observed.push({
            brandId: connection.brandId,
            secretsRemaining: state.secrets.length,
            status: state.conns[0].status,
          });
        },
      },
      { client },
    );

    assert.deepEqual(observed, [
      { brandId: "brand-owner", secretsRemaining: 0, status: "UNINSTALLED" },
    ]);
  });

  test("AA. no connection at all is a classified NO_CONNECTION, never a throw", async () => {
    const { client } = makeStore([], []);
    const result = await invalidateShopifyCredential(
      { brandId: "brand-missing", status: "DISCONNECTED" },
      { client },
    );
    assert.deepEqual(result, { outcome: "NO_CONNECTION" });
  });

  test("AB. a COMMERCE7 connection is never revoked by the Shopify invalidation path", async () => {
    const { client, state } = makeStore(
      [
        shopifyConn({
          id: "conn-c7",
          provider: CommerceProvider.COMMERCE7,
          externalAccountId: "acme.commerce7.com",
        }),
      ],
      [secretFor("conn-c7", LIVE_PAYLOAD)],
    );

    const result = await invalidateShopifyCredential(
      { brandId: "brand-1", status: "DISCONNECTED" },
      { client },
    );

    assert.deepEqual(result, { outcome: "NO_CONNECTION" });
    assert.equal(state.conns[0].status, "CONNECTED");
    assert.equal(state.secrets.length, 1);
  });

  test("AC. re-invalidating an already-revoked connection is idempotent", async () => {
    const { client, state } = makeStore([shopifyConn()], [secretFor("conn-shopify", LIVE_PAYLOAD)]);

    const first = await invalidateShopifyCredential(
      { brandId: "brand-1", status: "DISCONNECTED" },
      { client },
    );
    const second = await invalidateShopifyCredential(
      { brandId: "brand-1", status: "DISCONNECTED" },
      { client },
    );

    assert.equal(first.outcome, "INVALIDATED");
    assert.equal(second.outcome, "INVALIDATED");
    assert.equal(state.secrets.length, 0);
    assert.equal(state.conns[0].status, "DISCONNECTED");
  });

  test("AD. the secret delete carries NO lease predicate in the source", () => {
    // A `refreshLockId` predicate on this delete would make revocation
    // blockable by whoever holds the lease. R proves the behavior; this pins
    // the mechanism so a future refactor cannot reintroduce the predicate.
    const source = readSource("src/lib/commerce/providers/shopify-credential-store.ts");
    const body = source.slice(source.indexOf("export async function invalidateShopifyCredential"));
    const deleteCall = body.slice(body.indexOf("deleteMany"), body.indexOf("onInvalidated"));
    assert.doesNotMatch(deleteCall, /refreshLockId/);
  });

  // ---------------------------------------------------------------------
  // P1 FIX (independent review): a terminal webhook (`app/uninstalled`,
  // `shop/redact`) can be redelivered by Shopify's retry mechanism up to 4
  // hours after it was originally triggered, carrying the ORIGINAL payload.
  // If the merchant reinstalled the same shop domain in that window, the
  // canonical connection row (upserted by shop domain) now belongs to the
  // FRESH install. Applying a stale terminal event would revoke it.
  // ---------------------------------------------------------------------

  test("AM. a terminal event triggered BEFORE the connection's current installedAt is ignored, not applied", async () => {
    const { client, state } = makeStore(
      [shopifyConn({ installedAt: new Date("2026-03-01T12:00:00Z") })],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );

    const result = await invalidateShopifyCredential(
      {
        brandId: "brand-1",
        status: "UNINSTALLED",
        // Shopify triggered this uninstall BEFORE the reinstall that set
        // installedAt above — a redelivered, now-stale event.
        eventTriggeredAt: new Date("2026-03-01T11:00:00Z"),
      },
      { client },
    );

    assert.deepEqual(result, {
      outcome: "STALE_EVENT_IGNORED",
      connectionId: "conn-shopify",
      brandId: "brand-1",
    });
    // The decisive assertion: NOTHING was touched.
    assert.equal(state.conns[0].status, "CONNECTED");
    assert.equal(state.secrets.length, 1);
  });

  test("AN. a terminal event triggered AFTER installedAt is applied normally (not stale)", async () => {
    const { client, state } = makeStore(
      [shopifyConn({ installedAt: new Date("2026-03-01T11:00:00Z") })],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );

    const result = await invalidateShopifyCredential(
      {
        brandId: "brand-1",
        status: "UNINSTALLED",
        eventTriggeredAt: new Date("2026-03-01T12:00:00Z"),
      },
      { client },
    );

    assert.equal(result.outcome, "INVALIDATED");
    assert.equal(state.conns[0].status, "UNINSTALLED");
    assert.equal(state.secrets.length, 0);
  });

  test("AO. no eventTriggeredAt supplied (synchronous, non-webhook callers) never activates the fence", async () => {
    const { client, state } = makeStore(
      [shopifyConn({ installedAt: new Date("2026-03-01T12:00:00Z") })],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );

    const result = await invalidateShopifyCredential(
      { brandId: "brand-1", status: "DISCONNECTED" },
      { client },
    );

    assert.equal(result.outcome, "INVALIDATED");
    assert.equal(state.conns[0].status, "DISCONNECTED");
    assert.equal(state.secrets.length, 0);
  });

  test("AP. a missing installedAt never triggers the fence, even with eventTriggeredAt supplied", async () => {
    const { client, state } = makeStore(
      [shopifyConn({ installedAt: null })],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );

    const result = await invalidateShopifyCredential(
      {
        brandId: "brand-1",
        status: "UNINSTALLED",
        eventTriggeredAt: new Date("2026-03-01T12:00:00Z"),
      },
      { client },
    );

    assert.equal(result.outcome, "INVALIDATED");
    assert.equal(state.conns[0].status, "UNINSTALLED");
  });
});

describe("healShopifyCredentialConnected — canonical scope-drift heal", () => {
  test("AJ. heals REQUIRES_RECONNECT -> CONNECTED without touching the canonical credential", async () => {
    const { client, state } = makeStore(
      [shopifyConn({ status: "REQUIRES_RECONNECT" })],
      [secretFor("conn-shopify", LIVE_PAYLOAD)],
    );
    const payloadBefore = state.secrets[0].encryptedPayload;

    const result = await healShopifyCredentialConnected("brand-1", { client });

    assert.deepEqual(result, { outcome: "HEALED" });
    assert.equal(state.conns[0].status, "CONNECTED");
    // The decisive assertion: a STATUS heal must never rewrite the credential.
    // The previous implementation rebuilt the canonical secret from the legacy
    // `Brand` mirror here, which could overwrite a freshly rotated token with
    // a stale one.
    assert.equal(state.secrets.length, 1);
    assert.equal(state.secrets[0].encryptedPayload, payloadBefore);
  });

  test("AK. a connection that already moved on is NOT_ELIGIBLE, never resurrected", async () => {
    for (const status of ["CONNECTED", "DISCONNECTED", "UNINSTALLED"] as const) {
      const { client, state } = makeStore(
        [shopifyConn({ status })],
        [secretFor("conn-shopify", LIVE_PAYLOAD)],
      );
      const result = await healShopifyCredentialConnected("brand-1", { client });
      assert.deepEqual(result, { outcome: "NOT_ELIGIBLE" }, status);
      assert.equal(state.conns[0].status, status, `${status} must be left alone`);
    }
  });

  test("AL. a pre-cutover brand with no canonical row reports NO_CONNECTION", async () => {
    const { client } = makeStore([], []);
    assert.deepEqual(await healShopifyCredentialConnected("brand-1", { client }), {
      outcome: "NO_CONNECTION",
    });
  });
});
