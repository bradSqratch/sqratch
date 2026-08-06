# Phase 1: Commerce Abstraction Summary

SQRATCH is moving from a Shopify-only integration to a multi-provider commerce model (Shopify today, Commerce7 later). Phase 1 introduces the abstraction layer only — no Commerce7 adapter, no behavior change on any existing route, no database migration applied to any environment. This document is the record of what Phase 1 actually built, verified against the code in this repository (not the plan that preceded it).

## 1. Why the abstraction was introduced

Every Shopify-specific piece of state and behavior in SQRATCH was, before Phase 1, wired directly to Shopify: 16 columns on `Brand`, direct calls into `src/lib/shopify-products.ts` / `src/lib/shopify-discounts.ts` / `src/lib/shopify-token-manager.ts` from routes, and Shopify-shaped types (`shopifyProductGid`, shop domains) leaking into business logic. Adding a second commerce provider (Commerce7) on top of that would mean duplicating every call site rather than extending one. Phase 1 introduces a provider-neutral `CommerceAdapter` interface and a `CommerceAdapterRegistry` that a future Commerce7 adapter can register against, plus a `CommerceConnection` / `CommerceConnectionSecret` data model that can represent a connection to any provider, not just Shopify. Deliberately out of scope for Phase 1: routing any existing request through this new layer, or building anything Commerce7-specific. Phase 1 is the seam, not the cutover.

## 2. Current (pre-Phase-1) architecture

- All Shopify connection state lives directly on `Brand` — 16 `shopify*` columns (domain, encrypted tokens, expiries, status, auth mode, refresh lease, etc.), listed in full in §11.
- There is no `Product` table. Products are fetched live from Shopify's Admin GraphQL API on every request via `fetchNormalizedShopifyProducts` (`src/lib/shopify-products.ts`) and never persisted.
- There is no discount-revocation call anywhere in the codebase. Discount codes are created via `createShopifyRewardDiscountCode` (`src/lib/shopify-discounts.ts`) and only ever polled for usage status, never deactivated.
- Business routes (installation, disconnect, webhooks, product fetch, reward redemption) call the Shopify-specific services directly. There is no adapter layer and no registry.

## 3. New architecture

```
                     ┌─────────────────────────────┐
                     │   Business services/routes   │
                     │  (Phase 1: NOT yet wired in  │
                     │   — see D1 below)             │
                     └──────────────┬────────────────┘
                                    │  CommerceAdapter interface
                                    ▼
                     ┌─────────────────────────────┐
                     │   CommerceAdapterRegistry     │
                     │   (src/lib/commerce/registry) │
                     │   provider -> adapter factory │
                     └──────────────┬────────────────┘
                     ┌──────────────┴────────────────┐
                     ▼                                ▼
        ┌─────────────────────────┐      ┌──────────────────────────┐
        │  ShopifyCommerceAdapter  │      │  COMMERCE7 (unregistered) │
        │  wraps existing, un-     │      │  registry.get(COMMERCE7)  │
        │  modified Shopify        │      │  throws                  │
        │  services (§9)           │      │  UnsupportedProviderError │
        └─────────────┬─────────────┘      └──────────────────────────┘
                      │
                      ▼
        ┌───────────────────────────────────────────┐
        │  Existing Shopify services (unmodified):    │
        │  shopify-products.ts, shopify-discounts.ts, │
        │  shopify-token-manager.ts, shopify.ts        │
        └───────────────────────────────────────────┘

  Separately, a best-effort dual-write (src/lib/commerce/connection-sync.ts)
  runs AFTER each install/disconnect/uninstall/redact transaction commits,
  keeping CommerceConnection / CommerceConnectionSecret in sync with the
  legacy Brand.shopify* columns. See D2 and §10.
```

`src/lib/commerce/index.ts` is the public barrel: it re-exports the `CommerceAdapter` type, the registry, the default wired-up registry (`defaultCommerceAdapterRegistry`), the error classes, and every neutral type from `types.ts`. Nothing in `src/lib/commerce/` other than `providers/shopify-commerce-adapter.ts` and `default-registry.ts` imports anything Shopify-specific — `registry.ts`, `adapter.ts`, `types.ts`, and `errors.ts` are provider-agnostic by construction.

## 4. New Prisma models and enums

Source: `prisma/schema.prisma`.

### `CommerceProvider` (enum)

| Value | Meaning |
|---|---|
| `SHOPIFY` | Registered adapter exists (`ShopifyCommerceAdapter`). |
| `COMMERCE7` | Enum value only — no adapter registered. `defaultCommerceAdapterRegistry.get(CommerceProvider.COMMERCE7)` throws `UnsupportedProviderError`. |

### `CommerceConnectionStatus` (enum)

