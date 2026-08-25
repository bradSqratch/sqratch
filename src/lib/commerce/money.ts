/**
 * src/lib/commerce/money.ts
 *
 * Pure, total, provider-neutral money helpers for converting a commerce
 * provider's DECIMAL STRING price (e.g. Shopify's `ProductVariant.price`,
 * `"19.99"`) into an integer number of minor units (e.g. cents) suitable
 * for persistence.
 *
 * Every function here is TOTAL: for any input, including malformed strings,
 * it returns a typed discriminated-union result. Nothing throws and nothing
 * returns `NaN` — a caller that mishandles the `ok: false` branch gets a
 * type error, not a silently wrong number.
 *
 * All arithmetic is done on the STRING representation of the decimal value,
 * never by parsing to a JS `number` and multiplying. Floating-point
 * multiplication is NOT safe for money: `Math.round(1.005 * 100) === 100`
 * (not 101), because `1.005` cannot be represented exactly in IEEE-754
 * double precision — it is actually stored as ~1.00499999999999989... This
 * module never does that; see `decimalStringToMinorUnits` below for the
 * actual string-splitting algorithm.
 */

/**
 * Explicit minor-unit exponent (number of digits after the decimal point
 * that make up one "major" unit) for every currency code this module knows
 * about. A code that is NOT a key here is genuinely unknown to this module
 * — `getCurrencyExponent` falls back to the documented default of 2 for it
 * AND reports that the exponent was defaulted (`defaulted: true`), since we
 * have not actually verified that currency's real exponent.
 */
const KNOWN_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  // 2-decimal currencies (ISO 4217 exponent 2) — the common case.
  USD: 2,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  NZD: 2,
  // 0-decimal currencies (ISO 4217 exponent 0).
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  HUF: 0,
  TWD: 0,
  // 3-decimal currencies (ISO 4217 exponent 3).
  KWD: 3,
  BHD: 3,
  JOD: 3,
  OMR: 3,
  TND: 3,
};

/** The documented default exponent used for any currency code not present in `KNOWN_CURRENCY_EXPONENTS`. */
export const DEFAULT_MINOR_UNIT_EXPONENT = 2;

export type CurrencyExponentResult = {
  exponent: number;
  /**
   * `true` when `exponent` came from `DEFAULT_MINOR_UNIT_EXPONENT` because
   * the currency code is not one this module has verified an exponent for
   * (unknown, empty, or malformed) — lets a caller distinguish "this really
   * is a verified 2-decimal currency" from "we don't actually know this
   * currency's exponent and guessed 2".
   */
  defaulted: boolean;
};

/**
 * Resolves a currency code's minor-unit exponent. Total: always returns a
 * result, defaulting any code not in `KNOWN_CURRENCY_EXPONENTS` to
 * `DEFAULT_MINOR_UNIT_EXPONENT` with `defaulted: true`.
 */
export function getCurrencyExponent(
  currencyCode: string | null | undefined,
): CurrencyExponentResult {
  const code = (currencyCode ?? "").trim().toUpperCase();
  const known = KNOWN_CURRENCY_EXPONENTS[code];

  if (known !== undefined) {
    return { exponent: known, defaulted: false };
  }

  return { exponent: DEFAULT_MINOR_UNIT_EXPONENT, defaulted: true };
}

export type DecimalToMinorUnitsResult =
  | { ok: true; minorUnits: number }
  | { ok: false; reason: "EMPTY" | "INVALID_FORMAT" | "UNSAFE_INTEGER" | "OUT_OF_RANGE" };

/** The `BIGINT` range used by provider-neutral order totals in Postgres. */
const INT64_MIN = BigInt("-9223372036854775808");
const INT64_MAX = BigInt("9223372036854775807");

export type DecimalToBigIntMinorUnitsResult =
  | { ok: true; minorUnits: bigint }
  | { ok: false; reason: "EMPTY" | "INVALID_FORMAT" | "OUT_OF_RANGE" };

/**
 * Postgres `INTEGER` (int4) bounds. `CommerceProduct.priceMinMinor` /
 * `priceMaxMinor` are declared as `INTEGER` in `prisma/schema.prisma` (see
 * `prisma/migrations/20260806140000_add_commerce_product_catalog`), which is
 * a signed 32-bit range — far tighter than `Number.isSafeInteger`'s 2^53
 * ceiling. A value that passes the safe-integer check can still overflow
 * int4 (e.g. a large-denomination currency like IDR at the default 2-decimal
 * exponent), which would otherwise throw a Postgres `22003` error at
 * `create`/`update` time. Reject it here, as a typed result, instead.
 */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// Optional leading sign, one or more integer digits, optional fractional
