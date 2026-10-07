# Commerce7 rewards: design and operator guide

Research checked against current official documentation and operator-supplied sandbox reads on 2026-10-07. This revision removes the merchant-created coupon template. SQRATCH is the reward template authority and creates each claim's native coupon directly. It builds on deployed commit `df535687c237c09bbf46c3e675bb8897ff722f2d`. Migration `20261008010000_commerce7_rewards` is already applied in production and remains unchanged. **No migration is needed.** See [refinement verification and QA](commerce7-rewards-refinement.md).

> **For standard Commerce7 discount rewards, no Commerce7 coupon needs to be created manually. Configure the reward in SQRATCH. SQRATCH creates the claim's single-use native Commerce7 coupon when points are redeemed.**

## Shipping boundary

A Brand Admin configures only SQRATCH concepts: title, description, points cost, reward mode, eligibility, fixed or percentage discount, minimum subtotal, All products / Selected products, total and per-user limits, claim window, validity after claim and active state. There is no coupon-template field, no Commerce7 ID to copy and no provider terminology in the form.

Saving or editing an offer **stores and validates SQRATCH configuration only. It performs no Commerce7 call of any kind** (no coupon, customer or tag read or write). Provider resources belong to claims, not offers: the native coupon is created when a user redeems points, from that claim's frozen snapshot.

| Choice | Native coupon SQRATCH creates for each claim | Status |
| --- | --- | --- |
| **Anyone with the code** (`ANYONE_WITH_CODE`) + **All products** | `availableTo=Everyone`, `appliesTo=Store`, `usageLimitType=Per Store`, `usageLimit=1`, no shipping discount | **Fully automatic and verified.** No Customer lookup, email matching, Tag operation or CRM setup. Whoever has the code can use it once. |
| **Claiming customer only** (`CLAIMANT_ONLY`) | Restricted to that claim's own unique Manual Customer tag | Template-free and secure (verified SQRATCH email, exact pinned native customer, one unique claim tag, leaked-code checks). CRM tag assignment is still manual until a membership-write contract is proven. **Draft-only for new offers**: the Coupon `availableTo` value for a customer tag is unverified. |
| **Selected products** | Restricted to the exact catalog product IDs | Template-free. **Draft-only for new offers**: the Coupon `appliesTo` value and ID shape for products are unverified. |

Product scope is independent of eligibility: **Applies to → All products** hides the picker and clears product IDs; **Selected products** shows searchable checkbox cards, removable selections and Clear selection, and requires at least one synchronized product. Edit restores the persisted scope and eligibility.

### One contract: verified values or fail closed

Every Commerce7 Coupon enum SQRATCH may send lives in one typed module, `src/lib/commerce7-coupon-contract.ts`. An entry is either observed or `null`; `null` fails closed and is never filled with a guess.

* **Verified** (documented create example plus operator sandbox reads): `Store`, `Everyone`, `Per Store`, `Dollar Off`, `Percentage Off`, `No Discount`, `Enabled`.
* **Unverified for the Coupon object**: the selected-product `appliesTo` value and the customer-tag `availableTo` value. The Coupons page publishes no enum table. The Promotions page lists `Product`, `Collection`, `Tag` and `Group` for the sibling Promotion object, and live Commerce7 enums have already drifted from the public documentation (a live Product reads `security.availableTo: "Tag"` where the docs say `Group`), so those values are not assumed for Coupons.

An unverified branch can be **saved as a draft but not activated**. The server refuses activation and refuses reservation (before any debit, capacity change or provider call), and the Brand UI shows the option as draft-only. To enable a branch, add a redacted sandbox **Coupon** GET for it to `tests/fixtures/commerce7-rewards/` and set the one value in the contract module. See the fixture README.

### Legacy offers and claims

Offers saved before this revision may carry a merchant `templateCouponId` and a copy of its native body in `commerce7Config`. Compatibility policy:

