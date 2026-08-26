/**
 * tests/commerce7-settings-sync-route.test.ts
 *
 * PHASE 20 (settings sync round, Part 4) —
 * `POST /api/brand/commerce/connections/[connectionId]/settings/sync`
 * (`commerce7SettingsSyncPostImpl`): auth/ownership/status/provider-error
 * mapping. Mirrors the established pattern in
 * `tests/commerce7-storefront-configuration.test.ts`'s route-level battery
 * (13-15).
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import { commerce7SettingsSyncPostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/settings/sync/route";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  CommerceProviderApiError,
} from "../src/lib/commerce/errors";
import type { BrandAdminContext } from "../src/lib/brand-auth";

function makeContext(): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: "brand-a", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: { id: "brand-a", name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null },
    },
  };
}

describe("commerce7SettingsSyncPostImpl", () => {
  test("unauthenticated caller never reaches sync()", async () => {
    let called = false;
    const res = await commerce7SettingsSyncPostImpl(
      {
        getContext: async () => null,
        sync: async () => {
          called = true;
          return { ok: true, storefrontUrl: "https://x.example.com", productRoute: "/product", currencyCode: "USD", requiresProductSync: false };
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("CommerceConnectionNotFoundError maps to 404 (foreign/missing indistinguishable)", async () => {
    const res = await commerce7SettingsSyncPostImpl(
      { getContext: async () => makeContext(), sync: async () => { throw new CommerceConnectionNotFoundError("conn-1"); } },
      "conn-1",
    );
    assert.equal(res.status, 404);
  });

  test("CommerceConnectionMismatchError maps to 400", async () => {
    const res = await commerce7SettingsSyncPostImpl(
      {
        getContext: async () => makeContext(),
        sync: async () => {
          throw new CommerceConnectionMismatchError("conn-1", CommerceProvider.COMMERCE7, CommerceProvider.SHOPIFY);
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 400);
  });

  test("CommerceConnectionNotReadyError maps to 409", async () => {
    const res = await commerce7SettingsSyncPostImpl(
      {
        getContext: async () => makeContext(),
        sync: async () => {
          throw new CommerceConnectionNotReadyError("conn-1", CommerceProvider.COMMERCE7, "DISCONNECTED");
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 409);
  });

  test("a CommerceProviderApiError maps to a sanitized 502 — never the raw provider message", async () => {
    const res = await commerce7SettingsSyncPostImpl(
      {
        getContext: async () => makeContext(),
        sync: async () => {
          throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "raw provider detail that must never leak");
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!body.error.includes("raw provider detail"));
  });

  test("a validation failure ({ok: false}) maps to a 422 with the field-scoped message", async () => {
    const res = await commerce7SettingsSyncPostImpl(
      {
        getContext: async () => makeContext(),
        sync: async () => ({ ok: false, field: "storefrontUrl", error: "Invalid storefront URL." }),
      },
      "conn-1",
    );
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.field, "storefrontUrl");
  });

  test("a successful sync maps to 200 with ONLY the safe DTO fields", async () => {
    const res = await commerce7SettingsSyncPostImpl(
      {
        getContext: async () => makeContext(),
        sync: async () => ({
          ok: true,
          storefrontUrl: "https://shop.example.com",
          productRoute: "/product",
          currencyCode: "CAD",
          requiresProductSync: true,
        }),
      },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body.data).sort(), [
      "currencyCode",
      "productRoute",
      "requiresProductSync",
      "storefrontUrl",
    ]);
  });

  test("a missing connectionId maps to 400 before sync() is ever called", async () => {
    let called = false;
    const res = await commerce7SettingsSyncPostImpl(
      { getContext: async () => makeContext(), sync: async () => { called = true; return { ok: true, storefrontUrl: "https://x.example.com", productRoute: "/product", currencyCode: "USD", requiresProductSync: false }; } },
      undefined,
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });
});
