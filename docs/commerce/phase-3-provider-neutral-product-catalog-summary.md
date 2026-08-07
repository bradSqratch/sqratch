# Phase 3: Provider-Neutral Product Catalog Summary

Phase 1 (`docs/commerce/phase-1-commerce-abstraction-summary.md`) built the provider-neutral connection seam. Phase 2 (`docs/commerce/phase-2-commerce-cutover-hardening-summary.md`) cut specific runtime paths over to it and hardened the connection mirror with a reconciliation CLI and a database safety guard. Neither phase persisted a single product. Phase 3 adds the actual product catalog: a mirrored, provider-neutral `ConnectedCommerceProduct` table synced from Shopify (or, in future, Commerce7) through the existing `CommerceAdapter` seam, a brand-side curation layer (`BrandCommerceProduct`) that decides what a brand's SQRATCH Shop actually shows, an idempotent sync service with an observability trail (`CommerceProductSyncRun`), a read/selection HTTP API, a brand-facing management page, and a reconciliation CLI for the catalog itself. This document is the record of what Phase 3 actually built, verified against the code in this repository — not the plan that preceded it.

## 1. Why the catalog was introduced

Before Phase 3, "a brand's products" meant one thing: a live, uncached GraphQL call to Shopify (`fetchNormalizedShopifyProducts` in `src/lib/shopify-products.ts`) made fresh on every request that needed a product list. That has three problems Phase 3 exists to fix:

1. **No brand curation.** A brand could not choose which products appear in its SQRATCH Shop, reorder them, mark some campaign-eligible, or override a title/description/image for SQRATCH's own presentation — every consumer saw the raw, unfiltered Shopify catalog or nothing.
2. **No provider neutrality for products.** Every product-consuming code path imported `shopify-products.ts` directly, the exact pattern Phase 1/2 eliminated for connection identity and discounts. A future Commerce7 adapter would have had nowhere to plug in.
3. **No persistence, no observability.** A live-call-per-request design has no record of what a store's catalog looked like, no way to detect a product going unavailable, and no way to reconcile drift — every failure mode was invisible until a user reported it.

Phase 3 answers all three: `ConnectedCommerceProduct` is the provider-neutral mirror, `BrandCommerceProduct` is the curation layer, and `CommerceProductSyncRun` is the observability trail.

## 2. Before / after architecture

**Before (post-Phase-2):** product-consuming code paths called `fetchNormalizedShopifyProducts` directly, live, uncached, unpersisted, with no brand curation step.

**After (Phase 3):**

```
 ┌──────────┐   syncProducts()   ┌───────────────────────┐   normalize    ┌──────────────────────────┐
 │ Shopify   │ ─────────────────▶ │ ShopifyCommerceAdapter │ ─────────────▶ │  syncBrandCommerceProducts │
 │ Admin API │                    │ (providers/shopify-*)  │                │  (product-sync.ts)         │
 └──────────┘                    └───────────────────────┘                └─────────────┬─────────────┘
                                                                                          │ upsert (change-detected,
                                                                                          │ idempotent) + soft-unavailable
                                                                                          ▼
                                                                          ┌────────────────────────────────┐
                                                                          │   ConnectedCommerceProduct        │
                                                                          │   (provider-neutral mirror,        │
                                                                          │    one row per product per         │
                                                                          │    connection)                     │
                                                                          └───────────────┬────────────────────┘
                                                                                          │ brand reads + curates
                                                                                          │ (never writes back)
                                                                                          ▼
                                                                          ┌────────────────────────────────┐
                                                                          │   BrandCommerceProduct            │
                                                                          │   (visibility, campaign           │
                                                                          │    eligibility, ordering,          │
                                                                          │    SQRATCH-side overrides)         │
                                                                          └───────────────┬────────────────────┘
                                                                                          │ isVisibleInShop = true
                                                                                          ▼
                                                                          ┌────────────────────────────────┐
                                                                          │        SQRATCH Shop               │
                                                                          │  (brand-curated product surface,  │
                                                                          │   never a raw Shopify mirror)     │
                                                                          └────────────────────────────────┘

  Every sync attempt (success, partial, or failure) is recorded in
  CommerceProductSyncRun for observability — see §5.
```