// part. Deliberately does NOT accept exponential notation ("1e3"), thousands
// separators, or whitespace inside the number — a provider decimal price
// string is never formatted that way, and rejecting anything else keeps
// this parser from ever guessing at ambiguous input.
const DECIMAL_STRING_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * Converts a decimal string (e.g. "19.99", "-3.5", "0") to an integer count
 * of minor units at the given exponent, using pure string arithmetic:
 *
 *   1. Split the string into an optional sign, integer part, and fractional
 *      part on the literal "." character.
 *   2. Pad the fractional part with trailing zeros (or truncate it) to
 *      exactly `exponent` digits.
 *   3. Concatenate integer + padded-fraction digits and parse THAT as an
 *      integer.
 *
 * Truncation, not rounding: when the input has MORE fractional digits than
 * the target exponent (e.g. "1.005" at exponent 2), the extra digits are
 * dropped outright rather than rounded — "1.005" becomes "1.00" (100 minor
 * units), not "1.01" (101) or "1.00"-via-banker's-rounding. This is a
 * deliberate, conservative choice: silently rounding a provider's price up
 * would overcharge; this module never invents precision the source string
 * didn't have.
 *
 * Total: never throws, never returns `NaN`. Handles a leading `+`/`-`.
 * Rejects anything that isn't a plain decimal numeral (`""`, `null`,
 * non-numeric text, exponential notation, etc.) with a typed `ok: false`
 * result instead of throwing or coercing to `NaN`.
 */
export function decimalStringToMinorUnits(
  raw: string | null | undefined,
  exponent: number,
): DecimalToMinorUnitsResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "EMPTY" };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "EMPTY" };
  }

  const match = DECIMAL_STRING_PATTERN.exec(trimmed);
  if (!match) {
    return { ok: false, reason: "INVALID_FORMAT" };
  }

  const [, signPart, integerDigits, fractionDigits = ""] = match;
  const sign = signPart === "-" ? -1 : 1;

  const paddedFraction = (fractionDigits + "0".repeat(exponent)).slice(0, exponent);
  const combinedDigits = `${integerDigits}${paddedFraction}`.replace(/^0+(?=\d)/, "");

  const minorUnits = sign * Number(combinedDigits);

  if (!Number.isSafeInteger(minorUnits)) {
    return { ok: false, reason: "UNSAFE_INTEGER" };
  }

  if (minorUnits < INT32_MIN || minorUnits > INT32_MAX) {
    return { ok: false, reason: "OUT_OF_RANGE" };
  }

  return { ok: true, minorUnits };
}

/**
 * The BigInt counterpart for order totals. Catalog prices intentionally stay
 * on the int4-bounded function above; provider order columns are BigInt and
 * must not silently lose an otherwise representable high-value order.
 */
