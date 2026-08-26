/**
 * src/lib/commerce/providers/commerce7-settings.ts
 *
 * PHASE 20 (settings sync round) — Commerce7 READ-ONLY Setting API client:
 * `GET /v1/setting`. This is SQRATCH's chosen source for a tenant's
 * storefront URL, currency, and product-page base route — replacing the
 * prior manual Brand-Admin-authored configuration.
 *
 * ===========================================================================
 * PHASE 21 — DOCUMENTATION ACCURACY, NOT A BEHAVIOR CHANGE
 * ===========================================================================
 * Empirically verified working against the SQRATCH Commerce7 sandbox
 * (`sqratch-inc`) with `Setting: Read` enabled, using App ID/App Secret
 * Basic Auth and an exact `tenant` header — see
 * `docs/commerce/commerce7-required-permissions.md`. Commerce7 staff have
 * separately indicated in Partner Slack that they were not certain Setting
 * data is generally accessible through partner app credentials, and SQRATCH
 * is awaiting Commerce7's explicit confirmation on whether the collection
 * endpoint (`/v1/setting`) is supported the same way for every installed
 * merchant tenant, as distinct from a per-id lookup (`/v1/setting/:id`).
 * This is a documentation-accuracy correction only — no API behavior below
 * has changed: `fetchCommerce7StoreSettings` already fails closed on ANY
 * non-2xx response (401/403 included — see the status checks further down),
 * and every caller already treats that as a normal, controlled
 * settings-sync failure (`commerce7-connection-lifecycle.ts` /
 * `commerce7-settings-sync.ts`), never surfaced to a merchant as an alarming
 * error. Manual editing was NOT restored, and is not planned regardless of
 * how Commerce7 answers — see
 * `docs/commerce/commerce7-required-permissions.md` for the operational
 * plan if the collection endpoint turns out to be unavailable for some
 * tenants.
 *
 * ===========================================================================
 * SECURITY BOUNDARY — READ THIS BEFORE TOUCHING THIS FILE
 * ===========================================================================
 * Commerce7's `/v1/setting` response documents far more than SQRATCH needs —
 * it can carry configuration or credential-like values belonging to OTHER
 * merchant integrations (shipping-compliance, tax, payment, and other
 * third-party settings entirely unrelated to SQRATCH). This module's ONLY
 * job is to immediately PROJECT the response down to exactly three fields
 * (`url`, `currency`, `baseRoute.product`) and discard everything else —
 * nothing beyond that projection is ever held past this function's return.
 *
 * Consequently, this module and every caller of it MUST NEVER:
 *   - log the raw Setting response (not even at debug level, not even a
 *     partial/truncated dump)
 *   - persist the raw Setting response (not in `providerMetadata`, not
 *     anywhere else)
 *   - return the raw Setting response through any SQRATCH API
 *   - include the raw Setting response (or any of its unprojected fields)
 *     in a thrown error, exception message, or diagnostics payload
 * `fetchCommerce7StoreSettings` below returns ONLY the narrow
 * `Commerce7StoreSettingsDTO` — there is no code path that hands the caller
 * the parsed `unknown` response body.
 *
 * CREDENTIALS: app-global only, identical discipline to
 * `commerce7-products.ts` / `commerce7-orders.ts` — Basic auth is
 * `App ID : App Secret`, both read from backend environment configuration.
 * Never `CommerceConnectionSecret`.
 *
 * TENANT BINDING: every request carries an explicit `tenant` header the
 * caller derived from `CommerceConnection.externalAccountId`. This module
 * never accepts a tenant from a browser and never falls back to a default.
 *
 * SQRATCH DESTINATION-SECURITY VALIDATION IS SEPARATE: this client performs
 * only STRUCTURAL validation (the three fields exist and are non-empty
 * strings). It deliberately does NOT run
 * `validateCommerce7StorefrontUrl`/`validateCommerce7CurrencyCode`/
 * `validateCommerce7ProductRoute` itself — those live in
 * `./commerce7-connection-config.ts` and are already invoked by
 * `configureCommerce7Storefront` (`./commerce7-storefront-configuration.ts`),
 * which every caller of this client persists through. Duplicating that
 * validation here would risk the two copies drifting apart.
 */

import { CommerceProvider } from "@prisma/client";
import { CommerceProviderApiError } from "../errors";
import {
  buildCommerce7AppAuthorizationHeader,
  getCommerce7AppConfig,
  normalizeCommerce7Tenant,
} from "./commerce7";

const COMMERCE7_API_BASE = "https://api.commerce7.com/v1";

