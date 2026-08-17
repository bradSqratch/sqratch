process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/commerce-product-money.test.ts
 *
 * Unit tests for src/lib/commerce/money.ts: converting a commerce
 * provider's decimal-string price into integer minor units via pure STRING
 * arithmetic (never `Math.round(value * 100)`, which is unsafe for money —
 * see the module's own header comment for why `Math.round(1.005 * 100)`
 * is 100, not 101).
 *
 * money.ts does not touch prisma, the DB, or the network, so the
 * DATABASE_URL line above is precautionary only (matches this repo's
 * "every new test file" convention) — nothing in this file actually
 * requires it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  decimalStringToBigIntMinorUnits,
  decimalStringToMinorUnits,
  formatMinorUnitPriceRange,
  providerPriceStringToMinorUnits,
  getCurrencyExponent,
  DEFAULT_MINOR_UNIT_EXPONENT,
} from "../src/lib/commerce/money";

describe("decimalStringToBigIntMinorUnits", () => {
  test("preserves a provider order amount above catalog int4 range when it fits Postgres BigInt", () => {
    assert.deepEqual(decimalStringToBigIntMinorUnits("25000000.00", 2), {
      ok: true,
      minorUnits: BigInt("2500000000"),
    });
  });

  test("rejects an amount beyond the persisted Postgres BigInt range", () => {
    assert.deepEqual(decimalStringToBigIntMinorUnits("92233720368547758.08", 2), {
      ok: false,
      reason: "OUT_OF_RANGE",
    });
  });
});

