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

import type { CommerceProvider } from "@prisma/client";

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
 * `getCapabilities()` reports `canRevokeDiscount: false`).
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
 * Wraps a failure returned by a provider's API (HTTP error, GraphQL user
 * error, network failure, etc). Deliberately carries only diagnostic
 * metadata — it MUST NEVER carry or serialize access tokens, secrets, or
 * any other credential material.
 */
export class CommerceProviderApiError extends CommerceError {
  readonly provider: CommerceProvider;
  readonly providerCode?: string;

  constructor(provider: CommerceProvider, message: string, providerCode?: string) {
    super(message, "COMMERCE_PROVIDER_API_ERROR");
    this.name = "CommerceProviderApiError";
    this.provider = provider;
    this.providerCode = providerCode;
    Object.setPrototypeOf(this, CommerceProviderApiError.prototype);
  }
}
