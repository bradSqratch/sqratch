/**
 * src/lib/commerce/providers/commerce7-connection-lifecycle.ts
 *
 * PHASE 20 HOTFIX (Parts 5/6) — Brand-admin-controlled Commerce7
 * disconnect/reconnect, DISTINCT from the provider-driven install/uninstall
 * lifecycle in `../../../app/api/commerce7/{install,uninstall}/route.ts`.
 *
 * PHASE 20 (settings sync / one-active-Commerce7-store round, Parts 8/9/14/15)
 * added two further invariants, both enforced here:
 *
 *   - RECONNECT NEVER GOES LIVE WITH STALE SETTINGS. A DISCONNECTED
 *     connection's OLD `storefrontUrl`/`providerMetadata` may be stale — the
 *     merchant could have changed their Commerce7 storefront while
 *     disconnected. Going `DISCONNECTED -> CONNECTED` FIRST and refreshing
 *     settings afterward would create a real window where a stale public
 *     product destination is live again. `reconnectCommerce7Connection`
 *     therefore fetches and validates CURRENT Commerce7 settings WHILE the
 *     connection remains DISCONNECTED, and applies them in the SAME
 *     transaction that flips status to CONNECTED — never before, never
 *     after.
 *   - ONE ACTIVE COMMERCE7 CONNECTION PER BRAND. See
 *     `../providers/commerce7-active-slot.ts` for the exact predicate and
 *     `../brand-row-lock.ts` for why a Brand-level lock is the only
 *     mechanism that can close the race between two different tenants
 *     racing to occupy the same Brand's slot. LOCK ORDER IS ALWAYS Brand ->
 *     CommerceConnection — every transaction below locks the Brand FIRST,
 *     matching `../link-connection.ts`'s identical order, so neither path
 *     can deadlock against the other.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE STATE FROM `UNINSTALLED`
 * ===========================================================================
 * `UNINSTALLED` means Commerce7 itself reports the app is no longer on the
 * tenant (see `../../../app/api/commerce7/uninstall/route.ts`) — SQRATCH did
 * not choose that; Commerce7 told it. `DISCONNECTED` here means a Brand
 * Admin explicitly chose, from inside SQRATCH, to pause this connection while
 * the Commerce7 app remains installed. Conflating the two would make an
 * admin's deliberate pause look identical to an app removal, and would make
 * `../../../app/api/commerce7/install/route.ts`'s reinstall-recovery logic
 * (which checks `status !== CONNECTED` to decide whether to reconnect)
 * ambiguous about which action to reverse.
 *
 * ===========================================================================
 * WHAT THIS NEVER DOES
 * ===========================================================================
 * Never touches `CommerceProviderInstallation` (that row's
 * `INSTALLED`/`UNINSTALLED` lifecycle is owned exclusively by the
 * provider-driven install/uninstall callbacks — this module only READS it).
 * Never deletes or mutates `ConnectedCommerceProduct`, `BrandCommerceProduct`,
 * `CommerceOrder`, `CommerceOrderLineItem`, `CommerceOrderEvent`,
 * `CommerceClickAttribution`, or `CommerceConnectionSecret` rows. Never
 * creates a second `CommerceConnection` row — the SAME row transitions
 * status in place, so every historical relationship (Campaign/Lesson product
 * links, orders, attribution) stays intact.
 *
 * ===========================================================================
 * WHY DISCONNECTING ALREADY CLOSES EVERY DOWNSTREAM SURFACE
 * ===========================================================================
 * No new gating logic is required here: every consumer of a Commerce7
 * connection already requires `status === CONNECTED` before doing anything —
 * `runProductSync`/`syncCommerceConnectionById` (product-sync.ts),
 * `PUBLICLY_CLICKABLE_CONNECTED_PRODUCT` (click-attribution.ts, requires
 * `connection.status === "CONNECTED"`), and the Commerce7 order webhook
 * (commerce7-order-webhook.ts, rejects any non-CONNECTED tenant with an
 * identical 200 no-op). Moving `status` to `DISCONNECTED` therefore
 * immediately and correctly closes product sync, public listing/redirect,
 * and order ingestion — without this module needing to touch any of them.
 *
 * ===========================================================================
 * LOCKING
 * ===========================================================================
 * Reuses the existing, already-proven `lockCommerceConnectionForTransaction`
 * (`../connection-row-lock.ts`) and the new `lockBrandForTransaction`
 * (`../brand-row-lock.ts`) — both real Postgres row locks, never a fake one.
 * Provider HTTP (the Commerce7 Setting API fetch, reconnect only) ALWAYS
 * happens BEFORE any transaction opens — no lock is ever held across it.
 */

