import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMERCE7_EDIT_SAFE_CLAIM, commerce7ClaimAllowsOfferEdit, commerce7OfferEditable } from "../src/lib/commerce7-reward-domain";
import { harness, offerBody, type Harness, type Row } from "./commerce7-reward-harness";

const rejectCouponCreate = (app: Harness) => app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => new Response(JSON.stringify({ statusCode: 422, type: "validationError" }), { status: 422 }) });
const edit = (app: Harness, change: Row = {}) => app.save({ ...offerBody, title: "Edited title", discountAmountCents: 2500, ...change }, "offer");

test("the safe-claim definition is exactly a provably dead claim, and every single deviation blocks editing", () => {
  const dead = { ...COMMERCE7_EDIT_SAFE_CLAIM };
  assert.equal(commerce7ClaimAllowsOfferEdit(dead), true);
  const deviations: Row = { status: "ISSUED", provisioningState: "MANUAL_REVIEW", slotReleased: false, entitlementEverGranted: true, couponCreateAttempted: true, needsManualReview: true, provisioningOwner: "worker", externalDiscountId: "coupon", canonicalOrderId: "order", usedAt: new Date() };
  for (const [key, value] of Object.entries(deviations)) assert.equal(commerce7ClaimAllowsOfferEdit({ ...dead, [key]: value }), false, key);
  for (const status of ["POINTS_DEBITED", "ISSUED", "USED", "EXPIRED", "CANCELLED"]) assert.equal(commerce7ClaimAllowsOfferEdit({ ...dead, status }), false, status);
  // A missing or null provisioning state is not proof of anything: it blocks (this is why the filter is positive, not a SQL NOT).
  assert.equal(commerce7ClaimAllowsOfferEdit({ ...dead, provisioningState: null }), false); assert.equal(commerce7ClaimAllowsOfferEdit({ ...dead, provisioningState: undefined }), false);
  assert.equal(commerce7OfferEditable(0, 0, 0), true); assert.equal(commerce7OfferEditable(0, 3, 3), true);
  assert.equal(commerce7OfferEditable(1, 3, 3), false, "a live reservation always locks"); assert.equal(commerce7OfferEditable(0, 3, 2), false);
});

test("an offer whose only claim was definitively rejected by the provider (REFUNDED / FAILED_FINAL) can be edited; the claim is untouched", async () => {
  const app = harness(); rejectCouponCreate(app);
  const failed = await app.reserve(); assert.equal((await app.provision(failed.id))?.status, "REFUNDED");
  const claimBefore = JSON.stringify(app.claims()); const ledgerBefore = JSON.stringify([...app.ledger]); const callsBefore = app.calls.length;
  const saved = await edit(app);
  assert.equal(saved.title, "Edited title"); assert.equal(saved.discountAmountCents, 2500);
  assert.equal(JSON.stringify(app.claims()), claimBefore, "history and its frozen snapshot never change"); assert.equal(JSON.stringify([...app.ledger]), ledgerBefore);
  assert.equal(app.claims()[0].status, "REFUNDED"); assert.equal(app.claims()[0].provisioningState, "FAILED_FINAL"); assert.equal((app.claims()[0].rewardConfigSnapshot as Row & { discount: Row }).discount.amountCents, 1000);
  assert.equal(app.calls.length, callsBefore, "editing makes no Commerce7 call"); assert.equal(app.clientsCreated(), 1, "only the earlier claim used a client");
});

test("after the edit, new claims use the new terms while the refunded claim keeps its old snapshot", async () => {
  const app = harness(); rejectCouponCreate(app);
  const failed = await app.reserve(); await app.provision(failed.id); app.tenant.failures.length = 0;
  await edit(app); const next = await app.reserve("a-new-request-key-00001");
  assert.equal((next.rewardConfigSnapshot as Row & { discount: Row }).discount.amountCents, 2500);
  assert.equal((app.claims().find((claim) => claim.id === failed.id)!.rewardConfigSnapshot as Row & { discount: Row }).discount.amountCents, 1000);
});

test("an offer whose claims were all safely cancelled before issuance can be edited", async () => {
  const app = harness(); const a = await app.reserve(); await app.cancel(a.id); const b = await app.reserve("another-request-key-0002"); await app.cancel(b.id);
  assert.equal(app.offer().reservedClaimCount, 0); assert.equal((await edit(app)).title, "Edited title"); assert.equal(app.calls.length, 0);
});

test("the offer stays immutable when any claim is or ever was economically or provider-active", async () => {
  const cases: [string, (app: Harness) => Promise<void>][] = [
    ["points still reserved / pending", async (app) => { await app.reserve(); }],
    ["issued coupon", async (app) => { const c = await app.reserve(); await app.provision(c.id); }],
    ["ambiguous provider write (manual review)", async (app) => { app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => { throw new Error("socket hang up"); } }); const c = await app.reserve(); await app.provision(c.id); }],
    ["used coupon", async (app) => { const c = await app.reserve(); await app.provision(c.id); Object.assign(app.claims()[0], { status: "USED", usedAt: new Date(), canonicalOrderId: "order" }); }],
    ["expired coupon", async (app) => { const c = await app.reserve(); await app.provision(c.id); app.claims()[0].status = "EXPIRED"; }],
    ["revoked coupon", async (app) => { const c = await app.reserve(); await app.provision(c.id); Object.assign(app.claims()[0], { status: "CANCELLED", provisioningState: "REVOKED" }); }],
    ["active provisioning owner", async (app) => { const c = await app.reserve(); await app.cancel(c.id); app.claims()[0].provisioningOwner = "running-worker"; }],
    ["refund recorded but capacity not released", async (app) => { const c = await app.reserve(); await app.cancel(c.id); app.claims()[0].slotReleased = false; }],
    ["a dead claim next to an issued one", async (app) => { rejectCouponCreate(app); const dead = await app.reserve(); await app.provision(dead.id); app.tenant.failures.length = 0; const live = await app.reserve("a-second-request-key-002"); await app.provision(live.id); }],
  ];
  for (const [name, arrange] of cases) {
    const app = harness(); await arrange(app);
    const before = JSON.stringify(app.offer()); const callsBefore = app.calls.length;
    await assert.rejects(edit(app), { code: "OFFER_HAS_CLAIMS" }, name);
    assert.equal(JSON.stringify(app.offer()), before, name); assert.equal(app.calls.length, callsBefore, name);
  }
});

test("the editability rule is enforced on the server, regardless of what the UI shows", async () => {
  const app = harness(); const c = await app.reserve(); await app.provision(c.id);
  // A forged edit request (as if the Edit button had been enabled) is still refused and changes nothing.
  await assert.rejects(app.save({ ...offerBody, maxTotalRedemptions: 1000, pointsCost: 1 }, "offer"), { code: "OFFER_HAS_CLAIMS" });
  assert.equal(app.offer().pointsCost, 100); assert.equal(app.offer().maxTotalRedemptions, 25);
});
