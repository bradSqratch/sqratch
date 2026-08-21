# Shopify GDPR Data Inventory

Public-app installations store encrypted expiring-token lifecycle fields and CAS refresh-lease metadata on `CommerceConnectionSecret`. Disconnect or uninstall deletes the secret and marks the canonical `CommerceConnection` `UNINSTALLED`, while preserving non-sensitive audit/history records.

**Purpose:** Ground the implementation of the three mandatory Shopify compliance webhooks:
`customers/data_request`, `customers/redact`, and `shop/redact`.

**Basis:** Full read of `prisma/schema.prisma`, `src/lib/shopify*.ts`, `src/app/api/shopify/**`, and `src/app/api/rewards/**`. No fields were inferred or invented.

---

## 1. Field-level Data Map

| Model.field | Shopify-linked? | Contains PII? | Notes |
|---|---|---|---|
| `CommerceConnection.status` | shop | No | Canonical connection lifecycle (`CommerceConnectionStatus`). Set to `UNINSTALLED` by `app/uninstalled` and `shop/redact`. |
| `CommerceConnection.providerMetadata` | shop | No | Provider-opaque JSON (currency code, auth mode, etc.). Removed with the row on `shop/redact`. |
| `CommerceConnection.installedAt` / `.uninstalledAt` / `.lastProductSyncAt` | shop | No | Canonical lifecycle timestamps. `installedAt` also fences stale/redelivered webhooks. |
| `CommerceConnectionSecret.encryptedPayload` | token | Yes (credential) | **The sole credential store.** AES-256-GCM. Deleted by `app/uninstalled` and `shop/redact`. |
| `CommerceConnectionSecret.refreshLockId` / `.refreshLockedUntil` | none | No | CAS refresh-lease fields. Not personal data. |
| `BrandRewardOffer.codePrefix` | shop (indirect) | No | Brand-configured prefix for discount codes. |
| `BrandRewardOffer.sourceShopDomain` | shop | No (domain, not personal) | The shop the offer was created/last saved against while connected — set on every create/update for every `appliesTo` value, not only `SPECIFIC_PRODUCTS` (`src/lib/reward-offers.ts`, `src/app/api/brand/rewards/offers/route.ts`). Server-derived only, never client-supplied. This is the field `shop/redact` uses to decide which offers are specific to the redacted shop: on `shop/redact`, any offer whose `sourceShopDomain` equals the redacted domain is deactivated (`isActive = false`) and has `sourceShopDomain` nulled; offers with a different or null `sourceShopDomain` (e.g. resaved against a different shop after a relink) are untouched. |
| `CommerceConnection.externalAccountId` | shop | No (domain, not personal) | The connected store's shop domain, provider-neutral. Deleted outright on `shop/redact` (the whole row is hard-deleted). |
| `ConnectedCommerceProduct.productUrl` | product | No | Mirrored merchant product URL. Cascade-deleted with its `CommerceConnection` on `shop/redact`. |
| `BrandRewardOfferProduct.shopifyProductGid` | product | No | Shopify global product ID snapshot for discount scoping. Not personal data. |
| `BrandRewardOfferProduct.title` | product | No | Product title snapshot. |
| `BrandRewardOfferProduct.imageUrl` | product | No | Product image URL snapshot. |
| `BrandRewardOfferProduct.productUrl` | product | No | Product URL snapshot. |
| `CommerceConnectionEvent.externalAccountId` | provider account | No | Provider account identity associated with lifecycle history. For Shopify it is the shop domain. Never stores tokens, OAuth state, or session data. Shopify `shop/redact` nulls only rows whose `provider=SHOPIFY` and account matches. |
| `CommerceConnectionEvent.previousExternalAccountId` | provider account | No | Prior account identity, populated for reconnect/relink transitions. Shopify redaction nulls it independently so an unrelated current account snapshot is retained. |
| `CommerceConnectionEvent.currencyCode` / `.previousCurrencyCode` | provider account | No | Currency snapshots at the time of the event. Nulled alongside the corresponding account snapshot on Shopify redaction. |
| `CommerceConnectionEvent.providerClientId` | none | No | Provider client identifier used for the connection. Nulled alongside a redacted Shopify account snapshot. |
| `CommerceConnectionEvent.eventType` / `.provider` / `.createdAt` | none | No | Retained after redaction as anonymised provider-neutral lifecycle audit history. |
| `ShopifyRewardRedemption.shopifyShopDomain` | shop | No | Domain of the shop the code was issued against. Denormalised copy (not a FK). |
| `ShopifyRewardRedemption.shopifyDiscountNodeId` | shop | No | Shopify GID for the discount node; used to poll usage status. |
| `ShopifyRewardRedemption.shopifyDiscountStatus` | shop | No | Discount status string from Shopify (`ACTIVE`, etc.). |
| `ShopifyRewardRedemption.shopifyAsyncUsageCount` | shop | No | Number of times the code was used, polled from Shopify. |
| `ShopifyRewardRedemption.shopifyLastCheckedAt` | shop | No | Timestamp of last status poll. |
| `ShopifyRewardRedemption.shopifyUserErrors` | shop | No | JSON error details from Shopify mutation responses. |
| `ShopifyRewardRedemption.code` | none | Quasi-sensitive | SQRATCH-generated discount code string (e.g. `BRAND-XXXXXX`). Not tied to a Shopify customer identity. |
| `ShopifyRewardRedemption.userId` | none | No | FK to SQRATCH `User.id` — a SQRATCH identity, NOT a Shopify customer ID. |
| `ShopifyRewardRedemption.brandId` | none | No | FK to `Brand.id`. |
| `ShopifyRewardRedemption.offerId` | none | No | FK to `BrandRewardOffer.id`. |
| `ShopifyRewardRedemption.status` | none | No | SQRATCH redemption lifecycle enum. |
| `ShopifyRewardRedemption.pointsCost` | none | No | SQRATCH points spent. |
| `ShopifyRewardRedemption.discountAmountCents` | none | No | Snapshot of discount value at redemption time. |
| `ShopifyRewardRedemption.discountPercentageBasisPoints` | none | No | Snapshot of percentage discount at redemption time. |
| `ShopifyRewardRedemption.issuedAt` | none | No | When the Shopify discount code was created. |
| `ShopifyRewardRedemption.expiresAt` | none | No | When the discount code expires. |
| `ShopifyRewardRedemption.usedAt` | none | No | When usage was confirmed. |
| `ShopifyRewardRedemption.idempotencyKey` | none | No | Client-supplied dedup key. |
| `PointTransaction.userId` | none | No | SQRATCH user FK. |
| `PointTransaction.shopifyRewardRedemptionId` | none | No | FK to redemption for ledger linkage. |
| `PointTransaction.reason` | none | No | Enum includes `SHOPIFY_REWARD_REDEMPTION`, `SHOPIFY_REWARD_REFUND`. |
| `TokenStore.service` | token (ephemeral) | No | Key pattern `shopify_oauth_state:<nonce>` or `shopify_pending_install:<id>`. Short-lived; cleaned up on install completion. |
| `TokenStore.token` | token (ephemeral) | Yes (credential) | JSON containing `encryptedToken` during OAuth flow. Deleted after successful install. |
| `User.email` | none | Yes | SQRATCH account email. **Not linked to Shopify customer identity.** |
| `QRCode.email` | none | Yes | Optional email pre-filled on QR code creation (brand-side). **Not a Shopify customer email.** |
| `WaitlistEntry.email` | none | Yes | Waitlist email. Completely independent of Shopify. |
| `EmailQueue.email` | none | Yes | Transactional email queue. SQRATCH-internal. |

