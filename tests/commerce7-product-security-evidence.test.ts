import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { computeCommerce7Availability, normalizeCommerce7Product } from "../src/lib/commerce/providers/commerce7-products";
import { Commerce7RewardsClient } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { COMMERCE7_REWARD_CAPABILITIES, parseCommerce7Offer } from "../src/lib/commerce7-reward-domain";
import { fakeTenant, harness, offerBody } from "./commerce7-reward-harness";

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

test("exclusive access stays blocked even for a product whose live security shape is known", async () => {
  const exclusive = { ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", discountEnabled: false, maxTotalRedemptions: 25, productIds: ["wine-a"] };
  assert.equal(parseCommerce7Offer({ ...exclusive, isActive: false }, "CAD").eligibilityMode, "CLAIMANT_ONLY");
  assert.throws(() => parseCommerce7Offer({ ...exclusive, isActive: true }, "CAD"), { code: "INVALID_OFFER" });
  assert.equal(COMMERCE7_REWARD_CAPABILITIES.exclusiveProductAccess, false); assert.equal(COMMERCE7_REWARD_CAPABILITIES.automaticCustomerTagAssignment, false);
  const tenant = fakeTenant({ customers: [{ id: "alice", email: "alice@example.test" }] });
  const app = harness({ tenant, user: { email: "alice@example.test", isEmailVerified: true, emailVerifiedAt: new Date("2026-10-01") } });
  await app.save({ ...exclusive, isActive: false });
  Object.assign(app.offer(), { rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: true });
  await assert.rejects(app.reserve(), { code: "UNSUPPORTED_ACCESS" });
  assert.equal(tenant.calls.length, 0, "no Product, Tag or Customer write, and no read, is ever attempted"); assert.equal(app.balance(), 500);
});

test("the rewards provider client has a closed surface: no Product security, Allocation or customer-membership write exists", () => {
  const surface = Object.getOwnPropertyNames(Commerce7RewardsClient.prototype).filter((name) => name !== "constructor" && name !== "request").sort();
  assert.deepEqual(surface, ["coupon", "createCoupon", "createTag", "customer", "customerById", "findCoupon", "findTag", "revokeCoupon", "tagOnlyForCustomer"]);
});
