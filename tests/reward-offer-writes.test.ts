import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveRewardOfferUpdate } from "../src/lib/reward-offers";

const baseExisting = {
  discountType: "FIXED_AMOUNT" as const,
  minimumSubtotalCents: null,
  currencyCode: "USD",
  appliesTo: "ALL_PRODUCTS" as const,
  sourceShopDomain: null,
};

const validBody = {
  title: "10 off",
  pointsCost: 100,
  discountType: "FIXED_AMOUNT",
  discountAmountCents: 1000,
  appliesTo: "ALL_PRODUCTS",
  isActive: false,
};

test("normal save of a mismatched currency-dependent offer is rejected without acknowledgement", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: baseExisting,
    body: validBody,
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "CURRENCY_REVIEW_REQUIRED");
    assert.equal(result.status, 409);
  }
});

test("acknowledged currency mismatch cannot be saved active in the same request", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: baseExisting,
    body: { ...validBody, isActive: true, currencyReviewAcknowledged: true },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "CURRENCY_ACK_REQUIRES_INACTIVE");
    assert.equal(result.status, 400);
  }
});

test("acknowledged currency mismatch saves inactive with server-trusted currency and unchanged amount", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: baseExisting,
    body: { ...validBody, isActive: false, currencyReviewAcknowledged: true },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.currencyCode, "CAD");
    assert.equal(result.data.discountAmountCents, 1000);
    assert.equal(result.data.isActive, false);
  }
});

test("acknowledgement is ignored (and harmless) when there is no actual mismatch", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: { ...baseExisting, currencyCode: "CAD" },
    body: { ...validBody, currencyReviewAcknowledged: true },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.currencyCode, "CAD");
  }
});

test("percentage offer without minimum subtotal saves normally despite a currency drift", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: {
      ...baseExisting,
      discountType: "PERCENTAGE",
      currencyCode: "USD",
    },
    body: {
      title: "15% off",
      pointsCost: 100,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1500,
      appliesTo: "ALL_PRODUCTS",
      isActive: true,
    },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });

  assert.equal(result.ok, true);
});

test("specific-products offer with a different existing source requires reselection", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "old-shop.myshopify.com",
    },
    body: {
      title: "Specific",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS",
      isActive: false,
      products: [],
    },
    isConnected: true,
    currentShopDomain: "new-shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PRODUCT_RESELECTION_REQUIRED");
  }
});

test("specific-products reselection rejects activating in the same request", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "old-shop.myshopify.com",
    },
    body: {
      title: "Specific",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS",
      isActive: true,
      products: [{ shopifyProductGid: "gid://shopify/Product/1" }],
    },
    isConnected: true,
    currentShopDomain: "new-shop.myshopify.com",
    currentStoreCurrency: "CAD",
    validateProducts: async () => ({ ok: true }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PRODUCT_RESELECTION_REQUIRES_INACTIVE");
  }
});

test("specific-products reselection succeeds and stamps the current store as source", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "old-shop.myshopify.com",
    },
    body: {
      title: "Specific",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS",
      isActive: false,
      products: [{ shopifyProductGid: "gid://shopify/Product/1" }],
    },
    isConnected: true,
    currentShopDomain: "new-shop.myshopify.com",
    currentStoreCurrency: "CAD",
    validateProducts: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sourceShopDomain, "new-shop.myshopify.com");
  }
});

test("specific-products reselection is rejected when the authoritative Shopify check fails", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "old-shop.myshopify.com",
    },
    body: {
      title: "Specific",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS",
      isActive: false,
      products: [{ shopifyProductGid: "gid://shopify/Product/stale" }],
    },
    isConnected: true,
    currentShopDomain: "new-shop.myshopify.com",
    currentStoreCurrency: "CAD",
    validateProducts: async () => ({
      ok: false,
      error: "One or more selected products are not available in the connected Shopify store.",
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PRODUCT_VALIDATION_FAILED");
  }
});

test("specific-products offer whose source already matches the current store saves as a normal edit", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "shop.myshopify.com",
    },
    body: {
      title: "Specific (renamed)",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS",
      isActive: true,
      products: [{ shopifyProductGid: "gid://shopify/Product/1" }],
    },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
    validateProducts: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.isActive, true);
    assert.equal(result.sourceShopDomain, "shop.myshopify.com");
  }
});

test("activation is rejected end-to-end when Shopify is disconnected", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: { ...baseExisting, discountType: "PERCENTAGE", currencyCode: "CAD" },
    body: {
      title: "15% off",
      pointsCost: 100,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1500,
      appliesTo: "ALL_PRODUCTS",
      isActive: true,
    },
    isConnected: false,
    currentShopDomain: null,
    currentStoreCurrency: null,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "INCOMPATIBLE_OFFER");
    assert.deepEqual(result.details?.reasons, ["SHOPIFY_DISCONNECTED"]);
  }
});

test("client cannot spoof sourceShopDomain via the request body", async () => {
  const result = await resolveRewardOfferUpdate({
    existing: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "shop.myshopify.com",
    },
    body: {
      title: "Specific",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS",
      isActive: false,
      products: [{ shopifyProductGid: "gid://shopify/Product/1" }],
      // Attempted spoof — resolveRewardOfferUpdate has no such field and
      // must ignore it, always deriving sourceShopDomain from the server's
      // own connection state.
      sourceShopDomain: "attacker-shop.myshopify.com",
    },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
    validateProducts: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sourceShopDomain, "shop.myshopify.com");
  }
});

test("activation succeeds only on a later, separate request once the offer is actually compatible", async () => {
  // Step 1: the merchant acknowledges and saves the currency fix inactive.
  const stepOne = await resolveRewardOfferUpdate({
    existing: baseExisting,
    body: { ...validBody, isActive: false, currencyReviewAcknowledged: true },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });
  assert.equal(stepOne.ok, true);
  if (!stepOne.ok) return;
  assert.equal(stepOne.data.isActive, false);
  assert.equal(stepOne.data.currencyCode, "CAD");

  // Step 2: a later request against the now-corrected stored offer tries to
  // activate — no acknowledgement needed this time since there's no longer
  // a mismatch, and it succeeds.
  const stepTwo = await resolveRewardOfferUpdate({
    existing: { ...baseExisting, currencyCode: stepOne.data.currencyCode },
    body: { ...validBody, currencyCode: "CAD", isActive: true },
    isConnected: true,
    currentShopDomain: "shop.myshopify.com",
    currentStoreCurrency: "CAD",
  });

  assert.equal(stepTwo.ok, true);
  if (stepTwo.ok) {
    assert.equal(stepTwo.data.isActive, true);
  }
});