> **PHASE 14C-B2:** the 16 legacy `Brand.shopify*` compatibility columns (`shopifyShopDomain`, `shopifyAdminAccessTokenEncrypted`, `shopifyRefreshTokenEncrypted`, `shopifyAccessTokenExpiresAt`, `shopifyRefreshTokenExpiresAt`, `shopifyGrantedScopes`, `shopifyConnectionStatus`, `shopifyAuthMode`, `shopifyClientId`, `shopifyCurrencyCode`, `shopifyInstalledAt`, `shopifyDisconnectedAt`, `shopifyUninstalledAt`, `shopifyLastProductSyncAt`, `shopifyTokenRefreshLockId`, `shopifyTokenRefreshLockedUntil`) and the `ShopifyConnectionStatus` / `ShopifyAuthMode` enums have been **physically dropped**. `Brand` now stores no Shopify connection or credential state whatsoever, so no Shopify redaction step reads or writes `Brand` at all. `Brand` retains only the provider-specific `shopifyRewardRedemptions` relation; provider-neutral lifecycle history is reached through `commerceConnectionEvents`.

---

## 2. Key Architectural Finding: No Shopify Customer Identity Linkage

**SQRATCH does NOT store any Shopify customer identifier.**

The Shopify compliance payloads for `customers/data_request` and `customers/redact` carry:
- `customer.id` (Shopify customer ID, e.g. `207119551`)
- `customer.email`
- `customer.phone`
- `orders_requested` (array of order IDs)

