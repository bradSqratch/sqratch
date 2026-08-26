/**
 * tests/commerce7-connection-lifecycle.test.ts
 *
 * PHASE 20 HOTFIX (Parts 5/6/9/11) — Brand-admin-controlled Commerce7
 * disconnect/reconnect: the service layer
 * (`src/lib/commerce/providers/commerce7-connection-lifecycle.ts`) and the
 * two API routes it backs.
 *
 * PHASE 20 (settings sync / one-active-Commerce7-store round, Parts 8/9/14/21)
 * extends this file: reconnect now fetches/validates Commerce7 settings
 * WHILE the connection remains DISCONNECTED (never after going live), and
 * both disconnect and reconnect participate in the Brand-level active-slot
 * invariant.
 *
 * Mirrors the established fake-transactional-store idiom in
 * `tests/commerce7-storefront-configuration.test.ts` — a staged copy of
 * connection state that only commits if the callback resolves without
 * throwing, exactly matching `prisma.$transaction`'s rollback guarantee
 * without a real database.
 *
 * See `tests/commerce7-connection-lifecycle-real-db.test.ts` for the real
 * PostgreSQL proof of Part 7/22 (cross-Brand tenant linking, and the
 * Brand-level serialization primitive proven under real concurrency).
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceInstallationStatus, CommerceProvider } from "@prisma/client";

import {
  disconnectCommerce7Connection,
  reconnectCommerce7Connection,
  type Commerce7ConnectionLifecycleDeps,
  type Commerce7LifecycleConnectionRow,
  type Commerce7LifecycleTransactionClient,
} from "../src/lib/commerce/providers/commerce7-connection-lifecycle";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  CommerceProviderApiError,
} from "../src/lib/commerce/errors";
import type { Commerce7StoreSettingsDTO } from "../src/lib/commerce/providers/commerce7-settings";
import { commerce7DisconnectPostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/disconnect/route";
import { commerce7ReconnectPostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/reconnect/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";

function connectionRow(overrides: Partial<Commerce7LifecycleConnectionRow> = {}): Commerce7LifecycleConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    externalAccountId: "tenant-1",
    providerClientId: "client-abc",
    storefrontUrl: "https://old.example.com",
    providerMetadata: { currencyCode: "USD", productRoute: "/old-product" },
    ...overrides,
  };
}

const VALID_SETTINGS: Commerce7StoreSettingsDTO = {
  storefrontUrl: "https://new.example.com",
  currencyCode: "CAD",
  productRoute: "/product",
};

/**
 * Fake transactional store with REAL rollback semantics — same idiom as
 * `FakeConfigStore` in `commerce7-storefront-configuration.test.ts`. Also
 * doubles as the source for the PRE-transaction, unlocked
 * `readConnection`/`readInstallationStatus` snapshot reads
 * `reconnectCommerce7Connection` takes before ever fetching Commerce7
 * settings or opening a transaction.
 */
class FakeLifecycleStore {
  connections = new Map<string, Commerce7LifecycleConnectionRow>();
  installations = new Map<string, CommerceInstallationStatus>();
  /**
   * Set only for a test that must simulate the app being uninstalled
   * BETWEEN the pre-transaction snapshot read and the in-transaction
   * re-check (a genuine TOCTOU window) — when set, the IN-TRANSACTION
   * `findInstallationStatus` returns THIS instead of `installations`'s
   * value, while `readInstallationStatus` (pre-transaction) keeps using
   * `installations` unchanged.
   */
  installationStatusInsideTransaction: CommerceInstallationStatus | null | undefined = undefined;
  events: Array<{
    brandId: string;
    provider: CommerceProvider;
    eventType: "DISCONNECTED" | "RECONNECTED";
    externalAccountId: string;
  }> = [];
  lockedBrandIds: string[] = [];
  lockedConnectionIds: string[] = [];
  applyConfigurationCalls: Array<{ connectionId: string; values: Record<string, string> }> = [];
  settingsFetchCount = 0;
  settingsResult: Commerce7StoreSettingsDTO | CommerceProviderApiError = VALID_SETTINGS;

  setInstallation(provider: CommerceProvider, externalAccountId: string, status: CommerceInstallationStatus) {
    this.installations.set(`${provider}:${externalAccountId}`, status);
  }

  async fetchSettings(): Promise<Commerce7StoreSettingsDTO> {
    this.settingsFetchCount += 1;
    if (this.settingsResult instanceof CommerceProviderApiError) {
      throw this.settingsResult;
    }
    return this.settingsResult;
  }