/** A single non-paginated GET — generous but genuinely bounded, matching the "existing provider timeout policy" (`product-sync.ts`'s `collectCatalog`, the only other place in this codebase that owns an `AbortController`). */
export const DEFAULT_SETTINGS_FETCH_TIMEOUT_MS = 15_000;

export type Commerce7Fetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The ONLY three fields this module ever returns. Nothing else from the Setting response survives past this function. */
export type Commerce7StoreSettingsDTO = {
  storefrontUrl: string;
  currencyCode: string;
  productRoute: string;
};

function providerError(message: string, httpStatus?: number): never {
  throw new CommerceProviderApiError(
    CommerceProvider.COMMERCE7,
    message,
    undefined,
    httpStatus,
  );
}

function authHeaders(tenant: string): Record<string, string> {
  const config = getCommerce7AppConfig();
  if (!config) {
    providerError("Commerce7 API credentials are not configured.");
  }
  return {
    Authorization: buildCommerce7AppAuthorizationHeader(config),
    tenant,
    Accept: "application/json",
  };
}

/**
 * Structurally extracts ONLY `url`, `currency`, and `baseRoute.product` from
 * ONE settings row. Returns `null` (never partial data) if any required
 * field is missing, empty, or the wrong type — this function is the entire
 * projection boundary described in this file's header, so it is
 * deliberately narrow and defensive rather than permissive.
 */
function projectSettingsRow(row: unknown): Commerce7StoreSettingsDTO | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const record = row as Record<string, unknown>;

  const url = record.url;
  const currency = record.currency;
  const baseRoute = record.baseRoute;

  if (typeof url !== "string" || url.trim().length === 0) {
    return null;
  }
  if (typeof currency !== "string" || currency.trim().length === 0) {
    return null;
  }
  if (!baseRoute || typeof baseRoute !== "object" || Array.isArray(baseRoute)) {
    return null;
  }
  const product = (baseRoute as Record<string, unknown>).product;
  if (typeof product !== "string" || product.trim().length === 0) {
    return null;
  }

  return {
    storefrontUrl: url,
    currencyCode: currency,
    productRoute: product,
  };
}

export type Commerce7SettingsRequest = {
  /** Exact tenant, always derived from `CommerceConnection.externalAccountId`. */
  tenant: string;
  signal?: AbortSignal;
};

/**
 * Fetches and projects a Commerce7 tenant's store settings: `GET
 * /v1/setting`. Requires the `settings` array to exist and contain EXACTLY
 * one usable row — zero rows, more than one row, a non-array `settings`
 * value, or a row missing/malformed on any of the three required fields all
 * fail closed with a classified `CommerceProviderApiError`, never a partial
 * or guessed result.
 *
 * See this file's header for the hard security boundary this function
 * enforces: the return value is ALWAYS exactly `{ storefrontUrl,
 * currencyCode, productRoute }`, never the raw response.
 */
export async function fetchCommerce7StoreSettings(
  request: Commerce7SettingsRequest,
  deps: { fetchImpl?: Commerce7Fetch } = {},
): Promise<Commerce7StoreSettingsDTO> {
  const tenant = normalizeCommerce7Tenant(request.tenant);
  if (!tenant) {
    providerError("A valid Commerce7 tenant is required.");
  }

  const fetchImpl = (deps.fetchImpl ??
    (globalThis.fetch as unknown as Commerce7Fetch)) as Commerce7Fetch;

  const url = `${COMMERCE7_API_BASE}/setting`;

  let response: Awaited<ReturnType<Commerce7Fetch>>;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: authHeaders(tenant),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch {
    // The thrown error can echo request headers; never surface it.
    providerError("Commerce7 could not be reached.");
  }

  if (response.status === 401 || response.status === 403) {
    providerError("Commerce7 rejected the app credentials for this tenant.", response.status);
  }
  if (!response.ok) {
    providerError("Commerce7 returned an error for the settings request.", response.status);
  }

  // Parsed only as `unknown` — never logged, never persisted, never
  // returned. Only the narrow projection below ever leaves this function.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    providerError("Commerce7 returned a malformed settings response.", response.status);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    providerError("Commerce7 returned a malformed settings response.");
  }

  const settings = (payload as Record<string, unknown>).settings;
  if (!Array.isArray(settings)) {
    providerError("Commerce7 settings response did not include a settings array.");
  }
  if (settings.length === 0) {
    providerError("Commerce7 reported no store settings for this tenant.");
  }
  if (settings.length > 1) {
    providerError("Commerce7 reported more than one settings row for this tenant.");
  }

  const projected = projectSettingsRow(settings[0]);
  if (!projected) {
    providerError("Commerce7 settings response is missing a required field.");
  }

  return projected;
}
