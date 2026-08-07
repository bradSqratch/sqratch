process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/commerce-product-reconciliation.test.ts
 *
 * Unit tests for the Phase-3 product-catalog reconciliation LOGIC
 * (`src/lib/commerce/product-reconciliation.ts`) behind
 * `scripts/reconcile-commerce-products.ts`.
 *
 * No real DB, no real network anywhere in this file. `DATABASE_URL` /
 * `DIRECT_URL` above are the deliberately-unreachable blocked placeholders
 * (port 1 is never a live Postgres listener) — same convention as every
 * other test file in this repo. All dependencies are in-memory fakes
 * implementing `ProductReconciliationDeps`; the module under test is never
 * given a real Prisma client.
 *
 * Covered cases (numbered to match the task's review checklist):
 *  1.  Dry run by default performs ZERO writes.
 *  2.  duplicate_external_key detection fires correctly.
 *  3.  cross_brand_selection detection fires correctly (and is flagged as a warning).
 *  4.  wrong_brand_product detection fires correctly.
 *  5.  unavailable_but_visible detection fires correctly.
 *  6.  Deterministic repairs (3 & 4) apply only with --apply, and totals match what was done.
 *  7.  cross_brand_selection rows are reported but NEVER auto-repaired, even with --apply.
 *  8.  duplicate_external_key rows are reported but NEVER resolved, even with --apply.
 *  9.  No product or selection row is ever deleted, in any mode.
 *  10. Idempotency: a second --apply run immediately after reports zero repairs.
 *  11. --brand-id / --connection-id / --provider / --limit narrow correctly.
 *  12. Failures are counted without aborting the run, matching the documented exit-code contract.
 *  13. No output line matches /token|secret|encrypted|password|authorization/i.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider } from "@prisma/client";

import {
  reconcileCommerceProducts,
  findDuplicateExternalKeyGroups,
  findCrossBrandSelections,
  findWrongBrandProducts,
  findUnavailableButVisible,
  type ConnectedProductRow,
  type BrandSelectionRow,
  type ProductReconciliationDeps,
  type ProductReconciliationFilter,
} from "../src/lib/commerce/product-reconciliation";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeProduct(overrides: Partial<ConnectedProductRow> = {}): ConnectedProductRow {
  return {
    id: "product-1",
    connectionId: "connection-1",
    brandId: "brand-1",
    connectionBrandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    externalKey: "gid://shopify/Product/1",
    isAvailable: true,
    unavailableSince: null,
    ...overrides,
  };
}

