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
 * LEGACY-FALLBACK BRANDS NEVER GET A SILENT EMPTY SUCCESS
 * ---------------------------------------------------------------------------
 * `getActiveCommerceConnection` (`./connection-service.ts`) can return a
 * summary with `id: null` — a brand whose Shopify state lives only on the
 * legacy `Brand.shopify*` columns, with no `CommerceConnection` row yet (see
 * that module's header). `CommerceProductSyncRun.connectionId` is a required
 * FK to a real `CommerceConnection` row, so there is nothing to attach a run
 * to for such a brand — and more importantly, silently treating it as "zero
 * products, sync succeeded" would be actively wrong: the brand almost
 * certainly HAS a real catalog, we just have no connection row to sync it
 * against yet. `syncBrandCommerceProducts` returns an explicit
 * `{ status: "SKIPPED", reason: "LEGACY_FALLBACK" }` outcome for this case
 * (and `{ status: "SKIPPED", reason: "NO_CONNECTION" }` when the brand has no
 * connection at all) — never a `SUCCEEDED` outcome with an empty product
 * list, and it never writes anything.
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
 *   - The adapter call THROWS               -> run status FAILED. No
 *     products were even fetched (the adapter's `syncProducts` is a single
 *     all-or-nothing call — see `./providers/shopify-commerce-adapter.ts`),
 *     so nothing is upserted and the mark-unavailable step never runs. The
 *     existing catalog is untouched, byte for byte.
 *   - The adapter call SUCCEEDS but `result.hasNextPage` is `true` -> run
 *     status PARTIAL. This means pagination did NOT exhaust the catalog (the
 *     adapter only fetched one page — see `ShopifyCommerceAdapter.syncProducts`
 *     in `./providers/shopify-commerce-adapter.ts`, which does not loop). The
 *     products that WERE returned are still upserted (they are real,
 *     current data), but the mark-unavailable step is skipped — a product
 *     that exists on a page we didn't reach must never be marked unavailable
 *     just because this run didn't see it.
 *   - The adapter call SUCCEEDS and `result.hasNextPage` is `false` -> run
 *     status SUCCEEDED. Only now does the mark-unavailable step run, scoped
 *     to `connectionId` and excluding every `externalKey` this run saw.
 *
 * The guard itself lives in `runProductSync` below, directly on the branch
 * that decides `finalStatus`: `markUnavailableExcept` is called from exactly
 * one place, inside `if (finalStatus === "SUCCEEDED")`.
 *
 * ---------------------------------------------------------------------------
 * MONEY / CURRENCY
 * ---------------------------------------------------------------------------
 * `CommerceProduct.currency` (from `./types.ts`) is NEVER read here — for
 * Shopify it is a hardcoded `"USD"` default unless a caller explicitly
 * supplies `options.currency` to `fetchNormalizedShopifyProducts`, which
 * nothing in this codebase does (see that file's own warning comment).
 * Instead, currency comes from `Brand.shopifyCurrencyCode`
 * (`deps.getBrandCurrencyCode`), fetched once per sync (not once per
 * product). When that is `null`/unknown, EVERY product for this brand gets
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
 * `buildProviderMetadata` whitelists exactly four benign, non-credential
 * fields from the neutral `CommerceProduct` — `status`, `priceText`,
 * `providerCreatedAt` (ISO string), `providerUpdatedAt` (ISO string) — and
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
 * `CommerceConnection.lastProductSyncAt` itself — the Shopify adapter's
 * `syncProducts` already stamps that via its own `markProductSync` dep (see
 * `./providers/shopify-commerce-adapter.ts`), so writing it again here would
 * be a double-write of the same field from two different modules; this file
 * only touches `ConnectedCommerceProduct` / `CommerceProductSyncRun`.
 */

import { CommerceProvider, type Prisma } from "@prisma/client";
import type { CommerceAdapter } from "./adapter";
import { CommerceProviderApiError, UnsupportedCapabilityError } from "./errors";
import { getCurrencyExponent, providerPriceStringToMinorUnits } from "./money";
import type { CommerceConnectionSummary, CommerceProduct } from "./types";
import { getActiveCommerceConnection, getAdapterForConnection } from "./connection-service";

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
  /** The brand's connection is legacy-fallback-derived (`summary.id === null`) — no real `CommerceConnection` row to attach a sync run to. */
  | "LEGACY_FALLBACK";

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
  | { kind: "TOUCH"; existingId: string; lastSeenAt: Date; lastSyncRunId: string };

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
  /** Resolves the adapter for `provider`. Throws `UnsupportedProviderError` for an unregistered provider (COMMERCE7 today). Never itself makes a network call. */
  getAdapter(summary: CommerceConnectionSummary): CommerceAdapter;
  /** Reads `Brand.shopifyCurrencyCode` (or the provider-neutral equivalent), `null` if unknown. */
  getBrandCurrencyCode(brandId: string): Promise<string | null>;
  /** Loads every existing `ConnectedCommerceProduct` row for this connection, keyed for change detection. */
  findExistingProducts(connectionId: string): Promise<ExistingConnectedProductRow[]>;
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
  unavailableSince: true,
  providerMetadata: true,
} as const;

async function defaultGetActiveConnection(
  brandId: string,
  provider: CommerceProvider,
): Promise<CommerceConnectionSummary | null> {
  return getActiveCommerceConnection(brandId, provider);
}

function defaultGetAdapter(summary: CommerceConnectionSummary): CommerceAdapter {
  return getAdapterForConnection(summary);
}

async function defaultGetBrandCurrencyCode(brandId: string): Promise<string | null> {
  const prisma = await getPrisma();
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { shopifyCurrencyCode: true },
  });
  return brand?.shopifyCurrencyCode ?? null;
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

