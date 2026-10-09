import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import * as domain from "../src/lib/commerce7-reward-domain";
import * as eligibility from "../src/lib/commerce7-reward-eligibility";
import { fetchCommerce7ProductPage, normalizeCommerce7Product, readCommerce7ProductSecurity } from "../src/lib/commerce/providers/commerce7-products";
import { computeProductFields, decideProductWrite } from "../src/lib/commerce/product-sync";
import { fakeTenant, harness, offerBody, type Row } from "./commerce7-reward-harness";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/operator-sandbox-evidence.json", import.meta.url), "utf8"));
const TAG = "3605745f-4966-4465-af7d-20b81eefba4c"; // the live sandbox Customer Tag UUID supplied by the operator
const secured = (availableTo: string, ids: unknown, extra: Row = {}) => ({ security: { availableTo, displayOption: "Display Product / Show Login", availableToObjectIds: ids, ...extra } });

// ── Read-only product sync ────────────────────────────────────────────────────

test("the live Tag security shape is read verbatim (never rewritten to Group) and nothing else from security is kept", () => {
  assert.deepEqual(readCommerce7ProductSecurity(evidence.productSecurity), { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: evidence.productSecurity.security.availableToObjectIds });
  assert.deepEqual(readCommerce7ProductSecurity({ security: { availableTo: "Tag", availableToObjectIds: [TAG], customer: { email: "x@example.test" }, secret: "s" } }), { availableTo: "Tag", displayOption: null, availableToObjectIds: [TAG] });
  assert.deepEqual(readCommerce7ProductSecurity({ security: { availableTo: "Public", availableToObjectIds: "" } }), { availableTo: "Public", displayOption: null, availableToObjectIds: [] });
  for (const malformed of [{}, { security: null }, { security: { availableToObjectIds: [TAG] } }, { security: { availableTo: 7 } }, { security: { availableTo: "Tag", availableToObjectIds: [{ id: TAG }] } }, { security: { availableTo: "Tag", availableToObjectIds: "a,b" } }]) assert.equal(readCommerce7ProductSecurity(malformed), null, JSON.stringify(malformed));
  assert.deepEqual(normalizeCommerce7Product(evidence.productSecurity)?.accessSecurity, readCommerce7ProductSecurity(evidence.productSecurity));
  assert.equal(normalizeCommerce7Product(evidence.productSecurity)?.hasProviderStorefrontPublication, false, "public storefront eligibility is unchanged: a Tag product is not public");
  assert.equal(normalizeCommerce7Product(evidence.productSecurity)?.status, "ACTIVE", "and it stays available in the synchronized catalog");
});

test("product sync stays read-only: one GET per page, and the security block arrives on the normalized product", async () => {
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const page = await fetchCommerce7ProductPage({ tenant: "synthetic-tenant" }, { fetchImpl: (async (url: string, init?: { method?: string; body?: unknown }) => { calls.push({ url, method: init?.method, body: init?.body }); return { ok: true, status: 200, json: async () => ({ products: [evidence.productSecurity], cursor: null }) }; }) as never });
  assert.deepEqual(calls.map((call) => call.method), ["GET"]); assert.equal(calls[0].body, undefined); assert.match(calls[0].url, /\/product\?cursor=start$/);
  assert.equal(page.products[0].accessSecurity?.availableTo, "Tag");
});