| Value | Meaning |
|---|---|
| `PENDING` | No legacy equivalent — reserved for connection flows that have started but not completed (not produced by Phase 1 code). |
| `CONNECTED` | Maps 1:1 from legacy `ShopifyConnectionStatus.CONNECTED`. |
| `REQUIRES_RECONNECT` | Maps 1:1 from legacy `ShopifyConnectionStatus.REQUIRES_RECONNECT`. |
| `DISCONNECTED` | Maps 1:1 from legacy `ShopifyConnectionStatus.DISCONNECTED`. Also the model's default. |
| `UNINSTALLED` | Maps 1:1 from legacy `ShopifyConnectionStatus.UNINSTALLED`. |
| `ERROR` | No legacy equivalent — used as the defensive fallback when `mapLegacyShopifyStatusToCommerceStatus` receives a value it doesn't recognize, so an anomaly surfaces as `ERROR` rather than being silently reported as a real status. |

### `CommerceConnection`

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `brandId` | `String` | FK to `Brand.id`, `onDelete: Cascade`. |
| `provider` | `CommerceProvider` | |
| `status` | `CommerceConnectionStatus` | `@default(DISCONNECTED)`. |
| `displayName` | `String` | Human-readable label, e.g. the shop domain minus `.myshopify.com`. |
| `externalAccountId` | `String` | Provider-side account identifier; for Shopify this is the shop domain. |
| `storefrontUrl` | `String?` | |
| `providerClientId` | `String?` | Mirrors `Brand.shopifyClientId` for Shopify. |
| `isPrimary` | `Boolean @default(false)` | Enforced in application logic, not a DB constraint — see §13. |
| `grantedScopes` | `Json?` | Array of granted scope strings. |
| `providerMetadata` | `Json?` | Provider-specific extra data; for Shopify, `{ authMode, currencyCode }`. |
| `installedAt` | `DateTime?` | |
| `uninstalledAt` | `DateTime?` | |
| `lastProductSyncAt` | `DateTime?` | |
| `createdAt` / `updatedAt` | `DateTime` | Standard timestamps. |

Relations: `brand Brand @relation(...)`, `secret CommerceConnectionSecret?` (one-to-one, optional). Back-relation on `Brand`: `commerceConnections CommerceConnection[]`.

Indexes/constraints: `@@unique([provider, externalAccountId])`, `@@index([brandId])`, `@@index([brandId, provider])`, `@@index([brandId, isPrimary])`, `@@index([provider, status])`. There is **no** `@@unique([brandId, provider])` — a brand may in principle have multiple connections for the same provider (e.g. multiple Shopify stores), which is why the resolver needs a tiebreak rule (§10).

### `CommerceConnectionSecret`

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `connectionId` | `String @unique` | FK to `CommerceConnection.id`, `onDelete: Cascade`. One secret row per connection. |
| `encryptedPayload` | `String` | One encrypted JSON blob per connection (via `encryptSecret`/`decryptSecret` in `src/lib/crypto.ts`), not individual token columns — so the credential shape can evolve without a schema change. |
| `keyVersion` | `Int @default(1)` | |
| `rotatedAt` | `DateTime?` | |
| `expiresAt` | `DateTime?` | Not currently populated by the Phase-1 sync code (the payload itself carries per-token expiries instead). |
| `createdAt` / `updatedAt` | `DateTime` | |

Write-only in Phase 1 — see D3 in §13 and §10.

## 5. Migration strategy

Migration: `prisma/migrations/20260806120000_add_commerce_connection_abstraction/migration.sql`.

- **Purely additive.** Creates two new enums (`CommerceProvider`, `CommerceConnectionStatus`), two new tables (`CommerceConnection`, `CommerceConnectionSecret`) with their indexes, and two foreign keys. It does not alter, rename, or drop any existing table, column, or enum, and does not read or write any existing row.
- **Forward-only in practice.** The migration file documents a rollback (`DROP TABLE`/`DROP TYPE`) in a trailing comment block, but that rollback is only safe while both new tables are empty — once any row exists (from the dual-write or the backfill script), dropping the tables loses that data permanently, and the Postgres enum types cannot be trivially removed once any column default depends on them.
- **Not yet applied to any database.** As of this writing the migration exists only as a file in this repository; it has not been run against local, staging, or production. `npx prisma migrate deploy` has not been executed for it.
- Documented alongside the rest of the migration history in `docs/prisma-migrations.md` under "Commerce connection abstraction," including the same rollback caveat.

## 6. Backfill strategy

Script: `scripts/backfill-commerce-connections.ts`.

```bash
npx tsx scripts/backfill-commerce-connections.ts                # dry run (default)
npx tsx scripts/backfill-commerce-connections.ts --apply         # writes
npx tsx scripts/backfill-commerce-connections.ts --apply --limit=50
```

- **Defaults to dry-run.** Writing requires the explicit `--apply` flag (`const apply = process.argv.includes("--apply"); const dryRun = !apply;`), matching the existing convention in `scripts/import-legacy-printed-stickers.ts`. A dry run only logs which brands *would* be synced (`brand.id` + shop domain) and never calls the writer function at all — not even indirectly.
- `--limit=<n>` caps how many brands are processed (must be a positive integer, or the script throws before doing anything).
- Selects every `Brand` where `shopifyShopDomain` is not null, ordered by `id`, and — in apply mode — calls `syncShopifyCommerceConnectionForBrand(brand.id)` for each (the exact same function the Phase-1 dual-write calls at install time).
- **Idempotent.** The underlying upsert is keyed on `CommerceConnection`'s `@@unique([provider, externalAccountId])` constraint, so re-running the script against an already-synced brand always resolves to `"updated"` for that brand, never a duplicate `"created"` row. This is verified in `tests/commerce-connection-compatibility.test.ts` test 14 ("Backfill idempotency").
- Tallies and prints `Created` / `Updated` / `Skipped` / `Failed` counts; exits non-zero if any brand failed. Never logs a token, encrypted payload, or the encryption key — only brand id, shop domain, and (on failure) the error's `name`.
- This script is also the remedy for the D3 secret-staleness caveat (§13): re-running it (with `--apply`) refreshes `CommerceConnectionSecret` from the current `Brand` columns for every brand with a shop domain.

