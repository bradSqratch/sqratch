import assert from "node:assert/strict";
import test from "node:test";

import { collectAnonMergeKeys } from "../src/lib/anon-merge-keys";

// ─── Unit tests ───────────────────────────────────────────────────────────────

test("collectAnonMergeKeys — sqr_session is returned first", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "session-abc",
    anonKeyCookie: "legacy-anon",
    deviceKeyCookie: null,
    bodyAnonKey: null,
  });
  assert.equal(result[0], "session-abc");
});

test("collectAnonMergeKeys — legacy anonKey cookie does NOT shadow sqr_session", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "session-abc",
    anonKeyCookie: "old-anon-key",
    deviceKeyCookie: null,
    bodyAnonKey: null,
  });
  // Both are present; session is first
  assert.deepEqual(result, ["session-abc", "old-anon-key"]);
});

test("collectAnonMergeKeys — deduplicates identical values", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "same-key",
    anonKeyCookie: "same-key",
    deviceKeyCookie: "same-key",
    bodyAnonKey: "same-key",
  });
  assert.deepEqual(result, ["same-key"]);
});

test("collectAnonMergeKeys — drops empty strings", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "",
    anonKeyCookie: "",
    deviceKeyCookie: null,
    bodyAnonKey: null,
  });
  assert.deepEqual(result, []);
});

test("collectAnonMergeKeys — drops whitespace-only strings", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "   ",
    anonKeyCookie: "\t",
    deviceKeyCookie: null,
    bodyAnonKey: null,
  });
  assert.deepEqual(result, []);
});

test("collectAnonMergeKeys — includes all four distinct keys", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "sess-1",
    anonKeyCookie: "anon-1",
    deviceKeyCookie: "device-1",
    bodyAnonKey: "body-1",
  });
  assert.deepEqual(result, ["sess-1", "anon-1", "device-1", "body-1"]);
});

test("collectAnonMergeKeys — returns empty array when all inputs are null/undefined", () => {
  const result = collectAnonMergeKeys({});
  assert.deepEqual(result, []);
});

test("collectAnonMergeKeys — trims whitespace from values", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "  sess-padded  ",
    anonKeyCookie: null,
    deviceKeyCookie: null,
    bodyAnonKey: null,
  });
  assert.deepEqual(result, ["sess-padded"]);
});

test("collectAnonMergeKeys — dedupes after trimming", () => {
  const result = collectAnonMergeKeys({
    sessionCookie: "key",
    anonKeyCookie: "key",
    deviceKeyCookie: null,
    bodyAnonKey: null,
  });
  assert.deepEqual(result, ["key"]);
});

// ─── Manual QA checklist (integration — do not mock Prisma) ──────────────────
//
// These scenarios must be verified manually against a local DB:
//
// 1. FIRST ANON SCAN
//    - Scan a NEW QR code without being logged in.
//    - Expected: CampaignUnlock row created with anonKey=sqr_session, userId=null.
//
// 2. REPEAT ANON SCAN (concurrent race)
//    - Simulate two simultaneous POST /api/public/scan requests for the same
//      QR code and the same sessionId (remove the findFirst fast-path guard
//      temporarily, or trigger via parallel fetch in browser DevTools).
//    - Expected: Only one CampaignUnlock exists; second write swallowed P2002.
//    - Note: requires migration 20260615113320_campaign_unlock_anon_unique applied.
//
// 3. LOGIN / VERIFY-EMAIL MERGE
//    - Scan a QR code as anonymous (creates anon unlock under sqr_session).
//    - Also have a stale legacy "anonKey" cookie present in the browser.
//    - Register + verify email.
//    - Expected: mergeAnonymousCampaignUnlocks called for BOTH keys; the anon
//      unlock under sqr_session is claimed by the new userId; legacy key merged
//      if it had any unlocks.
//
// 4. MERGE IDEMPOTENCY (merge same campaign twice)
//    - Create two anon unlocks for the SAME campaign under different anonKeys.
//    - Verify email.
//    - Expected: exactly ONE CampaignUnlock for (campaignId, userId) — the merge
//      loop detects existingUserUnlock on the second key and deletes the anon row.
//
// 5. KIOSK FLOW (existing user)
//    - Submit kiosk form (add-user-send-verify-email) with an email that already
//      exists in the DB and a NEW QR code.
//    - Expected: QR redeemed (status USED), CampaignUnlock created for user,
//      PointTransaction created.
//
// 6. KIOSK FLOW (new user)
//    - Submit kiosk form with a brand-new email and a NEW QR code.
//    - Expected: User created, QR redeemed, CampaignUnlock created, PointTransaction
//      created.
//
// 7. LOCKED BRAND — reward access denied
//    - Attempt to redeem a BrandRewardOffer for a brand the user has NOT unlocked
//      (no CampaignUnlock for that brand's campaigns).
//    - Expected: 403 "Unlock this experience before claiming rewards."
//
// 8. UNLOCKED BRAND — reward access granted
//    - Scan QR → CampaignUnlock created → attempt redeem for that brand.
//    - Expected: 200 with discount code.