const syncFields = (raw: unknown) => computeProductFields(normalizeCommerce7Product(raw)!, "CAD");
test("sync persists a strict security whitelist in providerMetadata, and a security-only change is an UPDATE, not a silent TOUCH", () => {
  const now = new Date("2026-10-10T00:00:00.000Z");
  const created = decideProductWrite(null, syncFields(evidence.productSecurity), now, "run-1");
  assert.equal(created.kind, "CREATE");
  const metadata = (created as { data: { providerMetadata: Row } }).data.providerMetadata;
  assert.deepEqual(metadata.security, { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: evidence.productSecurity.security.availableToObjectIds });
  assert.deepEqual(Object.keys(metadata).sort(), ["priceText", "providerCreatedAt", "providerUpdatedAt", "security", "status", "storefrontUrlSource"].filter((key) => key in metadata).sort());
  const existing = { id: "row", ...(created as { data: Row }).data, unavailableSince: null } as never;
  assert.equal(decideProductWrite(existing, syncFields(evidence.productSecurity), now, "run-2").kind, "TOUCH", "an identical re-sync writes nothing");
  for (const change of [{ ...evidence.productSecurity, security: { availableTo: "Public" } }, { ...evidence.productSecurity, security: { ...evidence.productSecurity.security, availableToObjectIds: ["another-tag"] } }, { ...evidence.productSecurity, security: undefined }]) {
    assert.equal(decideProductWrite(existing, syncFields(change), now, "run-3").kind, "UPDATE", JSON.stringify(change.security));
  }
});

// ── Exclusive eligibility (server-side, never raw metadata to the browser) ─────

test("a product secured to one or several distinct, non-blank Customer Tags is exclusive-eligible; anything else is not", () => {
  const ids = (metadata: unknown) => JSON.parse(JSON.stringify(domain.commerce7ExclusiveSecurity(metadata)));
  assert.deepEqual(ids(secured("Tag", [TAG])), { tagIds: [TAG] });
  assert.deepEqual(ids(secured("Tag", [TAG, "second-tag"])), { tagIds: [TAG, "second-tag"] }, "several tags qualify; one is chosen explicitly");
  assert.deepEqual(ids(secured("Tag", [TAG, "second-tag", "third-tag"])), { tagIds: [TAG, "second-tag", "third-tag"] });
  for (const [name, metadata] of [
    ["public product", secured("Public", [])], ["allocation", secured("Allocation", ["allocation-id"])], ["club", secured("Club", ["club-id"])],
    ["documented Group wording is not the live value", secured("Group", [TAG])], ["lower-case tag", secured("tag", [TAG])], ["no security IDs", secured("Tag", [])],
    ["blank security ID", secured("Tag", ["  "])], ["one blank among several", secured("Tag", [TAG, ""])], ["padded ID", secured("Tag", [` ${TAG}`])], ["duplicate IDs", secured("Tag", [TAG, TAG])],
    ["more than 50 IDs", secured("Tag", Array.from({ length: 51 }, (_, i) => `tag-${i}`))], ["no security block", { status: "ACTIVE" }], ["null metadata", null], ["IDs not an array", secured("Tag", TAG)],
  ] as const) assert.equal(domain.commerce7ExclusiveSecurity(metadata), null, name);
});

test("a saved exclusive draft fails closed when the product's security changes or it stops being synchronized", () => {
  const config = { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveAccess: { productId: "rare", securityAvailableTo: "Tag", securityTagId: TAG } };
  const product = { externalId: "rare", isAvailable: true, providerMetadata: secured("Tag", [TAG]) };
  assert.equal(domain.commerce7ExclusiveAccessStatus(config, product), "CONFIGURED");
  assert.equal(domain.commerce7ExclusiveAccessStatus(config, null), "PRODUCT_UNAVAILABLE");
  assert.equal(domain.commerce7ExclusiveAccessStatus(config, { ...product, isAvailable: false }), "PRODUCT_UNAVAILABLE");
  assert.equal(domain.commerce7ExclusiveAccessStatus(config, { ...product, providerMetadata: secured("Tag", [TAG, "second"]) }), "CONFIGURED", "another tag on the product grants access independently (verified OR semantics)");
  assert.equal(domain.commerce7ExclusiveAccessStatus(config, { ...product, providerMetadata: secured("Tag", [TAG, "second"]) }, false), "MULTI_TAG_UNVERIFIED", "the gate remains for an unverified contract");
  assert.equal(domain.commerce7ExclusiveAccessStatus(config, { ...product, providerMetadata: secured("Tag", ["another-tag"]) }), "TAG_REMOVED");
  for (const providerMetadata of [secured("Public", []), secured("Tag", []), null]) assert.equal(domain.commerce7ExclusiveAccessStatus(config, { ...product, providerMetadata }), "SECURITY_CHANGED");
  assert.equal(domain.commerce7ExclusiveAccessStatus(config, { ...product, externalId: "other" }), "PRODUCT_UNAVAILABLE");
  assert.equal(domain.commerce7ExclusiveAccessStatus({ eligibilityMode: "CLAIMANT_ONLY" }, product), "NOT_CONFIGURED");
});

