import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import * as domain from "../src/lib/commerce7-reward-domain";
import { object } from "../src/lib/commerce/providers/commerce7-rewards-client";

const stub = new Proxy({}, { get() { return () => { throw new Error("Unexpected call into an unrelated module"); }; } });
function patchRoute(offers: Record<string, Record<string, unknown>>, brandId = "brand") {
  const calls: { service: unknown[][]; updates: unknown[]; lookups: unknown[] } = { service: [], updates: [], lookups: [] };
  const exports: Record<string, (...args: unknown[]) => Promise<Response>> = {};
  const dependencies: Record<string, unknown> = {
    "@/lib/commerce7-rewards": { setCommerce7OfferActive: async (...args: unknown[]) => { calls.service.push(args); if (args[2] === "ENABLE" && args[1] === "unsupported") throw new domain.RewardClaimError("COUPON_CONTRACT_UNVERIFIED", "Draft only.", 409); return { id: args[1], isActive: args[2] === "ENABLE", rewardMode: "DISCOUNT", commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true, templateCouponId: "secret-template", template: { id: "secret" } } }; }, saveCommerce7Offer: stub },
    "@/lib/commerce7-reward-domain": domain,
    "@/lib/commerce7-reward-http": { rewardErrorResponse: (error: unknown) => NextResponse.json({ error: (error as Error).message, code: (error as { code?: string }).code }, { status: (error as { status?: number }).status ?? 500 }) },
    "@/lib/commerce/providers/commerce7-rewards-client": { object },
    "@prisma/client": { CommerceProvider: { SHOPIFY: "SHOPIFY", COMMERCE7: "COMMERCE7" } },
    "@/lib/brand-auth": { getBrandManagementContext: async () => ({ membership: { brand: { id: brandId } } }), getBrandContextFailure: () => ({ error: "no", status: 403 }) },
    "@/lib/prisma": { __esModule: true, default: { brandRewardOffer: {
      findFirst: async (query: { where: { id: string; brandId: string } }) => { calls.lookups.push(query); const row = offers[query.where.id]; return row && row.brandId === query.where.brandId ? row : null; },
      update: async (query: unknown) => { calls.updates.push(query); return { id: "shopify-offer", isActive: false, products: [] }; },
    } } },
    "@/lib/shopify": stub, "@/lib/shopify-token-manager": stub, "@/lib/commerce/connection-service": stub, "@/lib/shopify-reward-compatibility": stub,
    "@/lib/reward-offers": { serializeRewardOffer: (offer: unknown) => ({ shopify: true, ...(offer as object) }), resolveRewardOfferUpdate: stub, validateProductsBelongToConnectedStore: stub },
  };
  runInNewContext(ts.transpileModule(readFileSync("src/app/api/brand/rewards/offers/[offerId]/route.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, console: { error() {} }, require(name: string) { if (name === "next/server") return { NextRequest, NextResponse }; if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; },
  });
  const patch = (id: string, body?: unknown) => exports.PATCH(new NextRequest(`https://sqratch.example/api/brand/rewards/offers/${id}`, { method: "PATCH", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }), { params: Promise.resolve({ offerId: id }) });
  return { calls, patch };
}
const offers = { c7: { id: "c7", brandId: "brand", provider: "COMMERCE7" }, unsupported: { id: "unsupported", brandId: "brand", provider: "COMMERCE7" }, shopify: { id: "shopify", brandId: "brand", provider: "SHOPIFY" }, foreign: { id: "foreign", brandId: "other-brand", provider: "COMMERCE7" } };

test("Commerce7 DISABLE and ENABLE are explicit server actions scoped to the authenticated Brand; the raw row is never updated by the route", async () => {
  const app = patchRoute(offers);
  for (const action of ["DISABLE", "ENABLE"]) { const response = await app.patch("c7", { action, brandId: "forged", isActive: true }); assert.equal(response.status, 200); assert.equal((await response.json()).data.isActive, action === "ENABLE"); }
  assert.deepEqual(app.calls.service, [["brand", "c7", "DISABLE"], ["brand", "c7", "ENABLE"]]); assert.equal(app.calls.updates.length, 0);
});

test("a Commerce7 PATCH without a body keeps its historical meaning (disable); anything else is forwarded verbatim for validation, never coerced", async () => {
  const app = patchRoute(offers);
  await app.patch("c7"); for (const body of [{ action: true }, { action: "toggle" }, {}, []]) await app.patch("c7", body);
  assert.deepEqual(app.calls.service.map((call) => call[2]), ["DISABLE", true, "toggle", undefined, undefined]);
});

test("the Brand response never carries the stored provider configuration", async () => {
  const app = patchRoute(offers); const body = JSON.stringify(await (await app.patch("c7", { action: "ENABLE" })).json());
  assert.doesNotMatch(body, /secret|templateCouponId|template/); assert.match(body, /ANYONE_WITH_CODE/);
});

test("a refused enable returns the safe error and the route changes nothing itself", async () => {
  const app = patchRoute(offers); const response = await app.patch("unsupported", { action: "ENABLE" });
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: "Draft only.", code: "COUPON_CONTRACT_UNVERIFIED" }); assert.equal(app.calls.updates.length, 0);
});

test("another Brand's offer is not found and never reaches the service", async () => {
  const app = patchRoute(offers); const response = await app.patch("foreign", { action: "ENABLE" });
  assert.equal(response.status, 404); assert.equal(app.calls.service.length, 0); assert.equal(app.calls.updates.length, 0);
});

test("Shopify offers are unchanged: PATCH ignores the body and disables exactly as before, without the Commerce7 service", async () => {
  for (const body of [undefined, {}, { action: "ENABLE" }]) {
    const app = patchRoute(offers); const response = await app.patch("shopify", body);
    assert.equal(response.status, 200); assert.equal(app.calls.service.length, 0);
    assert.equal(JSON.stringify(app.calls.updates), JSON.stringify([{ where: { id: "shopify" }, data: { isActive: false }, include: { products: true } }]));
  }
});