async function defaultCreateSyncRun(input: CreateSyncRunInput): Promise<{ id: string }> {
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
  getBrandCurrencyCode: defaultGetBrandCurrencyCode,
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
 * Resolves currency + minor-unit prices from `Brand.shopifyCurrencyCode`,
 * NEVER from `CommerceProduct.currency`. Returns every field `null` when
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
 * Whitelisted, sanitized `providerMetadata`. Only these four fields are ever
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
  return metadata;
}

function jsonStringField(value: Prisma.JsonValue | null | undefined, key: string): string | null {
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
    jsonStringField(existing.providerMetadata, "status") !==
      jsonStringField(computed.providerMetadata, "status")
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
    return { kind: "TOUCH", existingId: existing.id, lastSeenAt: now, lastSyncRunId: runId };
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
  return { tag: "UNKNOWN_ERROR", message: "Non-Error value thrown during product sync." };
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
};

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

  if (summary.id === null) {
    // Legacy-fallback brand — see the file header. Never a silent empty
    // success: this is reported distinctly so a caller (or a later
    // reconciliation/backfill tool) can tell "nothing to sync" apart from
    // "we don't yet have a row to sync against".
    return { status: "SKIPPED", reason: "LEGACY_FALLBACK", brandId, provider };
  }

  const connectionId = summary.id;

  // Resolved BEFORE creating a run row and before any network call — throws
  // UnsupportedProviderError / UnsupportedCapabilityError propagate straight
  // to the caller with nothing written.
  const adapter = resolvedDeps.getAdapter(summary);
  const capabilities = adapter.getCapabilities();
  if (!capabilities.canSyncProducts) {
    throw new UnsupportedCapabilityError(provider, "canSyncProducts");
  }

  return runProductSync(brandId, provider, connectionId, adapter, options, resolvedDeps);
}

async function runProductSync(
  brandId: string,
  provider: CommerceProvider,
  connectionId: string,
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

  let syncResult: Awaited<ReturnType<CommerceAdapter["syncProducts"]>>;
  try {
    syncResult = await adapter.syncProducts(connectionId);
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
  const hasNextPage = syncResult.hasNextPage;
  const requestedLimit: number | null = syncResult.limit;

  try {
    const brandCurrencyCode = await deps.getBrandCurrencyCode(brandId);
    const existingRows = await deps.findExistingProducts(connectionId);
    const existingByKey = new Map(existingRows.map((row) => [row.externalKey, row]));

    for (const product of syncResult.products) {
      const computed = computeProductFields(product, brandCurrencyCode);
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
    const isTruncated = syncResult.hasNextPage;
    const hadWriteFailures = stats.failedCount > 0;
    const succeededCount = stats.createdCount + stats.updatedCount + stats.unchangedCount;

    if (hadWriteFailures && succeededCount === 0) {
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
    } else {
      const reasons: string[] = [];
      if (isTruncated) {
        reasons.push("pagination did not reach the end of the catalog (hasNextPage=true)");
      }
      if (hadWriteFailures) {
        reasons.push(`${stats.failedCount} product write(s) failed`);
      }
      failureSummary = formatFailureSummary(
        hadWriteFailures ? "PARTIAL_WRITE_FAILURE" : "TRUNCATED_PAGINATION",
        `${reasons.join("; ")}; no product was marked unavailable this run.`,
      );
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
    const succeededCount = stats.createdCount + stats.updatedCount + stats.unchangedCount;
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
