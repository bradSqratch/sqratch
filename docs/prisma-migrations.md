# Prisma Migration Runbook

Do not run `migrate dev` against production.

## How to determine migration status (read this before trusting any table below)

Local migration folders under `prisma/migrations/` are **immutable historical records** of what has been authored — they are not, by themselves, evidence of what has been applied to any particular database. This repository has had **historical divergence between local migration folders and the production `_prisma_migrations` table** before (see "Historical divergence" below), and migrations can in principle reach a database by paths other than a plain sequential `migrate deploy` (e.g. `migrate resolve` marking a migration as applied without running it, or a manually-applied equivalent SQL change) — so do **not** infer that every earlier local migration was applied merely because a later one was confirmed applied. A later migration being live does not by itself prove every predecessor ran the way its folder describes.

Before relying on migration state for anything (writing a new migration, planning a deploy, debugging a schema mismatch), explicitly verify it:

```bash
npx prisma migrate status   # compares _prisma_migrations against local migration folders
npx prisma migrate diff \
  --from-config-datasource prisma.config.ts \
  --to-schema prisma/schema.prisma \
  --script                    # compares live schema against schema.prisma; empty output = no drift
```

Never repair migration history casually (e.g. `migrate resolve --applied` to make a discrepancy go away) without first understanding *why* local history and the database disagree — see "Historical divergence" below.

## Verified production state

**Every migration currently represented by a local migration folder, through `20260719061157_remove_legacy_user_points`, has been applied to production.** This was independently verified, not assumed:

- **Before** the `20260719061157_remove_legacy_user_points` deployment, `npx prisma migrate status` identified that migration as the *only* local migration not yet applied to production — i.e. every other local migration folder (the full hardening set and everything authored after it, through `20260718120000_shopify_store_reward_compatibility`) was already confirmed applied at that point.
- `20260719061157_remove_legacy_user_points` was then applied on 2026-07-19.
- **After** deployment, `npx prisma migrate status` reported the production schema up to date.
- `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` returned an empty migration (no drift between the live database and `prisma/schema.prisma`).
- The `User.points` column no longer exists in the production database.
- `UserPointAccount` and `PointTransaction` row/column data were confirmed unchanged by the migration (it is a single `ALTER TABLE ... DROP COLUMN`).

See `docs/points-ledger.md` for the full reconciliation record and deployment procedure that preceded the last migration. For any migration authored *after* `20260719061157_remove_legacy_user_points`, run the verification commands above rather than relying on this document's age.

## Historical divergence

Production's `_prisma_migrations` table also contains migration records that have **no corresponding local folder in this repository** — additional historical entries predating what this checkout's `prisma/migrations/` directory represents. This is the migration-history divergence for this repository: not missing/unapplied local migrations (see "Verified production state" above — there are none, as of 2026-07-19), but production carrying history the repository does not.

**This must not be casually repaired or reconstructed.** Do not fabricate local migration folders to "backfill" those unrepresented production records, do not delete or edit rows in production's `_prisma_migrations` table, and do not assume the missing folders are safe to ignore. Whenever local migration folders and production's tracking table disagree in either direction, verify explicitly before taking any action: compare `_prisma_migrations` directly, compare `migrate status` / `migrate diff` output, and (if genuinely uncertain) inspect `information_schema` for the schema objects a given record would have created.

## Hardening migrations (confirmed applied — see "Verified production state" above)

The four migrations below were confirmed applied to production by the `prisma migrate status` check that preceded the `20260719061157_remove_legacy_user_points` deployment (see above). If depending on this for a change today, re-run the verification commands to confirm nothing has changed since.