  async readConnection(id: string): Promise<Commerce7LifecycleConnectionRow | null> {
    return this.connections.get(id) ?? null;
  }

  async readInstallationStatus(
    provider: CommerceProvider,
    externalAccountId: string,
  ): Promise<CommerceInstallationStatus | null> {
    return this.installations.get(`${provider}:${externalAccountId}`) ?? null;
  }

  async runInTransaction<T>(
    fn: (client: Commerce7LifecycleTransactionClient) => Promise<T>,
  ): Promise<T> {
    const staged = new Map(this.connections);
    const client: Commerce7LifecycleTransactionClient = {
      lockBrand: async (brandId) => {
        this.lockedBrandIds.push(brandId);
      },
      lockAndFindConnection: async (id) => {
        this.lockedConnectionIds.push(id);
        return staged.get(id) ?? null;
      },
      setConnectionStatus: async (id, status) => {
        const existing = staged.get(id);
        if (existing) staged.set(id, { ...existing, status });
      },
      recordEvent: async (input) => {
        this.events.push({
          brandId: input.brandId,
          provider: input.provider,
          eventType: input.eventType,
          externalAccountId: input.externalAccountId,
        });
      },
      findInstallationStatus: async (provider, externalAccountId) => {
        if (this.installationStatusInsideTransaction !== undefined) {
          return this.installationStatusInsideTransaction;
        }
        return this.installations.get(`${provider}:${externalAccountId}`) ?? null;
      },
      findConflictingActiveCommerce7Connection: async (brandId, excludeConnectionId) => {
        for (const [id, row] of staged) {
          if (
            id !== excludeConnectionId &&
            row.brandId === brandId &&
            row.provider === CommerceProvider.COMMERCE7 &&
            row.status !== "DISCONNECTED" &&
            row.status !== "UNINSTALLED"
          ) {
            return { id };
          }
        }
        return null;
      },
      applyConfigurationValues: async (connectionId, _connection, values) => {
        this.applyConfigurationCalls.push({ connectionId, values });
        const existing = staged.get(connectionId);
        if (existing) {
          staged.set(connectionId, {
            ...existing,
            storefrontUrl: values.storefrontUrl,
            providerMetadata: { currencyCode: values.currencyCode, productRoute: values.productRoute },
          });
        }
        return { requiresProductSync: true };
      },
    };

    const result = await fn(client);
    this.connections = staged;
    return result;
  }
}

function depsFor(store: FakeLifecycleStore): Partial<Commerce7ConnectionLifecycleDeps> {
  return {
    runInTransaction: (fn) => store.runInTransaction(fn),
    readConnection: (id) => store.readConnection(id),
    readInstallationStatus: (provider, externalAccountId) =>
      store.readInstallationStatus(provider, externalAccountId),
    fetchSettings: () => store.fetchSettings(),
  };
}

// ---------------------------------------------------------------------------
// disconnectCommerce7Connection
// ---------------------------------------------------------------------------

describe("disconnectCommerce7Connection", () => {
  test("owner disconnect of a CONNECTED connection locks the Brand FIRST, transitions to DISCONNECTED, and records exactly one lifecycle event", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "CONNECTED" }));

    const result = await disconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "DISCONNECTED");
    assert.equal(store.connections.get("conn-1")!.status, "DISCONNECTED");
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].eventType, "DISCONNECTED");
    assert.deepEqual(store.lockedBrandIds, ["brand-a"], "Brand must be locked");
    assert.deepEqual(store.lockedConnectionIds, ["conn-1"], "connection must be locked, AFTER the Brand");
  });

  test("disconnect preserves every field other than status", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set(
      "conn-1",
      connectionRow({ status: "CONNECTED", externalAccountId: "tenant-xyz", providerClientId: "client-xyz" }),
    );

    await disconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    const after = store.connections.get("conn-1")!;
    assert.equal(after.brandId, "brand-a");
    assert.equal(after.provider, CommerceProvider.COMMERCE7);
    assert.equal(after.externalAccountId, "tenant-xyz");
    assert.equal(after.providerClientId, "client-xyz");
  });

  test("disconnecting an ALREADY-DISCONNECTED connection is a safe idempotent no-op — no duplicate lifecycle event", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED" }));

    const result = await disconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "ALREADY_DISCONNECTED");
    assert.equal(store.events.length, 0);
  });

  test("a foreign-brand connectionId throws CommerceConnectionNotFoundError", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ brandId: "brand-OTHER" }));
    await assert.rejects(
      () => disconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store)),
      CommerceConnectionNotFoundError,
    );
    assert.equal(store.connections.get("conn-1")!.status, "CONNECTED");
  });

  test("a nonexistent connectionId throws the SAME CommerceConnectionNotFoundError as a foreign one", async () => {
    const store = new FakeLifecycleStore();
    await assert.rejects(
      () => disconnectCommerce7Connection({ brandId: "brand-a", connectionId: "does-not-exist" }, depsFor(store)),
      CommerceConnectionNotFoundError,
    );
  });

  test("a Shopify connection throws CommerceConnectionMismatchError — Shopify is NEVER affected by this action", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ provider: CommerceProvider.SHOPIFY, status: "CONNECTED" }));
    await assert.rejects(
      () => disconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store)),
      CommerceConnectionMismatchError,
    );
    assert.equal(store.connections.get("conn-1")!.status, "CONNECTED");
  });

  test("a non-CONNECTED, non-DISCONNECTED status (e.g. PENDING) throws CommerceConnectionNotReadyError", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "PENDING" }));
    await assert.rejects(
      () => disconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store)),
      CommerceConnectionNotReadyError,
    );
  });
});

