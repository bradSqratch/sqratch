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
 * This is a SOURCE-LEVEL TRIPWIRE, not a behavioral test: it greps every
 * `.ts`/`.tsx` file under `src/` for the 16 field names and asserts the
 * result is EXACTLY the hand-audited allowlist below — every one of these
 * matches has already been individually verified to be one of:
 *   - a same-named field on a canonical-sourced DTO/response type (never a
 *     raw Prisma `Brand` read/write),
 *   - `ShopifyRewardRedemption`'s OWN historical `shopifyShopDomain` column
 *     (a different model, same field name),
 *   - a named parameter feeding `ShopifyConnectionEvent` (a legitimate,
 *     explicitly-retained provider-history model),
 *   - a doc comment,
 *   - the pre-column-drop reconciliation subsystem (diagnostic-only, never
 *     reached by a live user-facing route — scheduled for retirement
 *     alongside the physical column drop in Phase 14C-B), or
 *   - the Shopify `shop/redact` GDPR webhook, which has an explicit,
 *     protected, ongoing obligation to null these columns as long as they
 *     physically exist (a privacy-compliance write, not a compatibility
 *     mirror).
 *
 * A NEW match in a file not on this list means either a genuine regression
 * (a runtime Brand.shopify* read/write crept back in) or a new legitimate
 * case that needs to be reviewed and explicitly added here — either way, this
 * test should fail loudly rather than let it pass silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
 * tripwire.
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
  "src/lib/commerce/providers/shopify-commerce-adapter.ts",
  "src/lib/commerce/providers/shopify-credential-store.ts",
  "src/lib/commerce/shopify-app-embed.ts",
  "src/lib/commerce/types.ts",
  "src/lib/shopify-token-manager.ts",
  // Pre-column-drop reconciliation subsystem — diagnostic-only, never
  // reached by a live user-facing route. Retire alongside the physical
  // column drop (Phase 14C-B).
  "src/lib/commerce/connection-reconciliation.ts",
  "src/lib/commerce/connection-service.ts",
  "src/lib/commerce/connection-sync.ts",
  // Shopify `shop/redact` GDPR webhook — a protected, ongoing privacy
  // obligation to null these columns as long as they physically exist.
  "src/app/api/shopify/webhooks/shop/redact/route.ts",
]);

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
