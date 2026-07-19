# Shopify GDPR Data Inventory

Public-app installations also store encrypted expiring-token lifecycle fields and per-Brand refresh lease metadata. Disconnect or uninstall clears active credential material while preserving the shop domain and non-sensitive audit/history records.

**Purpose:** Ground the implementation of the three mandatory Shopify compliance webhooks:
`customers/data_request`, `customers/redact`, and `shop/redact`.

**Basis:** Full read of `prisma/schema.prisma`, `src/lib/shopify*.ts`, `src/app/api/shopify/**`, and `src/app/api/rewards/**`. No fields were inferred or invented.

---

## 1. Field-level Data Map

| Model.field | Shopify-linked? | Contains PII? | Notes |
|---|---|---|---|
| `Brand.shopifyShopDomain` | shop | No (domain, not personal) | `@unique`; used as FK into all Shopify-related tables. Clearing it requires handling the unique constraint. |
| `Brand.shopifyAdminAccessTokenEncrypted` | token | Yes (credential) | AES-encrypted offline access token. Must be nulled on shop redact. Already nulled by `app/uninstalled` handler. |
| `Brand.shopifyInstalledAt` | shop | No | Installation timestamp. |
| `Brand.shopifyDisconnectedAt` | shop | No | Disconnect timestamp. |
| `Brand.shopifyUninstalledAt` | shop | No | Uninstall timestamp. |
| `Brand.shopifyConnectionStatus` | shop | No | Enum: DISCONNECTED / CONNECTED / UNINSTALLED. |
| `Brand.shopifyLastProductSyncAt` | shop | No | Timestamp of last product sync. |
| `Brand.shopifyCurrencyCode` | shop | No | Three-letter ISO code fetched from shop. |
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

**Recommendation:**

The handler should:
1. Verify the HMAC (already done by `verifyShopifyWebhookRequest`).
2. Log the request with `shopDomain` and `customer.id` for audit purposes (no PII needs to be stored for this log — a hash of `customer.id` plus the shop domain is sufficient).
3. Return HTTP 200 immediately. No data export is possible or required.

A no-op-with-200 is lawful because SQRATCH genuinely holds no data attributable to Shopify customer identity. Shopify's GDPR policy requires apps to respond within 30 days; responding 200 immediately with no data payload satisfies this.

**Current implementation:** The handler already returns `200` but does not log the request. A structured audit log entry should be added.

---

## 4. `customers/redact` Webhook

**Payload fields of interest:** `customer.id`, `customer.email`, `customer.phone`, `orders_to_redact`, `shop_domain`.

**What Shopify-customer-linked PII to delete or anonymize:**

None. For the same reason as above, SQRATCH holds no rows keyed by Shopify customer identity. There is no field to null or anonymize.

**What must NOT be deleted:**

SQRATCH's own `User` records, `PointTransaction` records, and `ShopifyRewardRedemption` records are identified by SQRATCH-internal user IDs. Even if a SQRATCH user's email happened to match the Shopify customer's email, these are independent identities and SQRATCH has no reliable way to confirm the match (nor any obligation to delete SQRATCH records based on a Shopify customer data signal alone — that would require a separate SQRATCH account deletion request from the user directly).

**Recommendation:**

Same pattern as `customers/data_request`:
1. Verify HMAC.
2. Log `shopDomain` + `customer.id` for audit (no PII stored in log).
3. Return HTTP 200. No redaction is needed or appropriate.

A no-op-with-200 is lawful: the redaction obligation only covers data that SQRATCH holds *as a Shopify customer record*. None exists.

**Current implementation:** Handler already returns 200 but does not log. Add audit log.

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

**The `Brand.shopifyShopDomain` unique constraint issue:**

`shopifyShopDomain` has `@unique`. Simply nulling it allows the same shop to re-install later and get a fresh link. This is the **recommended approach**:

```
Brand.shopifyShopDomain = null
```

Setting it to `null` releases the unique slot. An alternative — replacing it with a placeholder like `"redacted:<hash>"` — would block re-installation and is not recommended.

**Recommended `shop/redact` handler actions (in a single transaction where possible):**

1. Find `Brand` by `shopifyShopDomain` matching `verification.shop`.
2. If no matching brand exists, return 200 (already clean).
3. On the matched `Brand`, set:
   - `shopifyShopDomain = null`
   - `shopifyAdminAccessTokenEncrypted = null` (confirm/ensure already null)
   - `shopifyConnectionStatus = "DISCONNECTED"` (or leave as `UNINSTALLED`)
   - Optionally null `shopifyInstalledAt`, `shopifyDisconnectedAt`, `shopifyUninstalledAt`, `shopifyLastProductSyncAt`, `shopifyCurrencyCode` (human decision — see open questions).