## 7. Adapter contract

Interface: `src/lib/commerce/adapter.ts`.

```ts
export interface CommerceAdapter {
  readonly provider: CommerceProvider;
  getCapabilities(): CommerceCapabilities;
  getConnection(connectionId: string): Promise<CommerceConnectionResult>;
  syncProducts(connectionId: string): Promise<ProductSyncResult>;
  createDiscount?(connectionId: string, input: CreateDiscountInput): Promise<ProviderDiscount>;
  revokeDiscount?(connectionId: string, externalDiscountId: string): Promise<void>;
  verifyAndParseWebhook?(connectionId: string, input: WebhookRequestInput): Promise<NormalizedWebhookEvent>;
}
```

| Method | Required? | Meaning |
|---|---|---|
| `provider` | required | Which `CommerceProvider` this adapter implements. |
| `getCapabilities()` | required | Reports which optional methods are actually implemented, via `CommerceCapabilities` (`canSyncProducts`, `canCreateDiscount`, `canRevokeDiscount`, `canVerifyWebhooks`). Callers feature-detect through this before calling an optional method, rather than probing for `undefined` directly (though both work — see `adapter.revokeDiscount === undefined` in the registry tests). |
| `getConnection(connectionId)` | required | Looks up a `CommerceConnection.id` and returns a `CommerceConnectionResult`: `{ ok: true, connection }` or a typed failure (`NOT_FOUND` / `NOT_CONNECTED`) — never a throw for a routine "not connected" case. |
| `syncProducts(connectionId)` | required | Fetches and normalizes the connection's live product catalog. There is no `Product` table, so "sync" means "fetch, normalize, and report a timestamp," not "reconcile against stored rows." |
| `createDiscount(connectionId, input)` | **optional** | Only present on adapters whose `getCapabilities().canCreateDiscount` is `true`. |
| `revokeDiscount(connectionId, externalDiscountId)` | **optional** | Only present on adapters whose `getCapabilities().canRevokeDiscount` is `true`. **No adapter in this codebase implements it** — see §13/§14. |
| `verifyAndParseWebhook(connectionId, input)` | **optional** | Only present on adapters whose `getCapabilities().canVerifyWebhooks` is `true`. Takes a framework-neutral `WebhookRequestInput` (`{ rawBody, headers }`), deliberately not `NextRequest`. |