1. `20260615113320_campaign_unlock_anon_unique`: additive partial unique index. Preflight duplicate anonymous unlocks; index creation can briefly lock writes.
2. `20260615120000_shopify_expiring_tokens`: additive enum value, enum type, and token lifecycle columns, including refresh lease ownership. Enum additions are not trivially reversible.
3. `20260615140000_redemption_reconciliation`: additive reconciliation columns/index plus an exactly-once point-ledger unique index. Preflight duplicate `(shopifyRewardRedemptionId, reason)` rows.
4. `20260615150000_evidence_based_indexes`: additive query indexes. Check `pg_indexes` for equivalent indexes first.

## Preflight

```sql
SELECT "campaignId", "anonKey", count(*)
FROM "CampaignUnlock"
WHERE "anonKey" IS NOT NULL AND "userId" IS NULL
GROUP BY 1, 2 HAVING count(*) > 1;

SELECT "shopifyRewardRedemptionId", "reason", count(*)
FROM "PointTransaction"
WHERE "shopifyRewardRedemptionId" IS NOT NULL
GROUP BY 1, 2 HAVING count(*) > 1;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('CampaignUnlock','ShopifyRewardRedemption','PointTransaction','EmailVerificationToken','TokenStore');
```

Also inspect `information_schema.columns` and `pg_type` for equivalent manually created token/reconciliation fields and enums.

## Migrations authored after the hardening set (confirmed applied — see "Verified production state" above)

The local migrations `20260716120000_harden_auth_sessions_and_verification`, `20260716130000_remove_external_role`, `20260716131000_verified_user_welcome_queue`, `20260717140000_welcome_email_worker_retries`, and `20260718120000_shopify_store_reward_compatibility` all predate `20260719061157_remove_legacy_user_points` in the local migration order, and were confirmed applied to production by the same pre-deployment `prisma migrate status` check described above (which identified `20260719061157_remove_legacy_user_points` as the only local migration not yet applied at that time). If depending on this for a change today, re-run `npx prisma migrate status` to confirm nothing has changed since this was last checked.

For `20260716130000_remove_external_role`: this migration confirms no users retain the retired role, aborting if one appears, before replacing the PostgreSQL `Role` enum without changing users. The welcome-queue migration removes only `trg_enqueue_welcome_email` and `enqueue_welcome_email()`, adds the verification challenge eligibility marker and `SKIPPED` queue status, and intentionally leaves the separate Make.com user-insert trigger unchanged.

`20260717140000_welcome_email_worker_retries` is additive only: nullable retry-scheduling and claim timestamps plus worker-selection indexes. Existing `PENDING` jobs remain immediately eligible, while `SENT`, `SKIPPED`, `FAILED`, and `SENDING` rows are not rewritten by the migration.

`20260716120000_harden_auth_sessions_and_verification` required `EMAIL_VERIFICATION_CODE_PEPPER` to be configured and the legacy challenge invalidation effect reviewed before it was applied; both apply to any other environment this migration is deployed to that has not yet had it applied.

The production-only `Make com ` trigger was reported as an `AFTER INSERT` trigger on `User` that calls an external Make.com webhook. Its function body is not version-controlled in this repository, so it cannot be inspected without querying the remote database. It is separate from `trg_enqueue_welcome_email` and is deliberately not modified by any migration in this repository.

## Commerce connection abstraction

`20260806120000_add_commerce_connection_abstraction`: additive only. Adds two new enums (`CommerceProvider`: `SHOPIFY`/`COMMERCE7`; `CommerceConnectionStatus`: `PENDING`/`CONNECTED`/`REQUIRES_RECONNECT`/`DISCONNECTED`/`UNINSTALLED`/`ERROR`) and two new tables (`CommerceConnection`, `CommerceConnectionSecret`) with their indexes and foreign keys. It is a provider-neutral connection model intended to eventually sit alongside — and later replace the runtime use of — the 16 Shopify-specific columns on `Brand` (`shopifyShopDomain`, `shopifyConnectionStatus`, `shopifyAuthMode`, etc.) and the existing `ShopifyConnectionStatus` enum, none of which this migration touches, modifies, or reads. `CommerceConnectionSecret` stores one encrypted JSON blob per connection (`encryptedPayload`, versioned via `keyVersion`) rather than individual token columns. This migration does not backfill any rows from the existing `Brand` Shopify columns into the new tables — that dual-write/backfill is out of scope for this change and is left to a later migration. `CommerceConnection` intentionally has no `@@unique([brandId, provider])` (a brand may have multiple stores per provider) but does carry `@@unique([provider, externalAccountId])`, mirroring the existing global uniqueness of `Brand.shopifyShopDomain`. Enforcement of "at most one primary connection per brand" is left to application logic, not a database constraint (no partial unique index was added for `isPrimary` on `CommerceConnection`) — **superseded** by `20260806130000_commerce_connection_single_primary` below, which adds that database constraint.