4. On all `ShopifyRewardRedemption` rows where `shopifyShopDomain = verification.shop`, set:
   - `shopifyShopDomain = null` (or a fixed redacted sentinel — see open questions)
   - `shopifyDiscountNodeId = null`
   - `shopifyDiscountStatus = null`
   - `shopifyUserErrors = null`
   - Preserve all other columns.
5. Delete any orphaned `TokenStore` rows for this shop's OAuth state.
6. Return HTTP 200.

**Note:** The current `shop/redact` handler nulls the access token and sets status to `UNINSTALLED` — which is correct for the `app/uninstalled` event — but it does NOT null `shopifyShopDomain` or clear the Shopify metadata columns on `ShopifyRewardRedemption`. The `shop/redact` handler needs to be more thorough than the `app/uninstalled` handler.

**Store-compatibility fields added for the reward/product-link relink-safety feature:**

The `shop/redact` handler additionally, in the same transaction:

1. Sets `isActive = false` on every `BrandRewardOffer` belonging to the Brand currently holding the redacted domain (the Brand is losing its Shopify connection; its offers must never stay claimable).
2. Nulls `sourceShopDomain` wherever it equals the redacted domain, across **all** Brands' `BrandRewardOffer`, `ExperienceProductLink`, and `LessonProductLink` rows — not only the Brand currently holding the domain, since an earlier relink can leave another Brand's rows referencing this domain as a historical `sourceShopDomain`. Rows themselves are never deleted; a nulled `sourceShopDomain` simply makes that offer/link require review or reselection before it can be considered current again.
3. Scrubs the redacted domain out of `ShopifyConnectionEvent` history: any row whose `shopDomain` matches has `shopDomain`, `currencyCode`, and `shopifyClientId` nulled; any row whose `previousShopDomain` matches has `previousShopDomain` and `previousCurrencyCode` nulled independently (so an unrelated *current* domain on that same row, e.g. a RELINKED event to a different, non-redacted store, is preserved). The event row itself (`eventType`, `createdAt`) is retained as anonymised history — no fake historical events are invented, and no row is deleted.

`ShopifyConnectionEvent` never stored access/refresh tokens, OAuth state, App Bridge session tokens, encryption secrets, or request headers in the first place, so there is nothing further to redact there beyond the domain/currency/client-id fields above.

---

## 6. Open Questions for Human Decision

1. **Timestamps on Brand after shop/redact:** Should `shopifyInstalledAt`, `shopifyUninstalledAt`, `shopifyDisconnectedAt` be nulled on shop/redact, or retained as an anonymised audit trail? Retaining them (without the domain) has no personal data impact but documents the relationship history. Nulling them makes the brand record completely clean of Shopify linkage.

2. **`ShopifyRewardRedemption.shopifyShopDomain` after shop/redact:** Should the denormalised shop domain on old redemption rows be nulled (losing auditability of which shop a code was issued against) or replaced with a non-reversible hash (e.g. `SHA-256(shopDomain)`) that preserves referential integrity in logs without retaining the plaintext domain? The domain is not personal data under GDPR but Shopify's DPA may require its removal.

3. **`BrandRewardOffer` and `BrandRewardOfferProduct` after shop/redact:** Product GIDs and snapshot data are not personal data. Should they be deleted anyway (the brand no longer has Shopify access, so the offer can't be redeemed), or left in place for historical records? Deletion would require a cascade decision on related `ShopifyRewardRedemption` rows (blocked by `onDelete: Restrict` on `offerId`).

4. **`QRCode.email` field:** This stores an optional email on QR codes created by brand admins. It is not linked to Shopify customer data but should be reviewed for the SQRATCH-side user deletion flow (separate from Shopify GDPR compliance).

5. **Re-installation after shop/redact:** Nulling `Brand.shopifyShopDomain` allows the same shop to re-install and link to the same Brand record. Is this the desired UX, or should re-installation create a fresh Brand?

6. **Audit log for compliance webhooks:** All three handlers currently return 200 with no logging. A durable audit log (even just a `console.log` with structured JSON to a log aggregator) should be added so the business can demonstrate compliance if audited by Shopify.

7. **`TokenStore` orphan cleanup:** If an OAuth flow is abandoned after the state token is stored but before installation completes, a `shopify_oauth_state:<nonce>` or `shopify_pending_install:<id>` record containing the shop domain may linger until its `expiresAt`. The `shop/redact` handler should query and delete any such records for the redacted shop. Currently this is not done.