// ── Saving an exclusive draft ─────────────────────────────────────────────────

const exclusiveBody = { ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, discountEnabled: false, maxTotalRedemptions: 25, productIds: ["wine-a"] };
function securedHarness(options: { multiTagAccessVerified?: boolean } = {}) { const app = harness({ tenant: fakeTenant({ tags: [{ id: TAG, title: "SQRATCH Rare Wine Test", type: "Manual", objectType: "Customer" }] }), ...options }); app.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-a")!.providerMetadata = secured("Tag", [TAG]); app.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-b")!.providerMetadata = secured("Public", []); return app; }

test("saving an exclusive draft freezes the product and its Customer Tag after one read-only Tag lookup: no write, points, claim, coupon or tag", async () => {
  const app = securedHarness(); const saved = await app.save(exclusiveBody);
  assert.equal(saved.isActive, false); assert.deepEqual(JSON.parse(JSON.stringify(domain.serializeCommerce7OfferResponse(saved).commerce7Config)), { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveTagTitle: "SQRATCH Rare Wine Test" }, "the route's write response carries the tag title, never its UUID");
  const stored = app.tables.brandRewardOffer.at(-1)!.commerce7Config as Row;
  assert.equal(JSON.stringify(stored.exclusiveAccess), JSON.stringify({ productId: "wine-a", securityAvailableTo: "Tag", securityTagId: TAG, tagTitle: "SQRATCH Rare Wine Test" }));
  assert.deepEqual(app.calls.map((call) => `${call.method} ${call.path}`), [`GET /v1/tag/customer/${TAG}`]); assert.equal(app.claims().length, 0); assert.equal(app.ledger.size, 0); assert.equal(app.tenant.coupons.length, 0); assert.equal(app.tenant.tags.length, 1);
});

