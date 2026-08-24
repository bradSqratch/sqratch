/**
 * src/lib/commerce/product-sync.ts
 *
 * Provider-neutral PRODUCT PERSISTENCE service. Fetches a brand's commerce
 * catalog through the registered `CommerceAdapter` (never a hard-coded
 * Shopify import) and upserts it into `ConnectedCommerceProduct`, recording
 * one `CommerceProductSyncRun` row per attempt.
 *
 * Same dependency-injection idiom as `./connection-sync.ts` /
 * `./connection-reconciliation.ts`: every exported entry point takes a
 * `Partial<ProductSyncDeps>`, the default DB-backed implementations lazily
 * `import("@/lib/prisma")` inside the function body, so importing this
 * module never requires `DATABASE_URL`.
 *
 * ---------------------------------------------------------------------------
 * MISSING CONNECTIONS NEVER GET A SILENT EMPTY SUCCESS
 * ---------------------------------------------------------------------------
 * `CommerceProductSyncRun.connectionId` is a required FK to a real
 * `CommerceConnection` row. A missing connection therefore returns an
 * explicit skipped outcome, never a false successful zero-product sync.
 *
 * ---------------------------------------------------------------------------
 * FULL vs PARTIAL vs FAILED, AND THE MARK-UNAVAILABLE GUARD
 * ---------------------------------------------------------------------------
 * The soft-unavailability step (marking every previously-seen,
 * currently-available product that was NOT returned by this run as
 * `isAvailable: false`) is the most dangerous write this module makes: get it
 * wrong and a transient provider hiccup erases a brand's entire catalog. It
 * therefore runs ONLY when the fetch fully and successfully exhausted the
 * catalog:
 *
 *   - A provider-page failure before any usable result -> run status FAILED.
 *   - A page failure, malformed cursor, guard, timeout, or write failure
 *     after usable products -> run status PARTIAL. Returned products may be
 *     persisted, but absence reconciliation is skipped.
 *   - Only a page sequence that explicitly terminates with `isComplete:true`
 *     and has no write failures -> run status SUCCEEDED. Only then does
 *     absence reconciliation run, scoped to `connectionId` and excluding
 *     every external key seen in the complete catalog.
 *
 * The guard itself lives in `runProductSync` below, directly on the branch
 * that decides `finalStatus`: `markUnavailableExcept` is called from exactly
 * one place, inside `if (finalStatus === "SUCCEEDED")`.
 *
 * `hasPublicStorefrontUrl` (Phase 8) is held to the SAME discipline, and is
 * deliberately narrower: it is only ever written from a page that actually
 * returned that specific product, i.e. through `decideProductWrite`'s
 * CREATE/UPDATE data for a fetched row. The absence sweep
 * (`markUnavailableExcept`) must never touch it — a truncated fetch would
 * otherwise mass-clear every unfetched product's public destination. It is
 * also never derived from `isAvailable` (or vice versa): one is provider
 * inventory/lifecycle status, the other is whether the provider gave us a
 * provider-confirmed Online Store publication, and a public click destination
 * needs both. Shopify's password-protected development stores can return
 * `onlineStoreUrl: null` for every published product, so the adapter's fact
 * comes from its complete publication scan, never URL presence alone.
 *
 * ---------------------------------------------------------------------------
 * MONEY / CURRENCY
 * ---------------------------------------------------------------------------
 * `CommerceProduct.currency` (from `./types.ts`) is NEVER read here — for
 * Shopify it is a hardcoded `"USD"` default unless a caller explicitly
 * supplies `options.currency` to `fetchNormalizedShopifyProducts`, which
 * nothing in this codebase does (see that file's own warning comment).
 * Instead, currency comes from the ALREADY-RESOLVED
 * `CommerceConnectionSummary.currencyCode` (`summary.currencyCode`,
 * sourced from `CommerceConnection.providerMetadata.currencyCode` — the
 * single canonical currency representation, see `./types.ts`) —
 * `syncBrandCommerceProducts` already resolves `summary` before this sync
 * even starts, so this is a pure pass-through, not a second read. This
 * module deliberately does NOT attempt a live self-heal fetch when it is
 * `null`: doing so would require importing Shopify-specific token/currency
 * resolution into a module whose entire contract is provider-neutral (see
 * the file header above — adapter access only, never a hard-coded Shopify
 * import). The self-heal that DOES exist (`getValidAccessToken` +
 * `getShopifyShopCurrencyWithAccessToken` + `recordCommerceConnectionCurrencyCode`,
 * see `src/app/api/brand/rewards/offers/route.ts`) lives at the Shopify-aware
 * routes that actually need it, and its write lands in the same canonical
 * field this module reads — so a gap closed there is visible here on the
 * very next sync with no duplicated logic. Fetched once per sync (not once
 * per product). When `summary.currencyCode` is `null`/unknown, EVERY
 * product for this brand gets
 * `currencyCode: null`, `priceMinMinor: null`, `priceMaxMinor: null`,
 * `priceMinorUnitExponent: null` — never a guessed "USD", and never an
 * amount stored without a currency to name its unit. When the brand currency
 * IS known, `priceRangeRaw.min` / `.max` (raw decimal strings) are converted
 * independently via `providerPriceStringToMinorUnits` from `./money.ts`; a
 * parse failure on one bound (`ok: false` — including a value that parses
 * fine but overflows Postgres `INTEGER`'s 32-bit range, reason
 * `OUT_OF_RANGE`; see that module's header) nulls only that bound, not the
 * whole product — `priceMinorUnitExponent` is resolved directly from the
 * currency code via `getCurrencyExponent` so it is never left `null` merely
 * because a price string failed to parse.
 *
 * ---------------------------------------------------------------------------
 * CHANGE DETECTION AND IDEMPOTENCY
 * ---------------------------------------------------------------------------
 * `decideProductWrite` is a PURE function (no I/O) that compares a fetched
 * product's computed fields against the existing row (if any) and returns
 * one of three decisions: CREATE (no existing row), UPDATE (an existing row
 * whose title/handle/productUrl/imageUrl/images/externalVariantIds/
 * descriptionText/sku/currencyCode/price fields/status changed, OR whose
 * availability needs to flip), or TOUCH (existing row, nothing meaningful
 * changed). Only CREATE/UPDATE write the full field set; TOUCH writes ONLY
 * `lastSeenAt` + `lastSyncRunId` — this is what makes a second, identical
 * sync report 100% UNCHANGED while performing no other field writes.
 *
 * ---------------------------------------------------------------------------
 * SANITIZED providerMetadata
 * ---------------------------------------------------------------------------
 * `buildProviderMetadata` whitelists exactly five benign, non-credential
 * fields from the neutral `CommerceProduct` — `status`, `priceText`,
 * `providerCreatedAt` (ISO string), `providerUpdatedAt` (ISO string), and a
 * boolean URL-provenance marker — and
 * NEVER spreads the provider payload or stores a raw provider node, URL with
 * embedded credentials, header, or token. `failureSummary` (on
 * `CommerceProductSyncRun`) is built by `classifySyncFailure` below, which
 * emits a short classified tag plus a bounded (300-char), message-only
 * string — never a full error object, response body, or URL.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It never hard-deletes a `ConnectedCommerceProduct` row (soft-unavailable
 * only, per the schema's design). It never touches
 * `CommerceConnection.lastProductSyncAt` directly — the optional adapter
 * completion hook owns that provider-connection write after this service has
 * confirmed a complete persisted catalog. This file only directly touches
 * `ConnectedCommerceProduct` / `CommerceProductSyncRun`.
 */