import {
  CommerceInstallationStatus,
  CommerceProvider,
  type CommerceConnectionStatus,
  type Prisma,
} from "@prisma/client";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  CommerceProviderApiError,
} from "../errors";
import { lockCommerceConnectionForTransaction } from "../connection-row-lock";
import { lockBrandForTransaction } from "../brand-row-lock";
import { recordCommerceConnectionEvent } from "../connection-lifecycle";
import { COMMERCE7_FREE_SLOT_STATUSES } from "./commerce7-active-slot";
import {
  validateCommerce7CurrencyCode,
  validateCommerce7ProductRoute,
  validateCommerce7StorefrontUrl,
} from "./commerce7-connection-config";
import {
  applyCommerce7ConfigurationValues,
  buildCommerce7ConfigTransactionClient,
} from "./commerce7-storefront-configuration";
import {
  DEFAULT_SETTINGS_FETCH_TIMEOUT_MS,
  fetchCommerce7StoreSettings,
} from "./commerce7-settings";

export type Commerce7LifecycleConnectionRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  externalAccountId: string;
  providerClientId: string | null;
  storefrontUrl: string | null;
  providerMetadata: unknown;
};

/**
 * Scoped to run against ONE transaction client, mirroring the established
 * pattern in `./commerce7-storefront-configuration.ts` — every read/write
 * below participates in the same database transaction.
 */
export type Commerce7LifecycleTransactionClient = {
  /** Real-locks the exact Brand row. MUST be called before `lockAndFindConnection` — see this file's header for the lock order invariant. */
  lockBrand(brandId: string): Promise<void>;
  /** Real-locks the exact `CommerceConnection` row FIRST, then reads it. */
  lockAndFindConnection(connectionId: string): Promise<Commerce7LifecycleConnectionRow | null>;
  setConnectionStatus(connectionId: string, status: CommerceConnectionStatus): Promise<void>;
  recordEvent(input: {
    brandId: string;
    provider: CommerceProvider;
    eventType: "DISCONNECTED" | "RECONNECTED";
    externalAccountId: string;
    providerClientId: string | null;
  }): Promise<void>;
  /** Whether the provider-side app install is still live for this exact tenant. */
  findInstallationStatus(
    provider: CommerceProvider,
    externalAccountId: string,
  ): Promise<CommerceInstallationStatus | null>;
  /** Any OTHER Commerce7 connection for this Brand still occupying the active slot (see ./commerce7-active-slot.ts), excluding `excludeConnectionId`. */
  findConflictingActiveCommerce7Connection(
    brandId: string,
    excludeConnectionId: string,
  ): Promise<{ id: string } | null>;
  /** Reconnect only: applies validated settings through the EXISTING configuration write/invalidation machinery. */
  applyConfigurationValues(
    connectionId: string,
    connection: Commerce7LifecycleConnectionRow,
    values: { storefrontUrl: string; productRoute: string; currencyCode: string },
  ): Promise<{ requiresProductSync: boolean }>;
};

