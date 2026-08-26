/**
 * src/lib/commerce/providers/commerce7-settings-sync.ts
 *
 * PHASE 20 (settings sync round) — the provider-neutral entry point that
 * fetches a Commerce7 tenant's AUTHORITATIVE store settings (Setting API,
 * see `./commerce7-settings.ts`) and persists them through the EXISTING,
 * unmodified `configureCommerce7Storefront` write/invalidation machinery
 * (`./commerce7-storefront-configuration.ts`) — this file deliberately
 * contains NO persistence logic of its own.
 *
 * ===========================================================================
 * WHY PROVIDER HTTP HAPPENS BEFORE ANY TRANSACTION OPENS
 * ===========================================================================
 * `configureCommerce7Storefront` already opens its own transaction (real
 * row lock, ownership/provider/status checks, write, invalidation). This
 * function's OWN ownership/provider/CONNECTED checks below run BEFORE the
 * Commerce7 network call purely to avoid an unauthorized or pointless
 * provider HTTP call — they are NOT a substitute for
 * `configureCommerce7Storefront`'s own re-check immediately before it
 * writes (which remains the authoritative, transactionally-fresh gate).
 * Never held across provider HTTP: no lock, no transaction is open for the
 * duration of the Commerce7 request.
 *
 * ===========================================================================
 * WHAT THIS DOES NOT DO
 * ===========================================================================
 * Never used for a DISCONNECTED connection reconnecting — that ordering
 * hazard (stale settings could briefly make a stale public destination live
 * again) is handled entirely differently, atomically, by
 * `reconnectCommerce7Connection` in `./commerce7-connection-lifecycle.ts`,
 * which fetches/validates settings WHILE the connection remains DISCONNECTED
 * and only applies them in the SAME transaction that flips status to
 * CONNECTED. This module is for an ALREADY-CONNECTED connection only: the
 * manual "Sync settings from Commerce7" button, and the automatic sync
 * attempted right after a brand-new tenant link commits.
 */

import { CommerceProvider } from "@prisma/client";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../errors";
import { getCommerceConnectionById } from "../connection-service";
import type { CommerceConnectionSummary } from "../types";
import {
  configureCommerce7Storefront,
  type Commerce7StorefrontConfigurationResult,
} from "./commerce7-storefront-configuration";
import {
  DEFAULT_SETTINGS_FETCH_TIMEOUT_MS,
  fetchCommerce7StoreSettings,
  type Commerce7StoreSettingsDTO,
} from "./commerce7-settings";

export type Commerce7SettingsSyncDeps = {
  getConnection(connectionId: string): Promise<CommerceConnectionSummary | null>;
  fetchSettings(input: { tenant: string; signal?: AbortSignal }): Promise<Commerce7StoreSettingsDTO>;
  configure(input: {
    brandId: string;
    connectionId: string;
    storefrontUrl: string;
    productRoute: string;
    currencyCode: string;
  }): Promise<Commerce7StorefrontConfigurationResult>;
};

const DEFAULT_DEPS: Commerce7SettingsSyncDeps = {
  getConnection: (connectionId) => getCommerceConnectionById(connectionId),
  fetchSettings: (input) => fetchCommerce7StoreSettings(input),
  configure: (input) => configureCommerce7Storefront(input),
};

/**
 * Fetches CURRENT Commerce7 store settings for one exact, owned, CONNECTED
 * Commerce7 connection and persists them through
 * `configureCommerce7Storefront`. Returns that function's own result type
 * unchanged — `{ok: true, ...}` on success, `{ok: false, field, error}` if
 * SQRATCH's destination-security validators (Part 2) reject a
 * provider-reported value, in which case NOTHING is persisted (partial
 * configuration is never written).
 *
 * Throws `CommerceConnectionNotFoundError` for a missing/foreign
 * connectionId, `CommerceConnectionMismatchError` for a non-Commerce7
 * connection, and `CommerceConnectionNotReadyError` for a Commerce7
 * connection that is not currently CONNECTED. A Commerce7 provider failure
 * (unreachable, 401/403, malformed/zero/multiple settings, missing field)
 * throws `CommerceProviderApiError` (see `./commerce7-settings.ts`) — never
 * caught and reinterpreted here, so the raw Setting response never touches
 * this function's own logic beyond the sanitized DTO it already returns.
 */
export async function syncCommerce7ConnectionSettings(
  input: { brandId: string; connectionId: string },
  deps: Partial<Commerce7SettingsSyncDeps> = {},
): Promise<Commerce7StorefrontConfigurationResult> {
  const resolved: Commerce7SettingsSyncDeps = { ...DEFAULT_DEPS, ...deps };

  const connection = await resolved.getConnection(input.connectionId);
  if (!connection || connection.brandId !== input.brandId) {
    throw new CommerceConnectionNotFoundError(input.connectionId);
  }
  if (connection.provider !== CommerceProvider.COMMERCE7) {
    throw new CommerceConnectionMismatchError(
      input.connectionId,
      CommerceProvider.COMMERCE7,
      connection.provider,
    );
  }
  if (connection.status !== "CONNECTED") {
    throw new CommerceConnectionNotReadyError(connection.id, connection.provider, connection.status);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_SETTINGS_FETCH_TIMEOUT_MS);
  let settings: Commerce7StoreSettingsDTO;
  try {
    settings = await resolved.fetchSettings({
      tenant: connection.externalAccountId,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  return resolved.configure({
    brandId: input.brandId,
    connectionId: input.connectionId,
    storefrontUrl: settings.storefrontUrl,
    productRoute: settings.productRoute,
    currencyCode: settings.currencyCode,
  });
}