SQRATCH has **no column in any table** that stores a Shopify customer ID, Shopify order ID, or phone number. SQRATCH users are identified by their own `User.id` (a CUID) and `User.email` (their SQRATCH account email). The connection between a SQRATCH user and a Shopify shop is only:

- A SQRATCH user redeems SQRATCH points → receives a discount **code string** (e.g. `BRAND-ABC123`).
- That code is created in the merchant's Shopify store via the Admin API with `customerSelection: { all: true }` (any customer can use it).
- SQRATCH never records who (Shopify customer) ultimately uses the code at the merchant's checkout.
- `ShopifyRewardRedemption.shopifyAsyncUsageCount` only records whether the code was used (0 or 1), not by which Shopify customer.

There is **no join** between SQRATCH `User` records and Shopify customer records. A Shopify customer who used a SQRATCH-generated discount code at checkout is completely unknown to SQRATCH.

---

## 3. `customers/data_request` Webhook

**Payload fields of interest:** `customer.id`, `customer.email`, `customer.phone`, `orders_requested`, `shop_domain`.

**What data SQRATCH could return for a given Shopify customer:**

None. SQRATCH holds no data keyed by Shopify customer ID, email (as a Shopify customer), or phone. SQRATCH cannot correlate an incoming `customer.id` or `customer.email` to any row in the database because the linkage was never recorded.

**Current implementation** (`src/app/api/shopify/webhooks/customers/data_request/route.ts`):
1. Verifies the HMAC via `verifyShopifyWebhookRequest`; non-matching requests are rejected before any further processing.
2. Writes a sanitized structured audit log entry (`topic`, `shopDomain` only — no `customer.id`, email, or phone is logged).
3. Returns HTTP 200 immediately with no data payload. No data export is attempted, because none is possible.

A no-op-with-200 is lawful because SQRATCH genuinely holds no data attributable to Shopify customer identity. Shopify's GDPR policy requires apps to respond within 30 days; responding 200 immediately with no data payload satisfies this.

---

## 4. `customers/redact` Webhook

**Payload fields of interest:** `customer.id`, `customer.email`, `customer.phone`, `orders_to_redact`, `shop_domain`.

**What Shopify-customer-linked PII to delete or anonymize:**

None. For the same reason as above, SQRATCH holds no rows keyed by Shopify customer identity. There is no field to null or anonymize.

**What must NOT be deleted:**

SQRATCH's own `User` records, `PointTransaction` records, and `ShopifyRewardRedemption` records are identified by SQRATCH-internal user IDs. Even if a SQRATCH user's email happened to match the Shopify customer's email, these are independent identities and SQRATCH has no reliable way to confirm the match (nor any obligation to delete SQRATCH records based on a Shopify customer data signal alone — that would require a separate SQRATCH account deletion request from the user directly).

**Current implementation** (`src/app/api/shopify/webhooks/customers/redact/route.ts`): same pattern as `customers/data_request` — verifies HMAC, writes a sanitized audit log entry (`shopDomain` only), and returns HTTP 200 with no redaction performed, because none is needed or appropriate.

A no-op-with-200 is lawful: the redaction obligation only covers data that SQRATCH holds *as a Shopify customer record*. None exists.

---

## 5. `shop/redact` Webhook

**Triggered:** 48 hours after a merchant uninstalls the Shopify app (Shopify sends this to confirm all shop data should be erased).

**What shop data SQRATCH stores (see Section 1):**