Rollback limitations: dropping `CommerceConnectionSecret` and `CommerceConnection` is possible while both tables are empty, but the `CommerceProvider` and `CommerceConnectionStatus` Postgres enum types cannot be trivially removed once any column depends on them (`CommerceConnection.provider` is `NOT NULL` typed as `CommerceProvider` with no default, and `CommerceConnection.status` is typed as `CommerceConnectionStatus` with a `DEFAULT` clause — Postgres refuses to drop an enum type while any column, defaulted or not, is still typed as that enum), and removing/renaming an already-shipped enum value is not reversible in place. If a later migration dual-writes into these tables before this one is rolled back, rolling back loses those rows permanently — rollback here is a data-loss operation once real connection rows exist, not just a schema change.

## Commerce connection single-primary enforcement

`20260806130000_commerce_connection_single_primary`: additive only. Adds a single partial unique index, `CommerceConnection_brandId_provider_primary_key`, on `CommerceConnection("brandId", "provider") WHERE "isPrimary" = true`, enforcing "at most one primary connection per (brandId, provider)" directly in Postgres. It touches no existing table, column, row, or enum. `CommerceConnection` intentionally still has no plain `@@unique([brandId, provider])` (a brand may hold multiple stores per provider) — this index only constrains the subset of rows where `isPrimary = true`.

Prisma cannot express partial unique indexes in `schema.prisma`, so this index is **DB-only, intentional schema/DB drift** — the same pattern already established by `20260615113320_campaign_unlock_anon_unique`'s `CampaignUnlock_campaignId_anonKey_key` index. Do not "fix" this by adding `@@unique([brandId, provider, isPrimary])` to `schema.prisma`: that would be a non-partial unique across every row (not just `isPrimary: true` ones) and would incorrectly forbid a brand from holding more than one CONNECTED-but-non-primary connection for the same provider, breaking multi-store support. Because of this drift, `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` and `npx prisma migrate status` will report this index as present in the database but absent from the schema on every future run — that is expected, not a sign of a missed migration or a schema out of sync; do not attempt to reconcile it by dropping the index or by adding the non-partial unique above.

Preflight (run before applying and confirm zero rows; see the migration file for the full duplicate-resolution procedure if it returns any):

```sql
SELECT "brandId", "provider", count(*)
FROM "CommerceConnection"
WHERE "isPrimary" = true
GROUP BY 1, 2
HAVING count(*) > 1;
```

If it returns rows, keep the row `pickPreferredConnectionRow` (in `src/lib/commerce/connection-resolver.ts`) would choose for that `(brandId, provider)` group — `isPrimary` first (moot within an already-primary-only group), then most recent `installedAt`, then most recent `createdAt` — clear `isPrimary` on every other row in the group (never delete), and re-run the preflight until it returns zero rows.

This migration is paired with an application-logic hardening in `src/lib/commerce/connection-sync.ts`: `applyShopifyConnectionSync` now clears `isPrimary` on a brand's other connections for a provider *before* upserting the target row's `isPrimary` value (previously the other order), so a single-writer sync can never itself transiently violate the index; and `syncShopifyCommerceConnectionForBrand` wraps the whole transaction in a bounded retry (3 attempts) that catches the P2002 (unique-violation) or P2034 (serialization failure) a genuine cross-transaction race produces and re-runs on a fresh read, which converges because the retry's `count()` sees whichever side of the race already committed.

