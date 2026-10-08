import { COMMERCE7_COUPON_CONTRACT, commerce7NativePercentage, type CouponContract, type CouponScope } from "../../commerce7-coupon-contract";
import { getCommerce7AppConfig, buildCommerce7AppAuthorizationHeader, normalizeCommerce7Tenant } from "./commerce7";
import { computeCommerce7Availability, readCommerce7ProductSecurity } from "./commerce7-products";
import type { CommerceProductAccessSecurity } from "../types";
import { createHash } from "node:crypto";

export class Commerce7RewardError extends Error {
  constructor(readonly code: "SETUP_INCOMPLETE" | "PROVIDER_UNAVAILABLE" | "INVALID_PROVIDER_RESPONSE" | "CUSTOMER_AMBIGUOUS" | "SEARCH_LIMIT" | "UNSUPPORTED_ACCESS" | "WRITE_REJECTED" | "NOT_FOUND", readonly uncertain = false) {
    super(code === "SETUP_INCOMPLETE" ? "Commerce7 rewards setup is incomplete." : code === "UNSUPPORTED_ACCESS" ? "Automatic exclusive-product access is not supported by the verified Commerce7 contract." : "Commerce7 could not complete this reward. Retry or contact the store.");
  }
}
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 250; }
export function normalizeRewardEmail(email: string) { return email.trim().toLowerCase(); }
export function claimTagTitle(claimId: string) { return `SQRATCH-${createHash("sha256").update(claimId).digest("hex").slice(0, 24)}`; }
/**
 * The native coupon as READ back (POST 201 echo, GET, list). Deliberately not the write shape: a GET still reports the
 * historical productDiscountType/productDiscount/minimumCartAmount fields, while the create echo reports the current
 * type/discountType/discount/cartRequirement* fields. Either may be present; see readCouponTerms.
 */