`connectionId` parameters are always a `CommerceConnection.id` (the Prisma model's own id), never a provider-side account id — this is stated explicitly in the file header and holds throughout `ShopifyCommerceAdapter`.

## 8. Adapter registry

`src/lib/commerce/registry.ts` — `CommerceAdapterRegistry` maps a `CommerceProvider` to a lazily-constructed, memoized `CommerceAdapter`, built from a `Partial<Record<CommerceProvider, CommerceAdapterFactory>>` supplied at construction. `registry.ts` itself imports nothing Shopify-specific, so it (and its tests, `tests/commerce-adapter-registry.test.ts`) exist independently of any concrete provider.

- `get(provider)`: returns the memoized adapter, constructing it via the registered factory on first access. If no factory is registered for `provider`, it throws `UnsupportedProviderError` (a `CommerceError` subclass). It **never** returns `undefined` or `null`, and never performs a network call itself — only the adapter's own methods do.
- `tryGet(provider)`: non-throwing variant, returns `null` for an unsupported provider instead of throwing.

`src/lib/commerce/default-registry.ts` wires the production registry: `SHOPIFY -> () => new ShopifyCommerceAdapter()`. `COMMERCE7` is deliberately left unregistered — `defaultCommerceAdapterRegistry.get(CommerceProvider.COMMERCE7)` throws `UnsupportedProviderError`, never makes a network call, and never returns `undefined`. This is exercised directly: `tests/commerce-adapter-registry.test.ts` proves the unregistered-provider path with a fake adapter (before `ShopifyCommerceAdapter` even existed, chronologically), and `tests/shopify-commerce-adapter.test.ts` test 13 proves the same against the real `defaultCommerceAdapterRegistry`.

Importing `default-registry.ts` (or the `src/lib/commerce` barrel) never opens a DB connection or requires `DATABASE_URL` — `createCommerceAdapterRegistry` only stores the factory function without invoking it, and `ShopifyCommerceAdapter`'s constructor only stores its (lazily-resolving) dependencies.

## 9. Shopify adapter

`src/lib/commerce/providers/shopify-commerce-adapter.ts` — `ShopifyCommerceAdapter` is a **wrapper**, not a rewrite. It delegates every Shopify API call, token-refresh decision, and discount-code shape unchanged to four existing, unmodified services:

| Wrapped service | Used for |
|---|---|
| `@/lib/shopify-products` (`fetchNormalizedShopifyProducts`) | `syncProducts` |
| `@/lib/shopify-discounts` (`createShopifyRewardDiscountCode`) | `createDiscount` |
| `@/lib/shopify-token-manager` (`getValidAccessToken`) | Resolving an access token before calling `createDiscountCode` |
| `@/lib/shopify` (`verifyShopifyWebhookHmac`) | `verifyAndParseWebhook` |

Nothing in this file talks to the Shopify Admin API directly. Every dependency (DB read/write for `CommerceConnection`, and the four services above) is injectable via `ShopifyCommerceAdapterDeps`, so the full test suite (`tests/shopify-commerce-adapter.test.ts`) runs against fakes with no real DB and no real network.

`getCapabilities()` returns:

```ts
{
  canSyncProducts: true,
  canCreateDiscount: true,
  canRevokeDiscount: false,   // no discountCodeDeactivate call exists anywhere in this codebase
  canVerifyWebhooks: true,
}
```

`revokeDiscount` is not defined on the class at all — `canRevokeDiscount: false` and the absence of the method are kept consistent so callers can feature-detect via `getCapabilities()` before ever touching `adapter.revokeDiscount`. Adding an implementation would be **new behavior**, not preserved behavior — no discount revocation exists anywhere in this codebase today.

### Product field mapping (`CommerceProduct` <-> `NormalizedShopifyProduct`)

| Neutral (`CommerceProduct`) | Shopify (`NormalizedShopifyProduct`) |
|---|---|
| `externalId` | `shopifyProductGid` |
| `title` | `title` |
| `handle` | `handle` |
| `productUrl` | `productUrl` |
| `imageUrl` | `imageUrl` |
| `images` | `images` |
| `priceText` | `priceText` |
| `currency` | `currency` |

`NormalizedShopifyProduct` additionally carries `id`, `priceRange { min, max }`, and `variantIds`, none of which cross the neutral boundary — `tests/shopify-commerce-adapter.test.ts` test 5 explicitly asserts the mapped `CommerceProduct` does not carry the `shopifyProductGid` key.

### Discount field mapping (`CreateDiscountInput` -> `createShopifyRewardDiscountCode` input, and its result -> `ProviderDiscount`)

| Neutral (`CreateDiscountInput`) | Shopify (`createShopifyRewardDiscountCode` input) |
|---|---|
| `code` | `code` |
| `title` | `title` |
| `issuedAt` | `issuedAt` |
| `validDays` | `codeValidDays` |
| `discountType` | `discountType` |
| `discountAmountCents` | `discountAmountCents` |
| `discountPercentageBasisPoints` | `discountPercentageBasisPoints` |
| `appliesTo` | `appliesTo` |
| `externalProductIds` | `shopifyProductGids` |
| `minimumSubtotalCents` | `minimumSubtotalCents` |
| (adapter-resolved, not on the input type) | `shopDomain` (from the connection row), `accessToken` (from `getValidAccessToken`) |

| Shopify result | Neutral (`ProviderDiscount`) |
|---|---|
| `discountNodeId` | `externalDiscountId` |
| `code` | `code` |
| `endsAt` | `expiresAt` |

This mapping matches exactly what `src/app/api/rewards/shopify/redeem/route.ts` passes to `createShopifyRewardDiscountCode` today (verified by reading that route and `tests/shopify-commerce-adapter.test.ts` test 7) — the existing single-use (`usageLimit: 1`) semantics are unchanged, since that value is hardcoded inside `createShopifyRewardDiscountCode` itself, which the adapter does not touch.

`verifyAndParseWebhook` reads `SHOPIFY_API_SECRET` from the environment, verifies the HMAC via the injected `verifyWebhookHmac` (default: the real `verifyShopifyWebhookHmac`), and maps the `x-shopify-topic` header to a neutral `CommerceWebhookEventType` via a fixed table covering exactly the four topics this app handles today:

| Shopify topic | Neutral `CommerceWebhookEventType` |
|---|---|
| `app/uninstalled` | `APP_UNINSTALLED` |
| `shop/redact` | `ACCOUNT_REDACT` |
| `customers/data_request` | `CUSTOMER_DATA_REQUEST` |
| `customers/redact` | `CUSTOMER_REDACT` |

Header lookup (`x-shopify-hmac-sha256`, `x-shopify-topic`, `x-shopify-shop-domain`) is case-insensitive, since inbound webhook headers may arrive in any case; this is exercised directly in `tests/shopify-commerce-adapter.test.ts` test 12. Verification is scoped to the shared app secret plus the shop-domain header, not to a specific `CommerceConnection` row — exactly like the existing `verifyShopifyWebhookRequest` used by the real webhook routes, none of which look up a connection before verifying.

## 10. Legacy compatibility

Two files carry the Phase-1 legacy/neutral compatibility layer: `src/lib/commerce/connection-resolver.ts` (read side) and `src/lib/commerce/connection-sync.ts` (write side / dual-write).

### Resolver precedence (`resolveCommerceConnectionForBrand`)

1. Prefer an existing `CommerceConnection` row for `(brandId, provider)`. If more than one exists — not expected today, but not prevented by the schema (no `@@unique([brandId, provider])`) — `pickPreferredConnectionRow` picks deterministically:
   a. `isPrimary: true` wins over `isPrimary: false`.
   b. Otherwise, the row with the most recent `installedAt` wins (rows with a null `installedAt` sort last).
   c. Otherwise, the row with the most recent `createdAt` wins.
2. If no `CommerceConnection` row exists, derive a legacy fallback summary from `Brand.shopify*` columns (`SHOPIFY` only — there is no legacy column set for any other provider). The result has `id: null` and `isLegacyFallback: true`.
3. If the brand doesn't exist, or exists but has no `shopifyShopDomain` on record (never connected, or fully redacted), the resolver returns `null` rather than a bogus empty summary.

`CommerceConnectionSummary` never carries a credential field by construction, and neither this resolver nor the sync module ever reads `CommerceConnectionSecret` or `Brand.shopifyAdminAccessTokenEncrypted` — `tests/commerce-connection-compatibility.test.ts` test 11 asserts `JSON.stringify()` of every summary shape never matches `/token|secret|encrypted|password/i`.

### Dual-write points (D2)

Every write into `CommerceConnection`/`CommerceConnectionSecret` happens through one of three best-effort wrapper functions in `connection-sync.ts`, called from a route **after** the existing legacy-column transaction has already committed — never from inside it. This is Phase-1 decision D2: a failed statement inside a Postgres transaction aborts the whole transaction, so running the dual-write inside the existing Serializable install transaction could turn a working install into a failed one over a mirror-table hiccup. Each wrapper runs the real operation in its **own** transaction and swallows any error with a sanitized `console.error` (brand id + a fixed outcome tag, never the underlying error object) — it can never throw into the caller. Consequence: if the dual-write fails, the legacy install/disconnect/webhook request still succeeds, and the mirror row is repaired by the next lifecycle event or a backfill re-run.

The five modified routes and which wrapper they call, verified via `git diff` against each file:

| Route | Wrapper called | When |
|---|---|---|
| `src/app/api/shopify/installations/[installId]/route.ts` | `safeSyncShopifyCommerceConnection(brand.id)` | After the install/link transaction commits. |
| `src/app/api/brand/shopify/disconnect/route.ts` | `safeMarkShopifyCommerceConnectionDisconnected(brandId, "DISCONNECTED")` | After the manual-disconnect transaction commits. |
| `src/app/api/shopify/embedded/disconnect/route.ts` | `safeMarkShopifyCommerceConnectionDisconnected(brand.id, "DISCONNECTED")` | After the embedded-app disconnect transaction commits. |
| `src/app/api/shopify/webhooks/app/uninstalled/route.ts` | `safeSyncShopifyCommerceConnection(uninstalledBrandId)` | After the uninstall transaction commits, and only if a matching brand was found. A full sync (not just a status mark) is used because `shopifyShopDomain` is preserved on uninstall, so it can still correctly re-derive the row — this also self-heals if the original install-time dual-write never ran. |
| `src/app/api/shopify/webhooks/shop/redact/route.ts` | `safeDeleteShopifyCommerceConnectionByShopDomain(shopDomain)` | After the redaction transaction commits. Deliberately **not** gated on the brand lookup: it is keyed on the redacted shop domain, so redaction still erases the row when the brand has since relinked to a different shop and no brand matches the redacted domain any more. |

### Idempotency and relink

The write path is keyed on `CommerceConnection`'s `@@unique([provider, externalAccountId])` constraint via `prisma.commerceConnection.upsert(...)`. Re-running a sync for the same shop domain always updates the same row — it can never create a duplicate (`tests/commerce-connection-compatibility.test.ts` test 7). Relink (a shop domain moving from brand A to brand B, mirroring the installations route's existing relink semantics) is handled by the same upsert: the `update` branch reassigns `brandId` on the same row rather than creating a second one, since the unique index is on `[provider, externalAccountId]`, not `[brandId, provider]` — a shop domain can only ever be "owned" by one `CommerceConnection` row at a time, exactly like `Brand.shopifyShopDomain @unique` today (test 8).

