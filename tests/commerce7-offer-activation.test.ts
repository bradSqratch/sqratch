import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeTenant, harness, verifiedContract, verifiedEmail, connection, type Harness, type Row } from "./commerce7-reward-harness";

/** The offer's economic terms: everything a toggle must leave alone. */
const terms = (offer: Row) => JSON.stringify({ ...offer, isActive: undefined, updatedAt: undefined });
const writes = (app: Harness, since = 0) => app.offerWrites.slice(since);

test("DISABLE turns an active offer off and touches nothing else; DISABLE again is an idempotent no-op", async () => {
  const app = harness(); const before = terms(app.offer());
  assert.equal((await app.setActive("DISABLE")).isActive, false); assert.equal(app.offer().isActive, false); assert.equal(terms(app.offer()), before);
  const written = app.offerWrites.length; assert.equal((await app.setActive("DISABLE")).isActive, false); assert.equal(writes(app, written).length, 0, "no second write");
  assert.equal(app.calls.length, 0); assert.equal(app.clientsCreated(), 0);
});

test("ENABLE turns an inactive offer on after revalidation; ENABLE again is an idempotent no-op", async () => {
  const app = harness({ offer: { isActive: false } }); const before = terms(app.offer());
  assert.equal((await app.setActive("ENABLE")).isActive, true); assert.equal(app.offer().isActive, true); assert.equal(terms(app.offer()), before);
  const written = app.offerWrites.length; assert.equal((await app.setActive("ENABLE")).isActive, true); assert.equal(writes(app, written).length, 0, "no second write");
});

test("the toggle is explicit and never a blind flip: unknown actions are rejected and change nothing", async () => {
  const app = harness();
  for (const action of [undefined, null, "", "TOGGLE", "enable", true, 1, { action: "ENABLE" }]) await assert.rejects(app.setActive(action), { code: "INVALID_ACTION" });
  assert.equal(app.offer().isActive, true); assert.equal(app.offerWrites.length, 0);
});

test("an offer with historical redemptions can be disabled and re-enabled, and no claim, snapshot, point or capacity changes", async () => {
  const app = harness(); const claim = await app.reserve(); await app.provision(claim.id);
  const claimBefore = JSON.stringify(app.claims()); const snapshotBefore = JSON.stringify(app.claims()[0].rewardConfigSnapshot); const ledgerBefore = JSON.stringify([...app.ledger]); const callsBefore = app.calls.length;
  const reserved = app.offer().reservedClaimCount; const balance = app.balance();
  await app.setActive("DISABLE"); assert.equal(app.offer().isActive, false);
  await assert.rejects(app.reserve("a-different-request-key"), { code: "INACTIVE" });
  await app.setActive("ENABLE"); assert.equal(app.offer().isActive, true);
  assert.equal(JSON.stringify(app.claims()), claimBefore); assert.equal(JSON.stringify(app.claims()[0].rewardConfigSnapshot), snapshotBefore);
  assert.equal(JSON.stringify([...app.ledger]), ledgerBefore); assert.equal(app.offer().reservedClaimCount, reserved); assert.equal(app.balance(), balance);
  assert.equal(app.calls.length, callsBefore, "toggling never contacts Commerce7"); assert.equal(app.claims()[0].status, "ISSUED", "an issued coupon is not revoked");
  assert.equal((await app.reserve("a-different-request-key")).offerId, "offer", "a re-enabled offer is claimable again");
});

test("DISABLE is always available, even when the store is disconnected or the stored configuration is broken", async () => {
  const app = harness({ offer: { commerce7Config: { eligibilityMode: "invented" } } });
  app.environment.active = null; app.environment.backend = false; app.tables.commerceConnection[0].status = "DISCONNECTED";
  assert.equal((await app.setActive("DISABLE")).isActive, false);
});

