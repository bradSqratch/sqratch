import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { disposableTestDbDecision } from "../src/lib/disposable-test-db";

// Validate before importing Prisma, reading dotenv, or launching any test.
const connectionString = process.env.DATABASE_URL ?? "";
const decision = disposableTestDbDecision({ connectionString, allowRealDatabaseTestsEnv: "true" });
if (!decision.allowed) {
  console.error("Refusing real-database tests: DATABASE_URL must explicitly identify a disposable loopback PostgreSQL database ending in _test.");
  process.exit(1);
}
const flags = [
  "POINT_ACCOUNT_CONCURRENCY", "COMMERCE_CONNECTION_LOCK", "PUBLIC_SHOP_PAGINATION_REAL_DB",
  "COMMERCE7_REWARDS_REAL_DB", "COMMERCE7_CONNECTION_LIFECYCLE", "COMMERCE7_ORDER_RECONCILIATION",
  "QR_LIFECYCLE_REAL_DB", "ADMIN_INTEGRITY_REAL_DB", "LESSON_INTEGRITY_REAL_DB",
];
const files = readdirSync("tests").filter((name) => name.includes("real-db") && name.endsWith(".test.ts"))
  .map((name) => `tests/${name}`);
files.push("tests/point-account-concurrency.test.ts", "tests/commerce-connection-lock.test.ts");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test", DATABASE_URL: connectionString, DIRECT_URL: connectionString,
    ALLOW_REAL_DATABASE_TESTS: "true", ...Object.fromEntries(flags.map((flag) => [flag, "true"])) },
});
if (result.error) console.error("Unable to start real-database tests.");
process.exit(result.status ?? 1);
