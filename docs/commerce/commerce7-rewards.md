# Commerce7 rewards: design and operator guide

Research checked against current official documentation and operator-supplied live sandbox requests on 2026-10-07. SQRATCH is the reward template authority and creates each claim's native coupon directly; no merchant coupon template exists. Selected-product discounts and **Exclusive Wine Access** (granting the merchant's existing Manual Customer Tag) are implemented from live-verified public `/v1` contracts. It builds on deployed commit `df535687c237c09bbf46c3e675bb8897ff722f2d`. Migration `20261008010000_commerce7_rewards` is already applied in production and remains unchanged. **One new additive migration is required for Exclusive Wine Access: `20261009010000_commerce7_exclusive_access`** (see [Deployment](#deployment-state-and-rollout)). See [refinement verification and QA](commerce7-rewards-refinement.md).

> **For standard Commerce7 discount rewards, no Commerce7 coupon needs to be created manually. Configure the reward in SQRATCH. SQRATCH creates the claim's single-use native Commerce7 coupon when points are redeemed.**

## Shipping boundary

A Brand Admin configures only SQRATCH concepts: title, description, points cost, reward mode, eligibility, fixed or percentage discount, minimum subtotal, All products / Selected products, total and per-user limits, claim window, validity after claim and active state. There is no coupon-template field, no Commerce7 ID to copy and no provider terminology in the form.

Saving or editing an offer **stores and validates SQRATCH configuration only and never writes to Commerce7.** A discount save makes no Commerce7 call at all. An Exclusive Wine Access save makes one read-only Tag lookup (`GET /v1/tag/customer/{id}`) to confirm the chosen Customer Tag and, when it is saved as active, one read-only product lookup (`GET /v1/product/{id}`). Provider resources belong to claims, not offers: the native coupon (or the Customer Tag membership) is created when a user redeems points, from that claim's frozen snapshot.

| Choice | Native coupon SQRATCH creates for each claim | Status |
| --- | --- | --- |
| **Anyone with the code** (`ANYONE_WITH_CODE`) + **All products** | `availableTo=Everyone`, `appliesTo=Store`, `usageLimitType=Per Store`, `usageLimit=1`, no shipping discount | **Fully automatic and verified.** No Customer lookup, email matching, Tag operation or CRM setup. Whoever has the code can use it once. |
| **Claiming customer only** (`CLAIMANT_ONLY`) | Restricted to that claim's own unique Manual Customer tag | Template-free and secure (verified SQRATCH email, exact pinned native customer, one unique claim tag, leaked-code checks). CRM assignment of this per-claim tag stays manual. **Draft-only for new offers**: the Coupon `availableTo` value for a customer tag is still unverified. |
| **Selected products** (with Anyone with the code) | `appliesTo: "Product"`, `appliesToObjectIds: [exact synchronized product IDs, sorted]`, `availableTo: "Everyone"` | **Verified and live.** Proven by a live `POST /v1/coupon` HTTP 201 (`tests/fixtures/commerce7-rewards/live-coupon-create-product-201.json`). |
| **Exclusive Wine Access** | Grants the merchant's existing Manual Customer Tag; an optional discount is a single-use `Product`-scoped `Everyone` coupon for the exclusive wine | **Verified and live for single-tag products** (see below). Multi-tag products are draft-only. |

Product scope is independent of eligibility: **Applies to → All products** hides the picker and clears product IDs; **Selected products** shows searchable checkbox cards, removable selections and Clear selection, and requires at least one synchronized product. Edit restores the persisted scope and eligibility.

### One contract: verified values or fail closed

Every Commerce7 Coupon enum SQRATCH may send lives in one typed module, `src/lib/commerce7-coupon-contract.ts`. An entry is either observed or `null`; `null` fails closed and is never filled with a guess.

* **Verified** (documented create example, operator sandbox reads and live 201s): `Store`, `Product` (selected products, with the exact IDs in `appliesToObjectIds`), `Everyone`, `Per Store`, `Dollar Off`, `Percentage Off` (the field name; see the unit note below), `No Discount`, `Enabled`.
* **Percentage units: verified.** HTTP 201 for `discount: 15` did not prove semantics: live QA showed that coupon as **0.15%** (`live-coupon-percentage-observation.json`). The native unit is 1/100 of a percent, the same scale as SQRATCH basis points, so 15% is written as `discount: 1500`; a live 1500 coupon showed "15.00% Off" in Admin and took 15% at checkout (`live-coupon-percentage-1500-observation.json`), so `COMMERCE7_COUPON_CONTRACT.percentage.verified` is true.
* **Unverified for the Coupon object**: the customer-tag `availableTo` value. The Coupons page publishes no enum table, and live Commerce7 enums have already drifted from the public documentation (a live Product reads `security.availableTo: "Tag"` where the docs say `Group`), so no value is assumed.

An unverified branch can be **saved as a draft but not activated**. The server refuses activation and refuses reservation (before any debit, capacity change or provider call), and the Brand UI shows the option as draft-only. To enable a branch, add a redacted sandbox **Coupon** GET for it to `tests/fixtures/commerce7-rewards/` and set the one value in the contract module. See the fixture README.

### Live Coupon write contract (proven)

The public [Coupons](https://developer.commerce7.com/docs/coupons) page is **stale for create**. The live `POST /v1/coupon` (public API, App ID / App Secret Basic auth; never `/v2`, an account JWT or the Admin contract) rejects its `productDiscountType` / `productDiscount` / `shippingDiscountType` shape with HTTP 422 (`tests/fixtures/commerce7-rewards/live-coupon-create-422.json`). The shape below returned HTTP 201 in operator sandbox probes (`live-coupon-create-201.json`) and is what SQRATCH now sends:

| Reward | Outgoing fields (plus `code`, `title`, `startDate`, `endDate`) |
| --- | --- |
| Fixed amount | `type: "Product"`, `discountType: "Dollar Off"`, `discount: <integer minor units>`, `dollarOffDiscountApplies: "Once Per Order"` |
| Percentage | `type: "Product"`, `discountType: "Percentage Off"`, `discount: <basis points>` (1500 = 15%; the live probe's 15 was 0.15%), no per-order field. Verified live (1500 = 15%) |
| No minimum | `cartRequirementType: "None"` (no `cartRequirement`, `cartRequirementMaximum` or `cartRequirementCountType`) |
| Minimum subtotal | `cartRequirementType: "Minimum Purchase Amount"`, `cartRequirement: <integer minor units>`, `cartRequirementCountType: "All Items"` |
| All products | `appliesTo: "Store"` (no `appliesToObjectIds`) |
| Selected products | `appliesTo: "Product"`, `appliesToObjectIds: [sorted synchronized product IDs]` (live 201: the response echoes the same IDs and `availableToObjectIds: null`, plus `channels`, `clubFrequencies`, `promotionSets` and `usageCount`, which readback ignores) |
| Always | `usageLimitType: "Per Store"`, `usageLimit: 1`, `availableTo: "Everyone"`, `status: "Enabled"`, minute-aligned UTC dates |

Never sent: `productDiscountType`, `productDiscount`, `shippingDiscountType`, `shippingDiscount`, `minimumCartAmount`.

**Write and read are separate contracts.** `CouponWriteRequest` is the request above. `NativeCoupon` is what comes back: the create echo reports the current fields, while a GET still reports the historical `productDiscountType` / `productDiscount` / `minimumCartAmount`. Readback normalizes either into the same terms and requires each benefit-defining term to be reported and equal: discount kind and amount, once-per-order for dollar off, minimum and its counting rule, no cart maximum, no shipping discount, usage, scope, eligibility, status, code (case-insensitive) and window (minute precision). If both representations report a term they must agree. The only tolerances are representation: field names, `null` versus `""` ID lists, sub-minute dates, the cosmetic title, and the provider's default `dollarOffDiscountApplies: "Once Per Order"` echoed on a percentage coupon. A dollar-off coupon read back with no per-order report cannot be proven, so recovery sends it to manual review rather than adopting it.

The claim sequence, refund on a deterministic 4xx, fail-closed handling of timeouts / 5xx / ambiguous writes, exact-code recovery and one-claim/one-debit/one-coupon idempotency are unchanged.

**Still wanted:** the 201 response bodies for the whole-store fixed, percentage and minimum probes, and a GET of a coupon created this way (the product-scoped 201 body is now stored). Customer-tag-restricted coupons stay draft-only until their `availableTo` value is proven.

### Legacy offers and claims

Offers saved before this revision may carry a merchant `templateCouponId` and a copy of its native body in `commerce7Config`. Compatibility policy:

* Reads never fail: the Brand DTO exposes only `eligibilityMode` and `discountEnabled`, never the template ID or body.
* The stored template is **never fetched, never required, and never shown**. Create/edit requests no longer accept or persist a template field; a stale client that still sends one is ignored.
* Where the contract is verified (bearer + all products) a legacy offer's stored template is ignored entirely and new claims use the contract.
* Where it is not (claimant-only, selected products), the already-validated template copy is the only evidence of the native enum, so it is frozen into the new claim snapshot and used for that claim. Such offers keep issuing exactly as before. Editing a legacy offer keeps the copy only while it still matches the edited eligibility and scope; otherwise it is dropped and the offer becomes a draft-only unverified branch.
* Historical claim snapshots in the old shape still parse, with scope and eligibility derived from their embedded template and discount terms from the immutable claim columns. A snapshot that is malformed or ambiguous fails closed ("Reward configuration needs review") instead of being reinterpreted. A claim that was already mid-issuance recovers its existing coupon by code, so an upgrade cannot create a second one.
* No database change is required: everything lives in existing JSON and columns.

Eligibility is stored in existing `commerce7Config` JSON and frozen on each claim. Missing modes on deployed offers/claims remain `CLAIMANT_ONLY`; unknown explicit stored modes fail closed. Edits that omit the mode preserve the existing mode. New discount creation defaults to `ANYONE_WITH_CODE`. Exclusive access always forces `CLAIMANT_ONLY` (the access is bound to the claimant's own Commerce7 customer). SQRATCH never assigns a claimant-only discount's per-claim tag automatically; it does grant an Exclusive Wine Access reward's chosen tag (below).

Exclusive-product access has a separate mode, one catalog product, one chosen Customer Tag, an optional discount, dates, points cost and a maximum of 25 claims. A discount on a public product is not exclusive access.

### Exclusive Wine Access

**What it is.** Commerce7 storefront access to one rare wine. The merchant secures the wine to one or more existing Manual Customer Tags in Commerce7. When a SQRATCH member claims the reward, SQRATCH adds **one** of those tags (the one the Brand chose) to the member's own Commerce7 customer, found by their exact verified email. The member then logs in to the Commerce7 store and can buy the wine online. An optional single-use discount code for that wine can be included.

**What it is not.** It is not a purchase, does not reserve inventory, and does not exclude every sales channel. Commerce7 product security applies to website purchases; POS and inbound carts are not restricted by a Customer Tag (only Allocation-based security restricts those, and SQRATCH uses no Allocation permission or write). The discount code is not needed to buy the wine and is not, by itself, an access check.

**Live evidence** (public `/v1`, App ID / App Secret Basic auth, tenant header; sanitized in `tests/fixtures/commerce7-rewards/live-customer-tag-membership.json`):

| Request | Observed | How SQRATCH uses it |
| --- | --- | --- |
| `GET /v1/product/{id}` | `security.availableTo: "Tag"`, `displayOption`, `availableToObjectIds: [tag UUID]`, `webStatus` / `adminStatus: "Available"` | Read-only proof the wine is still Tag-secured, available and secured to the chosen tag. "Tag" is used verbatim; the documented "Group" never qualifies. |
| `GET /v1/customer/{id}` | `tags: [{ id, title, objectType: "Customer", type: "Manual" }]` | Membership check before and after a grant. Duplicate entries are counted. |
| `POST /v1/tag-x-object/customer` `{ objectId, tagId }` | **201** `{ objectId, tagId, id, tagType, createdAt, updatedAt }`. It also succeeded for a customer **who already held the tag**, who was then listed with the tag **twice** | The only membership write. **Not idempotent**: sent at most once per claim, only after verified absence, behind a durable attempt marker, and never repeated after an ambiguous result. |
| `DELETE /v1/tag-x-object/customer/{tagId}/{customerId}` | **204**, empty body; afterwards **both** memberships were gone | **Never sent by SQRATCH.** It removes every copy of the tag, including memberships the merchant or another reward granted. |
| `GET /v1/tag/customer/{id}` (documented "Retrieve a tag") | Tag definition with `type` (Manual; the docs also list a dynamic type) and `objectType` | Resolves the chosen tag by UUID. Only `type: "Manual"` with `objectType: "Customer"` is grantable. Titles are for display only. |

**Several security tags.** A product qualifies when it is available on the current connection, `security.availableTo` is exactly `"Tag"`, and it lists 1–50 distinct, non-blank tag IDs. The Brand picks exactly one Manual Customer Tag for SQRATCH to grant: with one tag it is preselected, with several the Brand must choose. Whether Commerce7 lets a customer holding **any one** of several security tags buy the product has **not** been observed. A multi-tag product **can therefore be configured and saved as a draft but cannot be activated or claimed** (`MULTI_TAG_UNVERIFIED`) until that behavior is verified and `COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.multiTagAccessVerified` is set. The Brand UI warns that holders of the product's other tags may also have access, and, when the chosen tag also secures other synchronized products, that granting it may unlock those too.

**Claim flow** (one saga; no slow work inside a database transaction):

1. **Pre-check, before any debit** (read-only, outside transactions). The route gate requires an authenticated, campaign-unlocked user; then a verified SQRATCH email, an active offer, the current connection and a synchronized product that is still `CONFIGURED`. Live reads then prove the tag is still a Manual Customer tag and still secures the available product. Finally the Commerce7 customer is resolved by a complete, bounded scan and an **exact normalized verified-email match**: fuzzy search is never trusted, zero matches waits, and two or more fail closed. The pre-check never decides the price: **a voluntary claim always costs the configured points**, whatever tags the customer already holds.
2. **Reservation** (the existing serializable transaction): window, caps, per-user limit, frozen snapshot (version 3: `exclusiveAccess { productId, tagId }` and an optional discount), one capacity slot and one ledger debit. Only **one in-flight exclusive claim per member and Customer Tag** may exist, so two concurrent claims can never race the non-idempotent POST.
3. **Provisioning** (durable owner; provider calls outside transactions). Re-verify the tag and product live, and re-read the pinned customer. Then exactly one of:
   * Chosen tag already present and SQRATCH never wrote: **`PRE_EXISTING`**. No membership write; the claim completes (access-only claims settle as ISSUED, a discount issues its coupon) and the points stay spent. SQRATCH never treats this membership as its own and never removes it. A definitive coupon refusal before anything of value was issued still returns the points.
   * Tag absent: set `membershipWriteAttempted`, POST once, record the 201 relation ID, confirm with a fresh `GET /v1/customer/{id}`, then **`SQRATCH_GRANTED`** and `entitlementEverGranted`.
   * Tag present after SQRATCH's own attempt but without its 201 evidence: **`UNVERIFIED`** ownership. Access is finalized but never claimed as SQRATCH's.
4. **Optional discount**: tag first, then one coupon (`Product` scope for the exclusive wine, `Everyone`, single use) through the verified coupon saga with exact-code recovery.
5. `ISSUED / READY` only after verified provider state. An access-only claim shows no code, and coupon expiry never expires access.

| Grant / discount outcome | Result |
| --- | --- |
| Grant refused definitively (4xx, 404, 401/403) | Marker cleared; points refunded once; capacity released; nothing else attempted |
| Grant 429 | Marker cleared; retryable; points held |
| Grant timeout / network / 408 / 409 / 5xx / mismatched 201 | `MANUAL_REVIEW`; marker kept; **no second POST**; no refund. Check provider result finalizes as `UNVERIFIED` if the tag is present, or stays in review if it is absent |
| 201, but the fresh GET does not yet show the tag | "Waiting for Commerce7 to confirm" (retryable, never re-posted) |
| Tag granted, coupon refused definitively | `MANUAL_REVIEW` ("access granted, discount could not be issued"); **no refund**, because access was granted |
| Tag granted, coupon outcome unknown | `MANUAL_REVIEW`; recovery by exact code; no second coupon |
| Before any write: tag deleted or not Manual Customer, wine made public, tag removed from the wine, wine unavailable, multi-tag | Refused before the debit; if it happens between reservation and grant, refunded, because nothing was written |
| Customer deleted, or email changed, before the grant | `MANUAL_REVIEW`; the member may still cancel (nothing was written) |
| Membership removed natively after SQRATCH recorded it, before finalization | `MANUAL_REVIEW`; never re-granted automatically |

**Ownership and removal.** Ownership is durable (`membershipOwnership`, `providerMembershipId`, `membershipWriteAttempted`, `membershipVerifiedAt`) and evidence-bound by database CHECK constraints. `PRE_EXISTING` can never carry a SQRATCH write, `SQRATCH_GRANTED` needs SQRATCH's own 201 relation ID, and points can never be released after any membership write. **SQRATCH never deletes a Customer Tag membership or definition** and never revokes access automatically. The Brand claim action refuses to "revoke" an exclusive claim. Each exclusive claim in Brand Rewards shows its ownership guidance: the customer already had the tag; ownership is unverified; SQRATCH granted it; or another active SQRATCH reward relies on the same customer tag. Removing access is the merchant's decision in Commerce7, after checking Club, allocation and other uses, because Commerce7 removes every copy of the tag at once. There is no customer-facing revocation.

**Drift and readiness.** The Brand offer list reports `CONFIGURED`, `MULTI_TAG_UNVERIFIED`, `TAG_REMOVED` (tag no longer on the product), `SECURITY_CHANGED` (made public, or malformed), `PRODUCT_UNAVAILABLE` or `NOT_CONFIGURED` from the synchronized catalog. Tag deletion or a type change is detected live at save, Enable and claim time. Enable re-runs the live reads outside any transaction and refuses if the synchronized product changed between validation and commit. The claimant listing marks a drifted offer unavailable. No tag UUID, security block or customer data reaches a claimant, and Brand list payloads carry only the tag title.

#### Merchant setup (Commerce7 and SQRATCH)

1. In Commerce7 **Settings → Tags**, create or choose a **Manual Customer Tag**.
2. Any descriptive title is fine. SQRATCH identifies the tag only by its UUID; the title is shown for convenience.
3. Open the rare wine's **Security** and set it to **Tag**, with a display option such as "Display Product / Show Login".
4. Choose one or more Customer Tags. A single tag is the verified, claimable setup; with several tags the SQRATCH reward stays a draft.
5. In SQRATCH, **Products → Sync** the Commerce7 catalog.
6. In **Brand Rewards**, create a reward with **Reward mode: Exclusive wine access**.
7. Select the wine (only Tag-secured products are listed), then choose **exactly which existing tag SQRATCH should grant** under "Customer Tag SQRATCH grants".
8. With several tags on the wine, holders of any of the other tags can also buy it (verified OR semantics). If the tag also secures other products, granting it may unlock those too (SQRATCH lists them). Every voluntary claim costs the configured points, even for a member who already holds the chosen tag or another security tag; SQRATCH then writes no duplicate membership and never takes ownership of an existing tag.
9. Members need a Commerce7 customer account with **the same verified email** they use in SQRATCH, and must **log in to the Commerce7 store** for storefront authorization. Without an account, a claim waits (and can be cancelled for a full refund) until one exists.
10. Access is a storefront permission; a discount is a separate single-use code. Neither reserves inventory, and POS and inbound carts are not restricted by Customer Tag security.

The operator reports that the original deployment and additive migration succeeded. This work performs no database/provider mutations, app configuration changes or deployment. Service tests execute the actual saga with in-memory persistence and a stateful fake Commerce7 tenant.

## Provider research and evidence

The [AI documentation index](https://developer.commerce7.com/llms.txt) was the entry point. The [API overview](https://developer.commerce7.com/docs/commerce7-apis) documents server-side Basic authentication, the tenant header, pagination and rate limits. The implementation uses a ten-second request timeout, a 25-second client budget, bounded pagination and sanitized errors.

| Official source | Supported fact and implementation decision |
| --- | --- |
| [Coupons API](https://developer.commerce7.com/docs/coupons) | Documents create, retrieve, list/search, update and delete. Dollar Off uses integer cents; Percentage Off uses percentage units. Fields include dates, minimumCartAmount, scope and customer eligibility. DELETE returns 204. The page has no enum table; verified values come from its create example and the operator's real sandbox GET: `appliesTo: "Store"`, `availableTo: "Everyone"`, an empty ID list read back as `""` (not `null`/`[]`), `null` for an absent product/shipping discount, and minute-aligned dates. SQRATCH creates the coupon directly from the frozen claim snapshot, omits empty optional fields as the create example does, and compares the readback with those representation differences normalized. Implemented writes are creation and deletion, followed by exact readback/absence verification. No guessed disable status is sent. |
| [Discount setup](https://documentation.commerce7.com/discounts-promotions-coupons-and-promotion-sets) | Customer-tag restrictions, product targeting and per-store usage exist. Codes are case insensitive. A use limit counts orders, not bottles. SQRATCH sends only enum values it has observed for the Coupon object and never infers a tag or product-scope value from Admin labels or from a different object. No stacking, exclusion, per-item-dollar or shipping controls are offered. |
| [Customers API](https://developer.commerce7.com/docs/customers) | Customer responses contain emails, tags and account-related data. Name search is not proof of exact email uniqueness. Initial binding exhausts bounded cursor pages and compares normalized emails exactly. Retries read the pinned native customer ID. No customer account or login credentials are created. |
| [Tags API](https://developer.commerce7.com/docs/tags) | Manual Customer tag definitions can be created with title/type, retrieved (`GET /tag/customer/{id}`) and listed. POST /tag/customer is used only for claimant-only per-claim tags. The customer-membership write (`POST /tag-x-object/customer`) is not on this page: it is proven by the operator's live 201 and verified by a customer GET. Its DELETE is evidenced (204, removes every copy) and deliberately never used. |
| [Customer tag help](https://documentation.commerce7.com/how-do-i-create-customer-tags) | A merchant can assign manual tags in CRM individually or in bulk. This is the supported eligibility handoff. Never assign a claim tag to a second customer. |
| [Webhook documentation](https://developer.commerce7.com/docs/webhooks) | Bulk Customer Tag callbacks document GET /customer?tagId=…&cursor=start. SQRATCH uses that read filter to prove that the claim tag has only the pinned customer as a member. |
| [Products API](https://developer.commerce7.com/docs/products) | Product reads and updates exist, but the public security enum ("Group") differs from the live tenant. The operator's real read shows `security.availableTo: "Tag"`, `displayOption: "Display Product / Show Login"` and the Customer tag UUID in `availableToObjectIds`; it is stored as redacted fixture evidence and the catalog normalizer keeps such a product non-public without rewriting the value. Nested updates require complete objects, so no security PUT is implemented. |
| [Product security help](https://documentation.commerce7.com/how-to-secure-a-product) | Eligible logged-in customers can purchase secured products. Tag, Club and Allocation are business features. Product security does not apply to inbound/POS carts unless secured to an Allocation. Developer Group terminology must not be substituted for Admin Tag without a native fixture. |
| [Allocations help](https://documentation.commerce7.com/allocations) | Limited products, dates, quantities and customer eligibility are business features. This does not establish installed-app CRUD or member assignment endpoints. Exclusive activation remains closed. |
| [Orders API](https://developer.commerce7.com/docs/orders) | Order objects expose coupons, but the public example is empty. The new observer accepts only exact native coupon id + code, customerId, order id and matching updatedAt. A real populated order fixture is still required for sandbox acceptance. Other representations stay unlinked. |
| [Promotions](https://developer.commerce7.com/docs/promotions), [Collections](https://developer.commerce7.com/docs/collections), [App Data](https://developer.commerce7.com/docs/custom-app-data) | Investigated. The Promotions page lists `Store`/`Product`/`Collection`/`Tag`/`Group` for that object, which is analogy only and not Coupon evidence (see the contract section). Promotions are not a substitute for customer identity; App Data is not purchase eligibility. No new permissions or writes use these APIs. |
| [App API permissions](https://developer.commerce7.com/docs/app-apis-webhooks), [release updates](https://developer.commerce7.com/docs/releasing-a-new-version) | Access is configured per app version. Existing installations approve an upgrade; they do not receive new permissions automatically. Allocation is absent from the documented API-access selector. |

### Exact API surface

All paths use `https://api.commerce7.com/v1`, server-only app credentials and the exact original `CommerceConnection.externalAccountId` as tenant.

| Method/path | Purpose |
| --- | --- |
| GET /coupon/{id} | Confirm a revocation by 404. Never used for offers or issuance |
| GET /coupon?q={opaque-code} | Exact, unique coupon recovery; incomplete result sets fail closed |
| POST /coupon | Create the claim's single-use coupon from its frozen snapshot, once per claim, in the live-proven write shape (see "Live Coupon write contract") |
| DELETE /coupon/{id} | Merchant-requested revocation; no automatic points refund |
| GET /tag/customer?page={n}&limit=50 | Recover a claimant-only per-claim tag by its exact opaque title; complete bounded scan required |
| GET /tag/customer/{id} | Exclusive access: resolve the chosen Customer Tag by UUID (Manual + Customer only) at save, Enable, pre-check and provisioning |
| GET /product/{id} | Exclusive access: live, read-only security and availability proof at activation, Enable, pre-check and provisioning; product sync: bounded per-product Product Security read (at most 25 per run) when the list entry omits `security` |
| POST /tag-x-object/customer | Exclusive access: grant the chosen tag to the pinned customer, at most once per claim, after verified absence |
| POST /tag/customer | Create `{title: SQRATCH-<opaque hash>, type: Manual}` |
| GET /customer?cursor={cursor} | Initial exact verified-email binding, at most 20 pages / 1,000 customers |
| GET /customer/{id} | Revalidate the pinned customer and current native email/tag membership |
| GET /customer?tagId={id}&cursor={cursor} | Prove the unique claim tag belongs only to that customer |
| GET /order/{id} | Read-only purchase evidence through the existing order client |

Product security comes from the synchronized catalog plus the live read above; rewards introduce no Product API writes. Customer PUT, Product PUT, tag-definition PUT/DELETE, `DELETE /tag-x-object/...` and Allocation endpoints are intentionally absent.

## Architecture and database

Existing `BrandRewardOffer`, `BrandRewardOfferProduct`, `CommerceRewardRedemption`, `UserPointAccount` and `PointTransaction` remain canonical. The redemption model retains its existing physical table mapping to `ShopifyRewardRedemption`; it is not a new Shopify-only store.

Offers gain exact connection identity, `RewardMode`, closed provider configuration and a durable reserved-claim counter. The counter survives privileged row/account deletion and is decremented only by safe transactional compensation; historical issued capacity cannot reappear through a cascade. The admin user-deletion route serializes a C7 history check with deletion and directs operators to deactivate accounts that have C7 claims. Claims snapshot connection/tenant, offer terms, a versioned frozen coupon snapshot (eligibility, scope, discount, minimum, title), coupon identity, owner, attempt markers and canonical order linkage. Customer-bound claims additionally pin the verified-email timestamp and native customer/tag IDs, and exclusive claims also record membership ownership; bearer claims leave those fields empty. No duplicate raw email, provider secret or raw Customer response is stored. Snapshot identity intentionally survives connection deletion; reconnecting another tenant cannot redirect a historical claim.

Migration `20261008010000_commerce7_rewards` is additive. It adds columns/enums/indexes to reward tables, requires C7 connection/configuration and bounded limits, and permits capacity release only for refunded, never-issued claims without a coupon attempt.

Migration `20261009010000_commerce7_exclusive_access` (new, additive, not applied to any shared database) is required because the applied schema **cannot** represent Exclusive Wine Access: `reward_c7_offer_limits` forbids an active exclusive offer, both discount CHECKs forbid an access-only offer or claim, and durable membership ownership cannot live in the immutable snapshot or in unrelated columns. It adds enum `RewardMembershipOwnership` and four claim columns (`membershipWriteAttempted` defaulting to false, `membershipOwnership`, `providerMembershipId`, `membershipVerifiedAt`). It adds CHECKs `reward_c7_membership_owner` and `reward_c7_membership_write`. It replaces `reward_c7_release_safe` (now also requiring no membership write), `reward_c7_offer_limits` (exclusive offers may be active, still at most 25 claims) and the two discount CHECKs (only a Commerce7 exclusive row may carry no discount). It adds index `reward_c7_membership_inflight`. No row is rewritten, and every existing row satisfies the new constraints. Existing provider data keeps defaults; the new capacity counter is backfilled only for C7 offers. No financial or points tables are rewritten. Existing unique code/idempotency/ledger keys remain decisive. Indexes support offer/user capacity and provider queues.

Fixed amounts and minimums are safe integer cents, bounded by the existing Prisma Int representation. CAD/USD/EUR/GBP/AUD/NZD/ZAR discounts are allowed; unverified monetary exponents are rejected rather than treated as two-decimal currencies. Percentages are whole values 1–100 in the editor, persisted as basis points (1500 = 15%) and written natively in the same 1/100-percent unit (1500); readback compares the same native value, so a coupon created with the old 0.15% value is never adopted. Canonical order money continues using the existing BigInt/minor-unit pipeline. Discount scopes are whole store or exact synchronized catalog products (the latter draft-only until the Coupon scope enum is verified); collections/departments are unavailable. Coupon dates are minute-aligned UTC derived from the claim's stable creation and expiry, so every retry and recovery sends and expects the same window.

### Claim state machine

Exclusive Wine Access claims use the same reservation, owner, ledger, capacity and coupon machinery; their pre-check and membership grant replace the per-claim tag steps 4–5 below (see "Exclusive Wine Access").

1. Serializable transaction reads the authenticated active user (plus verified email stamp for claimant-only rewards), original connected tenant/currency, persisted offer window and caps, and freezes the coupon snapshot from the offer's own rows. An offer whose branch the coupon contract cannot express is refused here, before any debit. Product-scoped offers recheck synchronized availability. It conditionally increments the durable offer capacity counter, checks per-user unreleased claims, creates one claim and spends through `applyPointLedgerEvent` atomically. The database also constrains the counter to the offer ceiling. Unique server idempotency keys bind user + offer + browser request key. An SSI conflict retries the whole short transaction; a losing 26th claim has no debit or provider call.
2. Points and capacity are reserved. Bearer claims enter `POINTS_DEBITED / PROVISIONING` and proceed directly to coupon recovery/creation. Customer-bound claims enter `AWAITING_CUSTOMER`; a matching provider customer must exist. No CRM account is fabricated.
3. A compare-and-swap grants one durable `PROVISIONING` owner. Provider requests occur outside database transactions. For customer-bound claims, the verified-email stamp must remain unchanged; initial lookup is unique and exhaustive within limits. Subsequent reads use the pinned ID.
4. Customer-bound claims only: create/recover one opaque Manual Customer tag. Until CRM assignment is verified, the claim is `AWAITING_ELIGIBILITY` with `MANUAL_PROVIDER_SETUP_REQUIRED`. Merchant assigns it only to the exact displayed native customer ID.
5. Customer-bound claims re-read identity/membership and validate the tag's member list. Both modes first look up the claim's stable code, then persist the coupon-attempt marker before POST. The code is a 128-bit random `SQRA` + 32 hexadecimal value; scope and eligibility come from the contract (or, for a legacy claim, its frozen native values), and the window from the claim. Exactly one POST /coupon is sent and the entire closed response is matched against the reserved terms, ignoring only the cosmetic title and the representation differences above.
6. `ISSUED / READY` exposes the code only to its owner. `entitlementEverGranted=true` permanently consumes issuance capacity. `USED` requires exact paid purchase evidence, not merely creation of an order or coupon.
7. Safe pre-coupon cancellation atomically writes one ledger refund and releases capacity. A write is classified by what the provider could have done:

| POST /coupon outcome | Meaning | Result |
| --- | --- | --- |
| 400 / 422 / other definitive 4xx, or 401 / 403 | Refused; nothing was created and the same request can never succeed | Marker cleared, points refunded once, capacity released, claim closed |
| 429 | Refused before processing | Marker cleared; points stay reserved; retry posts again |
| Timeout, network error, 408, 409, 5xx, unparsable or mismatched success body | The coupon may exist | `MANUAL_REVIEW`; marker retained; no second POST, no refund |

A transient read failure is retryable and cancellable. Attempted writes are never blindly repeated and possible benefits are never blindly refunded.
8. Native expiry hides the code and the worker moves issued claims to `EXPIRED`. Deactivation stops new reservations while preserving already reserved terms. Native deletion produces `CANCELLED / REVOKED`; it neither refunds points nor recycles an issued slot. Historical purchases may still be linked without reopening the revoked claim.

The browser guards repeat clicks and retains its request key after a network failure, including a lost initial response. Explicit terminal responses clear that key for a later intentional claim. API requests cannot choose customer, tenant, Brand, points price, discount or code. Campaign/experience eligibility uses the existing server resolver. Brand management uses the existing role + active-Brand authorization policy.

### Reconciliation

The existing authenticated `POST /api/internal/reconcile-redemptions` runs independent Shopify, C7 provisioning and C7 purchase observers. Existing manually managed Cron scheduling and secret are retained. C7 provisioning processes one due claim per invocation, at most 20 automatic attempts; user/admin checks remain available. Expiry batches are bounded to 20.

Purchase observation scans at most one due claim and five canonical orders per invocation, within a 25-second provider-read budget. Its cursor/check timestamp live on the claim. Failed/disconnected claims rotate fairly without advancing their cursor. Exhausted scans restart so later payment and backfills can be observed. Latency therefore grows with claim/order volume; this is a small bounded initial rollout, not an immediate webhook acknowledgement guarantee.

A match requires C7 provider, exact Brand + original connection, native order ID, pinned customer ID for claimant-only rewards, coupon ID + case-insensitive code, matching provider update version, canonical PAID status, positive gross total and no cancellation. Expired/revoked claims require a purchase within validity. The worker re-reads canonical financial/version evidence in a serializable transaction and records the claim link once. It writes no order, order event, attribution, financial, inventory or points data. Bearer links record coupon redemption, without asserting that the claimant was the purchaser. Later refunds/fulfillment preserve the historical link. If first observed after partial/full refund, missing identity, or an unknown coupon representation, the claim remains unlinked for review.

The webhook handler accepts Order `Create` and `Update` on the same URL. The installed subscription is Order/Update only; adding Order/Create is a separate operator decision with its own procedure (see "Order #1006, delivery diagnosis and Order Create" below). The prior sandbox registration repair and order #1005/#1002 behavior are not redesigned here.

## Post-deployment QA round (2026-10-08): findings and fixes

Production inspection used read-only SELECTs (a `READ ONLY` transaction) and no Commerce7 request was made by the agent.

| Issue | Evidence | Root cause | Fix |
| --- | --- | --- | --- |
| A. 15% applied as 0.15% | Offer `C7 QA 02` stores 1500 bp; its coupon was POSTed with `discount: 15`; Admin showed 0.15%; checkout took CAD 0.03 off 18.97 | The writer divided basis points by 100, trusting an HTTP 201 instead of the applied discount | Native unit is 1/100 percent: 15% is written as 1500, readback compares the same unit. Percentage issuance is **gated** (`percentage.verified: false`) until a live 1500 = 15% is observed |
| B. "Copied" never reset | UI | No reset timer | Copy coupon → Copied → Copy coupon after 2 s; repeat clicks restart it; one card at a time; timer cleared on unmount; failures say so on that card; polite live region |
| C. Empty claim dates | UI | No defaults | New rewards open now and close 30 calendar days later (same local wall time, DST-safe), computed when the form opens; existing open-ended rewards stay open-ended on Edit; end must follow start (client and server); claim window and coupon validity are shown separately |
| D. "· Remove" buttons | UI | Text buttons | Compact chips with an icon-only, labelled `Remove {product}` button; removing the exclusive product also clears its tag, tag options and Active |
| E. Rare wine missing from the Exclusive picker | Every synchronized product, public ones included, had no stored `security`; the last product sync (2026-10-07 17:59 UTC) predates the deployment of security-aware sync (migration applied 2026-10-08 01:41 UTC) | No sync had run with security-aware code; in addition, whether the `/v1/product` list includes `security` is unproven | A list entry without `security` is now *unknown*, never unsecured. Each sync reads Product Security per product with public `GET /v1/product/{id}` for at most 25 available products whose security is unknown or whose provider version changed (unknown first), reuses known security for unchanged products, and never wipes known security after a failed read. The picker reports "Product Security has not been read yet for N products — Sync" instead of "no eligible products" |
| F. Multi-tag products draft-only | Safety gate | OR/AND semantics unverified | Gate unchanged; the editor explains why and exactly what sandbox evidence enables it |
| G. Order #1006 missing | No `CommerceOrder` row; no order event of any kind after 2026-10-07 05:20 UTC; `reconciledThrough` 2026-08-26; last Custom Range 2026-10-06 23:13 → 10-07 04:13 | The subscription is Order Update only (zero Create events ever recorded); a completed checkout with no later update produces no webhook; the catch-up worker is intentionally unscheduled | No code change. Operator recovery: **Order Operations → Custom Range** covering #1006's update time (see below). Optional, separate operator decision: subscribe Order Create (the receiver already accepts `Create` idempotently) or schedule the existing authenticated catch-up worker |
| H. Claim still "Ready to use" | The observer checks each issued claim every few minutes but no imported order exists | Missing canonical order (G). After import, linking also requires the order's `coupons[]` entry to carry the exact native coupon `id` and `code`, a populated shape not yet observed | Each pass now records a PII-free reason on the claim (`PURCHASE_CHECK:NO_MATCHING_ORDER`, `…COUPON_IDENTITY_UNCONFIRMED`, `…ORDER_VERSION_STALE`, `…ORDER_NOT_ELIGIBLE`, `…PROVIDER_UNAVAILABLE`) and the Brand sees it with the last-checked time. A used coupon reads "Coupon used" and never shows its code. Matching is unchanged and still strict |
| I. "Title · Active" text | UI | Inline text | Separate status badge with text: green Active, red Inactive, matching the Shopify rewards badge styling |

### Remediating the percentage coupon already issued

The `C7 QA 02 - Fifteen Percent` claim holds a single-use coupon that Commerce7 applies as 0.15%. SQRATCH never mutates issued coupons, claim snapshots or spent points. Choose one, as an operator:

1. **Correct it in Commerce7 (keeps the customer's code):** in Commerce7 Admin → Coupons, open the coupon whose title starts `SQRATCH C7 QA 02 - Fifteen Percent` and set the discount to 15%. This matches what SQRATCH recorded (1500 basis points). No SQRATCH change is needed.
2. **Revoke it and reissue:** Brand Rewards → Recent claims → Revoke coupon (deletes the native coupon and verifies it is gone; capacity stays consumed, points are not refunded automatically). Return the points only through a separately authorized ledger adjustment, then let the member claim a correctly generated reward once percentage issuance is verified.

The offer itself keeps showing 15% and is paused for new claims while percentage units are unverified. Do not activate new percentage rewards until the verification step in the checklist below passes and `percentage.verified` is set with its evidence.

### Order #1006 recovery and the Create subscription

Immediate, no configuration change: **Brand → Commerce → Order Operations → Custom Range**, from **2026-10-07 00:00 (your browser's local time) to now** (#1006 was reported as created on October 7. SQRATCH issued its product-specific coupons at 2026-10-08 08:29 UTC and later, so an order using one carries a Commerce7 time at or after that instant; starting on October 7 covers both readings, and an earlier start is harmless because the import is idempotent), then run it until it completes. It reads the public order list by `updatedAt`, ingests idempotently and never fabricates attribution or totals; repeating it is safe. Then confirm #1006 appears once with its real totals. The reward observer will recheck the Chardonnay claim within a few cron cycles.

Evidence for a separate operator decision on Order Create: the ledger contains zero `Create` events since installation; every recorded order arrived as `Update` or backfill; `handleCommerce7OrderWebhook` already accepts `Create` and `Update` on the same URL, authenticates before parsing, deduplicates by payload digest and resolves the exact tenant connection. Subscribing Order Create in the Commerce7 app (same URL and Basic auth) is therefore compatible, but it changes the app's webhook configuration and must be approved and tested as its own step (deliver a sandbox Create, confirm one canonical order, then the Update dedupes). Alternatively, schedule the existing authenticated `POST /api/internal/commerce7-reconciliation-worker` (see production-stabilization-2026-10.md). Neither is done by this change.

## Final Commerce7 QA (2026-10-09)

| Area | Finding | State |
| --- | --- | --- |
| Percentage discounts | Live evidence: `POST /v1/coupon` 201 with `Percentage Off` / `discount: 1500` / `Enabled`; Admin "15.00% Off"; checkout CA$29.00 → CA$4.35 off and CA$39.00 → CA$5.85 off (`live-coupon-percentage-1500-observation.json`) | `percentage.verified = true`, `nativeUnitsPerPercent = 100`. Percentage Discount offers can be activated in the editor and enabled with **Enable**; claims issue the native 1500. Verification activates nothing by itself (both `C7 QA 02` offers stay inactive until the Brand enables one); invalid percentages are still rejected; the historical 0.15% coupon is never rewritten |
| Multi-tag Exclusive Wine Access | Storefront evidence: any one of the product's Manual Customer Tags grants purchase (OR) | Verified. The Brand picks exactly ONE tag; SQRATCH grants only that tag and never changes the others |
| Points for Exclusive claims | Operator rule: a voluntary claim always costs the configured points, whether the customer holds no security tag, a different one, or the chosen one | Enforced. No pre-check shortcut and no refund for existing access. With the chosen tag already held, SQRATCH writes no membership, records it as `PRE_EXISTING` (never its own) and completes the claim. Per-user limits, capacity, idempotent replays and the one-in-flight-claim guard are unchanged. Historical claims refunded under the earlier rule still read "points returned" |
| Discount eligibility | — | Anyone with the code only; legacy claimant-only drafts need an explicit, confirmed edit; Exclusive Wine Access is claimant-bound |
| QA 04 coupon USED | Read-only check: QA 04 is **USED**, linked to #1006, `usedAt` 2026-10-08 08:47:06 UTC (the order's creation time) | Root cause of the earlier "ISSUED / PURCHASE_CHECK" state: the previous matcher compared the applied entry `id`, not `couponId`. The deployed matcher (couponId + exact code) linked it; `usedAt` equal to the order's creation time is only written by the new code, so production runs it. The leftover `PURCHASE_CHECK:COUPON_IDENTITY_UNCONFIRMED` text on that row is from the earlier pass: the link now clears the reason and records the check time |
| #1007 over-refund | Commerce7 lists TWO full refund children (#1008 and #1009, each CAD 162.72, different successful refund tenders) for a CAD 162.72 order: cumulative refunds CAD 325.44 | Superseded on 2026-10-10 (see "Over-refund anomaly" below): #1007 now imports as one canonical REFUNDED order (gross 162.72, refunded 162.72, net 0.00) with the excess CAD 162.72 recorded as a durable warning. #1008/#1009 remain refund documents, never sales. #1002 (9831 gross, 3277 refunded, 6554 net, PARTIALLY_REFUNDED) is unchanged |
| QA 05 coupon | Its only purchase is #1007 | Stays ISSUED. A claim is marked USED only from a canonical order that is currently PAID and uncancelled; an order first seen refunded (or rejected) is never linked automatically, and SQRATCH never pretends an over-refunded order is PAID (#1007 is stored REFUNDED). QA 05's Customer Tag access is not affected by the coupon or the refund |
| Webhook authentication | Resolved by reinstalling the test app; Order Create/Update now deliver with Basic auth | Unchanged receiver (401 without valid credentials) |

### Read-only diagnostic SQL (physical names)

The claims table is `"ShopifyRewardRedemption"` (model `CommerceRewardRedemption`): `externalDiscountId` is `"shopifyDiscountNodeId"`, `externalDiscountStatus` is `"shopifyDiscountStatus"`, `externalAccountId` is `"shopifyShopDomain"`, `providerLastCheckedAt` is `"shopifyLastCheckedAt"`; `BrandRewardOfferProduct.externalProductId` is `"shopifyProductGid"`. Run inside `BEGIN READ ONLY; … ROLLBACK;`. None returns a code, email or customer ID.

```sql
-- 1. The Commerce7 connection and its last product sync (no secrets)
SELECT id, status, "externalAccountId" AS tenant, "lastProductSyncAt"
FROM "CommerceConnection"
WHERE provider = 'COMMERCE7' AND status = 'CONNECTED';
-- 2. Did #1006 arrive? Orders updated or imported since 2026-10-07 (no customer fields)
SELECT "orderNumber", "financialStatus", "totalMinor", "totalRefundedMinor", "providerCreatedAt", "providerUpdatedAt", "createdAt" AS "importedAt"
FROM "CommerceOrder"
WHERE provider = 'COMMERCE7' AND ("providerUpdatedAt" >= '2026-10-07' OR "createdAt" >= '2026-10-07')
ORDER BY "providerUpdatedAt" DESC NULLS LAST;
-- 3. What reached ingestion since 2026-10-07: webhook (commerce7:order:Create / :Update) and backfill events
SELECT topic, status, "failureSummary", "providerUpdatedAt", "receivedAt", "processedAt", ("orderId" IS NOT NULL) AS "linkedToOrder"
FROM "CommerceOrderEvent"
WHERE provider = 'COMMERCE7' AND "receivedAt" >= '2026-10-07'
ORDER BY "receivedAt" DESC;
-- 4. Catch Up / Custom Range checkpoint
SELECT s."reconciledThrough", s."targetThrough", s."lastAttemptedAt", s."lastRunOutcome", s."customRangeFrom", s."customRangeTo", s."customRangeCursor", (s."activeRunId" IS NOT NULL) AS "runActive"
FROM "CommerceOrderReconciliationState" s
JOIN "CommerceConnection" c ON c.id = s."connectionId"
WHERE c.provider = 'COMMERCE7';
-- 5. Reward claims: coupon presence, order linkage and the purchase observer's last check (no codes, emails or customer IDs)
SELECT o.title, r.status, r."provisioningState", r."rewardMode",
       (r."shopifyDiscountNodeId" IS NOT NULL) AS "hasNativeCoupon",
       r."shopifyDiscountStatus" AS "nativeCouponStatus",
       co."orderNumber" AS "linkedOrderNumber", r."usedAt",
       r."rewardOrderCheckedAt" AS "purchaseLastCheckedAt", r."lastReconcileReason",
       (r."rewardOrderCursor" IS NOT NULL) AS "orderScanInProgress",
       r."issuedAt", r."expiresAt", r."createdAt"
FROM "ShopifyRewardRedemption" r
JOIN "BrandRewardOffer" o ON o.id = r."offerId"
LEFT JOIN "CommerceOrder" co ON co.id = r."canonicalOrderId"
WHERE r.provider = 'COMMERCE7'
ORDER BY r."createdAt" DESC
LIMIT 20;
-- 6. Offers: stored Active/Inactive plus the inputs of the eligibility verdict
SELECT o.title, o."isActive", o."rewardMode", o."discountType", o."discountPercentageBasisPoints",
       o."commerce7Config"->>'eligibilityMode' AS "eligibilityMode",
       o."commerce7Config"->'exclusiveAccess'->>'tagTitle' AS "grantedTagTitle",
       o."reservedClaimCount", o."maxTotalRedemptions", o."claimStartsAt", o."claimEndsAt",
       count(p.id) AS "productCount"
FROM "BrandRewardOffer" o
LEFT JOIN "BrandRewardOfferProduct" p ON p."offerId" = o.id
WHERE o.provider = 'COMMERCE7'
GROUP BY o.id
ORDER BY o."createdAt";
-- 7. Product Security as synchronized (tag count only, never tag IDs)
SELECT title, "isAvailable", ("providerMetadata" ? 'security') AS "securityRead",
       "providerMetadata"->'security'->>'availableTo' AS "availableTo",
       CASE WHEN jsonb_typeof("providerMetadata"->'security'->'availableToObjectIds') = 'array'
            THEN jsonb_array_length("providerMetadata"->'security'->'availableToObjectIds') ELSE 0 END AS "tagCount",
       "providerUpdatedAt"
FROM "ConnectedCommerceProduct"
WHERE provider = 'COMMERCE7'
ORDER BY title;
```

### Browser QA (reuse existing offers and orders)

1. **Percentage.** Brand Rewards → `C7 QA 02 - Fifteen Percent New` shows **Inactive** with no "Cannot be enabled yet" badge → **Enable** → **Active** + **Open for claims**. As a member, claim it once: the coupon shows 15% in Commerce7 Admin. (Leave `C7 QA 02 - Fifteen Percent` inactive; its issued 0.15% coupon needs separate remediation.)
2. **Editor.** Create reward → Discount → Percentage: Active is enabled; no "draft only" label.
3. **QA 04.** Brand claims: "Coupon used. Purchase linked to SQRATCH order …"; member shop card: "Coupon used", no code. SQL 5: `USED`, `linkedOrderNumber` 1006.
4. **QA 05.** Brand: **Active** + **Open for claims**; claim stays ISSUED (its order #1007 is rejected as contradictory); the member still has access.
5. **Points rule.** C7 QA 05 allows one claim per member and has one of two slots left. Sign in as a second SQRATCH member whose verified email matches a Commerce7 customer that already holds `SQRATCH Rare Wine Test`: the button reads "Claim access for 1 point"; after claiming, 1 point is spent, the claim is ISSUED with the $5 code, Brand Rewards shows "The customer already had this tag before the claim…", and Commerce7 still lists the tag once (no new membership). A repeat click or refresh does not spend again.
6. **Loading spinner.** Create reward → Exclusive wine access → tick Rare - 2015 Chardonnay: a small spinner with "Loading Customer Tags…" appears at once, then the tag selector; quickly ticking another product shows only that product's tags.
7. **#1007.** Order Operations shows the last error "1 order was rejected because Commerce7 reports refunds larger than the order total…"; SQL 3 shows `CONTRADICTORY_FINANCIAL_SNAPSHOT` for `cf8351cd-…`; SQL 2 does not list 1007. Correct it in Commerce7 (void one of #1008/#1009) or leave it as a known anomaly.

## Merchant setup and readiness

### App Development Center — operator only

In the SQRATCH app, select its development version (or Add Version to copy an existing published version), then Step 1: APIs & Webhooks → Add API Access. Add missing access below; preserve existing access needed by catalog/orders/refunds.

| Endpoint | Access | Why |
| --- | --- | --- |
| Coupon | Full | Create each claim's coupon, recover it by code, and delete it on revocation |
| Tag | Full | Customer-bound mode: read/create unique Manual Customer tags. Exclusive access: read the chosen tag and grant it (`POST /tag-x-object/customer`; the live grant succeeded with the app's existing access, but confirm which access covers it) |
| Customer | Read | Resolve email identity; read tag membership before and after a grant |
| Product | Read | Synchronized catalog (including Product security) and the live exclusive-access security check |
| Order | Read | Existing ingestion plus exact reward purchase observation |

Do not request Customer Full, Product Full or Allocation for this implementation. Preserve the sole Order/Update callback `https://www.sqratch.com/api/commerce7/webhooks/orders`, its authentication, and existing install/uninstall URLs. Save the version. For a published app, submit the updated version for approval; approve the resulting upgrade in the test tenant's app interface before assuming the permissions exist. Normal version upgrades do not require uninstall/reinstall. If a private development installation offers no upgrade path, ask Commerce7 Support for its supported version transition; do not repeat the earlier uninstall workaround automatically.

Readiness shows connection/currency, backend credential presence, access requirements, which mode requires manual eligibility, which coupon branches can go live, that exclusive access is supported, and that multi-tag access is unverified. Credentials present is not proof of granted permissions. Saving a discount needs no Commerce7 permission because it makes no provider call; an exclusive save needs Tag read access. Permission problems surface at claim time as a controlled setup error with the points returned. This code has not verified live tenant permissions.

### Reward setup and per-claim handoff

1. In Brand Rewards choose a title, eligibility and **Applies to**, then points, discount (fixed amount or percentage), optional minimum subtotal, dates, caps and validity. **Nothing is created in Commerce7 and nothing is copied from it.**
2. For **Anyone with the code** with **All products**, save and activate. Each claim creates and returns one unique single-use coupon automatically.
3. **Selected products** (Anyone with the code) save and activate like All products: each claim's coupon is limited to the exact synchronized products. Discount rewards are always **Anyone with the code**; a legacy claimant-only discount can only be re-saved after the Brand explicitly confirms the change, and cannot be enabled until then. For **Exclusive wine access**, follow the merchant setup in the Exclusive Wine Access section.
4. For claimant-only discount claims (legacy offers, or once verified), the store assigns the claim's opaque Customer tag by hand: find the exact native customer and opaque tag ID/title in Recent claims, verify the same email, assign the tag only to that customer in CRM, then Check provider result. SQRATCH never writes membership for these per-claim tags; the only membership write is an Exclusive Wine Access grant.
5. **When an offer can be edited.** Terms are editable while no capacity is reserved and every historical claim is provably dead: `REFUNDED`, `FAILED_FINAL`, slot released, never granted, no open coupon attempt, no membership attempt, no coupon ID, no review, no owner, no purchase (`COMMERCE7_EDIT_SAFE_CLAIM`). An exclusive claim refunded because the customer already had the tag is provably dead. That covers a definitive provider rejection and a cancellation before issuance. Any pending, issued, used, expired, revoked or manual-review claim keeps the offer immutable. The server enforces this on every save; the Brand UI only mirrors the server's `editable` verdict. Historical claims and their frozen snapshots are never modified, and saving makes no Commerce7 call. Switching **Reward mode** back to Discount resets eligibility, scope, products and the discount toggle to the normal defaults.
6. **Disable and re-enable.** Active offers show **Disable**, inactive ones show **Enable**; neither needs Edit. Both are explicit server actions (`PATCH` with `{ "action": "DISABLE" | "ENABLE" }`), never a blind flip. Disable is always allowed and changes only `isActive`: it does not touch claims, snapshots, points, capacity or issued coupons. Enable first re-validates the **current** offer and refuses, leaving it inactive, unless every check passes: the Brand owns a Commerce7 offer; the backend is configured; the original connection, tenant and currency are still connected and usable; the stored configuration parses; its limits, window, discount, catalog products and draft-only rules still hold (the editor's own validators); and its eligibility/scope branch is supported by the verified coupon contract (or a legacy offer's retained evidence). For an exclusive offer it also requires a `CONFIGURED` single-tag product and live reads proving the tag and product security, with no change between validation and commit. Enabling creates nothing in Commerce7. A bodiless Commerce7 `PATCH` still means disable; Shopify's `PATCH` is unchanged.
7. Each native coupon is titled `SQRATCH <offer title> <8-hex claim reference>` in Commerce7; the title never contains the code, an email or the claim ID.

One coupon per discount claim is required in both modes; an exclusive claim has one membership grant and at most one coupon. Only claimant-only discount rewards create a tag (one per claim); exclusive rewards never create or delete tag definitions. Discount caps are bounded at 1,000; exclusive offers at 25. Shared offer tags are not used for claimant-only coupons. Provider administrators remain trusted to preserve restrictions after issuance.

### Claimant rewards card: viewer states

`GET /api/rewards/commerce7` returns one safe, discriminated `viewerState` instead of an error, so the card never silently disappears:

| State | When | Response | Card |
| --- | --- | --- | --- |
| `SIGNED_OUT` | No session | `offers: []`, `claims: []`, `points: null` | "Sign in to view the rewards available for this experience." and **Log in** → `/login?callbackUrl=<current internal path and query>` |
| `LOCKED` | Signed in, campaign not unlocked | same empty payload | "You have not unlocked this campaign yet. Scan and unlock this campaign to view its rewards." No action |
| `READY` | Signed in and unlocked | the existing data plus `viewerState: "READY"` | unchanged: points, offers, prior claims, claim |

SIGNED_OUT and LOCKED are built before any offer, claim, points or connection read, so no private reward information can be included. They are returned only when the experience's linked Brand has a Commerce7 rewards program configured (one boolean and no offer detail); otherwise the response is an empty `READY`, which renders nothing, so a Shopify-only experience shows no Commerce7 card. The callback goes through the existing `buildLoginPathWithCallback` / `normalizeInternalRedirectPath`, so a hostile current path falls back to `/dashboard`. **This is presentation only**: the claim, retry and cancel routes still reject anonymous users with 401 and locked or wrong-context users with 403/404 before any reservation, and `getRewardClaimContext` is unchanged.

### Safe claim diagnostics

Provisioning failures log one event containing only `event`, `stage`, `code`, `uncertain`, `provider`, connection ID and claim ID. The same bounded `STAGE:CODE` token is stored on the claim and shown to the Brand. Stages: `ACCESS_VERIFY`, `CUSTOMER_LOOKUP`, `TAG_CREATE`, `TAG_ASSIGN`, `MEMBERSHIP_VERIFY`, `COUPON_RECOVERY`, `COUPON_CREATE`, `COUPON_VERIFY`. No raw body, exception, credential, tenant, customer data, email or coupon code is logged or stored.

| Condition | Result | Action |
| --- | --- | --- |
| 401/403 or missing server setup (`SETUP_INCOMPLETE`) | Points returned | Review credentials/connection and Coupon: Full (Tag: Full / Customer: Read for customer-bound mode). |
| Definitive 4xx on create (`WRITE_REJECTED`, stage `COUPON_CREATE`) | Points returned | Commerce7 rejected the request body. Capture the sanitized token and a redacted coupon GET for contract review; do not loosen validation. |
| Network/timeout, 408/409/5xx (`uncertain`) | Manual review, points held | Use Check provider result; recovery reads by code and never reposts. |
| 429 / transient read (`PROVIDER_UNAVAILABLE`) | Retryable | Retry after recovery. |
| Coupon terms differ from the reservation (`COUPON_CONFLICT`) | Manual review | A coupon with this code exists with other terms. Inspect it privately. |
| Branch not yet verified (`COUPON_CONTRACT_UNVERIFIED`) | Refused before debit | Use a verified option or wait for the missing fixture. |
| Exclusive tag or product drifted (`TAG_UNAVAILABLE`, `PRODUCT_SECURITY_CHANGED`, `MULTI_TAG_UNVERIFIED`) | Refused before debit, or refunded if nothing was written | Fix the tag or Product security in Commerce7, sync products and review the offer. |
| Exclusive grant result unknown (`TAG_ASSIGN` uncertain, `MEMBERSHIP_RESULT_UNKNOWN`) or membership changed (`MEMBERSHIP_CHANGED`) | Manual review, points held | See Recovery. SQRATCH never re-posts and never deletes. |
| Grant accepted but not yet visible (`MEMBERSHIP_NOT_CONFIRMED`) | Retryable | Check again; never re-posted. |

### Exclusive Wine Access — remaining facts to verify in the sandbox (operator)

None of these can be proven from the public documentation or the evidence supplied, so the code fails closed on each:

1. **Multi-tag access semantics — verified 2026-10-09.** Holding any one of a product's Manual Customer security tags is sufficient (OR); see `live-multi-tag-storefront-observation.json`. `multiTagAccessVerified` is true; SQRATCH still grants exactly one chosen tag.
2. **Storefront purchase with a SQRATCH-granted tag.** After a SQRATCH claim, log in as that customer and confirm the secured wine can be bought, and that it cannot be bought by a customer without the tag.
3. **Permission.** The live grant ran with the SQRATCH app's existing API access. Confirm in App Development Center which access covers `POST /tag-x-object/customer` on the installed version (expected: Tag: Full).
4. **`GET /v1/tag/customer/{id}` live shape.** It is documented but has not been captured live. Capture a redacted GET (including a dynamic tag) and add it to the fixtures.
5. **Error contract of the grant.** Capture a 4xx (for example an unknown tag) to confirm it is a definitive refusal.

## Recovery and revocation

* Customer-bound mode — missing customer or manual assignment: create/use a same-email Commerce7 account or complete CRM assignment, then retry. Users can cancel while no coupon attempt, membership attempt or benefit exists; refund keys prevent duplicate credit.
* Exclusive access — ambiguous grant (`TAG_ASSIGN` uncertain, or `MEMBERSHIP_RESULT_UNKNOWN`): open the customer in Commerce7. If the tag is present, use Check provider result, and SQRATCH finalizes with `UNVERIFIED` ownership. If it is absent and access should be granted, assign the tag in CRM yourself, then use Check provider result. SQRATCH never sends a second grant and never refunds once a grant may have happened. "Access granted, discount could not be issued" needs a separately reviewed decision (a manual coupon in Commerce7, or a separately authorized points adjustment). Never delete the membership on SQRATCH's account: Commerce7 deletes every copy.
* Ambiguous tag/coupon result: let the request finish, inspect the native resource privately and use Check provider result. Recovery compares exact title/code and full terms. Absence after an attempted POST stays manual; it does not authorize another POST or a refund that could coexist with a live coupon.
* Explicit permission denial or definitive provider rejection: fix the app/version access or review the sanitized diagnostic token. An unissued compensated claim is terminal; the user makes a fresh claim with a new request key.
* Crashed durable owner: first stop/terminate the owning invocation and confirm no provider request remains in flight. Do not use owner age alone as proof. Inspect claim IDs, attempt flags and native outcome. A qualified operator may then clear **only the observed owner**, preserving both attempt flags, in a compare-and-swap update. Example below is a future operator action, not run during implementation. Check provider result then performs lookup recovery. If ownership changed or status is no longer POINTS_DEBITED, stop.

```sql
UPDATE "ShopifyRewardRedemption"
SET "provisioningOwner" = NULL, "needsManualReview" = TRUE,
    "provisioningState" = 'MANUAL_REVIEW'
WHERE "id" = '<reviewed-claim-id>' AND "provider" = 'COMMERCE7'
  AND "status" = 'POINTS_DEBITED'
  AND "provisioningOwner" = '<observed-stopped-owner>';
```

* Possible coupon issuance with unresolved provider absence: requires Commerce7/operator confirmation of the final outcome. Never edit cached balances or clear attempt markers to force a retry. Any separately authorized points adjustment must use the existing ledger and close the claim against future provisioning; it is not an automated compensation path implemented here.
* Revoke an issued coupon through the Brand action. The server deletes the pinned coupon and verifies GET 404 before recording revocation. A concurrent purchase may still have succeeded; check Orders before any separately reviewed points adjustment. Customer tag definitions/membership are not automatically deleted, and historical records/capacity remain.

## Deployment state and rollout

The operator confirms migration `20261008010000_commerce7_rewards` is already applied in production; its SQL is unchanged. **Apply `20261009010000_commerce7_exclusive_access` before deploying this code**, through the normal reviewed `prisma migrate deploy` for the target environment. The redemption table is shared with Shopify rewards, so code that reads the new columns fails on a database without them. Applied first, the migration is compatible with the currently deployed code (additive columns with defaults, and relaxed constraints only). No db push, reset, migrate dev, migrate deploy against a shared database, Supabase access or provider mutation was performed during implementation. The migration was replayed only on a disposable local Postgres for the opt-in tests.

Rollback: disable exclusive offers first and let in-flight exclusive claims finish or reach review. Reverting the code is compatible with the migrated schema. Do not drop the new columns while any exclusive claim exists; any schema removal is a separately reviewed migration. SQRATCH-granted memberships stay in Commerce7 after a rollback.

No new production environment variables are required. Retain the existing server-only COMMERCE7_APP_ID, COMMERCE7_APP_SECRET, database configuration and CRON_SECRET. Never add NEXT_PUBLIC credentials. No Vercel settings were changed. Test-only ALLOW_REAL_DATABASE_TESTS / COMMERCE7_REWARDS_REAL_DB must not be enabled against shared databases.

Future operator rollout: review → apply the new migration → confirm app permissions (Coupon: Full, Tag: Full, Customer: Read, Product: Read, Order: Read) → perform the sandbox checks below → deploy the reviewed application when authorized → create inactive offers → small-cap acceptance → activate. Activate exclusive offers only on single-tag products, and only after the remaining-facts checks above. Keep the current externally managed reconciliation schedule; do not add a new cron or webhook subscription.

Rollback: disable new C7 offers first. Preserve and service existing claims, points history and provider resources; code rollback cannot revoke a native coupon. Reverting application code is compatible with the additive columns/defaults, but it stops C7 recovery, so retain an operator plan for pending claims. Leave the migration applied. Dropping columns/enums or reversing ledger events is not a safe automatic rollback; any later schema removal requires a separately reviewed migration after all claims are resolved.

## Sandbox acceptance checklist — operator performs provider writes

1. Verify main/dirty diff, already-applied migration, server configuration and manually approved test permissions. Confirm anonymous and wrong-role Brand requests are denied. Test both connected providers and explicit selection.
2. Create the first sandbox claim for an **Anyone with the code / All products** offer and read the created coupon back in Commerce7 Admin and via GET. Confirm `Per Store`/`usageLimit 1` is accepted and enforced (one redemption total), the `title`, the minute-aligned dates, and that omitting `appliesToObjectIds`, `availableToObjectIds`, `shippingDiscount` and (when none) `minimumCartAmount` was accepted. Fixed-dollar behavior across multiple items and the 36-character code length must also be checked in the real sandbox. A definitive rejection returns the points and records a `COUPON_CREATE:WRITE_REJECTED` token to capture.
3. Discount rewards are Anyone with the code only; no customer-restricted Coupon fixture is needed. Create inactive $10 and 15% offers, minimum subtotal, whole-store scope, windows/caps/validity. Update an unclaimed offer, activate, disable, and verify stale terms cannot be edited once a claim exists. Saving any offer must create nothing in Commerce7.
4. For claimant-only rewards (only once the tag enum is verified, or on a legacy offer), Alice uses a verified SQRATCH email and sufficient points. Claim once, double click, and retry a lost response. Check exactly one claim/debit/tag. Missing native customer stays pending; cancel twice returns points once. Wrong/duplicate CRM email fails closed. Changing the verified SQRATCH email blocks provisioning.
5. For claimant-only rewards, assign Alice's unique tag only to the displayed native customer. Check again: one matching coupon becomes ready. Login with the same email, apply the code, verify minimum/scope/amount/expiry/one-use behavior. Bob with a different account must not use Alice's leaked code. Remove/alter membership and confirm native enforcement; this is essential before production activation.
6. For bearer rewards, claim with no matching Commerce7 Customer; verify no new Customer tag and one usable Everyone coupon. Redeem with another account and confirm a second use is rejected. Exercise 25 allowed reservations and concurrent claim 26; verify loser has no debit/resource. Issued/used/expired/revoked claims retain capacity. Provider inventory remains separately authoritative; a claim does not reserve a bottle.
7. Simulate read failure and lost tag/coupon response in a controlled test environment. Retry recovers existing exact resources; unknown absence does not create a duplicate or blindly refund. Check durable owner recovery only after stopping its invocation.
8. Exclusive access: secure a sandbox wine to one Manual Customer Tag, sync, create an access-only reward and choose the tag.
   * Claim as a member whose Commerce7 email matches. Expect one `POST /tag-x-object/customer`, the tag listed once on the customer, 100 points spent, and the claim showing "Access granted". Log in to the storefront and buy the wine.
   * Claim again with a new request (per-user limit permitting): 100 more points, no second `POST`, the tag still listed once.
   * Claim as a member who already had the tag: 100 points, an ISSUED claim, no `POST`, the tag still listed once.
   * With an optional 15% discount: one tag grant plus one `Product`-scoped single-use coupon.
   * Secure a second wine to two tags: the reward saves as a draft and cannot be activated.
   * Delete or change the tag, make the wine public, or remove the tag from the wine: claims are refused before any debit.
   * Never remove memberships through SQRATCH; confirm the Brand "revoke" refusal.
9. Make an actual synthetic paid Commerce7 purchase, capture a redacted populated order GET with coupon identity, and run the existing reconciliation worker. Exact identity/version should link once. If the native representation differs, leave it unlinked and supply the fixture for the closed parser to be extended. Repeat Update, fulfillment, cancellation, partial/full refund and multiple/unknown coupon cases; points and financial arithmetic must not change due to reward observation.
10. Revoke an unused issued coupon, verify native absence and preserved capacity/history, then test expiry and disconnected/original-tenant recovery. Confirm the existing Order/Update subscription still processes fulfillment and order #1002 partial-refund behavior; do not register Create.
11. Run the unchanged Shopify offer, claim, discount, points, lifecycle, storefront and usage flows. Review responsive layout, labels, keyboard access and code copy on a real browser. Automated component execution tests are not a substitute for this operator QA.

## Final rewards QA and CI repair (2026-10-10)

### Custom Range timezone (CI)
The Custom Range picker converts the operator's local `datetime-local` value to an exact UTC instant in the browser (`new Date(local).toISOString()`); the server receives and validates that instant unchanged. The CI failure was a test that assumed the runner was not on UTC. Tests now pin `process.env.TZ` per case (UTC, America/New_York, Asia/Kolkata), cover both New York DST transitions, the future ceiling and a reversed range, and assert that a New York selection reaches the reconcile route unchanged on a UTC server.

### Over-refund anomaly (Commerce7 #1007)
When the settled refund documents linked to a sale add up to more than the sale total, ingestion keeps one canonical order and counts refunds only up to the sale (refunded = total, net 0, REFUNDED). The extra amount is never dropped silently: the PROCESSED order event that applied the bounded snapshot records the closed note `OVER_REFUND_EXCESS:<minor units>` in `CommerceOrderEvent.failureSummary` (no new column, no migration). Order Detail reads the latest processed event for that Brand-scoped order and shows an amber "Over-refund reported by Commerce7" warning with the extra amount, the provider's full refund total and the sale total. Order Operations activity shows the same note. Nothing else happens automatically: no reversal, retry, points, claim, workflow or notification change. The shared provider-neutral guard (refunds ≤ total) and Shopify ingestion are unchanged. The order is ingested, so the range and the Catch Up checkpoint are no longer blocked.

* Corrected later (a newer provider version whose refunds fit): that event carries no note, so the warning clears.
* Known limitation (P3): a provider correction that keeps the same `updatedAt` is skipped as stale, so the earlier warning would remain until a newer version arrives.
* After deployment, the earlier FAILED events for #1007 stay as history. The next Update webhook, or a Custom Range covering the order, imports it.

### Capacity and concurrency (Test 6)
On a disposable Postgres, 30 distinct users claim a 25-claim bearer reward at the same moment. Every outcome is safe: never more than 25 reservations, the counter always equals the reservations, and a rejected claimant has no claim and no debit. Under that burst, roughly 12 of 30 requests exhaust the four serializable attempts (Prisma P2034). The route answers "Reward processing failed. Please retry"; the browser keeps the same request key, so the retry is idempotent. Replaying every request settles at exactly 25 claims and 25 debits; the other five, and a later 26th claimant, receive SOLD_OUT with no charge. The suite also covers: two tabs (different keys) racing a per-user limit of 1; double clicks and a late lost-response retry on a per-user limit of 3; and the bearer coupon payload (Everyone, Per Store, usage limit 1, no customer or tag).

### Running the real-database suites (disposable only)
Never point these at Supabase or any shared database; `canUseRealDatabaseUnderTest` refuses non-loopback hosts and names that do not end in `_test`. Locally (Postgres 17):

1. `initdb` a throwaway data directory with `LC_ALL=C`. Start it on `127.0.0.1` with `-c unix_socket_directories= -c ssl=on` and a self-signed `server.crt`/`server.key` in the data directory (the app's pg adapter always uses TLS).
2. `createdb sqratch_test`. Replay every `prisma/migrations/*/migration.sql` in order except the historical `202604_lms_migration` baseline.
3. Run with `DATABASE_URL=postgresql://<user>@127.0.0.1:<port>/sqratch_test PG_SSL_REJECT_UNAUTHORIZED=false ALLOW_REAL_DATABASE_TESTS=true` and the suite flags: `COMMERCE7_REWARDS_REAL_DB`, `COMMERCE7_ORDER_RECONCILIATION`, `COMMERCE7_CONNECTION_LIFECYCLE`, `POINT_ACCOUNT_CONCURRENCY`, `COMMERCE_CONNECTION_LOCK`, `PUBLIC_SHOP_PAGINATION_REAL_DB` (each `=true`), then `npx tsx --test <file>`.
4. Stop the server and discard the directory.

## Automated verification and review boundaries

Tests execute domain mapping, real claimant routes, actual TSX with controlled hooks, and an opted-in real PostgreSQL saga. Service tests also run the actual saga against a stateful fake Commerce7 tenant, including template-free issuance, ambiguous and definitive POST outcomes, claimant-only security with an injected verified contract, legacy snapshot compatibility and mid-issuance recovery. The DB harness requires the existing safety opt-in, a loopback database ending `_test`, and COMMERCE7_REWARDS_REAL_DB=true. It has no live provider traffic and cleans only its own fixtures. It covers cap 25 (including a 30-claimant burst), competing points spends, duplicate keys, cancellation/refund, rollback, durable owners, lost responses, exact customer/connection guards, SQL constraints, capacity surviving a deliberately privileged fixture deletion, and read-only order linkage. Executed admin-route tests protect account-deletion history retention.

Existing Shopify, Commerce7 ingestion/refund/fulfillment and financial invariants remain in the full suite. The generic reconciliation worker is now explicitly Shopify-only so it cannot compensate a pending C7 saga. Shared serializers preserve old contracts; provider-neutral capabilities describe optional customer binding in this durable reward workflow; generic createDiscount C7 methods remain unsupported.

Known limitations requiring acceptance:
* Claiming customer only is retired for discounts. Legacy claimant-only discount claims keep their per-claim tags, which are still assigned manually in CRM.
* Multi-tag exclusive products are supported (verified OR semantics); one chosen tag is granted.
* The exclusive discount is a bearer code limited to the wine (keep it private).
* Customer matching scans at most 1,000 Commerce7 customers; larger tenants fail closed with a retryable error.
* Native object growth, and bounded lookup and worker latency.
* Operator recovery after a process crash, and unresolved native-write outcomes.
* No automated membership removal.
* Real order coupon representation is unconfirmed.

Live provider acceptance, permissions, storefront purchase behavior, inventory and browser QA remain operator work. Automated review does not claim those external facts have passed.
12. Claimant states on an Experience Shop with an offer configured: signed out shows the card and **Log in**, which returns to the exact shop URL after login; signed in but not unlocked shows the unlock message with no points or claim button; unlocked shows the existing experience. A Shopify-only experience shows no Commerce7 card.
13. Disable an offer that has claims, confirm Edit stays disabled, then **Enable** it and confirm it is claimable again. Disconnect the store (or break its config in a controlled test) and confirm Enable is refused with the offer still inactive. Confirm no Commerce7 resource is created or deleted by either action and issued coupons keep working.
