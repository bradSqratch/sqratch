/**
 * src/lib/commerce/errors.ts
 *
 * Provider-neutral error types for the commerce abstraction layer.
 *
 * All errors extend `CommerceError`, which itself extends the built-in
 * `Error`. Because the repo compiles TypeScript down to an ES2017 target,
 * subclassing `Error` does not automatically wire up the prototype chain
 * correctly on some downlevel targets (a long-standing TS/JS quirk — see
 * https://github.com/microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work).
 * Each constructor below explicitly restores the prototype via
 * `Object.setPrototypeOf` so that `instanceof CommerceError` (and
 * `instanceof` checks against the concrete subclasses) work reliably no
 * matter how the error was constructed or re-thrown.
 *
 * These classes intentionally know nothing about Shopify, Commerce7, or any
 * other concrete provider beyond the `CommerceProvider` enum value passed in
 * by the caller.
 */

import type { CommerceConnectionStatus, CommerceProvider } from "@prisma/client";

/**
 * Base class for every error raised by the commerce abstraction layer.
 * Carries a stable machine-readable `code` string in addition to the
 * human-readable `message`, so callers can branch on `code` without doing
 * fragile `instanceof` chains across module boundaries (e.g. after HMR).
 */
export class CommerceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    Object.setPrototypeOf(this, CommerceError.prototype);
  }
}

/**
 * Thrown when the requested `CommerceProvider` has no registered adapter.
 * Commerce7 is the current example: it exists only as an enum value today,
 * with no adapter implementation behind it.
 */
export class UnsupportedProviderError extends CommerceError {
  readonly provider: CommerceProvider;

  constructor(provider: CommerceProvider) {
    super(`No commerce adapter is registered for provider "${provider}".`, "UNSUPPORTED_PROVIDER");
    this.name = "UnsupportedProviderError";
    this.provider = provider;
    Object.setPrototypeOf(this, UnsupportedProviderError.prototype);
  }
}

/**
 * Thrown when an adapter is asked to perform a capability it does not
 * implement (e.g. calling `revokeDiscount` on a provider whose
 * `getCapabilities()` reports `rewards.revoke: false`).
 */
export class UnsupportedCapabilityError extends CommerceError {
  readonly provider: CommerceProvider;
  readonly capability: string;

  constructor(provider: CommerceProvider, capability: string) {
    super(
      `Provider "${provider}" does not support the "${capability}" capability.`,
      "UNSUPPORTED_CAPABILITY",
    );
    this.name = "UnsupportedCapabilityError";
    this.provider = provider;
    this.capability = capability;
    Object.setPrototypeOf(this, UnsupportedCapabilityError.prototype);
  }
}

/**
 * Thrown when a lookup by `CommerceConnection.id` finds no matching row.
 */
export class CommerceConnectionNotFoundError extends CommerceError {
  readonly connectionId: string;

  constructor(connectionId: string) {
    super(`Commerce connection "${connectionId}" was not found.`, "COMMERCE_CONNECTION_NOT_FOUND");
    this.name = "CommerceConnectionNotFoundError";
    this.connectionId = connectionId;
    Object.setPrototypeOf(this, CommerceConnectionNotFoundError.prototype);
  }
}

/**
 * Thrown when a caller asks to operate on a specific `CommerceConnection.id`
 * for a `CommerceProvider` other than the one that connection actually
 * belongs to (e.g. requesting a Shopify sync against a Commerce7
 * connection id). Deliberately distinct from `CommerceConnectionNotFoundError`
 * — this connection DOES exist and DOES belong to the caller's brand; only the
 * provider identity is wrong, which is a caller/UI bug rather than an
 * authorization failure, so it is safe to name the mismatch explicitly.
 */
export class CommerceConnectionMismatchError extends CommerceError {
  readonly connectionId: string;
  readonly requestedProvider: CommerceProvider;
  readonly actualProvider: CommerceProvider;

