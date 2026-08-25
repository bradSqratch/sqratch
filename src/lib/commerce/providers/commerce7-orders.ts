/**
 * src/lib/commerce/providers/commerce7-orders.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 4 — Commerce7 READ-ONLY order API client:
 * `GET /order/{id}` and `GET /order` (date-bounded list, for the optional
 * backfill entrypoint only).
 *
 * CREDENTIALS: app-global only, identical discipline to
 * `commerce7-products.ts` — Basic auth is `App ID : App Secret`, both read
 * from backend environment configuration via `getCommerce7AppConfig()`.
 * Never `CommerceConnectionSecret`.
 *
 * TENANT BINDING: every request carries an explicit `tenant` header the
 * caller derived from `CommerceConnection.externalAccountId`. This module
 * never accepts a tenant from a browser and never falls back to a default.
 *
 * NO MUTATION: this file only ever issues `GET` requests. It has no
 * function that creates, updates, or cancels a Commerce7 order — order
 * mutation is explicitly out of scope for this round.
 *
 * LOGGING: nothing here logs the Authorization header, the App Secret, or a
 * raw provider payload. Provider failures are surfaced as
 * `CommerceProviderApiError` carrying a sanitized message plus the upstream
 * HTTP status only.
 */

import { CommerceProvider } from "@prisma/client";
import { CommerceProviderApiError } from "../errors";
import {
  buildCommerce7AppAuthorizationHeader,
  getCommerce7AppConfig,
  normalizeCommerce7Tenant,
} from "./commerce7";

const COMMERCE7_API_BASE = "https://api.commerce7.com/v1";

export type Commerce7Fetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

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
    // Deliberately does not name which variable is missing.
    providerError("Commerce7 API credentials are not configured.");
  }
  return {
    Authorization: buildCommerce7AppAuthorizationHeader(config),
    tenant,
    Accept: "application/json",
  };
}

