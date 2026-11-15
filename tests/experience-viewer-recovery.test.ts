import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describePlaybackTime } from "../src/lib/playback-time";

const read = (path: string) => readFileSync(path, "utf8");

test("playback time is spoken in whole units with correct singular and plural forms", () => {
  assert.equal(describePlaybackTime(0), "0 seconds");
  assert.equal(describePlaybackTime(1), "1 second");
  assert.equal(describePlaybackTime(80), "1 minute 20 seconds");
  assert.equal(describePlaybackTime(240), "4 minutes");
  assert.equal(describePlaybackTime(3661), "1 hour 1 minute 1 second");
  assert.equal(describePlaybackTime(59.9), "59 seconds");
  assert.equal(describePlaybackTime(-5), "0 seconds");
  assert.equal(describePlaybackTime(Number.NaN), "0 seconds");
});

test("the seek control is named, announces readable time and moves by whole seconds", () => {
  const hub = read("src/components/experience/hub-client.tsx");
  const input = hub.slice(hub.indexOf('type="range"') - 40, hub.indexOf('type="range"') + 600);
  assert.match(input, /aria-label="Seek"/);
  assert.match(input, /aria-valuetext=\{`\$\{describePlaybackTime\(currentTime\)\} of \$\{describePlaybackTime\(duration\)\}`\}/);
  assert.match(input, /step=\{1\}/);
});

test("rewards render independently of products and every failure has a retry", () => {
  const shop = read("src/components/experience/shop-client.tsx");
  const rewards = shop.indexOf("<ShopifyShopRewardCard experienceSlug={experienceSlug} />");
  const productStates = shop.indexOf("{shopLoading || !shopSettled ? (");
  const products = shop.indexOf("{products.length === 0 ? (");
  // Rewards sit before every product state, so no product branch can hide them.
  assert.ok(rewards > 0 && rewards < productStates && productStates < products);
  assert.match(shop, /<Commerce7RewardsClient experienceSlug=\{experienceSlug\} campaignId=\{shopMeta\?\.campaign\?\.id\} \/>/);
  assert.match(shop, /Products could not be loaded\./);
  assert.match(shop, /onClick=\{\(\) => void fetchPage\(null\)\}/);

  const shopify = read("src/components/rewards/shopify-shop-reward-card.tsx");
  assert.match(shopify, /Rewards could not be loaded\./);
  assert.match(shopify, /onClick=\{\(\) => void loadRewards\(\)\}/);
  assert.match(shopify, /role="alert"/);
  // A signed-out visitor (unauthorized) stays hidden rather than seeing an error.
  assert.match(shopify, /includes\("unauthorized"\)/);
});

test("comment refresh is explicit and duplicate requests cannot be in flight together", () => {
  const posts = read("src/components/experience/posts-client.tsx");
  assert.match(posts, /loadComments\(\{ force = false \}/);
  assert.match(posts, /loadingRef\.current \|\| \(comments && !force\)/);
  assert.match(posts, /onClick=\{\(\) => void loadComments\(\{ force: Boolean\(comments\) \}\)\}/);
  assert.match(posts, /disabled=\{commentsLoading\}/);
  // Posting before the list was ever loaded loads the full list instead of showing a lone comment.
  assert.match(posts, /await loadComments\(\{ force: true \}\)/);
});