export type NativeCoupon = {
  id: string; code: string; title: string; usageLimitType: string; usageLimit: number | null;
  appliesTo: string; appliesToObjectIds: string[] | null; startDate: string; endDate: string | null;
  status: string; availableTo: string; availableToObjectIds: string[] | null;
  type: string | null; discountType: string | null; discount: number | null; dollarOffDiscountApplies: string | null;
  cartRequirementType: string | null; cartRequirement: number | null; cartRequirementCountType: string | null; cartRequirementMaximum: number | null;
  productDiscountType: string | null; productDiscount: number | null; shippingDiscountType: string | null; shippingDiscount: number | null; minimumCartAmount: number | null;
};
const keys = ["id", "code", "title", "usageLimitType", "appliesTo", "startDate", "status", "availableTo"] as const;
/** A real tenant reads an empty object-ID list back as "" (see operator-sandbox-evidence.json); arrays are the populated form. */
function nativeObjectIds(value: unknown): string[] | null {
  if (value == null || value === "") return null;
  if (!Array.isArray(value) || value.length > 50 || !value.every(text)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  return value.length ? value : null;
}
export function parseNativeCoupon(value: unknown): NativeCoupon {
  const row = object(value);
  if (!row || keys.some((key) => !text(row[key]))) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  // A coupon with no product/shipping discount reads these back as null. Absent and null are the same fact;
  // exact matching below decides whether that coupon is the one SQRATCH requested.
  for (const key of ["productDiscountType", "shippingDiscountType", "type", "discountType", "dollarOffDiscountApplies", "cartRequirementType", "cartRequirementCountType"] as const) {
    if (row[key] != null && !text(row[key])) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  }
  for (const key of ["productDiscount", "discount"] as const) {
    if (row[key] != null && (typeof row[key] !== "number" || !Number.isFinite(row[key]))) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  }
  for (const key of ["usageLimit", "shippingDiscount", "minimumCartAmount", "cartRequirement", "cartRequirementMaximum"] as const) {
    if (row[key] != null && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  }
  if (!Number.isFinite(Date.parse(String(row.startDate))) || (row.endDate != null && (typeof row.endDate !== "string" || !Number.isFinite(Date.parse(row.endDate))))) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  // Copy a closed, PII-free field set; additive provider fields are ignored.
  return {
    id: row.id as string, code: row.code as string, title: row.title as string, usageLimitType: row.usageLimitType as string, usageLimit: (row.usageLimit as number | null | undefined) ?? null,
    appliesTo: row.appliesTo as string, appliesToObjectIds: nativeObjectIds(row.appliesToObjectIds),
    productDiscountType: (row.productDiscountType as string | null | undefined) ?? null, productDiscount: (row.productDiscount as number | null | undefined) ?? null,
    shippingDiscountType: (row.shippingDiscountType as string | null | undefined) ?? null, shippingDiscount: (row.shippingDiscount as number | null | undefined) ?? null,
    startDate: row.startDate as string, endDate: (row.endDate as string | null | undefined) ?? null, status: row.status as string,
    minimumCartAmount: (row.minimumCartAmount as number | null | undefined) ?? null, availableTo: row.availableTo as string, availableToObjectIds: nativeObjectIds(row.availableToObjectIds),
    type: (row.type as string | null | undefined) ?? null, discountType: (row.discountType as string | null | undefined) ?? null, discount: (row.discount as number | null | undefined) ?? null,
    dollarOffDiscountApplies: (row.dollarOffDiscountApplies as string | null | undefined) ?? null, cartRequirementType: (row.cartRequirementType as string | null | undefined) ?? null,
    cartRequirement: (row.cartRequirement as number | null | undefined) ?? null, cartRequirementCountType: (row.cartRequirementCountType as string | null | undefined) ?? null,
    cartRequirementMaximum: (row.cartRequirementMaximum as number | null | undefined) ?? null,
  };
}
export type NativeTag = { id: string; title: string; type: "Manual"; objectType: "Customer" };
function parseTag(value: unknown): NativeTag {
  const row = object(value);
  if (!row || !text(row.id) || !text(row.title) || row.type !== "Manual" || row.objectType !== "Customer") throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  return { id: row.id, title: row.title, type: row.type, objectType: row.objectType };
}
/**
 * A tag definition exactly as Commerce7 reports it (GET /v1/tag/customer/{id}). `type`/`objectType` are kept verbatim so a
 * caller can refuse anything but the live-observed "Manual" / "Customer"; the documented Dynamic type is never assignable.
 */
export type NativeTagDefinition = { id: string; title: string; type: string; objectType: string };
function parseTagDefinition(value: unknown): NativeTagDefinition {
  const row = object(value);
  if (!row || !text(row.id) || !text(row.title) || !text(row.type) || !text(row.objectType)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
  return { id: row.id, title: row.title, type: row.type, objectType: row.objectType };
}
/** A product's live access facts (GET /v1/product/{id}), read with the same parsers product sync uses. Never written. */
export type NativeProductAccess = { id: string; available: boolean; security: CommerceProductAccessSecurity | null };
/** `tagIds` keeps duplicates: a live tenant can hold the same tag twice for one customer (see the duplicate-membership evidence). */
export type NativeCustomer = { id: string; emails: string[]; tagIds: string[] };
/** How many times the customer holds the tag. 0 = absent; more than 1 = duplicate native memberships. */
export function customerTagCount(customer: Pick<NativeCustomer, "tagIds">, tagId: string) { return customer.tagIds.filter((id) => id === tagId).length; }
function parseCustomer(value: unknown): NativeCustomer {
  const row = object(value);
  if (!row || !text(row.id) || !Array.isArray(row.emails) || !Array.isArray(row.tags)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
  const emails = row.emails.map((entry) => object(entry)?.email);
  const tags = row.tags.map((entry) => object(entry)?.id);
  if (!emails.every(text) || !tags.every(text)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
  return { id: row.id, emails: emails.map(normalizeRewardEmail), tagIds: tags };
}
export type RewardCouponTerms = { title: string; discountType: "FIXED_AMOUNT" | "PERCENTAGE"; discountAmountCents: number | null; discountPercentageBasisPoints: number | null; minimumSubtotalCents: number | null };
/**
 * The native coupon WRITE request: exactly what SQRATCH POSTs to the public /v1/coupon API. Proven field-by-field by live
 * sandbox 201s (tests/fixtures/commerce7-rewards/live-coupon-create-201.json); the public docs' productDiscountType/
 * productDiscount/shippingDiscountType shape is rejected by the live API (live-coupon-create-422.json) and is never sent.
 * Optional fields are omitted when they do not apply.
 */
export type CouponWriteRequest = {
  code: string; title: string; type: string; status: string; usageLimitType: string; usageLimit: number;
  appliesTo: string; appliesToObjectIds?: string[]; availableTo: string; availableToObjectIds?: string[];
  discountType: string; discount: number; dollarOffDiscountApplies?: string;
  cartRequirementType: string; cartRequirement?: number; cartRequirementCountType?: string;
  startDate: string; endDate: string;
};
/** Bounded, PII-free and secret-free: brand-authored title plus a non-reversible claim reference. Never the coupon code. */
export function rewardCouponTitle(title: string, claimId: string) {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 60).trim() || "reward";
  return `SQRATCH ${clean} ${createHash("sha256").update(`c7-coupon-title:${claimId}`).digest("hex").slice(0, 8)}`;
}
/** Provider dates are minute-aligned; aligning ours keeps retries, recovery and readback byte-stable. */
export function floorToMinute(date: Date) { return new Date(Math.floor(date.getTime() / 60000) * 60000); }
export function buildCommerce7RewardCoupon(input: { terms: RewardCouponTerms; scope: CouponScope; code: string; claimId: string; startsAt: Date; endsAt: Date }, contract: CouponContract = COMMERCE7_COUPON_CONTRACT): CouponWriteRequest {
  const { terms, scope, code } = input;
  const startsAt = floorToMinute(input.startsAt); const endsAt = floorToMinute(input.endsAt);
  if (!/^SQRA[A-F0-9]{32}$/.test(code) || !input.claimId || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new Commerce7RewardError("SETUP_INCOMPLETE");
  if (!scope.appliesTo || !scope.availableTo || (scope.appliesToObjectIds && !scope.appliesToObjectIds.length) || (scope.availableToObjectIds && !scope.availableToObjectIds.length)) throw new Commerce7RewardError("SETUP_INCOMPLETE");
  // Integer minor units / whole percentages only. No floating-point money math. A percentage is written in the native unit
  // (1/100 of a percent, live-observed): 15% is 1500, never 15, which Commerce7 applies as 0.15%.
  const basis = terms.discountPercentageBasisPoints;
  const discount = terms.discountType === "FIXED_AMOUNT" ? terms.discountAmountCents
    : typeof basis === "number" && Number.isSafeInteger(basis) && basis >= 100 && basis <= 10000 && basis % 100 === 0 ? commerce7NativePercentage(basis, contract) : null;
  const max = terms.discountType === "FIXED_AMOUNT" ? 2147483647 : 100 * contract.percentage.nativeUnitsPerPercent;
  if (typeof discount !== "number" || !Number.isSafeInteger(discount) || discount < 1 || discount > max) throw new Commerce7RewardError("SETUP_INCOMPLETE");
  if (terms.minimumSubtotalCents !== null && (!Number.isSafeInteger(terms.minimumSubtotalCents) || terms.minimumSubtotalCents < 1)) throw new Commerce7RewardError("SETUP_INCOMPLETE");
  return {
    code, title: rewardCouponTitle(terms.title, input.claimId), type: contract.type, status: contract.status, usageLimitType: contract.usageLimitType, usageLimit: contract.usageLimit,
    appliesTo: scope.appliesTo, ...(scope.appliesToObjectIds ? { appliesToObjectIds: scope.appliesToObjectIds } : {}),
    availableTo: scope.availableTo, ...(scope.availableToObjectIds ? { availableToObjectIds: scope.availableToObjectIds } : {}),
    discountType: contract.discountType[terms.discountType], discount,
    ...(terms.discountType === "FIXED_AMOUNT" ? { dollarOffDiscountApplies: contract.dollarOffDiscountApplies } : {}),
    ...(terms.minimumSubtotalCents === null
      ? { cartRequirementType: contract.cartRequirement.none }
      : { cartRequirementType: contract.cartRequirement.minimum, cartRequirement: terms.minimumSubtotalCents, cartRequirementCountType: contract.cartRequirement.countType }),
    startDate: startsAt.toISOString(), endDate: endsAt.toISOString(),
  };
}
/**
 * The benefit-defining terms of a read-back coupon, normalized from whichever representation the provider used. The create
 * echo reports type/discountType/discount/cartRequirement*; a GET reports productDiscountType/productDiscount/minimumCartAmount.
 * Null means "not reported". When both report a term they must agree, and a term no representation reports is unknown.
 */
type ReadTerms = { discount: { type: string; amount: number } | null; minimum: { amount: number | null; countType: string | null } | null };
function readCouponTerms(coupon: NativeCoupon): ReadTerms {
  const current = coupon.discountType !== null || coupon.discount !== null ? { type: coupon.discountType, amount: coupon.discount } : null;
  const legacy = coupon.productDiscountType !== null || coupon.productDiscount !== null ? { type: coupon.productDiscountType, amount: coupon.productDiscount } : null;
  const reported = current ?? legacy;
  const discount = !reported || reported.type === null || reported.amount === null || (current && legacy && (current.type !== legacy.type || current.amount !== legacy.amount)) ? null : { type: reported.type, amount: reported.amount };
  const { none, minimum: minimumType } = COMMERCE7_COUPON_CONTRACT.cartRequirement;
  let currentMinimum: { amount: number | null; countType: string | null } | null | "unknown" = null;
  if (coupon.cartRequirementType === none) currentMinimum = coupon.cartRequirement ? "unknown" : { amount: null, countType: null };
  else if (coupon.cartRequirementType === minimumType) currentMinimum = coupon.cartRequirement === null ? "unknown" : { amount: coupon.cartRequirement, countType: coupon.cartRequirementCountType };
  else if (coupon.cartRequirementType !== null) currentMinimum = "unknown"; // a requirement kind SQRATCH never writes (quantity, for example)
  const legacyMinimum = coupon.minimumCartAmount !== null ? { amount: coupon.minimumCartAmount, countType: null } : null;
  const minimum = currentMinimum === "unknown" || (currentMinimum && legacyMinimum && currentMinimum.amount !== legacyMinimum.amount) ? null : currentMinimum ?? legacyMinimum ?? { amount: null, countType: null };
  return { discount, minimum };
}
const sameIds = (actual: string[] | null, expected: string[] | undefined) => JSON.stringify(actual ? [...actual].sort() : null) === JSON.stringify(expected?.length ? [...expected].sort() : null);
const minuteOf = (value: string | null) => value === null ? null : Math.floor(Date.parse(value) / 60000);
/**
 * Semantic readback verification. Every benefit-defining term must be reported and equal: code (case-insensitive), usage,
 * scope, eligibility, status, discount kind and amount, once-per-order for dollar off, minimum and its counting rule, no
 * cart maximum, no shipping discount, and the minute-aligned window. Tolerated as representation only: the read/echo field
 * names, null versus "" object IDs, sub-minute date precision, the cosmetic title, and the provider's default
 * dollarOffDiscountApplies = "Once Per Order" echoed on a percentage coupon.
 */
export function couponMatches(coupon: NativeCoupon, expected: CouponWriteRequest) {
  const { discount, minimum } = readCouponTerms(coupon);
  const contract = COMMERCE7_COUPON_CONTRACT;
  const perOrderOk = expected.dollarOffDiscountApplies !== undefined
    ? coupon.dollarOffDiscountApplies === expected.dollarOffDiscountApplies
    : coupon.dollarOffDiscountApplies === null || coupon.dollarOffDiscountApplies === contract.dollarOffDiscountApplies;
  return coupon.code.toUpperCase() === expected.code.toUpperCase()
    && (coupon.type === null || coupon.type === expected.type)
    && coupon.usageLimitType === expected.usageLimitType && coupon.usageLimit === expected.usageLimit
    && coupon.appliesTo === expected.appliesTo && sameIds(coupon.appliesToObjectIds, expected.appliesToObjectIds)
    && coupon.availableTo === expected.availableTo && sameIds(coupon.availableToObjectIds, expected.availableToObjectIds)
    && coupon.status === expected.status
    && discount !== null && discount.type === expected.discountType && discount.amount === expected.discount && perOrderOk
    && minimum !== null && minimum.amount === (expected.cartRequirement ?? null)
    && (expected.cartRequirementCountType === undefined || minimum.countType === null || minimum.countType === expected.cartRequirementCountType)
    && coupon.cartRequirementMaximum === null
    && (coupon.shippingDiscountType ?? contract.readNoShippingDiscount) === contract.readNoShippingDiscount && coupon.shippingDiscount === null
    && minuteOf(coupon.startDate) === minuteOf(expected.startDate) && minuteOf(coupon.endDate) === minuteOf(expected.endDate);
}

export class Commerce7RewardsClient {
  private readonly deadline = Date.now() + 25000;
  constructor(readonly tenant: string, private readonly fetcher: typeof fetch = fetch) {
    if (!normalizeCommerce7Tenant(tenant) || normalizeCommerce7Tenant(tenant) !== tenant) throw new Commerce7RewardError("SETUP_INCOMPLETE");
  }
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const config = getCommerce7AppConfig();
    if (!config) throw new Commerce7RewardError("SETUP_INCOMPLETE");
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Commerce7RewardError("PROVIDER_UNAVAILABLE");
    let response: Response;
    try {
      response = await this.fetcher(`https://api.commerce7.com/v1${path}`, {
        method, headers: { Authorization: buildCommerce7AppAuthorizationHeader(config), tenant: this.tenant, Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(10000, remaining)), cache: "no-store",
      });
    } catch { throw new Commerce7RewardError("PROVIDER_UNAVAILABLE", method !== "GET"); }
    if (response.status === 401 || response.status === 403) throw new Commerce7RewardError("SETUP_INCOMPLETE");
    if (response.status === 404) throw new Commerce7RewardError("NOT_FOUND");
    if (!response.ok) {
      // 4xx other than 408/409 is a definitive refusal: nothing was written and the same request can never succeed.
      // 429 was refused before processing and is retryable. 408, 409 and 5xx on a write may have been accepted.
      const transient = response.status >= 500 || response.status === 429 || response.status === 408;
      const mayHaveWritten = method !== "GET" && (response.status >= 500 || response.status === 408 || response.status === 409);
      throw new Commerce7RewardError(transient ? "PROVIDER_UNAVAILABLE" : "WRITE_REJECTED", mayHaveWritten);
    }
    if (method === "DELETE" && response.status === 204) return null;
    try { return await response.json(); } catch { throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", method !== "GET"); }
  }
  async coupon(id: string) {
    const coupon = parseNativeCoupon(await this.request(`/coupon/${encodeURIComponent(id)}`));
    if (coupon.id !== id) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
    return coupon;
  }
  async customerById(id: string) {
    const customer = parseCustomer(await this.request(`/customer/${encodeURIComponent(id)}`));
    if (customer.id !== id) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
    return customer;
  }
  async tagOnlyForCustomer(tagId: string, customerId: string): Promise<boolean> {
    // Exact filter documented by the Bulk Update Customer Tag webhook.
    let cursor = "start"; const visited = new Set<string>(); const members = new Set<string>();
    for (let page = 0; page < 20; page++) {
      if (visited.has(cursor)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
      visited.add(cursor);
      const body = object(await this.request(`/customer?tagId=${encodeURIComponent(tagId)}&cursor=${encodeURIComponent(cursor)}`));
      if (!body || !Array.isArray(body.customers) || body.customers.length > 50) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
      for (const raw of body.customers) {
        const member = parseCustomer(raw);
        if (!member.tagIds.includes(tagId)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
        if (member.id !== customerId) throw new Commerce7RewardError("CUSTOMER_AMBIGUOUS");
        if (members.has(member.id)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
        members.add(member.id);
      }
      if (body.cursor == null || body.cursor === "") {
        if (body.total !== undefined && body.total !== members.size) throw new Commerce7RewardError("SEARCH_LIMIT");
        return members.has(customerId);
      }
      if (!text(body.cursor)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
      cursor = body.cursor;
    }
    throw new Commerce7RewardError("SEARCH_LIMIT");
  }
  /** Documented "Retrieve a tag". 404 means the tag no longer exists. */
  async customerTag(id: string): Promise<NativeTagDefinition | null> {
    let body: unknown;
    try { body = await this.request(`/tag/customer/${encodeURIComponent(id)}`); }
    catch (error) { if (error instanceof Commerce7RewardError && error.code === "NOT_FOUND") return null; throw error; }
    const tag = parseTagDefinition(body);
    if (tag.id !== id) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
    return tag;
  }
  /** Live product security and availability (Product: Read). Read-only; SQRATCH never writes product security. */
  async productAccess(id: string): Promise<NativeProductAccess | null> {
    let body: unknown;
    try { body = await this.request(`/product/${encodeURIComponent(id)}`); }
    catch (error) { if (error instanceof Commerce7RewardError && error.code === "NOT_FOUND") return null; throw error; }
    const row = object(body);
    if (!row || row.id !== id) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
    return { id, available: computeCommerce7Availability(row).isCatalogAvailable, security: readCommerce7ProductSecurity(row) };
  }
  /**
   * Live-proven POST /v1/tag-x-object/customer (HTTP 201 echoing objectId/tagId plus the relation id). NOT idempotent: the
   * provider accepted a second POST for a customer who already held the tag and then reported the tag twice. Callers must
   * prove absence first, persist an attempt marker, and never repeat this after an ambiguous outcome.
   */
  async assignCustomerTag(customerId: string, tagId: string): Promise<{ id: string }> {
    const row = object(await this.request("/tag-x-object/customer", "POST", { objectId: customerId, tagId }));
    if (!row || row.objectId !== customerId || row.tagId !== tagId || !text(row.id)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
    return { id: row.id };
  }
  async createTag(claimId: string) {
    const tag = parseTag(await this.request("/tag/customer", "POST", { title: claimTagTitle(claimId), type: "Manual" }));
    if (tag.title !== claimTagTitle(claimId)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
    return tag;
  }
  async findTag(claimId: string): Promise<NativeTag | null> {
    const matches: NativeTag[] = [];
    const seenIds = new Set<string>();
    let read = 0;
    let total: number | null = null;
    for (let page = 1; page <= 20; page++) {
      const body = object(await this.request(`/tag/customer?page=${page}&limit=50`));
      if (!body || !Array.isArray(body.tags) || !Number.isSafeInteger(body.total) || Number(body.total) < 0 || body.tags.length > 50 || (total !== null && total !== body.total)) throw new Commerce7RewardError("SEARCH_LIMIT");
      total = Number(body.total); read += body.tags.length;
      for (const raw of body.tags) {
        const id = object(raw)?.id;
        if (!text(id) || seenIds.has(id)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
        seenIds.add(id);
      }
      matches.push(...body.tags.filter((entry) => object(entry)?.title === claimTagTitle(claimId)).map(parseTag));
      if (read === total) break;
      if (read > total || !body.tags.length || page === 20) throw new Commerce7RewardError("SEARCH_LIMIT");
    }
    if (matches.length > 1) throw new Commerce7RewardError("CUSTOMER_AMBIGUOUS");
    return matches[0] ?? null;
  }
  async customer(email: string, exclusiveTagId?: string): Promise<NativeCustomer | null> {
    let cursor: string | null = "start";
    const visited = new Set<string>(); const found = new Map<string, NativeCustomer>(); const seenIds = new Set<string>();
    const tagMembers = new Set<string>();
    // Official cursor API; q is documented as name search, not email. Never
    // assume it proves uniqueness. Bounded exhaustion is required for binding.
    for (let page = 0; page < 20; page++) {
      if (!cursor || visited.has(cursor)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
      visited.add(cursor);
      const body = object(await this.request(`/customer?cursor=${encodeURIComponent(cursor)}`));
      if (!body || !Array.isArray(body.customers) || body.customers.length > 50) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
      for (const raw of body.customers) {
        const customer = parseCustomer(raw);
        if (seenIds.has(customer.id)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
        seenIds.add(customer.id);
        if (customer.emails.includes(normalizeRewardEmail(email))) found.set(customer.id, customer);
        if (exclusiveTagId && customer.tagIds.includes(exclusiveTagId)) tagMembers.add(customer.id);
      }
      if (body.cursor == null || body.cursor === "") {
        if (body.total !== undefined && body.total !== seenIds.size) throw new Commerce7RewardError("SEARCH_LIMIT");
        if (found.size > 1) throw new Commerce7RewardError("CUSTOMER_AMBIGUOUS");
        const customer = [...found.values()][0] ?? null;
        if (exclusiveTagId && [...tagMembers].some((id) => id !== customer?.id)) throw new Commerce7RewardError("CUSTOMER_AMBIGUOUS");
        return customer;
      }
      if (!text(body.cursor)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
      cursor = body.cursor;
    }
    throw new Commerce7RewardError("SEARCH_LIMIT");
  }
  async createCoupon(payload: CouponWriteRequest) {
    const coupon = parseNativeCoupon(await this.request("/coupon", "POST", payload));
    if (!couponMatches(coupon, payload)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
    return coupon;
  }
  async findCoupon(code: string): Promise<NativeCoupon | null> {
    const body = object(await this.request(`/coupon?q=${encodeURIComponent(code)}`));
    if (!body || !Array.isArray(body.coupons) || !Number.isSafeInteger(body.total) || body.total !== body.coupons.length || body.coupons.length > 50) throw new Commerce7RewardError("SEARCH_LIMIT");
    const matches = body.coupons.filter((entry) => String(object(entry)?.code ?? "").toUpperCase() === code.toUpperCase()).map(parseNativeCoupon);
    if (matches.length > 1) throw new Commerce7RewardError("CUSTOMER_AMBIGUOUS");
    return matches[0] ?? null;
  }
  async revokeCoupon(id: string) {
    try { await this.request(`/coupon/${encodeURIComponent(id)}`, "DELETE"); }
    catch (error) { if (!(error instanceof Commerce7RewardError) || error.code !== "NOT_FOUND") throw error; }
    try { await this.coupon(id); }
    catch (error) { if (error instanceof Commerce7RewardError && error.code === "NOT_FOUND") return; throw error; }
    throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  }
}
