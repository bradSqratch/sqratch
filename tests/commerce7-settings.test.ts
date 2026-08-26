/**
 * tests/commerce7-settings.test.ts
 *
 * PHASE 20 (settings sync round, Parts 19/20) — `fetchCommerce7StoreSettings`
 * (`src/lib/commerce/providers/commerce7-settings.ts`), the Commerce7
 * Setting API (`GET /v1/setting`) client.
 *
 * SECURITY (Part 19): proves that a Setting response containing fake
 * sensitive values belonging to OTHER merchant integrations (shipping
 * compliance, tax, payment, third-party secrets) never survives past this
 * module — the returned DTO contains ONLY `storefrontUrl`/`currencyCode`/
 * `productRoute`, and those sensitive values are absent from the DTO, from
 * any thrown error, and from anything this test itself would need to log to
 * fail (assertions read the DTO/error shape, never re-print the fixture).
 * Every "sensitive" value below is an obviously-fake placeholder string
 * (`"DO_NOT_STORE"` / `"FAKE_..."`), never a real credential shape.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import {
  fetchCommerce7StoreSettings,
  type Commerce7Fetch,
} from "../src/lib/commerce/providers/commerce7-settings";
import { CommerceProviderApiError } from "../src/lib/commerce/errors";

process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fakeFetch(handler: (url: string, init: unknown) => ReturnType<typeof jsonResponse>): Commerce7Fetch {
  return (async (url: string, init: unknown) => handler(url, init)) as unknown as Commerce7Fetch;
}

const SETTINGS_WITH_SENSITIVE_SIBLING_FIELDS = {
  settings: [
    {
      id: "setting-1",
      url: "https://shop.example.com",
      currency: "CAD",
      baseRoute: { product: "/product", cart: "/cart" },
      // Fake, obviously-placeholder values standing in for OTHER merchant
      // integrations' configuration — never real credential shapes.
      shipCompliant: { username: "FAKE_USER", password: "DO_NOT_STORE" },
      avalara: { licenseKey: "DO_NOT_STORE", accountId: "FAKE_ACCOUNT" },
      payment: { provider: "fake-processor", apiKey: "DO_NOT_STORE" },
      vinoCheck: { apiSecretKey: "DO_NOT_STORE" },
    },
  ],
  total: 1,
};

describe("Part 19: fetchCommerce7StoreSettings — sensitive-field security boundary", () => {
  test("a Setting response containing fake sensitive sibling fields yields a DTO with ONLY storefrontUrl/currencyCode/productRoute", async () => {
    const dto = await fetchCommerce7StoreSettings(
      { tenant: "sqratch-inc" },
      { fetchImpl: fakeFetch(() => jsonResponse(200, SETTINGS_WITH_SENSITIVE_SIBLING_FIELDS)) },
    );

    assert.deepEqual(Object.keys(dto).sort(), ["currencyCode", "productRoute", "storefrontUrl"]);
    assert.equal(dto.storefrontUrl, "https://shop.example.com");
    assert.equal(dto.currencyCode, "CAD");
    assert.equal(dto.productRoute, "/product");

    const serialized = JSON.stringify(dto);
    assert.ok(!serialized.includes("DO_NOT_STORE"), "no sensitive value anywhere in the returned DTO");
    assert.ok(!serialized.includes("shipCompliant"));
    assert.ok(!serialized.includes("avalara"));
    assert.ok(!serialized.includes("payment"));
    assert.ok(!serialized.includes("vinoCheck"));
    assert.ok(!serialized.includes("FAKE_USER"));
    assert.ok(!serialized.includes("FAKE_ACCOUNT"));
  });

  test("a malformed-settings failure's thrown error never carries the raw response body", async () => {
    let thrown: unknown;
    try {
      await fetchCommerce7StoreSettings(
        { tenant: "sqratch-inc" },
        { fetchImpl: fakeFetch(() => jsonResponse(200, { settings: [], total: 0 })) },
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof CommerceProviderApiError);
    const serialized = JSON.stringify({
      message: (thrown as CommerceProviderApiError).message,
      details: (thrown as CommerceProviderApiError).details,
    });
    assert.ok(!serialized.includes("DO_NOT_STORE"));
  });
});

describe("Part 20: fetchCommerce7StoreSettings — extraction and fail-closed behavior", () => {
  test("a valid, single-row response extracts url/currency/baseRoute.product exactly", async () => {
    const dto = await fetchCommerce7StoreSettings(
      { tenant: "sqratch-inc" },
      {
        fetchImpl: fakeFetch(() =>
          jsonResponse(200, {
            settings: [{ url: "https://winery.example.com", currency: "USD", baseRoute: { product: "/products" } }],
            total: 1,
          }),
        ),
      },
    );
    assert.equal(dto.storefrontUrl, "https://winery.example.com");
    assert.equal(dto.currencyCode, "USD");
    assert.equal(dto.productRoute, "/products");
  });

  test("zero settings rows fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          { fetchImpl: fakeFetch(() => jsonResponse(200, { settings: [], total: 0 })) },
        ),
      CommerceProviderApiError,
    );
  });

  test("more than one settings row fails closed", async () => {
    const row = { url: "https://a.example.com", currency: "USD", baseRoute: { product: "/product" } };
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          { fetchImpl: fakeFetch(() => jsonResponse(200, { settings: [row, row], total: 2 })) },
        ),
      CommerceProviderApiError,
    );
  });

  test("a non-array settings field fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          { fetchImpl: fakeFetch(() => jsonResponse(200, { settings: "not-an-array" })) },
        ),
      CommerceProviderApiError,
    );
  });

  test("a missing url fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          {
            fetchImpl: fakeFetch(() =>
              jsonResponse(200, { settings: [{ currency: "USD", baseRoute: { product: "/product" } }], total: 1 }),
            ),
          },
        ),
      CommerceProviderApiError,
    );
  });

  test("a missing currency fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          {
            fetchImpl: fakeFetch(() =>
              jsonResponse(200, {
                settings: [{ url: "https://a.example.com", baseRoute: { product: "/product" } }],
                total: 1,
              }),
            ),
          },
        ),
      CommerceProviderApiError,
    );
  });

  test("a missing baseRoute.product fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          {
            fetchImpl: fakeFetch(() =>
              jsonResponse(200, {
                settings: [{ url: "https://a.example.com", currency: "USD", baseRoute: {} }],
                total: 1,
              }),
            ),
          },
        ),
      CommerceProviderApiError,
    );
  });

  test("baseRoute missing entirely fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          {
            fetchImpl: fakeFetch(() =>
              jsonResponse(200, { settings: [{ url: "https://a.example.com", currency: "USD" }], total: 1 }),
            ),
          },
        ),
      CommerceProviderApiError,
    );
  });

  test("a 401 response fails closed as a classified provider error", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          { fetchImpl: fakeFetch(() => jsonResponse(401, { error: "unauthorized" })) },
        ),
      CommerceProviderApiError,
    );
  });

  test("a 403 response fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          { fetchImpl: fakeFetch(() => jsonResponse(403, { error: "forbidden" })) },
        ),
      CommerceProviderApiError,
    );
  });

  test("a 500 response fails closed", async () => {
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "sqratch-inc" },
          { fetchImpl: fakeFetch(() => jsonResponse(500, { error: "boom" })) },
        ),
      CommerceProviderApiError,
    );
  });

  test("a network-level rejection (timeout/unreachable) fails closed and never leaks the underlying error", async () => {
    const fetchImpl: Commerce7Fetch = (async () => {
      throw new Error("request failed: header dump leaked here would be bad");
    }) as unknown as Commerce7Fetch;
    let thrown: unknown;
    try {
      await fetchCommerce7StoreSettings({ tenant: "sqratch-inc" }, { fetchImpl });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof CommerceProviderApiError);
    assert.ok(!(thrown as CommerceProviderApiError).message.includes("header dump"));
  });

  test("an invalid tenant is rejected before any fetch call", async () => {
    let called = false;
    await assert.rejects(
      () =>
        fetchCommerce7StoreSettings(
          { tenant: "not a valid tenant!!" },
          { fetchImpl: fakeFetch(() => { called = true; return jsonResponse(200, { settings: [], total: 0 }); }) },
        ),
      CommerceProviderApiError,
    );
    assert.equal(called, false);
  });

  test("the tenant and Basic-auth headers are sent exactly as documented, and the request is GET /v1/setting", async () => {
    let capturedUrl = "";
    let capturedInit: { method: string; headers: Record<string, string> } | null = null;
    await fetchCommerce7StoreSettings(
      { tenant: "sqratch-inc" },
      {
        fetchImpl: fakeFetch((url, init) => {
          capturedUrl = url;
          capturedInit = init as { method: string; headers: Record<string, string> };
          return jsonResponse(200, {
            settings: [{ url: "https://a.example.com", currency: "USD", baseRoute: { product: "/product" } }],
            total: 1,
          });
        }),
      },
    );
    assert.equal(capturedUrl, "https://api.commerce7.com/v1/setting");
    assert.equal(capturedInit!.method, "GET");
    assert.equal(capturedInit!.headers.tenant, "sqratch-inc");
    assert.equal(
      capturedInit!.headers.Authorization,
      `Basic ${Buffer.from("test-app-id:test-app-secret").toString("base64")}`,
    );
  });
});
