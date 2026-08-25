/**
 * tests/product-config-fingerprint.test.ts
 *
 * PHASE 16-18 REPAIR — P1-1: the config-only product fingerprint
 * (`src/lib/commerce/product-config-fingerprint.ts`) and a source-level lock
 * proving the real DB-backed reader in `product-sync.ts` never selects
 * `updatedAt` or `lastProductSyncAt` — the exact defect the independent
 * review found (a normal successful sync bumps `lastProductSyncAt`, which
 * bumps Prisma's `@updatedAt`, which the OLD fingerprint read directly).
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { CommerceProvider } from "@prisma/client";

import { deriveProductConfigurationFingerprint } from "../src/lib/commerce/product-config-fingerprint";

describe("deriveProductConfigurationFingerprint", () => {
  test("3. a Commerce7 currency change DOES change the fingerprint", () => {
    const a = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    });
    const b = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "CAD", productRoute: "/product" },
    });
    assert.notEqual(a, b);
  });

  test("4. a Commerce7 storefrontUrl change DOES change the fingerprint", () => {
    const a = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://old.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    });
    const b = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://new.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    });
    assert.notEqual(a, b);
  });

  test("5. a Commerce7 productRoute change DOES change the fingerprint", () => {
    const a = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    });
    const b = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/shop" },
    });
    assert.notEqual(a, b);
  });

  test("6. a relevant Shopify config change (currency, storefrontUrl) DOES change the fingerprint", () => {
    const base = {
      provider: CommerceProvider.SHOPIFY,
      storefrontUrl: "https://shop.myshopify.com",
      providerMetadata: { currencyCode: "USD" },
    };
    const currencyChanged = deriveProductConfigurationFingerprint({
      ...base,
      providerMetadata: { currencyCode: "EUR" },
    });
    const storefrontChanged = deriveProductConfigurationFingerprint({
      ...base,
      storefrontUrl: "https://newshop.myshopify.com",
    });
    const original = deriveProductConfigurationFingerprint(base);
    assert.notEqual(currencyChanged, original);
    assert.notEqual(storefrontChanged, original);
  });

  test("an unrelated providerMetadata key changing does NOT change the fingerprint — this is not a whole-blob hash", () => {
    const a = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product", someUnrelatedFutureKey: "x" },
    });
    const b = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product", someUnrelatedFutureKey: "y" },
    });
    assert.equal(a, b);
  });

  test("identical config input produces an identical fingerprint (deterministic)", () => {
    const input = {
      provider: CommerceProvider.SHOPIFY,
      storefrontUrl: "https://shop.myshopify.com",
      providerMetadata: { currencyCode: "USD" },
    };
    assert.equal(
      deriveProductConfigurationFingerprint(input),
      deriveProductConfigurationFingerprint(input),
    );
  });

  test("a null storefrontUrl/providerMetadata never throws and yields a stable fingerprint", () => {
    const fp = deriveProductConfigurationFingerprint({
      provider: CommerceProvider.COMMERCE7,
      storefrontUrl: null,
      providerMetadata: null,
    });
    assert.equal(typeof fp, "string");
  });
});

describe("source-level lock: the real DB-backed fingerprint reader never selects updatedAt/lastProductSyncAt", () => {
  test("CONFIG_FINGERPRINT_SELECT in product-sync.ts names only provider/storefrontUrl/providerMetadata", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "commerce", "product-sync.ts"),
      "utf8",
    );
    const match = source.match(/const CONFIG_FINGERPRINT_SELECT = \{([\s\S]*?)\} as const;/);
    assert.ok(match, "CONFIG_FINGERPRINT_SELECT must exist in product-sync.ts");
    const body = match![1];
    assert.ok(!/updatedAt/.test(body), "the fingerprint select must never include updatedAt");
    assert.ok(!/lastProductSyncAt/.test(body), "the fingerprint select must never include lastProductSyncAt");
    assert.ok(/provider\s*:\s*true/.test(body));
    assert.ok(/storefrontUrl\s*:\s*true/.test(body));
    assert.ok(/providerMetadata\s*:\s*true/.test(body));
  });
});
