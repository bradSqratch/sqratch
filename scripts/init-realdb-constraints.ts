import { readFileSync } from "node:fs";
import { Client } from "pg";
import { disposableTestDbDecision } from "../src/lib/disposable-test-db";

// This is only for an empty, freshly created local test cluster after `prisma db push`.
const connectionString = process.env.DATABASE_URL ?? "";
const decision = disposableTestDbDecision({ connectionString, allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS });
if (!decision.allowed || process.env.INIT_EMPTY_TEST_DATABASE !== "true") {
  throw new Error("Refusing initialization: an explicitly opted-in, empty loopback _test database is required.");
}

// Copy no SQL by hand: take the current final definitions directly from their migrations.
function statement(file: string, prefix: string): string {
  const contents = readFileSync(`prisma/migrations/${file}/migration.sql`, "utf8");
  const start = contents.indexOf(prefix);
  if (start < 0) throw new Error(`Required statement missing: ${prefix}`);
  const end = contents.indexOf(";", start);
  if (end < 0 || contents.indexOf(prefix, end) >= 0) throw new Error(`Ambiguous statement: ${prefix}`);
  return contents.slice(start, end + 1);
}
const sql = [
  statement("20260615113320_campaign_unlock_anon_unique", 'CREATE UNIQUE INDEX "CampaignUnlock_campaignId_anonKey_key"'),
  statement("20260806130000_commerce_connection_single_primary", 'CREATE UNIQUE INDEX "CommerceConnection_brandId_provider_primary_key"'),
  ...["reward_c7_offer_connection", "reward_c7_claim_connection"].map((name) => statement("20261008010000_commerce7_rewards", `ALTER TABLE "${name === "reward_c7_offer_connection" ? "BrandRewardOffer" : "ShopifyRewardRedemption"}" ADD CONSTRAINT "${name}"`)),
  ...[
    ["ShopifyRewardRedemption", "reward_c7_membership_owner"],
    ["ShopifyRewardRedemption", "reward_c7_membership_write"],
    ["ShopifyRewardRedemption", "reward_c7_release_safe"],
    ["BrandRewardOffer", "reward_c7_offer_limits"],
    ["BrandRewardOffer", "brand_reward_offer_discount_check"],
    ["ShopifyRewardRedemption", "shopify_reward_redemption_discount_check"],
  ].map(([table, name]) => statement("20261009010000_commerce7_exclusive_access", `ALTER TABLE "${table}" ADD CONSTRAINT "${name}"`)),
];

async function main() {
  const client = new Client({ connectionString, ssl: process.env.PG_SSL_REJECT_UNAUTHORIZED === "false" ? { rejectUnauthorized: false } : { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Refuse any populated public table; do not change data or existing constraints.
    await client.query(`DO $$ DECLARE item record; populated boolean; BEGIN
      FOR item IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', item.schemaname, item.tablename) INTO populated;
        IF populated THEN RAISE EXCEPTION 'Disposable test database is not empty'; END IF;
      END LOOP;
    END $$`);
    for (const query of sql) await client.query(query);
    await client.query("COMMIT");
    console.log(`Installed ${sql.length} migration-defined test constraints and indexes.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
void main().catch((error: unknown) => { console.error("Disposable test constraint initialization failed:", error instanceof Error ? error.message : "unknown error"); process.exitCode = 1; });