export type Commerce7ConnectionLifecycleDeps = {
  runInTransaction<T>(fn: (client: Commerce7LifecycleTransactionClient) => Promise<T>): Promise<T>;
  /** Pre-transaction, unlocked snapshot read — used ONLY to decide whether it's worth fetching Commerce7 settings at all before opening any transaction. Re-verified for real, under the real lock, inside the transaction that actually commits. */
  readConnection(connectionId: string): Promise<Commerce7LifecycleConnectionRow | null>;
  /** Pre-transaction, unlocked snapshot read of installation status — same caveat as `readConnection`. */
  readInstallationStatus(
    provider: CommerceProvider,
    externalAccountId: string,
  ): Promise<CommerceInstallationStatus | null>;
  fetchSettings(input: {
    tenant: string;
    signal?: AbortSignal;
  }): ReturnType<typeof fetchCommerce7StoreSettings>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

function connectionSelect() {
  return {
    id: true,
    brandId: true,
    provider: true,
    status: true,
    externalAccountId: true,
    providerClientId: true,
    storefrontUrl: true,
    providerMetadata: true,
  } as const;
}

function buildTransactionClient(tx: Prisma.TransactionClient): Commerce7LifecycleTransactionClient {
  return {
    async lockBrand(brandId) {
      await lockBrandForTransaction(tx, brandId);
    },
    async lockAndFindConnection(connectionId) {
      await lockCommerceConnectionForTransaction(tx, connectionId);
      return tx.commerceConnection.findUnique({
        where: { id: connectionId },
        select: connectionSelect(),
      });
    },
    async setConnectionStatus(connectionId, status) {
      await tx.commerceConnection.update({
        where: { id: connectionId },
        data: { status },
      });
    },
    async recordEvent(input) {
      await recordCommerceConnectionEvent(tx, {
        brandId: input.brandId,
        provider: input.provider,
        eventType: input.eventType,
        snapshot: {
          externalAccountId: input.externalAccountId,
          currencyCode: null,
          providerClientId: input.providerClientId,
        },
      });
    },
    async findInstallationStatus(provider, externalAccountId) {
      const row = await tx.commerceProviderInstallation.findUnique({
        where: { provider_externalAccountId: { provider, externalAccountId } },
        select: { status: true },
      });
      return row?.status ?? null;
    },
    async findConflictingActiveCommerce7Connection(brandId, excludeConnectionId) {
      return tx.commerceConnection.findFirst({
        where: {
          brandId,
          provider: CommerceProvider.COMMERCE7,
          status: { notIn: [...COMMERCE7_FREE_SLOT_STATUSES] },
          id: { not: excludeConnectionId },
        },
        select: { id: true },
      });
    },
    async applyConfigurationValues(connectionId, connection, values) {
      const configClient = buildCommerce7ConfigTransactionClient(tx);
      return applyCommerce7ConfigurationValues(configClient, connection, values, connectionId);
    },
  };
}

async function defaultRunInTransaction<T>(
  fn: (client: Commerce7LifecycleTransactionClient) => Promise<T>,
): Promise<T> {
  const prisma = await getPrisma();
  return prisma.$transaction((tx) => fn(buildTransactionClient(tx)));
}

async function defaultReadConnection(
  connectionId: string,
): Promise<Commerce7LifecycleConnectionRow | null> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findUnique({
    where: { id: connectionId },
    select: connectionSelect(),
  });
}

async function defaultReadInstallationStatus(
  provider: CommerceProvider,
  externalAccountId: string,
): Promise<CommerceInstallationStatus | null> {
  const prisma = await getPrisma();
  const row = await prisma.commerceProviderInstallation.findUnique({
    where: { provider_externalAccountId: { provider, externalAccountId } },
    select: { status: true },
  });
  return row?.status ?? null;
}

const DEFAULT_DEPS: Commerce7ConnectionLifecycleDeps = {
  runInTransaction: defaultRunInTransaction,
  readConnection: defaultReadConnection,
  readInstallationStatus: defaultReadInstallationStatus,
  fetchSettings: (input) => fetchCommerce7StoreSettings(input),
};

/** Throws for a missing/foreign connectionId (indistinguishable) or a non-Commerce7 connection. Never called for a resolved row's own provider/ownership — every caller below applies this identically. */
function assertOwnedCommerce7Connection(
  connectionId: string,
  brandId: string,
  connection: Commerce7LifecycleConnectionRow | null,
): asserts connection is Commerce7LifecycleConnectionRow {
  if (!connection || connection.brandId !== brandId) {
    throw new CommerceConnectionNotFoundError(connectionId);
  }
  if (connection.provider !== CommerceProvider.COMMERCE7) {
    throw new CommerceConnectionMismatchError(
      connectionId,
      CommerceProvider.COMMERCE7,
      connection.provider,
    );
  }
}

export type Commerce7DisconnectResult =
  | { status: "DISCONNECTED"; connectionId: string }
  | { status: "ALREADY_DISCONNECTED"; connectionId: string };

/**
 * Transitions a CONNECTED Commerce7 connection to DISCONNECTED. Idempotent:
 * calling this on an already-DISCONNECTED connection is a safe no-op (no
 * duplicate lifecycle event). Throws `CommerceConnectionNotFoundError` for a
 * missing/foreign connectionId, `CommerceConnectionMismatchError` for a
 * non-Commerce7 connection, and `CommerceConnectionNotReadyError` for any
 * OTHER non-CONNECTED status (PENDING/REQUIRES_RECONNECT/UNINSTALLED/ERROR)
 * — this action's one supported transition is exactly `CONNECTED ->
 * DISCONNECTED`; a connection that was never connected, or that Commerce7
 * itself already uninstalled, is not this action's concern.
 *
 * PHASE 20: locks the Brand FIRST (Part 15) — disconnecting frees this
 * Brand's Commerce7 active slot, so it must participate in the SAME
 * serialization strategy as link/reconnect, even though disconnect itself
 * never needs to CHECK the active-slot invariant (freeing a slot cannot
 * conflict with anything).
 */
