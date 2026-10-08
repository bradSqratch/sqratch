/**
 * Exclusive Wine Access product discovery when the Commerce7 catalog LIST omits Product Security.
 *
 * Production evidence (read-only SELECT, 2026-10-08): every synchronized product, including public ones, had no stored
 * `security`, and "Rare - 2015 Chardonnay" (Tag-secured per the operator's detail GET) was missing from the Exclusive picker.
 * These tests drive the REAL provider-neutral sync and the REAL Commerce7 adapter against synthetic list/detail responses:
 * a list WITHOUT `security` and a detail `GET /v1/product/{id}` WITH it. Only persistence and HTTP are faked.
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { CommerceProvider } from "@prisma/client";
import { syncBrandCommerceProducts, type ExistingConnectedProductRow, type ProductSyncDeps, type ProductWriteDecision } from "../src/lib/commerce/product-sync";
import { Commerce7CommerceAdapter, type Commerce7CommerceConnectionRow } from "../src/lib/commerce/providers/commerce7-commerce-adapter";
import { fetchCommerce7ProductAccessSecurity, normalizeCommerce7Product, type Commerce7Fetch } from "../src/lib/commerce/providers/commerce7-products";
import { commerce7ExclusiveSecurity } from "../src/lib/commerce7-reward-domain";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/operator-sandbox-evidence.json", import.meta.url), "utf8"));
const TENANT = "sqratch-inc"; const CONNECTION = "conn-c7"; const BRAND = "brand-c7";
const RARE_TAG = evidence.customerTag.id; const OTHER_TAG = "00000000-0000-4000-8000-0000000000b2";
type Row = Record<string, unknown> & { id: string; connectionId: string; externalKey: string; isAvailable: boolean };

/** List entries as the catalog list returns them in this scenario: no `security` block at all. */
function listed(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: `Wine ${id}`, slug: `wine-${id}`, webStatus: "Available", adminStatus: "Available", updatedAt: "2026-10-07T12:00:00.000Z", variants: [{ id: `${id}-v`, sku: id, price: 4200 }], ...overrides };
}
/** Detail security per product (the authoritative per-product read). */
const detailSecurity: Record<string, unknown> = {
  rare: evidence.productSecurity.security,
  multi: { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: [RARE_TAG, OTHER_TAG] },
  public: { availableTo: "Public", availableToObjectIds: "" },
  "no-tag": { availableTo: "Tag", availableToObjectIds: [] },
};