describe("decimalStringToMinorUnits", () => {
  test('"19.99" at exponent 2 -> 1999', () => {
    const result = decimalStringToMinorUnits("19.99", 2);
    assert.deepEqual(result, { ok: true, minorUnits: 1999 });
  });

  test('"1.005" at exponent 2 -> TRUNCATES to 100, not rounds to 101 (documented, deliberate semantic)', () => {
    // This module never rounds up — extra fractional digits beyond the
    // target exponent are dropped outright ("1.005" -> "1.00"), because
    // silently rounding a provider price up would overcharge. A caller
    // that wants a different (e.g. round-half-up) policy must apply it
    // itself before/after calling this module; it is explicitly out of
    // scope here.
    const result = decimalStringToMinorUnits("1.005", 2);
    assert.deepEqual(result, { ok: true, minorUnits: 100 });
  });

  test('"0" -> 0, never NaN', () => {
    const result = decimalStringToMinorUnits("0", 2);
    assert.deepEqual(result, { ok: true, minorUnits: 0 });
  });

  test('"" -> typed EMPTY, never NaN/throws', () => {
    const result = decimalStringToMinorUnits("", 2);
    assert.deepEqual(result, { ok: false, reason: "EMPTY" });
  });

  test("null -> typed EMPTY, never NaN/throws", () => {
    const result = decimalStringToMinorUnits(null, 2);
    assert.deepEqual(result, { ok: false, reason: "EMPTY" });
  });

  test("undefined -> typed EMPTY, never NaN/throws", () => {
    const result = decimalStringToMinorUnits(undefined, 2);
    assert.deepEqual(result, { ok: false, reason: "EMPTY" });
  });

  test('"abc" -> typed INVALID_FORMAT, never NaN/throws', () => {
    const result = decimalStringToMinorUnits("abc", 2);
    assert.deepEqual(result, { ok: false, reason: "INVALID_FORMAT" });
  });

  test('"-5.00" -> -500 (decimalStringToMinorUnits itself allows negatives; price-domain rejection is a separate wrapper)', () => {
    const result = decimalStringToMinorUnits("-5.00", 2);
    assert.deepEqual(result, { ok: true, minorUnits: -500 });
  });

  test('"1e3" (exponential notation) -> typed INVALID_FORMAT, never NaN/throws', () => {
    const result = decimalStringToMinorUnits("1e3", 2);
    assert.deepEqual(result, { ok: false, reason: "INVALID_FORMAT" });
  });

  test("whitespace-only string -> typed EMPTY", () => {
    const result = decimalStringToMinorUnits("   ", 2);
    assert.deepEqual(result, { ok: false, reason: "EMPTY" });
  });

  test("exponent 0 currency semantics (e.g. JPY): no fractional digits expected, whole units pass through unchanged", () => {
    const result = decimalStringToMinorUnits("500", 0);
    assert.deepEqual(result, { ok: true, minorUnits: 500 });

    // Fractional digits supplied anyway are still truncated away at
    // exponent 0, consistent with the general truncation semantic above.
    const withFraction = decimalStringToMinorUnits("500.7", 0);
    assert.deepEqual(withFraction, { ok: true, minorUnits: 500 });
  });

  test("exponent 3 currency semantics (e.g. KWD): 3 fractional digits map 1:1 to minor units", () => {
    const result = decimalStringToMinorUnits("1.500", 3);
    assert.deepEqual(result, { ok: true, minorUnits: 1500 });

    const twoDigitInput = decimalStringToMinorUnits("1.5", 3);
    assert.deepEqual(twoDigitInput, { ok: true, minorUnits: 1500 });
  });

  test("a leading '+' sign is accepted", () => {
    const result = decimalStringToMinorUnits("+3.50", 2);
    assert.deepEqual(result, { ok: true, minorUnits: 350 });
  });

  test("int4 boundary: 2147483647 (INT32_MAX) at exponent 0 is OK", () => {
    const result = decimalStringToMinorUnits("2147483647", 0);
    assert.deepEqual(result, { ok: true, minorUnits: 2147483647 });
  });

  test("int4 boundary: 2147483648 (INT32_MAX + 1) at exponent 0 is typed OUT_OF_RANGE, not a throw", () => {
    const result = decimalStringToMinorUnits("2147483648", 0);
    assert.deepEqual(result, { ok: false, reason: "OUT_OF_RANGE" });
  });

  test("int4 boundary: -2147483648 (INT32_MIN) at exponent 0 is OK", () => {
    const result = decimalStringToMinorUnits("-2147483648", 0);
    assert.deepEqual(result, { ok: true, minorUnits: -2147483648 });
  });

  test("int4 boundary: -2147483649 (INT32_MIN - 1) at exponent 0 is typed OUT_OF_RANGE", () => {
    const result = decimalStringToMinorUnits("-2147483649", 0);
    assert.deepEqual(result, { ok: false, reason: "OUT_OF_RANGE" });
  });

  test('IDR-shaped case: "25000000.00" at exponent 2 (unknown-currency default) overflows int4 -> OUT_OF_RANGE, never throws', () => {
    // Concrete failure from the review: shopifyCurrencyCode "IDR" is not in
    // KNOWN_CURRENCY_EXPONENTS, so getCurrencyExponent defaults to exponent
    // 2. An ordinary Indonesian-Rupiah price of ~US$1,500 (25,000,000.00
    // IDR) converts to 2,500,000,000 minor units, which exceeds Postgres
    // int4's 2,147,483,647 ceiling.
    const result = decimalStringToMinorUnits("25000000.00", 2);
    assert.deepEqual(result, { ok: false, reason: "OUT_OF_RANGE" });
  });

  test('USD boundary: "21474836.48" at exponent 2 -> 2147483648, one over the int4 ceiling -> OUT_OF_RANGE', () => {
    const result = decimalStringToMinorUnits("21474836.48", 2);
    assert.deepEqual(result, { ok: false, reason: "OUT_OF_RANGE" });
  });

  test('USD boundary: "21474836.47" at exponent 2 -> 2147483647, exactly the int4 ceiling -> OK', () => {
    const result = decimalStringToMinorUnits("21474836.47", 2);
    assert.deepEqual(result, { ok: true, minorUnits: 2147483647 });
  });

  test("never returns NaN across a battery of malformed inputs", () => {
    const malformedInputs = [
      "",
      "   ",
      "abc",
      "1e3",
      "$19.99",
      "19,99",
      "19.99.99",
      "--5",
      "NaN",
      "Infinity",
      null,
      undefined,
    ];

    for (const input of malformedInputs) {
      const result = decimalStringToMinorUnits(input, 2);
      assert.equal(result.ok, false, `expected ok:false for input ${JSON.stringify(input)}`);
      if (!result.ok) {
        assert.ok(
          result.reason === "EMPTY" ||
            result.reason === "INVALID_FORMAT" ||
            result.reason === "UNSAFE_INTEGER" ||
            result.reason === "OUT_OF_RANGE",
          `expected a typed reason for ${JSON.stringify(input)}, got ${result.reason}`,
        );
      }
    }
  });
});

