import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { getShopifyRewardDisplayState } from "../src/lib/shopify-reward-display";

const claimableAvailability = {
  status: "CLAIMABLE" as const,
  label: "Claimable",
  claimable: true,
};

test("unlocked users can view an unaffordable reward, but cannot redeem it", () => {
  const state = getShopifyRewardDisplayState({
    userPointsBalance: 60,
    pointsCost: 100,
    availability: claimableAvailability,
  });

  assert.deepEqual(state, {
    canView: true,
    canRedeem: false,
    disabledReason: "NOT_ENOUGH_POINTS",
    displayLabel: "Not enough points",
    pointsShortfall: 40,
  });
});

test("a claimable reward with sufficient spendable points stays redeemable", () => {
  assert.deepEqual(
    getShopifyRewardDisplayState({
      userPointsBalance: 100,
      pointsCost: 100,
      availability: claimableAvailability,
    }),
    {
      canView: true,
      canRedeem: true,
      disabledReason: null,
      displayLabel: "Redeem",
      pointsShortfall: 0,
    },
  );
});

test("availability limits continue to disable redemption independently of points", () => {
  const state = getShopifyRewardDisplayState({
    userPointsBalance: 500,
    pointsCost: 100,
    availability: {
      status: "LIMIT_REACHED",
      label: "Limit reached",
      claimable: false,
    },
  });

  assert.equal(state.canView, true);
  assert.equal(state.canRedeem, false);
  assert.equal(state.disabledReason, "LIMIT_REACHED");
  assert.equal(state.displayLabel, "Limit reached");
});

test("public reward UI keeps insufficient-point offers visible, muted, and explained", () => {
  const source = readFileSync(
    new URL("../src/components/rewards/shopify-shop-reward-card.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /offers\.map\(\(offer\)/);
  assert.match(source, /offer\.disabledReason === "NOT_ENOUGH_POINTS"/);
  assert.match(source, /You need \{offer\.pointsShortfall\}/);
  assert.match(source, /opacity-70/);
  assert.match(source, /!offer\.canRedeem \|\| redeemingOfferId === offer\.id/);
  assert.match(source, /aria-describedby=/);
  assert.match(source, /: offer\.displayLabel/);
});

test("experience shop mounts rewards before its zero-product state", () => {
  const source = readFileSync(
    new URL("../src/components/experience/shop-client.tsx", import.meta.url),
    "utf8",
  );
  const rewardCardIndex = source.indexOf(
    "<ShopifyShopRewardCard experienceSlug={experienceSlug} />",
  );
  const zeroProductIndex = source.indexOf("{productCount === 0 ? (");

  assert.ok(rewardCardIndex >= 0);
  assert.ok(zeroProductIndex > rewardCardIndex);
});

test("rewards API uses unlock context and the point-account balance", () => {
  const source = readFileSync(
    new URL("../src/app/api/rewards/shopify/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getRewardClaimContext/);
  assert.match(source, /id:\s*\{\s*in: rewardContext\.brandIds/);
  assert.match(source, /getUserSpendablePointBalance/);
  assert.doesNotMatch(source, /userPointsBalance:\s*user\.points/);
});

test("public rewards API filters incompatible offers without ever calling Shopify", () => {
  const source = readFileSync(
    new URL("../src/app/api/rewards/shopify/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /computeShopifyRewardCompatibility/);
  assert.match(source, /compatibleOffers\s*=\s*offers\.filter/);
  assert.match(source, /compatibility\.compatible/);
  // No Shopify API/token call may be introduced in this public GET route.
  assert.doesNotMatch(source, /fetchNormalizedShopifyProducts/);
  assert.doesNotMatch(source, /getValidAccessToken/);
});
