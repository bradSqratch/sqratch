import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import * as domain from "../src/lib/commerce7-reward-domain";
import * as eligibility from "../src/lib/commerce7-reward-eligibility";
import * as viewer from "../src/lib/commerce7-reward-viewer";
import { object } from "../src/lib/commerce/providers/commerce7-rewards-client";
import * as couponContract from "../src/lib/commerce7-coupon-contract";

function load(path: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => Promise<Response>> = {};
  runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, URLSearchParams,
    require(name: string) { if (name === "next/server") return { NextRequest, NextResponse }; if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return exports;
}
const forbidden = (what: string) => async () => { throw new Error(`Private reward data was read: ${what}`); };
/** A viewer who has not earned any private reward data: reading offers, claims, points or connections throws. */
function listing(options: { session: unknown; context?: unknown; hasRewards?: boolean; private?: Record<string, unknown> }) {
  const reads: string[] = [];
  const db = {
    experience: { findUnique: async () => { reads.push("experience"); return { campaigns: [{ campaign: { brandId: "brand-a" } }, { campaign: { brandId: "brand-a" } }] }; } },
    campaign: { findUnique: async () => { reads.push("campaign"); return { brandId: "brand-a" }; } },
    brandRewardOffer: { count: async () => { reads.push("offerCount"); return options.hasRewards === false ? 0 : 2; }, findMany: options.private?.offers ?? forbidden("offers") },
    commerceRewardRedemption: { findMany: options.private?.claims ?? forbidden("claims"), count: options.private?.count ?? forbidden("claim count") },
    commerceConnection: { findMany: options.private?.connections ?? forbidden("connections") },
    connectedCommerceProduct: { findMany: options.private?.products ?? forbidden("products") },
  };
  const handler = load("src/app/api/rewards/commerce7/route.ts", {
    "@/lib/commerce7-reward-eligibility": eligibility, "@/lib/prisma": { __esModule: true, default: db },
    "@/lib/auth-session": { resolveSession: async () => options.session },
    "@/lib/reward-access": { getRewardClaimContext: async () => options.context ?? { ok: true, brandIds: ["brand-a"] } },
    "@/lib/points": { getUserSpendablePointBalance: options.private?.points ?? forbidden("points") },
    "@/lib/commerce/connection-service": { getActiveCommerceConnection: options.private?.active ?? forbidden("active connection"), isConnectionUsable: () => true },
    "@/lib/commerce7-reward-domain": domain, "@/lib/commerce7-reward-viewer": viewer, "@/lib/commerce/providers/commerce7-rewards-client": { object }, "@/lib/commerce7-coupon-contract": couponContract,
    "@/lib/commerce7-reward-http": { rewardErrorResponse: (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : "x" }, { status: 500 }) },
    "@/lib/commerce/providers/commerce7-connection-config": { validateCommerce7StorefrontUrl: () => ({ ok: false }) },
  });
  return { reads, get: (query = "experienceSlug=demo&campaignId=camp") => handler.GET(new NextRequest(`https://sqratch.example/api/rewards/commerce7?${query}`)) };
}
const safe = { offers: [], claims: [], points: null };

test("signed out: a safe SIGNED_OUT state with no private reward information and no private reads", async () => {
  const app = listing({ session: null }); const response = await app.get();
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, { viewerState: "SIGNED_OUT", ...safe });
  assert.deepEqual([...new Set(app.reads)].sort(), ["experience", "offerCount"], "only the existence of a Commerce7 program is consulted");
  const campaignOnly = listing({ session: null }); assert.equal((await (await campaignOnly.get("campaignId=camp")).json()).data.viewerState, "SIGNED_OUT");
});

test("logged in but locked: a safe LOCKED state with no private reward information and no private reads", async () => {
  for (const status of [403]) {
    const app = listing({ session: { user: { id: "alice" } }, context: { ok: false, status, error: "Unlock this experience before claiming rewards." } });
    const response = await app.get(); assert.equal(response.status, 200);
    const body = await response.json(); assert.deepEqual(body.data, { viewerState: "LOCKED", ...safe });
    assert.doesNotMatch(JSON.stringify(body), /Unlock this experience|brand-a|alice/);
  }
});

