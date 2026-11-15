import "./env-setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertExpectedBrand, type BrandAdminContext } from "../src/lib/brand-auth";
import { commerce7DisconnectPostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/disconnect/route";

const context = { userId: "user", selectionRequired: false, brands: [], membership: { id: "member", role: "MANAGER", brand: { id: "b", name: "Brand B", slug: "b", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null } } } satisfies BrandAdminContext;
const request = (brand?: string) => new Request("https://sqratch.test", { method: "POST", headers: brand ? { "x-sqratch-expected-brand": brand } : {} });

test("expected brand is optional but cannot select a different brand", () => {
  assert.equal(assertExpectedBrand(request(), context), null);
  assert.equal(assertExpectedBrand(request("b"), context), null);
  assert.deepEqual(assertExpectedBrand(request("private-id"), context), { status: 409, code: "BRAND_CONTEXT_MISMATCH", expectedBrandId: "private-id", activeBrand: { id: "b", name: "Brand B" } });
});

test("stale brand is rejected before a commerce mutation", async () => {
  let writes = 0;
  const response = await commerce7DisconnectPostImpl({ getContext: async () => context, disconnect: async () => { writes++; throw new Error("unexpected write"); } }, "connection", request("a"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "BRAND_CONTEXT_MISMATCH");
  assert.equal(writes, 0);
});

test("active brand selection remains higher priority", async () => {
  const response = await commerce7DisconnectPostImpl({ getContext: async () => ({ ...context, membership: null, selectionRequired: true }) }, "connection", request("a"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "ACTIVE_BRAND_REQUIRED");
});

test("every brand mutation reaches the expected-brand guard", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ts = await import("typescript");
  const routes: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "route.ts") routes.push(path);
    }
  }
  walk("src/app/api/brand");
  let count = 0;
  for (const file of routes) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const functions = new Map<string, import("typescript").FunctionDeclaration>();
    for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
    function guarded(name: string, visited = new Set<string>()): boolean {
      if (name === "assertExpectedBrand") return true;
      if (visited.has(name)) return false;
      visited.add(name);
      const node = functions.get(name);
      if (!node) return false;
      let found = false;
      function visit(child: import("typescript").Node) {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && guarded(child.expression.text, visited)) found = true;
        ts.forEachChild(child, visit);
      }
      visit(node);
      return found;
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      if (!functions.has(method)) continue;
      count++;
      assert.ok(guarded(method), `${file}: ${method} does not reach assertExpectedBrand`);
    }
  }
  assert.ok(count >= 22, `Expected at least 22 mutation handlers; found ${count}`);
});

test("VIEWER membership is excluded from brand management", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const ts = await import("typescript");
  const session = { user: { id: "viewer", role: "BRAND_ADMIN" } };
  const modules: Record<string, unknown> = {
    "next/headers": { cookies: async () => ({ get: () => null, set: () => {} }) },
    "next-auth": { getServerSession: async () => session },
    "@/app/api/auth/[...nextauth]/options": { authOptions: {} },
    "@/lib/prisma": { __esModule: true, default: { brandMember: { findMany: async () => [{ id: "member", role: "VIEWER", brand: { id: "b", name: "Brand", slug: "b", isActive: true } }] } } },
  };
  function load(file: string) {
    const exports: Record<string, unknown> = {};
    const output = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    runInNewContext(output, { exports, require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected module: ${id}`); return modules[id]; }, process });
    return exports;
  }
  modules["@/lib/brand-context"] = load("src/lib/brand-context.ts");
  const auth = load("src/lib/brand-auth.ts") as { getBrandAdminContext(): Promise<unknown> };
  assert.equal(await auth.getBrandAdminContext(), null);
});