`syncBrandCommerceProducts` (`src/lib/commerce/product-sync.ts`) never imports a Shopify-specific module directly — it resolves the brand's connection via `getActiveCommerceConnection`/`getAdapterForConnection` (`./connection-service.ts`, Phase 2) and calls `adapter.syncProducts(connectionId)` through the `CommerceAdapter` interface, exactly as Phase 1 intended. A future Commerce7 adapter registering `canSyncProducts: true` needs no change to this module.

## 3. New Prisma models and enum

All three tables and the one enum were added by migration `20260806140000_add_commerce_product_catalog` (see §6). Full field tables, transcribed from `prisma/schema.prisma`:

### `ConnectedCommerceProduct`

The provider-neutral mirrored catalog. One row per product per connection.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `connectionId` | `String` | FK → `CommerceConnection.id`, `onDelete: Cascade` |
| `brandId` | `String` | FK → `Brand.id`, `onDelete: Cascade`. **Denormalized** from `connection.brandId` so brand-scoped reads need no join; the connection remains authoritative (§9's reconciliation tool repairs drift here). |
| `provider` | `CommerceProvider` | |
| `externalKey` | `String` | Stable provider-scoped key (Shopify: the product `gid`). Unique **per connection**, not globally — see §6. |
| `externalId` | `String` | Provider's raw product id. |
| `title` | `String` | |
| `handle` | `String?` | |
| `productUrl` | `String` | |
| `imageUrl` | `String?` | |
| `images` | `String[]` | |
| `externalVariantIds` | `String[]` | |
| `descriptionText` | `String?` | |
| `sku` | `String?` | |
| `currencyCode` | `String?` | `null` when the brand's currency is unknown — see §7. Never guessed. |
| `priceMinMinor` | `Int?` | Integer minor units (e.g. cents). No float/decimal price column exists or may be added — see §6. |
| `priceMaxMinor` | `Int?` | |
| `priceMinorUnitExponent` | `Int?` | Resolved from the currency code itself, independent of whether a price string parsed. |
| `isAvailable` | `Boolean @default(true)` | Soft-unavailability flag — see §5. |
| `firstSeenAt` | `DateTime @default(now())` | |
| `lastSeenAt` | `DateTime @default(now())` | Bumped every sync the product is still returned by, even on a `TOUCH` (no other field write). |
| `unavailableSince` | `DateTime?` | Set once, on the transition to unavailable; preserved (not reset) on subsequent unavailable syncs. |
| `providerCreatedAt` / `providerUpdatedAt` | `DateTime?` | From the provider, not this system. |
| `providerMetadata` | `Json?` | Whitelisted, sanitized subset only — see §5. |
| `lastSyncRunId` | `String?` | Not a FK (informational only). |
| `createdAt` / `updatedAt` | `DateTime` | |

Indexes: `connectionId`; `(connectionId, isAvailable)`; `brandId`; `(brandId, isAvailable)`; `(connectionId, lastSeenAt)`. Unique: `(connectionId, externalKey)`.

### `CommerceProductSyncRun`

One row per catalog sync attempt.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `connectionId` | `String` | FK → `CommerceConnection.id`, `onDelete: Cascade` |
| `brandId` | `String` | FK → `Brand.id`, `onDelete: Cascade` |
| `provider` | `CommerceProvider` | |
| `status` | `CommerceProductSyncRunStatus @default(RUNNING)` | `RUNNING \| SUCCEEDED \| PARTIAL \| FAILED` — the new enum. |
| `startedAt` | `DateTime @default(now())` | |
| `finishedAt` | `DateTime?` | `null` while `RUNNING`. |
| `fetchedCount` | `Int @default(0)` | |
| `createdCount` | `Int @default(0)` | |
| `updatedCount` | `Int @default(0)` | |
| `unchangedCount` | `Int @default(0)` | |
| `markedUnavailableCount` | `Int @default(0)` | Always `0` for a `PARTIAL` or `FAILED` run — see §5. |
| `failedCount` | `Int @default(0)` | |
| `hasNextPage` | `Boolean @default(false)` | |
| `requestedLimit` | `Int?` | |
| `failureSummary` | `String?` | Sanitized, bounded (300 chars) text only — never a raw error object, response body, or URL. |
| `triggeredBy` | `String?` | Free-text provenance (e.g. `"manual"`, `"cron"`). |
| `createdAt` | `DateTime @default(now())` | |

Indexes: `(connectionId, startedAt)`; `(brandId, startedAt)`; `status`.

### `BrandCommerceProduct`

Brand-side curation layered on top of a mirrored product. SQRATCH presentation only — never written back to a provider (§8).

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `brandId` | `String` | FK → `Brand.id`, `onDelete: Cascade` |
| `connectedProductId` | `String` | FK → `ConnectedCommerceProduct.id`, `onDelete: Cascade` |
| `isVisibleInShop` | `Boolean @default(false)` | Opt-in: a synced product is invisible until a brand explicitly selects it. |
| `isCampaignEligible` | `Boolean @default(false)` | |
| `displayOrder` | `Int @default(0)` | |
| `titleOverride` | `String?` | SQRATCH-side only. |
| `shortDescriptionOverride` | `String?` | |
| `imageUrlOverride` | `String?` | |
| `approvedByUserId` | `String?` | Not a FK (informational only). |
| `approvedAt` | `DateTime?` | |
| `createdAt` / `updatedAt` | `DateTime` | |

Indexes: `(brandId, isVisibleInShop, displayOrder)`; `(brandId, isCampaignEligible)`; `connectedProductId`. Unique: `(brandId, connectedProductId)`.

### `CommerceProductSyncRunStatus` (new enum)

`RUNNING | SUCCEEDED | PARTIAL | FAILED` — see §5 for exactly which write behavior each status gates.

## 4. The migration: `20260806140000_add_commerce_product_catalog`

**Additive and forward-only.** The migration file contains only `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, and `ALTER TABLE ... ADD CONSTRAINT` (foreign keys) statements — no `DROP`, no `ALTER COLUMN`, no `UPDATE`/`DELETE`/`TRUNCATE`. It does not touch any existing table, column, row, index, or enum, and does not read or backfill from `Brand.shopify*`, `CommerceConnection`, or `CommerceConnectionSecret`.

**Preflight — this migration WILL fail if applied out of order.** Every foreign key here references `CommerceConnection.id`, which only exists once `20260806120000_add_commerce_connection_abstraction` (Phase 1) has been applied. Attempting to apply this migration against a database that hasn't run that one fails outright with Postgres error `42P01` ("relation does not exist"). The migration file documents the exact preflight queries to run first (confirming the prior migration's tracking row, confirming `CommerceConnection`/`CommerceProvider` actually exist, and confirming `CommerceProductSyncRunStatus` does not already exist) — see the file's header comment for the literal SQL. **As of this writing, this migration has NOT been applied to any environment** (see §10).

**Cascade reasoning.** Every foreign key is `ON DELETE CASCADE`, deliberately: Shopify's `shop/redact` GDPR webhook hard-deletes the `CommerceConnection` row, and a GDPR erasure must not leave a full product mirror of the erased shop behind. `BrandCommerceProduct` cascades too — that curation loss is accepted, because it is unrenderable once the product it points at is gone. `app/uninstalled` does **not** delete the connection (it sets `status = 'UNINSTALLED'` and keeps the row), so the catalog correctly survives an uninstall/relink cycle and is erased only on genuine redaction.

**Rollback limitations.**

- **Dropping `BrandCommerceProduct` destroys brand curation that cannot be re-derived from any provider.** Visibility flags, campaign eligibility, display ordering, and the three override fields are first-party SQRATCH data entered by brand staff — no Shopify or Commerce7 re-sync can reconstruct them. `ConnectedCommerceProduct` and `CommerceProductSyncRun`, by contrast, are re-derivable (a mirror and a log). Export any curation rows before dropping.
- **The new Postgres enum type `CommerceProductSyncRunStatus` cannot be dropped while any column of that type still exists** — including a column that merely carries a `DEFAULT` of that type, as `CommerceProductSyncRun.status` does. `DROP TYPE` must come strictly after `DROP TABLE "CommerceProductSyncRun"`. Once shipped, an individual enum value cannot be removed in place either; retiring one requires a replacement type and rewriting every dependent column.
- Rolling back restores nothing the forward migration removed, because the forward migration removes nothing — it is purely a matter of discarding the three new (initially empty) tables and whatever data has since accumulated in them.

## 5. Synchronization semantics

`syncBrandCommerceProducts` (`src/lib/commerce/product-sync.ts`) is the single entry point; `scripts/reconcile-commerce-products.ts` (§9) never duplicates it.

**Idempotency and change detection.** `decideProductWrite` is a pure function that compares a fetched product's computed fields against the existing row (if any) and returns one of three decisions:
- `CREATE` — no existing row.
- `UPDATE` — an existing row whose content changed (title, handle, productUrl, imageUrl, images, externalVariantIds, descriptionText, sku, currencyCode, price fields, or status) **or** whose availability is flipping.
- `TOUCH` — nothing meaningful changed; only `lastSeenAt` + `lastSyncRunId` are written.

A second, identical sync therefore reports 100% `TOUCH`/`unchangedCount`, never a spurious `UPDATE`.

**Soft unavailability, never a hard delete.** A product is never removed from `ConnectedCommerceProduct` when it disappears from the provider's catalog. Instead, `markUnavailableExcept` sets `isAvailable: false` + `unavailableSince: now` on every previously-available product for the connection that this run did **not** see.

**HARD RULE: a failed, partial, or truncated sync marks NOTHING unavailable.** This is the single most dangerous write path in the module, and it is guarded directly on the branch that decides the run's final status:
- The adapter call **throws** → run status `FAILED`. Nothing was fetched (the adapter's `syncProducts` is a single all-or-nothing call), so nothing is upserted and the mark-unavailable step never runs. The existing catalog is untouched, byte for byte.
- The adapter call **succeeds but `hasNextPage: true`** → run status `PARTIAL`. Pagination did not exhaust the catalog. Products actually returned on the page fetched are still upserted (real, current data), but the mark-unavailable step is skipped entirely — a product that lives on a page this run never reached must never be marked unavailable just because this run didn't see it.
- The adapter call **succeeds and `hasNextPage: false`** → run status `SUCCEEDED`. Only now does the mark-unavailable step run.

This is why an incomplete sync is safe (never over-hides a real product) even though it can leave the mirrored catalog incomplete (§11's known risk).

**Sanitized `providerMetadata`.** Only four whitelisted, non-credential fields are ever copied from the neutral product into `providerMetadata`: `status`, `priceText`, `providerCreatedAt` (ISO string), `providerUpdatedAt` (ISO string). The raw provider node, any header, URL, or token is never spread into it.

**Legacy-fallback and no-connection brands are never silently reported as a successful empty sync.** `syncBrandCommerceProducts` returns `{ status: "SKIPPED", reason: "NO_CONNECTION" }` for a brand with no commerce connection at all, and `{ status: "SKIPPED", reason: "LEGACY_FALLBACK" }` for a brand whose Shopify state lives only on legacy `Brand.shopify*` columns with no `CommerceConnection` row yet (`getActiveCommerceConnection` returning `summary.id === null` — see Phase 2). Neither case ever produces a `SUCCEEDED` outcome with an empty product list, and neither writes anything. See §11.

## 6. Money handling

Prices are stored **exclusively** as integer minor units — `priceMinMinor` / `priceMaxMinor`, with `priceMinorUnitExponent` recording the currency's minor-unit exponent (via `getCurrencyExponent`, `src/lib/commerce/money.ts`). No float, double, decimal, or numeric price column exists in the schema, and none may be added later (enforced by convention and the migration's own header comment, not by a DB constraint).

**Currency comes from `Brand.shopifyCurrencyCode`, fetched once per sync — never from `NormalizedShopifyProduct.currency`.** The neutral `CommerceProduct.currency` field (from `./types.ts`) is unreliable: for Shopify it is a hardcoded `"USD"` default unless a caller explicitly supplies `options.currency` to `fetchNormalizedShopifyProducts`, and nothing in this codebase does. `product-sync.ts` therefore never reads `product.currency` at all.

When `Brand.shopifyCurrencyCode` is `null`/unknown, **every** product for that brand gets `currencyCode: null`, `priceMinMinor: null`, `priceMaxMinor: null`, `priceMinorUnitExponent: null` — never a guessed `"USD"`, and never an amount stored without a currency to name its unit. A `null` currency means "unknown, do not render a price" (recoverable); a wrong currency stored as if correct is not. When the brand's currency **is** known, `priceRangeRaw.min`/`.max` (raw decimal strings from the provider) are converted independently via `providerPriceStringToMinorUnits`; a parse failure on one bound nulls only that bound, never the whole product, and the exponent is resolved directly from the currency code so it's never left `null` merely because a price string failed to parse.

## 7. Brand approval and override semantics

`BrandCommerceProduct` is opt-in: a newly-synced `ConnectedCommerceProduct` has no matching selection row and is therefore invisible in the SQRATCH Shop by default (`isVisibleInShop` only ever becomes `true` via an explicit brand action through `PATCH /api/brand/products/[connectedProductId]/selection`). Title and short-description overrides let a brand adjust presentation inside SQRATCH only; they are never sent back to Shopify or another provider. As of Phase 3.5, the historical `imageUrlOverride` column is dormant legacy storage: active code neither reads nor writes it, and synchronized provider images remain authoritative. The selection route (`src/app/api/brand/products/[connectedProductId]/selection/route.ts`) writes only to `BrandCommerceProduct`; it never calls a commerce adapter and never touches `ConnectedCommerceProduct`.

Product ownership on the selection route is enforced with `findFirst({ where: { id, brandId: brand.id } })`, never a bare `findUnique` followed by a brandId comparison — a wrong-brand id and a nonexistent id resolve through the identical code path to the identical 404, so neither response shape leaks which case occurred.

## 8. API routes

All four routes live under `src/app/api/brand/products/**` and are scoped through `getBrandManagementContext`/`getBrandContextFailure` (`src/lib/brand-auth.ts`) — never a client-supplied brand id trusted on its own.

| Route | Method | Purpose |
|---|---|---|
| `src/app/api/brand/products/route.ts` | `GET` | Lists the brand's persisted catalog (`ConnectedCommerceProduct`) joined with its own selection state (`BrandCommerceProduct`). Keyset ("seek") pagination on `[{title:"asc"},{id:"asc"}]`, not offset paging — the table is concurrently rewritten by syncs mid-scroll, and offset paging over that silently drops/duplicates rows. |
| `src/app/api/brand/products/sync/route.ts` | `POST` | Triggers `syncBrandCommerceProducts` for the brand's active SHOPIFY connection. A `SKIPPED` outcome is always surfaced as an error, never mapped onto a 200. Refuses a new run (409) while a `RUNNING` run younger than 5 minutes exists for the brand; an older `RUNNING` row is treated as abandoned and does not block. |
| `src/app/api/brand/products/sync-runs/route.ts` | `GET` | Lists recent `CommerceProductSyncRun` rows for the brand (audit surface), keyset-paginated on `[{startedAt:"desc"},{id:"desc"}]`. Only the already-sanitized `failureSummary` is exposed. |
| `src/app/api/brand/products/[connectedProductId]/selection/route.ts` | `PATCH` | Upserts the brand's `BrandCommerceProduct` row for one product (visibility, campaign eligibility, display order, title and short-description overrides). |

## 9. The brand page

`src/app/(withSidebar)/dashboard/brand/products/page.tsx` + `BrandProductsClient.tsx` + `product-catalog-helpers.ts` render the brand-facing management UI on top of the four routes above (built concurrently by a separate workstream; out of this document's authorship scope beyond noting its existence and that it is untouched by this workstream).

## 10. The reconciliation tool

`scripts/reconcile-commerce-products.ts` (thin CLI wrapper) + `src/lib/commerce/product-reconciliation.ts` (pure, dependency-injected logic) — same separation Phase 2's `scripts/reconcile-commerce-connections.ts` / `connection-reconciliation.ts` established. **Dry run by default; `--apply` is required to write.**

```
npx tsx scripts/reconcile-commerce-products.ts
npx tsx scripts/reconcile-commerce-products.ts --apply
```

Additional flags: `--brand-id=<id>`, `--connection-id=<id>`, `--provider=<SHOPIFY|COMMERCE7>`, `--limit=N`, `--help`.

**Detection / repair matrix:**

| # | Category | Detected as | Repaired with `--apply`? |
|---|---|---|---|
| 1 | `duplicate_external_key` | More than one `ConnectedCommerceProduct` row shares `(connectionId, externalKey)`. | **Never.** There is no principled way to pick a winner — both rows are equally real product history (pre-constraint data, or a since-fixed sync bug), and this tool never hard-deletes a historical product row, which is exactly what "resolving" a duplicate would require. Reported only, as a preflight signal. |
| 2 | `cross_brand_selection` | A `BrandCommerceProduct.brandId` differs from its `connectedProduct.brandId`. | **Never — deliberately manual-only.** This is security-relevant (a brand curating/possibly publicly showing a product it does not own) but genuinely ambiguous to auto-fix: either the selection row should be deleted, or the product's own denormalized `brandId` is the one that's actually wrong. Guessing wrong either destroys a brand's curation or leaves a real cross-brand hole in place. Always reported prominently as a WARNING, in both dry run and apply. |
| 3 | `wrong_brand_product` | A `ConnectedCommerceProduct`'s denormalized `brandId` differs from its `connection.brandId`. | **Yes — deterministic.** The connection is authoritative (a product is only ever fetched through its own connection's adapter for that connection's brand), so the product's `brandId` is reset to `connection.brandId`. |
| 4 | `unavailable_but_visible` | `isAvailable === false` while a `BrandCommerceProduct` selecting it has `isVisibleInShop === true`. | **Yes — deterministic.** The product cannot be shown regardless of the flag, so `isVisibleInShop` is cleared. |

No category, in any mode, ever hard-deletes a `ConnectedCommerceProduct` or `BrandCommerceProduct` row.

**Output** prints the mode (`DRY RUN`/`APPLY`) prominently, then per-row `[INFO]`/`[WARN]`/`[ERROR]` lines (ids, brand ids, connection ids, provider names, external keys — never a token/secret/credential/database URL), then totals: products/selections scanned, created, updated, skipped, warnings, failed.

**Idempotent:** a second `--apply` run immediately after the first reports zero repairs — every detection is re-derived from current state, never cached.

**Exit codes:**
- `0` — success: dry run computed cleanly, or every attempted apply-mode repair succeeded.
- `1` — one or more per-row repairs failed (see the `Failed` total and per-row `ERROR` lines); the run still completed for every other row.
- `2` — invalid usage (malformed `--limit`, unrecognized `--provider`); nothing was read or written.

## 11. Tests

`tests/commerce-product-reconciliation.test.ts` — 21 tests, all against in-memory fakes implementing `ProductReconciliationDeps`, no real DB or network. Covers: dry run performs zero writes; each of the four detections fires independently; deterministic repairs (categories 3 & 4) apply only with `--apply` and totals match what was actually done; `cross_brand_selection` and `duplicate_external_key` are reported but never auto-repaired even with `--apply`; no product or selection row is ever deleted in any mode; idempotency (a second apply run reports zero repairs); `--brand-id`/`--connection-id`/`--provider`/`--limit` each narrow correctly; a simulated repair failure is counted without aborting the run; no output line matches `/token|secret|encrypted|password|authorization/i`; an empty catalog produces an empty, zero-write report.

Pre-existing catalog tests exercised by this phase's implementation (not authored by this workstream, listed for completeness): `tests/commerce-product-sync.test.ts`, `tests/commerce-product-money.test.ts`, `tests/shopify-commerce-adapter.test.ts`, `tests/commerce-adapter-registry.test.ts`.

## 12. Known risks

- **The Shopify adapter fetches a single page (up to 100 products) and never loops.** `ShopifyCommerceAdapter.syncProducts` calls `fetchNormalizedShopifyProducts` without an `after` cursor, so any store with more than 100 products always reports `hasNextPage: true` and its run status is permanently `PARTIAL` — its mirrored catalog will never reach the tail of a >100-product store. This is **safe** (per §5's hard rule, a truncated sync never marks anything unavailable) but means the catalog is **incomplete** for large stores until the adapter is extended to paginate across multiple pages.
- **Migration `20260806140000_add_commerce_product_catalog` has not been applied to any environment as of this writing.** None of `ConnectedCommerceProduct`, `CommerceProductSyncRun`, or `BrandCommerceProduct` exist in any live database yet; every code path in this document is inert until it is deployed (see §13 for the deploy sequencing this requires).
- **Legacy-fallback brands (no `CommerceConnection` row, only legacy `Brand.shopify*` columns) get a `SKIPPED` sync, not an empty-but-successful one — but they also get no catalog at all until backfilled.** `scripts/backfill-commerce-connections.ts` (Phase 2) must run for such a brand before its first product sync can do anything.
- The reconciliation tool's `--limit` applies independently per table (`ConnectedCommerceProduct` and `BrandCommerceProduct` are each capped separately), so a duplicate-external-key group that straddles a `--limit` boundary could have one of its rows excluded from a given scan and go undetected in that run. An unlimited (or high-limit) run does not have this gap.
- `CommerceProductSyncRun.lastSyncRunId` on `ConnectedCommerceProduct` is informational only (not a foreign key); nothing enforces it points at a live run row.

## 13. Explicitly deferred / out of scope

- A Commerce7 adapter's `syncProducts` implementation (the registry and interface already support it; no adapter is registered).
- Multi-page product fetch/pagination inside the Shopify adapter (see the known risk above).
- Any UI beyond the brand management page already covered in §9 — in particular, wiring `BrandCommerceProduct.isVisibleInShop` selections into the actual public-facing SQRATCH Shop surface (`src/app/x/[experienceSlug]/shop/page.tsx`) is not part of this workstream.
- Deleting/archiving `ConnectedCommerceProduct` rows for products permanently removed from a store — the system only ever soft-marks `isAvailable: false`, by design (§5); a hard-delete/archival policy, if ever wanted, is a deliberately separate decision.
- Any automatic resolution of `duplicate_external_key` or `cross_brand_selection` findings — both are permanently manual-only per §10's matrix.
- Scheduling/cron automation for `syncBrandCommerceProducts` or the reconciliation tool — both are currently invoked on demand only (the sync route, or a manual CLI run).

## 14. Manual testing instructions

Once the migration (§4, §15) has been applied to a database with the Phase 1 `CommerceConnection` table already present:

1. Connect a brand to a real or test Shopify store via the existing OAuth flow (unchanged by this phase).
2. Call `POST /api/brand/products/sync` for that brand (or use the brand page's sync action, §9). Confirm a `CommerceProductSyncRun` row is created with `status: SUCCEEDED` (or `PARTIAL` if the store has >100 products) and that `ConnectedCommerceProduct` rows now exist for that connection.
3. Call `GET /api/brand/products` and confirm the returned rows match the store's catalog, each with `isVisibleInShop: false` by default (no `BrandCommerceProduct` row yet).
4. `PATCH /api/brand/products/[connectedProductId]/selection` with `{ "isVisibleInShop": true }` for one product; re-`GET` and confirm it now reports `isVisibleInShop: true`.
5. Remove or archive that product in the Shopify admin, re-sync, and confirm the corresponding `ConnectedCommerceProduct` row flips to `isAvailable: false` with `unavailableSince` set, while the row itself still exists (never deleted).
6. Run the reconciliation tool in dry-run mode (`npx tsx scripts/reconcile-commerce-products.ts --brand-id=<id>`) and confirm it reports the `unavailable_but_visible` finding for the product from step 4/5 (still visible, now unavailable). Re-run with `--apply` and confirm `isVisibleInShop` is cleared, then run once more and confirm zero repairs (idempotency).

## 15. Production migration instructions

1. Confirm `20260806120000_add_commerce_connection_abstraction` (Phase 1) is already applied and its objects exist — see the exact preflight SQL embedded in the migration file's header comment (§4).
2. Apply `20260806140000_add_commerce_product_catalog` via the standard `prisma migrate deploy` path for this repository (see `docs/prisma-migrations.md` for this project's general migration process and its historical local-vs-production drift notes).
3. Confirm the three new tables and the new enum exist, and that no existing table/column was altered (the migration is additive-only, so this should be a no-op check, not a recovery step).
4. Do **not** hand-run any DDL from this migration file manually against production — apply the migration file as-is through the standard deploy path.
5. This workstream did not run this migration, or any other database-connecting command, against any environment — see §16.

## 16. Readiness for Phase 4

The provider-neutral seam now covers connection identity (Phase 1/2) and the full product catalog persistence + curation layer (Phase 3). What remains before a genuinely provider-neutral commerce surface is complete: a second adapter (Commerce7) actually implementing `canSyncProducts`, multi-page product fetch in the Shopify adapter, and wiring the curated `BrandCommerceProduct` selections into the public SQRATCH Shop page. The reconciliation CLI built here (§10) gives Phase 4 the same operational safety net Phase 2 gave the connection mirror — a repeatable, dry-run-by-default way to detect and deterministically repair the two classes of drift this schema can develop, without ever guessing on the two classes it can't.

---

**Verification performed by this workstream:** `npx prisma validate`, `npx prisma generate`, `npm run typecheck`, `npm run lint`, and the full test suite (via the blocked-DB-URL convention) all passed with zero failures attributable to this workstream's files; `npm run build` completed successfully. This workstream never executed `scripts/reconcile-commerce-products.ts`, any other script, or any database-connecting command (no `prisma migrate`, `db push`, `db pull`, `psql`, `prisma studio`, or seed) — all verification of `product-reconciliation.ts`'s logic was via unit tests against injected in-memory fakes only.