function makeSelection(overrides: Partial<BrandSelectionRow> = {}): BrandSelectionRow {
  return {
    id: "selection-1",
    brandId: "brand-1",
    connectedProductId: "product-1",
    isVisibleInShop: false,
    connectedProductBrandId: "brand-1",
    connectedProductIsAvailable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake in-memory store + deps
// ---------------------------------------------------------------------------

class FakeStore {
  products: ConnectedProductRow[] = [];
  selections: BrandSelectionRow[] = [];
  calls = { productBrandUpdates: 0, visibilityClears: 0 };
  /** productId -> error, to simulate a repair failure without aborting the run. */
  failProductBrandUpdateFor = new Set<string>();

  seedProducts(...rows: ConnectedProductRow[]) {
    this.products.push(...rows);
  }

  seedSelections(...rows: BrandSelectionRow[]) {
    this.selections.push(...rows);
  }
}

function buildFakeDeps(store: FakeStore): ProductReconciliationDeps {
  function filterProducts(filter: ProductReconciliationFilter): ConnectedProductRow[] {
    let rows = store.products.filter(
      (row) =>
        (!filter.brandId || row.brandId === filter.brandId) &&
        (!filter.connectionId || row.connectionId === filter.connectionId) &&
        (!filter.provider || row.provider === filter.provider),
    );
    rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    if (filter.limit) {
      rows = rows.slice(0, filter.limit);
    }
    // Clone so callers mutating the returned array/object never corrupt the store directly.
    return rows.map((row) => ({ ...row }));
  }

  function filterSelections(filter: ProductReconciliationFilter): BrandSelectionRow[] {
    let rows = store.selections.filter((row) => !filter.brandId || row.brandId === filter.brandId);
    rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    if (filter.limit) {
      rows = rows.slice(0, filter.limit);
    }
    return rows.map((row) => ({ ...row }));
  }

  return {
    listConnectedProducts: async (filter) => filterProducts(filter),
    listBrandSelections: async (filter) => filterSelections(filter),
    updateProductBrandId: async (productId, connectionBrandId) => {
      store.calls.productBrandUpdates += 1;
      if (store.failProductBrandUpdateFor.has(productId)) {
        throw new Error(`simulated failure updating brandId for ${productId}`);
      }
      const row = store.products.find((r) => r.id === productId);
      if (!row) {
        return { updated: false };
      }
      row.brandId = connectionBrandId;
      return { updated: true };
    },
    clearVisibility: async (brandCommerceProductId) => {
      store.calls.visibilityClears += 1;
      const row = store.selections.find((r) => r.id === brandCommerceProductId);
      if (!row) {
        return { updated: false };
      }
      row.isVisibleInShop = false;
      return { updated: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure detection helper unit tests
// ---------------------------------------------------------------------------

describe("pure detection helpers", () => {
  test("findDuplicateExternalKeyGroups groups rows sharing (connectionId, externalKey)", () => {
    const a = makeProduct({ id: "p1", connectionId: "c1", externalKey: "k1" });
    const b = makeProduct({ id: "p2", connectionId: "c1", externalKey: "k1" });
    const c = makeProduct({ id: "p3", connectionId: "c1", externalKey: "k2" });
    const groups = findDuplicateExternalKeyGroups([a, b, c]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].map((r) => r.id).sort(),
      ["p1", "p2"],
    );
  });

  test("findCrossBrandSelections flags brandId mismatch", () => {
    const good = makeSelection({ id: "s1", brandId: "brand-1", connectedProductBrandId: "brand-1" });
    const bad = makeSelection({ id: "s2", brandId: "brand-2", connectedProductBrandId: "brand-1" });
    const result = findCrossBrandSelections([good, bad]);
    assert.deepEqual(
      result.map((r) => r.id),
      ["s2"],
    );
  });

  test("findWrongBrandProducts flags denormalized brandId mismatch", () => {
    const good = makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-1" });
    const bad = makeProduct({ id: "p2", brandId: "brand-1", connectionBrandId: "brand-2" });
    const result = findWrongBrandProducts([good, bad]);
    assert.deepEqual(
      result.map((r) => r.id),
      ["p2"],
    );
  });

  test("findUnavailableButVisible flags isAvailable=false + isVisibleInShop=true", () => {
    const hiddenUnavailable = makeSelection({
      id: "s1",
      isVisibleInShop: false,
      connectedProductIsAvailable: false,
    });
    const visibleAvailable = makeSelection({
      id: "s2",
      isVisibleInShop: true,
      connectedProductIsAvailable: true,
    });
    const visibleUnavailable = makeSelection({
      id: "s3",
      isVisibleInShop: true,
      connectedProductIsAvailable: false,
    });
    const result = findUnavailableButVisible([hiddenUnavailable, visibleAvailable, visibleUnavailable]);
    assert.deepEqual(
      result.map((r) => r.id),
      ["s3"],
    );
  });
});

// ---------------------------------------------------------------------------
// reconcileCommerceProducts integration-style tests (in-memory fakes)
// ---------------------------------------------------------------------------

describe("reconcileCommerceProducts", () => {
  test("1. dry run by default performs ZERO writes", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-2" }), // wrong_brand_product
    );
    store.seedSelections(
      makeSelection({
        id: "s1",
        isVisibleInShop: true,
        connectedProductIsAvailable: false, // unavailable_but_visible
      }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false });

    assert.equal(report.mode, "dry_run");
    assert.equal(store.calls.productBrandUpdates, 0);
    assert.equal(store.calls.visibilityClears, 0);
    // Data itself untouched.
    assert.equal(store.products[0].brandId, "brand-1");
    assert.equal(store.selections[0].isVisibleInShop, true);
    // Totals still preview the would-be repairs.
    assert.equal(report.totals.updated, 2);
  });

  test("2. detects duplicate external keys", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", connectionId: "c1", externalKey: "dup-key" }),
      makeProduct({ id: "p2", connectionId: "c1", externalKey: "dup-key" }),
      makeProduct({ id: "p3", connectionId: "c1", externalKey: "unique-key" }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false });

    const findings = report.findings.filter((f) => f.kind === "duplicate_external_key");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].repaired, false);
    assert.equal(report.totals.warnings, 1);
  });

  test("3. detects cross-brand selections (security-relevant)", async () => {
    const store = new FakeStore();
    store.seedSelections(
      makeSelection({ id: "s1", brandId: "brand-2", connectedProductBrandId: "brand-1" }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false });

    const findings = report.findings.filter((f) => f.kind === "cross_brand_selection");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].repaired, false);
    assert.match(report.lines.find((l) => l.includes("cross_brand_selection")) ?? "", /SECURITY/);
    assert.equal(report.totals.warnings, 1);
  });

  test("4. detects wrong-brand products", async () => {
    const store = new FakeStore();
    store.seedProducts(makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-2" }));
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false });

    const findings = report.findings.filter((f) => f.kind === "wrong_brand_product");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].repaired, false);
  });

  test("5. detects unavailable-but-visible selections", async () => {
    const store = new FakeStore();
    store.seedSelections(
      makeSelection({ id: "s1", isVisibleInShop: true, connectedProductIsAvailable: false }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false });

    const findings = report.findings.filter((f) => f.kind === "unavailable_but_visible");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].repaired, false);
  });

  test("6. --apply performs deterministic repairs and totals match what was actually done", async () => {
    const store = new FakeStore();
    store.seedProducts(makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-2" }));
    store.seedSelections(
      makeSelection({ id: "s1", isVisibleInShop: true, connectedProductIsAvailable: false }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: true });

    assert.equal(report.mode, "apply");
    assert.equal(store.calls.productBrandUpdates, 1);
    assert.equal(store.calls.visibilityClears, 1);
    assert.equal(store.products[0].brandId, "brand-2");
    assert.equal(store.selections[0].isVisibleInShop, false);

    const wrongBrandFinding = report.findings.find((f) => f.kind === "wrong_brand_product");
    const unavailableFinding = report.findings.find((f) => f.kind === "unavailable_but_visible");
    assert.equal(wrongBrandFinding?.repaired, true);
    assert.equal(unavailableFinding?.repaired, true);
    assert.equal(report.totals.updated, 2);
    assert.equal(report.totals.failed, 0);
  });

  test("7. cross-brand selections are reported but NEVER auto-repaired, even with --apply", async () => {
    const store = new FakeStore();
    store.seedSelections(
      makeSelection({
        id: "s1",
        brandId: "brand-2",
        connectedProductBrandId: "brand-1",
        isVisibleInShop: true,
      }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: true });

    assert.equal(store.calls.visibilityClears, 0);
    assert.equal(store.selections[0].isVisibleInShop, true); // untouched
    const finding = report.findings.find((f) => f.kind === "cross_brand_selection");
    assert.equal(finding?.repaired, false);
  });

  test("8. duplicate external keys are reported but never resolved, even with --apply", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", connectionId: "c1", externalKey: "dup-key", brandId: "brand-1", connectionBrandId: "brand-1" }),
      makeProduct({ id: "p2", connectionId: "c1", externalKey: "dup-key", brandId: "brand-1", connectionBrandId: "brand-1" }),
    );
    const deps = buildFakeDeps(store);
    const beforeCount = store.products.length;

    const report = await reconcileCommerceProducts(deps, { apply: true });

    assert.equal(store.products.length, beforeCount);
    assert.equal(store.calls.productBrandUpdates, 0);
    const finding = report.findings.find((f) => f.kind === "duplicate_external_key");
    assert.equal(finding?.repaired, false);
  });

  test("9. no product or selection row is ever deleted, in any mode", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", connectionId: "c1", externalKey: "dup-key" }),
      makeProduct({ id: "p2", connectionId: "c1", externalKey: "dup-key" }),
      makeProduct({ id: "p3", brandId: "brand-1", connectionBrandId: "brand-2" }),
    );
    store.seedSelections(
      makeSelection({ id: "s1", brandId: "brand-2", connectedProductBrandId: "brand-1" }),
      makeSelection({ id: "s2", isVisibleInShop: true, connectedProductIsAvailable: false }),
    );
    const deps = buildFakeDeps(store);
    // Sanity: this fake's deps object has no delete-shaped method at all --
    // there is nothing for reconcileCommerceProducts to even call.
    assert.equal((deps as Record<string, unknown>).deleteProduct, undefined);
    assert.equal((deps as Record<string, unknown>).deleteSelection, undefined);

    const productCountBefore = store.products.length;
    const selectionCountBefore = store.selections.length;

    await reconcileCommerceProducts(deps, { apply: true });

    assert.equal(store.products.length, productCountBefore);
    assert.equal(store.selections.length, selectionCountBefore);
  });

  test("10. idempotency: a second --apply run immediately after reports zero repairs", async () => {
    const store = new FakeStore();
    store.seedProducts(makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-2" }));
    store.seedSelections(
      makeSelection({ id: "s1", isVisibleInShop: true, connectedProductIsAvailable: false }),
    );
    const deps = buildFakeDeps(store);

    const first = await reconcileCommerceProducts(deps, { apply: true });
    assert.equal(first.totals.updated, 2);

    const second = await reconcileCommerceProducts(deps, { apply: true });
    assert.equal(second.totals.updated, 0);
    assert.equal(second.totals.warnings, 0);
    assert.equal(second.findings.length, 0);
  });

  test("11a. --brand-id narrows candidate products and selections", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-2" }),
      makeProduct({ id: "p2", brandId: "brand-9", connectionBrandId: "brand-8" }),
    );
    store.seedSelections(
      makeSelection({ id: "s1", brandId: "brand-1", isVisibleInShop: true, connectedProductIsAvailable: false }),
      makeSelection({ id: "s2", brandId: "brand-9", isVisibleInShop: true, connectedProductIsAvailable: false }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false, brandId: "brand-1" });

    assert.equal(report.totals.productsScanned, 1);
    assert.equal(report.totals.selectionsScanned, 1);
    assert.equal(
      report.findings.every((f) => f.brandId === "brand-1"),
      true,
    );
  });

  test("11b. --connection-id narrows candidate products", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", connectionId: "conn-a", brandId: "brand-1", connectionBrandId: "brand-2" }),
      makeProduct({ id: "p2", connectionId: "conn-b", brandId: "brand-1", connectionBrandId: "brand-2" }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false, connectionId: "conn-a" });

    assert.equal(report.totals.productsScanned, 1);
    assert.equal(report.findings.length, 1);
  });

  test("11c. --provider narrows candidate products", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", provider: CommerceProvider.SHOPIFY, brandId: "brand-1", connectionBrandId: "brand-2" }),
      makeProduct({ id: "p2", provider: CommerceProvider.COMMERCE7, brandId: "brand-1", connectionBrandId: "brand-2" }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, {
      apply: false,
      provider: CommerceProvider.COMMERCE7,
    });

    assert.equal(report.totals.productsScanned, 1);
    assert.equal(report.findings[0].connectionId, "connection-1");
  });

  test("11d. --limit caps the number of scanned rows per table", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-1" }),
      makeProduct({ id: "p2", brandId: "brand-1", connectionBrandId: "brand-1" }),
      makeProduct({ id: "p3", brandId: "brand-1", connectionBrandId: "brand-1" }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: false, limit: 2 });

    assert.equal(report.totals.productsScanned, 2);
  });

  test("12. failures are counted without aborting the run", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", brandId: "brand-1", connectionBrandId: "brand-2" }),
      makeProduct({ id: "p2", brandId: "brand-1", connectionBrandId: "brand-3" }),
    );
    store.failProductBrandUpdateFor.add("p1");
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: true });

    // p1's repair failed; p2's still succeeded -- the run did not abort.
    assert.equal(report.totals.failed, 1);
    assert.equal(store.products.find((r) => r.id === "p2")?.brandId, "brand-3");
    assert.equal(store.products.find((r) => r.id === "p1")?.brandId, "brand-1"); // unchanged
    // Matches the documented CLI exit-code contract: totals.failed > 0 => exit 1.
    const wouldExitNonZero = report.totals.failed > 0;
    assert.equal(wouldExitNonZero, true);
  });

  test("13. no output line contains a token/secret/encrypted/password/authorization-shaped string", async () => {
    const store = new FakeStore();
    store.seedProducts(
      makeProduct({ id: "p1", connectionId: "c1", externalKey: "dup-key" }),
      makeProduct({ id: "p2", connectionId: "c1", externalKey: "dup-key" }),
      makeProduct({ id: "p3", brandId: "brand-1", connectionBrandId: "brand-2" }),
    );
    store.seedSelections(
      makeSelection({ id: "s1", brandId: "brand-2", connectedProductBrandId: "brand-1" }),
      makeSelection({ id: "s2", isVisibleInShop: true, connectedProductIsAvailable: false }),
    );
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: true });

    const forbidden = /token|secret|encrypted|password|authorization/i;
    for (const line of report.lines) {
      assert.doesNotMatch(line, forbidden);
    }
  });

  test("empty catalog: nothing scanned, nothing reported, zero writes", async () => {
    const store = new FakeStore();
    const deps = buildFakeDeps(store);

    const report = await reconcileCommerceProducts(deps, { apply: true });

    assert.equal(report.totals.productsScanned, 0);
    assert.equal(report.totals.selectionsScanned, 0);
    assert.equal(report.findings.length, 0);
    assert.equal(report.totals.created, 0);
    assert.equal(report.totals.updated, 0);
    assert.equal(report.totals.warnings, 0);
    assert.equal(report.totals.failed, 0);
  });
});