Rollback: `DROP INDEX "CommerceConnection_brandId_provider_primary_key";` — non-destructive, unlike the Phase-1 table-creating migration above. Dropping a unique index never deletes rows or column data, only the constraint.

## Commerce product catalog

`20260806140000_add_commerce_product_catalog`: additive and forward-only. Adds one new enum (`CommerceProductSyncRunStatus`: `RUNNING`/`SUCCEEDED`/`PARTIAL`/`FAILED`) and three new tables — `ConnectedCommerceProduct` (the mirrored merchant catalog, one row per product per connection), `CommerceProductSyncRun` (one row per catalog sync attempt, for observability and partial-failure diagnosis), and `BrandCommerceProduct` (brand-side curation: shop visibility, campaign eligibility, display order, title/description/image overrides, approval record) — with their indexes and foreign keys. It contains only `CREATE TYPE`/`CREATE TABLE`/`CREATE INDEX`/`CREATE UNIQUE INDEX`/`ALTER TABLE ... ADD CONSTRAINT`: no `DROP`, no `ALTER COLUMN`, no `UPDATE`/`DELETE`/`TRUNCATE`. It touches no existing table, column, row, index or enum, and does not read or backfill from the 16 `Brand.shopify*` columns, `ExperienceProductLink`, `LessonProductLink`, `BrandRewardOffer`, `ShopifyRewardRedemption`, `CommerceConnection` or `CommerceConnectionSecret`.

The core constraint is `ConnectedCommerceProduct_connectionId_externalKey_key` — `UNIQUE ("connectionId", "externalKey")`, **connection-scoped, not global**. `externalKey` is a stable provider-scoped key (for Shopify, the product gid). Provider product ids are unique only *within* a store, so two different `CommerceConnection` rows can legitimately carry the same gid for two unrelated products; a global unique on `externalKey` or `externalId` would make the second store's sync collide with the first store's catalog and silently cross-link two merchants' products. Do not add one. `brandId` is denormalized onto `ConnectedCommerceProduct` and `CommerceProductSyncRun` deliberately (it is derivable through `connectionId`) so the brand authorization filter is a single indexed predicate with no join. Prices are stored exclusively as integer minor units (`priceMinMinor`, `priceMaxMinor`, `priceMinorUnitExponent`); no float/decimal price column exists or may be added. `currencyCode` is nullable with no default on purpose — the current product pipeline has a real currency defaulting bug, and a null ("currency unknown, do not render a price") is recoverable where a wrongly persisted currency is not. `CommerceProductSyncRun.failureSummary` holds sanitized text only — never a raw error object, URL, token, or response body. `BrandCommerceProduct.approvedByUserId` is a plain nullable `String`, not a foreign key to `User`, so deleting a user cannot cascade into brand curation (same pattern as `PointTransaction.createdById`).

Cascade behaviour is intentional: every foreign key is `ON DELETE CASCADE`. Shopify's `shop/redact` hard-deletes the `CommerceConnection` row, and cascading the catalog away on that deletion is correct — a GDPR erasure must not leave a full product mirror of the erased shop behind. `BrandCommerceProduct` cascades too, which loses brand curation; that loss is accepted because the curation is unrenderable without its products and its override fields are themselves derived from the merchant data being erased. `app/uninstalled` does **not** delete the connection (status becomes `UNINSTALLED`, row preserved), so the catalog correctly survives an uninstall/relink cycle and is erased only on genuine redaction.