| Data | Location | Action |
|---|---|---|
| Shopify OAuth access/refresh token (encrypted) | `CommerceConnectionSecret.encryptedPayload` | **DELETE** — the secret row is deleted by `invalidateShopifyCredential` before anything else runs. This is the only place a Shopify credential exists. |
| Shop domain, status, currency, auth mode, lifecycle timestamps | `CommerceConnection` (`externalAccountId`, `status`, `providerMetadata`, `installedAt`/`uninstalledAt`/`lastProductSyncAt`) | **DELETE** — the whole row is hard-deleted after the transaction commits, which also cascades the canonical product chain. |
| Product snapshots | `BrandRewardOfferProduct` rows linked to the brand's offers | **PRESERVE** — these are SQRATCH business records describing what offers existed. Product GIDs are not personal data. No deletion required. |
| Shopify metadata on redemptions | `ShopifyRewardRedemption.shopifyShopDomain`, `.shopifyDiscountNodeId`, `.shopifyDiscountStatus`, `.shopifyAsyncUsageCount`, `.shopifyLastCheckedAt`, `.shopifyUserErrors` | **ANONYMIZE** — null or clear only the Shopify-specific metadata columns; preserve the redemption record itself as a SQRATCH financial/points ledger entry. |
| SQRATCH points ledger | `PointTransaction` rows | **PRESERVE in full** — these are SQRATCH internal accounting records with no Shopify personal data. |
| SQRATCH redemption records | `ShopifyRewardRedemption` core fields (`userId`, `brandId`, `offerId`, `code`, `pointsCost`, `status`, timestamps) | **PRESERVE** — these record SQRATCH points activity. The `code` field is a SQRATCH-generated string; it is not a Shopify customer identifier. |
| Ephemeral OAuth state tokens | `TokenStore` rows with `shopify_oauth_state:` or `shopify_pending_install:` keys | These are short-lived and cleaned up during the OAuth flow. Confirm none remain for this shop; delete any orphans. |

**Re-installation after redaction:**

Because the canonical `CommerceConnection` row is hard-deleted (and its `@@unique([provider, externalAccountId])` slot released with it), the same shop can re-install and link to a brand again later. No redacted placeholder is written, since a placeholder would permanently block re-installation.

**Current `shop/redact` handler behavior** (`src/app/api/shopify/webhooks/shop/redact/route.ts`). Steps 3–6 run inside one database transaction; steps 1–2 and 7 run outside it, in the order listed:

1. Revokes the **canonical** credential first via `invalidateShopifyCredential({ shopDomain, status: "UNINSTALLED" })` — a status transition plus secret delete, keyed on the shop domain. If this reports `STALE_EVENT_IGNORED` (the event predates the connection's current `installedAt`, i.e. it was redelivered after a reinstall) the handler stops here and returns 200, so a delayed webhook can never destroy a newer connection.
2. Resolves the set of brands historically associated with this shop domain from `CommerceConnectionEvent` scoped to `provider=SHOPIFY` (matching `externalAccountId` **or** `previousExternalAccountId`) union `ShopifyRewardRedemption.shopifyShopDomain`. This remains GDPR audit evidence only; no cleanup step is keyed on a brand id. `Brand` itself is never read or written — it holds no Shopify state.
3. On every `ShopifyRewardRedemption` row where `shopifyShopDomain` matches: nulls `shopifyDiscountNodeId`, `shopifyDiscountStatus`, and `shopifyUserErrors`. `shopifyShopDomain` on these rows is **not** nulled — it is a non-nullable `String` column in the schema (a denormalized snapshot, not a live FK) and is not personal data, so it is left as an audit trail of which shop a code was issued against. All SQRATCH core fields (`userId`, `brandId`, `offerId`, `code`, `pointsCost`, `status`, timestamps) are preserved unconditionally.
4. On every `BrandRewardOffer` row (across **all** brands) whose `sourceShopDomain` equals the redacted domain — not scoped to "every offer belonging to any brand historically associated with this shop," since a brand can relink to a different, still-live shop and resave offers against it, and those offers must stay untouched: sets `isActive = false` and nulls `sourceShopDomain`. Rows are never deleted. An offer with a different or null `sourceShopDomain` (including a brand's currently-live offers after a relink) is never matched by this step.

   Phase 8 removed the `ExperienceProductLink` and `LessonProductLink` scrubs that used to be part of this step, along with those two tables. No coverage is lost: they only ever nulled a shop *domain string* on snapshot rows, whereas the canonical product chain (`ConnectedCommerceProduct`, `BrandCommerceProduct`, `CampaignLessonProduct`) is `ON DELETE CASCADE` from `CommerceConnection`, and the handler strictly hard-deletes that `CommerceConnection` row (`deleteShopifyCommerceConnectionByShopDomain`, after the transaction above commits). A deletion failure returns a retryable non-2xx response, so those rows are removed wholesale rather than field-scrubbed. See `docs/commerce/phase-8-canonical-commerce-legacy-elimination-summary.md`.
5. Scrubs the redacted domain from `CommerceConnectionEvent` only where `provider=SHOPIFY`: matching `externalAccountId` rows have account, currency, and provider client id nulled; matching `previousExternalAccountId` rows have prior account and currency nulled independently. Commerce7 events are untouched. The row itself (`provider`, `eventType`, `createdAt`) remains anonymised history; no event is deleted or invented.
6. Identifies and deletes orphaned OAuth-state / pending-install `TokenStore` rows whose stored payload references this shop (a bounded scan of `shopify_oauth_state:*` / `shopify_pending_install:*` keys, parsing only the plaintext `shop` field — no token value is decrypted).
7. Writes a sanitized audit log entry (`shopDomain`, whether a brand was found, whether redaction ran, and the count of orphaned tokens deleted) before the domain itself becomes unrecoverable.
8. Strictly erases the canonical `CommerceConnection` row outright (`deleteShopifyCommerceConnectionByShopDomain`), after the transaction commits. This cascades the canonical product chain (`ConnectedCommerceProduct`, `BrandCommerceProduct`, `CampaignLessonProduct`). A deletion failure returns a sanitized 500 so Shopify retries; an already-deleted row is an idempotent success.
9. Returns HTTP 200.

This is materially more thorough than `app/uninstalled`, which only deletes the credential secret and sets the canonical connection to `UNINSTALLED` while deliberately preserving the `CommerceConnection` row itself and its `externalAccountId` (so a merchant who reinstalls without waiting for the 48-hour `shop/redact` webhook gets a seamless relink to the same brand).

---

## 6. Remaining Open Questions for Human Decision

The items below are genuinely undecided policy questions, not implementation gaps — the current behavior for each is stated so it is clear what "leaving it open" currently means in practice.

1. ~~**`Brand.shopifyInstalledAt` / `.shopifyLastProductSyncAt` / `.shopifyCurrencyCode` / `.shopifyClientId` after shop/redact**~~ — **RESOLVED by Phase 14C-B2.** These columns no longer exist. The equivalent canonical values live on the `CommerceConnection` row, which `shop/redact` hard-deletes outright, so nothing is retained on the brand at all.
2. **`ShopifyRewardRedemption.shopifyShopDomain` after shop/redact:** currently **retained in plaintext** on historical redemption rows (not nulled or hashed), because the column is non-nullable and the domain is not personal data. Should it instead be replaced with a non-reversible hash to further reduce linkability in logs/exports? This would require a schema change (making the column nullable or adding a hashed variant) — flagged as a possible legal/policy ambiguity, not resolved here.
3. **`BrandRewardOffer` and `BrandRewardOfferProduct` after shop/redact:** currently **preserved** (offers are deactivated via `isActive = false`, not deleted; product snapshots are untouched). Should they instead be deleted once a brand's Shopify access is permanently gone? Deletion would require a cascade decision on related `ShopifyRewardRedemption` rows (currently blocked by `onDelete: Restrict` on `offerId`) — not attempted.
4. **`QRCode.email` field:** an optional email on QR codes created by brand admins, unrelated to Shopify customer data. Not addressed by any Shopify compliance webhook; would need its own review under SQRATCH's own user-data-deletion flow if one is required.
5. **Re-installation after shop/redact:** deleting the canonical `CommerceConnection` row releases its `@@unique([provider, externalAccountId])` slot, allowing the same shop to re-install and link to the same Brand record later. This is the current, intentional behavior, not an open question about mechanism — but whether this is the desired product UX (vs. forcing a fresh Brand on re-install) has not been explicitly confirmed as a product decision.

Resolved since the original version of this document: a sanitized audit log now exists on all four webhook handlers, and `shop/redact` now deletes orphaned `TokenStore` OAuth-state/pending-install rows for the redacted shop. Neither is an open question any longer.