function tenant(listProducts: Array<Record<string, unknown>>, options: { failDetail?: Set<string>; detail?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const fetchImpl: Commerce7Fetch = async (url, init) => {
    const target = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${target.pathname}`);
    assert.equal(init?.method ?? "GET", "GET", "product sync is read-only");
    assert.equal((init?.headers as Record<string, string>).tenant, TENANT, "always the connection's own tenant");
    if (target.pathname === "/v1/product") return { ok: true, status: 200, json: async () => ({ products: listProducts, total: listProducts.length }) };
    const id = decodeURIComponent(target.pathname.replace("/v1/product/", ""));
    if (options.failDetail?.has(id)) return { ok: false, status: 503, json: async () => ({}) };
    const product = listProducts.find((entry) => entry.id === id);
    if (!product) return { ok: false, status: 404, json: async () => ({}) };
    const security = (options.detail ?? detailSecurity)[id];
    return { ok: true, status: 200, json: async () => ({ ...product, ...(security === undefined ? {} : { security }) }) };
  };
  return { calls, fetchImpl, details: () => calls.filter((call) => /^GET \/v1\/product\/.+/.test(call)) };
}

function connectionRow(): Commerce7CommerceConnectionRow {
  return { id: CONNECTION, brandId: BRAND, provider: CommerceProvider.COMMERCE7, status: "CONNECTED", displayName: TENANT, externalAccountId: TENANT, storefrontUrl: null, isPrimary: true, grantedScopes: null, installedAt: new Date("2026-01-01"), uninstalledAt: null, lastProductSyncAt: null, providerMetadata: null };
}
function harness(fetchImpl: Commerce7Fetch, rows = new Map<string, Row>()) {
  let next = 1;
  const adapter = new Commerce7CommerceAdapter({ loadConnection: async (id) => (id === CONNECTION ? connectionRow() : null), markProductSync: async () => {}, fetchImpl });
  const deps: ProductSyncDeps = {
    async getActiveConnection() { return { id: CONNECTION, brandId: BRAND, provider: CommerceProvider.COMMERCE7, status: "CONNECTED", displayName: TENANT, externalAccountId: TENANT, storefrontUrl: null, isPrimary: true, grantedScopes: [], installedAt: new Date("2026-01-01"), uninstalledAt: null, lastProductSyncAt: null, currencyCode: "CAD" }; },
    getAdapter() { return adapter; },
    async findExistingProducts(connectionId): Promise<ExistingConnectedProductRow[]> { return [...rows.values()].filter((row) => row.connectionId === connectionId) as unknown as ExistingConnectedProductRow[]; },
    async claimProductSyncRun() { return { status: "CLAIMED" as const, run: { id: `run-${next++}` } }; },
    async finalizeSyncRun() {},
    async applyProductWrite(connectionId, brandId, provider, externalKey, decision: ProductWriteDecision) {
      if (decision.kind === "CREATE") { const id = `row-${next++}`; rows.set(id, { id, connectionId, brandId, provider, externalKey, ...decision.data } as Row); }
      else if (decision.kind === "UPDATE") rows.set(decision.existingId, { ...rows.get(decision.existingId)!, ...decision.data } as Row);
      else rows.set(decision.existingId, { ...rows.get(decision.existingId)!, lastSeenAt: decision.lastSeenAt, lastSyncRunId: decision.lastSyncRunId } as Row);
      return { trustworthy: true };
    },
    async markUnavailableExcept() { return { count: 0 }; },
    async getConnectionFingerprint() { return "unchanged"; },
    async getConnectionConfigSnapshot() { return { fingerprint: "unchanged", currencyCode: "CAD" }; },
    async invalidateStaleConfigDerivedFields() {},
  };
  const byExternalId = (id: string) => [...rows.values()].find((row) => row.externalKey === id)!;
  const security = (id: string) => (byExternalId(id).providerMetadata as Record<string, unknown> | null)?.security;
  return { rows, deps, byExternalId, security, sync: (options: Record<string, unknown> = {}) => syncBrandCommerceProducts(BRAND, CommerceProvider.COMMERCE7, { ...options }, deps) };
}

test("a list entry without Product Security is UNKNOWN security, never 'unsecured'", () => {
  assert.equal(normalizeCommerce7Product(listed("rare"))?.accessSecurity, undefined);
  assert.equal(normalizeCommerce7Product(listed("rare", { security: null }))?.accessSecurity, undefined);
  assert.deepEqual(normalizeCommerce7Product(listed("rare", { security: evidence.productSecurity.security }))?.accessSecurity, { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: [RARE_TAG] });
  assert.equal(normalizeCommerce7Product(listed("rare", { security: { availableTo: 7 } }))?.accessSecurity, null, "a malformed block is known-unusable");
  assert.equal(normalizeCommerce7Product(listed("rare"))?.hasProviderStorefrontPublication, false, "unknown security is never treated as public");
});

test("the detail read is a public /v1 GET of exactly one product on the connection's tenant", async () => {
  const fake = tenant([listed("rare")]);
  const result = await fetchCommerce7ProductAccessSecurity({ tenant: TENANT, externalId: "rare" }, { fetchImpl: fake.fetchImpl });
  assert.deepEqual(result, { found: true, security: { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: [RARE_TAG] } });
  assert.deepEqual(fake.calls, ["GET /v1/product/rare"]);
  assert.deepEqual(await fetchCommerce7ProductAccessSecurity({ tenant: TENANT, externalId: "missing" }, { fetchImpl: fake.fetchImpl }), { found: false, security: null });
  const mismatched: Commerce7Fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "another-product", security: { availableTo: "Public" } }) });
  await assert.rejects(fetchCommerce7ProductAccessSecurity({ tenant: TENANT, externalId: "rare" }, { fetchImpl: mismatched }));
});

test("sync reads security per product when the list omits it: one-tag and multi-tag products become exclusive-eligible; public, tag-less and unavailable do not", async () => {
  const fake = tenant([listed("rare"), listed("multi"), listed("public"), listed("no-tag"), listed("retired", { webStatus: "Retired" })]);
  const app = harness(fake.fetchImpl);
  const outcome = await app.sync();
  assert.equal(outcome.status, "SUCCEEDED");
  assert.deepEqual(fake.details().sort(), ["GET /v1/product/multi", "GET /v1/product/no-tag", "GET /v1/product/public", "GET /v1/product/rare"], "unavailable products are never read individually");
  assert.deepEqual(commerce7ExclusiveSecurity(app.byExternalId("rare").providerMetadata), { tagIds: [RARE_TAG] });
  assert.deepEqual(commerce7ExclusiveSecurity(app.byExternalId("multi").providerMetadata), { tagIds: [RARE_TAG, OTHER_TAG] });
  assert.equal(commerce7ExclusiveSecurity(app.byExternalId("public").providerMetadata), null); assert.equal((app.security("public") as Record<string, unknown>).availableTo, "Public");
  assert.equal(commerce7ExclusiveSecurity(app.byExternalId("no-tag").providerMetadata), null);
  assert.equal(app.security("retired"), undefined);
  assert.equal(app.byExternalId("rare").hasPublicStorefrontUrl, false, "a Tag-secured product is never made public to appear in the picker");
});

test("an unchanged product keeps its known security without another read; a changed product is re-read", async () => {
  const products = [listed("rare"), listed("public")];
  const first = tenant(products); const rows = new Map<string, Row>();
  await harness(first.fetchImpl, rows).sync();
  const second = tenant(products); const app = harness(second.fetchImpl, rows);
  await app.sync();
  assert.deepEqual(second.details(), [], "same provider version: no detail reads");
  assert.deepEqual(commerce7ExclusiveSecurity(app.byExternalId("rare").providerMetadata), { tagIds: [RARE_TAG] }, "known security is never wiped by a list that omits it");
  const changed = tenant([listed("rare", { updatedAt: "2026-10-08T09:00:00.000Z" }), listed("public")], { detail: { ...detailSecurity, rare: { availableTo: "Public", availableToObjectIds: "" } } });
  const third = harness(changed.fetchImpl, rows); await third.sync();
  assert.deepEqual(changed.details(), ["GET /v1/product/rare"]);
  assert.equal(commerce7ExclusiveSecurity(third.byExternalId("rare").providerMetadata), null, "made public in Commerce7: no longer exclusive-eligible");
});

test("security reads are bounded per sync, unknown products first, and a failed read never erases known security", async () => {
  const many = Array.from({ length: 6 }, (_, index) => listed(`p${index}`));
  const fake = tenant(many, { detail: Object.fromEntries(many.map((product) => [product.id, { availableTo: "Public", availableToObjectIds: "" }])) });
  const app = harness(fake.fetchImpl);
  await app.sync({ maxSecurityReads: 4 });
  assert.equal(fake.details().length, 4, "at most the per-run budget");
  assert.equal(many.filter((product) => app.security(String(product.id)) !== undefined).length, 4);
  const next = tenant(many, { detail: Object.fromEntries(many.map((product) => [product.id, { availableTo: "Public", availableToObjectIds: "" }])) });
  const again = harness(next.fetchImpl, app.rows); await again.sync({ maxSecurityReads: 4 });
  assert.equal(next.details().length, 2, "the next sync reads only the products still unknown");
  assert.equal(many.every((product) => again.security(String(product.id)) !== undefined), true);
  const failing = tenant([listed("rare", { updatedAt: "2026-10-09T00:00:00.000Z" })], { failDetail: new Set(["rare"]) });
  const rows = new Map<string, Row>(); await harness(tenant([listed("rare")]).fetchImpl, rows).sync();
  const kept = harness(failing.fetchImpl, rows); const outcome = await kept.sync();
  assert.equal(outcome.status, "SUCCEEDED", "a failed security read does not fail the catalog sync");
  assert.deepEqual(commerce7ExclusiveSecurity(kept.byExternalId("rare").providerMetadata), { tagIds: [RARE_TAG] }, "known security is kept, not wiped, when the re-read fails");
});

test("when the list does include Product Security, no per-product reads are made", async () => {
  const fake = tenant([listed("rare", { security: evidence.productSecurity.security }), listed("public", { security: { availableTo: "Public" } })]);
  const app = harness(fake.fetchImpl); await app.sync();
  assert.deepEqual(fake.details(), []); assert.deepEqual(commerce7ExclusiveSecurity(app.byExternalId("rare").providerMetadata), { tagIds: [RARE_TAG] });
});