import { CommerceProvider, type Prisma } from "@prisma/client";
import type { CommerceAdapter } from "./adapter";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  CommerceProviderApiError,
  UnsupportedCapabilityError,
} from "./errors";
import { getCurrencyExponent, providerPriceStringToMinorUnits } from "./money";
import type { CommerceConnectionSummary, CommerceProduct } from "./types";
import {
  getActiveCommerceConnection,
  getAdapterForConnection,
  getCommerceConnectionById,
} from "./connection-service";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type ProductSyncStats = {
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  markedUnavailableCount: number;
  failedCount: number;
};

function zeroStats(): ProductSyncStats {
  return {
    fetchedCount: 0,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    markedUnavailableCount: 0,
    failedCount: 0,
  };
}

export type ProductSyncSkippedReason =
  /** The brand has no commerce connection at all for this provider. */
  | "NO_CONNECTION"
  /**
   * A connection exists for this provider but its `status` is not
   * `CONNECTED` (e.g. `UNINSTALLED`, `DISCONNECTED`, `REQUIRES_RECONNECT`).
   * PHASE 16C2: the canonical product-sync lifecycle invariant — provider
   * I/O never runs against a non-CONNECTED connection. Never silently swaps
   * in a different connection or auto-reconnects.
   */
  | "NOT_CONNECTED";

export type ProductSyncOutcome =
  | {
      status: "SKIPPED";
      reason: ProductSyncSkippedReason;
      brandId: string;
      provider: CommerceProvider;
    }
  | {
      status: "SUCCEEDED" | "PARTIAL" | "FAILED";
      brandId: string;
      provider: CommerceProvider;
      connectionId: string;
      runId: string;
      stats: ProductSyncStats;
      hasNextPage: boolean;
      /** Classified, sanitized failure detail. `null` for a SUCCEEDED run. */
      failureSummary: string | null;
    };

// ---------------------------------------------------------------------------
// DB row shapes (select-shaped, never the full Prisma model)
// ---------------------------------------------------------------------------

export type ExistingConnectedProductRow = {
  id: string;
  externalKey: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  externalVariantIds: string[];
  descriptionText: string | null;
  sku: string | null;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  isAvailable: boolean;
  hasPublicStorefrontUrl: boolean;
  unavailableSince: Date | null;
  providerMetadata: Prisma.JsonValue | null;
};

export type ConnectedProductWriteData = {
  externalId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  externalVariantIds: string[];
  descriptionText: string | null;
  sku: string | null;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  isAvailable: boolean;
  hasPublicStorefrontUrl: boolean;
  unavailableSince: Date | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  providerMetadata: Prisma.JsonObject;
  lastSeenAt: Date;
  lastSyncRunId: string;
};

export type ProductWriteDecision =
  | { kind: "CREATE"; data: ConnectedProductWriteData }
  | { kind: "UPDATE"; existingId: string; data: ConnectedProductWriteData }
  | {
      kind: "TOUCH";
      existingId: string;
      lastSeenAt: Date;
      lastSyncRunId: string;
    };

export type CreateSyncRunInput = {
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
  triggeredBy: string | null;
};

