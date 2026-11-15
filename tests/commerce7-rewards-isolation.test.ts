import "./env-setup";
import { assertExpectedBrand } from "../src/lib/brand-auth";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { object } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { requireValue, RewardClaimError } from "../src/lib/commerce7-reward-domain";

function route(path: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => Promise<Response>> = {};
  runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    require(name: string) {
      if (name === "next/server") return { NextRequest, NextResponse };
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}
const errorResponse = { rewardErrorResponse: (error: unknown) => NextResponse.json({ error: "Controlled error" }, { status: error instanceof RewardClaimError ? error.status : 500 }) };

test("claim route forwards only authenticated user, persisted offer key and server-resolved Brands", async () => {
  let claimed: unknown[] = [];
  const handler = route("src/app/api/rewards/commerce7/claims/route.ts", {
    "@/lib/auth-session": { resolveSession: async () => ({ user: { id: "authenticated-alice" } }) },
    "@/lib/reward-access": { getRewardClaimContext: async () => ({ ok: true, brandIds: ["server-brand"] }) },
    "@/lib/commerce7-rewards": { claimCommerce7Reward: async (...args: unknown[]) => { claimed = args; return { alreadyEligible: false, claim: { id: "reserved-claim" } }; } },
    "@/lib/commerce7-reward-domain": { requireValue, serializeCommerce7Claim: (value: unknown) => value },
    "@/lib/commerce/providers/commerce7-rewards-client": { object },
    "@/lib/commerce7-reward-http": errorResponse,
  });
  const response = await handler.POST(new NextRequest("https://sqratch.example/api/rewards/commerce7/claims", { method: "POST", body: JSON.stringify({ offerId: "selected-offer", idempotencyKey: "stable-browser-key", userId: "bob", brandId: "foreign-brand", connectionId: "foreign-connection", tenant: "foreign-tenant", email: "bob@example.test", providerCustomerId: "bob", pointsCost: 0, discountAmountCents: 999999, code: "FORGED" }) }));
  assert.equal(response.status, 200);
  // The pre-check, reservation and provisioning all receive only the session user, the offer key and server-resolved Brands.
  assert.deepEqual(claimed, ["authenticated-alice", "selected-offer", "stable-browser-key", ["server-brand"]]);
});

test("Brand claim operations reject missing/wrong-role management context before lookup or provider access", async () => {
  const handler = route("src/app/api/brand/rewards/commerce7/claims/[claimId]/route.ts", {
    "@/lib/prisma": { __esModule: true, default: new Proxy({}, { get() { throw new Error("Unauthorized database access"); } }) },
    "@/lib/brand-auth": { assertExpectedBrand, getBrandManagementContext: async () => null, getBrandContextFailure: () => ({ error: "Brand admin access required.", status: 403 }) },
    "@/lib/commerce7-rewards": {},
    "@/lib/commerce/providers/commerce7-rewards-client": {},
    "@/lib/commerce7-reward-domain": { RewardClaimError },
    "@/lib/commerce7-reward-http": errorResponse,
  });
  assert.equal((await handler.POST(new NextRequest("https://sqratch.example/api/brand/rewards/commerce7/claims/foreign", { method: "POST", body: JSON.stringify({ action: "REVOKE" }) }), { params: Promise.resolve({ claimId: "foreign" }) })).status, 403);
});

test("Brand native revoke pins the original connection, provider, Brand and coupon ID", async () => {
  const queries: unknown[] = []; const native: unknown[] = [];
  const claim = { id: "claim", brandId: "server-brand", provider: "COMMERCE7", connectionId: "original-connection", externalAccountId: "original-tenant", status: "ISSUED", externalDiscountId: "original-coupon" };
  const handler = route("src/app/api/brand/rewards/commerce7/claims/[claimId]/route.ts", {
    "@/lib/prisma": { __esModule: true, default: { commerceRewardRedemption: { findFirst: async (query: unknown) => { queries.push(query); return claim; }, updateMany: async (query: unknown) => { queries.push(query); return { count: 1 }; } }, commerceConnection: { findFirst: async (query: unknown) => { queries.push(query); return { externalAccountId: "original-tenant" }; } } } },
    "@/lib/brand-auth": { assertExpectedBrand, getBrandManagementContext: async () => ({ membership: { brand: { id: "server-brand" } } }) },
    "@/lib/commerce7-rewards": {},
    "@/lib/commerce/providers/commerce7-rewards-client": { object, Commerce7RewardsClient: class { constructor(tenant: string) { native.push(tenant); } async revokeCoupon(id: string) { native.push(id); } } },
    "@/lib/commerce7-reward-domain": { RewardClaimError },
    "@/lib/commerce7-reward-http": errorResponse,
  });
  assert.equal((await handler.POST(new NextRequest("https://sqratch.example/api/brand/rewards/commerce7/claims/claim", { method: "POST", body: JSON.stringify({ action: "REVOKE", brandId: "foreign", tenant: "foreign", externalDiscountId: "foreign" }) }), { params: Promise.resolve({ claimId: "claim" }) })).status, 200);
  assert.equal(JSON.stringify(queries[0]), JSON.stringify({ where: { id: "claim", brandId: "server-brand", provider: "COMMERCE7" } }));
  assert.equal(JSON.stringify(queries[1]), JSON.stringify({ where: { id: "original-connection", brandId: "server-brand", provider: "COMMERCE7", externalAccountId: "original-tenant", status: "CONNECTED", uninstalledAt: null } }));
  assert.deepEqual(native, ["original-tenant", "original-coupon"]);
});
test("account deletion retains reward history in a serializable transaction", async () => {
  for (const rewardCount of [1, 0]) {
    let deleted = 0; const counts: unknown[] = []; let transactionOptions: unknown;
    const tx = {
      user: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "admin" ? { role: "ADMIN", isActive: true } : { id: "alice", role: "USER", isActive: true, imageUrl: null }, delete: async () => { deleted++; } },
      campaign: { count: async () => 0 }, qRCode: { count: async () => 0 }, pointTransaction: { count: async () => 0 },
      commerceRewardRedemption: { count: async (query: unknown) => { counts.push(query); return rewardCount; } },
    };
    const service = route("src/lib/admin-user-mutations.ts", { "@/lib/prisma": { __esModule: true, default: { $transaction: async (work: (tx: unknown) => Promise<unknown>, options: unknown) => { transactionOptions = options; return work(tx); } } } });
    const result = service.deleteUser({ actorId: "admin", targetId: "alice" });
    if (rewardCount) await assert.rejects(result, (error: unknown) => (error as Error).message === "USER_HAS_HISTORY");
    else await result;
    assert.equal(deleted, rewardCount ? 0 : 1);
    assert.equal(JSON.stringify(counts), JSON.stringify([{ where: { userId: "alice" } }]));
    assert.equal(JSON.stringify(transactionOptions), JSON.stringify({ isolationLevel: "Serializable" }));
  }
});
