// Exercise real DST rules: America/Toronto falls back on 2026-11-01 and springs forward on 2026-03-08.
process.env.TZ = "America/Toronto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimWindowError, claimWindowIso, defaultClaimWindow, fromLocalDateTimeInput, toLocalDateTimeInput } from "../src/lib/reward-claim-window";
import { parseCommerce7Offer } from "../src/lib/commerce7-reward-domain";

test("the process really runs in a DST zone (guards the assertions below)", () => {
  assert.equal(new Date("2026-07-01T12:00:00Z").getTimezoneOffset(), 240); assert.equal(new Date("2026-12-01T12:00:00Z").getTimezoneOffset(), 300);
});

test("a new reward defaults to now (minute precision) through 30 calendar days later at the same local time", () => {
  const window = defaultClaimWindow(new Date("2026-10-08T12:13:47.900Z"));
  assert.deepEqual(window, { starts: "2026-10-08T08:13", ends: "2026-11-07T08:13" }, "EDT start, EST end: same wall time across the November DST change");
  assert.equal(claimWindowIso(window.starts), "2026-10-08T12:13:00.000Z");
  assert.equal(claimWindowIso(window.ends), "2026-11-07T13:13:00.000Z", "30 calendar days is 30 days + 1 hour of UTC across fall-back");
});

test("defaults follow the clock at the time they are computed, not a frozen module load time", () => {
  const first = defaultClaimWindow(new Date("2026-10-08T12:00:00.000Z")); const later = defaultClaimWindow(new Date("2026-10-09T15:30:00.000Z"));
  assert.notEqual(first.starts, later.starts); assert.equal(later.starts, "2026-10-09T11:30"); assert.equal(later.ends, "2026-11-08T11:30");
});

test("local input values round-trip through UTC, including both DST edges", () => {
  for (const iso of ["2026-03-07T12:00:00.000Z", "2026-03-08T12:00:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T07:30:00.000Z", "2026-12-31T23:59:00.000Z"]) {
    assert.equal(fromLocalDateTimeInput(toLocalDateTimeInput(new Date(iso)))?.toISOString(), iso, iso);
  }
  // 01:30 on the fall-back night happens twice (EDT then EST). A datetime-local value cannot say which; the platform picks
  // the first occurrence, so the later instant displays as 01:30 and saves an hour earlier. Documented, not hidden.
  assert.equal(toLocalDateTimeInput(new Date("2026-11-01T06:30:00.000Z")), "2026-11-01T01:30");
  assert.equal(fromLocalDateTimeInput("2026-11-01T01:30")?.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(fromLocalDateTimeInput("2026-03-08T02:30")?.toISOString(), "2026-03-08T07:30:00.000Z", "a nonexistent spring-forward wall time is normalized forward to 03:30 EDT");
  for (const invalid of ["", "2026-13-01T00:00", "2026-02-30T10:00", "2026-10-08 08:13", "not a date"]) assert.equal(fromLocalDateTimeInput(invalid), null, invalid);
});

test("client validation mirrors the server: end must follow start; either side may be left open", () => {
  assert.equal(claimWindowError("2026-10-08T08:13", "2026-11-07T08:13"), null);
  assert.equal(claimWindowError("", ""), null, "an open-ended reward is valid");
  assert.equal(claimWindowError("2026-10-08T08:13", ""), null); assert.equal(claimWindowError("", "2026-11-07T08:13"), null);
  assert.equal(claimWindowError("2026-10-08T08:13", "2026-10-08T08:13"), "Claim end must be after claim start.");
  assert.equal(claimWindowError("2026-10-08T08:13", "2026-10-01T08:13"), "Claim end must be after claim start.");
  assert.equal(claimWindowError("garbage", ""), "Enter a valid claim start date and time.");
  assert.equal(claimWindowIso(""), null);
  const body = { title: "Window", isActive: false, pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: 1000, maxTotalRedemptions: 5, maxRedemptionsPerUser: 1, codeValidDays: 7 };
  assert.throws(() => parseCommerce7Offer({ ...body, claimStartsAt: "2026-10-08T12:13:00.000Z", claimEndsAt: "2026-10-08T12:13:00.000Z" }, "CAD"), /End date must follow start date/);
  const parsed = parseCommerce7Offer({ ...body, claimStartsAt: claimWindowIso("2026-10-08T08:13"), claimEndsAt: claimWindowIso("2026-11-07T08:13") }, "CAD");
  assert.equal(parsed.claimStartsAt?.toISOString(), "2026-10-08T12:13:00.000Z"); assert.equal(parsed.codeValidDays, 7, "coupon validity is independent of the claim window");
  assert.equal(parseCommerce7Offer({ ...body, claimStartsAt: null, claimEndsAt: null }, "CAD").claimEndsAt, null, "the server keeps an open-ended reward open-ended");
});
