import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { archivedBatchWhere, archivedCodeWhere, parseArchivedFilter } from "../src/lib/qr-archive";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("the archived filter defaults to hiding archived batches and rejects unknown values", () => {
  assert.equal(parseArchivedFilter(null), "exclude");
  assert.equal(parseArchivedFilter(""), "exclude");
  assert.equal(parseArchivedFilter("include"), "include");
  assert.equal(parseArchivedFilter("only"), "only");
  assert.equal(parseArchivedFilter("everything"), null);
  assert.deepEqual(archivedBatchWhere("exclude"), { archivedAt: null });
  assert.deepEqual(archivedBatchWhere("only"), { archivedAt: { not: null } });
  assert.deepEqual(archivedBatchWhere("include"), {});
  // Codes with no batch can never be archived, so they stay in the default list.
  assert.deepEqual(archivedCodeWhere("exclude"), { OR: [{ batchId: null }, { batch: { is: { archivedAt: null } } }] });
  assert.deepEqual(archivedCodeWhere("include"), {});
});

test("archiving is never read by scanning, redemption, public routes, exports or deletion guards", () => {
  const guarded = [
    ...sourceFiles("src/app/api/public"),
    "src/lib/qr-redemption.ts",
    "src/lib/anonymous-transfer.ts",
    "src/lib/qr-lifecycle.ts",
    "src/app/api/brand/qr-batches/[id]/export/route.ts",
    "src/app/q",
  ].flatMap((path) => (existsSync(path) && statSync(path).isDirectory() ? sourceFiles(path) : [path]));
  assert.ok(guarded.length > 5);
  for (const file of guarded) assert.doesNotMatch(readFileSync(file, "utf8"), /archivedAt|archivedById|qr-archive/, file);
});

test("archive routes only touch batch list state and do not reuse isActive", () => {
  for (const mode of ["archive", "unarchive"]) {
    const route = readFileSync(`src/app/api/brand/qr-batches/[id]/${mode}/route.ts`, "utf8");
    assert.match(route, /assertExpectedBrand\(request, brand\)/);
    assert.match(route, /campaign: \{ brandId: brand\.membership\.brand\.id \}/);
    assert.doesNotMatch(route, /isActive/);
    assert.doesNotMatch(route, /qRCode\.|pointTransaction|campaignUnlock|\.delete/);
  }
});

test("the migration is additive, nullable, and leaves isActive alone", () => {
  const sql = readFileSync("prisma/migrations/20261114120000_add_qr_batch_archive/migration.sql", "utf8");
  const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /ADD COLUMN "archivedAt" TIMESTAMP\(3\),\s*ADD COLUMN "archivedById" TEXT$/);
  assert.match(statements[1], /ON DELETE SET NULL/);
  assert.doesNotMatch(statements.join(";\n"), /\bDROP\b|DELETE FROM|NOT NULL|^UPDATE |isActive/m);
});

test("the batch page offers archive, unarchive and an archived filter, and explains the blocked delete", () => {
  const page = readFileSync("src/app/(withSidebar)/dashboard/brand/qr-batches/page.tsx", "utf8");
  assert.match(page, /archived: archivedView/);
  assert.match(page, /"Unarchive"/);
  assert.match(page, /Archive this batch to hide it from the list/);
  assert.match(page, /Archived batches/);
  assert.match(page, /All batches/);
});
