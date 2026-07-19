# Shopify GDPR Data Inventory

Public-app installations also store encrypted expiring-token lifecycle fields and per-Brand refresh lease metadata. Disconnect or uninstall clears active credential material while preserving the shop domain and non-sensitive audit/history records.

**Purpose:** Ground the implementation of the three mandatory Shopify compliance webhooks:
`customers/data_request`, `customers/redact`, and `shop/redact`.

**Basis:** Full read of `prisma/schema.prisma`, `src/lib/shopify*.ts`, `src/app/api/shopify/**`, and `src/app/api/rewards/**`. No fields were inferred or invented.

---

## 1. Field-level Data Map

| Model.field | Shopify-linked? | Contains PII? | Notes |
|---|---|---|---|
| `Brand.shopifyShopDomain` | shop | No (domain, not personal) | `@unique`; used as FK into all Shopify-related tables. Nulled on `shop/redact` (releases the unique slot); preserved on `app/uninstalled` for relink. |
| `Brand.shopifyAdminAccessTokenEncrypted` | token | Yes (credential) | AES-encrypted offline access token. Nulled by both `app/uninstalled` and `shop/redact`. |
| `Brand.shopifyRefreshTokenEncrypted` | token | Yes (credential) | AES-encrypted refresh token (expiring-token/public-app mode only). Nulled by both `app/uninstalled` and `shop/redact`. |
| `Brand.shopifyAccessTokenExpiresAt` / `.shopifyRefreshTokenExpiresAt` | token | No | Expiry timestamps for expiring-token mode. Nulled by both `app/uninstalled` and `shop/redact`. |
| `Brand.shopifyGrantedScopes` | token | No | Comma-separated granted scopes. Nulled by both `app/uninstalled` and `shop/redact`. |
| `Brand.shopifyClientId` | none | No | The app's own OAuth client id for this installation — not shop- or customer-identifying. Not cleared by either handler (harmless once credentials are nulled). |
| `Brand.shopifyTokenRefreshLockedUntil` / `.shopifyTokenRefreshLockId` | none | No | CAS lease fields for concurrent token-refresh prevention. Not personal data. |
| `Brand.shopifyAuthMode` | none | No | Enum: `LEGACY_OFFLINE` / `EXPIRING_OFFLINE`. Not personal data. |
| `Brand.shopifyInstalledAt` | shop | No | Installation timestamp. Not cleared by either handler; retained as anonymised audit trail. |
| `Brand.shopifyDisconnectedAt` | shop | No | Disconnect timestamp. Cleared to `null` by `app/uninstalled` (a distinct lifecycle event from disconnect). Not touched by `shop/redact`. |
| `Brand.shopifyUninstalledAt` | shop | No | Uninstall timestamp. Set to the current time by `app/uninstalled`. Not touched by `shop/redact`. |
| `Brand.shopifyConnectionStatus` | shop | No | Enum: `DISCONNECTED` / `CONNECTED` / `UNINSTALLED` / `REQUIRES_RECONNECT`. Set to `UNINSTALLED` by both `app/uninstalled` and `shop/redact`. |
| `Brand.shopifyLastProductSyncAt` | shop | No | Timestamp of last product sync. Not cleared by either handler. |
| `Brand.shopifyCurrencyCode` | shop | No | Three-letter ISO code fetched from shop. Not cleared by either handler. |
| `BrandRewardOffer.codePrefix` | shop (indirect) | No | Brand-configured prefix for discount codes. |
| `BrandRewardOffer.sourceShopDomain` | shop | No (domain, not personal) | Which Shopify store's product catalog the offer's selected products (if any) were chosen from. Server-derived only, never client-supplied. Nulled on `shop/redact` wherever it matches the redacted domain, on any Brand (a prior relink can leave it referencing a domain that Brand no longer owns). |
| `ExperienceProductLink.sourceShopDomain` | shop | No (domain, not personal) | Same purpose as above, for a direct experience-shop product link. Nulled on `shop/redact`. |
| `LessonProductLink.sourceShopDomain` | shop | No (domain, not personal) | Same purpose as above, for a lesson product link. Server-derived on create/update from the resolved brand's current domain. Nulled on `shop/redact`. |
| `BrandRewardOfferProduct.shopifyProductGid` | product | No | Shopify global product ID snapshot for discount scoping. Not personal data. |
| `BrandRewardOfferProduct.title` | product | No | Product title snapshot. |
| `BrandRewardOfferProduct.imageUrl` | product | No | Product image URL snapshot. |
| `BrandRewardOfferProduct.productUrl` | product | No | Product URL snapshot. |
| `ShopifyConnectionEvent.shopDomain` | shop | No (domain, not personal) | Domain associated with a connection-history event (connect/reconnect/relink/disconnect/uninstall/requires-reconnect). Never stores tokens, OAuth state, or session data. Nulled on `shop/redact` on any row where it matches the redacted domain. |
| `ShopifyConnectionEvent.previousShopDomain` | shop | No (domain, not personal) | Prior domain, populated only for RECONNECTED/RELINKED events. Nulled independently of `shopDomain` on `shop/redact` (a row's unrelated *current* domain is preserved if only its `previousShopDomain` matches the redacted shop). |
| `ShopifyConnectionEvent.currencyCode` / `.previousCurrencyCode` | shop | No | Store currency snapshots at the time of the event. Nulled alongside the corresponding domain field on `shop/redact`. |
| `ShopifyConnectionEvent.shopifyClientId` | none | No | The app's own OAuth client id used for the connection — not shop- or customer-identifying. Nulled alongside `shopDomain` on `shop/redact`. |
| `ShopifyConnectionEvent.eventType` / `.createdAt` | none | No | Retained even after redaction as anonymised connection-history audit trail (no domain, currency, or client id attached). |
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
| Shopify OAuth access token (encrypted) | `Brand.shopifyAdminAccessTokenEncrypted` | **NULL** — already done by `app/uninstalled` handler; must be confirmed null before shop/redact runs. |
| Shop domain | `Brand.shopifyShopDomain` | See note below on unique constraint. |
| Connection timestamps | `Brand.shopifyInstalledAt`, `Brand.shopifyDisconnectedAt`, `Brand.shopifyUninstalledAt` | Can be cleared (NULL) or retained as anonymised audit trail — human decision required. |
| Connection status | `Brand.shopifyConnectionStatus` | Should be set to `DISCONNECTED` or `UNINSTALLED` (already done by `app/uninstalled`). |
| Currency code | `Brand.shopifyCurrencyCode` | Can be nulled — it is a derived shop attribute. |
| Last sync timestamp | `Brand.shopifyLastProductSyncAt` | Can be nulled. |
| Product snapshots | `BrandRewardOfferProduct` rows linked to the brand's offers | **PRESERVE** — these are SQRATCH business records describing what offers existed. Product GIDs are not personal data. No deletion required. |
| Shopify metadata on redemptions | `ShopifyRewardRedemption.shopifyShopDomain`, `.shopifyDiscountNodeId`, `.shopifyDiscountStatus`, `.shopifyAsyncUsageCount`, `.shopifyLastCheckedAt`, `.shopifyUserErrors` | **ANONYMIZE** — null or clear only the Shopify-specific metadata columns; preserve the redemption record itself as a SQRATCH financial/points ledger entry. |
| SQRATCH points ledger | `PointTransaction` rows | **PRESERVE in full** — these are SQRATCH internal accounting records with no Shopify personal data. |
| SQRATCH redemption records | `ShopifyRewardRedemption` core fields (`userId`, `brandId`, `offerId`, `code`, `pointsCost`, `status`, timestamps) | **PRESERVE** — these record SQRATCH points activity. The `code` field is a SQRATCH-generated string; it is not a Shopify customer identifier. |
| Ephemeral OAuth state tokens | `TokenStore` rows with `shopify_oauth_state:` or `shopify_pending_install:` keys | These are short-lived and cleaned up during the OAuth flow. Confirm none remain for this shop; delete any orphans. |

**The `Brand.shopifyShopDomain` unique constraint:**

`shopifyShopDomain` has `@unique`. The handler nulls it (rather than replacing it with a redacted placeholder) specifically so the same shop can re-install and get a fresh link later — a placeholder like `"redacted:<hash>"` would permanently block re-installation, so it is not used.

**Current `shop/redact` handler behavior** (`src/app/api/shopify/webhooks/shop/redact/route.ts`), all inside one database transaction:

1. Finds the `Brand` by `shopifyShopDomain` matching the verified shop. If none exists, the rest is skipped and the handler returns 200 (already clean).
2. On the matched `Brand`: nulls `shopifyShopDomain`, `shopifyAdminAccessTokenEncrypted`, `shopifyRefreshTokenEncrypted`, `shopifyAccessTokenExpiresAt`, `shopifyRefreshTokenExpiresAt`, and `shopifyGrantedScopes`; sets `shopifyConnectionStatus = "UNINSTALLED"`. (`shopifyInstalledAt`, `shopifyLastProductSyncAt`, `shopifyCurrencyCode`, and `shopifyClientId` are left as-is — see Section 1 and "Remaining open questions" below.)
3. On every `ShopifyRewardRedemption` row where `shopifyShopDomain` matches: nulls `shopifyDiscountNodeId`, `shopifyDiscountStatus`, and `shopifyUserErrors`. `shopifyShopDomain` on these rows is **not** nulled — it is a non-nullable `String` column in the schema (a denormalized snapshot, not a live FK) and is not personal data, so it is left as an audit trail of which shop a code was issued against. All SQRATCH core fields (`userId`, `brandId`, `offerId`, `code`, `pointsCost`, `status`, timestamps) are preserved unconditionally.
4. Sets `isActive = false` on every `BrandRewardOffer` belonging to the brand that held the redacted domain — the brand is losing its Shopify connection, so its offers must never stay (or become) claimable.
5. Nulls `sourceShopDomain` wherever it equals the redacted domain, across **all** brands' `BrandRewardOffer`, `ExperienceProductLink`, and `LessonProductLink` rows — not only the brand currently holding the domain, since an earlier relink can leave a different brand's rows referencing this domain as a historical `sourceShopDomain`. Rows are never deleted; a nulled `sourceShopDomain` requires review/reselection before that offer/link is considered current again.
6. Scrubs the redacted domain out of `ShopifyConnectionEvent` history: any row whose `shopDomain` matches has `shopDomain`, `currencyCode`, and `shopifyClientId` nulled; any row whose `previousShopDomain` matches has `previousShopDomain` and `previousCurrencyCode` nulled independently, so an unrelated *current* domain on the same row (e.g. a `RELINKED` event to a different, non-redacted store) is preserved. The event row itself (`eventType`, `createdAt`) is retained as anonymised history — no row is deleted and no historical event is invented. `ShopifyConnectionEvent` never stored access/refresh tokens, OAuth state, session tokens, or encryption secrets in the first place, so there is nothing further to redact there.
7. Identifies and deletes orphaned OAuth-state / pending-install `TokenStore` rows whose stored payload references this shop (a bounded scan of `shopify_oauth_state:*` / `shopify_pending_install:*` keys, parsing only the plaintext `shop` field — no token value is decrypted).
8. Writes a sanitized audit log entry (`shopDomain`, whether a brand was found, whether redaction ran, and the count of orphaned tokens deleted) before the domain itself becomes unrecoverable.
9. Returns HTTP 200.

This is materially more thorough than `app/uninstalled`, which only clears credentials and sets `UNINSTALLED` while deliberately preserving `shopifyShopDomain` (so a merchant who reinstalls without waiting for the 48-hour `shop/redact` webhook gets a seamless relink to the same brand).

---

## 6. Remaining Open Questions for Human Decision

The items below are genuinely undecided policy questions, not implementation gaps — the current behavior for each is stated so it is clear what "leaving it open" currently means in practice.

1. **`Brand.shopifyInstalledAt` / `.shopifyLastProductSyncAt` / `.shopifyCurrencyCode` / `.shopifyClientId` after shop/redact:** currently **retained** (not nulled) as an anonymised-once-the-domain-is-gone audit trail. None of these is personal data on its own. Should they be cleared anyway for a "fully clean" brand record, or is retaining them the intended behavior? No change has been made pending this decision.
2. **`ShopifyRewardRedemption.shopifyShopDomain` after shop/redact:** currently **retained in plaintext** on historical redemption rows (not nulled or hashed), because the column is non-nullable and the domain is not personal data. Should it instead be replaced with a non-reversible hash to further reduce linkability in logs/exports? This would require a schema change (making the column nullable or adding a hashed variant) — flagged as a possible legal/policy ambiguity, not resolved here.
3. **`BrandRewardOffer` and `BrandRewardOfferProduct` after shop/redact:** currently **preserved** (offers are deactivated via `isActive = false`, not deleted; product snapshots are untouched). Should they instead be deleted once a brand's Shopify access is permanently gone? Deletion would require a cascade decision on related `ShopifyRewardRedemption` rows (currently blocked by `onDelete: Restrict` on `offerId`) — not attempted.
4. **`QRCode.email` field:** an optional email on QR codes created by brand admins, unrelated to Shopify customer data. Not addressed by any Shopify compliance webhook; would need its own review under SQRATCH's own user-data-deletion flow if one is required.
5. **Re-installation after shop/redact:** nulling `Brand.shopifyShopDomain` allows the same shop to re-install and link to the same Brand record later. This is the current, intentional behavior (see the unique-constraint note above), not an open question about mechanism — but whether this is the desired product UX (vs. forcing a fresh Brand on re-install) has not been explicitly confirmed as a product decision.

Resolved since the original version of this document: a sanitized audit log now exists on all four webhook handlers, and `shop/redact` now deletes orphaned `TokenStore` OAuth-state/pending-install rows for the redacted shop. Neither is an open question any longer.