  constructor(
    connectionId: string,
    requestedProvider: CommerceProvider,
    actualProvider: CommerceProvider,
  ) {
    super(
      `Commerce connection "${connectionId}" belongs to provider "${actualProvider}", not the requested "${requestedProvider}".`,
      "COMMERCE_CONNECTION_PROVIDER_MISMATCH",
    );
    this.name = "CommerceConnectionMismatchError";
    this.connectionId = connectionId;
    this.requestedProvider = requestedProvider;
    this.actualProvider = actualProvider;
    Object.setPrototypeOf(this, CommerceConnectionMismatchError.prototype);
  }
}

/**
 * Thrown when a caller asks to perform account-specific provider I/O
 * (product sync, etc.) against a `CommerceConnection` that EXISTS, and
 * belongs to the caller's own brand, and matches the requested provider —
 * but whose `status` is not `CONNECTED`.
 *
 * The canonical lifecycle contract: `UNINSTALLED` / `DISCONNECTED` /
 * `REQUIRES_RECONNECT` must never reach account-specific provider transport.
 * This is that boundary's typed failure. Deliberately distinct from
 * `CommerceConnectionNotFoundError` (existence/ownership) and
 * `CommerceConnectionMismatchError` (provider identity) — this connection is
 * genuinely the caller's own, correctly identified connection; only its
 * lifecycle state disqualifies it, which is safe to state plainly (it is
 * never used to answer "does connection X exist" for an unowned id).
 *
 * Carries only `connectionId`, `provider`, and the actual `status` — never a
 * credential, token, or other connection metadata.
 */
export class CommerceConnectionNotReadyError extends CommerceError {
  readonly connectionId: string;
  readonly provider: CommerceProvider;
  readonly status: CommerceConnectionStatus;

  constructor(
    connectionId: string,
    provider: CommerceProvider,
    status: CommerceConnectionStatus,
  ) {
    super(
      `Commerce connection "${connectionId}" is not connected (status: "${status}").`,
      "COMMERCE_CONNECTION_NOT_READY",
    );
    this.name = "CommerceConnectionNotReadyError";
    this.connectionId = connectionId;
    this.provider = provider;
    this.status = status;
    Object.setPrototypeOf(this, CommerceConnectionNotReadyError.prototype);
  }
}

/**
 * Wraps a failure returned by a provider's API (HTTP error, GraphQL user
 * error, network failure, etc). Deliberately carries only diagnostic
 * metadata — it MUST NEVER carry or serialize access tokens, secrets, or
 * any other credential material.
 */
export class CommerceProviderApiError extends CommerceError {
  readonly provider: CommerceProvider;
  readonly providerCode?: string;
  /**
   * The HTTP status the upstream provider call itself failed with, when the
   * caller that raised this error has one to report (e.g.
   * `ShopifyCommerceAdapter.syncProducts` passes through the `status` field
   * `fetchNormalizedShopifyProducts` already computed for the same failure —
   * see `src/lib/shopify-products.ts`). Optional and never guessed: a caller
   * with no meaningful upstream status (e.g. a token-resolution failure)
   * simply omits it, and a route mapping this error back to an HTTP response
   * must supply its own fallback status in that case.
   */
  readonly httpStatus?: number;
  /**
   * Opaque, provider-specific diagnostic detail attached to this failure
   * (e.g. Shopify's `userErrors` array from a GraphQL mutation response).
   * Deliberately typed `unknown`, never a named provider shape — this class
   * must stay provider-neutral. Optional and never guessed: a caller with
   * no such detail simply omits it. MUST NEVER carry or serialize an access
   * token, secret, or any other credential material — the same rule as the
   * rest of this class.
   */
  readonly details?: unknown;

  constructor(
    provider: CommerceProvider,
    message: string,
    providerCode?: string,
    httpStatus?: number,
    details?: unknown,
  ) {
    super(message, "COMMERCE_PROVIDER_API_ERROR");
    this.name = "CommerceProviderApiError";
    this.provider = provider;
    this.providerCode = providerCode;
    this.httpStatus = httpStatus;
    this.details = details;
    Object.setPrototypeOf(this, CommerceProviderApiError.prototype);
  }
}
