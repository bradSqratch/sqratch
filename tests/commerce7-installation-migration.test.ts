import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

const MIGRATIONS_DIR = join(root, "prisma/migrations");
const MIGRATION_NAME = "add_commerce_provider_installation_and_link_intent";

function findMigrationDir(): string {
  const match = readdirSync(MIGRATIONS_DIR).find((entry) =>
    entry.endsWith(MIGRATION_NAME),
  );
  assert.ok(match, `no migration directory ending in "${MIGRATION_NAME}" found`);
  return match!;
}

const migrationDirName = findMigrationDir();
const migration = readFileSync(
  join(MIGRATIONS_DIR, migrationDirName, "migration.sql"),
  "utf8",
);
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");

test("Phase 16B migration is the most recently timestamped migration directory", () => {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry !== "migration_lock.toml")
    .sort();

  assert.equal(
    entries[entries.length - 1],
    migrationDirName,
    "the Phase 16B migration must sort after every other migration directory " +
      "(an unapplied migration must never be timestamped before an already-" +
      "deployed one)",
  );

  const timestamp = migrationDirName.slice(0, 14);
  assert.match(timestamp, /^\d{14}$/, "migration directory must start with a 14-digit timestamp");

  for (const entry of entries) {
    if (entry === migrationDirName) continue;
    const otherTimestamp = entry.slice(0, 14);
    assert.ok(
      /^\d{14}$/.test(otherTimestamp) ? timestamp > otherTimestamp : true,
      `Phase 16B migration (${timestamp}) must sort after ${entry}`,
    );
  }
});

test("Phase 16B migration is additive only: no ALTER of an existing table, no DROP, no DML", () => {
  // Every existing table this migration must never touch.
  const protectedTables = [
    "PointTransaction",
    "UserPointAccount",
    "CommerceConnection",
    "CommerceConnectionEvent",
    "CommerceConnectionSecret",
    "Brand",
    "BrandRewardOffer",
    "ShopifyRewardRedemption",
  ];

  for (const table of protectedTables) {
    assert.doesNotMatch(
      migration,
      new RegExp(`ALTER TABLE\\s+"${table}"`),
      `must not ALTER the pre-existing table ${table}`,
    );
  }

  // No destructive or data-mutating statement anywhere in the file.
  assert.doesNotMatch(
    migration,
    /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bDROP\s+TYPE\b|\bTRUNCATE\b/i,
    "must contain no DROP of any kind",
  );
  assert.doesNotMatch(
    migration,
    /\bINSERT\s+INTO\b|\bUPDATE\s+"|\bDELETE\s+FROM\b/i,
    "must contain no DML — this migration is schema-only",
  );

  // The only ALTER TABLE permitted is the new table's own foreign key.
  const alterStatements = migration.match(/^ALTER TABLE[^;]*;/gim) ?? [];
  for (const statement of alterStatements) {
    assert.match(
      statement,
      /^ALTER TABLE "CommerceConnectionLinkIntent"/,
      `unexpected ALTER TABLE statement: ${statement}`,
    );
  }

  // Exactly the two new tables and the one new enum are created. Anchored to
  // the start of a line (not just anywhere in the file) so a mention inside
  // the header comment's prose can never be miscounted as a statement.
  assert.match(migration, /^CREATE TYPE "CommerceInstallationStatus"/m);
  assert.match(migration, /^CREATE TABLE "CommerceProviderInstallation"/m);
  assert.match(migration, /^CREATE TABLE "CommerceConnectionLinkIntent"/m);
  const createTableCount = (migration.match(/^CREATE TABLE/gm) ?? []).length;
  assert.equal(createTableCount, 2, "exactly two new tables");

  // CommerceProviderInstallation carries no brandId — ownership authority
  // must remain solely on CommerceConnection.
  const installationTableMatch = migration.match(
    /CREATE TABLE "CommerceProviderInstallation" \(([\s\S]*?)\);/,
  );
  assert.ok(installationTableMatch);
  assert.doesNotMatch(installationTableMatch![1], /brandId/);

  // No credential/secret column on either new table.
  for (const tableName of ["CommerceProviderInstallation", "CommerceConnectionLinkIntent"]) {
    const tableMatch = migration.match(
      new RegExp(`CREATE TABLE "${tableName}" \\(([\\s\\S]*?)\\);`),
    );
    assert.ok(tableMatch);
    assert.doesNotMatch(
      tableMatch![1],
      /secret|token"|credential|password/i,
      `${tableName} must store no credential material (only a token HASH is permitted, and it is named tokenHash)`,
    );
  }
});

test("Phase 16B schema: CommerceProviderInstallation has no brandId; CommerceConnectionLinkIntent stores no raw token", () => {
  const installationModel =
    schema.match(/model CommerceProviderInstallation \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(installationModel, "model CommerceProviderInstallation not found");
  assert.doesNotMatch(installationModel, /^\s+brandId\s+String/m);
  assert.match(installationModel, /^\s+provider\s+CommerceProvider/m);
  assert.match(installationModel, /^\s+externalAccountId\s+String/m);
  assert.match(installationModel, /@@unique\(\[provider, externalAccountId\]\)/);

  const intentModel =
    schema.match(/model CommerceConnectionLinkIntent \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(intentModel, "model CommerceConnectionLinkIntent not found");
  assert.match(intentModel, /^\s+tokenHash\s+String\s+@unique/m);
  assert.doesNotMatch(
    intentModel,
    /^\s+(rawToken|token|accountToken)\s+String/m,
    "no raw-token-shaped column may exist on the link intent model",
  );
});