export async function disconnectCommerce7Connection(
  input: { brandId: string; connectionId: string },
  deps: Partial<Commerce7ConnectionLifecycleDeps> = {},
): Promise<Commerce7DisconnectResult> {
  const resolved: Commerce7ConnectionLifecycleDeps = { ...DEFAULT_DEPS, ...deps };

  return resolved.runInTransaction(async (client) => {
    await client.lockBrand(input.brandId);
    const connection = await client.lockAndFindConnection(input.connectionId);
    assertOwnedCommerce7Connection(input.connectionId, input.brandId, connection);

    if (connection.status === "DISCONNECTED") {
      return { status: "ALREADY_DISCONNECTED", connectionId: connection.id };
    }
    if (connection.status !== "CONNECTED") {
      throw new CommerceConnectionNotReadyError(connection.id, connection.provider, connection.status);
    }

    await client.setConnectionStatus(connection.id, "DISCONNECTED");
    await client.recordEvent({
      brandId: connection.brandId,
      provider: connection.provider,
      eventType: "DISCONNECTED",
      externalAccountId: connection.externalAccountId,
      providerClientId: connection.providerClientId,
    });

    return { status: "DISCONNECTED", connectionId: connection.id };
  });
}

export type Commerce7SettingsSyncFailureReason =
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_REJECTED_CREDENTIALS"
  | "PROVIDER_MALFORMED_RESPONSE"
  | "SETTINGS_INVALID";

export type Commerce7ReconnectResult =
  | { status: "CONNECTED"; connectionId: string }
  | { status: "ALREADY_CONNECTED"; connectionId: string }
  | { status: "APP_NOT_INSTALLED"; connectionId: string }
  | { status: "COMMERCE7_STORE_ALREADY_CONNECTED"; connectionId: string }
  | { status: "SETTINGS_SYNC_FAILED"; connectionId: string; reason: Commerce7SettingsSyncFailureReason };

/** Sanitized classification only — never the underlying provider message/body (see ../errors.ts's own no-leak contract for `CommerceProviderApiError`). */
function classifyProviderFailure(error: CommerceProviderApiError): Commerce7SettingsSyncFailureReason {
  if (error.httpStatus === 401 || error.httpStatus === 403) {
    return "PROVIDER_REJECTED_CREDENTIALS";
  }
  if (error.httpStatus !== undefined) {
    return "PROVIDER_MALFORMED_RESPONSE";
  }
  return "PROVIDER_UNREACHABLE";
}

/**
 * Transitions a DISCONNECTED Commerce7 connection back to CONNECTED, ONLY
 * when ALL of the following hold:
 *   1. `CommerceProviderInstallation` for the SAME (provider,
 *      externalAccountId) still reports `INSTALLED`.
 *   2. Commerce7's Setting API can be fetched and yields values that pass
 *      SQRATCH's own destination-security validators (Part 2) — fetched and
 *      validated WHILE THE CONNECTION REMAINS DISCONNECTED, never after
 *      going live (see this file's header for why).
 *   3. No OTHER Commerce7 connection for this Brand currently occupies the
 *      active slot (Part 9/14).
 *
 * The SAME `CommerceConnection.id` is always preserved (an UPDATE, never a
 * new row), so every historical relationship survives untouched.
 *
 * Idempotent: calling this on an already-CONNECTED connection is a safe
 * no-op. Returns (never throws) a discriminated failure result for every
 * expected business outcome — `APP_NOT_INSTALLED`,
 * `COMMERCE7_STORE_ALREADY_CONNECTED`, `SETTINGS_SYNC_FAILED` — each with NO
 * mutation. Throws `CommerceConnectionNotFoundError` /
 * `CommerceConnectionMismatchError` for ownership/provider problems, and
 * `CommerceConnectionNotReadyError` for any status other than CONNECTED or
 * DISCONNECTED.
 */