describe("getCurrencyExponent", () => {
  test("USD, CAD, EUR, GBP -> exponent 2, not defaulted", () => {
    for (const code of ["USD", "CAD", "EUR", "GBP"]) {
      assert.deepEqual(getCurrencyExponent(code), { exponent: 2, defaulted: false });
    }
  });

  test("JPY, KRW -> exponent 0, not defaulted", () => {
    for (const code of ["JPY", "KRW"]) {
      assert.deepEqual(getCurrencyExponent(code), { exponent: 0, defaulted: false });
    }
  });

  test("KWD, BHD, JOD -> exponent 3, not defaulted", () => {
    for (const code of ["KWD", "BHD", "JOD"]) {
      assert.deepEqual(getCurrencyExponent(code), { exponent: 3, defaulted: false });
    }
  });

  test("unknown currency code defaults to exponent 2 AND reports defaulted: true", () => {
    const result = getCurrencyExponent("XYZ");
    assert.deepEqual(result, { exponent: DEFAULT_MINOR_UNIT_EXPONENT, defaulted: true });
    assert.equal(result.defaulted, true, "caller must be able to tell this was a guess, not a verified exponent");
  });

  test("null/undefined/empty currency code also defaults to exponent 2 with defaulted: true, never throws", () => {
    assert.deepEqual(getCurrencyExponent(null), { exponent: 2, defaulted: true });
    assert.deepEqual(getCurrencyExponent(undefined), { exponent: 2, defaulted: true });
    assert.deepEqual(getCurrencyExponent(""), { exponent: 2, defaulted: true });
  });

  test("currency code lookup is case-insensitive", () => {
    assert.deepEqual(getCurrencyExponent("usd"), { exponent: 2, defaulted: false });
    assert.deepEqual(getCurrencyExponent("jpy"), { exponent: 0, defaulted: false });
  });
});

describe("providerPriceStringToMinorUnits (price-domain wrapper)", () => {
  test('"19.99" USD -> 1999 minor units at exponent 2, currencyExponentDefaulted: false', () => {
    const result = providerPriceStringToMinorUnits("19.99", "USD");
    assert.deepEqual(result, {
      ok: true,
      minorUnits: 1999,
      exponent: 2,
      currencyExponentDefaulted: false,
    });
  });

  test('"-5.00" is rejected as NEGATIVE in the price domain (unlike the general decimal helper)', () => {
    const result = providerPriceStringToMinorUnits("-5.00", "USD");
    assert.deepEqual(result, { ok: false, reason: "NEGATIVE" });
  });

  test("unknown currency code still converts the price, using the defaulted exponent, and reports currencyExponentDefaulted: true", () => {
    const result = providerPriceStringToMinorUnits("19.99", "ZZZ");
    assert.deepEqual(result, {
      ok: true,
      minorUnits: 1999,
      exponent: 2,
      currencyExponentDefaulted: true,
    });
  });

  test("malformed/empty price strings propagate the underlying typed reason, never NaN/throws", () => {
    assert.deepEqual(providerPriceStringToMinorUnits("", "USD"), { ok: false, reason: "EMPTY" });
    assert.deepEqual(providerPriceStringToMinorUnits(null, "USD"), { ok: false, reason: "EMPTY" });
    assert.deepEqual(providerPriceStringToMinorUnits("abc", "USD"), {
      ok: false,
      reason: "INVALID_FORMAT",
    });
    assert.deepEqual(providerPriceStringToMinorUnits("1e3", "USD"), {
      ok: false,
      reason: "INVALID_FORMAT",
    });
  });

  test("JPY (exponent 0) price string converts without fractional digits", () => {
    const result = providerPriceStringToMinorUnits("1500", "JPY");
    assert.deepEqual(result, {
      ok: true,
      minorUnits: 1500,
      exponent: 0,
      currencyExponentDefaulted: false,
    });
  });

  test("KWD (exponent 3) price string converts with 3 fractional digits", () => {
    const result = providerPriceStringToMinorUnits("19.990", "KWD");
    assert.deepEqual(result, {
      ok: true,
      minorUnits: 19990,
      exponent: 3,
      currencyExponentDefaulted: false,
    });
  });

  test("never throws and never returns NaN across a battery of malformed price inputs", () => {
    const malformedInputs = ["", "abc", "1e3", null, undefined, "-5.00", "--5"];
    for (const input of malformedInputs) {
      const result = providerPriceStringToMinorUnits(input, "USD");
      assert.equal(result.ok, false, `expected ok:false for input ${JSON.stringify(input)}`);
      if (!result.ok) {
        assert.ok(
          ["EMPTY", "INVALID_FORMAT", "UNSAFE_INTEGER", "OUT_OF_RANGE", "NEGATIVE"].includes(
            result.reason,
          ),
          `expected a typed reason for ${JSON.stringify(input)}, got ${result.reason}`,
        );
      }
    }
  });

  test('IDR-shaped case: "25000000.00" via providerPriceStringToMinorUnits with an unknown currency code -> OUT_OF_RANGE, never throws', () => {
    const result = providerPriceStringToMinorUnits("25000000.00", "IDR");
    assert.deepEqual(result, { ok: false, reason: "OUT_OF_RANGE" });
  });

  test('USD boundary via providerPriceStringToMinorUnits: "21474836.48" -> OUT_OF_RANGE, "21474836.47" -> OK', () => {
    assert.deepEqual(providerPriceStringToMinorUnits("21474836.48", "USD"), {
      ok: false,
      reason: "OUT_OF_RANGE",
    });
    assert.deepEqual(providerPriceStringToMinorUnits("21474836.47", "USD"), {
      ok: true,
      minorUnits: 2147483647,
      exponent: 2,
      currencyExponentDefaulted: false,
    });
  });
});