test("draft-only branches cannot be enabled: native claimant-only and unconfigured exclusive access stay inactive; selected products now enable", async () => {
  const claimant = harness({ mode: "CLAIMANT_ONLY", offer: { isActive: false } });
  await assert.rejects(claimant.setActive("ENABLE"), { code: "COUPON_CONTRACT_UNVERIFIED" }); assert.equal(claimant.offer().isActive, false); assert.equal(claimant.offerWrites.length, 0);
  const selected = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], offer: { isActive: false } });
  assert.equal((await selected.setActive("ENABLE")).isActive, true, "the live 201 proved the Product scope");
  // An exclusive offer with no frozen product and Customer Tag is never enabled (configured ones: commerce7-exclusive-claims.test.ts).
  const exclusive = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], offer: { isActive: false, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", maxTotalRedemptions: 25 } });
  await assert.rejects(exclusive.setActive("ENABLE"), { code: "INVALID_OFFER" }); assert.equal(exclusive.offer().isActive, false);
  for (const app of [claimant, selected, exclusive]) { assert.equal(app.calls.length, 0); assert.equal(app.clientsCreated(), 0); }
});

test("a legacy offer keeps its observed native evidence and can be re-enabled; a proven contract enables the same branch without a template", async () => {
  const legacy = harness({ mode: "CLAIMANT_ONLY", config: "LEGACY_TEMPLATE", offer: { isActive: false } });
  assert.equal((await legacy.setActive("ENABLE")).isActive, true);
  const proven = harness({ mode: "CLAIMANT_ONLY", contract: verifiedContract, offer: { isActive: false }, user: verifiedEmail });
  assert.equal((await proven.setActive("ENABLE")).isActive, true); assert.equal(proven.calls.length, 0);
  const tampered = harness({ mode: "CLAIMANT_ONLY", config: "LEGACY_TEMPLATE", offer: { isActive: false } });
  (tampered.offer().commerce7Config as Row).template = { not: "a native coupon" };
  await assert.rejects(tampered.setActive("ENABLE"), { code: "INVALID_OFFER" }); assert.equal(tampered.offer().isActive, false);
});

test("a disconnected, replaced, unusable or mismatched store cannot be used to enable an offer", async () => {
  const cases: [string, (app: Harness) => void, string][] = [
    ["connection disconnected", (app) => { app.tables.commerceConnection[0].status = "DISCONNECTED"; }, "CONNECTION_UNAVAILABLE"],
    ["connection uninstalled", (app) => { app.tables.commerceConnection[0].uninstalledAt = new Date(); }, "CONNECTION_UNAVAILABLE"],
    ["no active connection", (app) => { app.environment.active = null; }, "CONNECTION_UNAVAILABLE"],
    ["connection not usable", (app) => { app.environment.usable = false; }, "CONNECTION_UNAVAILABLE"],
    ["a different current connection", (app) => { app.environment.active = { ...connection, id: "another-connection" }; }, "CONNECTION_UNAVAILABLE"],
    ["a different store identity", (app) => { app.environment.active = { ...connection, externalAccountId: "another-tenant" }; }, "CONNECTION_UNAVAILABLE"],
    ["offer pinned to another connection", (app) => { app.offer().connectionId = "foreign-connection"; }, "CONNECTION_UNAVAILABLE"],
    ["offer pinned to another store", (app) => { app.offer().sourceExternalAccountId = "foreign-tenant"; }, "CONNECTION_UNAVAILABLE"],
    ["store currency changed", (app) => { app.environment.active = { ...connection, currencyCode: "USD" }; }, "CURRENCY_REVIEW_REQUIRED"],
    ["backend credentials missing", (app) => { app.environment.backend = false; }, "SETUP_INCOMPLETE"],
  ];
  for (const [name, arrange, code] of cases) {
    const app = harness({ offer: { isActive: false } }); arrange(app);
    await assert.rejects(app.setActive("ENABLE"), { code }, name); assert.equal(app.offer().isActive, false, name); assert.equal(app.offerWrites.length, 0, name); assert.equal(app.calls.length, 0, name);
  }
});

