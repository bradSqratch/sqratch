import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function service(target: { id: string; role: string; isActive: boolean }, others = 0, history = 0, redeemedQr = false) {
  const tx = {
    user: { findUnique: async (args: { where: { id: string } }) => args.where.id === target.id ? ({ ...target, email: "user@example.test", name: "User" }) : ({ id: args.where.id, role: "ADMIN", isActive: true }), count: async () => others, update: async () => ({}), delete: async () => ({}) },
    campaign: { count: async () => 0 }, qRCode: { count: async (args: unknown) => { if (redeemedQr) assert.match(JSON.stringify(args), /redeemedById/); return redeemedQr ? 1 : 0; } }, pointTransaction: { count: async () => history }, commerceRewardRedemption: { count: async () => 0 },
  };
  const exports: Record<string, (...args: never[]) => Promise<unknown>> = {};
  runInNewContext(ts.transpileModule(readFileSync("src/lib/admin-user-mutations.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, Error, require: () => ({ __esModule: true, default: { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } }) });
  return exports as unknown as { changeUserAccess(input: object): Promise<unknown>; deleteUser(input: object): Promise<unknown> };
}

test("admin access and deletion refusal paths", async () => {
  const admin = service({ id: "target", role: "ADMIN", isActive: true });
  await assert.rejects(admin.changeUserAccess({ actorId: "target", targetId: "target", role: "USER" }), { message: "SELF_CHANGE" });
  await assert.rejects(admin.deleteUser({ actorId: "target", targetId: "target" }), { message: "SELF_CHANGE" });
  await assert.rejects(admin.changeUserAccess({ actorId: "other", targetId: "target", email: "changed@example.test", name: "Changed", role: "ADMIN", isActive: true }), { message: "EMAIL_CHANGE_NOT_ALLOWED" });
  await assert.rejects(admin.changeUserAccess({ actorId: "other", targetId: "target", role: "USER" }), { message: "LAST_ADMIN" });
  await assert.rejects(admin.changeUserAccess({ actorId: "other", targetId: "target", isActive: false }), { message: "LAST_ADMIN" });
  await assert.rejects(admin.deleteUser({ actorId: "other", targetId: "target" }), { message: "LAST_ADMIN" });
  await assert.rejects(service({ id: "target", role: "USER", isActive: true }, 1, 1).deleteUser({ actorId: "other", targetId: "target" }), { message: "USER_HAS_HISTORY" });
  await assert.rejects(service({ id: "target", role: "USER", isActive: true }, 1, 0, true).deleteUser({ actorId: "other", targetId: "target" }), { message: "USER_HAS_HISTORY" });
});

test("user role and active-state writes stay within the approved paths", () => {
  const allowed = new Set(["src/lib/admin-user-mutations.ts", "src/app/api/admin/approvals/brand/[requestId]/route.ts", "src/app/api/admin/approvals/creator/[requestId]/route.ts", "src/app/api/auth/signup/route.ts", "src/app/api/admin/user-management/get-or-create-users/route.ts"]);
  function walk(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []); }
  for (const file of walk("src")) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["update", "updateMany", "upsert", "create"].includes(node.expression.name.text) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "user") {
        const text = node.arguments[0]?.getText(source) || "";
        if (/\b(role|isActive)\s*:/.test(text)) assert.ok(allowed.has(file), `Unexpected User access writer: ${file}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});

test("approval routes map lost claims and admin targets to conflicts", async () => {
  for (const kind of ["brand", "creator"] as const) {
    for (const code of ["REQUEST_ALREADY_DECIDED", "TARGET_IS_ADMIN"]) {
      const exports: { POST?: (request: Request, context: { params: Promise<{ requestId: string }> }) => Promise<Response> } = {};
      const requestModel = {
        findUnique: async () => ({ id: "request", userId: "user", user: { id: "user", name: "Name", email: "user@example.test" } }),
        updateMany: async () => ({ count: code === "REQUEST_ALREADY_DECIDED" ? 0 : 1 }),
        findUniqueOrThrow: async () => ({ id: "request", status: "APPROVED" }),
      };
      const db = { [kind === "brand" ? "brandRequest" : "creatorRequest"]: requestModel, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ [kind === "brand" ? "brandRequest" : "creatorRequest"]: requestModel, user: { updateMany: async () => ({ count: 0 }) } }) };
      const { NextResponse } = await import("next/server");
      const deps: Record<string, unknown> = { "next/server": { NextResponse }, "@/lib/prisma": { __esModule: true, default: db }, "@/lib/admin-auth": { getAdminContext: async () => ({ userId: "admin" }) }, "@/helpers/mailer": {} };
      runInNewContext(ts.transpileModule(readFileSync(`src/app/api/admin/approvals/${kind}/[requestId]/route.ts`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, Error, require(name: string) { return deps[name]; }, console });
      const response = await exports.POST!(new Request("https://example.test", { method: "POST", body: JSON.stringify({ action: "approve" }) }), { params: Promise.resolve({ requestId: "request" }) });
      assert.equal(response.status, 409); assert.equal((await response.json()).code, code);
    }
  }
});
