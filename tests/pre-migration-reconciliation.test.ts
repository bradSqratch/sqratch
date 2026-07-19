import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Regression coverage for a safety correction to the User.points removal:
// production reconciliation for users missing a UserPointAccount must run
// BEFORE Stage A (deploying the ledger-only self-healing code), not merely
// before Stage B (dropping the column). Stage A changes how a missing
// account is initialized — from seeding off User.points to deriving purely
// from PointTransaction history — so a user whose legacy value disagreed
// with their ledger sum would see their balance change the instant Stage A
// ships, independent of when the column is actually dropped.
// ---------------------------------------------------------------------------

function readSource(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const SQL_PATH = "prisma/pre-migration-checks-remove-user-points.sql";

function stripSqlComments(sql: string) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

test("the pre-migration SQL contains the missing-account legacy-versus-ledger comparison", () => {
  const sql = readSource(SQL_PATH);

  // Query 3: full-context missing-account view (legacy points, transaction
  // count, ledger sum, difference).
  assert.match(sql, /transaction_count/);
  assert.match(sql, /ledger_sum/);
  assert.match(sql, /AS difference/);
});

test("the anomaly query checks users with no UserPointAccount", () => {
  const sql = readSource(SQL_PATH);

  const blockingQueryMatch = sql.match(
    /-- 4\. \[BLOCKING[\s\S]*?ORDER BY ABS\(u\."points" - COALESCE\(l\.ledger_sum, 0\)\) DESC;/,
  );
  assert.ok(blockingQueryMatch, "expected to find the blocking missing-account anomaly query");
  const blockingQuery = blockingQueryMatch![0];

  assert.match(blockingQuery, /LEFT JOIN "UserPointAccount" a\s*\n\s*ON a\."userId" = u\."id"/);
  assert.match(blockingQuery, /a\."userId" IS NULL/);
});

test("the anomaly query compares User.points with COALESCE(SUM(PointTransaction.points), 0)", () => {
  const sql = readSource(SQL_PATH);

  const blockingQueryMatch = sql.match(
    /WITH ledger AS \(\s*SELECT\s*"userId",\s*COUNT\(\*\) AS transaction_count,\s*COALESCE\(SUM\("points"\), 0\) AS ledger_sum\s*FROM "PointTransaction"\s*GROUP BY "userId"\s*\)[\s\S]*?ORDER BY ABS\(u\."points" - COALESCE\(l\.ledger_sum, 0\)\) DESC;/,
  );
  assert.ok(
    blockingQueryMatch,
    "expected the exact ledger CTE (COUNT + COALESCE(SUM(...),0)) feeding the blocking query",
  );
  const blockingQuery = blockingQueryMatch![0];

  assert.match(blockingQuery, /u\."points" <> COALESCE\(l\.ledger_sum, 0\)/);
  assert.match(blockingQuery, /u\."points" - COALESCE\(l\.ledger_sum, 0\) AS difference/);
});

test("a separate informational query covers missing-account users whose legacy value matches the ledger sum (or has no history)", () => {
  const sql = readSource(SQL_PATH);

  assert.match(sql, /5\. \[Informational — safe\] Missing-account users whose legacy points already/);
  assert.match(sql, /u\."points" = COALESCE\(l\.ledger_sum, 0\)/);
});

test("the pre-migration SQL contains only SELECT/CTE statements — no UPDATE, DELETE, INSERT, ALTER, DROP, TRUNCATE, or CREATE", () => {
  const sql = readSource(SQL_PATH);
  const executable = stripSqlComments(sql);

  for (const forbidden of ["UPDATE", "DELETE", "INSERT", "ALTER", "DROP", "TRUNCATE", "CREATE"]) {
    assert.doesNotMatch(
      executable,
      new RegExp(`\\b${forbidden}\\b`, "i"),
      `pre-migration SQL must not contain ${forbidden}`,
    );
  }

  // Every non-comment, non-blank line must belong to a SELECT/CTE/JOIN/WHERE/
  // etc. read-only vocabulary — spot-check the file opens only with SELECT
  // or WITH statements.
  const statements = executable
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    assert.match(statement, /^(SELECT|WITH)\b/i, `unexpected non-read statement: ${statement.slice(0, 60)}`);
  }
});

test("deployment documentation records that reconciliation was required before Stage A, not merely before Stage B", () => {
  const doc = readSource("docs/points-ledger.md");

  assert.match(doc, /Pre-Stage-A/);
  assert.match(doc, /\*\*Stage A\*\*/);
  assert.match(doc, /\*\*Stage B\*\*/);
  // The core safety claim, preserved as historical record now that the
  // migration is complete: Stage A itself (not just Stage B) was gated on
  // reconciliation, because self-healing changed at Stage A.
  assert.match(
    doc,
    /Reconciliation was required \*\*before Stage A\*\*, not merely before Stage B/,
  );
  assert.match(doc, /query 4 — \*\*blocking\*\*/);
});

test("the pre-migration SQL file itself documents the two-gate (pre-Stage-A / pre-Stage-B) requirement", () => {
  const sql = readSource(SQL_PATH);

  assert.match(sql, /GATE 1 — BEFORE STAGE A/);
  assert.match(sql, /GATE 2 — BEFORE STAGE B/);
  assert.match(sql, /MUST be run and every discrepancy MUST\s*\n?--\s*be resolved.*before\s*\n?--\s*Stage A is deployed/);
});

test("the migration's executable SQL remains exactly the single column drop", () => {
  const sql = readSource(
    "prisma/migrations/20260719061157_remove_legacy_user_points/migration.sql",
  );
  const executable = stripSqlComments(sql).trim();

  assert.equal(executable, `ALTER TABLE "User" DROP COLUMN "points";`);
});

test("the migration comments state reconciliation must occur before Stage A and be re-run before Stage B", () => {
  const sql = readSource(
    "prisma/migrations/20260719061157_remove_legacy_user_points/migration.sql",
  );

  assert.match(sql, /GATE 1 \(before deploying the ledger-only missing-account self-healing/);
  assert.match(sql, /before Stage A/);
  assert.match(sql, /GATE 2 \(before applying this migration, i\.e\. before Stage B\)/);
  assert.match(sql, /executable SQL below is, and must remain, exactly one statement/);
});