test("stored limits and configuration are revalidated, and an invalid offer stays inactive with a safe message", async () => {
  const broken: [string, Row][] = [
    ["claim cap above the limit", { maxTotalRedemptions: 5000 }], ["per-user above total", { maxRedemptionsPerUser: 30 }], ["window inverted", { claimStartsAt: new Date("2026-11-01"), claimEndsAt: new Date("2026-10-01") }],
    ["non-positive discount", { discountAmountCents: 0 }], ["fraction of a percent", { discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1550 }], ["validity out of range", { codeValidDays: 0 }],
    ["unverified currency exponent", { currencyCode: "JPY" }], ["unparseable config", { commerce7Config: { eligibilityMode: "invented" } }], ["missing config", { commerce7Config: null }],
  ];
  for (const [name, change] of broken) {
    const app = harness({ offer: { isActive: false, ...change } });
    if (change.currencyCode) app.environment.active = { ...connection, currencyCode: change.currencyCode };
    const failure = await app.setActive("ENABLE").then(() => null, (error: Error & { code?: string }) => error);
    assert.ok(failure, name); assert.ok(["INVALID_OFFER", "CURRENCY_REVIEW_REQUIRED"].includes(String(failure.code)), `${name}: ${failure.code}`);
    assert.doesNotMatch(failure.message, /template|enum|appliesTo|availableTo|Commerce7 API/i, name); assert.equal(app.offer().isActive, false, name); assert.equal(app.offerWrites.length, 0, name);
  }
});

test("selected-product offers also require every product to remain synchronized before enabling", async () => {
  const app = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], contract: verifiedContract, offer: { isActive: false } });
  app.tables.connectedCommerceProduct.find((product) => product.externalId === "wine-a")!.isAvailable = false;
  await assert.rejects(app.setActive("ENABLE"), { code: "INVALID_OFFER" }); assert.equal(app.offer().isActive, false);
  app.tables.connectedCommerceProduct.find((product) => product.externalId === "wine-a")!.isAvailable = true;
  assert.equal((await app.setActive("ENABLE")).isActive, true);
});

test("Brand and provider isolation: another Brand, another provider or an unknown offer cannot be toggled", async () => {
  const app = harness({ offer: { isActive: false } });
  await assert.rejects(app.setActive("ENABLE", "offer", "other-brand"), { code: "NOT_FOUND", status: 404 }); await assert.rejects(app.setActive("DISABLE", "offer", "other-brand"), { code: "NOT_FOUND" });
  await assert.rejects(app.setActive("ENABLE", "unknown-offer"), { code: "NOT_FOUND" });
  app.offer().provider = "SHOPIFY"; await assert.rejects(app.setActive("ENABLE"), { code: "NOT_FOUND" }); await assert.rejects(app.setActive("DISABLE"), { code: "NOT_FOUND" });
  assert.equal(app.offer().isActive, false); assert.equal(app.offerWrites.length, 0);
});

test("enabling and disabling never create, read or delete any Commerce7 resource", async () => {
  const tenant = fakeTenant(); const app = harness({ tenant, offer: { isActive: false } });
  await app.setActive("ENABLE"); await app.setActive("DISABLE"); await app.setActive("ENABLE");
  assert.equal(tenant.calls.length, 0); assert.equal(tenant.coupons.length, 0); assert.equal(tenant.tags.length, 0); assert.equal(app.clientsCreated(), 0); assert.equal(app.logs.length, 0);
});

// ── Transaction boundaries (regression: "A query cannot be executed on an expired transaction") ──

test("ENABLE runs connection and configuration validation outside any transaction, then commits in one short transaction", async () => {
  const app = harness({ offer: { isActive: false } });
  assert.equal((await app.setActive("ENABLE")).isActive, true);
  assert.ok(app.environment.connectionLookups.length >= 1);
  assert.ok(app.environment.connectionLookups.every((lookup) => !lookup.insideTransaction), "connection resolution must never run inside an interactive transaction");
  assert.equal(app.txState.opened, 1, "exactly one short transaction"); assert.equal(app.txState.open, 0);
});

test("a validation failure opens no transaction at all", async () => {
  for (const arrange of [(app: Harness) => { app.environment.active = null; }, (app: Harness) => { app.environment.backend = false; }, (app: Harness) => { app.offer().commerce7Config = { eligibilityMode: "CLAIMANT_ONLY" }; }]) {
    const app = harness({ offer: { isActive: false } }); arrange(app);
    await assert.rejects(app.setActive("ENABLE")); assert.equal(app.txState.opened, 0); assert.equal(app.offer().isActive, false);
  }
});