describe("formatMinorUnitPriceRange (the one shared price formatter)", () => {
  test("exponent 2, min === max -> a single formatted value", () => {
    assert.equal(
      formatMinorUnitPriceRange({
        priceMinMinor: 1200,
        priceMaxMinor: 1200,
        priceMinorUnitExponent: 2,
        currencyCode: "USD",
      }),
      "$12.00",
    );
  });

  test("exponent 2, min !== max -> a joined range", () => {
    assert.equal(
      formatMinorUnitPriceRange({
        priceMinMinor: 1200,
        priceMaxMinor: 2999,
        priceMinorUnitExponent: 2,
        currencyCode: "USD",
      }),
      "$12.00 - $29.99",
    );
  });

  test("exponent 0 (JPY) formats whole units with no decimals", () => {
    assert.equal(
      formatMinorUnitPriceRange({
        priceMinMinor: 1200,
        priceMaxMinor: 1200,
        priceMinorUnitExponent: 0,
        currencyCode: "JPY",
      }),
      "¥1,200",
    );
  });

  test("exponent 3 (KWD) divides by 1000", () => {
    const formatted = formatMinorUnitPriceRange({
      priceMinMinor: 12500,
      priceMaxMinor: 12500,
      priceMinorUnitExponent: 3,
      currencyCode: "KWD",
    });
    assert.ok(formatted);
    assert.match(formatted!, /12\.500$/);
  });

  test("any missing field yields null, never a partial or guessed string", () => {
    const base = {
      priceMinMinor: 1200,
      priceMaxMinor: 1200,
      priceMinorUnitExponent: 2,
      currencyCode: "USD",
    };
    assert.equal(formatMinorUnitPriceRange({ ...base, priceMinMinor: null }), null);
    assert.equal(formatMinorUnitPriceRange({ ...base, priceMaxMinor: null }), null);
    assert.equal(formatMinorUnitPriceRange({ ...base, priceMinorUnitExponent: null }), null);
    assert.equal(formatMinorUnitPriceRange({ ...base, currencyCode: null }), null);
    assert.equal(formatMinorUnitPriceRange({ ...base, currencyCode: "" }), null);
  });

  test("an out-of-contract exponent (negative, > 6, or fractional) yields null", () => {
    const base = { priceMinMinor: 1200, priceMaxMinor: 1200, currencyCode: "USD" };
    assert.equal(formatMinorUnitPriceRange({ ...base, priceMinorUnitExponent: -1 }), null);
    assert.equal(formatMinorUnitPriceRange({ ...base, priceMinorUnitExponent: 7 }), null);
    assert.equal(formatMinorUnitPriceRange({ ...base, priceMinorUnitExponent: 2.5 }), null);
  });

  test("an unusable currency code yields null instead of throwing", () => {
    assert.equal(
      formatMinorUnitPriceRange({
        priceMinMinor: 1200,
        priceMaxMinor: 1200,
        priceMinorUnitExponent: 2,
        currencyCode: "not-a-currency",
      }),
      null,
    );
  });

  test("bigint inputs are accepted; a value beyond exact integer range yields null", () => {
    // BigInt(...) rather than a literal: this project's TS target predates
    // ES2020 bigint literals.
    assert.equal(
      formatMinorUnitPriceRange({
        priceMinMinor: BigInt(1200),
        priceMaxMinor: BigInt(1200),
        priceMinorUnitExponent: 2,
        currencyCode: "USD",
      }),
      "$12.00",
    );
    assert.equal(
      formatMinorUnitPriceRange({
        priceMinMinor: BigInt("9007199254740993"),
        priceMaxMinor: BigInt("9007199254740993"),
        priceMinorUnitExponent: 2,
        currencyCode: "USD",
      }),
      null,
    );
  });
});
