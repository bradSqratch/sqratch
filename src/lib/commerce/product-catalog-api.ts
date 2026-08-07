/**
 * src/lib/commerce/product-catalog-api.ts
 *
 * Pure, DB-free helpers backing `src/app/api/brand/products/**` (Workstream
 * 4). Kept separate from `./product-sync.ts` (which this file never
 * imports from or modifies) — this module only supports the read/selection
 * HTTP surface, never the sync/persistence pipeline itself.
 *
 * Nothing here performs I/O. Every function is pure and unit-testable
 * without a database or network connection.
 */

import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Keyset pagination — product list (orderBy [{title:"asc"},{id:"asc"}])
// ---------------------------------------------------------------------------

export type ProductListCursor = { title: string; id: string };

/**
 * Encodes a `(title, id)` keyset cursor as an opaque base64 string. Never
 * exposes raw row internals beyond the two sort keys the client already
 * received in the previous page's last item.
 */
export function encodeProductCursor(cursor: ProductListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decodes a cursor produced by `encodeProductCursor`. Returns `null` for any
 * malformed, tampered, or non-conforming input — callers must treat a `null`
 * decode as "ignore the cursor" (start from the first page), never as an
 * error, since a stale/garbage cursor is not attacker-exploitable (it only
 * narrows the WHERE clause, still scoped to the brand).
 */
export function decodeProductCursor(raw: string | null): ProductListCursor | null {
  if (!raw) {
    return null;
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).title === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      return { title: (parsed as ProductListCursor).title, id: (parsed as ProductListCursor).id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Builds the Prisma keyset predicate for "strictly after this (title, id)"
 * under `orderBy: [{title:"asc"},{id:"asc"}]`: `title > cursor.title` OR
 * (`title === cursor.title` AND `id > cursor.id`).
 */
export function buildProductCursorWhere(
  cursor: ProductListCursor,
): Prisma.ConnectedCommerceProductWhereInput {
  return {
    OR: [
      { title: { gt: cursor.title } },
      { AND: [{ title: cursor.title }, { id: { gt: cursor.id } }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Keyset pagination — sync run list (orderBy [{startedAt:"desc"},{id:"desc"}])
// ---------------------------------------------------------------------------

export type SyncRunListCursor = { startedAt: string; id: string };

export function encodeSyncRunCursor(cursor: SyncRunListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSyncRunCursor(raw: string | null): SyncRunListCursor | null {
  if (!raw) {
    return null;
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).startedAt === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      const startedAt = (parsed as SyncRunListCursor).startedAt;
      // `new Date("garbage")` does not throw — it silently produces an
      // Invalid Date, which `buildSyncRunCursorWhere` would otherwise pass
      // straight to Prisma and turn into a generic 500. A tampered/garbage
      // `startedAt` must be treated exactly like any other malformed cursor
      // here: ignored, not surfaced as a decode success. The PRODUCT cursor
      // path above has no equivalent risk (`title` is a plain string
      // compared as a string), so it needs no matching check.
      if (Number.isNaN(new Date(startedAt).getTime())) {
        return null;
      }
      return {
        startedAt,
        id: (parsed as SyncRunListCursor).id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Builds the Prisma keyset predicate for "strictly before this
 * (startedAt, id)" under `orderBy: [{startedAt:"desc"},{id:"desc"}]`:
 * `startedAt < cursor.startedAt` OR (`startedAt === cursor.startedAt` AND
 * `id < cursor.id`).
 */
export function buildSyncRunCursorWhere(
  cursor: SyncRunListCursor,
): Prisma.CommerceProductSyncRunWhereInput {
  const startedAt = new Date(cursor.startedAt);
  return {
    OR: [
      { startedAt: { lt: startedAt } },
      { AND: [{ startedAt }, { id: { lt: cursor.id } }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pagination bounds
// ---------------------------------------------------------------------------

export const DEFAULT_PRODUCT_LIST_LIMIT = 50;
export const MAX_PRODUCT_LIST_LIMIT = 100;
export const DEFAULT_SYNC_RUN_LIST_LIMIT = 20;
export const MAX_SYNC_RUN_LIST_LIMIT = 50;

/** Clamps a client-supplied limit into `[1, max]`, defaulting to `fallback` for anything missing/malformed. */
export function clampLimit(raw: string | null, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

// ---------------------------------------------------------------------------
// Safe field extraction — providerMetadata is NEVER serialized as-is
// ---------------------------------------------------------------------------

/**
 * Extracts ONLY the whitelisted `status` string out of a
 * `ConnectedCommerceProduct.providerMetadata` JSON blob (written by
 * `./product-sync.ts`'s `buildProviderMetadata`, which itself whitelists
 * exactly four benign fields). This is the ONLY field of that JSON blob
 * ever surfaced to a client — the raw blob itself must never appear in a
 * response body.
 */
export function extractProviderStatus(value: Prisma.JsonValue | null | undefined): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const status = (value as Record<string, Prisma.JsonValue>).status;
  return typeof status === "string" ? status : null;
}

// ---------------------------------------------------------------------------
// List query filters
// ---------------------------------------------------------------------------

export type AvailabilityFilter = "all" | "available" | "unavailable";
export type SelectionFilter = "all" | "visible" | "eligible" | "unselected";

export function normalizeAvailabilityFilter(raw: string | null): AvailabilityFilter {
  if (raw === "all" || raw === "unavailable") {
    return raw;
  }
  return "available";
}

export function normalizeSelectionFilter(raw: string | null): SelectionFilter {
  if (raw === "visible" || raw === "eligible" || raw === "unselected") {
    return raw;
  }
  return "all";
}

export function buildAvailabilityWhere(
  filter: AvailabilityFilter,
): Prisma.ConnectedCommerceProductWhereInput {
  if (filter === "available") {
    return { isAvailable: true };
  }
  if (filter === "unavailable") {
    return { isAvailable: false };
  }
  return {};
}

export function buildSelectionWhere(
  filter: SelectionFilter,
  brandId: string,
): Prisma.ConnectedCommerceProductWhereInput {
  if (filter === "visible") {
    return { brandSelections: { some: { brandId, isVisibleInShop: true } } };
  }
  if (filter === "eligible") {
    return { brandSelections: { some: { brandId, isCampaignEligible: true } } };
  }
  if (filter === "unselected") {
    return { brandSelections: { none: { brandId } } };
  }
  return {};
}

export function buildSearchWhere(q: string | null): Prisma.ConnectedCommerceProductWhereInput {
  const trimmed = q?.trim();
  if (!trimmed) {
    return {};
  }
  return {
    OR: [
      { title: { contains: trimmed, mode: "insensitive" } },
      { sku: { contains: trimmed, mode: "insensitive" } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Selection override validation (PATCH body)
// ---------------------------------------------------------------------------

export const TITLE_OVERRIDE_MAX_LENGTH = 200;
export const SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH = 1000;
export const IMAGE_URL_OVERRIDE_MAX_LENGTH = 2048;
export const DISPLAY_ORDER_MIN = 0;
export const DISPLAY_ORDER_MAX = 1_000_000;

export type SelectionUpdateInput = {
  isVisibleInShop?: boolean;
  isCampaignEligible?: boolean;
  displayOrder?: number;
  titleOverride?: string | null;
  shortDescriptionOverride?: string | null;
  imageUrlOverride?: string | null;
};

export type SelectionValidationResult =
  | { ok: true; data: SelectionUpdateInput }
  | { ok: false; error: string };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates and bounds a `PATCH .../selection` request body. Total: never
 * throws. Rejects (does not silently clamp) any out-of-bounds string/number
 * — a caller that supplies an over-long override or a non-http(s) image URL
 * gets an explicit 400, not a silently truncated write.
 */
export function validateSelectionUpdate(body: unknown): SelectionValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;
  const data: SelectionUpdateInput = {};

  if ("isVisibleInShop" in input && input.isVisibleInShop !== undefined) {
    if (typeof input.isVisibleInShop !== "boolean") {
      return { ok: false, error: "isVisibleInShop must be a boolean." };
    }
    data.isVisibleInShop = input.isVisibleInShop;
  }

  if ("isCampaignEligible" in input && input.isCampaignEligible !== undefined) {
    if (typeof input.isCampaignEligible !== "boolean") {
      return { ok: false, error: "isCampaignEligible must be a boolean." };
    }
    data.isCampaignEligible = input.isCampaignEligible;
  }

  if ("displayOrder" in input && input.displayOrder !== undefined) {
    const value = input.displayOrder;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < DISPLAY_ORDER_MIN ||
      value > DISPLAY_ORDER_MAX
    ) {
      return {
        ok: false,
        error: `displayOrder must be an integer between ${DISPLAY_ORDER_MIN} and ${DISPLAY_ORDER_MAX}.`,
      };
    }
    data.displayOrder = value;
  }

  for (const [key, maxLength] of [
    ["titleOverride", TITLE_OVERRIDE_MAX_LENGTH],
    ["shortDescriptionOverride", SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH],
  ] as const) {
    if (key in input && input[key] !== undefined) {
      const value = input[key];
      if (value === null) {
        data[key] = null;
        continue;
      }
      if (typeof value !== "string") {
        return { ok: false, error: `${key} must be a string or null.` };
      }
      if (value.length > maxLength) {
        return { ok: false, error: `${key} must be at most ${maxLength} characters.` };
      }
      data[key] = value;
    }
  }

  if ("imageUrlOverride" in input && input.imageUrlOverride !== undefined) {
    const value = input.imageUrlOverride;
    if (value === null) {
      data.imageUrlOverride = null;
    } else if (typeof value !== "string") {
      return { ok: false, error: "imageUrlOverride must be a string or null." };
    } else if (value.length > IMAGE_URL_OVERRIDE_MAX_LENGTH) {
      return {
        ok: false,
        error: `imageUrlOverride must be at most ${IMAGE_URL_OVERRIDE_MAX_LENGTH} characters.`,
      };
    } else if (!isHttpUrl(value)) {
      return { ok: false, error: "imageUrlOverride must be a valid http(s) URL." };
    } else {
      data.imageUrlOverride = value;
    }
  }

  return { ok: true, data };
}
