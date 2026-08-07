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
