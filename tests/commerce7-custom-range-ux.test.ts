/**
 * tests/commerce7-custom-range-ux.test.ts
 *
 * PHASE 26, PART 2 — the production defect where Custom Range reconciliation
 * returned HTTP 400 because the `<input type="datetime-local">` controls let
 * an operator select a future date/time the server always refused.
 *
 * Covers the pure, DB-free, DOM-free helpers in
 * `commerce-response-validation.ts` (no React testing library in this repo —
 * same idiom as `product-catalog-helpers.ts`'s own tests) plus static source
 * assertions on the client component that consumes them.
 *
 * TIMEZONE INDEPENDENCE: every fixture `Date` below is constructed via the
 * LOCAL-time constructor (`new Date(year, month, day, hour, minute)`), and
 * `formatDateTimeLocalMax`/`validateCustomRangeSelection` themselves operate
 * purely on local `Date` accessors — so every assertion holds regardless of
 * the machine running the suite, without needing to mock the system clock.
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatDateTimeLocalMax,
  validateCustomRangeSelection,
  CUSTOM_RANGE_FUTURE_MESSAGE,
} from "../src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation";

describe("formatDateTimeLocalMax", () => {
  test("6. formats using LOCAL date components as YYYY-MM-DDTHH:mm, independent of runtime timezone", () => {
    const date = new Date(2026, 7, 26, 4, 39); // August 26 2026, 04:39 local (month is 0-indexed)
    assert.equal(formatDateTimeLocalMax(date), "2026-08-26T04:39");
  });

  test("pads single-digit month/day/hour/minute", () => {
    const date = new Date(2026, 0, 5, 9, 3); // Jan 5 2026, 09:03 local
    assert.equal(formatDateTimeLocalMax(date), "2026-01-05T09:03");
  });

  test("drops seconds/milliseconds — a datetime-local max with seconds can reject the current minute", () => {
    const date = new Date(2026, 7, 26, 4, 39, 58, 500);
    assert.equal(formatDateTimeLocalMax(date), "2026-08-26T04:39");
  });

  test("handles midnight and the last minute of a year correctly", () => {
    assert.equal(formatDateTimeLocalMax(new Date(2026, 0, 1, 0, 0)), "2026-01-01T00:00");
    assert.equal(formatDateTimeLocalMax(new Date(2026, 11, 31, 23, 59)), "2026-12-31T23:59");
  });
});

describe("validateCustomRangeSelection", () => {
  const now = new Date(2026, 7, 26, 12, 0); // fixed local "now" for every test below

  test("1/3. a From strictly after `now` is rejected with the future-range message", () => {
    const future = formatDateTimeLocalMax(new Date(2026, 7, 27, 0, 0));
    const laterFuture = formatDateTimeLocalMax(new Date(2026, 7, 27, 1, 0));
    const result = validateCustomRangeSelection({ fromValue: future, toValue: laterFuture, now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.message, CUSTOM_RANGE_FUTURE_MESSAGE);
  });

  test("2/4. a valid From but a To strictly after `now` is ALSO rejected as future", () => {
    const validFrom = formatDateTimeLocalMax(new Date(2026, 7, 25, 0, 0));
    const futureTo = formatDateTimeLocalMax(new Date(2026, 7, 27, 0, 0));
    const result = validateCustomRangeSelection({ fromValue: validFrom, toValue: futureTo, now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.message, CUSTOM_RANGE_FUTURE_MESSAGE);
  });

  test("From/To exactly equal to `now` is accepted — the ceiling is inclusive, matching the max attribute", () => {
    const exactlyNow = formatDateTimeLocalMax(now);
    const result = validateCustomRangeSelection({ fromValue: "2026-08-20T04:00", toValue: exactlyNow, now });
    assert.equal(result.ok, true);
  });

  test("5. a valid historical range parses to ok:true with well-formed ISO strings", () => {
    const result = validateCustomRangeSelection({
      fromValue: "2026-08-20T04:00",
      toValue: "2026-08-20T05:00",
      now,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(typeof result.fromIso, "string");
      assert.equal(typeof result.toIso, "string");
      assert.ok(!Number.isNaN(new Date(result.fromIso).getTime()));
      assert.ok(!Number.isNaN(new Date(result.toIso).getTime()));
    }
  });

  test("6. local datetime -> ISO conversion parses as LOCAL time (via new Date(...)), never a bare 'Z' appended", () => {
    const fromValue = "2026-08-20T04:39";
    const result = validateCustomRangeSelection({ fromValue, toValue: "2026-08-20T05:00", now });
    assert.equal(result.ok, true);
    if (result.ok) {
      // The correct conversion: parse fromValue as LOCAL time, then format.
      assert.equal(result.fromIso, new Date(fromValue).toISOString());
      // The WRONG conversion this bug class guards against: naively treating
      // the local-time string as if it already were UTC.
      assert.notEqual(result.fromIso, `${fromValue}:00.000Z`);
    }
  });

  test("10. From >= To remains rejected", () => {
    const result = validateCustomRangeSelection({
      fromValue: "2026-08-20T05:00",
      toValue: "2026-08-20T05:00",
      now,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /strictly before/i);
  });

  test("an empty From or To is rejected with a clear message, not a crash", () => {
    const result = validateCustomRangeSelection({ fromValue: "", toValue: "", now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /choose a valid/i);
  });

  test("a malformed value never throws and is rejected cleanly", () => {
    assert.doesNotThrow(() =>
      validateCustomRangeSelection({ fromValue: "not-a-date", toValue: "2026-08-20T05:00", now }),
    );
    const result = validateCustomRangeSelection({
      fromValue: "not-a-date",
      toValue: "2026-08-20T05:00",
      now,
    });
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 9. Static source assertions — the UI actually wires these helpers in.
// ---------------------------------------------------------------------------

describe("BrandCommerceOrdersClient — custom range picker wiring", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "src/app/(withSidebar)/dashboard/brand/commerce/orders/BrandCommerceOrdersClient.tsx",
    ),
    "utf8",
  );

  test("1/2. both From and To datetime-local inputs carry a max bound derived from formatDateTimeLocalMax", () => {
    assert.match(source, /formatDateTimeLocalMax\(new Date\(\)\)/);
    const fromInputStart = source.indexOf('<span>From</span>');
    const fromInputBlock = source.slice(fromInputStart, fromInputStart + 300);
    assert.match(fromInputBlock, /max=\{maxDateTimeLocal\}/);
    const toInputStart = source.indexOf('<span>To</span>');
    const toInputBlock = source.slice(toInputStart, toInputStart + 300);
    assert.match(toInputBlock, /max=\{maxDateTimeLocal\}/);
  });

  test("3/4. handleReconcileRange runs the shared client pre-flight validator before any fetch", () => {
    const fnStart = source.indexOf("async function handleReconcileRange()");
    assert.ok(fnStart > -1, "handleReconcileRange not found");
    const fnBody = source.slice(fnStart, fnStart + 900);
    assert.match(fnBody, /validateCustomRangeSelection\(/);
    assert.match(fnBody, /if \(!selection\.ok\)/);
    // The fetch loop must appear AFTER the validation check, never before.
    const validationIndex = fnBody.indexOf("validateCustomRangeSelection(");
    const fetchLoopIndex = fnBody.indexOf("runOneChunk(");
    assert.ok(validationIndex > -1 && fetchLoopIndex > -1);
    assert.ok(validationIndex < fetchLoopIndex);
  });

  test("9. the future-range rejection renders the specific shared message, not the generic fallback", () => {
    assert.match(source, /setError\(selection\.message\)/);
  });

  test("the max-date ceiling refresh interval is cleared on both collapse and unmount — no leaked timer", () => {
    const effectStart = source.indexOf("if (!expanded) return;");
    assert.ok(effectStart > -1);
    const effectBlock = source.slice(effectStart, effectStart + 400);
    assert.match(effectBlock, /setInterval\(/);
    assert.match(effectBlock, /return \(\) => clearInterval\(handle\);/);
  });

  test("the ceiling is recomputed when the panel opens (effect depends on `expanded`)", () => {
    const effectStart = source.indexOf("setMaxDateTimeLocal(formatDateTimeLocalMax(new Date()));\n    const handle");
    assert.ok(effectStart > -1);
    const nearbyBlock = source.slice(Math.max(0, effectStart - 200), effectStart + 400);
    assert.match(nearbyBlock, /\[expanded\]/);
  });

  test("server-side validation is still authoritative — the client never assumes it alone is sufficient (POST still round-trips)", () => {
    assert.match(source, /orders\/reconcile-range/);
    assert.match(source, /method: "POST"/);
  });
});