test("an experience without a Commerce7 rewards program gets no card at all, signed out or locked", async () => {
  for (const [session, context] of [[null, undefined], [{ user: { id: "alice" } }, { ok: false, status: 403, error: "x" }]] as const) {
    const app = listing({ session, context, hasRewards: false }); const data = (await (await app.get()).json()).data;
    assert.deepEqual(data, { viewerState: "READY", ...safe });
  }
  assert.equal(await viewer.commerce7RewardsApply({ experience: { findUnique: async () => null }, campaign: { findUnique: async () => null }, brandRewardOffer: { count: async () => { throw new Error("must not count without a Brand"); } } } as never, { experienceSlug: "missing" }), false);
  assert.equal(await viewer.commerce7RewardsApply({} as never, {}), false);
});

test("unlocked: the existing full data is unchanged, with the READY marker added", async () => {
  const offer = { id: "offer", title: "Reward", description: null, brandId: "brand-a", brand: { name: "Winery" }, products: [], connectionId: "conn", sourceExternalAccountId: "tenant", currencyCode: "CAD", pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: 1000, discountPercentageBasisPoints: null, minimumSubtotalCents: null, codeValidDays: 30, claimStartsAt: null, claimEndsAt: null, isActive: true, rewardMode: "DISCOUNT", appliesTo: "ALL_PRODUCTS", reservedClaimCount: 1, maxTotalRedemptions: 25, maxRedemptionsPerUser: 2, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE" } };
  const connection = { id: "conn", externalAccountId: "tenant", currencyCode: "CAD", storefrontUrl: null };
  const app = listing({ session: { user: { id: "alice" } }, private: { offers: async () => [offer], claims: async () => [], count: async () => 0, connections: async () => [], points: async () => 6, active: async () => connection } });
  const data = (await (await app.get()).json()).data;
  assert.equal(data.viewerState, "READY"); assert.equal(data.points, 6); assert.deepEqual(data.claims, []);
  assert.equal(data.offers.length, 1); assert.equal(data.offers[0].id, "offer"); assert.equal(data.offers[0].claimable, true); assert.equal(data.offers[0].remaining, 24); assert.equal(data.offers[0].brandName, "Winery");
});

test("other context failures (unknown experience) remain explicit errors for a signed-in user", async () => {
  const app = listing({ session: { user: { id: "alice" } }, context: { ok: false, status: 404, error: "Experience not found." } });
  const response = await app.get(); assert.equal(response.status, 404); assert.equal((await response.json()).error, "Experience not found.");
});

test("presentation only: every claim route still rejects anonymous, locked and wrong-context users", async () => {
  const claimsFor = (session: unknown, context: unknown, calls: string[]) => load("src/app/api/rewards/commerce7/claims/route.ts", {
    "@/lib/auth-session": { resolveSession: async () => session },
    "@/lib/reward-access": { getRewardClaimContext: async () => context },
    "@/lib/commerce7-rewards": { claimCommerce7Reward: async () => { calls.push("claim"); return { alreadyEligible: false, claim: { id: "claim" } }; } },
    "@/lib/commerce7-reward-domain": domain, "@/lib/commerce/providers/commerce7-rewards-client": { object },
    "@/lib/commerce7-reward-http": { rewardErrorResponse: () => NextResponse.json({ error: "controlled" }, { status: 500 }) },
  });
  const post = (handler: Record<string, (...a: unknown[]) => Promise<Response>>) => handler.POST(new NextRequest("https://sqratch.example/api/rewards/commerce7/claims", { method: "POST", body: JSON.stringify({ offerId: "offer", idempotencyKey: "browser-key-0001", experienceSlug: "demo", campaignId: "camp" }) }));
  const calls: string[] = [];
  assert.equal((await post(claimsFor(null, { ok: true, brandIds: ["brand-a"] }, calls))).status, 401);
  assert.equal((await post(claimsFor({ user: { id: "alice" } }, { ok: false, status: 403, error: "Unlock this experience before claiming rewards." }, calls))).status, 403);
  assert.equal((await post(claimsFor({ user: { id: "alice" } }, { ok: false, status: 404, error: "Campaign not found." }, calls))).status, 404);
  assert.deepEqual(calls, [], "no pre-check, reservation or provisioning without an unlocked, correctly scoped user");
  assert.equal((await post(claimsFor({ user: { id: "alice" } }, { ok: true, brandIds: ["brand-a"] }, calls))).status, 200); assert.deepEqual(calls, ["claim"]);
});

test("unlocked exclusive offers: storefront access with no tag, security or customer data, and drift makes them unclaimable", async () => {
  const TAG = "00000000-0000-4000-8000-0000000000b1";
  const base = { id: "exclusive", title: "Rare access", description: null, brandId: "brand-a", brand: { name: "Winery" }, products: [{ title: "Rare - 2015 Chardonnay", externalProductId: "rare" }], appliesTo: "SPECIFIC_PRODUCTS", connectionId: "conn", sourceExternalAccountId: "tenant", currencyCode: "CAD", pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: null, discountPercentageBasisPoints: null, minimumSubtotalCents: null, codeValidDays: 30, claimStartsAt: null, claimEndsAt: null, isActive: true, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", reservedClaimCount: 0, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveAccess: { productId: "rare", securityAvailableTo: "Tag", securityTagId: TAG, tagTitle: "Members" } } };
  const connection = { id: "conn", externalAccountId: "tenant", currencyCode: "CAD", storefrontUrl: null };
  const product = (security: unknown) => ({ brandId: "brand-a", connectionId: "conn", externalId: "rare", isAvailable: true, providerMetadata: { security } });
  const run = async (products: unknown[]) => (await (await listing({ session: { user: { id: "alice" } }, private: { offers: async () => [base], claims: async () => [], count: async () => 0, connections: async () => [], points: async () => 500, active: async () => connection, products: async () => products } }).get()).json());
  const ready = await run([product({ availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: [TAG] })]);
  const [offer] = ready.data.offers;
  assert.equal(offer.rewardMode, "EXCLUSIVE_PRODUCT_ACCESS"); assert.equal(offer.accessOnly, true); assert.equal(offer.claimable, true); assert.deepEqual(offer.productTitles, ["Rare - 2015 Chardonnay"]); assert.equal(offer.requiresManualEligibility, false);
  for (const secret of [TAG, "Members", "Display Product", "availableToObjectIds", "exclusiveAccess", "securityTagId"]) assert.ok(!JSON.stringify(ready).includes(secret), secret);
  const [multiTag] = (await run([product({ availableTo: "Tag", availableToObjectIds: [TAG, "second"] })])).data.offers;
  assert.equal(multiTag.claimable, true, "another tag on the product is not drift (verified OR semantics)");
  for (const drifted of [[product({ availableTo: "Public", availableToObjectIds: [] })], [product({ availableTo: "Tag", availableToObjectIds: ["second"] })], []]) {
    const [blocked] = (await run(drifted)).data.offers;
    assert.equal(blocked.claimable, false); assert.match(blocked.unavailableReason, /not available right now/);
  }
});

test("an active percentage offer is listed but not claimable while Commerce7 percentage units are unverified; fixed amounts are unaffected", async () => {
  const base = { title: "Reward", description: null, brandId: "brand-a", brand: { name: "Winery" }, products: [], connectionId: "conn", sourceExternalAccountId: "tenant", currencyCode: "CAD", pointsCost: 100, minimumSubtotalCents: null, codeValidDays: 7, claimStartsAt: null, claimEndsAt: null, isActive: true, rewardMode: "DISCOUNT", appliesTo: "ALL_PRODUCTS", reservedClaimCount: 0, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true } };
  const offers = [{ ...base, id: "percent", discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 }, { ...base, id: "fixed", discountType: "FIXED_AMOUNT", discountAmountCents: 1000, discountPercentageBasisPoints: null }];
  const connection = { id: "conn", externalAccountId: "tenant", currencyCode: "CAD", storefrontUrl: null };
  const data = (await (await listing({ session: { user: { id: "alice" } }, private: { offers: async () => offers, claims: async () => [], count: async () => 0, connections: async () => [], points: async () => 500, active: async () => connection } }).get()).json()).data;
  const byId = Object.fromEntries(data.offers.map((offer: Record<string, unknown>) => [offer.id, offer]));
  assert.equal(byId.percent.claimable, false); assert.match(byId.percent.unavailableReason, /temporarily unavailable/); assert.equal(byId.percent.discountPercentageBasisPoints, 1500, "15% is still presented as 15%");
  assert.equal(byId.fixed.claimable, true);
});