Preflight: this migration foreign-keys to `CommerceConnection`, so it **fails outright** (Postgres `42P01`, relation does not exist) if `20260806120000_add_commerce_connection_abstraction` has not been applied. Confirm before running — and per "How to determine migration status" above, do not trust the tracking table alone; check the objects exist too:

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE migration_name = '20260806120000_add_commerce_connection_abstraction';

SELECT to_regclass('public."CommerceConnection"') IS NOT NULL AS has_table,
       EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommerceProvider') AS has_provider_enum;

SELECT typname FROM pg_type WHERE typname = 'CommerceProductSyncRunStatus';
```

Expect the first query to return one row with a non-null `finished_at` and null `rolled_back_at`, the second to return both columns true, and the third to return zero rows. If the first or second fails, stop and apply `20260806120000_add_commerce_connection_abstraction` first — do not hand-create the missing table. A row from the third means a partial or manual application already happened and must be understood before proceeding.

Expected drift: `npx prisma migrate diff` and `npx prisma migrate status` will **continue** to report the two pre-existing DB-only partial unique indexes — `CommerceConnection_brandId_provider_primary_key` and `CampaignUnlock_campaignId_anonKey_key` — as drift after this migration is applied, exactly as they did before it. Prisma cannot express partial unique indexes, so that drift is intentional and permanent. It must not be "cleaned up" (do not drop either index, do not add a non-partial `@@unique` to `schema.prisma`), and it must not be read as evidence that this migration is missing or was not applied. This migration adds no new drift of its own. No `CONCURRENTLY` is used: `migrate deploy` wraps each file in a transaction, and these are brand-new empty tables where plain index creation is instant.

Rollback limitations: drop children before parents — `BrandCommerceProduct`, then `CommerceProductSyncRun`, then `ConnectedCommerceProduct`, then `DROP TYPE "CommerceProductSyncRunStatus"`. Two caveats. (a) Dropping `BrandCommerceProduct` **destroys brand curation that cannot be re-derived from any provider**: visibility, campaign eligibility, ordering, overrides and approval are first-party data entered by brand staff, and no re-sync reconstructs them (`ConnectedCommerceProduct` and `CommerceProductSyncRun`, by contrast, are a re-derivable mirror and log). Export curation rows before dropping if any exist. (b) The `CommerceProductSyncRunStatus` enum type cannot be dropped while any column of that type still exists — including one that merely has a `DEFAULT` of it, as `CommerceProductSyncRun.status` does — so `DROP TYPE` must come strictly after the `DROP TABLE`s; and once shipped, an individual enum value cannot be removed in place, requiring a replacement type and a rewrite of every dependent column.

## Connected product storefront availability

`20260808120000_add_connected_product_storefront_availability`: additive and forward-only. Adds exactly one column, `ConnectedCommerceProduct.hasPublicStorefrontUrl BOOLEAN NOT NULL DEFAULT false`. It contains no `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, `ALTER COLUMN`, type change, or renamed object; no existing column, index, or constraint is modified, so every existing row keeps every value it already had. No new index is added, on purpose: the existing `ConnectedCommerceProduct_brandId_isAvailable_idx` and `ConnectedCommerceProduct_connectionId_isAvailable_idx` keep serving the render/click gates, since adding this column extends their *predicate* rather than the shape of the rows they select.

Why the column exists: Shopify's `Product.onlineStoreUrl` is null when a product has no publicly reachable storefront URL (unpublished from the Online Store sales channel, or a password-protected storefront). The normalizer collapsed that signal with `productUrl: product.onlineStoreUrl || 'https://<shop>/products/<handle>'`, which **fabricates a URL that 404s**, and the sync then persisted that fabricated URL with `isAvailable: true` (`isAvailable` encodes Shopify `status === ACTIVE`, which is orthogonal to publication). The click route's destination validator cannot catch this either — it checks that the destination hostname equals the brand's expected shop domain, and the fabricated URL uses exactly that host. This column captures the signal that was being destroyed: the fact that the provider handed us a real storefront URL, evaluated *before* the `||` fallback. It is deliberately not named `isPublished` (a password-protected store means a product can be genuinely published and still unreachable) and is deliberately separate from `isAvailable`; neither may be derived from or substituted for the other, and a public clickable destination requires **both**.

