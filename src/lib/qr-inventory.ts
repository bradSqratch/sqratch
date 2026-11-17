import type { Prisma } from "@prisma/client";
import { archivedBatchWhere, archivedCodeWhere, parseArchivedFilter, type ArchivedFilter } from "@/lib/qr-archive";

/** Page sizes: codes keep their historical default of 100 (max 200); batches are a smaller table. */
export const CODE_PAGE_SIZE = 100;
export const CODE_MAX_PAGE_SIZE = 200;
export const BATCH_PAGE_SIZE = 25;
export const BATCH_MAX_PAGE_SIZE = 100;
export const OPTIONS_PAGE_SIZE = 25;
export const OPTIONS_MAX_PAGE_SIZE = 50;
const MAX_TEXT = 100;

export type InventoryQuery = {
  archived: ArchivedFilter;
  page: number;
  pageSize: number;
  batchPage: number;
  batchPageSize: number;
  campaignId: string | null;
  batchId: string | null;
  status: "NEW" | "REDEEMED" | null;
  codeSearch: string | null;
  batchSearch: string | null;
};

type Params = Pick<URLSearchParams, "get">;

function positiveInt(value: string | null, fallback: number, max?: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return max ? Math.min(n, max) : n;
}

function text(value: string | null) {
  const trimmed = (value ?? "").trim().slice(0, MAX_TEXT);
  return trimmed || null;
}

/**
 * A pasted scan link (`…/q/<code>`) or a code with stray whitespace searches
 * the same as the bare code. Codes are case-sensitive, so case is preserved.
 */
export function normalizeCodeSearch(value: string | null) {
  const raw = text(value);
  if (!raw) return null;
  const withoutQuery = raw.split(/[?#]/)[0].replace(/\/+$/, "");
  const segment = withoutQuery.includes("/") ? withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1) : withoutQuery;
  return segment || null;
}

export function parseInventoryQuery(params: Params): { ok: true; query: InventoryQuery } | { ok: false; error: string } {
  const archived = parseArchivedFilter(params.get("archived"));
  if (!archived) return { ok: false, error: "archived must be one of: exclude, include, only." };
  const statusParam = params.get("status");
  if (statusParam && statusParam !== "NEW" && statusParam !== "REDEEMED") {
    return { ok: false, error: "status must be NEW or REDEEMED." };
  }
  return {
    ok: true,
    query: {
      archived,
      page: positiveInt(params.get("page"), 1),
      pageSize: positiveInt(params.get("pageSize"), CODE_PAGE_SIZE, CODE_MAX_PAGE_SIZE),
      batchPage: positiveInt(params.get("batchPage"), 1),
      batchPageSize: positiveInt(params.get("batchPageSize"), BATCH_PAGE_SIZE, BATCH_MAX_PAGE_SIZE),
      campaignId: text(params.get("campaignId")),
      batchId: text(params.get("batchId")),
      status: (statusParam as "NEW" | "REDEEMED" | null) || null,
      codeSearch: normalizeCodeSearch(params.get("q")),
      batchSearch: text(params.get("batchQ")),
    },
  };
}

/** Every filter is applied on top of the brand scope; an id from another brand simply matches nothing. */
export function inventoryCodeWhere(brandId: string, query: InventoryQuery): Prisma.QRCodeWhereInput {
  const and: Prisma.QRCodeWhereInput[] = [archivedCodeWhere(query.archived)];
  if (query.batchId) and.push({ batchId: query.batchId });
  if (query.campaignId) and.push({ campaignId: query.campaignId });
  if (query.status === "REDEEMED") and.push({ status: "USED" });
  if (query.status === "NEW") and.push({ status: { not: "USED" } });
  if (query.codeSearch) and.push({ qrCodeData: { startsWith: query.codeSearch } });
  return { campaign: { brandId }, AND: and };
}

export function inventoryBatchWhere(brandId: string, query: InventoryQuery): Prisma.QRCodeBatchWhereInput {
  const and: Prisma.QRCodeBatchWhereInput[] = [archivedBatchWhere(query.archived)];
  if (query.campaignId) and.push({ campaignId: query.campaignId });
  if (query.batchSearch) and.push({ name: { contains: query.batchSearch, mode: "insensitive" } });
  return { campaign: { brandId }, AND: and };
}

export type OptionsQuery = {
  type: "batches" | "campaigns";
  q: string | null;
  cursor: string | null;
  limit: number;
  archived: ArchivedFilter;
  campaignId: string | null;
};

export function parseOptionsQuery(params: Params): { ok: true; query: OptionsQuery } | { ok: false; error: string } {
  const type = params.get("type");
  if (type !== "batches" && type !== "campaigns") return { ok: false, error: "type must be batches or campaigns." };
  const archived = parseArchivedFilter(params.get("archived") ?? "include");
  if (!archived) return { ok: false, error: "archived must be one of: exclude, include, only." };
  return {
    ok: true,
    query: {
      type,
      q: text(params.get("q")),
      cursor: text(params.get("cursor")),
      limit: positiveInt(params.get("limit"), OPTIONS_PAGE_SIZE, OPTIONS_MAX_PAGE_SIZE),
      archived,
      campaignId: text(params.get("campaignId")),
    },
  };
}
