/**
 * tests/phase-14c-a-brand-shopify-fields-tripwire.test.ts
 *
 * PHASE 14C-A closed out every runtime dependency on the 16 legacy
 * `Brand.shopify*` columns — canonical `CommerceConnection` +
 * `CommerceConnectionSecret` is now the sole runtime authority (see the
 * phase's own commit history / AGENTS.md commerce invariants). The columns
 * themselves are NOT dropped yet (that's Phase 14C-B), so a careless future
 * change can silently reintroduce a real `Brand.shopify*` read or write.
 *
 * This is a SOURCE-LEVEL TRIPWIRE, not a behavioral test, made of TWO
 * independent layers:
 *
 *   1. FILE-LEVEL (tests 1-2 below): greps every `.ts`/`.tsx` file under
 *      `src/` for the 16 field names and asserts the result is EXACTLY the
 *      hand-audited allowlist below.
 *
 *   2. CALL-LEVEL (test 3, PHASE 14C-B1): an independent review of Phase
 *      14C-A correctly flagged that layer 1 alone has a blind spot — a NEW
 *      illegal `prisma.brand.*` read added to a file ALREADY on the
 *      allowlist (e.g. because it legitimately mentions a field name in a
 *      DTO type or a comment) would pass layer 1 undetected, since the
 *      allowlist is keyed on the file, not the call. Layer 2 closes that
 *      gap: it finds every `<something>.brand.<prismaMethod>(...)` call
 *      anywhere in `src/` whose arguments mention one of the 16 fields, and
 *      asserts the TOTAL COUNT of such calls equals `EXPECTED_BRAND_FIELD_CALL_COUNT`
 *      — currently 2, both the explicitly-audited GDPR erasure in
 *      `shop/redact/route.ts`. Adding a brand-new legacy-field-touching call
 *      ANYWHERE — including inside an already-allowlisted file — changes
 *      this count and fails the test, regardless of which file it lands in.
 *
 * Every match under layer 1 has already been individually verified to be
 * one of:
 *   - a same-named field on a canonical-sourced DTO/response type (never a
 *     raw Prisma `Brand` read/write),
 *   - `ShopifyRewardRedemption`'s OWN historical `shopifyShopDomain` column
 *     (a different model, same field name),
 *   - a named parameter feeding `ShopifyConnectionEvent` (a legitimate,
 *     explicitly-retained provider-history model),
 *   - a doc comment,
 *   - the Shopify `shop/redact` GDPR webhook, which has an explicit,
 *     protected, ongoing obligation to null these columns as long as they
 *     physically exist (a privacy-compliance write, not a compatibility
 *     mirror).
 *
 * PHASE 14C-B1: the pre-column-drop reconciliation subsystem
 * (`connection-reconciliation.ts`, `scripts/reconcile-commerce-connections.ts`)
 * has been deleted outright, along with the diagnostic-only drift-reporting
 * pieces of `connection-service.ts` and the Brand-sourced dual-write pieces
 * of `connection-sync.ts` — none of those files match any more.
 *
 * A NEW match in a file not on the layer-1 allowlist, or a count change in
 * layer 2, means either a genuine regression (a runtime Brand.shopify*
 * read/write crept back in) or a new legitimate case that needs to be
 * reviewed and explicitly added here — either way, this test should fail
 * loudly rather than let it pass silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

const LEGACY_BRAND_SHOPIFY_FIELDS = [
  "shopifyShopDomain",
  "shopifyAdminAccessTokenEncrypted",
  "shopifyInstalledAt",
  "shopifyLastProductSyncAt",
  "shopifyDisconnectedAt",
  "shopifyUninstalledAt",
  "shopifyConnectionStatus",
  "shopifyCurrencyCode",
  "shopifyAccessTokenExpiresAt",
  "shopifyAuthMode",
  "shopifyClientId",
  "shopifyGrantedScopes",
  "shopifyRefreshTokenEncrypted",
  "shopifyRefreshTokenExpiresAt",
  "shopifyTokenRefreshLockId",
  "shopifyTokenRefreshLockedUntil",
] as const;

/**
 * Every file under `src/` allowed to match one of the field names above,
 * hand-audited as described in the file header comment. Keep this list
 * SORTED and add a one-line justification comment when adding a new entry —
 * "just add it to make the test pass" defeats the entire point of a
 * tripwire. This layer alone does NOT prove a file's `prisma.brand.*` calls
 * are safe — see test 3 for the call-level layer that does.
 */
