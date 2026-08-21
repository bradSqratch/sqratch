process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/legacy-product-link-removal.test.ts
 *
 * Phase 8, Step 6 regression guard — the single most valuable one in the phase.
 *
 * Two jobs:
 *
 *  1. MIGRATION SHAPE. Assert that
 *     20260808130000_remove_legacy_product_link_snapshots does exactly what its
 *     header claims and nothing more: three fail-closed preflight gates that
 *     precede every destructive statement, an exact drop set, no row-deleting
 *     DML, and plain DROP TABLE (never CASCADE).
 *
 *  2. SCHEMA SHAPE. Assert the legacy dual representation is GONE from
 *     prisma/schema.prisma, AND that nothing on the KEEP list went with it —
 *     every Brand.shopify* compatibility column and every model Phase 8 was
 *     required to preserve.
 *
 * These are text-level assertions against files on disk. They never connect to
 * a database (DATABASE_URL above is a deliberately unroutable sentinel).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");

const MIGRATION_DIR = "20260808130000_remove_legacy_product_link_snapshots";
const migration = readFileSync(
  join(root, "prisma/migrations", MIGRATION_DIR, "migration.sql"),
  "utf8",
);

/**
 * Strips whole-line `-- comment` lines so keyword checks only ever see
 * executable SQL. This matters more here than in any other migration test: the
 * header of this migration deliberately names DELETE / TRUNCATE / UPDATE /
 * CASCADE / ON DELETE in prose in order to document their ABSENCE, which would
 * false-positive any naive full-text search.
 */
function executableSql(sql: string) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const executable = executableSql(migration);

/**
 * Strips `//` and `///` comment lines from the Prisma schema so shape checks see
 * only DECLARATIONS. The schema deliberately keeps tombstone prose naming the
 * removed models and columns (so a future reader learns why they are gone
 * instead of re-inventing them); that prose must not satisfy — or defeat — a
 * "this object no longer exists" assertion.
 */
