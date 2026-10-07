import { getCommerce7AppConfig, buildCommerce7AppAuthorizationHeader, normalizeCommerce7Tenant } from "./commerce7";
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
export type NativeCoupon = {
  id: string; code: string; title: string; usageLimitType: string; usageLimit: number | null;
  appliesTo: string; appliesToObjectIds: string[] | null; productDiscountType: string; productDiscount: number;
  shippingDiscountType: string; shippingDiscount: number | null; startDate: string; endDate: string | null;
  status: string; minimumCartAmount: number | null; availableTo: string; availableToObjectIds: string[] | null;
};
const keys = ["id", "code", "title", "usageLimitType", "appliesTo", "productDiscountType", "shippingDiscountType", "startDate", "status", "availableTo"] as const;
export function parseNativeCoupon(value: unknown): NativeCoupon {
  const row = object(value);
  if (!row || keys.some((key) => !text(row[key])) || !Number.isFinite(row.productDiscount)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  for (const key of ["usageLimit", "shippingDiscount", "minimumCartAmount"] as const) {
    if (row[key] !== null && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  }
  for (const key of ["appliesToObjectIds", "availableToObjectIds"] as const) {
    if (row[key] !== null && (!Array.isArray(row[key]) || row[key].length > 50 || !row[key].every(text))) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  }
  if (!Number.isFinite(Date.parse(String(row.startDate))) || (row.endDate !== null && (typeof row.endDate !== "string" || !Number.isFinite(Date.parse(row.endDate))))) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  // Copy a closed, PII-free field set; additive provider fields are ignored.
  return Object.fromEntries([...keys, "usageLimit", "appliesToObjectIds", "productDiscount", "shippingDiscount", "endDate", "minimumCartAmount", "availableToObjectIds"].map((key) => [key, row[key]])) as NativeCoupon;
}
export type NativeTag = { id: string; title: string; type: "Manual"; objectType: "Customer" };
function parseTag(value: unknown): NativeTag {
  const row = object(value);
  if (!row || !text(row.id) || !text(row.title) || row.type !== "Manual" || row.objectType !== "Customer") throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE", true);
  return { id: row.id, title: row.title, type: row.type, objectType: row.objectType };
}
export type NativeCustomer = { id: string; emails: string[]; tagIds: string[] };
function parseCustomer(value: unknown): NativeCustomer {
  const row = object(value);
  if (!row || !text(row.id) || !Array.isArray(row.emails) || !Array.isArray(row.tags)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
  const emails = row.emails.map((entry) => object(entry)?.email);
  const tags = row.tags.map((entry) => object(entry)?.id);
  if (!emails.every(text) || !tags.every(text)) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
  return { id: row.id, emails: emails.map(normalizeRewardEmail), tagIds: tags };
}
export type RewardCouponConfig = { title: string; discountType: "FIXED_AMOUNT" | "PERCENTAGE"; discountAmountCents: number | null; discountPercentageBasisPoints: number | null; minimumSubtotalCents: number | null };
export function buildCommerce7RewardCoupon(template: NativeCoupon, config: RewardCouponConfig, code: string, customerTagId: string, startsAt: Date, endsAt: Date) {
  if (!/^SQRA[A-F0-9]{32}$/.test(code) || !customerTagId || !Number.isFinite(startsAt.getTime()) || endsAt <= startsAt) throw new Commerce7RewardError("SETUP_INCOMPLETE");
  // Eligibility and scope enum values come from an actual native template,
  // never guessed from Admin labels. Each claim gets its own Customer tag.
  if (template.availableTo === "Everyone" || template.availableToObjectIds?.length !== 1 || template.usageLimitType !== "Per Store" || template.usageLimit !== 1 || template.shippingDiscountType !== "No Discount") throw new Commerce7RewardError("SETUP_INCOMPLETE");
  const discount = config.discountType === "FIXED_AMOUNT" ? config.discountAmountCents : (config.discountPercentageBasisPoints ?? 0) / 100;
  if (!discount || !Number.isSafeInteger(discount) || discount < 1 || (config.discountType === "PERCENTAGE" && discount > 100)) throw new Commerce7RewardError("SETUP_INCOMPLETE");
  return {
    code, title: config.title, usageLimitType: template.usageLimitType, usageLimit: 1,
    appliesTo: template.appliesTo, appliesToObjectIds: template.appliesToObjectIds,
    productDiscountType: config.discountType === "FIXED_AMOUNT" ? "Dollar Off" : "Percentage Off", productDiscount: discount,
    shippingDiscountType: "No Discount", shippingDiscount: null, status: "Enabled",
    minimumCartAmount: config.minimumSubtotalCents, availableTo: template.availableTo, availableToObjectIds: [customerTagId],
    startDate: startsAt.toISOString(), endDate: endsAt.toISOString(),
  };
}
export type CouponPayload = ReturnType<typeof buildCommerce7RewardCoupon>;
export function couponMatches(coupon: NativeCoupon, payload: CouponPayload) {
  return Object.entries(payload).every(([key, value]) => key === "code" ? coupon.code.toUpperCase() === String(value).toUpperCase() : JSON.stringify(coupon[key as keyof NativeCoupon]) === JSON.stringify(value));
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
    if (!response.ok) throw new Commerce7RewardError(response.status >= 500 || response.status === 429 ? "PROVIDER_UNAVAILABLE" : "WRITE_REJECTED", method !== "GET" && response.status >= 500);
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
  async tag(id: string) {
    const tag = parseTag(await this.request(`/tag/customer/${encodeURIComponent(id)}`));
    if (tag.id !== id) throw new Commerce7RewardError("INVALID_PROVIDER_RESPONSE");
    return tag;
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
  async createCoupon(payload: CouponPayload) {
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
