import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { NextResponse } from "next/server";
import ts from "typescript";
import { realDbTest } from "./helpers/real-db";

const gate = realDbTest("ADMIN_INTEGRITY_REAL_DB");
test("Postgres serializes admin removals and approval decisions", { skip: gate.skipReason }, async () => {
  const { default: db } = await import("../src/lib/prisma");
  const { changeUserAccess, deleteUser } = await import("../src/lib/admin-user-mutations");
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids: string[] = [];
  const brandIds: string[] = [];
  async function user(role: "USER" | "ADMIN" = "USER") {
    const row = await db.user.create({ data: { email: `admin-integrity-${ids.length}-${unique}@example.test`, role } });
    ids.push(row.id); return row;
  }
  const existingAdmins = await db.user.count({ where: { role: "ADMIN", isActive: true } });
  try {
    const a = await user("ADMIN"), b = await user("ADMIN");
    await assert.rejects(changeUserAccess({ actorId: a.id, targetId: a.id, role: "USER" }), { message: "SELF_CHANGE" });
    const decisions = await Promise.allSettled([
      changeUserAccess({ actorId: a.id, targetId: b.id, role: "USER" }),
      changeUserAccess({ actorId: b.id, targetId: a.id, role: "USER" }),
    ]);
    if (existingAdmins === 0) assert.equal(decisions.filter((x) => x.status === "fulfilled").length, 1);
    assert.ok(await db.user.count({ where: { role: "ADMIN", isActive: true } }) >= 1);
    if (existingAdmins === 0) {
      const survivor = await db.user.findFirstOrThrow({ where: { id: { in: [a.id, b.id] }, role: "ADMIN", isActive: true } });
      const c = await user("ADMIN");
      const deleteAndDemote = await Promise.allSettled([
        deleteUser({ actorId: c.id, targetId: survivor.id }),
        changeUserAccess({ actorId: survivor.id, targetId: c.id, role: "USER" }),
      ]);
      assert.equal(deleteAndDemote.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(await db.user.count({ where: { role: "ADMIN", isActive: true } }), 1);
    }
    // A distinct reviewer remains available even if the concurrency fixture deleted one.
    const reviewer = await user("ADMIN");
    const history = await user();
    await db.pointTransaction.create({ data: { userId: history.id, points: 1, reason: "BONUS" } });
    await assert.rejects(deleteUser({ actorId: reviewer.id, targetId: history.id }), { message: "USER_HAS_HISTORY" });
    for (const kind of ["creator", "brand"] as const) {
      const applicant = await user();
      const request = kind === "creator" ? await db.creatorRequest.create({ data: { userId: applicant.id } }) : await db.brandRequest.create({ data: { userId: applicant.id, proposedBrandName: `Fixture ${unique}` } });
      const exports: { POST?: (request: Request, context: { params: Promise<{ requestId: string }> }) => Promise<Response> } = {};
      const deps: Record<string, unknown> = {
        "next/server": { NextResponse }, "@/lib/prisma": { __esModule: true, default: db },
        "@/helpers/mailer": { sendApprovalEmail: async () => {} },
        "@/lib/admin-auth": { getAdminContext: async () => ({ userId: reviewer.id, role: "ADMIN" }), createUniqueSlug: async (_name: string, exists: (x: string) => Promise<boolean>) => { const slug = `fixture-${unique}-${Math.random().toString(36).slice(2)}`; assert.equal(await exists(slug), false); return slug; } },
      };
      runInNewContext(ts.transpileModule(readFileSync(`src/app/api/admin/approvals/${kind}/[requestId]/route.ts`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require(name: string) { if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`); return deps[name]; }, console });
      const post = (action: string) => exports.POST!(new Request("https://example.test", { method: "POST", body: JSON.stringify({ action }) }), { params: Promise.resolve({ requestId: request.id }) });
      const results = await Promise.all([post("approve"), post("reject")]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await results.find((r) => r.status === 409)!.json()).code, "REQUEST_ALREADY_DECIDED");
      const stored = kind === "creator" ? await db.creatorRequest.findUniqueOrThrow({ where: { id: request.id } }) : await db.brandRequest.findUniqueOrThrow({ where: { id: request.id } });
      const updated = await db.user.findUniqueOrThrow({ where: { id: applicant.id } });
      assert.equal(updated.role, stored.status === "APPROVED" ? (kind === "creator" ? "CREATOR" : "BRAND_ADMIN") : "USER");
      const memberships = await db.brandMember.findMany({ where: { userId: applicant.id } });
      brandIds.push(...memberships.map((x) => x.brandId));
      assert.equal(memberships.length, kind === "brand" && stored.status === "APPROVED" ? 1 : 0);

      const doubleApplicant = await user();
      const doubleRequest = kind === "creator" ? await db.creatorRequest.create({ data: { userId: doubleApplicant.id } }) : await db.brandRequest.create({ data: { userId: doubleApplicant.id, proposedBrandName: `Double ${unique}` } });
      const doublePost = () => exports.POST!(new Request("https://example.test", { method: "POST", body: JSON.stringify({ action: "approve" }) }), { params: Promise.resolve({ requestId: doubleRequest.id }) });
      const doubles = await Promise.all([doublePost(), doublePost()]);
      assert.deepEqual(doubles.map((r) => r.status).sort(), [200, 409]);
      const doubleMemberships = await db.brandMember.findMany({ where: { userId: doubleApplicant.id } });
      brandIds.push(...doubleMemberships.map((x) => x.brandId));
      assert.equal(doubleMemberships.length, kind === "brand" ? 1 : 0);

      const adminRequest = kind === "creator" ? await db.creatorRequest.create({ data: { userId: reviewer.id } }) : await db.brandRequest.create({ data: { userId: reviewer.id } });
      const adminResponse = await exports.POST!(new Request("https://example.test", { method: "POST", body: JSON.stringify({ action: "approve" }) }), { params: Promise.resolve({ requestId: adminRequest.id }) });
      assert.equal(adminResponse.status, 409);
      assert.equal((await adminResponse.json()).code, "TARGET_IS_ADMIN");
      const unchanged = kind === "creator" ? await db.creatorRequest.findUniqueOrThrow({ where: { id: adminRequest.id } }) : await db.brandRequest.findUniqueOrThrow({ where: { id: adminRequest.id } });
      assert.equal(unchanged.status, "PENDING");
    }
  } finally {
    await db.brandMember.deleteMany({ where: { userId: { in: ids } } });
    await db.brand.deleteMany({ where: { id: { in: brandIds } } });
    await db.pointTransaction.deleteMany({ where: { userId: { in: ids } } });
    await db.creatorRequest.deleteMany({ where: { userId: { in: ids } } });
    await db.brandRequest.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
});
