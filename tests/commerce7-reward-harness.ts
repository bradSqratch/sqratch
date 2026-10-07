import "./env-setup";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import ts from "typescript";
import * as domain from "../src/lib/commerce7-reward-domain";
import * as provider from "../src/lib/commerce/providers/commerce7-rewards-client";
import * as eligibility from "../src/lib/commerce7-reward-eligibility";
import * as couponContract from "../src/lib/commerce7-coupon-contract";

/**
 * Executes the actual saga (src/lib/commerce7-rewards.ts) with in-memory
 * persistence, the actual provider transport/parser and a fake Commerce7
 * tenant. No database connection or network request is possible; any provider
 * route the fake does not know throws, so an accidental call fails the test.
 */
export type Row = Record<string, unknown>;
export type Mode = "ANYONE_WITH_CODE" | "CLAIMANT_ONLY";
export const connection = { id: "connection", brandId: "brand", provider: "COMMERCE7", externalAccountId: "synthetic-tenant", status: "CONNECTED", uninstalledAt: null, currencyCode: "CAD", providerMetadata: { currencyCode: "CAD" } };
/** The body a Brand posts. There is deliberately no coupon template field. */
export const offerBody = { title: "Test reward", isActive: true, rewardMode: "DISCOUNT", pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: 1000, maxTotalRedemptions: 25, maxRedemptionsPerUser: 2, codeValidDays: 30, minimumSubtotalCents: null, appliesTo: "ALL_PRODUCTS", productIds: [] };
// Opaque, clearly non-Commerce7 values for branches the production contract leaves unverified.
export const OPAQUE_PRODUCT_SCOPE = "opaque-product-scope"; export const OPAQUE_CUSTOMER_TAG = "opaque-customer-tag";
export const verifiedContract: couponContract.CouponContract = { ...couponContract.COMMERCE7_COUPON_CONTRACT, appliesTo: { ...couponContract.COMMERCE7_COUPON_CONTRACT.appliesTo, SPECIFIC_PRODUCTS: OPAQUE_PRODUCT_SCOPE }, availableTo: { ...couponContract.COMMERCE7_COUPON_CONTRACT.availableTo, CLAIMANT_ONLY: OPAQUE_CUSTOMER_TAG } };

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some((part) => matches(row, part));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const rule = value as Row;
      if ("in" in rule) return (rule.in as unknown[]).includes(row[key]);
      if ("lt" in rule) return (row[key] as Date) < (rule.lt as Date);
      if ("gt" in rule) return Number(row[key]) > Number(rule.gt);
    }
    return row[key] === value;
  });
}

export type Tenant = ReturnType<typeof fakeTenant>;
/** A stateful fake Commerce7 tenant: customers, manual Customer tags and coupons. */
export function fakeTenant(options: { customers?: { id: string; email: string; tagIds?: string[] }[] } = {}) {
  const customers = (options.customers ?? []).map((c) => ({ ...c, tagIds: [...(c.tagIds ?? [])] }));
  const tags: { id: string; title: string }[] = []; const coupons: Row[] = [];
  const calls: { path: string; method: string; body: Row | null }[] = [];
  const customerJson = (c: (typeof customers)[number]) => ({ id: c.id, emails: [{ email: c.email }], tags: c.tagIds.map((id) => ({ id })) });
  const failures: { when: (path: string, method: string) => boolean; respond: (call: { path: string; method: string; body: Row | null }) => Response | Promise<Response> }[] = [];
  const state = {
    customers, tags, coupons, calls, failures,
    assignTag(customerId: string, tagId: string) { customers.find((c) => c.id === customerId)!.tagIds.push(tagId); },
    tagIdFor(index = 0) { return tags[index]?.id; },
    fetcher: (async (url, init) => {
      const target = new URL(String(url)); const path = target.pathname + target.search; const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Row : null;
      calls.push({ path, method, body });
      const failure = failures.find((entry) => entry.when(path, method)); if (failure) return failure.respond({ path, method, body });
      if (method === "GET" && target.pathname === "/v1/coupon") { const q = (target.searchParams.get("q") ?? "").toUpperCase(); const found = coupons.filter((c) => String(c.code).toUpperCase() === q); return Response.json({ coupons: found, total: found.length }); }
      if (method === "POST" && target.pathname === "/v1/coupon") {
        // Reads back the way a real tenant does: empty ID lists as "", absent discounts as null.
        const coupon = { id: `coupon-${coupons.length + 1}`, appliesToObjectIds: "", availableToObjectIds: "", shippingDiscount: null, minimumCartAmount: null, ...body }; coupons.push(coupon); return Response.json(coupon);
      }
      if (method === "GET" && target.pathname === "/v1/customer") {
        const tagId = target.searchParams.get("tagId"); const list = customers.filter((c) => !tagId || c.tagIds.includes(tagId)).map(customerJson);
        return Response.json({ customers: list, total: list.length });
      }
      const byId = /^\/v1\/customer\/([^/]+)$/.exec(target.pathname);
      if (method === "GET" && byId) { const found = customers.find((c) => c.id === byId[1]); return found ? Response.json(customerJson(found)) : new Response(null, { status: 404 }); }
      if (method === "GET" && target.pathname === "/v1/tag/customer") return Response.json({ tags: tags.map((t) => ({ ...t, type: "Manual", objectType: "Customer" })), total: tags.length });
      if (method === "POST" && target.pathname === "/v1/tag/customer") { const tag = { id: `tag-${tags.length + 1}`, title: String(body?.title) }; tags.push(tag); return Response.json({ ...tag, type: "Manual", objectType: "Customer" }); }
      throw new Error(`Unexpected provider operation ${method} ${path}`);
    }) as typeof fetch,
  };
  return state;
}

