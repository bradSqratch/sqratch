process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/commerce-provider-capabilities.test.ts
 *
 * Phase 13. Locks in the provider-NEUTRAL boundary for the one security
 * decision that used to be an inline `provider === "SHOPIFY"` check inside
 * `src/lib/commerce/click-attribution.ts`'s `validateDestination`.
 *
 * Why this matters beyond tidiness: that branch governs whether a stored
 * product URL whose host differs from the connection's account host may
 * become a real outbound redirect. An inline provider equality check makes
 * every future provider take the "else" path BY ACCIDENT. These tests assert
 * the decision is explicit, centralized, and fail-closed for anything not
 * affirmatively vetted — which is exactly what makes adding a COMMERCE7
 * adapter later a reviewed change rather than a silent behavior shift.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CommerceProvider } from "@prisma/client";
import { providerTrustsSuppliedStorefrontUrl } from "../src/lib/commerce/provider-capabilities";

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("providerTrustsSuppliedStorefrontUrl: the centralized storefront-URL trust decision", () => {
  test("SHOPIFY trusts a provider-supplied URL — Shopify's Product.onlineStoreUrl legitimately uses a merchant custom domain, so host-pinning would reject valid destinations", () => {
    assert.equal(providerTrustsSuppliedStorefrontUrl(CommerceProvider.SHOPIFY), true);
  });

  test("COMMERCE7 fails closed — its storefront-URL provenance is unverified until a Commerce7 adapter exists, and this codebase never guesses provider contracts", () => {
    assert.equal(providerTrustsSuppliedStorefrontUrl(CommerceProvider.COMMERCE7), false);
  });

  test("every value in the CommerceProvider enum has an explicit, total answer (no provider silently inherits a default)", () => {
    for (const provider of Object.values(CommerceProvider)) {
      const result = providerTrustsSuppliedStorefrontUrl(provider);
      assert.equal(
        typeof result,
        "boolean",
        `${provider} must have an explicit boolean decision`,
      );
    }
  });

  test("an unknown/forged provider value fails closed rather than throwing or returning true", () => {
    // Defends the exhaustiveness guard's runtime behavior: a value outside
    // the enum (a stale row, a hand-edited fixture) must never be treated as
    // trusted. Cast is deliberate — this simulates data the type system
    // claims cannot exist.
    const rogue = "TOTALLY_NOT_A_PROVIDER" as unknown as CommerceProvider;
    assert.equal(providerTrustsSuppliedStorefrontUrl(rogue), false);
  });

  test("the module performs no I/O — its CODE never imports prisma, an adapter, or a credential helper (safe on the click-redirect hot path)", () => {
    // Comments are stripped first: this module's own header legitimately
    // NAMES `CommerceAdapter.getCapabilities()` to explain why it exists
    // separately from it, and asserting against prose would false-fail on
    // the very documentation that justifies the design.
    const codeOnly = readSource("src/lib/commerce/provider-capabilities.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    assert.doesNotMatch(codeOnly, /@\/lib\/prisma/);
    assert.doesNotMatch(codeOnly, /getAdapterForConnection|CommerceAdapter/);
    assert.doesNotMatch(codeOnly, /decryptSecret|encryptSecret|accessToken/i);
    assert.doesNotMatch(codeOnly, /\bawait\b/);
  });
});

describe("the neutral click-attribution layer no longer branches on a provider identity inline", () => {
  test("validateDestination calls the centralized predicate instead of comparing provider to a literal", () => {
    const source = readSource("src/lib/commerce/click-attribution.ts");
    const fnStart = source.indexOf("function validateDestination(");
    assert.notEqual(fnStart, -1, "validateDestination must exist");
    // Bound the slice to this function only, so unrelated code elsewhere in
    // the file cannot mask or false-fail the assertion.
    const fnEnd = source.indexOf("\nfunction ", fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    assert.match(fnBody, /providerTrustsSuppliedStorefrontUrl\(provider\)/);
    assert.doesNotMatch(
      fnBody,
      /provider\s*===\s*["'`]SHOPIFY["'`]/,
      "the inline provider equality check must not come back",
    );
    assert.doesNotMatch(
      fnBody,
      /provider\s*===\s*CommerceProvider\./,
      "no provider-identity branching belongs in the neutral destination validator",
    );
  });
});
