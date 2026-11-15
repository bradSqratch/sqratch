import "./env-setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { assertExpectedBrand, getBrandContextFailure, slugifyValue, type BrandAdminContext } from "../src/lib/brand-auth";

const context = { userId: "user", selectionRequired: false, brands: [], membership: { id: "member", role: "MANAGER", brand: { id: "brand-b", name: "Brand B", slug: "b", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null } } } satisfies BrandAdminContext;
function campaignRoute(auth: BrandAdminContext | null) {
  const writes: Array<{ brandId: string; createdById: string }> = [];
  const modules: Record<string, unknown> = {
    "next/server": { NextRequest, NextResponse },
    "@/lib/brand-auth": { getBrandAdminContext: async () => auth, getBrandContextFailure, assertExpectedBrand, slugifyValue },
    "@/lib/prisma": { __esModule: true, default: { campaign: { findFirst: async () => null, create: async ({ data }: { data: { brandId: string; createdById: string } }) => { writes.push(data); return data; } } } },
  };
  const exports: { POST?: (request: NextRequest) => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(readFileSync("src/app/api/brand/campaigns/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, console, require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected dependency ${id}`); return modules[id]; } });
  return { writes, call: (expected?: string) => exports.POST!(new NextRequest("https://example.test/api/brand/campaigns", { method: "POST", headers: expected ? { "x-sqratch-expected-brand": expected } : {}, body: JSON.stringify({ name: "Synthetic campaign", brandId: "client-selected-brand" }) })) };
}

test("campaign creation uses authorized brand; expected header detects stale forms without granting authority", async () => {
  for (const expected of [undefined, "brand-b"]) {
    const route = campaignRoute(context);
    assert.equal((await route.call(expected)).status, 201);
    assert.equal(route.writes.length, 1);
    assert.equal(route.writes[0].brandId, "brand-b");
    assert.equal(route.writes[0].createdById, "user");
  }
  const stale = campaignRoute(context);
  const mismatch = await stale.call("brand-a");
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "BRAND_CONTEXT_MISMATCH");
  assert.equal(stale.writes.length, 0);
  const unauthorized = campaignRoute(null);
  assert.equal((await unauthorized.call("brand-b")).status, 403);
  assert.equal(unauthorized.writes.length, 0);
});