export type HarnessOptions = {
  mode?: Mode;
  /** NATIVE = template-free offer config. LEGACY = pre-refinement offer carrying the merchant's native template. */
  config?: "NATIVE" | "LEGACY_TEMPLATE";
  appliesTo?: "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS"; productIds?: string[];
  contract?: couponContract.CouponContract;
  tenant?: Tenant; transport?: typeof fetch;
  offer?: Row; user?: Row; startAt?: Date;
};
export function legacyTemplate(mode: Mode, scope: { appliesTo: string; ids: string[] | null } = { appliesTo: "Store", ids: null }): provider.NativeCoupon {
  return { id: "legacy-template", code: "legacy-template", title: "Merchant template", usageLimitType: "Per Store", usageLimit: 1, appliesTo: scope.appliesTo, appliesToObjectIds: scope.ids, productDiscountType: "Dollar Off", productDiscount: 1000, shippingDiscountType: "No Discount", shippingDiscount: null, startDate: "2026-01-01T00:00:00.000Z", endDate: null, status: "Enabled", minimumCartAmount: null, availableTo: mode === "ANYONE_WITH_CODE" ? "Everyone" : "legacy-customer-tag", availableToObjectIds: mode === "ANYONE_WITH_CODE" ? null : ["template-tag"] };
}
export function harness(options: HarnessOptions = {}) {
  const mode = options.mode ?? "ANYONE_WITH_CODE"; const appliesTo = options.appliesTo ?? "ALL_PRODUCTS"; const productIds = appliesTo === "ALL_PRODUCTS" ? [] : options.productIds ?? ["wine-a"];
  let now = options.startAt ?? new Date("2026-10-10T00:00:00.000Z");
  const config = options.config === "LEGACY_TEMPLATE"
    ? { eligibilityMode: mode, templateCouponId: "legacy-template", template: legacyTemplate(mode, appliesTo === "ALL_PRODUCTS" ? undefined : { appliesTo: OPAQUE_PRODUCT_SCOPE, ids: productIds }) }
    : { eligibilityMode: mode, discountEnabled: true };
  const tables: Record<string, Row[]> = {
    commerceConnection: [structuredClone(connection)],
    user: [{ id: "user", email: null, isActive: true, isEmailVerified: false, emailVerifiedAt: null, ...options.user }],
    brandRewardOffer: [{ ...offerBody, appliesTo, id: "offer", brandId: "brand", provider: "COMMERCE7", connectionId: "connection", sourceExternalAccountId: "synthetic-tenant", currencyCode: "CAD", reservedClaimCount: 0, discountPercentageBasisPoints: null, claimStartsAt: null, claimEndsAt: null, commerce7Config: config, ...options.offer }],
    commerceRewardRedemption: [],
    connectedCommerceProduct: ["wine-a", "wine-b", "wine-c"].map((externalId) => ({ id: `product-${externalId}`, brandId: "brand", connectionId: "connection", provider: "COMMERCE7", externalId, title: `Wine ${externalId}`, isAvailable: true })),
    brandRewardOfferProduct: productIds.map((externalProductId) => ({ id: `offer-product-${externalProductId}`, offerId: "offer", externalProductId, title: externalProductId })),
  };
  const ledger = new Map<string, string>(); let balance = 500;
  const db: Row = {};
  for (const name of Object.keys(tables)) {
    const find = (args: { where: Row }) => tables[name].find((row) => matches(row, args.where));
    const apply = (row: Row, data: Row) => { for (const [key, value] of Object.entries(data)) { const rule = provider.object(value); row[key] = rule && "increment" in rule ? Number(row[key] ?? 0) + Number(rule.increment) : rule && "decrement" in rule ? Number(row[key]) - Number(rule.decrement) : value; } };
    db[name] = {
      findFirst: async (args: { where: Row }) => structuredClone(find(args) ?? null),
      findUnique: async (args: { where: Row }) => structuredClone(find(args) ?? null),
      findUniqueOrThrow: async (args: { where: Row }) => { const row = find(args); assert.ok(row); return structuredClone(row); },
      findMany: async (args: { where: Row }) => structuredClone(tables[name].filter((row) => matches(row, args.where))),
      count: async (args: { where: Row }) => tables[name].filter((row) => matches(row, args.where)).length,
      create: async ({ data }: { data: Row }) => { const row = { id: `${name}-${tables[name].length}`, createdAt: now, provisioningOwner: null, providerLastCheckedAt: null, providerCustomerId: null, providerTagId: null, couponCreateAttempted: false, tagCreateAttempted: false, entitlementEverGranted: false, needsManualReview: false, slotReleased: false, reconcileAttempts: 0, lastReconcileReason: null, ...data }; tables[name].push(row); return structuredClone(row); },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => { const rows = tables[name].filter((row) => matches(row, where)); rows.forEach((row) => apply(row, data)); return { count: rows.length }; },
      update: async ({ where, data }: { where: Row; data: Row }) => { const row = find({ where }); assert.ok(row); apply(row, data); return structuredClone(row); },
      deleteMany: async () => ({ count: 0 }),
    };
  }
  db.$transaction = async (work: (tx: Row) => Promise<unknown>) => {
    const backup = structuredClone(tables); const oldBalance = balance; const oldLedger = new Map(ledger);
    try { return await work(db); } catch (error) { for (const name of Object.keys(tables)) tables[name] = backup[name]; balance = oldBalance; ledger.clear(); oldLedger.forEach((v, k) => ledger.set(k, v)); throw error; }
  };
  const tenant = options.tenant ?? fakeTenant();
  const transport: typeof fetch = options.transport ? (async (url, init) => { tenant.calls.push({ path: new URL(String(url)).pathname + new URL(String(url)).search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null }); return options.transport!(url, init); }) as typeof fetch : tenant.fetcher;
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  let clientsCreated = 0;
  const deps = { db, client: () => { clientsCreated++; return new provider.Commerce7RewardsClient("synthetic-tenant", transport); }, now: () => now, ...(options.contract ? { contract: options.contract } : {}) };
  const logs: unknown[] = []; const exports: typeof import("../src/lib/commerce7-rewards") = {} as never;
  const dependencies: Row = { "node:crypto": crypto, "@prisma/client": { Prisma }, "./prisma": { default: db }, "./commerce/connection-service": { getActiveCommerceConnection: async () => connection, isConnectionUsable: () => true }, "./commerce/providers/commerce7-rewards-client": provider, "./commerce7-reward-domain": domain, "./commerce7-reward-eligibility": eligibility, "./commerce7-coupon-contract": couponContract, "./points": { applyPointLedgerEvent: async (event: { idempotencyKey: string; type: string; points: number }) => {
    if (ledger.has(event.idempotencyKey)) return { applied: false, reason: "DUPLICATE" };
    if (event.type === "SPEND" && balance < event.points) return { applied: false, reason: "INSUFFICIENT_POINTS" };
    balance += event.type === "SPEND" ? -event.points : event.points; ledger.set(event.idempotencyKey, event.type); return { applied: true };
  } } };
  runInNewContext(ts.transpileModule(readFileSync("src/lib/commerce7-rewards.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Date, Set, Map, JSON, Math, Number, console: { warn: (value: unknown) => logs.push(value), error: (value: unknown) => logs.push(value) }, require(name: string) { assert.ok(name in dependencies, name); return dependencies[name]; },
  });
  const offer = () => tables.brandRewardOffer[0]; const claims = () => tables.commerceRewardRedemption;
  return { tables, tenant, calls: tenant.calls, logs, ledger, offer, claims, balance: () => balance, clientsCreated: () => clientsCreated, now: () => now,
    advance: (ms = 60000) => { now = new Date(now.getTime() + ms); }, setNow: (value: Date) => { now = value; },
    reserve: (key = "synthetic-request-key", userId = "user", brands = ["brand"]) => exports.reserveCommerce7Claim(userId, "offer", key, brands, deps as never),
    provision: (id: string, userId = "user") => exports.provisionCommerce7Claim(id, userId, deps as never),
    cancel: (id: string) => exports.cancelCommerce7Claim("user", id, deps as never),
    save: (body: unknown = offerBody, id?: string) => exports.saveCommerce7Offer("brand", body, id, deps as never),
    postBodies: () => tenant.calls.filter((call) => call.method === "POST" && call.path === "/v1/coupon").map((call) => call.body as Row),
  };
}
export type Harness = ReturnType<typeof harness>;
export const verifiedEmail = { email: "alice@example.test", isEmailVerified: true, emailVerifiedAt: new Date("2026-10-01T00:00:00.000Z") };