export type FinalizeSyncRunInput = {
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  finishedAt: Date;
  stats: ProductSyncStats;
  hasNextPage: boolean;
  requestedLimit: number | null;
  failureSummary: string | null;
};

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export type ProductSyncDeps = {
  /** Resolves the brand's active connection summary for `provider`. Defaults to `getActiveCommerceConnection`. */
  getActiveConnection(
    brandId: string,
    provider: CommerceProvider,
  ): Promise<CommerceConnectionSummary | null>;
  /** Resolves the adapter for `provider`. Throws `UnsupportedProviderError` for an unregistered provider (no live example today: SHOPIFY and COMMERCE7 are both registered as of Phase 16C1). Never itself makes a network call. */
  getAdapter(summary: CommerceConnectionSummary): CommerceAdapter;
  /** Loads every existing `ConnectedCommerceProduct` row for this connection, keyed for change detection. */
  findExistingProducts(
    connectionId: string,
  ): Promise<ExistingConnectedProductRow[]>;
  /** Creates the `RUNNING` `CommerceProductSyncRun` row. */
  createSyncRun(input: CreateSyncRunInput): Promise<{ id: string }>;
  /** Finalizes a run with its terminal status + counts. */
  finalizeSyncRun(runId: string, input: FinalizeSyncRunInput): Promise<void>;
  /** Applies one product's create/update/touch decision. */
  applyProductWrite(
    connectionId: string,
    brandId: string,
    provider: CommerceProvider,
    externalKey: string,
    decision: ProductWriteDecision,
  ): Promise<void>;
  /**
   * Marks every currently-available product for `connectionId` whose
   * `externalKey` is NOT in `seenExternalKeys` as unavailable (setting
   * `unavailableSince` to `now` and `lastSyncRunId` to `runId`). MUST only
   * ever be called after a full, successful fetch — see the file header.
   * MUST NOT re-stamp a row that is already `isAvailable: false` (the
   * default implementation's `where` clause enforces this by filtering on
   * `isAvailable: true`).
   */
  markUnavailableExcept(
    connectionId: string,
    seenExternalKeys: string[],
    now: Date,
    runId: string,
  ): Promise<{ count: number }>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

const EXISTING_PRODUCT_SELECT = {
  id: true,
  externalKey: true,
  title: true,
  handle: true,
  productUrl: true,
  imageUrl: true,
  images: true,
  externalVariantIds: true,
  descriptionText: true,
  sku: true,
  currencyCode: true,
  priceMinMinor: true,
  priceMaxMinor: true,
  priceMinorUnitExponent: true,
  isAvailable: true,
  hasPublicStorefrontUrl: true,
  unavailableSince: true,
  providerMetadata: true,
} as const;

async function defaultGetActiveConnection(
  brandId: string,
  provider: CommerceProvider,
): Promise<CommerceConnectionSummary | null> {
  return getActiveCommerceConnection(brandId, provider);
}

function defaultGetAdapter(
  summary: CommerceConnectionSummary,
): CommerceAdapter {
  return getAdapterForConnection(summary);
}

async function defaultFindExistingProducts(
  connectionId: string,
): Promise<ExistingConnectedProductRow[]> {
  const prisma = await getPrisma();
  return prisma.connectedCommerceProduct.findMany({
    where: { connectionId },
    select: EXISTING_PRODUCT_SELECT,
  });
}

async function defaultCreateSyncRun(
  input: CreateSyncRunInput,
): Promise<{ id: string }> {
  const prisma = await getPrisma();
  const run = await prisma.commerceProductSyncRun.create({
    data: {
      connectionId: input.connectionId,
      brandId: input.brandId,
      provider: input.provider,
      status: "RUNNING",
      triggeredBy: input.triggeredBy ?? undefined,
    },
    select: { id: true },
  });
  return { id: run.id };
}

async function defaultFinalizeSyncRun(
  runId: string,
  input: FinalizeSyncRunInput,
): Promise<void> {
  const prisma = await getPrisma();
  await prisma.commerceProductSyncRun.update({
    where: { id: runId },
    data: {
      status: input.status,
      finishedAt: input.finishedAt,
      fetchedCount: input.stats.fetchedCount,
      createdCount: input.stats.createdCount,
      updatedCount: input.stats.updatedCount,
      unchangedCount: input.stats.unchangedCount,
      markedUnavailableCount: input.stats.markedUnavailableCount,
      failedCount: input.stats.failedCount,
      hasNextPage: input.hasNextPage,
      requestedLimit: input.requestedLimit ?? undefined,
      failureSummary: input.failureSummary ?? undefined,
    },
  });
}

async function defaultApplyProductWrite(
  connectionId: string,
  brandId: string,
  provider: CommerceProvider,
  externalKey: string,
  decision: ProductWriteDecision,
): Promise<void> {
  const prisma = await getPrisma();

  if (decision.kind === "CREATE") {
    await prisma.connectedCommerceProduct.create({
      data: {
        connectionId,
        brandId,
        provider,
        externalKey,
        ...decision.data,
      },
    });
    return;
  }

  if (decision.kind === "UPDATE") {
    await prisma.connectedCommerceProduct.update({
      where: { id: decision.existingId },
      data: decision.data,
    });
    return;
  }

  await prisma.connectedCommerceProduct.update({
    where: { id: decision.existingId },
    data: {
      lastSeenAt: decision.lastSeenAt,
      lastSyncRunId: decision.lastSyncRunId,
    },
  });
}

async function defaultMarkUnavailableExcept(
  connectionId: string,
  seenExternalKeys: string[],
  now: Date,
  runId: string,
): Promise<{ count: number }> {
  const prisma = await getPrisma();
  const result = await prisma.connectedCommerceProduct.updateMany({
    where: {
      connectionId,
      isAvailable: true,
      externalKey: { notIn: seenExternalKeys },
    },
    data: {
      isAvailable: false,
      unavailableSince: now,
      lastSyncRunId: runId,
    },
  });
  return { count: result.count };
}

const DEFAULT_PRODUCT_SYNC_DEPS: ProductSyncDeps = {
  getActiveConnection: defaultGetActiveConnection,
  getAdapter: defaultGetAdapter,
  findExistingProducts: defaultFindExistingProducts,
  createSyncRun: defaultCreateSyncRun,
  finalizeSyncRun: defaultFinalizeSyncRun,
  applyProductWrite: defaultApplyProductWrite,
  markUnavailableExcept: defaultMarkUnavailableExcept,
};

function resolveDeps(deps: Partial<ProductSyncDeps>): ProductSyncDeps {
  return { ...DEFAULT_PRODUCT_SYNC_DEPS, ...deps };
}

// ---------------------------------------------------------------------------
// Pure helpers: money / currency
// ---------------------------------------------------------------------------

/** Provider-neutral "is this product currently sellable" predicate. Unset/missing status defaults to available; anything other than "ACTIVE" (case-insensitive) is treated as unavailable. */
function isStatusActive(status: string | null | undefined): boolean {
  if (status === null || status === undefined) {
    return true;
  }
  return status.trim().toUpperCase() === "ACTIVE";
}

type ComputedPrice = {
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
};

/**
 * Resolves currency + minor-unit prices from the canonical
 * `CommerceConnectionSummary.currencyCode`, NEVER from
 * `CommerceProduct.currency`. Returns every field `null` when
 * `brandCurrencyCode` is unknown — see the file header's MONEY / CURRENCY
 * section for why.
 */
function computePrice(
  product: CommerceProduct,
  brandCurrencyCode: string | null,
): ComputedPrice {
  const trimmed = brandCurrencyCode?.trim().toUpperCase();
  if (!trimmed) {
    return {
      currencyCode: null,
      priceMinMinor: null,
      priceMaxMinor: null,
      priceMinorUnitExponent: null,
    };
  }

  const exponent = getCurrencyExponent(trimmed).exponent;
  const rawMin = product.priceRangeRaw?.min ?? null;
  const rawMax = product.priceRangeRaw?.max ?? null;
  const minResult = providerPriceStringToMinorUnits(rawMin, trimmed);
  const maxResult = providerPriceStringToMinorUnits(rawMax, trimmed);

  return {
    currencyCode: trimmed,
    priceMinMinor: minResult.ok ? minResult.minorUnits : null,
    priceMaxMinor: maxResult.ok ? maxResult.minorUnits : null,
    priceMinorUnitExponent: exponent,
  };
}

/**
 * Whitelisted, sanitized `providerMetadata`. Only these five fields are ever
 * copied out of the neutral `CommerceProduct` — never the raw provider node,
 * never a token/header/URL. See the file header's providerMetadata section.
 */
function buildProviderMetadata(product: CommerceProduct): Prisma.JsonObject {
  const metadata: Prisma.JsonObject = {};
  if (product.status) {
    metadata.status = product.status;
  }
  if (product.priceText) {
    metadata.priceText = product.priceText;
  }
  if (product.providerCreatedAt) {
    metadata.providerCreatedAt = product.providerCreatedAt.toISOString();
  }
  if (product.providerUpdatedAt) {
    metadata.providerUpdatedAt = product.providerUpdatedAt.toISOString();
  }
  if (typeof product.hasProviderSuppliedStorefrontUrl === "boolean") {
    metadata.storefrontUrlSource = product.hasProviderSuppliedStorefrontUrl
      ? "PROVIDER"
      : "FALLBACK";
  }
  return metadata;
}

function jsonStringField(
  value: Prisma.JsonValue | null | undefined,
  key: string,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, Prisma.JsonValue>)[key];
  return typeof field === "string" ? field : null;
}

