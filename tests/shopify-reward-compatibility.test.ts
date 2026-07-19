import assert from "node:assert/strict";
import { test } from "node:test";

import { computeShopifyRewardCompatibility } from "../src/lib/shopify-reward-compatibility";

const connectedBase = {
  shopifyConnected: true,
  currentShopDomain: "current-shop.myshopify.com",
  currentStoreCurrency: "CAD",
};

test("connected compatible fixed reward has no incompatibility reasons", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "FIXED_AMOUNT",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
    },
    ...connectedBase,
  });

  assert.deepEqual(result, {
    compatible: true,
    reasons: [],
    currentShopDomain: "current-shop.myshopify.com",
    currentStoreCurrency: "CAD",
    sourceShopDomain: null,
  });
});

test("fixed reward in USD against a CAD store requires currency review", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "FIXED_AMOUNT",
      minimumSubtotalCents: null,
      currencyCode: "USD",
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
    },
    ...connectedBase,
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["CURRENCY_REVIEW_REQUIRED"]);
});

test("percentage reward with no minimum subtotal ignores a currency mismatch", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "USD",
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
    },
    ...connectedBase,
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.reasons, []);
});

test("percentage reward with a minimum subtotal still requires matching currency", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: 5000,
      currencyCode: "USD",
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
    },
    ...connectedBase,
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["CURRENCY_REVIEW_REQUIRED"]);
});

test("missing current store currency requires currency review for currency-dependent offers", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "FIXED_AMOUNT",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
    },
    shopifyConnected: true,
    currentShopDomain: "current-shop.myshopify.com",
    currentStoreCurrency: null,
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["CURRENCY_REVIEW_REQUIRED"]);
});

test("specific products offer with matching source store is compatible", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "USD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "Current-Shop.MyShopify.com",
    },
    ...connectedBase,
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.sourceShopDomain, "current-shop.myshopify.com");
});

test("specific products offer sourced from another store requires reselection only", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "USD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: "previous-shop.myshopify.com",
    },
    ...connectedBase,
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["PRODUCT_RESELECTION_REQUIRED"]);
});

test("specific products offer with missing source store requires reselection and flags unknown source", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "USD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: null,
    },
    ...connectedBase,
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    [...result.reasons].sort(),
    ["PRODUCT_RESELECTION_REQUIRED", "UNKNOWN_SOURCE_STORE"].sort(),
  );
});

test("multiple simultaneous incompatibility reasons are all reported together", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "FIXED_AMOUNT",
      minimumSubtotalCents: null,
      currencyCode: "USD",
      appliesTo: "SPECIFIC_PRODUCTS",
      sourceShopDomain: null,
    },
    shopifyConnected: false,
    currentShopDomain: null,
    currentStoreCurrency: null,
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    [...result.reasons].sort(),
    [
      "CURRENCY_REVIEW_REQUIRED",
      "PRODUCT_RESELECTION_REQUIRED",
      "SHOPIFY_DISCONNECTED",
      "UNKNOWN_SOURCE_STORE",
    ].sort(),
  );
});

test("disconnected Shopify is reported even when the offer would otherwise be compatible", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "PERCENTAGE",
      minimumSubtotalCents: null,
      currencyCode: "CAD",
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
    },
    shopifyConnected: false,
    currentShopDomain: null,
    currentStoreCurrency: null,
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["SHOPIFY_DISCONNECTED"]);
});

test("currency comparison is case-insensitive and whitespace-tolerant", () => {
  const result = computeShopifyRewardCompatibility({
    offer: {
      discountType: "FIXED_AMOUNT",
      minimumSubtotalCents: null,
      currencyCode: " cad ",
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
    },
    ...connectedBase,
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.reasons, []);
});