export async function reconnectCommerce7Connection(
  input: { brandId: string; connectionId: string },
  deps: Partial<Commerce7ConnectionLifecycleDeps> = {},
): Promise<Commerce7ReconnectResult> {
  const resolved: Commerce7ConnectionLifecycleDeps = { ...DEFAULT_DEPS, ...deps };

  // --- Pre-transaction snapshot: ownership/provider/status, and a cheap
  // installation check before paying for a Commerce7 HTTP round trip. Both
  // are RE-VERIFIED for real, under the real Brand+connection locks, inside
  // the transaction below — this is only an early exit for the common cases.
  const snapshot = await resolved.readConnection(input.connectionId);
  assertOwnedCommerce7Connection(input.connectionId, input.brandId, snapshot);

  if (snapshot.status === "CONNECTED") {
    return { status: "ALREADY_CONNECTED", connectionId: snapshot.id };
  }
  if (snapshot.status !== "DISCONNECTED") {
    throw new CommerceConnectionNotReadyError(snapshot.id, snapshot.provider, snapshot.status);
  }

  const preInstallationStatus = await resolved.readInstallationStatus(
    snapshot.provider,
    snapshot.externalAccountId,
  );
  if (preInstallationStatus !== CommerceInstallationStatus.INSTALLED) {
    return { status: "APP_NOT_INSTALLED", connectionId: snapshot.id };
  }

  // --- Provider HTTP, entirely OUTSIDE any transaction, connection still
  // DISCONNECTED for its entire duration.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_SETTINGS_FETCH_TIMEOUT_MS);
  let rawSettings: Awaited<ReturnType<typeof fetchCommerce7StoreSettings>>;
  try {
    rawSettings = await resolved.fetchSettings({
      tenant: snapshot.externalAccountId,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof CommerceProviderApiError) {
      return {
        status: "SETTINGS_SYNC_FAILED",
        connectionId: snapshot.id,
        reason: classifyProviderFailure(error),
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  // SQRATCH's own destination-security validation (Part 2) — mandatory even
  // though the Setting API is the authoritative PROVIDER source. Run BEFORE
  // any transaction opens, mirroring `configureCommerce7Storefront`'s own
  // "validate first, transact second" shape.
  const storefrontResult = validateCommerce7StorefrontUrl(rawSettings.storefrontUrl);
  const routeResult = validateCommerce7ProductRoute(rawSettings.productRoute);
  const currencyResult = validateCommerce7CurrencyCode(rawSettings.currencyCode);
  if (!storefrontResult.ok || !routeResult.ok || !currencyResult.ok) {
    return { status: "SETTINGS_SYNC_FAILED", connectionId: snapshot.id, reason: "SETTINGS_INVALID" };
  }

  return resolved.runInTransaction(async (client) => {
    await client.lockBrand(input.brandId);
    const connection = await client.lockAndFindConnection(input.connectionId);
    assertOwnedCommerce7Connection(input.connectionId, input.brandId, connection);

    if (connection.status === "CONNECTED") {
      return { status: "ALREADY_CONNECTED", connectionId: connection.id };
    }
    if (connection.status !== "DISCONNECTED") {
      throw new CommerceConnectionNotReadyError(connection.id, connection.provider, connection.status);
    }

    // Re-verify installation status fresh, under lock — the pre-transaction
    // read above is only a fast-path hint.
    const installationStatus = await client.findInstallationStatus(
      connection.provider,
      connection.externalAccountId,
    );
    if (installationStatus !== CommerceInstallationStatus.INSTALLED) {
      return { status: "APP_NOT_INSTALLED", connectionId: connection.id };
    }

    const conflicting = await client.findConflictingActiveCommerce7Connection(
      connection.brandId,
      connection.id,
    );
    if (conflicting) {
      return { status: "COMMERCE7_STORE_ALREADY_CONNECTED", connectionId: connection.id };
    }

    await client.applyConfigurationValues(connection.id, connection, {
      storefrontUrl: storefrontResult.value,
      productRoute: routeResult.value,
      currencyCode: currencyResult.value,
    });
    await client.setConnectionStatus(connection.id, "CONNECTED");
    await client.recordEvent({
      brandId: connection.brandId,
      provider: connection.provider,
      eventType: "RECONNECTED",
      externalAccountId: connection.externalAccountId,
      providerClientId: connection.providerClientId,
    });

    return { status: "CONNECTED", connectionId: connection.id };
  });
}