### Single-primary enforcement

There is no DB partial-unique-index for "at most one primary connection per `(brand, provider)`" — it is enforced in application logic, inside the same transaction as the upsert: a connection becomes primary iff the brand has no *other* `CONNECTED` connection for that provider (excluding this shop domain's own row), and whenever that resolves to `true`, every other connection for `(brand, provider)` has `isPrimary` cleared in the same transaction (tests 9 and 9b).

### Redaction handling

`shop/redact` nulls `Brand.shopifyShopDomain` entirely, so a `CommerceConnection` row keyed on that domain (`externalAccountId`) can no longer be correctly re-derived or re-keyed. Rather than leaving it pointing at a redacted shop, `safeDeleteShopifyCommerceConnectionByShopDomain` deletes the row outright — the secret cascades via `onDelete: Cascade` — mirroring the legacy erase-everything intent documented in `docs/shopify-data-inventory.md` §5 for this webhook.

The delete is keyed on `(provider, externalAccountId)`, **not** on the brand id. That matters in two cases the independent review surfaced: (a) if the brand relinked to a different shop between `app/uninstalled` and the 48-hour `shop/redact`, no brand row still carries the redacted domain, and a brand-keyed delete would silently skip the erase; (b) once a brand legitimately holds several Shopify connections, a brand-keyed delete would remove all of them instead of only the redacted shop's row. Both cases are covered by tests 15–19 in `tests/commerce-connection-compatibility.test.ts`.

### Secret mirror (D3)

See §13 for the full statement of this decision and its known consequence.

## 11. Existing fields intentionally retained

All 16 `Brand.shopify*` columns remain exactly as they were before Phase 1 — none were removed, renamed, or altered by the schema change or the migration:

| Column | Purpose |
|---|---|
| `shopifyShopDomain` | The connected shop's domain; `@unique`. |
| `shopifyAdminAccessTokenEncrypted` | AES-encrypted offline access token. |
| `shopifyInstalledAt` | Installation timestamp. |
| `shopifyDisconnectedAt` | Manual-disconnect timestamp. |
| `shopifyUninstalledAt` | Uninstall timestamp. |
| `shopifyConnectionStatus` | `ShopifyConnectionStatus` enum — drives all Shopify features today. |
| `shopifyLastProductSyncAt` | Timestamp of last product sync. |
| `shopifyCurrencyCode` | Three-letter ISO currency code fetched from the shop. |
| `shopifyAccessTokenExpiresAt` | Access token expiry (expiring-token mode). |
| `shopifyRefreshTokenEncrypted` | AES-encrypted refresh token (expiring-token mode). |
| `shopifyRefreshTokenExpiresAt` | Refresh token expiry. |
| `shopifyGrantedScopes` | Comma-separated granted OAuth scopes. |
| `shopifyClientId` | The app's own OAuth client id for this installation. |
| `shopifyTokenRefreshLockedUntil` | CAS lease expiry for concurrent token-refresh prevention. |
| `shopifyTokenRefreshLockId` | CAS lease owner id. |
| `shopifyAuthMode` | `ShopifyAuthMode` enum (`LEGACY_OFFLINE` / `EXPIRING_OFFLINE`). |

These remain the sole authentication and read path in Phase 1 — see D1 and D3 in §13.

## 12. Tests performed

All three commerce test files run against fakes/mocks — no real DB connection and no real network call is made in any of them.

| Test file | Covers | Result |
|---|---|---|
| `tests/commerce-adapter-registry.test.ts` | The registry in isolation, via a fake in-memory adapter (built before `ShopifyCommerceAdapter` existed): SHOPIFY resolves to the registered factory; repeated `get()` memoizes and the factory runs exactly once; COMMERCE7 throws `UnsupportedProviderError` (which is also a `CommerceError`) naming the provider; the registry never returns `undefined`/`null` for any `CommerceProvider` value; requesting COMMERCE7 never invokes the SHOPIFY factory; `canRevokeDiscount: false` implies no `revokeDiscount` method; `tryGet()` returns `null` instead of throwing. | Automated, passing. |
| `tests/shopify-commerce-adapter.test.ts` | `ShopifyCommerceAdapter` with every dependency injected: capability flags; `getConnection` for known/missing/non-`CONNECTED` connections; `syncProducts` delegation, product mapping, and `lastProductSyncAt` stamping; `syncProducts` on a missing connection; `createDiscount` field mapping and each non-ok token-result variant; `verifyAndParseWebhook` with a **real, computed HMAC** (via `node:crypto`, not a stubbed-true check) for valid/invalid signatures, an unknown topic, and case-insensitive headers; and registry integration against the real `defaultCommerceAdapterRegistry`. | Automated, passing. The webhook-HMAC tests are genuine signature checks, not rubber stamps — a deliberate design choice noted in the file header. |
| `tests/commerce-connection-compatibility.test.ts` | The resolver's precedence/fallback/null cases and multi-connection tiebreak; legacy status mapping for all four `ShopifyConnectionStatus` values plus an unknown-value fallback to `ERROR`; `grantedScopes` normalization (comma string, JSON array, null, non-array JSON); the sync module's idempotency, relink reassignment, and single-primary enforcement against a hand-rolled in-memory fake Prisma transaction client that genuinely enforces the `@@unique([provider, externalAccountId])` upsert-key behavior (not a hand-waved assertion); secret encryption round-tripping through `decryptSecret`; secret exclusion from every summary shape; a disconnected/uninstalled brand having its secret deleted rather than written empty; `safeSyncShopifyCommerceConnection` swallowing both a `findBrandForSync` throw and a transaction throw without rethrowing; and backfill-loop idempotency (running the sync loop twice against a shared fake store creates nothing new on the second pass). | Automated, passing. |

Repository-wide verification measured at the time of writing: `npx prisma validate` passed; `npx prisma generate` passed; `npm run typecheck` passed; `npm run lint` passed; `npm test` reported 568 tests, 566 passing, 2 pre-existing skips (unrelated to this change), 0 failing; `npm run build` passed.

**What is NOT automated and still requires manual testing** (see §15 for exact steps): every route this dual-write touches, exercised end-to-end against a real Shopify store and a real database — install, disconnect (both the dashboard and embedded-app paths), the `app/uninstalled` and `shop/redact` webhooks, and confirming the `CommerceConnection`/`CommerceConnectionSecret` rows actually land correctly once the migration is applied to a real database. None of the unit tests above touch a real database, so they cannot catch a Postgres-level constraint violation, a Prisma client/schema mismatch against an actual applied migration, or a real Shopify API response shape drifting from the fakes.

## 13. Known risks

- **D3 — secret staleness (by design, not a bug).** `CommerceConnectionSecret.encryptedPayload` is write-only in Phase 1; nothing reads it for authentication. `getValidAccessToken(brandId)` against `Brand` columns (`src/lib/shopify-token-manager.ts`, not modified by this work) remains the sole auth path, because its compare-and-swap refresh lock is concurrency-sensitive and was deliberately left untouched. Consequence: for `EXPIRING_OFFLINE` brands whose access tokens rotate between lifecycle events (install/disconnect/uninstall), the mirrored secret can go stale — it is only refreshed when a lifecycle event fires or the backfill script (§6) is re-run. Phase 2 must re-sync every connection at cutover before treating this mirror as authoritative for anything.
- **D2 — best-effort dual-write failure mode.** The dual-write can silently fail (network blip, encryption error, DB hiccup) without surfacing anywhere except a sanitized server log line — there is no alerting, retry queue, or reconciliation job for it in Phase 1 beyond "the next lifecycle event or a manual backfill re-run will fix it." A brand that installs/disconnects successfully but whose dual-write fails will have a stale or missing `CommerceConnection` row indefinitely until one of those two things happens.
- **Single-primary is application-enforced, not DB-enforced, and has a latent read-then-write race.** There is no partial unique index for "at most one primary connection per `(brand, provider)`" on `CommerceConnection`; `isPrimary` correctness depends entirely on `connection-sync.ts`'s transactional logic running correctly. Concretely, `applyShopifyConnectionSync` reads `otherConnectedCount` via `count()` and then writes `isPrimary` based on that count, inside a transaction that runs at Postgres's default READ COMMITTED isolation (see `defaultRunTransaction`) — READ COMMITTED does not prevent two concurrent transactions from both reading zero and both writing `isPrimary: true`. So two concurrent syncs for the same `brandId` with different `externalAccountId` values could in principle both become primary. This is **latent, not live**: it is not reachable through any flow that exists in Phase 1, because the install route's Serializable transaction plus one-time pending-install token consumption prevents concurrent duplicate installs of the same domain, and Phase 1 has no other path that syncs two different shop domains onto the same brand concurrently. Before genuine multi-store flows ship in Phase 2, this must be closed with an actual concurrency-safety mechanism — e.g. a Postgres advisory lock keyed on `(brandId, provider)`, a `SELECT ... FOR UPDATE` on the existing primary row, or a partial unique index — not left to the resolver's read-time tiebreak (§10), which papers over an inconsistent DB state rather than preventing one.
- **No `@@unique([brandId, provider])`.** By design (a brand may have multiple stores per provider later), but it means a stray extra `CommerceConnection` row for the same brand/provider is not rejected by the schema — only caught, if at all, by the resolver's deterministic tiebreak at read time.
- **`revokeDiscount` is unimplemented, not just unwired.** `canRevokeDiscount: false` accurately reflects that no discount-revocation call exists anywhere in this codebase (not in `shopify-discounts.ts`, not anywhere else) — this is a genuine capability gap, not a Phase-1 scoping choice around an existing capability.
- **The migration has never been run against a real database.** Every guarantee above (constraint behavior, index behavior, cascade behavior) is verified only against Prisma's schema validation and the hand-rolled in-memory fakes in the test suite — not against a live Postgres instance. See §16 for what must happen before that changes.
- **Rollback of the migration is a data-loss operation once real rows exist**, as already documented in `docs/prisma-migrations.md`: dropping the two new tables is only safe while both are empty.

## 14. Deferred features

Explicitly out of scope for Phase 1 and not present anywhere in this codebase:

- Commerce7 integration (adapter implementation).
- Order storage (there is still no `Order` model of any kind).
- Attribution.
- Purchase-based points (points are currently campaign/QR/lesson-driven, not purchase-driven).
- Creator commissions.
- Universal reward migration (rewards remain Shopify-shaped — `ShopifyRewardRedemption` is untouched).
- Universal product catalog (there is still no `Product` table; products remain fetched live and unpersisted).

## 15. Manual test instructions

These steps exercise the *existing, unmodified* Shopify behavior end-to-end plus the new best-effort dual-write. `docs/shopify-testing.md` already documents the full checklists for install, reconnect, product fetch/display, redemption, webhooks, and disconnect/uninstall in detail — this section cross-references those checklists rather than duplicating them, and adds only what's new for Phase 1 (confirming the `CommerceConnection`/`CommerceConnectionSecret` mirror).

**Prerequisite for anything below that inspects `CommerceConnection`/`CommerceConnectionSecret` rows:** the migration must first be applied to the target database (`npx prisma migrate deploy`, or `migrate dev` in a local/dev environment) — it has not been applied anywhere as of this writing (§5).

- **Shopify install** — follow `docs/shopify-testing.md` "SQRATCH-First Install Checklist" and "Shopify-Started Install Checklist" (routes: `/dashboard/brand/shopify`, `/api/shopify/installations/[installId]`). After a successful install, additionally confirm a `CommerceConnection` row exists for the brand with `provider: SHOPIFY`, `status: CONNECTED`, `isPrimary: true`, and a matching `CommerceConnectionSecret` row whose `encryptedPayload` decrypts (via `decryptSecret`) to the same access token currently on `Brand.shopifyAdminAccessTokenEncrypted`.
- **Connection status** — `GET /api/brand/shopify/status` per `docs/shopify-testing.md`; this route is unchanged and still reads only `Brand.shopify*` columns (D1).
- **Reconnect / relink** — follow the reconnect flow in `docs/shopify-testing.md`. Additionally confirm relinking the same shop domain to a different brand reassigns `CommerceConnection.brandId` on the same row rather than creating a second row (matches `tests/commerce-connection-compatibility.test.ts` test 8's relink behavior).
- **Product sync / product display** — follow `docs/shopify-testing.md` "Product Linking Checklist" and "Product Edge Cases" (route: `/dashboard/brand/shopify`, "Fetch products"). This still reads live from Shopify via the unmodified `fetchNormalizedShopifyProducts` — the adapter's `syncProducts` is not on this path in Phase 1.
- **Experience product links** — visit `/x/[experienceSlug]/shop` and confirm linked products render, per `docs/shopify-testing.md`. Underlying data route: `GET /api/public/experience/[slug]/products`.
- **Lesson product links** — visit `/x/[experienceSlug]/lessons/[lessonId]` and confirm linked products render. Underlying data route: `GET /api/public/experience/[slug]/lessons/[id]/products`.
- **Points -> discount redemption** — follow `docs/shopify-testing.md` "Reward Redemption, Status Refresh, and Reconciliation Checklist" (route: `POST /api/rewards/shopify/redeem`). This still calls `createShopifyRewardDiscountCode` directly — the adapter's `createDiscount` is not on this path in Phase 1.
- **Webhooks** — follow `docs/shopify-testing.md` "Disconnect And Uninstall Checklist" and "Compliance Webhook Checklist." For `app/uninstalled` (`POST /api/shopify/webhooks/app/uninstalled`), additionally confirm the `CommerceConnection` row's `status` becomes `UNINSTALLED` and its `CommerceConnectionSecret` is deleted, while the row itself is **not** deleted (it stays keyed on the shop domain for relink, matching `shopifyShopDomain` being preserved). For `shop/redact` (`POST /api/shopify/webhooks/shop/redact`), confirm the brand's `CommerceConnection` row (and its secret, via cascade) is deleted outright.
- **Disconnect / uninstall** — follow `docs/shopify-testing.md` "Disconnect And Uninstall Checklist" (routes: dashboard disconnect at `POST /api/brand/shopify/disconnect`, and the embedded-app path at `POST /api/shopify/embedded/disconnect`). Additionally confirm the `CommerceConnection` row's `status` becomes `DISCONNECTED` and its secret is deleted for both paths.
- **Dual-write resilience (Phase-1-specific, not in `docs/shopify-testing.md`)** — confirm that if the dual-write fails (e.g. temporarily point `safeSyncShopifyCommerceConnection`'s dependency at a broken connection in a controlled test environment, never in production), the underlying install/disconnect/webhook request still succeeds and returns its normal response — the failure should only be visible as a sanitized `[commerce/connection-sync]` log line, never as a user-facing error.

## 16. Readiness for Phase 2

Phase 2 must not route any request through `CommerceAdapter`/`resolveCommerceConnectionForBrand` until, in order:

1. **Apply the migration** (`npx prisma migrate deploy`) to the target database and confirm with `npx prisma migrate status` / `npx prisma migrate diff` per the verification procedure in `docs/prisma-migrations.md`.
2. **Run the backfill** (`npx tsx scripts/backfill-commerce-connections.ts --apply`) so every existing Shopify-connected brand has a `CommerceConnection` row, not just brands that install/disconnect/uninstall/redact after the migration lands.
3. **Re-sync secrets** — because of D3, re-run the backfill (or an equivalent full re-sync) immediately before cutover so `CommerceConnectionSecret` reflects the current token state for every brand, including any `EXPIRING_OFFLINE` brand whose token rotated silently between lifecycle events since the last sync.
4. **Only then cut read paths over** — replace direct `Brand.shopify*` reads and direct Shopify-service calls with `resolveCommerceConnectionForBrand` / `CommerceAdapter` calls, one call site at a time, verifying behavior is unchanged at each step (D1 exists specifically so this cutover can happen incrementally and safely, not as a single flag flip).

Until all four steps happen, `CommerceConnection`/`CommerceConnectionSecret` remain a best-effort mirror with no consumer — safe to leave stale, safe to backfill repeatedly, and safe to ignore if Phase 2 is delayed indefinitely.