// ---------------------------------------------------------------------------
// Pure change detection / write decision
// ---------------------------------------------------------------------------

type ComputedProductFields = {
  externalKey: string;
  externalId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  externalVariantIds: string[];
  descriptionText: string | null;
  sku: string | null;
  isAvailable: boolean;
  hasPublicStorefrontUrl: boolean;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  providerMetadata: Prisma.JsonObject;
} & ComputedPrice;

function computeProductFields(
  product: CommerceProduct,
  brandCurrencyCode: string | null,
): ComputedProductFields {
  return {
    externalKey: product.externalId,
    externalId: product.externalId,
    title: product.title,
    handle: product.handle,
    productUrl: product.productUrl,
    imageUrl: product.imageUrl,
    images: product.images,
    externalVariantIds: product.externalVariantIds,
    descriptionText: product.descriptionText ?? null,
    sku: product.sku ?? null,
    isAvailable: isStatusActive(product.status),
    // Fail-closed: an adapter that does not report complete storefront
    // publication evidence is treated as "not publicly usable". Never
    // derived from `status` / `isAvailable`, or a possibly fabricated URL.
    hasPublicStorefrontUrl: product.hasProviderStorefrontPublication === true,
    providerCreatedAt: product.providerCreatedAt ?? null,
    providerUpdatedAt: product.providerUpdatedAt ?? null,
    providerMetadata: buildProviderMetadata(product),
    ...computePrice(product, brandCurrencyCode),
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

/** True when any field that counts as "changed" per the module's contract differs. Does NOT include availability — see `decideProductWrite`. */
function contentChanged(
  existing: ExistingConnectedProductRow,
  computed: ComputedProductFields,
): boolean {
  return (
    existing.title !== computed.title ||
    existing.handle !== computed.handle ||
    existing.productUrl !== computed.productUrl ||
    existing.imageUrl !== computed.imageUrl ||
    !arraysEqual(existing.images, computed.images) ||
    !arraysEqual(existing.externalVariantIds, computed.externalVariantIds) ||
    existing.descriptionText !== computed.descriptionText ||
    existing.sku !== computed.sku ||
    existing.currencyCode !== computed.currencyCode ||
    existing.priceMinMinor !== computed.priceMinMinor ||
    existing.priceMaxMinor !== computed.priceMaxMinor ||
    existing.priceMinorUnitExponent !== computed.priceMinorUnitExponent ||
    existing.hasPublicStorefrontUrl !== computed.hasPublicStorefrontUrl ||
    jsonStringField(existing.providerMetadata, "status") !==
      jsonStringField(computed.providerMetadata, "status") ||
    jsonStringField(existing.providerMetadata, "storefrontUrlSource") !==
      jsonStringField(computed.providerMetadata, "storefrontUrlSource")
  );
}

function toWriteData(
  computed: ComputedProductFields,
  now: Date,
  runId: string,
  previousUnavailableSince: Date | null,
): ConnectedProductWriteData {
  const unavailableSince = computed.isAvailable
    ? null
    : (previousUnavailableSince ?? now);

  return {
    externalId: computed.externalId,
    title: computed.title,
    handle: computed.handle,
    productUrl: computed.productUrl,
    imageUrl: computed.imageUrl,
    images: computed.images,
    externalVariantIds: computed.externalVariantIds,
    descriptionText: computed.descriptionText,
    sku: computed.sku,
    currencyCode: computed.currencyCode,
    priceMinMinor: computed.priceMinMinor,
    priceMaxMinor: computed.priceMaxMinor,
    priceMinorUnitExponent: computed.priceMinorUnitExponent,
    isAvailable: computed.isAvailable,
    hasPublicStorefrontUrl: computed.hasPublicStorefrontUrl,
    unavailableSince,
    providerCreatedAt: computed.providerCreatedAt,
    providerUpdatedAt: computed.providerUpdatedAt,
    providerMetadata: computed.providerMetadata,
    lastSeenAt: now,
    lastSyncRunId: runId,
  };
}

/**
 * Pure decision function — no I/O. Compares a fetched product's computed
 * fields against the existing row (if any). Availability is handled
 * separately from `contentChanged`: a product whose content is byte-identical
 * but that is transitioning available<->unavailable (e.g. reappearing after
 * a prior absence, or newly reporting a non-ACTIVE status) still counts as a
 * write (UPDATE), never silently absorbed into TOUCH.
 */
export function decideProductWrite(
  existing: ExistingConnectedProductRow | null,
  computed: ComputedProductFields,
  now: Date,
  runId: string,
): ProductWriteDecision {
  if (!existing) {
    return { kind: "CREATE", data: toWriteData(computed, now, runId, null) };
  }

  const fieldsChanged = contentChanged(existing, computed);
  const availabilityChanged = existing.isAvailable !== computed.isAvailable;

  if (!fieldsChanged && !availabilityChanged) {
    return {
      kind: "TOUCH",
      existingId: existing.id,
      lastSeenAt: now,
      lastSyncRunId: runId,
    };
  }

  return {
    kind: "UPDATE",
    existingId: existing.id,
    data: toWriteData(computed, now, runId, existing.unavailableSince),
  };
}

// ---------------------------------------------------------------------------
// Failure classification (bounded, sanitized — never an error object/body/URL)
// ---------------------------------------------------------------------------

const MAX_FAILURE_MESSAGE_LENGTH = 300;

function classifySyncFailure(error: unknown): { tag: string; message: string } {
  if (error instanceof CommerceProviderApiError) {
    return {
      tag: "PROVIDER_API_ERROR",
      message: error.message.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
    };
  }
  if (error instanceof Error) {
    return {
      tag: "UNKNOWN_ERROR",
      message: error.message.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
    };
  }
  return {
    tag: "UNKNOWN_ERROR",
    message: "Non-Error value thrown during product sync.",
  };
}

function formatFailureSummary(tag: string, message: string): string {
  return `${tag}: ${message}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type SyncBrandCommerceProductsOptions = {
  /** Free-text provenance tag stored on `CommerceProductSyncRun.triggeredBy` (e.g. "cron", "manual", "webhook"). */
  triggeredBy?: string;
  /** Provider-neutral page size. Defaults to Shopify's established 100-item page size. */
  pageSize?: number;
  /** Bounded safety guard for a synchronous catalog request. */
  maxPages?: number;
  /** Bounded safety guard for total provider rows observed, before deduplication. */
  maxProducts?: number;
  /** Bounded elapsed-time guard for the complete logical sync. */
  maxDurationMs?: number;
  /** Injectable clock for deterministic unit tests. */
  now?: () => number;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_PRODUCTS = 10_000;
const DEFAULT_MAX_DURATION_MS = 45_000;

type CollectedCatalog = {
  products: CommerceProduct[];
  hasNextPage: boolean;
  requestedLimit: number | null;
  failureSummary: string | null;
  providerFailed: boolean;
};

function positiveBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), maximum);
}

function pageFailureSummary(tag: string, message: string): string {
  return formatFailureSummary(
    tag,
    message.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
  );
}

/**
 * Fetches the whole logical catalog through the optional neutral page method.
 * Older adapters retain their established single-call behavior; they simply
 * report `hasNextPage` and are therefore never mistaken for a complete sync.
 */
async function collectCatalog(
  adapter: CommerceAdapter,
  connectionId: string,
  options: SyncBrandCommerceProductsOptions,
): Promise<CollectedCatalog> {
  if (!adapter.fetchProductPage) {
    const result = await adapter.syncProducts(connectionId);
    return {
      products: result.products,
      hasNextPage: result.hasNextPage,
      requestedLimit: result.limit,
      failureSummary: result.hasNextPage
        ? pageFailureSummary(
            "TRUNCATED_PAGINATION",
            "Adapter returned an incomplete catalog.",
          )
        : null,
      providerFailed: false,
    };
  }

  const pageSize = positiveBound(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
  );
  const maxPages = positiveBound(options.maxPages, DEFAULT_MAX_PAGES, 10_000);
  const maxProducts = positiveBound(
    options.maxProducts,
    DEFAULT_MAX_PRODUCTS,
    1_000_000,
  );
  const maxDurationMs = positiveBound(
    options.maxDurationMs,
    DEFAULT_MAX_DURATION_MS,
    10 * 60_000,
  );
  const now = options.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxDurationMs);
  const observed: CommerceProduct[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pagesFetched = 0;

  try {
    // Some providers must obtain one complete, catalog-wide fact before the
    // first row can be safely persisted (for example, Shopify's Online Store
    // publication set). Keep that state opaque and provider-owned. If it is
    // incomplete or fails, do not write a catalog page with false/unknown
    // evidence over previously trusted facts.
    let syncContext: unknown;
    try {
      syncContext = await adapter.prepareProductSync?.(connectionId, {
        limit: pageSize,
        maxPages,
        maxProducts,
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut =
        controller.signal.aborted || now() - startedAt >= maxDurationMs;
      const classified = classifySyncFailure(error);
      return {
        products: [],
        hasNextPage: true,
        requestedLimit: pageSize,
        failureSummary: timedOut
          ? pageFailureSummary(
              "PAGINATION_TIMEOUT",
              "Elapsed-time guard reached before publication preparation completed.",
            )
          : pageFailureSummary(
              "PROVIDER_PREPARATION_FAILURE",
              classified.message,
            ),
        providerFailed: !timedOut,
      };
    }

    while (true) {
      if (now() - startedAt >= maxDurationMs) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "PAGINATION_TIMEOUT",
            "Elapsed-time guard reached before catalog completion.",
          ),
          providerFailed: false,
        };
      }

      let page;
      try {
        page = await adapter.fetchProductPage(connectionId, {
          cursor,
          limit: pageSize,
          signal: controller.signal,
          syncContext,
        });
      } catch (error) {
        const timedOut =
          controller.signal.aborted || now() - startedAt >= maxDurationMs;
        const classified = classifySyncFailure(error);
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: timedOut
            ? pageFailureSummary(
                "PAGINATION_TIMEOUT",
                "Elapsed-time guard reached before catalog completion.",
              )
            : pageFailureSummary("PROVIDER_PAGE_FAILURE", classified.message),
          providerFailed: !timedOut,
        };
      }

      pagesFetched += 1;
      if (
        !Array.isArray(page.products) ||
        typeof page.isComplete !== "boolean"
      ) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "INVALID_PAGE",
            "Provider returned an invalid product page.",
          ),
          providerFailed: false,
        };
      }

      for (const product of page.products) {
        if (
          !product ||
          typeof product.externalId !== "string" ||
          !product.externalId.trim()
        ) {
          return {
            products: deduplicateCatalogProducts(observed),
            hasNextPage: true,
            requestedLimit: pageSize,
            failureSummary: pageFailureSummary(
              "INVALID_PAGE",
              "Provider returned a product without an external key.",
            ),
            providerFailed: false,
          };
        }
        observed.push(product);
      }

      if (observed.length > maxProducts) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "MAX_PRODUCTS_REACHED",
            "Maximum product guard reached before catalog completion.",
          ),
          providerFailed: false,
        };
      }

      const nextCursor = page.nextCursor;
      if (page.isComplete) {
        if (nextCursor !== null) {
          return {
            products: deduplicateCatalogProducts(observed),
            hasNextPage: true,
            requestedLimit: pageSize,
            failureSummary: pageFailureSummary(
              "INVALID_PAGE",
              "Complete page returned a next cursor.",
            ),
            providerFailed: false,
          };
        }
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: false,
          requestedLimit: page.limit,
          failureSummary: null,
          providerFailed: false,
        };
      }

      if (typeof nextCursor !== "string" || !nextCursor.trim()) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "MISSING_CURSOR",
            "Incomplete page did not return a usable next cursor.",
          ),
          providerFailed: false,
        };
      }

      if (seenCursors.has(nextCursor)) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "CURSOR_LOOP",
            "Provider returned a repeated catalog cursor.",
          ),
          providerFailed: false,
        };
      }

      if (pagesFetched >= maxPages) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "MAX_PAGES_REACHED",
            "Maximum page guard reached before catalog completion.",
          ),
          providerFailed: false,
        };
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Later pages win for an overlapping external key; first-seen key order remains stable. */
function deduplicateCatalogProducts(
  products: CommerceProduct[],
): CommerceProduct[] {
  const byExternalKey = new Map<string, CommerceProduct>();
  for (const product of products) {
    byExternalKey.set(product.externalId, product);
  }
  return [...byExternalKey.values()];
}

/**
 * Syncs `brandId`'s catalog for `provider` (default SHOPIFY) into
 * `ConnectedCommerceProduct`. See the file header for the full behavior
 * contract (skip semantics, full/partial/failed determination, money rules,
 * providerMetadata whitelist).
 *
 * Throws `UnsupportedProviderError` (from `deps.getAdapter`) for a provider
 * with no registered adapter, and `UnsupportedCapabilityError` for a
 * registered adapter that does not support product sync — both BEFORE any
 * `CommerceProductSyncRun` row is created and before any network call, so a
 * caller's error handling for "provider not supported" never has to
 * distinguish "did this write a run row" from "did it not".
 */
export async function syncBrandCommerceProducts(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  options: SyncBrandCommerceProductsOptions = {},
  deps: Partial<ProductSyncDeps> = {},
): Promise<ProductSyncOutcome> {
  const resolvedDeps = resolveDeps(deps);

  const summary = await resolvedDeps.getActiveConnection(brandId, provider);

  if (!summary) {
    return { status: "SKIPPED", reason: "NO_CONNECTION", brandId, provider };
  }

  // PHASE 16C2: the canonical product-sync lifecycle invariant applies here
  // too, not only to the exact-connection-id entry point below. The
  // "preferred" resolver does not itself filter by status, so this boundary
  // must — never silently select a different connection, never auto-heal.
  // A non-CONNECTED preferred row is reported as an ordinary SKIPPED outcome
  // (not a thrown error) so the legacy no-body caller keeps its existing
  // SKIPPED-outcome contract unchanged.
  if (summary.status !== "CONNECTED") {
    return { status: "SKIPPED", reason: "NOT_CONNECTED", brandId, provider };
  }

  const connectionId = summary.id;

  // Resolved BEFORE creating a run row and before any network call — throws
  // UnsupportedProviderError / UnsupportedCapabilityError propagate straight
  // to the caller with nothing written.
  const adapter = resolvedDeps.getAdapter(summary);
  const capabilities = adapter.getCapabilities();
  if (!capabilities.products.sync) {
    throw new UnsupportedCapabilityError(provider, "products.sync");
  }

  return runProductSync(
    brandId,
    provider,
    connectionId,
    summary.currencyCode,
    adapter,
    options,
    resolvedDeps,
  );
}

export type SyncCommerceConnectionByIdInput = {
  brandId: string;
  provider: CommerceProvider;
  connectionId: string;
};

/**
 * PHASE 16C2: syncs an EXACT `CommerceConnection.id` rather than the brand's
 * "preferred" connection for a provider. Exists so a provider-neutral UI that
 * lets a Brand Admin pick a specific connection (relevant once a brand can
 * hold more than one connection for the same provider) can never have that
 * selection silently resolve to a different account.
 *
 * Verifies, BEFORE any adapter/provider I/O and BEFORE any
 * `CommerceProductSyncRun` row is created:
 *   1. the connection exists;
 *   2. it belongs to `input.brandId` — a mismatch throws the SAME
 *      `CommerceConnectionNotFoundError` as a genuinely missing id, so a
 *      caller can never learn that a connectionId exists under a different
 *      brand;
 *   3. its provider matches `input.provider` exactly — a mismatch throws
 *      `CommerceConnectionMismatchError` (a caller/UI bug, safe to name);
 *   4. its `status` is `CONNECTED` — a mismatch throws
 *      `CommerceConnectionNotReadyError`. This is the canonical product-sync
 *      lifecycle invariant: `UNINSTALLED` / `DISCONNECTED` /
 *      `REQUIRES_RECONNECT` must never reach account-specific provider
 *      transport, even though the connection is genuinely this brand's own
 *      and genuinely the right provider. Never silently falls back to a
 *      different connection or auto-reconnects — the caller must fix the
 *      connection first.
 *   5. the resolved adapter actually supports `products.sync`.
 *
 * Reuses `runProductSync` — the exact same persistence engine
 * `syncBrandCommerceProducts` uses — so there is no second, divergent catalog
 * write path.
 */
export async function syncCommerceConnectionById(
  input: SyncCommerceConnectionByIdInput,
  options: SyncBrandCommerceProductsOptions = {},
  deps: Partial<ProductSyncDeps> & {
    getConnectionById?(connectionId: string): Promise<CommerceConnectionSummary | null>;
  } = {},
): Promise<ProductSyncOutcome> {
  const { getConnectionById = defaultGetConnectionById, ...persistenceOverrides } = deps;
  const resolvedDeps = resolveDeps(persistenceOverrides);

  const summary = await getConnectionById(input.connectionId);

  if (!summary || summary.brandId !== input.brandId) {
    throw new CommerceConnectionNotFoundError(input.connectionId);
  }

  if (summary.provider !== input.provider) {
    throw new CommerceConnectionMismatchError(
      input.connectionId,
      input.provider,
      summary.provider,
    );
  }

  if (summary.status !== "CONNECTED") {
    throw new CommerceConnectionNotReadyError(
      summary.id,
      summary.provider,
      summary.status,
    );
  }

  // Same ordering guarantee as syncBrandCommerceProducts: resolved BEFORE any
  // run row or network call.
  const adapter = resolvedDeps.getAdapter(summary);
  const capabilities = adapter.getCapabilities();
  if (!capabilities.products.sync) {
    throw new UnsupportedCapabilityError(input.provider, "products.sync");
  }

  return runProductSync(
    input.brandId,
    input.provider,
    summary.id,
    summary.currencyCode,
    adapter,
    options,
    resolvedDeps,
  );
}

async function defaultGetConnectionById(
  connectionId: string,
): Promise<CommerceConnectionSummary | null> {
  return getCommerceConnectionById(connectionId);
}

async function runProductSync(
  brandId: string,
  provider: CommerceProvider,
  connectionId: string,
  currencyCode: string | null,
  adapter: CommerceAdapter,
  options: SyncBrandCommerceProductsOptions,
  deps: ProductSyncDeps,
): Promise<ProductSyncOutcome> {
  const run = await deps.createSyncRun({
    connectionId,
    brandId,
    provider,
    triggeredBy: options.triggeredBy ?? null,
  });

  let catalog: CollectedCatalog;
  try {
    catalog = await collectCatalog(adapter, connectionId, options);
  } catch (error) {
    const { tag, message } = classifySyncFailure(error);
    const stats = zeroStats();
    stats.failedCount = 1;
    const failureSummary = formatFailureSummary(tag, message);

    await deps.finalizeSyncRun(run.id, {
      status: "FAILED",
      finishedAt: new Date(),
      stats,
      hasNextPage: false,
      requestedLimit: null,
      failureSummary,
    });

    return {
      status: "FAILED",
      brandId,
      provider,
      connectionId,
      runId: run.id,
      stats,
      hasNextPage: false,
      failureSummary,
    };
  }

  const now = new Date();
  const stats = zeroStats();
  const seenExternalKeys: string[] = [];

  // Pessimistic defaults: if anything below throws before these are
  // overwritten by the normal-completion logic further down, the run still
  // finalizes as FAILED (never RUNNING) via the `finally` block — see the
  // file header's MARK-UNAVAILABLE GUARD section and M2 in the Phase 3
  // review this block closes.
  let finalStatus: "SUCCEEDED" | "PARTIAL" | "FAILED" = "FAILED";
  let failureSummary: string | null = null;
  const hasNextPage = catalog.hasNextPage;
  const requestedLimit: number | null = catalog.requestedLimit;

  try {
    const existingRows = await deps.findExistingProducts(connectionId);
    const existingByKey = new Map(
      existingRows.map((row) => [row.externalKey, row]),
    );

    for (const product of catalog.products) {
      const computed = computeProductFields(product, currencyCode);
      const existing = existingByKey.get(computed.externalKey) ?? null;
      const decision = decideProductWrite(existing, computed, now, run.id);

      // A single row's write failure (e.g. M1's int4 overflow surviving
      // some other way, a unique-constraint race with a concurrent run, a
      // transient connection reset) must never abort the whole run and
      // strand it RUNNING — see M2 in the Phase 3 review. Every OTHER
      // product must still get its chance.
      try {
        await deps.applyProductWrite(
          connectionId,
          brandId,
          provider,
          computed.externalKey,
          decision,
        );
      } catch {
        stats.failedCount += 1;
        continue;
      }

      seenExternalKeys.push(computed.externalKey);
      stats.fetchedCount += 1;
      if (decision.kind === "CREATE") {
        stats.createdCount += 1;
      } else if (decision.kind === "UPDATE") {
        stats.updatedCount += 1;
      } else {
        stats.unchangedCount += 1;
      }
    }

    // TRUNCATED/PARTIAL: pagination did not exhaust the catalog. A run with
    // any per-product write failures is also never a clean SUCCEEDED, even
    // when pagination itself completed — see M2 in the Phase 3 review.
    // Products actually written (above) are still persisted either way; the
    // mark-unavailable step below is the ONLY thing this status gates, and
    // it is called from exactly this one place, inside
    // `if (finalStatus === "SUCCEEDED")` — see the file header.
    const isTruncated = catalog.hasNextPage;
    if (catalog.providerFailed) {
      stats.failedCount += 1;
    }
    const hadWriteFailures = stats.failedCount > 0;
    const succeededCount =
      stats.createdCount + stats.updatedCount + stats.unchangedCount;

    if ((catalog.providerFailed || isTruncated) && succeededCount === 0) {
      finalStatus = "FAILED";
    } else if (isTruncated || hadWriteFailures) {
      finalStatus = "PARTIAL";
    } else {
      finalStatus = "SUCCEEDED";
    }

    if (finalStatus === "SUCCEEDED") {
      const unavailableResult = await deps.markUnavailableExcept(
        connectionId,
        seenExternalKeys,
        now,
        run.id,
      );
      stats.markedUnavailableCount = unavailableResult.count;
      // The connection must advertise completion only after absence
      // reconciliation succeeds as well; otherwise its timestamp would
      // falsely describe a partial catalog as complete.
      await adapter.completeProductSync?.(connectionId, now);
    } else {
      const reasons: string[] = catalog.failureSummary
        ? [catalog.failureSummary]
        : [];
      if (isTruncated && reasons.length === 0) {
        reasons.push(
          "pagination did not reach the end of the catalog (hasNextPage=true)",
        );
      }
      if (hadWriteFailures) {
        reasons.push(`${stats.failedCount} product write(s) failed`);
      }
      failureSummary =
        catalog.failureSummary ??
        formatFailureSummary(
          hadWriteFailures ? "PARTIAL_WRITE_FAILURE" : "TRUNCATED_PAGINATION",
          `${reasons.join("; ")}; no product was marked unavailable this run.`,
        );
      if (hadWriteFailures && catalog.failureSummary) {
        failureSummary = formatFailureSummary(
          "PARTIAL_WRITE_FAILURE",
          `${catalog.failureSummary}; ${stats.failedCount} product write(s) or provider page(s) failed; no product was marked unavailable this run.`,
        );
      }
    }
  } catch (error) {
    // An unexpected throw anywhere above (currency lookup, existing-row
    // fetch, or the mark-unavailable step itself) must still finalize the
    // run rather than leave it RUNNING — see M2. Only sanitized,
    // classified detail is recorded; never a raw error object, response
    // body, URL, or credential (same convention as the adapter-throw catch
    // above).
    const { tag, message } = classifySyncFailure(error);
    failureSummary = formatFailureSummary(tag, message);
    const succeededCount =
      stats.createdCount + stats.updatedCount + stats.unchangedCount;
    finalStatus = succeededCount > 0 ? "PARTIAL" : "FAILED";
  } finally {
    // Reached on EVERY exit path out of the try block above — normal
    // completion, a per-product write failure loop that ran to the end, or
    // an unexpected throw caught just above. A `CommerceProductSyncRun` row
    // must never be left `RUNNING`.
    await deps.finalizeSyncRun(run.id, {
      status: finalStatus,
      finishedAt: new Date(),
      stats,
      hasNextPage,
      requestedLimit,
      failureSummary,
    });
  }

  return {
    status: finalStatus,
    brandId,
    provider,
    connectionId,
    runId: run.id,
    stats,
    hasNextPage,
    failureSummary,
  };
}
