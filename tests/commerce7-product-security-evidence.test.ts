import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { computeCommerce7Availability, normalizeCommerce7Product } from "../src/lib/commerce/providers/commerce7-products";
import { Commerce7RewardsClient } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { COMMERCE7_REWARD_CAPABILITIES, parseCommerce7Offer } from "../src/lib/commerce7-reward-domain";
import { fakeTenant, harness, offerBody, secureForExclusive } from "./commerce7-reward-harness";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/operator-sandbox-evidence.json", import.meta.url), "utf8"));
const wine = evidence.productSecurity;

test("live Product security reads Tag verbatim, never as Group, and the product is catalog-available but not public", () => {
  assert.equal(wine.security.availableTo, "Tag"); assert.equal(wine.security.displayOption, "Display Product / Show Login");
  assert.deepEqual(wine.security.availableToObjectIds, [evidence.customerTag.id]); assert.equal(evidence.customerTag.type, "Manual"); assert.equal(evidence.customerTag.objectType, "Customer");
  assert.deepEqual(computeCommerce7Availability(wine), { isCatalogAvailable: true, isPublicEligible: false, statusToken: "ACTIVE" });
  const product = normalizeCommerce7Product(wine);
  assert.equal(product?.externalId, wine.id); assert.equal(product?.title, "Rare - 2015 Chardonnay"); assert.equal(product?.status, "ACTIVE");
  assert.equal(product?.hasProviderStorefrontPublication, false, "a tag-restricted product is never a public destination");
  // The observed value and the documented values are all non-public; only "Public" is.
  for (const availableTo of ["Tag", "Group", "Club", "Allocation", "unknown"]) assert.equal(computeCommerce7Availability({ ...wine, security: { ...wine.security, availableTo } }).isPublicEligible, false, availableTo);
  assert.equal(computeCommerce7Availability({ ...wine, security: { availableTo: "Public" } }).isPublicEligible, true);
  assert.doesNotMatch(JSON.stringify(wine), /"Group"/);
});

test("exclusive access for the evidence-shaped product: activation is allowed, and the only write is one verified Customer Tag grant", async () => {
  const exclusive = { ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", discountEnabled: false, maxTotalRedemptions: 25, productIds: ["wine-a"] };
  assert.equal(parseCommerce7Offer({ ...exclusive, isActive: false }, "CAD").eligibilityMode, "CLAIMANT_ONLY");
  assert.equal(parseCommerce7Offer({ ...exclusive, isActive: true }, "CAD").isActive, true, "the domain no longer refuses activation; the saga verifies native state");
  assert.equal(COMMERCE7_REWARD_CAPABILITIES.exclusiveProductAccess, true); assert.equal(COMMERCE7_REWARD_CAPABILITIES.automaticCustomerTagAssignment, true);
  const tagId = wine.security.availableToObjectIds[0];
  const tenant = fakeTenant({ customers: [{ id: "alice", email: "alice@example.test" }], tags: [evidence.customerTag], products: [{ ...wine, id: "wine-a" }] });
  const app = harness({ tenant, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], user: { email: "alice@example.test", isEmailVerified: true, emailVerifiedAt: new Date("2026-10-01") } }); secureForExclusive(app, "wine-a", tagId);
  await app.save({ ...exclusive, isActive: false });
  Object.assign(app.offer(), { rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: true, discountAmountCents: null, commerce7Config: app.tables.brandRewardOffer.at(-1)!.commerce7Config });
  await app.claim();
  assert.equal(app.claims()[0].status, "ISSUED"); assert.equal(app.claims()[0].membershipOwnership, "SQRATCH_GRANTED");
  assert.deepEqual(tenant.calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.path, call.body]), [["POST", "/v1/tag-x-object/customer", { objectId: "alice", tagId }]], "no Product, Tag-definition or Customer-record write, and no deletion");
  assert.deepEqual(tenant.products[0].security, wine.security, "product security is untouched"); assert.equal(app.balance(), 400);
});

test("the rewards provider client has a closed surface: the only membership write is the verified grant; no Product security, Allocation or membership deletion exists", () => {
  const surface = Object.getOwnPropertyNames(Commerce7RewardsClient.prototype).filter((name) => name !== "constructor" && name !== "request").sort();
  assert.deepEqual(surface, ["assignCustomerTag", "coupon", "createCoupon", "createTag", "customer", "customerById", "customerTag", "findCoupon", "findTag", "productAccess", "revokeCoupon", "tagOnlyForCustomer"]);
  const source = readFileSync("src/lib/commerce/providers/commerce7-rewards-client.ts", "utf8");
  assert.deepEqual(source.match(/this\.request\([^)]*tag-x-object[^)]*\)/g), [`this.request("/tag-x-object/customer", "POST", { objectId: customerId, tagId })`], "exactly one membership request: the POST grant"); assert.doesNotMatch(source, /\/allocation/i);
});