// ---------------------------------------------------------------------------
// reconnectCommerce7Connection
// ---------------------------------------------------------------------------

describe("reconnectCommerce7Connection", () => {
  test("owner reconnect of a DISCONNECTED connection with an INSTALLED app fetches+validates settings WHILE disconnected, then applies them and transitions to CONNECTED in one transaction, preserving the SAME connection id", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED", externalAccountId: "tenant-1" }));
    store.setInstallation(CommerceProvider.COMMERCE7, "tenant-1", CommerceInstallationStatus.INSTALLED);
    store.settingsResult = VALID_SETTINGS;

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "CONNECTED");
    assert.equal(result.connectionId, "conn-1", "reconnect must preserve the SAME connection id");
    assert.equal(store.settingsFetchCount, 1);
    assert.equal(store.applyConfigurationCalls.length, 1, "settings must be applied via the shared configuration machinery");
    assert.equal(store.applyConfigurationCalls[0].values.storefrontUrl, VALID_SETTINGS.storefrontUrl);
    assert.equal(store.applyConfigurationCalls[0].values.currencyCode, VALID_SETTINGS.currencyCode);
    assert.equal(store.applyConfigurationCalls[0].values.productRoute, VALID_SETTINGS.productRoute);

    const after = store.connections.get("conn-1")!;
    assert.equal(after.status, "CONNECTED");
    assert.equal(after.storefrontUrl, VALID_SETTINGS.storefrontUrl, "the OLD stale storefrontUrl must be replaced");
    assert.deepEqual(store.lockedBrandIds, ["brand-a"]);
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].eventType, "RECONNECTED");
  });

  test("reconnecting an ALREADY-CONNECTED connection is a safe idempotent no-op — settings are never even fetched", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "CONNECTED" }));

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "ALREADY_CONNECTED");
    assert.equal(store.settingsFetchCount, 0);
    assert.equal(store.events.length, 0);
  });

  test("reconnect against an UNINSTALLED app (caught by the pre-check) returns APP_NOT_INSTALLED — Commerce7 is never called", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED", externalAccountId: "tenant-1" }));
    store.setInstallation(CommerceProvider.COMMERCE7, "tenant-1", CommerceInstallationStatus.UNINSTALLED);

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "APP_NOT_INSTALLED");
    assert.equal(store.settingsFetchCount, 0, "no provider HTTP when the app is already known to be uninstalled");
    assert.equal(store.connections.get("conn-1")!.status, "DISCONNECTED");
  });

  test("reconnect against an app uninstalled BETWEEN the pre-check and the transaction (TOCTOU) is still caught, INSIDE the transaction — no mutation", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED", externalAccountId: "tenant-1" }));
    // Pre-check sees INSTALLED (so settings ARE fetched)...
    store.setInstallation(CommerceProvider.COMMERCE7, "tenant-1", CommerceInstallationStatus.INSTALLED);
    // ...but the in-transaction re-check observes an uninstall that landed in between.
    store.installationStatusInsideTransaction = CommerceInstallationStatus.UNINSTALLED;

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "APP_NOT_INSTALLED");
    assert.equal(store.settingsFetchCount, 1, "the pre-check passed, so settings WERE fetched");
    assert.equal(store.applyConfigurationCalls.length, 0, "but nothing was ever applied");
    assert.equal(store.connections.get("conn-1")!.status, "DISCONNECTED", "no mutation on the TOCTOU-caught conflict");
  });

  test("reconnect while ANOTHER Commerce7 connection for the same Brand occupies the active slot returns COMMERCE7_STORE_ALREADY_CONNECTED — no mutation, even though settings were already fetched", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-x", connectionRow({ id: "conn-x", status: "DISCONNECTED", externalAccountId: "tenant-x" }));
    store.connections.set(
      "conn-y",
      connectionRow({ id: "conn-y", status: "CONNECTED", externalAccountId: "tenant-y" }),
    );
    store.setInstallation(CommerceProvider.COMMERCE7, "tenant-x", CommerceInstallationStatus.INSTALLED);

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-x" }, depsFor(store));

    assert.equal(result.status, "COMMERCE7_STORE_ALREADY_CONNECTED");
    assert.equal(store.settingsFetchCount, 1, "settings are fetched before the active-slot check — that ordering is fine, it just doesn't persist");
    assert.equal(store.applyConfigurationCalls.length, 0);
    assert.equal(store.connections.get("conn-x")!.status, "DISCONNECTED", "X remains DISCONNECTED — no mutation");
    assert.equal(store.connections.get("conn-y")!.status, "CONNECTED", "Y is completely untouched");
  });

  test("a Commerce7 provider failure (unreachable/401/malformed) returns SETTINGS_SYNC_FAILED and leaves the connection DISCONNECTED — never thrown as an unhandled exception", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED", externalAccountId: "tenant-1" }));
    store.setInstallation(CommerceProvider.COMMERCE7, "tenant-1", CommerceInstallationStatus.INSTALLED);
    store.settingsResult = new CommerceProviderApiError(CommerceProvider.COMMERCE7, "Commerce7 could not be reached.");

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "SETTINGS_SYNC_FAILED");
    if (result.status === "SETTINGS_SYNC_FAILED") {
      assert.equal(result.reason, "PROVIDER_UNREACHABLE");
    }
    assert.equal(store.connections.get("conn-1")!.status, "DISCONNECTED");
    assert.equal(store.applyConfigurationCalls.length, 0);
  });

  test("a 401 provider failure classifies as PROVIDER_REJECTED_CREDENTIALS, sanitized (no raw message)", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED", externalAccountId: "tenant-1" }));
    store.setInstallation(CommerceProvider.COMMERCE7, "tenant-1", CommerceInstallationStatus.INSTALLED);
    store.settingsResult = new CommerceProviderApiError(
      CommerceProvider.COMMERCE7,
      "Commerce7 rejected the app credentials for this tenant.",
      undefined,
      401,
    );

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "SETTINGS_SYNC_FAILED");
    if (result.status === "SETTINGS_SYNC_FAILED") {
      assert.equal(result.reason, "PROVIDER_REJECTED_CREDENTIALS");
    }
  });

  test("Commerce7-reported settings that fail SQRATCH's own destination-security validation return SETTINGS_INVALID — no transaction ever opens", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED", externalAccountId: "tenant-1" }));
    store.setInstallation(CommerceProvider.COMMERCE7, "tenant-1", CommerceInstallationStatus.INSTALLED);
    store.settingsResult = { storefrontUrl: "http://not-https.example.com", currencyCode: "CAD", productRoute: "/product" };

    const result = await reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store));

    assert.equal(result.status, "SETTINGS_SYNC_FAILED");
    if (result.status === "SETTINGS_SYNC_FAILED") {
      assert.equal(result.reason, "SETTINGS_INVALID");
    }
    assert.deepEqual(store.lockedBrandIds, [], "an invalid settings value must never even open a transaction");
    assert.equal(store.connections.get("conn-1")!.status, "DISCONNECTED");
  });

  test("a foreign-brand connectionId throws CommerceConnectionNotFoundError before any provider HTTP", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ brandId: "brand-OTHER", status: "DISCONNECTED" }));
    await assert.rejects(
      () => reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store)),
      CommerceConnectionNotFoundError,
    );
    assert.equal(store.settingsFetchCount, 0);
  });

  test("a Shopify connection throws CommerceConnectionMismatchError", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ provider: CommerceProvider.SHOPIFY, status: "DISCONNECTED" }));
    await assert.rejects(
      () => reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store)),
      CommerceConnectionMismatchError,
    );
  });

  test("a non-CONNECTED, non-DISCONNECTED status (e.g. UNINSTALLED) throws CommerceConnectionNotReadyError — this action never resurrects a provider-uninstalled connection", async () => {
    const store = new FakeLifecycleStore();
    store.connections.set("conn-1", connectionRow({ status: "UNINSTALLED" }));
    await assert.rejects(
      () => reconnectCommerce7Connection({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store)),
      CommerceConnectionNotReadyError,
    );
    assert.equal(store.settingsFetchCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Route-level auth / ownership / status mapping
// ---------------------------------------------------------------------------

function makeContext(): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: "brand-a", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: { id: "brand-a", name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null },
    },
  };
}