Preflight: confirm `to_regclass('public."ConnectedCommerceProduct"') IS NOT NULL`; confirm the column is not already present from a manual partial application (`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ConnectedCommerceProduct' AND column_name = 'hasPublicStorefrontUrl'` must return zero rows); and confirm `20260806140000_add_commerce_product_catalog` is applied with a non-null `finished_at` and null `rolled_back_at`.

Locking: PostgreSQL 11+ adds a `NOT NULL` column with a non-volatile `DEFAULT` without rewriting the table, so the `ACCESS EXCLUSIVE` lock is held only briefly for the catalog update. No backfill statement is needed or included.

**Mandatory post-deploy step**: every already-synced row gets `false`, i.e. is treated as having no public storefront destination. The code shipped with *this* migration alone only writes the column, but the read gates land in `20260808130000`'s change set (see below), after which nothing renders or is clickable until each brand re-runs a product sync. Plan the resync for every connected brand before deploying either migration.

Rollback: dropping this column is lossless only in the sense that its values are recomputable by a full product resync — it carries no history that cannot be re-derived from the provider. There is deliberately no automatic rollback SQL, because dropping a column that shipped code reads is a manual, deliberate operation.

## Legacy product-link snapshot removal (DESTRUCTIVE)

`20260808130000_remove_legacy_product_link_snapshots`: **the only destructive migration in this repository, and the only one that drops a table.** Read its file header in full before deploying it. It drops exactly six objects — four `DROP COLUMN` and two `DROP TABLE`:

| Object | Kind |
|---|---|
| `CommerceClickAttribution.lessonProductLinkId` | `DROP COLUMN` |
| `CommerceClickAttribution.experienceProductLinkId` | `DROP COLUMN` |
| `CampaignLessonProduct.legacyLessonProductLinkId` | `DROP COLUMN` (takes its unique index and `SET NULL` FK) |
| `LessonProductLink` | `DROP TABLE` |
| `ExperienceProductLink` | `DROP TABLE` |
| `Campaign.commerceProductCurationEnabled` | `DROP COLUMN` |

It contains **no** `DELETE`, `TRUNCATE`, `UPDATE`, `ALTER COLUMN`, or `CASCADE`. `ALTER TABLE ... DROP COLUMN` removes a column, never a tuple, so no row is deleted from any surviving table: `Campaign`, `CampaignLessonProduct`, `CommerceClickAttribution`, `Brand`, `Experience`, `Course`, `Lesson`, `User`, `QRCode`, `QRCodeBatch`, `CampaignUnlock`, `PointTransaction`, `UserPointAccount`, `ShopifyRewardRedemption`, `BrandRewardOffer`, `BrandRewardOfferProduct`, `CommerceConnection`, `CommerceConnectionSecret`, `ConnectedCommerceProduct`, `BrandCommerceProduct`, `CampaignCommerceProduct`, `CommerceOrder`, `CommerceOrderLineItem` and `CommerceOrderEvent` all keep every row they had. The points/money path and the entire Phase 7 order set are not referenced by any statement in the file.

Statement order matters and is deliberate: all preflight blocks first, then the three `DROP COLUMN`s that remove foreign keys *referencing* the doomed tables, then the two `DROP TABLE`s, then the curation-flag `DROP COLUMN`. Dropping the referencing columns first is what lets the `DROP TABLE`s succeed **without** `CASCADE`. Both `DROP TABLE`s are plain: if an unanticipated dependency (a view, another FK, a trigger) still exists, the deploy must fail loudly and name it rather than silently dropping it as collateral. Do not add `CASCADE` or `IF EXISTS`.