async function parseOrderResponse(
  response: Awaited<ReturnType<Commerce7Fetch>>,
): Promise<Record<string, unknown>> {
  if (response.status === 401 || response.status === 403) {
    providerError("Commerce7 rejected the app credentials for this tenant.", response.status);
  }
  if (response.status === 404) {
    providerError("Commerce7 order was not found.", response.status);
  }
  if (!response.ok) {
    providerError("Commerce7 returned an error for the order request.", response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    providerError("Commerce7 returned a malformed order response.", response.status);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    providerError("Commerce7 returned a malformed order response.");
  }

  return payload as Record<string, unknown>;
}

export type Commerce7OrderRequest = {
  /** Exact tenant, always derived from `CommerceConnection.externalAccountId`. */
  tenant: string;
  /** Commerce7's own order id (UUID). */
  externalOrderId: string;
  signal?: AbortSignal;
};

/**
 * Fetches ONE Commerce7 order by its own id: `GET /order/{id}`. Returns the
 * RAW order JSON object — normalization is a separate, pure step (see
 * `./commerce7-order-normalizer.ts`) so this client stays a thin transport
 * layer with no business-mapping decisions of its own.
 */
export async function fetchCommerce7Order(
  request: Commerce7OrderRequest,
  deps: { fetchImpl?: Commerce7Fetch } = {},
): Promise<Record<string, unknown>> {
  const tenant = normalizeCommerce7Tenant(request.tenant);
  if (!tenant) {
    providerError("A valid Commerce7 tenant is required.");
  }
  const externalOrderId = request.externalOrderId?.trim();
  if (!externalOrderId) {
    providerError("A Commerce7 order id is required.");
  }

  const fetchImpl = (deps.fetchImpl ??
    (globalThis.fetch as unknown as Commerce7Fetch)) as Commerce7Fetch;

  const url = `${COMMERCE7_API_BASE}/order/${encodeURIComponent(externalOrderId)}`;

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

  return parseOrderResponse(response);
}

// ---------------------------------------------------------------------------
// Bounded backfill / reconciliation (list endpoint) — NEVER auto-run
// ---------------------------------------------------------------------------

/** Hard ceiling on how many orders one backfill call will ever request. */
export const COMMERCE7_BACKFILL_MAX_RESULTS = 500;

export type Commerce7OrderListRequest = {
  tenant: string;
  /** Inclusive lower bound — required. An unbounded backfill is refused. */
  updatedAtGte: Date;
  /** Inclusive upper bound — required. An unbounded backfill is refused. */
  updatedAtLte: Date;
  signal?: AbortSignal;
};

export type Commerce7OrderListPage = {
  orders: Record<string, unknown>[];
  total: number;
};

function formatCommerce7DateParam(date: Date): string {
  return date.toISOString();
}

/**
 * Fetches ONE page of `GET /order`, date-bounded via the documented
 * `updatedAt` query operators (`gte:`/`lte:`). Commerce7's list endpoint
 * documents NO cursor/pagination mechanism — this is a genuine, confirmed
 * gap, not an oversight — so this function deliberately does not attempt to
 * "walk" a full catalog the way `fetchAllCommerce7Products` does. It exists
 * ONLY to back the optional, explicitly-bounded reconciliation entrypoint in
 * `./commerce7-order-backfill.ts`, which additionally enforces a hard
 * result-count ceiling and is never invoked automatically.
 *
 * BOTH bounds are required (never "since forever") — an unbounded backfill
 * against a provider with no pagination could return an unbounded response.
 */
export async function fetchCommerce7OrdersByDateRange(
  request: Commerce7OrderListRequest,
  deps: { fetchImpl?: Commerce7Fetch } = {},
): Promise<Commerce7OrderListPage> {
  const tenant = normalizeCommerce7Tenant(request.tenant);
  if (!tenant) {
    providerError("A valid Commerce7 tenant is required.");
  }
  if (!(request.updatedAtGte instanceof Date) || Number.isNaN(request.updatedAtGte.getTime())) {
    providerError("A valid updatedAtGte bound is required.");
  }
  if (!(request.updatedAtLte instanceof Date) || Number.isNaN(request.updatedAtLte.getTime())) {
    providerError("A valid updatedAtLte bound is required.");
  }
  if (request.updatedAtGte.getTime() > request.updatedAtLte.getTime()) {
    providerError("updatedAtGte must not be after updatedAtLte.");
  }

  const fetchImpl = (deps.fetchImpl ??
    (globalThis.fetch as unknown as Commerce7Fetch)) as Commerce7Fetch;

  const params = new URLSearchParams();
  params.set("updatedAt", `gte:${formatCommerce7DateParam(request.updatedAtGte)}`);
  const url = `${COMMERCE7_API_BASE}/order?${params.toString()}`;

  let response: Awaited<ReturnType<Commerce7Fetch>>;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: authHeaders(tenant),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch {
    providerError("Commerce7 could not be reached.");
  }

  const body = await parseOrderResponse(response);
  const rawOrders = body.orders;
  if (!Array.isArray(rawOrders)) {
    providerError("Commerce7 returned a malformed order list response.");
  }

  // The upper bound is not a documented query operand alongside a lower
  // bound in one call (the docs show `btw:` for the date-window params but
  // this function targets `updatedAt`, whose documented operators are
  // singular comparisons) — enforced client-side instead, so the caller's
  // window is exact regardless of how the server-side filter behaves.
  const orders = rawOrders.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const updatedAtRaw = (entry as Record<string, unknown>).updatedAt;
    if (typeof updatedAtRaw !== "string") {
      return false;
    }
    const updatedAt = new Date(updatedAtRaw);
    if (Number.isNaN(updatedAt.getTime())) {
      return false;
    }
    return updatedAt.getTime() <= request.updatedAtLte.getTime();
  });

  const total = typeof body.total === "number" ? body.total : orders.length;

  return { orders, total };
}
