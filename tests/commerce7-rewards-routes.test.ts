import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { realAuthResolvers } from "../src/lib/auth-session";
import { GET } from "../src/app/api/rewards/commerce7/route";
import { POST as claim } from "../src/app/api/rewards/commerce7/claims/route";
import { POST as retry, DELETE as cancel } from "../src/app/api/rewards/commerce7/claims/[claimId]/route";
test("all claimant mutation routes reject anonymous requests before database/provider access", async (t) => {
  t.mock.method(realAuthResolvers, "resolveSession", async () => null);
  const request = new NextRequest("https://sqratch.example/api/rewards/commerce7"); const context = { params: Promise.resolve({ claimId: "foreign-claim" }) };
  for (const response of [await claim(request), await retry(request, context), await cancel(request, context)]) assert.equal(response.status, 401);
});
test("the anonymous listing is a safe empty state, not an error, and touches no database without an experience scope", async (t) => {
  t.mock.method(realAuthResolvers, "resolveSession", async () => null);
  const response = await GET(new NextRequest("https://sqratch.example/api/rewards/commerce7")); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { viewerState: "READY", offers: [], claims: [], points: null });
});
test("claim route rejects malformed or injected input before resolving campaigns or provisioning", async (t) => {
  t.mock.method(realAuthResolvers, "resolveSession", async () => ({ user: { id: "alice", role: "USER" } }));
  for (const body of [null, {}, { offerId: 7 }, { offerId: "offer", campaignId: { id: "foreign" } }, { offerId: "offer", experienceSlug: ["foreign"] }]) {
    const response = await claim(new NextRequest("https://sqratch.example/api/rewards/commerce7/claims", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
  }
});