test("if the offer or its connection changes between validation and commit, ENABLE fails closed and the offer stays inactive", async () => {
  const changes: [string, (app: Harness) => void][] = [
    ["connection disconnected", (app) => { app.tables.commerceConnection[0].status = "DISCONNECTED"; }],
    ["connection uninstalled", (app) => { app.tables.commerceConnection[0].uninstalledAt = new Date(); }],
    ["store identity changed", (app) => { app.tables.commerceConnection[0].externalAccountId = "another-tenant"; }],
    ["store currency changed", (app) => { app.tables.commerceConnection[0].providerMetadata = { currencyCode: "USD" }; }],
    ["offer terms edited", (app) => { app.offer().discountAmountCents = 5000; }],
    ["offer config changed", (app) => { app.offer().commerce7Config = { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: true }; }],
    ["offer moved to another connection", (app) => { app.offer().connectionId = "foreign-connection"; }],
    ["offer products changed", (app) => { app.tables.brandRewardOfferProduct.push({ id: "late", offerId: "offer", externalProductId: "wine-b" }); }],
    ["offer enabled concurrently", (app) => { app.offer().isActive = true; }],
  ];
  for (const [name, change] of changes) {
    const app = harness({ offer: { isActive: false } }); app.txState.onOpen = () => change(app);
    const outcome = await app.setActive("ENABLE").then((offer) => offer, (error: Error & { code?: string }) => error);
    if (name === "offer enabled concurrently") { assert.equal((outcome as Row).isActive, true, name); continue; }
    assert.ok(outcome instanceof Error, name); assert.equal((outcome as { code?: string }).code, "OFFER_CHANGED", name);
    assert.equal(app.offer().isActive, false, name); assert.equal(app.offerWrites.length, 0, name);
  }
});

test("DISABLE is a single cheap conditional write with no validation, connection lookup or interactive transaction", async () => {
  const app = harness(); app.environment.active = null; app.environment.backend = false;
  assert.equal((await app.setActive("DISABLE")).isActive, false);
  assert.equal(app.txState.opened, 0); assert.equal(app.environment.connectionLookups.length, 0); assert.deepEqual(app.offerWrites, ["updateMany"]);
  assert.equal((await app.setActive("DISABLE")).isActive, false); assert.deepEqual(app.offerWrites, ["updateMany"], "a second disable writes nothing");
  assert.equal(app.offer().isActive, false);
});

test("ENABLE twice and DISABLE twice are idempotent end states", async () => {
  const app = harness({ offer: { isActive: false } });
  assert.equal((await app.setActive("ENABLE")).isActive, true); assert.equal((await app.setActive("ENABLE")).isActive, true); assert.equal(app.offer().isActive, true);
  assert.equal(app.txState.opened, 1, "the second ENABLE sees an active offer and does nothing");
  assert.equal((await app.setActive("DISABLE")).isActive, false); assert.equal((await app.setActive("DISABLE")).isActive, false); assert.equal(app.offer().isActive, false);
});

test("an offer with historical failed and refunded claims can be re-enabled without touching them", async () => {
  const app = harness();
  app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => new Response(JSON.stringify({ statusCode: 422, type: "validationError" }), { status: 422 }) });
  const failed = await app.reserve(); assert.equal((await app.provision(failed.id))?.status, "REFUNDED");
  const cancelled = await app.reserve("a-second-request-key-0002"); await app.cancel(cancelled.id);
  await app.setActive("DISABLE");
  const claims = JSON.stringify(app.claims()); const ledger = JSON.stringify([...app.ledger]); const reserved = app.offer().reservedClaimCount; const callsBefore = app.calls.length;
  assert.equal((await app.setActive("ENABLE")).isActive, true);
  assert.equal(JSON.stringify(app.claims()), claims); assert.equal(JSON.stringify([...app.ledger]), ledger); assert.equal(app.offer().reservedClaimCount, reserved);
  assert.equal(app.calls.length, callsBefore, "no Commerce7 coupon is created, read or deleted"); assert.equal(app.tenant.coupons.length, 0);
});