Fail-closed preflight, executed by the migration itself as three `DO $$ ... RAISE EXCEPTION ... END $$;` blocks, all before any destructive statement (so an abort leaves the schema byte-for-byte unchanged):

1. `ExperienceProductLink` contains any row → abort.
2. `LessonProductLink` contains any row → abort.
3. Any **active** `CampaignLessonProduct` whose canonical chain is broken or cross-brand → abort: `brandCommerceProductId` must resolve to a `BrandCommerceProduct`, which must resolve to a `ConnectedCommerceProduct`, and **both** must have `brandId` equal to the attachment's `brandId`.

Gates 1 and 2 deliberately do **not** delete the rows they find. The operator is expected to have manually cleaned both tables; unexpected rows mean the assumption about production was wrong, and the correct response is a loud non-destructive abort, not silent data destruction inside a schema migration. Gate 3 is the load-bearing one: once the bridge column is gone, the canonical chain is the *only* way to resolve an attachment.

Gate 3 deliberately does **not** fail on `isActive = true AND "legacyLessonProductLinkId" IS NULL`. That check reads as the pre-Phase-8 invariant ("an active scoping row bridges to a snapshot") but applying it now would be backwards and would abort the deploy on correct data: the canonical creator path stopped writing the bridge, so every row created since is active with a null bridge, and the operator's deletion of all `LessonProductLink` rows fires the pre-existing `ON DELETE SET NULL` FK, nulling the bridge on survivors. A null bridge on an active row is expected and fine.

Read-only informational queries to run manually before deploying are in the migration header (they are comments, never executed). Query (5) is the one not to skip: it counts `CommerceClickAttribution` rows whose only structured product identity is `lessonProductLinkId`/`experienceProductLinkId` (both product-campaign and brand-product columns null). Those rows are **not deleted** and keep `destinationUrl`/`destinationHost`, so the click stays provable, but they no longer resolve to a product row. That is accepted evidence degradation and must be a recorded number, not a discovery. Query (4) exports the per-campaign `commerceProductCurationEnabled` values before they are gone.

**Mandatory post-deploy step, same as `20260808120000` above**: the code shipped with this migration gates both public rendering and the click/redirect path on `ConnectedCommerceProduct.hasPublicStorefrontUrl`, which currently reads `false` for every already-synced row. Public commerce is effectively down until every connected brand re-runs a product sync. Runbook: operator clears the legacy rows → `migrate deploy` → product sync for every brand → spot-check one public lesson product renders and redirects.

Rollback limitations: **irreversible, deliberately no down migration.** Re-adding `commerceProductCurationEnabled` re-defaults every campaign to `false`, so the per-campaign choice is unrecoverable once dropped (export it with informational query (4) first if it matters). The two dropped tables' row data — creator-typed, provider-unverified `productUrl`/`title`/`imageUrl`/`priceText`/`currency`/`brandId`/`sourceShopDomain` — has no canonical source to re-derive it from and is unrecoverable; in the expected case both tables are already empty, and if they are not, the preflight aborts rather than destroying anything. The dropped attribution and bridge column values are likewise unrecoverable. Restore from a database backup if any of this is needed.

Full rationale, including the canonical target data flow and the storefront-404 bug this fixes, is in `docs/commerce/phase-8-canonical-commerce-legacy-elimination-summary.md`.

## Phase 11.1 Campaign ownership and click attribution cleanup

`20260815120000_harden_campaign_brand_ownership_and_click_attribution` is a
forward-only migration that has not been applied by this repository. It first
fails closed if any `Campaign.brandId` is null, then makes that column required
and installs a trigger that rejects a change to a Campaign's Brand while
allowing metadata updates and no-op same-Brand writes. It performs no Campaign
backfill, update, or deletion.