const ALLOWED_FILES = new Set<string>([
  // DTO field names on API response shapes, sourced canonically server-side.
  "src/app/(withSidebar)/dashboard/admin/brands/page.tsx",
  "src/app/(withSidebar)/dashboard/brand/products/BrandProductsClient.tsx",
  "src/app/(withSidebar)/dashboard/brand/rewards/page.tsx",
  "src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx",
  "src/app/api/admin/brands/route.ts",
  "src/app/api/brand/shopify/disconnect/route.ts",
  "src/app/api/brand/shopify/status/route.ts",
  "src/app/api/shopify/embedded/status/route.ts",
  "src/lib/shopify-embedded-connection.ts",
  // ShopifyRewardRedemption's OWN historical `shopifyShopDomain` column —
  // a different model than Brand, same field name.
  "src/app/api/rewards/shopify/redeem/route.ts",
  "src/app/api/rewards/shopify/redemptions/[redemptionId]/refresh-status/route.ts",
  "src/app/api/rewards/shopify/redemptions/route.ts",
  "src/lib/reward-reconciliation.ts",
  // Named parameters feeding ShopifyConnectionEvent (retained provider
  // history model) — never a Brand read/write.
  "src/app/api/shopify/installations/[installId]/route.ts",
  "src/app/api/shopify/webhooks/app/uninstalled/route.ts",
  "src/lib/shopify-connection-transitions.ts",
  // Doc comments only — no field access.
  "src/lib/commerce/connection-resolver.ts",
  "src/lib/commerce/connection-sync.ts",
  "src/lib/commerce/providers/shopify-commerce-adapter.ts",
  "src/lib/commerce/providers/shopify-credential-store.ts",
  "src/lib/commerce/shopify-app-embed.ts",
  "src/lib/commerce/types.ts",
  "src/lib/shopify-token-manager.ts",
  // Shopify `shop/redact` GDPR webhook — a protected, ongoing privacy
  // obligation to null these columns as long as they physically exist.
  "src/app/api/shopify/webhooks/shop/redact/route.ts",
]);

/**
 * The exact number of `<x>.brand.<prismaMethod>(...)` calls anywhere in
 * `src/` whose arguments mention a legacy field — see test 3. Currently 2:
 * `shop/redact/route.ts`'s legacy-mirror lookup (`prisma.brand.findMany`,
 * filtered on `shopifyShopDomain`) and its erasure write
 * (`prisma.brand.update`, nulling the 7 credential/domain/status fields).
 * Bump this ONLY after reviewing exactly what new call is being added and
 * why it's legitimate — never merely to make the test pass.
 */
const EXPECTED_BRAND_FIELD_CALL_COUNT = 2;

