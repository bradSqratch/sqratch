# Phase 2: Commerce Cutover + Hardening Summary

Phase 1 (`docs/commerce/phase-1-commerce-abstraction-summary.md`) built the provider-neutral seam — `CommerceAdapter`, `CommerceAdapterRegistry`, `CommerceConnection`/`CommerceConnectionSecret`, and a best-effort dual-write — without routing a single existing request through it. Phase 2 does the cutover: it moves specific, chosen runtime paths behind that seam while preserving every existing API contract byte-for-byte, adds a database-level single-primary invariant the Phase-1 model was missing, adds a reconciliation CLI, and adds a production-database safety guard for the test suite. This document is the record of what Phase 2 actually built, verified against the code in this repository — not the plan that preceded it.

**Scope discipline carried over from Phase 1 applies here too:** where cutting a path over would touch authorization, race-sensitive transactions, or GDPR-deadline-bound webhook verification, Phase 2 deliberately left it on the legacy path and documents why in §3.

## 1. Before and after architecture

**Before (post-Phase-1, pre-Phase-2):** every route read `Brand.shopify*` columns and called the Shopify-specific services (`shopify-products.ts`, `shopify-discounts.ts`, `shopify-token-manager.ts`) directly. The `CommerceAdapter`/`CommerceAdapterRegistry`/`CommerceConnection` layer existed but had no caller.

**After (Phase 2):** four specific paths (status metadata, product fetch, discount issuance, and a set of connectivity gates) now resolve their connection through `src/lib/commerce/connection-service.ts` first, and only reach the adapter layer when that resolution yields a real `CommerceConnection.id`. Every one of them retains its exact legacy call as a fallback.

```
                    ┌───────────────────────────────────────────────────────────┐
                    │  Routes (status, products, redeem, lesson/experience gates) │
                    └───────────────────────┬───────────────────────────────────┘
                                             │
                              getActiveCommerceConnection(brandId, provider)
                              (or a legacy-only pure helper — see §2)
                                             │
                    ┌────────────────────────▼────────────────────────┐
                    │        connection-service.ts (neutral service)     │
                    │  consistency-checked preference:                   │
                    │    CommerceConnection row IF externalAccountId      │
                    │    agrees with normalized Brand.shopifyShopDomain;  │
                    │    else legacy Brand.shopify* wins + drift reported │
                    └───────────┬─────────────────────────┬─────────────┘
                                │ summary.id !== null       │ summary.id === null
                                │ (mirror trusted)           │ (no row / drift / legacy fallback)
                                ▼                            ▼
                 ┌───────────────────────────┐   ┌─────────────────────────────────┐
                 │  defaultCommerceAdapterRegistry │   │  Legacy direct call (unchanged): │
                 │  .get(SHOPIFY)                │   │  fetchNormalizedShopifyProducts,  │
                 └───────────────┬───────────────┘   │  createShopifyRewardDiscountCode  │
                                 ▼                    └─────────────────────────────────┘
                 ┌───────────────────────────┐
                 │   ShopifyCommerceAdapter     │
                 │   (wraps, never rewrites,    │
                 │   the same services)          │
                 └───────────────┬───────────────┘
                                 ▼
      ┌───────────────────────────────────────────────────┐
      │  Existing Shopify services (unmodified call shape): │
      │  shopify-products.ts, shopify-discounts.ts,          │
      │  shopify-token-manager.ts, shopify.ts                 │
      └───────────────────────────────────────────────────┘

  Separately, src/lib/shopify-token-manager.ts now also fires the Phase-1
  best-effort mirror (safeSyncShopifyCommerceConnection /
  safeMarkShopifyCommerceConnectionDisconnected) at the two points a token
  refresh actually changes durable state — see §5.
```

Both branches funnel into the same response shape at every cut-over route — the adapter path and the legacy-fallback path are asserted byte-identical by `tests/shopify-route-contract-compatibility.test.ts` test 5 and `tests/shopify-reward-adapter-cutover.test.ts`'s adapter-vs-legacy test.

## 2. Routes and services cut over