* Reads never fail: the Brand DTO exposes only `eligibilityMode` and `discountEnabled`, never the template ID or body.
* The stored template is **never fetched, never required, and never shown**. Create/edit requests no longer accept or persist a template field; a stale client that still sends one is ignored.
* Where the contract is verified (bearer + all products) a legacy offer's stored template is ignored entirely and new claims use the contract.
* Where it is not (claimant-only, selected products), the already-validated template copy is the only evidence of the native enum, so it is frozen into the new claim snapshot and used for that claim. Such offers keep issuing exactly as before. Editing a legacy offer keeps the copy only while it still matches the edited eligibility and scope; otherwise it is dropped and the offer becomes a draft-only unverified branch.
* Historical claim snapshots in the old shape still parse, with scope and eligibility derived from their embedded template and discount terms from the immutable claim columns. A snapshot that is malformed or ambiguous fails closed ("Reward configuration needs review") instead of being reinterpreted. A claim that was already mid-issuance recovers its existing coupon by code, so an upgrade cannot create a second one.
* No database change is required: everything lives in existing JSON and columns.

Eligibility is stored in existing `commerce7Config` JSON and frozen on each claim. Missing modes on deployed offers/claims remain `CLAIMANT_ONLY`; unknown explicit stored modes fail closed. Edits that omit the mode preserve the existing mode. New discount creation defaults to `ANYONE_WITH_CODE`. Exclusive access always forces `CLAIMANT_ONLY`. SQRATCH does not automatically assign Customer tags.

Exclusive-product access has a separate mode, catalog selection, optional discount, dates, points cost and a maximum of 25 claims in its stored configuration. It can be saved and edited as a draft. **Activation and claims are blocked by the UI, domain and database until a customer-bound access write contract is proven.** The operator's live Product read (`security.availableTo: "Tag"`, `displayOption`, tag UUID in `availableToObjectIds`) is recorded as redacted read evidence, but the public Products API documents a different enum ("Group") and warns that nested objects need their complete shape, so no Product-security write has been invented. A discount on a public product is not exclusive access.

The operator reports that the original deployment and additive migration succeeded. This work performs no database/provider mutations, app configuration changes or deployment. Service tests execute the actual saga with in-memory persistence and a stateful fake Commerce7 tenant.

## Provider research and evidence

