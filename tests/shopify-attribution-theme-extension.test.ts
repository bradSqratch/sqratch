import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import {
  CLICK_TOKEN_CART_ATTRIBUTE,
  CLICK_TOKEN_QUERY_PARAM,
} from "../src/lib/commerce/click-token";

const EXTENSIONS_ROOT = join(process.cwd(), "extensions");
const EMBED_PATH = join(
  EXTENSIONS_ROOT,
  "sqratch-attribution/blocks/sqratch-attribution-embed.liquid",
);

const embed = readFileSync(EMBED_PATH, "utf8");

/**
 * Only the executable body. The Liquid `{% comment %}` header documents both key
 * names in prose, so literal counting must never see it.
 */
const embedScript = embed.slice(embed.indexOf("<script>"), embed.indexOf("</script>"));

function countMatches(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

function listFilesRecursively(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFilesRecursively(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Field/identifier shapes that must never appear in code that builds a Shopify
 * cart attribute. Attribution travels as one opaque 43-character token and
 * nothing else, so a merchant, a shopper, or anyone reading a cart or order
 * payload can never learn a SQRATCH entity id from it.
 */
const FORBIDDEN_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /creator[_-]?id/i,
  /creator[_-]?profile[_-]?id/i,
  /profile[_-]?id/i,
  /experience[_-]?id/i,
  /campaign[_-]?id/i,
  /lesson[_-]?id/i,
  /user[_-]?id/i,
  /brand[_-]?id/i,
  /connection[_-]?id/i,
];

/** A file that can reach Shopify's Ajax Cart attribute surface at all. */
function writesCartAttributes(source: string): boolean {
  return (
    /\/cart\/(update|change|add|clear)\.js/.test(source) ||
    /\bcart_attributes\b/.test(source) ||
    /\battributes\s*:/.test(source)
  );
}

test("Theme App Extension captures only a format-valid namespaced token and preserves merchant attributes", () => {
  assert.match(embed, /const queryParamKey = "sqratch_ref"/);
  assert.match(embed, /const cartAttributeKey = "_sqratch_ref"/);
  assert.match(embed, /searchParams\.get\(queryParamKey\)/);
  assert.match(embed, /\^\[A-Za-z0-9_-\]\{43\}\$/);
  assert.match(embed, /fetch\("\/cart\/update\.js"/);
  assert.match(embed, /attributes: \{ \[cartAttributeKey\]: token \}/);
  assert.doesNotMatch(embed, /checkout|variant_id|\/cart\/add/);
});

test("the embed's two literals mirror the decoupled TypeScript constants", () => {
  assert.equal(CLICK_TOKEN_QUERY_PARAM, "sqratch_ref");
  assert.equal(CLICK_TOKEN_CART_ATTRIBUTE, "_sqratch_ref");
  assert.match(embedScript, new RegExp(`const queryParamKey = "${CLICK_TOKEN_QUERY_PARAM}";`));
  assert.match(embedScript, new RegExp(`const cartAttributeKey = "${CLICK_TOKEN_CART_ATTRIBUTE}";`));
});

test("the URL read key and the cart-attribute write key are genuinely different literals", () => {
  // Regression guard against collapsing the two back into one shared constant:
  // before the rename a single `key` served both roles, and re-merging them
  // would silently un-hide the attribute at checkout.
  assert.notEqual(CLICK_TOKEN_QUERY_PARAM, CLICK_TOKEN_CART_ATTRIBUTE);

  // `"_sqratch_ref"` cannot match `/"sqratch_ref"/` — the character before
  // `sqratch` is `_`, not a quote — so these counts are unambiguous.
  assert.equal(countMatches(embedScript, /"sqratch_ref"/g), 1);
  assert.equal(countMatches(embedScript, /"_sqratch_ref"/g), 1);
  assert.equal(countMatches(embedScript, /"__sqratch_ref"/g), 0);

  // The roles must not be swapped or cross-wired.
  assert.doesNotMatch(embedScript, /searchParams\.get\(cartAttributeKey\)/);
  assert.doesNotMatch(embedScript, /\[queryParamKey\]:/);
  assert.equal(countMatches(embedScript, /\bconst key\b/g), 0);
});

test("the cart attribute carries only the validated opaque token", () => {
  // Exactly one assignment to `token`, sourced from the URL parameter, and
  // gated on the 43-character opaque-token format before it is ever written.
  assert.equal(countMatches(embedScript, /\btoken\s*=/g), 1);
  assert.match(
    embedScript,
    /const token = new URL\(window\.location\.href\)\.searchParams\.get\(queryParamKey\);/,
  );
  assert.match(embedScript, /if \(!token \|\| !\/\^\[A-Za-z0-9_-\]\{43\}\$\/\.test\(token\)\) return;/);

  // Exactly one key is ever written into the cart attributes payload.
  assert.equal(countMatches(embedScript, /attributes:/g), 1);
  assert.equal(countMatches(embedScript, /\[cartAttributeKey\]: token/g), 1);
});

test("no cart-attribute-writing extension code carries a raw SQRATCH identifier", () => {
  const files = listFilesRecursively(EXTENSIONS_ROOT);
  assert.ok(files.length > 0, "expected at least one file under extensions/");

  const scanned: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!writesCartAttributes(source)) {
      continue;
    }
    scanned.push(relative(process.cwd(), file));
    for (const pattern of FORBIDDEN_IDENTIFIER_PATTERNS) {
      assert.doesNotMatch(
        source,
        pattern,
        `${relative(process.cwd(), file)} writes cart attributes and must not reference ${pattern}`,
      );
    }
  }

  // The embed is the only cart-attribute writer today; if a new one appears it
  // is scanned by the loop above rather than silently exempted.
  assert.ok(
    scanned.includes(relative(process.cwd(), EMBED_PATH)),
    `expected the attribution embed to be scanned, saw: ${scanned.join(", ")}`,
  );
});

test("the cart-attribute key itself is opaque and not identifier-shaped", () => {
  const clickTokenSource = readFileSync(
    join(process.cwd(), "src/lib/commerce/click-token.ts"),
    "utf8",
  );

  for (const pattern of FORBIDDEN_IDENTIFIER_PATTERNS) {
    assert.doesNotMatch(CLICK_TOKEN_CART_ATTRIBUTE, pattern);
    assert.doesNotMatch(CLICK_TOKEN_QUERY_PARAM, pattern);
  }

  // A single leading underscore hides the attribute; the double-underscore
  // namespace is reserved for Shopify's own internal attributes.
  assert.match(CLICK_TOKEN_CART_ATTRIBUTE, /^_[a-z0-9_]+$/);
  assert.doesNotMatch(CLICK_TOKEN_CART_ATTRIBUTE, /^__/);

  // The module that defines the cart-attribute key never reaches for an entity
  // id, so there is nothing there for a future edit to smuggle into the cart.
  for (const pattern of FORBIDDEN_IDENTIFIER_PATTERNS) {
    assert.doesNotMatch(clickTokenSource, pattern);
  }
});