| Path | What moved | Fallback behavior |
|---|---|---|
| `src/app/api/brand/shopify/status/route.ts` | Connection identity/metadata (`shopifyInstalledAt`, `shopifyUninstalledAt`, `shopifyConnectionStatus`, `shopifyLastProductSyncAt`) now sourced from `getActiveCommerceConnection`. | Field-by-field: each field is only taken from the mirror summary once verified equal to the corresponding legacy value (`mirrorTrusted` check in the route); any single field mismatch falls back to the legacy value for **all** of them. `shopifyShopDomain` always stays the legacy literal (mirror stores it normalized/lowercased; legacy doesn't). Token-derived fields (`shopifyAuthMode`, `shopifyAccessTokenExpiresAt`, `shopifyGrantedScopes`, `hasShopifyAccessToken`) are never sourced from the service — it has no credential field. |
| `src/app/api/brand/shopify/products/route.ts` | Product fetch: when the resolved summary carries a real `CommerceConnection.id`, fetch goes through `defaultCommerceAdapterRegistry.get(SHOPIFY).syncProducts(connectionId)` → `ShopifyCommerceAdapter.syncProducts`. | When the summary is a legacy fallback (`id === null` — no mirror row, or the mirror's domain disagreed with legacy), falls back to the exact pre-cutover direct call, `fetchNormalizedShopifyProducts`. `Brand.shopifyLastProductSyncAt`/`shopifyConnectionStatus` are stamped identically regardless of which path ran (the adapter path additionally stamps `CommerceConnection.lastProductSyncAt` as a required dual-write, not a duplicate). |
| `src/app/api/rewards/shopify/redeem/route.ts` | Discount issuance: when the resolved summary carries a real `CommerceConnection.id`, issuance goes through `adapter.createDiscount(connectionId, input, { preResolvedAccessToken })` — the route's own already-resolved `getValidAccessToken` result is passed in so the adapter never resolves a second token (see §5's "exactly one token resolution" note). | Falls back to the exact legacy `createShopifyRewardDiscountCode` call when `summary.id === null`. The connection-summary lookup itself is wrapped in `safeGetCommerceConnectionSummary`, which catches **any** error and returns `null` — a `CommerceConnection` lookup failure can never fail a redemption; it always degrades to the legacy path. Both branches produce the same `DiscountCreationOutcome` shape, so refund/persist logic downstream cannot tell which path ran. |
| `src/lib/lesson-product-links.ts` (`getLessonProductManagementContext`'s `primaryBrand` selection, `resolveSourceShopDomainForBrand`) | Connectivity gate and shop-domain read now call `isLegacyShopifyBrandConnectionUsable` / `externalAccountIdFromShopDomain` — pure helpers exported from `connection-service.ts` — instead of hand-inlining the three-part `shopDomain && token && status === CONNECTED` check at each call site. | These helpers are **legacy-only by design** (see §3) — there is no mirror-preferring fallback here because there is nothing to fall back from; centralizing removed duplicated logic without changing which data source answers the question. |
| `src/app/api/creator/lessons/route.ts`, `.../[lessonId]/products/route.ts` | Shop-domain reads for `isProductLinkCurrent`'s `domainByBrandId` map now go through `externalAccountIdFromShopDomain` instead of reading `brand.shopifyShopDomain` directly. | Same helper, same legacy-only source; the helper is a pure `trim()`-or-`null` pass, so behavior is unchanged for every existing domain value. |
| `src/app/api/creator/lessons/[lessonId]/available-products/route.ts` | Three-part connectivity gate replaced with `isLegacyShopifyBrandConnectionUsable(brand)`. | Same legacy-only source. The redundant `!brand?.shopifyShopDomain` check alongside it is a TypeScript-narrowing no-op, not an added condition. |
| `src/app/api/public/experience/[experienceSlug]/products/route.ts`, `.../lessons/[lessonId]/products/route.ts` | Same two helpers (`externalAccountIdFromShopDomain` for the domain map, `isLegacyShopifyBrandConnectionUsable` for the direct-fetch-fallback gate). The brand `select` in the products route was changed to drop `shopifyAdminAccessTokenEncrypted` and add `shopifyInstalledAt`/`shopifyUninstalledAt`/`shopifyLastProductSyncAt`/`shopifyGrantedScopes` — the field set `LegacyBrandShopifyFields` needs, since the helper never reads a token column. | Same legacy-only source. |
| `src/app/api/rewards/shopify/redemptions/route.ts` | `shopUrl` now built via `deriveShopifyStorefrontUrl(brand.shopifyShopDomain)` instead of an inline ternary. | Pure formula helper (`shopDomain ? https://${shopDomain} : null`), reproduced byte-for-byte — no behavior change possible. |

## 3. Routes intentionally left legacy-backed

| Path / area | Reason |
|---|---|
| Webhook routes (`src/app/api/shopify/webhooks/app/uninstalled`, `.../shop/redact`, `.../customers/data_request`, `.../customers/redact`) | `ShopifyCommerceAdapter.verifyAndParseWebhook` needs a `connectionId`, but an inbound webhook carries no such id before it has been verified — verification must happen before any DB lookup could resolve one. Shopify retries (and can eventually auto-disable delivery) on repeated non-200 responses, and `shop/redact` carries a 48-hour GDPR compliance deadline; neither tolerates the extra failure surface of routing through a not-yet-exercised adapter path on the compliance-critical route. |
| `src/lib/reward-reconciliation.ts` | Calls `createShopifyRewardDiscountCode`/`getValidAccessToken` directly (verified: it imports from `@/lib/shopify-discounts` and `@/lib/shopify-token-manager`, not from `@/lib/commerce`). `CommerceAdapter` has no discount-**lookup** method today (only `createDiscount`/`revokeDiscount`) — adding one requires designing two lookup strategies (by Shopify node id, by code) plus ambiguous-vs-definitive-not-found semantics that don't exist yet. Deferred deliberately, not an oversight. |
| Token authority (`src/lib/shopify-token-manager.ts`'s `getValidAccessToken`) | Legacy `Brand.shopify*` columns remain the sole authoritative token source for all of Phase 2. `getValidAccessToken` itself is otherwise unchanged — Phase 2 only adds the best-effort mirror calls described in §5, never alters its refresh/CAS/lock logic. |
| `src/lib/shopify-embedded-connection.ts` | The embedded-app auth gate. Untouched — authorization-critical. |
| The install/relink route (`src/app/api/shopify/installations/[installId]/route.ts`) and its Serializable transaction | Untouched — race-critical (prevents concurrent duplicate installs of the same shop domain). |
| `src/lib/brand-auth.ts` (brand-context/brand-auth) | Untouched — authorization-critical. |
| The redeem route's connectivity gate and its in-transaction re-read of the point reservation | Untouched — race-critical (money path). Only the discount-issuance call itself (after that gate passes) was cut over. |
| The connectivity gates centralized behind `connection-service.ts` (`isLegacyShopifyBrandConnectionUsable`, §2's `lesson-product-links.ts`/creator/public routes) | Still evaluate **legacy fields only**, deliberately — `getActiveCommerceConnection`'s consistency check only verifies that the mirror's `externalAccountId` agrees with legacy; it does **not** re-verify that the mirror's `status` also agrees, so the mirror can report a different `status` than legacy even when the domain check passes. Preferring the mirror at these gates would risk a behavior change these low-risk call sites must not have. |

## 4. Database invariant: single-primary partial unique index

Migration `prisma/migrations/20260806130000_commerce_connection_single_primary/migration.sql` adds one index:

```sql
CREATE UNIQUE INDEX "CommerceConnection_brandId_provider_primary_key"
  ON "CommerceConnection"("brandId", "provider")
  WHERE "isPrimary" = true;
```

It is purely additive — no existing table, column, row, or enum is touched. Because it is a **partial** unique index, it only constrains rows where `isPrimary = true`; a brand may still hold multiple non-primary `CommerceConnection` rows for the same provider (multi-store support). Prisma cannot express partial unique indexes in `schema.prisma`, so this is deliberate, permanent DB-only schema drift — the same pattern already established by `20260615113320_campaign_unlock_anon_unique`. `npx prisma migrate diff`/`migrate status` will report this index as present in the database but absent from the schema on every future run; that is expected and must not be "fixed" by adding a non-partial `@@unique([brandId, provider, isPrimary])` (which would incorrectly forbid multiple non-primary connections) or by dropping the index.

**Preflight** (must return zero rows before applying; run again after resolving any returned group):

```sql
SELECT "brandId", "provider", count(*)
FROM "CommerceConnection"
WHERE "isPrimary" = true
GROUP BY 1, 2
HAVING count(*) > 1;
```

If it returns rows, keep whichever row's `externalAccountId` matches the brand's current `Brand.shopifyShopDomain` — the store actually live right now — falling back only when none match to the row `pickPreferredConnectionRow` (`src/lib/commerce/connection-resolver.ts`) would choose for that group (`isPrimary` first, moot within an already-primary-only group; then most recent `installedAt`; then most recent `createdAt`) — and manually clear `isPrimary` on every other row in the group (never delete). The migration file states that, as of authoring, production holds 2 `CommerceConnection` rows with no duplicate primaries, so this preflight is expected to return zero rows — but it must still be run and confirmed immediately before applying, not assumed.

Application logic was hardened alongside this migration (`src/lib/commerce/connection-sync.ts`'s `applyShopifyConnectionSync`): siblings are now cleared to `isPrimary: false` **before** the target row is upserted with its computed `isPrimary` value (previously the reverse order), so a single-writer sync can never itself transiently hold two `isPrimary: true` rows. The remaining case — two different transactions racing to become primary for the same `(brandId, provider)` with different shop domains under READ COMMITTED — is caught by the index itself; `syncShopifyCommerceConnectionForBrand` wraps the whole transaction in a bounded retry (`MAX_PRIMARY_CONFLICT_ATTEMPTS = 3`) that catches the resulting P2002 (unique violation) or P2034 (serialization failure) and re-runs on a fresh `otherConnectedCount` read, which converges because the loser's retry sees the winner's already-committed row.

**Rollback:** `DROP INDEX "CommerceConnection_brandId_provider_primary_key";` — non-destructive. Dropping a unique index never deletes rows or column data, only the constraint, unlike the Phase-1 table-creating migration.

**As of this writing, this migration has NOT been applied to any database** (local, staging, or production).

## 5. Secret synchronization

- **Authoritative source, unchanged:** `Brand.shopifyAdminAccessTokenEncrypted` / `shopifyRefreshTokenEncrypted` via `getValidAccessToken(brandId)`. `CommerceConnectionSecret.encryptedPayload` remains write-only — nothing in this codebase reads it for authentication.
- **Mirror behavior:** `CommerceConnectionSecret` holds one `encryptSecret`-wrapped JSON blob per connection (`ShopifyConnectionSecretPayload`: `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`, `authMode`). It is rebuilt by the same `applyShopifyConnectionSync` upsert the Phase-1 dual-write already used, or narrowly (secret only, no `CommerceConnection` column touched) via `rebuildShopifyConnectionSecretForBrand` — the reconciliation helper described in §6.
- **Rotation — new in Phase 2:** `src/lib/shopify-token-manager.ts` now calls the mirror at the two points a token refresh actually commits durable state:
  1. **Winning refresh success** — after `performTokenRefresh`'s CAS `updateMany` commits (both the "we hold the lock" branch and the "takeover lock" branch), `safeSyncShopifyCommerceConnection(brandId)` re-reads the `Brand` row fresh and re-syncs the full connection + secret.
  2. **`markRequiresReconnect` success** — after the CAS-guarded status-only update to `REQUIRES_RECONNECT` commits (tokens are cleared on this transition), `safeMarkShopifyCommerceConnectionDisconnected(brandId, "REQUIRES_RECONNECT")` runs, which also deletes the secret mirror to match legacy.
  A third call site (the granted-scopes-insufficient early `NEEDS_RECONNECT` branch, before any refresh attempt) also calls `safeSyncShopifyCommerceConnection` — status changes there but the token itself is not cleared, so a full re-sync (not the disconnect-and-clear helper) is what correctly reflects that.
- **Concurrency / winner-only:** losing concurrent refreshers (the stale-writer / already-fresh / takeover-lost paths) never call the mirror at all — enforced **structurally by call-site placement** (the mirror calls sit only in the two success branches above), not by a runtime "am I the winner" guard. `tests/shopify-token-manager.test.ts`'s "mirror orchestration" describe block (tests 1–7) asserts this directly for every loser path.
- **Failure behavior:** every mirror call is wrapped in both `.catch(() => {})` at the call site and the `safe*` wrapper's own internal try/catch (sanitized `console.error`, brand id + fixed outcome tag only) — a mirror failure can never change `getValidAccessToken`'s return value or propagate to its caller.
- **`keyVersion`:** currently always written as the literal `1` (both in `applyShopifyConnectionSync` and `applyRebuildShopifyConnectionSecret`) — there is no key-rotation tracking logic beyond the column existing as a placeholder for a future rotation scheme.

## 6. Reconciliation tooling

Two scripts exist; both parse `--flag=value` with the same `getArg` convention and default to a dry run.

**`scripts/backfill-commerce-connections.ts`** (Phase 1, unchanged) — one-shot sweep that calls `syncShopifyCommerceConnectionForBrand` for every `Brand` with a non-null `shopifyShopDomain`:

```
npx tsx scripts/backfill-commerce-connections.ts                # dry run (default)
npx tsx scripts/backfill-commerce-connections.ts --apply         # writes
npx tsx scripts/backfill-commerce-connections.ts --apply --limit=50
```

**`scripts/reconcile-commerce-connections.ts`** (new in Phase 2) — a thin CLI wrapper around `src/lib/commerce/connection-reconciliation.ts`'s pure, dependency-injected `reconcileCommerceConnections`. It additionally **detects** drift categories the backfill alone doesn't surface, and running it in dry-run mode is the documented preflight for the §4 migration:

```
npx tsx scripts/reconcile-commerce-connections.ts                # dry run, all brands
npx tsx scripts/reconcile-commerce-connections.ts --apply         # writes
npx tsx scripts/reconcile-commerce-connections.ts --apply --limit=50
npx tsx scripts/reconcile-commerce-connections.ts --brand-id=abc123
npx tsx scripts/reconcile-commerce-connections.ts --shop-domain=acme.myshopify.com --apply
npx tsx scripts/reconcile-commerce-connections.ts --help
```

`--apply` is **required** to write anything — a dry run calls the exact same detection path and never invokes a write-shaped dependency function.

Detections (all reported in both modes; repairs only performed with `--apply`):

| # | Kind | Detected via | Repair |
|---|---|---|---|
| 1 | `missing_connection_row` | `detectConnectionDrift`'s `LEGACY_DOMAIN_WITHOUT_ROW` | `syncShopifyCommerceConnectionForBrand` |
| 2 | `stale_connection_metadata` | `findStaleConnectionFields` (status/displayName/storefrontUrl/grantedScopes/installedAt/uninstalledAt/lastProductSyncAt disagree with current legacy truth) or `detectConnectionDrift`'s `ROW_LEGACY_MISMATCH` | `syncShopifyCommerceConnectionForBrand` |
| 3 | `missing_secret` | `determineShopifySecretRebuildOutcome` returning `"created"` | `rebuildShopifyConnectionSecretForBrand` |
| 4 | `stale_secret_mirror` | `determineShopifySecretRebuildOutcome` returning `"rebuilt"` (decrypt-and-compare, contents never exposed) | `rebuildShopifyConnectionSecretForBrand` |
| 5 | `duplicate_primary` | More than one `isPrimary: true` row for `(brandId, SHOPIFY)` — exactly what the §4 index rejects | Keep whichever row's `externalAccountId` matches the brand's current `Brand.shopifyShopDomain` (falling back to whichever row `pickPreferredConnectionRow` would choose only when none match); clear `isPrimary` on the rest |

Other flags: `--limit=N` (first N candidate brands by id ascending), `--brand-id=<id>`, `--shop-domain=<domain>` (normalized trim+lowercase before matching), `--help`/`-h`.

**Exit codes:** `0` success (dry run: nothing failed computing the report; apply: every attempted repair succeeded) · `1` one or more per-brand operations failed, run still completed for every other brand (`report.totals.failed > 0`) · `2` invalid command-line usage (e.g. malformed `--limit`), nothing read or written.

**Idempotency:** running `--apply` a second time immediately after the first reports zero repairs needed — every detection is re-derived from current state on each run, never cached (`tests/commerce-connection-reconciliation.test.ts` test 8).

**Never printed:** a token, encrypted payload, decrypted payload, secret, or encryption key — only brand ids, shop domains, connection ids, and outcome tags (`tests/commerce-connection-reconciliation.test.ts` test 12 asserts no output line matches `/token|secret|encrypted|password/i`).

## 7. Tests

All test files below run against dependency-injected fakes/mocks — no real DB connection and no real network call, unless explicitly noted as manual/opt-in.

| Test file | Covers | Automated? |
|---|---|---|
| `tests/db-safety.test.ts` (new) | Pure classification/decision logic for `classifyDbTarget`, `canUseRealDatabaseUnderTest` (all three conditions, evaluated unconditionally — including the explicit regression test that a production Supabase host is refused even with the opt-in flag set), `assertDatabaseAccessAllowed`'s chokepoint behavior (no-op outside test mode; throws under test for any production classification), `isTestEnvironment`'s signal detection, and that no output ever leaks a password or full URL. | Yes — pure functions, no I/O. |
| `tests/commerce-connection-service.test.ts` (new) | `getActiveCommerceConnection`'s consistency-checked preference (agree/disagree/no-row/no-legacy-domain cases, case/whitespace-insensitive comparison), `detectConnectionDrift`, `getPrimaryCommerceConnection`, that every read function never calls a write-shaped Prisma method, deterministic multi-connection tiebreak, `getCommerceCapabilities`/`getAdapterForConnection` (throwing vs. non-throwing contract), `isConnectionUsable`/`connectionRequiresReconnect`, `toSafeConnectionSummary`, and the Task-2 legacy-only helpers (`isLegacyShopifyBrandConnectionUsable`, `externalAccountIdFromShopDomain`, `deriveShopifyStorefrontUrl`). | Yes — DI fakes, no DB. |
| `tests/commerce-connection-reconciliation.test.ts` (new) | The reconciliation module directly (not via subprocess): dry-run-is-zero-writes, each of the 5 detection categories, `--apply` performing repairs with totals matching real work done, duplicate-primary resolution, idempotency, brand-id/shop-domain/limit filters, per-brand failure counting without aborting the run, no-sensitive-output, and a brand with no Shopify state being skipped cleanly. | Yes — DI fakes, no DB. The CLI script itself (`scripts/reconcile-commerce-connections.ts`) is not executed by any test; only the module it wraps is. |
| `tests/shopify-route-contract-compatibility.test.ts` (new) | `brand/shopify/status` route: exact response key set/values across every connection state, context-failure branches, and identical output whether the mirror is absent/agreeing/disagreeing. `brand/shopify/products` route: exact response shape, byte-identical adapter-path vs. legacy-fallback-path output, identical failure mapping for both paths, `lastProductSyncAt` stamped only on success, no product ever persisted, provider selection going through the injected registry (never hard-coded), and COMMERCE7 remaining controlled (no network call, generic 500). | Yes — mocked deps, no DB/network. |
| `tests/shopify-reward-adapter-cutover.test.ts` (new) | Unit contract: byte-identical persisted redemption data between the adapter and legacy paths for the same Shopify response; fixed-amount/percentage and product-targeting field forwarding; minimum-subtotal forwarding; `CommerceProviderApiError`/`CommerceConnectionNotFoundError`/`UnsupportedCapabilityError` mapping to the exact legacy-equivalent `{status, error, userErrors}` shape; registry-based (not hard-coded) provider selection; COMMERCE7's `UnsupportedProviderError` never reaching the network. End-to-end `redeemImpl` tests: legacy path unaffected, legacy-failure refund unaffected, adapter path issuing via the adapter, adapter-error refund/502, `canCreateDiscount:false` failing safely with a refund, token-unavailable producing an identical refund regardless of path, idempotency unchanged, and — the fail-safe property called out in the design notes — a **throwing** commerce-connection mirror lookup still lets the redemption succeed via the legacy fallback. | Yes — mocked deps, no DB/network. Does **not** cover webhooks. |
| `tests/commerce-connection-compatibility.test.ts` (extended, +552 lines over Phase 1) | Everything Phase 1 already covered (resolver precedence, sync idempotency/relink, secret round-tripping, redaction targeting), **plus** new single-primary tests 22–26: clear-siblings-before-set ordering, two competing primary assignments for the same `(brandId, provider)` resolving to exactly one primary, a P2002 conflict being retried and resolved rather than propagating, multiple non-primary connections remaining permitted, and the bounded retry terminating (not retrying forever) under sustained conflict. | Yes — hand-rolled fake tx client that genuinely enforces the unique-key upsert behavior, no real DB. |
| `tests/shopify-token-manager.test.ts` (extended, +505 lines over Phase 1) | Everything Phase 1 already covered (token freshness, scope checks, refresh decision logic, encryption), **plus** a new "getValidAccessToken → mirror orchestration" describe block (7 tests): winning refresh calls the mirror exactly once, strictly after the CAS commits; a throwing mirror never changes the return value or propagates; every losing-refresher path (stale-writer, fresh-after-wait, not-yet-expired-fallback, takeover-lock-lost) does **not** call the mirror; a successful `markRequiresReconnect` triggers the status mirror; a failed (superseded) CAS does not; `LEGACY_OFFLINE` brands never reach the mirror. | Yes — mocked DB/network. |
| `tests/commerce-adapter-registry.test.ts`, `tests/shopify-commerce-adapter.test.ts` (touched) | Unchanged Phase-1 coverage; the only diff is adding `hasNextPage`/`limit` to fake `syncProducts` results so they match the (Phase-1) `ProductSyncResult` shape. | Yes. |
| `tests/integration-coverage.test.ts` (touched) | Adds a default `prisma.commerceConnection` mock (`findMany`/`findUnique` both returning empty/null) and several other model mocks to the shared webhook-route integration harness, so the redeem route's new commerce-mirror lookup and the token manager's new mirror calls don't break existing integration coverage by hitting an unmocked Prisma delegate. Coverage itself (webhook route behavior) is unchanged. | Yes — mocked Prisma. |
| `tests/auth-route-wrapper.test.ts`, `tests/qr-routes-hardening.test.ts`, `tests/shopify-embedded-connection.test.ts` (touched) | No coverage change — only the placeholder `DATABASE_URL` literal was updated to the new blocked-and-unreachable value (`postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked`) for consistency with `tests/env-setup.ts` and `src/lib/db-safety.ts`. | Yes. |
| `tests/point-account-concurrency.test.ts` (touched) | Real-Postgres concurrency behavior for point-account creation. Gating changed from a single `POINT_ACCOUNT_CONCURRENCY=true` env flag to that flag **AND** `canUseRealDatabaseUnderTest`'s full three-part opt-in (`ALLOW_REAL_DATABASE_TESTS=true`, a loopback/local `DATABASE_URL` host, a database name ending in `_test`). | **Manual / opt-in only** — both tests in this file are the 2 skips in the standard `npm test` run; they require a real disposable local Postgres instance and are never exercised by CI or `npm run verify` as configured. |

A webhook-focused test file may be added concurrently by a separate agent working on this same phase; it was not present in this repository at the time this document was written and its contents could not be verified here.

## 8. Migration instructions

**Nothing has been applied to any database as of this writing** — this migration exists only as a file in this repository.

1. **Preflight.** Run the duplicate-primary query from §4 against the target database and confirm zero rows; resolve any returned group per the procedure in §4 before proceeding.
2. **Apply.** `npx prisma migrate deploy` from a controlled release job (per `docs/prisma-migrations.md`'s general deployment procedure: back up first, pause reward issuance briefly, run the reviewed preflight SQL, then deploy).
3. **Verify.** Immediately after, run `npx prisma migrate status` and `npx prisma migrate diff` and confirm the expected state — do not assume success from the deploy command's exit code alone. Both commands will report the new partial index as DB-only drift (expected, per §4 — not a sign of a missed migration).
4. Then validate schema, token refresh, QR unlock deduplication, and redemption/refund behavior, per the same general procedure `docs/prisma-migrations.md` documents for every migration.

Running `scripts/reconcile-commerce-connections.ts` in dry-run mode beforehand (§6) doubles as an independent, code-level confirmation of the preflight query's result.

## 9. Manual testing

`docs/shopify-testing.md` already documents the full checklists this section cross-references rather than duplicates: "SQRATCH-First Install Checklist," "Shopify-Started Install Checklist," "Product Linking Checklist," "Product Edge Cases," "Disconnect And Uninstall Checklist," "Reward Redemption, Status Refresh, and Reconciliation Checklist," and "Compliance Webhook Checklist." Phase 1's own manual-test section (`docs/commerce/phase-1-commerce-abstraction-summary.md` §15) already added the `CommerceConnection`/`CommerceConnectionSecret` mirror-inspection steps for install/reconnect/disconnect/uninstall/webhooks — those still apply unchanged. This section adds only what's new for Phase 2: confirming the **cut-over paths** actually route through the adapter, not just that the mirror stays in sync.

- **Install** — per `docs/shopify-testing.md`'s install checklists. Unchanged from Phase 1.
- **Status** (`GET /api/brand/shopify/status`) — confirm the response is unchanged whether or not the `CommerceConnection` mirror exists yet for the brand (the route falls back field-by-field on any disagreement — see §2).
- **Reconnect** — per `docs/shopify-testing.md`'s reconnect flow. Confirm `shopifyConnectionStatus` transitions correctly reach the response via the same fallback logic as above.
- **Disconnect / Uninstall** — per `docs/shopify-testing.md`'s "Disconnect And Uninstall Checklist." Unchanged from Phase 1; these routes were not cut over in Phase 2.
- **Product fetch** (`/dashboard/brand/shopify`, "Fetch products" → `GET /api/brand/shopify/products`) — after a normal install (which already has a `CommerceConnection` row from the Phase-1 dual-write), confirm products still render correctly; this now exercises the **adapter path** (`ShopifyCommerceAdapter.syncProducts`), not the legacy direct call. To exercise the **fallback path**, test against a brand connected before any `CommerceConnection` row existed (or with the mirror row manually deleted) and confirm products still render identically via the legacy direct fetch.
- **Experience product links** (`/x/[experienceSlug]/shop`, `GET /api/public/experience/[slug]/products`) and **Lesson product links** (`/x/[experienceSlug]/lessons/[lessonId]`, `GET /api/public/experience/[slug]/lessons/[id]/products`) — per `docs/shopify-testing.md`'s "Product Linking Checklist." Confirm rendering is unchanged now that domain reads and the connectivity gate route through `connection-service.ts`'s legacy-only helpers.
- **Reward redemption** (`POST /api/rewards/shopify/redeem`) — per `docs/shopify-testing.md`'s "Reward Redemption..." checklist. For a brand with a `CommerceConnection` row, confirm the issued discount is identical whether observed before or after this cutover (this now exercises `adapter.createDiscount`). Additionally confirm a redemption still succeeds and issues correctly if the `CommerceConnection` row is (in a controlled test environment only) temporarily made unreachable — it must silently fall back to the legacy direct call, never fail the redemption.
- **Webhooks** — per `docs/shopify-testing.md`'s "Compliance Webhook Checklist." Unchanged from Phase 1; webhooks remain entirely on the legacy path (§3) — this cutover made no change to them.

## 10. Remaining legacy dependencies

All 16 `Brand.shopify*` columns remain the sole authoritative source for authentication and are still read directly by at least one live code path:

| Column | Still-authoritative for |
|---|---|
| `shopifyShopDomain` | `getValidAccessToken`, every connectivity gate, the status route's emitted `shopifyShopDomain` field. |
| `shopifyAdminAccessTokenEncrypted` | The sole access-token source (`getValidAccessToken`); `hasShopifyAccessToken` on the status route. |
| `shopifyInstalledAt` | Fallback for the status route when the mirror isn't trusted. |
| `shopifyDisconnectedAt` | Read directly by the status route always (no neutral equivalent field exists at all). |
| `shopifyUninstalledAt` | Fallback for the status route when the mirror isn't trusted. |
| `shopifyConnectionStatus` | The `requiresReconnect` computation and fallback for the status route. |
| `shopifyLastProductSyncAt` | Fallback for the status route when the mirror isn't trusted; also stamped directly by the products route regardless of which fetch path ran. |
| `shopifyCurrencyCode` | Read directly by the status route always (no neutral equivalent field exists at all). |
| `shopifyAccessTokenExpiresAt` | `getValidAccessToken`'s freshness check; the status route's `shopifyAccessTokenExpiresAt` field (never sourced from the neutral service). |
| `shopifyRefreshTokenEncrypted` | The sole refresh-token source for `EXPIRING_OFFLINE` brands. |
| `shopifyRefreshTokenExpiresAt` | `getValidAccessToken`'s refresh-eligibility check. |
| `shopifyGrantedScopes` | `hasSufficientScopes`; the status route's `shopifyGrantedScopes` field (never sourced from the neutral service). |
| `shopifyClientId` | Token exchange / refresh request construction. |
| `shopifyTokenRefreshLockedUntil` | The CAS concurrent-refresh lease — untouched, race-critical. |
| `shopifyTokenRefreshLockId` | The CAS lease owner id — untouched, race-critical. |
| `shopifyAuthMode` | `getValidAccessToken`'s LEGACY_OFFLINE vs. EXPIRING_OFFLINE branch; the status route's `shopifyAuthMode` field (never sourced from the neutral service). |

Also still legacy-backed in full: `src/lib/reward-reconciliation.ts`, every webhook route, the install/relink transaction, `src/lib/shopify-embedded-connection.ts`, `src/lib/brand-auth.ts`, and the redeem route's point-reservation transaction (§3).

## 11. Known risks

- **Mirror drift is possible and detected, not prevented.** The dual-write (`connection-sync.ts`) remains best-effort; nothing blocks a brand from having a stale or missing `CommerceConnection`/`CommerceConnectionSecret` row indefinitely until the next lifecycle event, a manual backfill, or a `reconcile-commerce-connections.ts --apply` run. `getActiveCommerceConnection`'s consistency check only compares `externalAccountId`, not `status`/timestamps — a route reading the "trusted" mirror through it (products, redeem) can still receive a `status` that disagrees with legacy without that being flagged as drift.
- **The single-primary partial unique index has not been applied to any database.** Every guarantee in §4 (index behavior, retry convergence under a real constraint violation) is verified only against the hand-rolled in-memory fake transaction client in `tests/commerce-connection-compatibility.test.ts`, not a live Postgres instance.
- **Reconciliation is still legacy-backed at its root.** `reconcileCommerceConnections` repairs the mirror **from** legacy `Brand.shopify*` truth — it has no way to detect or repair legacy data itself being wrong, and it never touches `Brand` columns.
- **Webhooks remain entirely on the legacy path.** No part of the compliance-critical GDPR/mandatory-topic handling exercises the adapter or the neutral connection service; a future cutover here carries the highest risk of the remaining candidates given the retry/deadline constraints in §3.
- **The test-suite database-safety guard is a fail-closed backstop, not a substitute for correct configuration.** `assertDatabaseAccessAllowed` is a complete no-op outside a detected test process — production and normal dev behavior are unaffected by its presence. Under test, any production-classified or unparseable `DATABASE_URL` throws immediately at `src/lib/prisma.ts`'s module load, before any query can execute; a loopback/local host is always allowed to construct a client under test (so the rest of the suite's mocked delegates still work), but only a URL satisfying all three of `canUseRealDatabaseUnderTest`'s conditions (opt-in flag, loopback host, `_test`-suffixed database name) may actually reach a real database — and `tests/point-account-concurrency.test.ts` is, today, the only test file that exercises that real-database path at all, and only when a developer explicitly opts in locally (§7). It is not exercised by `npm test`/`npm run verify` as configured.
- **`revokeDiscount` remains unimplemented** (carried over from Phase 1, unchanged) — `canRevokeDiscount: false` accurately reflects that no discount-revocation call exists anywhere in this codebase.

## 12. Readiness for the next phase (provider-neutral persisted product catalog)

Before a `Product` table (or any persisted, provider-neutral catalog) can be introduced on top of this abstraction:

1. **Apply the §4 migration** and confirm the single-primary invariant holds against a real database, not just the in-memory fakes.
2. **Run the backfill and reconciliation tooling** (`scripts/backfill-commerce-connections.ts --apply`, then `scripts/reconcile-commerce-connections.ts --apply`) against production so every existing Shopify-connected brand has an up-to-date `CommerceConnection` row — a persisted catalog keyed on `CommerceConnection.id` would otherwise silently exclude any brand still resolving through the legacy fallback.
3. **Close the mirror-drift gap**, or explicitly design the catalog's sync job to tolerate it — today a stale `status` on an otherwise-domain-agreeing mirror row is invisible to `detectConnectionDrift`; a background catalog sync keyed on "is this connection `CONNECTED`" needs a stronger signal than what §2's routes currently rely on.
4. **Give `reward-reconciliation.ts` a real discount-lookup path** through the adapter (§3) before assuming `CommerceAdapter` is a complete substitute for the legacy discount services anywhere in the reward flow.
5. **Decide whether webhooks route through the adapter** before or independently of the catalog work — a persisted catalog likely needs `app/uninstalled`/`shop/redact` to correctly invalidate cached products, which argues for closing that gap earlier rather than later, notwithstanding the GDPR-deadline caution in §3.