It then removes the redundant `CommerceClickAttribution.brandId` relation and
column. `CommerceClickAttribution.attributedBrandId` is retained as the sole
durable historical Brand-attribution scalar (intentionally non-FK); rows with a
null historical value remain unknown. The `productCampaignId` foreign key is
replaced with `FOREIGN KEY ("productCampaignId") REFERENCES "Campaign"("id")
ON DELETE SET NULL`. No `CommerceClickAttribution` row is updated or deleted.

Before deploying, run these read-only checks in the controlled deployment
environment (never from application tests):

```sql
SELECT id, name, slug FROM "Campaign" WHERE "brandId" IS NULL;
SELECT conname FROM pg_constraint
WHERE conrelid = '"CommerceClickAttribution"'::regclass
  AND conname IN ('CommerceClickAttribution_brandId_fkey', 'CommerceClickAttribution_productCampaignId_brandId_fkey');
```

The first query must return zero rows. After deployment, verify the trigger and
the new foreign key with `pg_trigger`/`pg_constraint`, and confirm
`information_schema.columns` has no `CommerceClickAttribution.brandId` column.
There is no automatic rollback for the removed redundant column: restoring it
would require inventing historical attribution data.

## Phase 15C1 reward provider expansion

`20260821130000_add_reward_provider_columns` is an EXPAND-only compatibility
migration for the future provider-neutral reward cutover. It adds
`provider CommerceProvider NOT NULL DEFAULT 'SHOPIFY'` to the existing
`BrandRewardOffer` and `ShopifyRewardRedemption` tables, and adds the two
provider-aware exact-identity indexes `(brandId, provider, sourceShopDomain)`
and `(brandId, provider, shopifyShopDomain)`. Existing indexes remain.

The temporary defaults kept the deployed Shopify offer and redemption writers
compatible during expansion. Phase 15C2 writes `provider` explicitly; Phase
15C3 contracts the defaults so a future provider can never silently become
Shopify. This migration deliberately does not rename any reward table, enum,
or provider-shaped field.

It contains no DML and does not reference `PointTransaction` or
`UserPointAccount`; it cannot alter point balances, ledger history, reward
links, or account totals.

Phase 15C2 deliberately adds no migration. Prisma now exposes the logical
`CommerceRewardRedemption` and `CommerceRewardRedemptionStatus` names while
mapping them to the existing `ShopifyRewardRedemption` table and enum. Its
logical account, discount, diagnostics, offer-product, and ledger-relation
fields map to their existing Shopify-shaped columns. Phase 15C3 removed the
temporary database defaults; every writer must now explicitly provide its
`CommerceProvider` (`SHOPIFY` today, `COMMERCE7` when that writer exists).
Physical Shopify naming remains intentionally mapped rather than renamed:
renaming it provides no runtime provider-neutrality benefit and would add
migration risk.

## Phase 15C3 reward provider contract

`20260821140000_remove_reward_provider_defaults` contains only two `ALTER
COLUMN ... DROP DEFAULT` statements: one for `BrandRewardOffer.provider` and
one for physical `ShopifyRewardRedemption.provider`. It neither reads nor
rewrites reward rows, point-ledger rows, or point-account balances; it changes
only the database behavior for future omitted provider values. The migration is
forward-compatible with both the 15C2 and 15C3 runtimes because their Shopify
writers already explicitly set `provider = SHOPIFY`.

## Deployment procedure

Back up first, pause reward issuance briefly, run reviewed preflight SQL, then run `npx prisma migrate deploy` once from a controlled release job. Immediately after, run `npx prisma migrate status` and `npx prisma migrate diff` to confirm the expected state (do not assume success from the deploy command's exit code alone). Validate schema, token refresh, QR unlock deduplication, redemption/refund, and query plans afterward.

Existing migration folders under `prisma/migrations/` must never be edited after being merged — they are immutable historical records. A mistake in an already-applied migration is corrected with a new, forward-only migration, never by rewriting history.

## Rollback

Rollback is manual: indexes and additive columns can be dropped after application rollback, but enum values are not safely removed in place. Never delete point or redemption history.