function schemaDeclarations(prismaSchema: string) {
  return prismaSchema
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const declarations = schemaDeclarations(schema);

/** The models Phase 8 was required to preserve, structurally unaltered. */
const KEEP_MODELS = [
  "CommerceConnection",
  "CommerceConnectionSecret",
  "ConnectedCommerceProduct",
  "CommerceProductSyncRun",
  "BrandCommerceProduct",
  "CampaignCommerceProduct",
  "CampaignLessonProduct",
  "CommerceClickAttribution",
  "CommerceOrder",
  "CommerceOrderLineItem",
  "CommerceOrderEvent",
  "CampaignExperience",
  "BrandRewardOffer",
  "BrandRewardOfferProduct",
  "ShopifyRewardRedemption",
  "PointTransaction",
  "UserPointAccount",
  "User",
  "QRCode",
  "QRCodeBatch",
  "CampaignUnlock",
  "Campaign",
  "Brand",
  "Experience",
  "Course",
  "Lesson",
] as const;

/**
 * The 16 legacy Brand.shopify* compatibility columns.
 *
 * PHASE 8 (historical): every one had to SURVIVE — the Phase 8 migration was
 * not allowed to drop them, which the "no Brand.shopify* column appears in any
 * drop statement" test below still enforces against that historical migration.
 *
 * PHASE 14C-B2 (current): they have all been physically dropped. `Brand` now
 * carries zero Shopify connection/credential state — `CommerceConnection` +
 * `CommerceConnectionSecret` are the sole authority. The test below is
 * inverted accordingly: every name must now be ABSENT from model Brand.
 */
const BRAND_SHOPIFY_COLUMNS = [
  "shopifyShopDomain",
  "shopifyAdminAccessTokenEncrypted",
  "shopifyInstalledAt",
  "shopifyDisconnectedAt",
  "shopifyUninstalledAt",
  "shopifyConnectionStatus",
  "shopifyLastProductSyncAt",
  "shopifyCurrencyCode",
  "shopifyAccessTokenExpiresAt",
  "shopifyRefreshTokenEncrypted",
  "shopifyRefreshTokenExpiresAt",
  "shopifyGrantedScopes",
  "shopifyClientId",
  "shopifyTokenRefreshLockedUntil",
  "shopifyTokenRefreshLockId",
  "shopifyAuthMode",
] as const;

// ---------------------------------------------------------------------------
// 1. MIGRATION SHAPE
// ---------------------------------------------------------------------------

test("the migration declares three fail-closed preflight gates, each RAISE EXCEPTION in its own DO block", () => {
  const doBlocks = executable.match(/DO \$\$/g) ?? [];
  assert.equal(doBlocks.length, 3, "exactly three preflight DO blocks");

  const raises = executable.match(/RAISE EXCEPTION/g) ?? [];
  assert.equal(raises.length, 3, "each gate raises");

  // Gate 1: ExperienceProductLink must be empty.
  assert.match(executable, /SELECT count\(\*\) INTO remaining FROM "ExperienceProductLink";/);
  assert.match(
    executable,
    /table "ExperienceProductLink" still contains % row\(s\)/,
  );
  // Gate 2: LessonProductLink must be empty.
  assert.match(executable, /SELECT count\(\*\) INTO remaining FROM "LessonProductLink";/);
  assert.match(executable, /table "LessonProductLink" still contains % row\(s\)/);
  // Gate 3: the canonical chain of every ACTIVE attachment must be intact and
  // same-brand, because after this migration it is the only way to resolve one.
  assert.match(executable, /FROM "CampaignLessonProduct" clp/);
  assert.match(executable, /LEFT JOIN "BrandCommerceProduct" bcp/);
  assert.match(executable, /LEFT JOIN "ConnectedCommerceProduct" ccp/);
  assert.match(executable, /WHERE clp\."isActive"/);
  assert.match(executable, /bcp\."brandId" <> clp\."brandId"/);
  assert.match(executable, /ccp\."brandId" <> clp\."brandId"/);
  assert.match(executable, /broken or cross-brand canonical chain/);

  // Every gate names an actionable REQUIRED ACTION so a failed deploy log tells
  // the operator exactly what to clean.
  const requiredActions = executable.match(/REQUIRED ACTION:/g) ?? [];
  assert.equal(requiredActions.length, 3);
});

test("gate 3 deliberately does NOT fail on a NULL bridge on an active row", () => {
  // The pre-Phase-8 invariant was "active implies bridge non-null", so gating on
  // `isActive AND legacyLessonProductLinkId IS NULL` looks plausible — and would
  // be BACKWARDS. Step 2 stopped writing the bridge (so canonically-created rows
  // are active with a NULL bridge, which is the new correct state), and the
  // operator's deletion of all LessonProductLink rows fires the pre-existing
  // ON DELETE SET NULL FK, nulling the bridge on survivors. Gating on it would
  // abort the deploy on legitimately correct data.
  assert.doesNotMatch(executable, /legacyLessonProductLinkId"?\s+IS\s+NULL/i);
  assert.doesNotMatch(executable, /IS\s+NOT\s+NULL/i);
  // The header must record the reasoning so nobody "fixes" the gate later.
  assert.match(migration, /WHAT GATE 3 DELIBERATELY DOES \*NOT\* CHECK/);
  assert.match(migration, /BACKWARDS/);
});

test("every preflight gate precedes every destructive statement", () => {
  const lines = executable.split("\n");

  const lastGateLine = lines.reduce(
    (acc, line, i) => (/END \$\$;/.test(line) ? i : acc),
    -1,
  );
  assert.ok(lastGateLine > 0, "found the end of the last preflight block");

  const destructiveLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /\bDROP\b/i.test(line))
    .map(({ i }) => i);

  assert.equal(destructiveLines.length, 6, "six destructive statements");
  for (const i of destructiveLines) {
    assert.ok(
      i > lastGateLine,
      `destructive statement on executable line ${i} must come after the last preflight gate (line ${lastGateLine})`,
    );
  }
});

test("the drop set is exactly six objects: four DROP COLUMN and two DROP TABLE", () => {
  const dropColumns = executable.match(/\bDROP COLUMN\b/g) ?? [];
  const dropTables = executable.match(/\bDROP TABLE\b/g) ?? [];
  const allDrops = executable.match(/\bDROP\b/gi) ?? [];

  assert.equal(dropColumns.length, 4);
  assert.equal(dropTables.length, 2);
  assert.equal(allDrops.length, 6, "no DROP other than those six");

  assert.match(
    executable,
    /ALTER TABLE "CommerceClickAttribution" DROP COLUMN "lessonProductLinkId";/,
  );
  assert.match(
    executable,
    /ALTER TABLE "CommerceClickAttribution" DROP COLUMN "experienceProductLinkId";/,
  );
  assert.match(
    executable,
    /ALTER TABLE "CampaignLessonProduct" DROP COLUMN "legacyLessonProductLinkId";/,
  );
  assert.match(executable, /DROP TABLE "LessonProductLink";/);
  assert.match(executable, /DROP TABLE "ExperienceProductLink";/);
  assert.match(
    executable,
    /ALTER TABLE "Campaign" DROP COLUMN "commerceProductCurationEnabled";/,
  );
});

test("a referencing column is dropped before the table it references", () => {
  const idx = (needle: string) => executable.indexOf(needle);

  const clpBridgeDrop = idx('ALTER TABLE "CampaignLessonProduct" DROP COLUMN "legacyLessonProductLinkId"');
  const ccaLessonDrop = idx('DROP COLUMN "lessonProductLinkId"');
  const ccaExpDrop = idx('DROP COLUMN "experienceProductLinkId"');
  const lessonTableDrop = idx('DROP TABLE "LessonProductLink"');
  const expTableDrop = idx('DROP TABLE "ExperienceProductLink"');

  for (const n of [clpBridgeDrop, ccaLessonDrop, ccaExpDrop, lessonTableDrop, expTableDrop]) {
    assert.ok(n > -1);
  }
  assert.ok(ccaLessonDrop < lessonTableDrop);
  assert.ok(clpBridgeDrop < lessonTableDrop);
  assert.ok(ccaExpDrop < expTableDrop);
});

test("no row-deleting or row-mutating statement exists anywhere in the migration", () => {
  assert.doesNotMatch(executable, /\bDELETE\b/i);
  assert.doesNotMatch(executable, /\bTRUNCATE\b/i);
  assert.doesNotMatch(executable, /\bUPDATE\b/i);
  // Nor an in-place type/nullability change on a surviving column.
  assert.doesNotMatch(executable, /\bALTER COLUMN\b/i);
  // The only reads are the preflight counts.
  const selects = executable.match(/\bSELECT\b/gi) ?? [];
  assert.equal(selects.length, 3, "exactly the three preflight counts");
});

test("DROP TABLE is plain, never CASCADE, so an unanticipated dependency fails the deploy loudly", () => {
  assert.doesNotMatch(executable, /\bCASCADE\b/i);
  assert.doesNotMatch(executable, /DROP TABLE[^;]*CASCADE/i);
  assert.doesNotMatch(executable, /DROP TABLE IF EXISTS/i);
  assert.match(migration, /NO CASCADE, ON PURPOSE/);
});

test("no Brand.shopify* column and no KEEP-list table appears in any drop statement", () => {
  const dropStatements = executable
    .split("\n")
    .filter((line) => /\bDROP\b/i.test(line));

  assert.equal(dropStatements.length, 6);

  for (const column of BRAND_SHOPIFY_COLUMNS) {
    for (const statement of dropStatements) {
      assert.ok(
        !statement.includes(column),
        `drop statement must not mention Brand.${column}: ${statement}`,
      );
    }
  }

  // No KEEP-list table may be the target of a DROP TABLE, and none of the
  // ALTER TABLE ... DROP COLUMN statements may name a column that is not on the
  // approved list of six.
  const APPROVED_DROP_TARGETS = new Set([
    'ALTER TABLE "CommerceClickAttribution" DROP COLUMN "lessonProductLinkId";',
    'ALTER TABLE "CommerceClickAttribution" DROP COLUMN "experienceProductLinkId";',
    'ALTER TABLE "CampaignLessonProduct" DROP COLUMN "legacyLessonProductLinkId";',
    'DROP TABLE "LessonProductLink";',
    'DROP TABLE "ExperienceProductLink";',
    'ALTER TABLE "Campaign" DROP COLUMN "commerceProductCurationEnabled";',
  ]);
  for (const statement of dropStatements) {
    assert.ok(
      APPROVED_DROP_TARGETS.has(statement.trim()),
      `unapproved drop statement: ${statement}`,
    );
  }

  for (const model of KEEP_MODELS) {
    assert.ok(
      !executable.includes(`DROP TABLE "${model}"`),
      `KEEP-list model ${model} must never be dropped`,
    );
  }
});

test("the migration header documents irreversibility, the no-rows-deleted guarantee, and the MANDATORY resync", () => {
  assert.match(migration, /DESTRUCTIVE, IRREVERSIBLE MIGRATION/);
  assert.match(migration, /NO ROWS ARE DELETED FROM ANY SURVIVING TABLE/);
  assert.match(migration, /MANDATORY POST-DEPLOY STEP: FULL PRODUCT RESYNC/);
  assert.match(migration, /hasPublicStorefrontUrl/);
  assert.match(migration, /20260808120000_add_connected_product_storefront_availability/);
  // Re-adding the curation flag re-defaults every campaign; that must be stated.
  assert.match(migration, /re-defaults EVERY campaign to false/);
  // The accepted attribution evidence degradation must be an explicit,
  // quantifiable decision, not a surprise.
  assert.match(migration, /attribution_rows_losing_all_product_identity/);
  assert.match(migration, /INFORMATIONAL PRE-DEPLOY QUERIES/);

  // Every table Phase 8 must not lose rows from is named in the guarantee.
  for (const model of KEEP_MODELS) {
    assert.ok(migration.includes(model), `header must name ${model}`);
  }
});

test("the migration contains no credential, token, or database URL", () => {
  assert.doesNotMatch(migration, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(migration, /\bshpat_/i);
  assert.doesNotMatch(migration, /\bshpca_/i);
  assert.doesNotMatch(migration, /myshopify\.com/i);
  assert.doesNotMatch(migration, /SUPABASE/i);
  assert.doesNotMatch(migration, /DATABASE_URL/);
});

// ---------------------------------------------------------------------------
// 2. SCHEMA SHAPE
// ---------------------------------------------------------------------------

test("prisma/schema.prisma no longer declares the legacy models, bridge, or curation flag", () => {
  assert.doesNotMatch(declarations, /model ExperienceProductLink\b/);
  assert.doesNotMatch(declarations, /model LessonProductLink\b/);
  assert.doesNotMatch(declarations, /legacyLessonProductLinkId/);
  assert.doesNotMatch(declarations, /lessonProductLinkId/);
  assert.doesNotMatch(declarations, /experienceProductLinkId/);
  assert.doesNotMatch(declarations, /commerceProductCurationEnabled/);

  // The back-relations that pointed at the two removed models are gone too, so
  // no dangling relation can silently resurrect them.
  assert.doesNotMatch(declarations, /ExperienceProductLink\[\]/);
  assert.doesNotMatch(declarations, /LessonProductLink\[\]/);
  assert.doesNotMatch(declarations, /LessonProductLink\?/);
  assert.doesNotMatch(declarations, /ExperienceProductLink\?/);

  // No `model` block of either name can exist under ANY formatting, and no
  // field of either type can exist at all.
  assert.doesNotMatch(declarations, /\bmodel\s+(?:Experience|Lesson)ProductLink\b/);
  assert.doesNotMatch(declarations, /^\s+\w+\s+(?:Experience|Lesson)ProductLink/m);
});

// PHASE 14C-B2: the inverse of the original Phase 8 protection. These columns
// were deliberately preserved through Phase 8 and every phase up to 14C-B1.1;
// 14C-B2 physically drops them. This test is the standing guard that they never
// come back — a reintroduced `Brand.shopify*` scalar would resurrect exactly the
// duplicate-authority/stale-mirror class of bug the canonical migration removed.
test("all 16 legacy Brand.shopify* compatibility columns are ABSENT from Brand (Phase 14C-B2)", () => {
  const brandModel = schema.match(/model Brand \{[\s\S]*?\n\}/);
  assert.ok(brandModel, "found model Brand");
  const body = brandModel[0];

  for (const column of BRAND_SHOPIFY_COLUMNS) {
    assert.doesNotMatch(
      body,
      new RegExp(`^\\s+${column}\\s+`, "m"),
      `Brand.${column} must NOT be declared — it was dropped in Phase 14C-B2`,
    );
  }

  // Count check, so a reintroduced column is caught even if this file's name
  // list were edited. Brand still declares exactly two shopify* fields, and
  // BOTH are relation lists (back-relations to provider-specific history), not
  // scalar compatibility columns.
  const RELATION_FIELDS = new Set(["shopifyRewardRedemptions", "shopifyConnectionEvents"]);
  const declaredShopifyFields = [...body.matchAll(/^\s+(shopify[A-Za-z]+)\s+/gm)].map(
    (match) => match[1],
  );
  const scalars = declaredShopifyFields.filter((name) => !RELATION_FIELDS.has(name));

  assert.deepEqual(
    scalars,
    [],
    "Brand must declare NO shopify* scalar columns at all",
  );
  assert.deepEqual(
    [...declaredShopifyFields].sort(),
    ["shopifyConnectionEvents", "shopifyRewardRedemptions"],
    "the only shopify* fields left on Brand are the two provider-specific history relations",
  );
});

test("the legacy ShopifyConnectionStatus / ShopifyAuthMode enums are gone, and provider-neutral commerce enums survive (Phase 14C-B2)", () => {
  assert.doesNotMatch(
    schema,
    /^enum\s+ShopifyConnectionStatus\b/m,
    "enum ShopifyConnectionStatus must be dropped",
  );
  assert.doesNotMatch(
    schema,
    /^enum\s+ShopifyAuthMode\b/m,
    "enum ShopifyAuthMode must be dropped",
  );

  // No model may reference them any more either.
  assert.doesNotMatch(schema, /\bShopifyConnectionStatus\b/);
  assert.doesNotMatch(schema, /\bShopifyAuthMode\b/);

  // The provider-neutral commerce enums must be untouched by this phase.
  assert.match(schema, /^enum\s+CommerceConnectionStatus\b/m);
  assert.match(schema, /^enum\s+CommerceProvider\b/m);
});

test("canonical commerce authority and provider-specific history models survive Phase 14C-B2", () => {
  for (const model of [
    // Canonical authority — the whole point of the migration.
    "CommerceConnection",
    "CommerceConnectionSecret",
    // Provider-specific history, deliberately retained (not duplicate Brand authority).
    "ShopifyConnectionEvent",
    "ShopifyRewardRedemption",
  ]) {
    assert.match(
      schema,
      new RegExp(`^model\\s+${model}\\s*\\{`, "m"),
      `model ${model} must survive Phase 14C-B2`,
    );
  }

  // Provider-specific columns on non-Brand models are legitimate domain data
  // and must NOT have been swept up by the Brand contraction.
  assert.match(schema, /^\s+shopifyProductGid\s+/m);
  assert.match(schema, /^\s+shopifyRewardRedemptionId\s+/m);
});

test("every KEEP-list model still exists in the schema", () => {
  for (const model of KEEP_MODELS) {
    assert.match(
      schema,
      new RegExp(`^model ${model} \\{`, "m"),
      `model ${model} must survive Phase 8`,
    );
  }
});

test("CampaignLessonProduct keeps its canonical shape and reversible lifecycle key", () => {
  const model = schema.match(/model CampaignLessonProduct \{[\s\S]*?\n\}/);
  assert.ok(model, "found model CampaignLessonProduct");
  const body = model[0];

  assert.match(body, /brandId\s+String/);
  assert.match(body, /campaignId\s+String/);
  assert.match(body, /lessonId\s+String/);
  assert.match(body, /brandCommerceProductId\s+String/);
  assert.match(body, /isActive\s+Boolean\s+@default\(true\)/);
  assert.match(body, /deactivatedAt\s+DateTime\?/);
  assert.match(body, /@@unique\(\[campaignId, lessonId, brandCommerceProductId\]\)/);

  // Both same-brand composite FKs survive, so Postgres itself still rejects a
  // cross-brand attachment.
  assert.match(
    body,
    /campaign\s+Campaign\s+@relation\(fields: \[campaignId, brandId\], references: \[id, brandId\]/,
  );
  assert.match(
    body,
    /brandCommerceProduct\s+BrandCommerceProduct\s+@relation\(fields: \[brandCommerceProductId, brandId\], references: \[id, brandId\]/,
  );
});

test("the CampaignLessonProduct docblock describes the canonical model, not the removed bridge", () => {
  const docblock = schema.match(
    /((?:^\/\/\/.*\n)+)model CampaignLessonProduct \{/m,
  );
  assert.ok(docblock, "CampaignLessonProduct still has a docblock");
  const prose = docblock[1];

  assert.match(prose, /canonical Lesson product attachment/i);
  assert.match(prose, /BrandCommerceProduct -> ConnectedCommerceProduct/);
  assert.match(prose, /reversible[\s/]+lifecycle key/i);
  assert.doesNotMatch(prose, /legacyLessonProductLinkId/);
  assert.doesNotMatch(prose, /bridges to/);
});

test("ConnectedCommerceProduct.hasPublicStorefrontUrl survives and stays fail-closed", () => {
  assert.match(schema, /hasPublicStorefrontUrl\s+Boolean\s+@default\(false\)/);
});

// ---------------------------------------------------------------------------
// 3. SOURCE-LEVEL: no runtime code may reference the removed Prisma delegates
// ---------------------------------------------------------------------------

test("shop/redact no longer touches the removed legacy Prisma delegates, and keeps its other scrubs", () => {
  const route = readFileSync(
    join(root, "src/app/api/shopify/webhooks/shop/redact/route.ts"),
    "utf8",
  );

  assert.doesNotMatch(route, /prisma\.experienceProductLink/);
  assert.doesNotMatch(route, /prisma\.lessonProductLink/);

  // PHASE 14C-B2: the Brand compatibility-mirror lookup and clear are gone
  // along with the columns themselves. shop/redact must now perform NO Brand
  // write and NO Brand read of any kind — there is nothing left on Brand to
  // redact, and reintroducing one would recreate the stale-mirror bug class.
  assert.doesNotMatch(route, /prisma\.brand\.update/);
  assert.doesNotMatch(route, /prisma\.brand\.findMany/);
  assert.doesNotMatch(route, /prisma\.brand\.findFirst/);
  assert.doesNotMatch(route, /shopifyAdminAccessTokenEncrypted: null/);
  assert.doesNotMatch(route, /shopifyRefreshTokenEncrypted: null/);
  assert.doesNotMatch(route, /shopifyShopDomain: null/);
  assert.doesNotMatch(route, /shopifyConnectionStatus: "UNINSTALLED"/);

  // Every other documented redaction step is untouched.
  assert.match(route, /verifyShopifyWebhookRequest/);
  assert.match(route, /prisma\.shopifyRewardRedemption\.updateMany/);
  assert.match(route, /prisma\.brandRewardOffer\.updateMany/);
  assert.match(route, /prisma\.shopifyConnectionEvent\.updateMany/);
  assert.match(route, /prisma\.tokenStore\.deleteMany/);
  assert.match(route, /prisma\.\$transaction\(operations\)/);
  assert.match(route, /deleteShopifyCommerceConnectionByShopDomain\(shopDomain\)/);
  assert.doesNotMatch(route, /safeDeleteShopifyCommerceConnectionByShopDomain/);
  assert.match(route, /new NextResponse\(null, \{ status: 200 \}\)/);
});

// ---------------------------------------------------------------------------
// 4. REPO-WIDE: no runtime source file anywhere under src/ references the
// removed Prisma delegates (items 15 & 16). The prior test above checks only
// shop/redact/route.ts; this walks the entire src/ tree so a stray reference
// added to any other file — not just the ones this phase happened to touch —
// still fails loudly.
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test("no file under src/ calls the removed prisma.experienceProductLink or prisma.lessonProductLink delegates (repo-wide, items 15 & 16)", () => {
  const files = listSourceFiles(join(root, "src"));
  assert.ok(files.length > 100, "sanity: the walk found a plausible number of source files");

  const offenders: string[] = [];
  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    if (
      /prisma\.experienceProductLink\b/.test(contents) ||
      /prisma\.lessonProductLink\b/.test(contents) ||
      /\btx\.experienceProductLink\b/.test(contents) ||
      /\btx\.lessonProductLink\b/.test(contents)
    ) {
      offenders.push(file.slice(root.length + 1));
    }
  }
  assert.deepEqual(offenders, [], "no file may call the removed Prisma delegates");
});

test("no leftover [productLinkId] route segment exists anywhere under src/app (items 15 & 16)", () => {
  // All three surfaces that used to address a legacy snapshot id by this
  // segment name are gone: the public shop click hop, the public lesson click
  // hop, and the creator lesson-product mutation route. Each now addresses a
  // canonical id instead (`[brandCommerceProductId]` / `[campaignAssignmentId]`
  // / `[campaignLessonProductId]`).
  const removedRouteDirs = [
    "src/app/api/public/experience/[experienceSlug]/products/click/[productLinkId]/route.ts",
    "src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/products/click/[productLinkId]/route.ts",
    "src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route.ts",
  ];
  for (const relativePath of removedRouteDirs) {
    assert.equal(
      existsSync(join(root, relativePath)),
      false,
      `${relativePath} must not exist`,
    );
  }

  const files = listSourceFiles(join(root, "src/app"));
  const offenders = files.filter((file) => file.includes("[productLinkId]"));
  assert.deepEqual(offenders, [], "no [productLinkId] route segment may exist anywhere under src/app");
});

test("src/lib/product-link-compatibility.ts (the deleted free-form compatibility helper) no longer exists", () => {
  assert.equal(
    existsSync(join(root, "src/lib/product-link-compatibility.ts")),
    false,
  );
});
