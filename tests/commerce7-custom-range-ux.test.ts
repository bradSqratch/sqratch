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
      // The correct conversion, whatever this machine's timezone is: parse as LOCAL time, then serialize as an absolute instant.
      // (Comparing against `${fromValue}:00.000Z` is meaningless here: on a UTC machine the two are correctly identical.)
      assert.equal(result.fromIso, new Date(fromValue).toISOString());
      assert.match(result.fromIso, /Z$/, "the server always receives an absolute UTC instant");
    }
  });

  // Deterministic timezone coverage: each case pins process.env.TZ (Node re-reads it), so the outcome never depends on the
  // developer's machine or the CI runner (GitHub Actions runs in UTC).
  function inTimeZone<T>(timeZone: string, run: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try { return run(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  }
  const select = (fromValue: string, toValue: string) => validateCustomRangeSelection({ fromValue, toValue, now: new Date("2027-01-01T00:00:00.000Z") });
  for (const [timeZone, from, to] of [
    ["UTC", "2026-08-20T04:39:00.000Z", "2026-08-20T05:00:00.000Z"],
    ["America/New_York", "2026-08-20T08:39:00.000Z", "2026-08-20T09:00:00.000Z"], // EDT, UTC-4
    ["Asia/Kolkata", "2026-08-19T23:09:00.000Z", "2026-08-19T23:30:00.000Z"], // UTC+5:30, previous UTC day
  ] as const) {
    test(`6b. in ${timeZone} the operator's local wall time becomes the exact UTC instant`, () => {
      const result = inTimeZone(timeZone, () => select("2026-08-20T04:39", "2026-08-20T05:00"));
      assert.equal(result.ok, true);
      if (result.ok) { assert.equal(result.fromIso, from); assert.equal(result.toIso, to); }
    });
  }

  test("6c. America/New_York daylight-saving changes: winter is UTC-5, summer UTC-4, and ranges across a change stay ordered", () => {
    inTimeZone("America/New_York", () => {
      const winter = select("2026-01-15T09:00", "2026-01-15T10:00");
      assert.ok(winter.ok); if (winter.ok) assert.equal(winter.fromIso, "2026-01-15T14:00:00.000Z");
      // 2026-03-08 02:00 springs forward to 03:00: a range spanning it is one real hour long, not two.
      const spring = select("2026-03-08T01:30", "2026-03-08T03:30");
      assert.ok(spring.ok); if (spring.ok) { assert.equal(spring.fromIso, "2026-03-08T06:30:00.000Z"); assert.equal(spring.toIso, "2026-03-08T07:30:00.000Z"); }
      // 2026-11-01 02:00 falls back to 01:00: the ambiguous 01:30 resolves to a single valid instant, and order is preserved.
      const fall = select("2026-11-01T00:30", "2026-11-01T03:00");
      assert.ok(fall.ok); if (fall.ok) { assert.equal(fall.fromIso, "2026-11-01T04:30:00.000Z"); assert.equal(fall.toIso, "2026-11-01T08:00:00.000Z"); }
      const reversed = select("2026-03-08T03:30", "2026-03-08T01:30");
      assert.equal(reversed.ok, false, "From after To is still rejected across a DST change");
    });
  });

  test("6d. the future-range ceiling compares absolute instants, so it is identical in every timezone", () => {
    for (const timeZone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
      inTimeZone(timeZone, () => {
        const nowInstant = new Date("2026-08-26T16:00:00.000Z");
        const local = formatDateTimeLocalMax(nowInstant); // the input's max, in this zone's wall time
        assert.equal(validateCustomRangeSelection({ fromValue: "2026-08-20T00:00", toValue: local, now: nowInstant }).ok, true, `${timeZone}: now itself is allowed`);
        const oneMinuteLater = formatDateTimeLocalMax(new Date(nowInstant.getTime() + 60000));
        const late = validateCustomRangeSelection({ fromValue: "2026-08-20T00:00", toValue: oneMinuteLater, now: nowInstant });
        assert.equal(late.ok, false, `${timeZone}: one minute in the future is refused`);
      });
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