function grepMatchingFiles(): string[] {
  const pattern = `\\.(${LEGACY_BRAND_SHOPIFY_FIELDS.join("|")})\\b|\\b(${LEGACY_BRAND_SHOPIFY_FIELDS.join("|")})\\s*:`;
  try {
    const output = execFileSync(
      "grep",
      ["-rlE", pattern, "src", "--include=*.ts", "--include=*.tsx"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  } catch (error) {
    // grep exits 1 when there are no matches — that's a valid (empty) result.
    const err = error as { status?: number; stdout?: string };
    if (err.status === 1) return [];
    throw error;
  }
}

test("PHASE 14C-A TRIPWIRE: every src/ file referencing a legacy Brand.shopify* field name is on the hand-audited allowlist", () => {
  const matched = grepMatchingFiles();
  const unexpected = matched.filter((file) => !ALLOWED_FILES.has(file));

  assert.deepEqual(
    unexpected,
    [],
    `Unexpected file(s) referencing a legacy Brand.shopify* field name: ${JSON.stringify(unexpected)}. ` +
      `Either this is a genuine regression (a runtime Brand.shopify* read/write crept back in — fix the code), ` +
      `or it's a new legitimate case that needs review and an explicit, justified addition to ALLOWED_FILES in ` +
      `${join("tests", "phase-14c-a-brand-shopify-fields-tripwire.test.ts")}.`,
  );
});

test("PHASE 14C-A TRIPWIRE: the allowlist itself has no stale entries (every allowed file still exists and still matches)", () => {
  const matched = new Set(grepMatchingFiles());
  const stale = [...ALLOWED_FILES].filter((file) => !matched.has(file));

  assert.deepEqual(
    stale,
    [],
    `Allowlist entries that no longer match anything (remove them — a shrinking allowlist is a sign of ` +
      `progress toward the eventual Phase 14C-B column drop): ${JSON.stringify(stale)}`,
  );
});

/**
 * Finds every `<identifier>.brand.<prismaMethod>(` call in `source` and
 * returns, for each, whether a legacy field name appears within its
 * argument list — found via balanced-paren scanning from the call's own
 * opening `(`, so the window is exactly that one call's arguments, never
 * spilling into unrelated surrounding code (which would cause false
 * positives from a nearby comment or an unrelated later call).
 */
function findBrandFieldTouchingCalls(source: string): number[] {
  const FIELD_PATTERN = new RegExp(`\\b(${LEGACY_BRAND_SHOPIFY_FIELDS.join("|")})\\b`);
  const CALL_PATTERN =
    /\.brand\.(findFirst|findUnique|findMany|findFirstOrThrow|findUniqueOrThrow|update|updateMany|upsert|create|createMany|delete|deleteMany|count)\s*\(/g;

  const matchIndexes: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = CALL_PATTERN.exec(source))) {
    const openParenIndex = match.index + match[0].length - 1;
    let depth = 0;
    let closeParenIndex = -1;
    for (let i = openParenIndex; i < source.length; i++) {
      if (source[i] === "(") depth += 1;
      if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          closeParenIndex = i;
          break;
        }
      }
    }
    if (closeParenIndex === -1) continue; // Unbalanced — shouldn't happen in valid TS.
    const args = source.slice(openParenIndex, closeParenIndex + 1);
    if (FIELD_PATTERN.test(args)) {
      matchIndexes.push(match.index);
    }
  }
  return matchIndexes;
}

test("PHASE 14C-B1 TRIPWIRE: exactly EXPECTED_BRAND_FIELD_CALL_COUNT prisma.brand.* calls anywhere in src/ touch a legacy field — a new one, in ANY file, must fail this test", () => {
  const candidateFiles = grepMatchingFiles(); // A brand.*() call touching a field must appear in a file that also matches the plain field-name grep.
  const findings: string[] = [];

  for (const file of candidateFiles) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const callIndexes = findBrandFieldTouchingCalls(source);
    for (const index of callIndexes) {
      const line = source.slice(0, index).split("\n").length;
      findings.push(`${file}:${line}`);
    }
  }

  assert.equal(
    findings.length,
    EXPECTED_BRAND_FIELD_CALL_COUNT,
    `Expected exactly ${EXPECTED_BRAND_FIELD_CALL_COUNT} prisma.brand.* call(s) touching a legacy Brand.shopify* ` +
      `field (the audited shop/redact GDPR erasure), found ${findings.length}: ${JSON.stringify(findings)}. ` +
      `A count HIGHER than expected means a new Brand.shopify* Prisma call was added somewhere — including possibly ` +
      `inside a file already on the layer-1 allowlist — and must be reviewed before bumping ` +
      `EXPECTED_BRAND_FIELD_CALL_COUNT. A count LOWER than expected means progress (one of the audited calls was ` +
      `removed) — lower the constant to match.`,
  );
});