test("an exclusive draft is refused for a public, ambiguous, unavailable or foreign product", async () => {
  const cases: [string, (app: ReturnType<typeof securedHarness>) => void, string[]][] = [
    ["public product", () => {}, ["wine-b"]],
    ["no security metadata", () => {}, ["wine-c"]],
    ["two security tags without an explicit choice", (app) => { app.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-a")!.providerMetadata = secured("Tag", [TAG, "second"]); }, ["wine-a"]],
    ["unavailable", (app) => { app.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-a")!.isAvailable = false; }, ["wine-a"]],
    ["another connection's product", (app) => { app.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-a")!.connectionId = "another-connection"; }, ["wine-a"]],
    ["another Brand's product", (app) => { app.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-a")!.brandId = "another-brand"; }, ["wine-a"]],
  ];
  for (const [name, arrange, productIds] of cases) {
    const app = securedHarness(); arrange(app); const before = app.tables.brandRewardOffer.length;
    await assert.rejects(app.save({ ...exclusiveBody, productIds }), { code: "INVALID_OFFER" }, name);
    assert.equal(app.tables.brandRewardOffer.length, before, name); assert.equal(app.calls.length, 0, name);
  }
});

test("with an UNVERIFIED multi-tag contract (injected), a multi-tag product cannot be activated or claimed", async () => {
  const app = securedHarness({ multiTagAccessVerified: false }); app.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-a")!.providerMetadata = secured("Tag", [TAG, "second"]);
  await app.save({ ...exclusiveBody, exclusiveTagId: TAG }); const config = app.tables.brandRewardOffer.at(-1)!.commerce7Config;
  await assert.rejects(app.save({ ...exclusiveBody, exclusiveTagId: TAG, isActive: true }), { code: "MULTI_TAG_UNVERIFIED" });
  Object.assign(app.offer(), { rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", appliesTo: "SPECIFIC_PRODUCTS", isActive: false, discountAmountCents: null, commerce7Config: config });
  app.tables.brandRewardOfferProduct.push({ id: "offer-product-wine-a", offerId: "offer", externalProductId: "wine-a", title: "wine-a" });
  await assert.rejects(app.setActive("ENABLE"), { code: "MULTI_TAG_UNVERIFIED" });
  Object.assign(app.offer(), { isActive: true }); app.tables.user[0] = { ...app.tables.user[0], email: "alice@example.test", isEmailVerified: true, emailVerifiedAt: new Date("2026-10-01T00:00:00.000Z") };
  await assert.rejects(app.reserve(), { code: "MULTI_TAG_UNVERIFIED" });
  assert.ok(app.calls.every((call) => call.method === "GET")); assert.equal(app.ledger.size, 0); assert.equal(app.claims().length, 0);
});

test("the discount product rule is unchanged: any available synchronized product, secured or not", async () => {
  const app = securedHarness();
  const saved = await app.save({ ...offerBody, isActive: false, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a", "wine-b", "wine-c"] });
  assert.equal(saved.appliesTo, "SPECIFIC_PRODUCTS"); assert.equal(((app.tables.brandRewardOffer.at(-1)!.commerce7Config) as Row).exclusiveAccess, undefined);
});

// ── Brand API: picker contents and no leaks ───────────────────────────────────

function brandRoute(products: Row[], offers: Row[] = []) {
  const exports: Record<string, () => Promise<Response>> = {};
  const pick = (row: Row, select?: Record<string, boolean>) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row;
  const db = {
    brandRewardOffer: { findMany: async () => offers },
    commerceRewardRedemption: { findMany: async () => [], groupBy: async () => [] },
    connectedCommerceProduct: { findMany: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => products.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)).map((row) => pick(row, select)) },
  };
  runInNewContext(ts.transpileModule(readFileSync("src/app/api/brand/rewards/commerce7/route.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, require(name: string) {
      const dependencies: Record<string, unknown> = {
        "next/server": { NextResponse }, "@/lib/prisma": { __esModule: true, default: db }, "@/lib/commerce7-reward-eligibility": eligibility, "@/lib/commerce7-reward-domain": domain,
        "@/lib/brand-auth": { getBrandManagementContext: async () => ({ membership: { brand: { id: "brand" } } }), getBrandContextFailure: () => ({ error: "no", status: 403 }) },
        "@/lib/commerce/connection-service": { getActiveCommerceConnection: async (_brand: string, provider: string) => provider === "COMMERCE7" ? { id: "connection", displayName: "Winery", currencyCode: "CAD", status: "CONNECTED" } : null, isConnectionUsable: () => true },
        "@/lib/commerce/providers/commerce7": { getCommerce7AppConfig: () => ({}) }, "@/lib/commerce/providers/commerce7-rewards-client": { claimTagTitle: () => "SQRATCH-x" },
        "@/lib/commerce7-reward-http": { rewardErrorResponse: (error: Error) => NextResponse.json({ error: error.message }, { status: 500 }) },
      };
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name];
    },
  });
  return exports.GET;
}
const row = (externalId: string, title: string, providerMetadata: unknown, extra: Row = {}) => ({ externalId, title, brandId: "brand", connectionId: "connection", provider: "COMMERCE7", isAvailable: true, providerMetadata, ...extra });
const catalog = [
  row("rare", "Rare - 2015 Chardonnay", secured("Tag", [TAG])), row("sample", "Sample Public Wine", secured("Public", [])), row("allocated", "Allocation Wine", secured("Allocation", ["allocation-id"])),
  row("club", "Club Wine", secured("Club", ["club-id"])), row("zero", "Tag Without IDs", secured("Tag", [])), row("multi", "Two Tags", secured("Tag", [TAG, "second"])), row("plain", "Unsynced Security", null),
  row("gone", "Retired Rare", secured("Tag", [TAG]), { isAvailable: false }), row("elsewhere", "Other Store Rare", secured("Tag", [TAG]), { connectionId: "other-connection" }), row("foreign", "Other Brand Rare", secured("Tag", [TAG]), { brandId: "other-brand" }),
];

test("the Exclusive picker lists this connection's available Tag-secured products, with one or several tags; the Discount list is unchanged", async () => {
  const body = await (await brandRoute(catalog)()).json();
  assert.deepEqual(body.exclusiveProducts, [{ externalId: "rare", title: "Rare - 2015 Chardonnay", tagCount: 1 }, { externalId: "multi", title: "Two Tags", tagCount: 2 }]);
  assert.deepEqual(body.products.map((product: Row) => product.externalId).sort(), ["allocated", "club", "multi", "plain", "rare", "sample", "zero"], "the discount picker still lists every available product of this connection");
  assert.ok(body.products.every((product: Row) => JSON.stringify(Object.keys(product).sort()) === JSON.stringify(["externalId", "title"])));
  assert.deepEqual(body.exclusiveDiagnostics, { securityUnknownCount: 1, lastProductSyncAt: null }, "only 'Unsynced Security' (no stored security) is unknown; counts only, no product data");
});

test("the Brand API never exposes raw security, provider metadata or Customer Tag UUIDs", async () => {
  const offer = { id: "draft", brandId: "brand", provider: "COMMERCE7", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, reservedClaimCount: 0, products: [{ externalProductId: "rare" }], _count: { redemptions: 0 }, commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveAccess: { productId: "rare", securityAvailableTo: "Tag", securityTagId: TAG } } };
  const text = JSON.stringify(await (await brandRoute(catalog, [offer])()).json());
  for (const forbidden of [TAG, "providerMetadata", "availableToObjectIds", "securityTagId", "securityAvailableTo", '"exclusiveAccess":', '"security"', "Display Product", "allocation-id", "club-id"]) assert.ok(!text.includes(forbidden), forbidden);
  const body = JSON.parse(text); assert.equal(body.offers[0].exclusiveAccessStatus, "CONFIGURED");
  const drifted = JSON.parse(JSON.stringify(await (await brandRoute([row("rare", "Rare - 2015 Chardonnay", secured("Public", [])), ...catalog.slice(1)], [offer])()).json()));
  assert.equal(drifted.offers[0].exclusiveAccessStatus, "SECURITY_CHANGED"); assert.deepEqual(drifted.exclusiveProducts.map((product: Row) => product.externalId), ["multi"]);
  assert.equal(body.offers[0].exclusiveSharedProductCount, 1, "the same tag also secures the two-tag product"); assert.equal(body.offers[0].exclusiveTagCount, 1);
  const removed = await (await brandRoute(catalog.slice(1), [offer])()).json(); assert.equal(removed.offers[0].exclusiveAccessStatus, "PRODUCT_UNAVAILABLE");
});

// ── Brand tag options, claim DTOs and the REVOKE guard ─────────────────────────

function loadRoute(path: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => Promise<Response>> = {};
  runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, URLSearchParams, require(name: string) { if (name === "next/server") return { NextResponse }; if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return exports;
}
const SECOND = "00000000-0000-4000-8000-0000000000b2"; const AUTO = "00000000-0000-4000-8000-0000000000b4";
function tagOptionsRoute(options: { products?: Row[]; tags?: Record<string, Row | null>; offers?: Row[]; brand?: boolean; backend?: boolean } = {}) {
  const reads: string[] = [];
  const products = options.products ?? [row("rare", "Rare - 2015 Chardonnay", secured("Tag", [TAG, SECOND, AUTO])), row("library", "Library Cabernet", secured("Tag", [TAG])), row("sample", "Sample Public Wine", secured("Public", []))];
  class FakeClient { constructor(readonly tenant: string) { reads.push(`tenant:${tenant}`); } async customerTag(id: string) { reads.push(`GET tag ${id}`); if (options.tags && id in options.tags) return options.tags[id]; return ({ [TAG]: { id: TAG, title: "SQRATCH Rare Wine Test", type: "Manual", objectType: "Customer" }, [SECOND]: { id: SECOND, title: "Library Members", type: "Manual", objectType: "Customer" }, [AUTO]: { id: AUTO, title: "Big Spenders", type: "Dynamic", objectType: "Customer" } } as Record<string, Row>)[id] ?? null; } }
  const handler = loadRoute("src/app/api/brand/rewards/commerce7/exclusive-tags/route.ts", {
    "@/lib/prisma": { __esModule: true, default: { connectedCommerceProduct: { findMany: async ({ where }: { where: Row }) => products.filter((p) => p.brandId === where.brandId && p.connectionId === where.connectionId && p.isAvailable) }, brandRewardOffer: { findFirst: async ({ where }: { where: Row }) => (options.offers ?? []).find((o) => o.id === where.id && o.brandId === where.brandId) ?? null } } },
    "@/lib/brand-auth": { getBrandManagementContext: async () => options.brand === false ? null : { membership: { brand: { id: "brand" } } }, getBrandContextFailure: () => ({ error: "Brand admin access required.", status: 403 }) },
    "@/lib/commerce/connection-service": { getActiveCommerceConnection: async () => ({ id: "connection", externalAccountId: "synthetic-tenant" }), isConnectionUsable: () => true },
    "@/lib/commerce/providers/commerce7": { getCommerce7AppConfig: () => options.backend === false ? null : {} },
    "@/lib/commerce/providers/commerce7-rewards-client": { Commerce7RewardsClient: FakeClient },
    "@/lib/commerce7-reward-domain": domain,
    "@/lib/commerce7-reward-http": { rewardErrorResponse: (error: { message: string; status?: number }) => NextResponse.json({ error: error.message }, { status: error.status ?? 409 }) },
  });
  return { reads, get: async (query: string) => { const response = await handler.GET({ nextUrl: new URL(`https://sqratch.example/api/brand/rewards/commerce7/exclusive-tags?${query}`) }); return { status: response.status, body: await response.json() }; } };
}

test("Brand tag options resolve each security tag live by UUID: readable titles, only Manual Customer tags selectable, shared products listed, no preselection for several tags", async () => {
  const app = tagOptionsRoute(); const { status, body } = await app.get("productId=rare");
  assert.equal(status, 200); assert.equal(body.tagCount, 3); assert.equal(body.multiTagAccessVerified, true); assert.equal(body.preselectedTagId, null, "several tags still need an explicit choice");
  assert.deepEqual(body.tags.map((tag: Row) => [tag.title, tag.selectable, tag.reason]), [["SQRATCH Rare Wine Test", true, null], ["Library Members", true, null], ["Big Spenders", false, "NOT_MANUAL"]]);
  assert.deepEqual(body.tags[0].sharedProductTitles, ["Library Cabernet"]); assert.equal(body.tags[0].sharedProductCount, 1); assert.equal(body.tags[1].sharedProductCount, 0);
  assert.deepEqual(app.reads, ["tenant:synthetic-tenant", `GET tag ${TAG}`, `GET tag ${SECOND}`, `GET tag ${AUTO}`], "read-only, the connection's own tenant");
  assert.ok(!JSON.stringify(body).includes("Display Product"), "no raw security block");
});

test("Brand tag options: a single-tag product preselects its tag; an edited offer shows its frozen tag; deleted and non-Customer tags are unselectable", async () => {
  const single = await tagOptionsRoute().get("productId=library"); assert.equal(single.body.preselectedTagId, TAG);
  const edited = await tagOptionsRoute({ offers: [{ id: "draft", brandId: "brand", commerce7Config: { exclusiveAccess: { productId: "rare", securityAvailableTo: "Tag", securityTagId: SECOND } } }] }).get("productId=rare&offerId=draft");
  assert.equal(edited.body.preselectedTagId, SECOND); assert.deepEqual(edited.body.tags.map((tag: Row) => tag.current), [false, true, false]);
  const foreignOffer = await tagOptionsRoute({ offers: [{ id: "draft", brandId: "other-brand", commerce7Config: { exclusiveAccess: { productId: "rare", securityAvailableTo: "Tag", securityTagId: SECOND } } }] }).get("productId=rare&offerId=draft");
  assert.equal(foreignOffer.body.preselectedTagId, null, "another Brand's offer is never read");
  const broken = await tagOptionsRoute({ tags: { [TAG]: null, [SECOND]: { id: SECOND, title: "Order Tag", type: "Manual", objectType: "Order" } } }).get("productId=rare");
  assert.deepEqual(broken.body.tags.map((tag: Row) => [tag.title, tag.selectable, tag.reason]), [[null, false, "NOT_FOUND"], ["Order Tag", false, "NOT_CUSTOMER"], ["Big Spenders", false, "NOT_MANUAL"]]);
});

test("Brand tag options refuse unauthenticated, ineligible, foreign or over-tagged products before any provider read", async () => {
  const many = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
  for (const [name, app, query, status] of [
    ["no Brand", tagOptionsRoute({ brand: false }), "productId=rare", 403], ["public product", tagOptionsRoute(), "productId=sample", 400], ["unknown product", tagOptionsRoute(), "productId=missing", 400],
    ["another connection's product", tagOptionsRoute({ products: [row("rare", "Rare", secured("Tag", [TAG]), { connectionId: "other" })] }), "productId=rare", 400],
    ["another Brand's product", tagOptionsRoute({ products: [row("rare", "Rare", secured("Tag", [TAG]), { brandId: "other-brand" })] }), "productId=rare", 400],
    ["more than ten tags", tagOptionsRoute({ products: [row("rare", "Rare", secured("Tag", many))] }), "productId=rare", 400], ["missing product id", tagOptionsRoute(), "", 400],
    ["backend not configured", tagOptionsRoute({ backend: false }), "productId=rare", 409],
  ] as const) {
    const result = await app.get(query); assert.equal(result.status, status, name); assert.ok(!app.reads.some((read) => read.startsWith("GET")), name);
  }
});

test("the Brand claim route refuses to revoke exclusive access: SQRATCH never deletes a Customer Tag membership", async () => {
  const calls: string[] = [];
  const handler = loadRoute("src/app/api/brand/rewards/commerce7/claims/[claimId]/route.ts", {
    "@/lib/prisma": { __esModule: true, default: { commerceRewardRedemption: { findFirst: async () => ({ id: "claim", brandId: "brand", provider: "COMMERCE7", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", status: "ISSUED", externalDiscountId: "coupon-1", provisioningOwner: null }), updateMany: async () => { calls.push("update"); return { count: 1 }; } }, commerceConnection: { findFirst: async () => { calls.push("connection"); return {}; } } } },
    "@/lib/brand-auth": { getBrandManagementContext: async () => ({ membership: { brand: { id: "brand" } } }), getBrandContextFailure: () => ({ error: "no", status: 403 }) },
    "@/lib/commerce7-rewards": { provisionCommerce7Claim: async () => { calls.push("provision"); } },
    "@/lib/commerce/providers/commerce7-rewards-client": { Commerce7RewardsClient: class { constructor() { calls.push("client"); } }, object: (value: unknown) => value && typeof value === "object" ? value : null },
    "@/lib/commerce7-reward-domain": domain,
    "@/lib/commerce7-reward-http": { rewardErrorResponse: (error: { message: string; status?: number }) => NextResponse.json({ error: error.message }, { status: error.status ?? 409 }) },
  });
  const response = await handler.POST({ json: async () => ({ action: "REVOKE" }) }, { params: Promise.resolve({ claimId: "claim" }) });
  assert.equal(response.status, 409); assert.match((await response.json()).error, /does not revoke Commerce7 Customer Tag access/); assert.deepEqual(calls, []);
});

test("Brand claims hide the merchant's tag UUID for exclusive claims and report access state and ownership guidance", async () => {
  const claim = { id: "c1", brandId: "brand", provider: "COMMERCE7", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", status: "ISSUED", provisioningState: "READY", providerCustomerId: "customer-1", providerTagId: TAG, connectionId: "connection", membershipOwnership: "SQRATCH_GRANTED", membershipWriteAttempted: true, providerMembershipId: "membership-1", membershipVerifiedAt: new Date(), needsManualReview: false, provisioningOwner: null, externalDiscountId: "coupon-1", lastReconcileReason: null, errorMessage: null, canonicalOrderId: null, createdAt: new Date(), rewardConfigSnapshot: { eligibilityMode: "CLAIMANT_ONLY" }, offer: { title: "Rare access" } };
  const exports: Record<string, () => Promise<Response>> = {};
  const db = { brandRewardOffer: { findMany: async () => [] }, connectedCommerceProduct: { findMany: async () => [] }, commerceRewardRedemption: { findMany: async () => [claim], groupBy: async ({ by }: { by: string[] }) => by.includes("providerTagId") ? [{ connectionId: "connection", providerCustomerId: "customer-1", providerTagId: TAG, _count: { _all: 2 } }] : [] } };
  runInNewContext(ts.transpileModule(readFileSync("src/app/api/brand/rewards/commerce7/route.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require(name: string) {
    const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, "@/lib/prisma": { __esModule: true, default: db }, "@/lib/commerce7-reward-eligibility": eligibility, "@/lib/commerce7-reward-domain": domain,
      "@/lib/brand-auth": { getBrandManagementContext: async () => ({ membership: { brand: { id: "brand" } } }), getBrandContextFailure: () => ({ error: "no", status: 403 }) },
      "@/lib/commerce/connection-service": { getActiveCommerceConnection: async () => null, isConnectionUsable: () => true }, "@/lib/commerce/providers/commerce7": { getCommerce7AppConfig: () => ({}) },
      "@/lib/commerce/providers/commerce7-rewards-client": { claimTagTitle: () => "SQRATCH-per-claim" }, "@/lib/commerce7-reward-http": { rewardErrorResponse: (error: Error) => NextResponse.json({ error: error.message }, { status: 500 }) } };
    return dependencies[name];
  } });
  const body = await (await exports.GET()).json(); const dto = body.claims[0];
  assert.equal(dto.providerTagId, null); assert.equal(dto.tagTitle, null, "no per-claim CRM tag for exclusive claims"); assert.equal(dto.canRevoke, false);
  assert.equal(dto.accessState, "ACCESS_GRANTED"); assert.equal(dto.membershipOwnership, "SQRATCH_GRANTED"); assert.equal(dto.membershipGuidance, "SHARED_WITH_OTHER_REWARDS", "another live claim relies on the same customer tag");
  assert.ok(!JSON.stringify(body).includes(TAG));
});

test("claimant claim DTOs never carry the customer, tag, membership or internal access-only code", () => {
  const view = domain.serializeCommerce7Claim({ id: "c", offerId: "o", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", status: "ISSUED", provisioningState: "READY", pointsCost: 100, code: "SQRA0123456789ABCDEF0123456789ABCDEF", issuedAt: new Date(), expiresAt: new Date("2026-01-01"), usedAt: null, couponCreateAttempted: false, entitlementEverGranted: true, membershipWriteAttempted: true, membershipOwnership: "SQRATCH_GRANTED", providerMembershipId: "membership-1", membershipVerifiedAt: new Date(), providerCustomerId: "customer-1", providerTagId: TAG, externalDiscountId: null, provisioningOwner: null, needsManualReview: false, lastReconcileReason: null, errorMessage: null, createdAt: new Date(), rewardConfigSnapshot: { eligibilityMode: "CLAIMANT_ONLY" } } as never);
  const text = JSON.stringify(view);
  for (const secret of [TAG, "customer-1", "membership-1", "SQRA0123456789ABCDEF0123456789ABCDEF"]) assert.ok(!text.includes(secret), secret);
  assert.equal(view.status, "ISSUED", "access does not expire with the coupon window"); assert.equal(view.accessState, "ACCESS_GRANTED");
});
