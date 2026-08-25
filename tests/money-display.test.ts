/**
 * PHASE 19 REPAIR — P1-3 / Part 9/14C: exact minor-unit money display
 * formatting. Every case here proves NO Number()/parseFloat/division is
 * ever involved and NO precision is lost, including for values far beyond
 * Number.MAX_SAFE_INTEGER.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { formatExactMinorAmount, formatMoneyDisplay } from "../src/lib/commerce/money";

describe("formatExactMinorAmount", () => {
  test("USD exponent 2: 123456 minor -> 1234.56", () => {
    assert.equal(formatExactMinorAmount("123456", 2), "1234.56");
  });

  test("JPY exponent 0: 5000 minor -> 5000 (never divided by 100)", () => {
    assert.equal(formatExactMinorAmount("5000", 0), "5000");
  });

  test("KWD/BHD-style exponent 3: 12345 minor -> 12.345", () => {
    assert.equal(formatExactMinorAmount("12345", 3), "12.345");
  });

  test("a very small amount smaller than the exponent still pads correctly", () => {
    assert.equal(formatExactMinorAmount("5", 2), "0.05");
    assert.equal(formatExactMinorAmount("5", 3), "0.005");
  });

  test("zero renders without a sign, at any exponent", () => {
    assert.equal(formatExactMinorAmount("0", 2), "0.00");
    assert.equal(formatExactMinorAmount("0", 0), "0");
    assert.equal(formatExactMinorAmount("-0", 2), "0.00", "a literal -0 string never renders as negative");
  });

  test("negative amounts are supported and exact", () => {
    assert.equal(formatExactMinorAmount("-500", 2), "-5.00");
    assert.equal(formatExactMinorAmount("-5", 0), "-5");
    assert.equal(formatExactMinorAmount("-12345", 3), "-12.345");
  });

  test("a bigint input is accepted identically to its decimal string", () => {
    assert.equal(formatExactMinorAmount(BigInt(123456), 2), formatExactMinorAmount("123456", 2));
  });

  test("large values beyond Number.MAX_SAFE_INTEGER remain exact — no precision loss", () => {
    // MAX_SAFE_INTEGER is 9007199254740991. Number(minor) on the value
    // below would silently round; the exact string must not.
    const huge = "900719925474099312345";
    assert.equal(formatExactMinorAmount(huge, 2), "9007199254740993123.45");
    assert.equal(formatExactMinorAmount(BigInt(huge), 2), "9007199254740993123.45");
  });

  test("an even-larger negative value beyond MAX_SAFE_INTEGER is also exact", () => {
    const huge = "-900719925474099312345";
    assert.equal(formatExactMinorAmount(huge, 3), "-900719925474099312.345");
  });

  test("throws for a malformed minor-unit string rather than silently producing NaN/garbage", () => {
    assert.throws(() => formatExactMinorAmount("12.5", 2));
    assert.throws(() => formatExactMinorAmount("abc", 2));
    assert.throws(() => formatExactMinorAmount("", 2));
  });

  test("throws for an invalid exponent", () => {
    assert.throws(() => formatExactMinorAmount("100", -1));
    assert.throws(() => formatExactMinorAmount("100", 1.5));
  });

  test("source lock: this module never uses Number(), parseFloat, or division for the exact formatter", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "commerce", "money.ts"),
      "utf8",
    );
    const startMarker = "export function formatExactMinorAmount";
    const endMarker = "function groupIntegerDigits";
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    assert.ok(start !== -1 && end !== -1 && end > start);
    const body = source.slice(start, end);
    assert.ok(!/\bNumber\(/.test(body), "formatExactMinorAmount must never call Number()");
    assert.ok(!/parseFloat|parseInt/.test(body), "formatExactMinorAmount must never call parseFloat/parseInt");
    assert.ok(!/\/\s*100\b/.test(body), "formatExactMinorAmount must never hard-code a /100 division");
  });
});

describe("formatMoneyDisplay", () => {
  test("USD example: 123456 minor -> 'USD 1,234.56' (comma-grouped, code not symbol)", () => {
    assert.equal(formatMoneyDisplay("123456", "USD", 2), "USD 1,234.56");
  });

  test("JPY example: 5000 minor -> 'JPY 5,000'", () => {
    assert.equal(formatMoneyDisplay("5000", "JPY", 0), "JPY 5,000");
  });

  test("KWD example: 12345 minor -> 'KWD 12.345'", () => {
    assert.equal(formatMoneyDisplay("12345", "KWD", 3), "KWD 12.345");
  });

  test("large grouped amount: 123456789 minor USD -> 'USD 1,234,567.89'", () => {
    assert.equal(formatMoneyDisplay("123456789", "USD", 2), "USD 1,234,567.89");
  });

  test("a negative amount groups correctly with the sign outside the grouped digits", () => {
    assert.equal(formatMoneyDisplay("-123456789", "USD", 2), "USD -1,234,567.89");
  });

  test("null amount displays unknown, never a fabricated zero", () => {
    assert.equal(formatMoneyDisplay(null, "USD", 2), "—");
  });

  test("null currency displays unknown, even with a real amount/exponent", () => {
    assert.equal(formatMoneyDisplay("1000", null, 2), "—");
  });

  test("null exponent displays unknown — never silently assumes 2", () => {
    assert.equal(formatMoneyDisplay("1000", "USD", null), "—");
  });

  test("a malformed minor string displays unknown, never throws to the caller", () => {
    assert.equal(formatMoneyDisplay("not-a-number", "USD", 2), "—");
  });

  test("zero is a real, known value and displays as a real zero, not unknown", () => {
    assert.equal(formatMoneyDisplay("0", "USD", 2), "USD 0.00");
  });

  test("a value beyond MAX_SAFE_INTEGER renders exactly, grouped, through the display formatter too", () => {
    assert.equal(
      formatMoneyDisplay("900719925474099312345", "USD", 2),
      "USD 9,007,199,254,740,993,123.45",
    );
  });
});