The [AI documentation index](https://developer.commerce7.com/llms.txt) was the entry point. The [API overview](https://developer.commerce7.com/docs/commerce7-apis) documents server-side Basic authentication, the tenant header, pagination and rate limits. The implementation uses a ten-second request timeout, a 25-second client budget, bounded pagination and sanitized errors.

| Official source | Supported fact and implementation decision |
| --- | --- |
| [Coupons API](https://developer.commerce7.com/docs/coupons) | Documents create, retrieve, list/search, update and delete. Dollar Off uses integer cents; Percentage Off uses percentage units. Fields include dates, minimumCartAmount, scope and customer eligibility. DELETE returns 204. The page has no enum table; verified values come from its create example and the operator's real sandbox GET: `appliesTo: "Store"`, `availableTo: "Everyone"`, an empty ID list read back as `""` (not `null`/`[]`), `null` for an absent product/shipping discount, and minute-aligned dates. SQRATCH creates the coupon directly from the frozen claim snapshot, omits empty optional fields as the create example does, and compares the readback with those representation differences normalized. Implemented writes are creation and deletion, followed by exact readback/absence verification. No guessed disable status is sent. |
| [Discount setup](https://documentation.commerce7.com/discounts-promotions-coupons-and-promotion-sets) | Customer-tag restrictions, product targeting and per-store usage exist. Codes are case insensitive. A use limit counts orders, not bottles. SQRATCH sends only enum values it has observed for the Coupon object and never infers a tag or product-scope value from Admin labels or from a different object. No stacking, exclusion, per-item-dollar or shipping controls are offered. |
| [Customers API](https://developer.commerce7.com/docs/customers) | Customer responses contain emails, tags and account-related data. Name search is not proof of exact email uniqueness. Initial binding exhausts bounded cursor pages and compares normalized emails exactly. Retries read the pinned native customer ID. No customer account or login credentials are created. |
| [Tags API](https://developer.commerce7.com/docs/tags) | Manual Customer tag definitions can be created with title/type and retrieved/listed. POST /tag/customer is implemented. The separate customer-membership mutation is unproven and deliberately absent. |
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
| POST /coupon | Create the claim's single-use coupon from its frozen snapshot, once per claim |
| DELETE /coupon/{id} | Merchant-requested revocation; no automatic points refund |
| GET /tag/customer?page={n}&limit=50 | Recover a tag by its exact opaque title; complete bounded scan required |
| POST /tag/customer | Create `{title: SQRATCH-<opaque hash>, type: Manual}` |
| GET /customer?cursor={cursor} | Initial exact verified-email binding, at most 20 pages / 1,000 customers |
| GET /customer/{id} | Revalidate the pinned customer and current native email/tag membership |
| GET /customer?tagId={id}&cursor={cursor} | Prove the unique claim tag belongs only to that customer |
| GET /order/{id} | Read-only purchase evidence through the existing order client |

Product access comes from the existing synchronized catalog; rewards introduce no Product API writes. Customer PUT, Product PUT and Allocation endpoints are intentionally absent.

## Architecture and database

Existing `BrandRewardOffer`, `BrandRewardOfferProduct`, `CommerceRewardRedemption`, `UserPointAccount` and `PointTransaction` remain canonical. The redemption model retains its existing physical table mapping to `ShopifyRewardRedemption`; it is not a new Shopify-only store.

Offers gain exact connection identity, `RewardMode`, closed provider configuration and a durable reserved-claim counter. The counter survives privileged row/account deletion and is decremented only by safe transactional compensation; historical issued capacity cannot reappear through a cascade. The admin user-deletion route serializes a C7 history check with deletion and directs operators to deactivate accounts that have C7 claims. Claims snapshot connection/tenant, offer terms, a versioned frozen coupon snapshot (eligibility, scope, discount, minimum, title), coupon identity, owner, attempt markers and canonical order linkage. Customer-bound claims additionally pin the verified-email timestamp and native customer/tag IDs; bearer claims leave those fields empty. No duplicate raw email, provider secret or raw Customer response is stored. Snapshot identity intentionally survives connection deletion; reconnecting another tenant cannot redirect a historical claim.

Migration `20261008010000_commerce7_rewards` is additive. It adds columns/enums/indexes to reward tables, requires C7 connection/configuration and bounded limits, prevents exclusive activation, and permits capacity release only for refunded, never-issued claims without a coupon attempt. Existing provider data keeps defaults; the new capacity counter is backfilled only for C7 offers. No financial or points tables are rewritten. Existing unique code/idempotency/ledger keys remain decisive. Indexes support offer/user capacity and provider queues.

Fixed amounts and minimums are safe integer cents, bounded by the existing Prisma Int representation. CAD/USD/EUR/GBP/AUD/NZD/ZAR discounts are allowed; unverified monetary exponents are rejected rather than treated as two-decimal currencies. Percentages are whole values 1–100, persisted as basis points and mapped to provider units. Canonical order money continues using the existing BigInt/minor-unit pipeline. Discount scopes are whole store or exact synchronized catalog products (the latter draft-only until the Coupon scope enum is verified); collections/departments are unavailable. Coupon dates are minute-aligned UTC derived from the claim's stable creation and expiry, so every retry and recovery sends and expects the same window.

### Claim state machine

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

The Commerce7 Order/Update subscription and webhook handler are unchanged. Do not add Order/Create. The prior sandbox registration repair and order #1005/#1002 behavior are not redesigned here.

## Merchant setup and readiness

### App Development Center — operator only

In the SQRATCH app, select its development version (or Add Version to copy an existing published version), then Step 1: APIs & Webhooks → Add API Access. Add missing access below; preserve existing access needed by catalog/orders/refunds.

| Endpoint | Access | Why |
| --- | --- | --- |
| Coupon | Full | Create each claim's coupon, recover it by code, and delete it on revocation |
| Tag | Full | Customer-bound mode: read/create unique Manual Customer tags |
| Customer | Read | Customer-bound mode: resolve email identity; read tag membership |
| Product | Read | Existing synchronized catalog and optional operator verification |
| Order | Read | Existing ingestion plus exact reward purchase observation |

Do not request Customer Full, Product Full or Allocation for this implementation. Preserve the sole Order/Update callback `https://www.sqratch.com/api/commerce7/webhooks/orders`, its authentication, and existing install/uninstall URLs. Save the version. For a published app, submit the updated version for approval; approve the resulting upgrade in the test tenant's app interface before assuming the permissions exist. Normal version upgrades do not require uninstall/reinstall. If a private development installation offers no upgrade path, ask Commerce7 Support for its supported version transition; do not repeat the earlier uninstall workaround automatically.

Readiness shows connection/currency, backend credential presence, access requirements, which mode requires manual eligibility and which coupon branches can go live. Credentials present is not proof of granted permissions. Saving an offer needs no Commerce7 permission because it makes no provider call; permission problems surface at claim time as a controlled setup error with the points returned. This code has not verified live tenant permissions.

### Reward setup and per-claim handoff

1. In Brand Rewards choose a title, eligibility and **Applies to**, then points, discount (fixed amount or percentage), optional minimum subtotal, dates, caps and validity. **Nothing is created in Commerce7 and nothing is copied from it.**
2. For **Anyone with the code** with **All products**, save and activate. Each claim creates and returns one unique single-use coupon automatically.
3. **Claiming customer only** and **Selected products** save as drafts and show "draft only" in the form. They cannot be activated until their Coupon enum is verified (see the contract section).
4. For claimant-only claims (legacy offers, or once verified), the store assigns the claim's opaque Customer tag by hand: find the exact native customer and opaque tag ID/title in Recent claims, verify the same email, assign the tag only to that customer in CRM, then Check provider result. SQRATCH never writes customer membership.
5. Each native coupon is titled `SQRATCH <offer title> <8-hex claim reference>` in Commerce7; the title never contains the code, an email or the claim ID.

One coupon per claim is required in both modes. Only claimant-only rewards create one tag per claim. Discount caps are bounded at 1,000; exclusive drafts at 25. Shared offer tags are not used for claimant-only coupons. Provider administrators remain trusted to preserve restrictions after issuance.

### Safe claim diagnostics

Provisioning failures log one event containing only `event`, `stage`, `code`, `uncertain`, `provider`, connection ID and claim ID. The same bounded `STAGE:CODE` token is stored on the claim and shown to the Brand. Stages: `CUSTOMER_LOOKUP`, `TAG_CREATE`, `MEMBERSHIP_VERIFY`, `COUPON_RECOVERY`, `COUPON_CREATE`, `COUPON_VERIFY`. No raw body, exception, credential, tenant, customer data, email or coupon code is logged or stored.

| Condition | Result | Action |
| --- | --- | --- |
| 401/403 or missing server setup (`SETUP_INCOMPLETE`) | Points returned | Review credentials/connection and Coupon: Full (Tag: Full / Customer: Read for customer-bound mode). |
| Definitive 4xx on create (`WRITE_REJECTED`, stage `COUPON_CREATE`) | Points returned | Commerce7 rejected the request body. Capture the sanitized token and a redacted coupon GET for contract review; do not loosen validation. |
| Network/timeout, 408/409/5xx (`uncertain`) | Manual review, points held | Use Check provider result; recovery reads by code and never reposts. |
| 429 / transient read (`PROVIDER_UNAVAILABLE`) | Retryable | Retry after recovery. |
| Coupon terms differ from the reservation (`COUPON_CONFLICT`) | Manual review | A coupon with this code exists with other terms. Inspect it privately. |
| Branch not yet verified (`COUPON_CONTRACT_UNVERIFIED`) | Refused before debit | Use a verified option or wait for the missing fixture. |

### Exclusive wine contract collection — operator only

Using synthetic data, create a Manual Customer tag, attach it in CRM, create a tag-restricted coupon, and secure a test product to the tag through Admin. Supply redacted GET /coupon/{id}, /customer/{id} JSON for a tag-restricted coupon and customer (the same coupon read also unlocks claimant-only issuance). Retain native IDs/types/security field structure and enum values while removing names/emails/address/phones. The Product read has been supplied (live `security.availableTo: "Tag"`, `displayOption`, tag UUID list). Still needed: confirmation that a PUT accepts that shape (the public docs say Group), the complete nested security fields it requires, customer tag mutation syntax, and web/POS/inbound behavior from Commerce7 Support. For Allocations, obtain an explicit installed-app CRUD/membership and permission contract; a webhook object is insufficient evidence. Until those facts are available, exclusive activation remains disabled and charges no points. A manually created Allocation cannot yet be linked as verified active access through this feature.

## Recovery and revocation

* Customer-bound mode — missing customer or manual assignment: create/use a same-email Commerce7 account or complete CRM assignment, then retry. Users can cancel while no coupon attempt/benefit exists; refund keys prevent duplicate credit.
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

## Deployment state and refinement rollout

The operator confirms migration `20261008010000_commerce7_rewards` is already applied in production. Its SQL and the Prisma schema are unchanged. Eligibility uses existing JSON, and product scope uses existing columns/relations. **Do not run migrations for this refinement.** No db push, reset, migrate dev, migrate deploy, shared database access or provider mutation was performed here.

No new production environment variables are required. Retain the existing server-only COMMERCE7_APP_ID, COMMERCE7_APP_SECRET, database configuration and CRON_SECRET. Never add NEXT_PUBLIC credentials. No Vercel settings were changed. Test-only ALLOW_REAL_DATABASE_TESTS / COMMERCE7_REWARDS_REAL_DB must not be enabled against shared databases.

Future operator rollout: review the refinement → confirm already-approved app permissions → perform the synthetic QA below → deploy the reviewed application when authorized → create inactive offers → small-cap acceptance → activate selected discounts. Keep exclusive drafts inactive. Keep the current externally managed reconciliation schedule; do not add a new cron or webhook subscription.

Rollback: disable new C7 offers first. Preserve and service existing claims, points history and provider resources; code rollback cannot revoke a native coupon. Reverting application code is compatible with the additive columns/defaults, but it stops C7 recovery, so retain an operator plan for pending claims. Leave the migration applied. Dropping columns/enums or reversing ledger events is not a safe automatic rollback; any later schema removal requires a separately reviewed migration after all claims are resolved.

## Sandbox acceptance checklist — operator performs provider writes

1. Verify main/dirty diff, already-applied migration, server configuration and manually approved test permissions. Confirm anonymous and wrong-role Brand requests are denied. Test both connected providers and explicit selection.
2. Create the first sandbox claim for an **Anyone with the code / All products** offer and read the created coupon back in Commerce7 Admin and via GET. Confirm `Per Store`/`usageLimit 1` is accepted and enforced (one redemption total), the `title`, the minute-aligned dates, and that omitting `appliesToObjectIds`, `availableToObjectIds`, `shippingDiscount` and (when none) `minimumCartAmount` was accepted. Fixed-dollar behavior across multiple items and the 36-character code length must also be checked in the real sandbox. A definitive rejection returns the points and records a `COUPON_CREATE:WRITE_REJECTED` token to capture.
3. Capture the two missing fixtures in Admin and send their redacted GET JSON: a Coupon restricted to **specific products**, and a Coupon restricted to a **Customer tag**. Each proves the string and ID-list shape that enables its branch. Until then, verify those options save as drafts, cannot be activated, and show as draft-only. Create inactive $10 and 15% offers, minimum subtotal, whole-store scope, windows/caps/validity. Update an unclaimed offer, activate, disable, and verify stale terms cannot be edited once a claim exists. Saving any offer must create nothing in Commerce7.
4. For claimant-only rewards (only once the tag enum is verified, or on a legacy offer), Alice uses a verified SQRATCH email and sufficient points. Claim once, double click, and retry a lost response. Check exactly one claim/debit/tag. Missing native customer stays pending; cancel twice returns points once. Wrong/duplicate CRM email fails closed. Changing the verified SQRATCH email blocks provisioning.
5. For claimant-only rewards, assign Alice's unique tag only to the displayed native customer. Check again: one matching coupon becomes ready. Login with the same email, apply the code, verify minimum/scope/amount/expiry/one-use behavior. Bob with a different account must not use Alice's leaked code. Remove/alter membership and confirm native enforcement; this is essential before production activation.
6. For bearer rewards, claim with no matching Commerce7 Customer; verify no new Customer tag and one usable Everyone coupon. Redeem with another account and confirm a second use is rejected. Exercise 25 allowed reservations and concurrent claim 26; verify loser has no debit/resource. Issued/used/expired/revoked claims retain capacity. Provider inventory remains separately authoritative; a claim does not reserve a bottle.
7. Simulate read failure and lost tag/coupon response in a controlled test environment. Retry recovers existing exact resources; unknown absence does not create a duplicate or blindly refund. Check durable owner recovery only after stopping its invocation.
8. Save exclusive access-only and optional-15% drafts for a synchronized product. Confirm activation and claims are rejected and no points/provider benefit is issued. Do not describe this draft as usable access. Separately prove any future native access contract before enabling it.
9. Make an actual synthetic paid Commerce7 purchase, capture a redacted populated order GET with coupon identity, and run the existing reconciliation worker. Exact identity/version should link once. If the native representation differs, leave it unlinked and supply the fixture for the closed parser to be extended. Repeat Update, fulfillment, cancellation, partial/full refund and multiple/unknown coupon cases; points and financial arithmetic must not change due to reward observation.
10. Revoke an unused issued coupon, verify native absence and preserved capacity/history, then test expiry and disconnected/original-tenant recovery. Confirm the existing Order/Update subscription still processes fulfillment and order #1002 partial-refund behavior; do not register Create.
11. Run the unchanged Shopify offer, claim, discount, points, lifecycle, storefront and usage flows. Review responsive layout, labels, keyboard access and code copy on a real browser. Automated component execution tests are not a substitute for this operator QA.

## Automated verification and review boundaries

Tests execute domain mapping, real claimant routes, actual TSX with controlled hooks, and an opted-in real PostgreSQL saga. Service tests also run the actual saga against a stateful fake Commerce7 tenant, including template-free issuance, ambiguous and definitive POST outcomes, claimant-only security with an injected verified contract, legacy snapshot compatibility and mid-issuance recovery. The DB harness requires the existing safety opt-in, a loopback database ending `_test`, and COMMERCE7_REWARDS_REAL_DB=true. It has no live provider traffic and cleans only its own fixtures. It covers cap 25, competing points spends, duplicate keys, cancellation/refund, rollback, durable owners, lost responses, exact customer/connection guards, SQL constraints, capacity surviving a deliberately privileged fixture deletion, and read-only order linkage. Executed admin-route tests protect account-deletion history retention.

Existing Shopify, Commerce7 ingestion/refund/fulfillment and financial invariants remain in the full suite. The generic reconciliation worker is now explicitly Shopify-only so it cannot compensate a pending C7 saga. Shared serializers preserve old contracts; provider-neutral capabilities describe optional customer binding in this durable reward workflow; generic createDiscount C7 methods remain unsupported.

Known limitations requiring acceptance are two unverified Coupon branches (customer-tag restriction and selected products) that stay draft-only, manual CRM assignment for claimant-only rewards, native object growth, bounded lookup/worker latency, operator recovery after a process crash, unresolved native-write outcomes, and unconfirmed real order coupon representation. Exclusive access is intentionally unavailable. Live provider acceptance, permissions, inventory and browser QA remain operator work. Automated review does not claim those external facts have passed.
