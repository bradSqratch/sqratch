import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATION_DIR_NAME = "20260719061157_remove_legacy_user_points";

function readMigrationSql() {
  return readFileSync(
    new URL(`../prisma/migrations/${MIGRATION_DIR_NAME}/migration.sql`, import.meta.url),
    "utf8",
  );
}

test("the migration folder exists with exactly one migration.sql file", () => {
  const files = readdirSync(
    new URL(`../prisma/migrations/${MIGRATION_DIR_NAME}`, import.meta.url),
  );
  assert.deepEqual(files, ["migration.sql"]);
});

test("the migration drops only User.points and touches no other schema object", () => {
  const sql = readMigrationSql();

  // Strip SQL comments before inspecting statements so documentation text
  // (which legitimately mentions PointTransaction/UserPointAccount/etc. in
  // prose) can't produce a false negative.
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();

  assert.equal(withoutComments, `ALTER TABLE "User" DROP COLUMN "points";`);
});

test("the migration contains no destructive statements beyond the single column drop", () => {
  const sql = readMigrationSql();

  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bDELETE\b/i);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bDROP TABLE\b/i);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bUPDATE\b/i);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bALTER TYPE\b/i);
});

test("the migration never mentions PointTransaction or UserPointAccount in an executable statement", () => {
  const sql = readMigrationSql();
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  assert.doesNotMatch(withoutComments, /PointTransaction/);
  assert.doesNotMatch(withoutComments, /UserPointAccount/);
});

test("the migration documents why the column is obsolete, the authoritative models, reconciliation, and preservation guarantees", () => {
  const sql = readMigrationSql();

  assert.match(sql, /obsolete/i);
  assert.match(
    sql,
    /UserPointAccount[\s\S]{0,80}authoritative|authoritative[\s\S]{0,80}UserPointAccount/i,
  );
  assert.match(sql, /PointTransaction/);
  assert.match(sql, /reconciliation|pre-migration-checks/i);
  assert.match(sql, /no active code path reads or writes/i);
  assert.match(sql, /preserved/i);
});

test("prisma/schema.prisma no longer declares User.points", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const userModelMatch = schema.match(/model User \{[\s\S]*?\n\}/);
  assert.ok(userModelMatch, "expected to find the User model block");
  assert.doesNotMatch(userModelMatch![0], /\bpoints\s+Int\b/);
});