export function decimalStringToBigIntMinorUnits(
  raw: string | null | undefined,
  exponent: number,
): DecimalToBigIntMinorUnitsResult {
  if (raw === null || raw === undefined) return { ok: false, reason: "EMPTY" };

  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "EMPTY" };

  const match = DECIMAL_STRING_PATTERN.exec(trimmed);
  if (!match) return { ok: false, reason: "INVALID_FORMAT" };

  const [, signPart, integerDigits, fractionDigits = ""] = match;
  const paddedFraction = (fractionDigits + "0".repeat(exponent)).slice(0, exponent);
  const digits = `${integerDigits}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  const minorUnits = (signPart === "-" ? BigInt(-1) : BigInt(1)) * BigInt(digits);

  if (minorUnits < INT64_MIN || minorUnits > INT64_MAX) {
    return { ok: false, reason: "OUT_OF_RANGE" };
  }

  return { ok: true, minorUnits };
}

/**
 * Formats a persisted minor-unit price RANGE for display, e.g. "$12.00" or
 * "$12.00 - $19.99". Returns `null` — never a partial or guessed string —
 * whenever any input needed to name the amount is missing or unusable.
 *
 * This is the ONE shared implementation of a formatter that was previously
 * duplicated verbatim across four route/service modules
 * (`formatPersistedPrice` / `formatCatalogProductPrice`). Its behavior is
 * deliberately IDENTICAL to those copies, including:
 *
 *  - the guard: all four of priceMin/priceMax/exponent/currency must be
 *    present, and the exponent must be an integer in [0, 6];
 *  - the HARDCODED "en-US" locale. This is not an oversight and must not be
 *    "improved" to a request locale: doing so would silently change every
 *    price string SQRATCH has ever rendered. Only the currency SYMBOL and
 *    grouping come from `currencyCode`;
 *  - a `null` result rather than a throw for an unusable currency code
 *    (`Intl.NumberFormat` throws `RangeError` for one).
 *
 * `bigint` inputs are accepted because the Phase 7 order money columns are
 * BIGINT while the catalog columns are INTEGER; a value too large to be an
 * exact `number` yields `null` rather than a silently rounded amount.
 */
export function formatMinorUnitPriceRange(input: {
  priceMinMinor: number | bigint | null;
  priceMaxMinor: number | bigint | null;
  priceMinorUnitExponent: number | null;
  currencyCode: string | null;
}): string | null {
  const { priceMinMinor, priceMaxMinor, priceMinorUnitExponent, currencyCode } = input;

  if (
    priceMinMinor === null ||
    priceMaxMinor === null ||
    priceMinorUnitExponent === null ||
    !currencyCode ||
    !Number.isInteger(priceMinorUnitExponent) ||
    priceMinorUnitExponent < 0 ||
    priceMinorUnitExponent > 6
  ) {
    return null;
  }

  const min = Number(priceMinMinor);
  const max = Number(priceMaxMinor);

  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    return null;
  }

  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    });
    const divisor = 10 ** priceMinorUnitExponent;
    const minText = formatter.format(min / divisor);
    const maxText = formatter.format(max / divisor);
    return min === max ? minText : `${minText} - ${maxText}`;
  } catch {
    return null;
  }
}

export type PriceStringToMinorUnitsResult =
  | {
      ok: true;
      minorUnits: number;
      exponent: number;
      /** See `CurrencyExponentResult.defaulted` — propagated through unchanged. */
      currencyExponentDefaulted: boolean;
    }
  | {
      ok: false;
      reason: "EMPTY" | "INVALID_FORMAT" | "UNSAFE_INTEGER" | "OUT_OF_RANGE" | "NEGATIVE";
    };

/**
 * Converts a provider decimal PRICE string (e.g. Shopify's
 * `ProductVariant.price` / `priceRangeRaw.min`/`.max` on
 * `NormalizedShopifyProduct`) to integer minor units for a given currency
 * code, resolving the currency's exponent via `getCurrencyExponent`.
 *
 * This is a thin, price-domain-specific wrapper around
 * `decimalStringToMinorUnits`: unlike that general-purpose decimal parser
 * (which legitimately represents negative amounts for domains where they
 * are valid, e.g. refunds or ledger entries), a product PRICE is never
 * negative in this codebase's domain. A negative provider price string
 * indicates corrupt or unexpected upstream data, so it is rejected here as
 * a typed `NEGATIVE` result rather than silently persisted as a negative
 * price.
 */
export function providerPriceStringToMinorUnits(
  raw: string | null | undefined,
  currencyCode: string | null | undefined,
): PriceStringToMinorUnitsResult {
  const { exponent, defaulted } = getCurrencyExponent(currencyCode);
  const parsed = decimalStringToMinorUnits(raw, exponent);

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.minorUnits < 0) {
    return { ok: false, reason: "NEGATIVE" };
  }

  return {
    ok: true,
    minorUnits: parsed.minorUnits,
    exponent,
    currencyExponentDefaulted: defaulted,
  };
}

// ---------------------------------------------------------------------------
// EXACT MINOR-UNIT DISPLAY FORMATTING (PHASE 19 REPAIR — P1-3)
// ---------------------------------------------------------------------------
//
// `formatMinorUnitPriceRange` above is deliberately scoped to the PRODUCT
// CATALOG (`ConnectedCommerceProduct.priceMinMinor`/`priceMaxMinor`, both
// Postgres `Int` columns — 32-bit, always well within `Number.isSafeInteger`
// range) and intentionally uses `Number()` + `Intl.NumberFormat` for a
// symbol-prefixed, locale-formatted string. That is safe for its bounded
// domain and must not be changed.
//
// Order money (`CommerceOrder.totalMinor` etc.) is different: those columns
// are `BigInt`, with no upper bound this codebase enforces, and a "1234.56"
// UI that did `Number(minor) / 100` would (a) silently corrupt any value
// past `Number.MAX_SAFE_INTEGER`, (b) divide by a HARDCODED 100 regardless
// of the persisted `minorUnitExponent`, single-handedly making JPY (exponent
// 0) read 100x too small and KWD-style 3-decimal currencies read 10x too
// large. The functions below exist specifically to never do either — see
// `formatExactMinorAmount`'s own doc comment for the string/BigInt-only
// algorithm.

/** Digit-string sanity check — the ONLY shape `formatExactMinorAmount` accepts as `minor`. */
const INTEGER_STRING_PATTERN = /^-?\d+$/;

/**
 * Converts an INTEGER number of minor units (as a decimal string or
 * `bigint` — e.g. `"123456"` cents, never a float) plus its
 * `minorUnitExponent` into an exact decimal STRING (`"1234.56"`), using
 * ONLY string manipulation and `BigInt`-safe integer digit operations —
 * never `Number()`, `parseFloat`, or floating-point division. Correct for
 * any magnitude, including values far beyond `Number.MAX_SAFE_INTEGER`
 * (verified in `tests/money-display.test.ts` with values larger than
 * `9007199254740991`), and for every documented exponent (0, 2, 3, ...).
 *
 * Examples: `("123456", 2) -> "1234.56"`, `("5000", 0) -> "5000"`,
 * `("12345", 3) -> "12.345"`, `("-500", 2) -> "-5.00"`.
 *
 * Throws for a malformed `minor` string or a negative/non-integer
 * `exponent` — this is a pure, total-over-VALID-input formatter; callers
 * displaying possibly-absent data should use `formatMoneyDisplay` below,
 * which handles `null` and formatting failure by returning an explicit
 * "unknown" marker instead of ever fabricating a number.
 */
export function formatExactMinorAmount(minor: string | bigint, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new Error(`formatExactMinorAmount: invalid minorUnitExponent ${exponent}`);
  }
  const raw = typeof minor === "bigint" ? minor.toString() : minor;
  if (!INTEGER_STRING_PATTERN.test(raw)) {
    throw new Error(`formatExactMinorAmount: invalid minor-unit amount ${JSON.stringify(raw)}`);
  }

  const negative = raw.startsWith("-");
  const unsignedDigits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");

  if (exponent === 0) {
    return (negative ? "-" : "") + unsignedDigits;
  }

  const padded = unsignedDigits.padStart(exponent + 1, "0");
  const integerPart = padded.slice(0, padded.length - exponent);
  const fractionPart = padded.slice(padded.length - exponent);
  const isZero = integerPart === "0" && /^0*$/.test(fractionPart);
  return `${negative && !isZero ? "-" : ""}${integerPart}.${fractionPart}`;
}

/** Inserts thousands-separator commas into an unsigned integer digit string — pure string manipulation, no numeric conversion. */
function groupIntegerDigits(digits: string): string {
  let grouped = "";
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    grouped += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) {
      grouped += ",";
    }
  }
  return grouped;
}

/**
 * The safe, exact, provider-neutral order-money display formatter (PHASE 19
 * — Parts 9/10/11). Combines the ISO currency CODE (never a symbol — see
 * Part 9A: correctness over symbol prettiness, since a symbol would require
 * `Intl`, which requires a `Number()` conversion this module refuses to do
 * for potentially-huge `BigInt` order amounts) with a comma-grouped exact
 * amount from `formatExactMinorAmount`.
 *
 * "Unknown must display as unknown, never as zero" (Part 10/11): returns
 * `"—"` whenever `minor`, `currencyCode`, or `exponent` is `null`, or when
 * `minor`/`exponent` fail `formatExactMinorAmount`'s validation — NEVER a
 * fabricated `"0.00"` or a value computed against a guessed exponent.
 *
 * Examples: `("123456", "USD", 2) -> "USD 1,234.56"`,
 * `("5000", "JPY", 0) -> "JPY 5,000"`,
 * `("12345", "KWD", 3) -> "KWD 12.345"`.
 */
export function formatMoneyDisplay(
  minor: string | bigint | null,
  currencyCode: string | null,
  exponent: number | null,
): string {
  if (minor === null || currencyCode === null || exponent === null) {
    return "—";
  }
  let exact: string;
  try {
    exact = formatExactMinorAmount(minor, exponent);
  } catch {
    return "—";
  }
  const negative = exact.startsWith("-");
  const unsigned = negative ? exact.slice(1) : exact;
  const dotIndex = unsigned.indexOf(".");
  const integerPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fractionPart = dotIndex === -1 ? null : unsigned.slice(dotIndex + 1);
  const groupedInteger = groupIntegerDigits(integerPart);
  const groupedAmount = fractionPart !== null ? `${groupedInteger}.${fractionPart}` : groupedInteger;
  return `${currencyCode} ${negative ? "-" : ""}${groupedAmount}`;
}