describe("commerce7DisconnectPostImpl", () => {
  test("unauthenticated caller never reaches disconnect()", async () => {
    let called = false;
    const res = await commerce7DisconnectPostImpl(
      { getContext: async () => null, disconnect: async () => { called = true; return { status: "DISCONNECTED", connectionId: "conn-1" }; } },
      "conn-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("CommerceConnectionNotFoundError maps to 404", async () => {
    const res = await commerce7DisconnectPostImpl(
      { getContext: async () => makeContext(), disconnect: async () => { throw new CommerceConnectionNotFoundError("conn-1"); } },
      "conn-1",
    );
    assert.equal(res.status, 404);
  });

  test("CommerceConnectionMismatchError maps to 400", async () => {
    const res = await commerce7DisconnectPostImpl(
      {
        getContext: async () => makeContext(),
        disconnect: async () => {
          throw new CommerceConnectionMismatchError("conn-1", CommerceProvider.COMMERCE7, CommerceProvider.SHOPIFY);
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 400);
  });

  test("CommerceConnectionNotReadyError maps to 409", async () => {
    const res = await commerce7DisconnectPostImpl(
      {
        getContext: async () => makeContext(),
        disconnect: async () => {
          throw new CommerceConnectionNotReadyError("conn-1", CommerceProvider.COMMERCE7, "PENDING");
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 409);
  });

  test("a successful DISCONNECTED result maps to 200 with the result in { data }", async () => {
    const res = await commerce7DisconnectPostImpl(
      { getContext: async () => makeContext(), disconnect: async () => ({ status: "DISCONNECTED", connectionId: "conn-1" }) },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, "DISCONNECTED");
  });
});

describe("commerce7ReconnectPostImpl", () => {
  test("unauthenticated caller never reaches reconnect()", async () => {
    let called = false;
    const res = await commerce7ReconnectPostImpl(
      { getContext: async () => null, reconnect: async () => { called = true; return { status: "CONNECTED", connectionId: "conn-1" }; } },
      "conn-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("CommerceConnectionNotFoundError maps to 404", async () => {
    const res = await commerce7ReconnectPostImpl(
      { getContext: async () => makeContext(), reconnect: async () => { throw new CommerceConnectionNotFoundError("conn-1"); } },
      "conn-1",
    );
    assert.equal(res.status, 404);
  });

  test("a successful CONNECTED result maps to 200 with the result in { data }", async () => {
    const res = await commerce7ReconnectPostImpl(
      { getContext: async () => makeContext(), reconnect: async () => ({ status: "CONNECTED", connectionId: "conn-1" }) },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, "CONNECTED");
  });

  test("an APP_NOT_INSTALLED result maps to a controlled 409 with code APP_NOT_INSTALLED — never thrown as a 500", async () => {
    const res = await commerce7ReconnectPostImpl(
      { getContext: async () => makeContext(), reconnect: async () => ({ status: "APP_NOT_INSTALLED", connectionId: "conn-1" }) },
      "conn-1",
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "APP_NOT_INSTALLED");
  });

  test("a COMMERCE7_STORE_ALREADY_CONNECTED result maps to a controlled 409 with that code", async () => {
    const res = await commerce7ReconnectPostImpl(
      {
        getContext: async () => makeContext(),
        reconnect: async () => ({ status: "COMMERCE7_STORE_ALREADY_CONNECTED", connectionId: "conn-1" }),
      },
      "conn-1",
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "COMMERCE7_STORE_ALREADY_CONNECTED");
  });

  test("a SETTINGS_SYNC_FAILED result maps to a controlled 502, never the raw provider reason leaking as the message", async () => {
    const res = await commerce7ReconnectPostImpl(
      {
        getContext: async () => makeContext(),
        reconnect: async () => ({
          status: "SETTINGS_SYNC_FAILED",
          connectionId: "conn-1",
          reason: "PROVIDER_UNREACHABLE",
        }),
      },
      "conn-1",
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.code, "SETTINGS_SYNC_FAILED");
  });
});
