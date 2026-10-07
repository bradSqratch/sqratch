# Commerce7 rewards: design and operator guide

Research checked against current official documentation on 2026-10-07. Implementation starts from `6e7ff3fc563372659a1fb3404d393c9c72098bff` on `main`.

## Shipping boundary

Discount rewards have a complete SQRATCH claim, points, manual eligibility, native coupon, cancellation, recovery and purchase-link flow. **Each claim requires a merchant to assign its unique Customer tag in Commerce7 CRM.** SQRATCH creates the tag definition, verifies membership, then creates the coupon. It does not claim that it can automatically assign Customer tags.

Exclusive-product access has a separate mode, catalog selection, optional discount, dates, points cost and a maximum of 25 claims in its stored configuration. It can be saved and edited as a draft. **Activation and claims are blocked by the UI, domain and database until a customer-bound access write contract is proven.** No Allocation or Product-security write has been invented. A discount on a public product is not exclusive access.

No shared database migration, provider mutation, Commerce7 app change, environment change or deployment was performed during implementation. A disposable local PostgreSQL database was used for opted-in tests; its provider client is synthetic.

## Provider research and evidence

The [AI documentation index](https://developer.commerce7.com/llms.txt) was the entry point. The [API overview](https://developer.commerce7.com/docs/commerce7-apis) documents server-side Basic authentication, the tenant header, pagination and rate limits. The implementation uses a ten-second request timeout, a 25-second client budget, bounded pagination and sanitized errors.

| Official source | Supported fact and implementation decision |
| --- | --- |
| [Coupons API](https://developer.commerce7.com/docs/coupons) | Documents create, retrieve, list/search, update and delete. Dollar Off uses integer cents; Percentage Off uses percentage units. Fields include dates, minimumCartAmount, scope and customer eligibility. DELETE returns 204. Implemented writes are creation and deletion, followed by exact readback/absence verification. No guessed disable status is sent. |
| [Discount setup](https://documentation.commerce7.com/discounts-promotions-coupons-and-promotion-sets) | Customer-tag restrictions, product targeting and per-store usage exist. Codes are case insensitive. A use limit counts orders, not bottles. A manually configured native template supplies eligibility and scope values; SQRATCH does not hardcode an inferred tag enum. No stacking, exclusion, per-item-dollar or shipping controls are offered. |
| [Customers API](https://developer.commerce7.com/docs/customers) | Customer responses contain emails, tags and account-related data. Name search is not proof of exact email uniqueness. Initial binding exhausts bounded cursor pages and compares normalized emails exactly. Retries read the pinned native customer ID. No customer account or login credentials are created. |
| [Tags API](https://developer.commerce7.com/docs/tags) | Manual Customer tag definitions can be created with title/type and retrieved/listed. POST /tag/customer is implemented. The separate customer-membership mutation is unproven and deliberately absent. |
| [Customer tag help](https://documentation.commerce7.com/how-do-i-create-customer-tags) | A merchant can assign manual tags in CRM individually or in bulk. This is the supported eligibility handoff. Never assign a claim tag to a second customer. |
| [Webhook documentation](https://developer.commerce7.com/docs/webhooks) | Bulk Customer Tag callbacks document GET /customer?tagId=…&cursor=start. SQRATCH uses that read filter to prove that the claim tag has only the pinned customer as a member. |
| [Products API](https://developer.commerce7.com/docs/products) | Product reads and updates exist; security examples do not establish the full Tag/Group write shape. Nested updates require complete objects. No security PUT is implemented. |
| [Product security help](https://documentation.commerce7.com/how-to-secure-a-product) | Eligible logged-in customers can purchase secured products. Tag, Club and Allocation are business features. Product security does not apply to inbound/POS carts unless secured to an Allocation. Developer Group terminology must not be substituted for Admin Tag without a native fixture. |
| [Allocations help](https://documentation.commerce7.com/allocations) | Limited products, dates, quantities and customer eligibility are business features. This does not establish installed-app CRUD or member assignment endpoints. Exclusive activation remains closed. |
| [Orders API](https://developer.commerce7.com/docs/orders) | Order objects expose coupons, but the public example is empty. The new observer accepts only exact native coupon id + code, customerId, order id and matching updatedAt. A real populated order fixture is still required for sandbox acceptance. Other representations stay unlinked. |
| [Promotions](https://developer.commerce7.com/docs/promotions), [Collections](https://developer.commerce7.com/docs/collections), [App Data](https://developer.commerce7.com/docs/custom-app-data) | Investigated; none is needed for this implementation. Promotions are not a substitute for customer identity; App Data is not purchase eligibility. No new permissions or writes use these APIs. |
| [App API permissions](https://developer.commerce7.com/docs/app-apis-webhooks), [release updates](https://developer.commerce7.com/docs/releasing-a-new-version) | Access is configured per app version. Existing installations approve an upgrade; they do not receive new permissions automatically. Allocation is absent from the documented API-access selector. |

### Exact API surface

All paths use `https://api.commerce7.com/v1`, server-only app credentials and the exact original `CommerceConnection.externalAccountId` as tenant.

| Method/path | Purpose |
| --- | --- |
| GET /coupon/{id} | Read a merchant-created template; confirm deletion by 404 |
| GET /coupon?q={opaque-code} | Exact, unique coupon recovery; incomplete result sets fail closed |
| POST /coupon | Create the reserved claim's single-use, tag-restricted coupon |
| DELETE /coupon/{id} | Merchant-requested revocation; no automatic points refund |
| GET /tag/customer/{id} | Prove the template refers to a Manual Customer tag |
| GET /tag/customer?page={n}&limit=50 | Recover a tag by its exact opaque title; complete bounded scan required |
| POST /tag/customer | Create `{title: SQRATCH-<opaque hash>, type: Manual}` |
| GET /customer?cursor={cursor} | Initial exact verified-email binding, at most 20 pages / 1,000 customers |
| GET /customer/{id} | Revalidate the pinned customer and current native email/tag membership |
| GET /customer?tagId={id}&cursor={cursor} | Prove the unique claim tag belongs only to that customer |
| GET /order/{id} | Read-only purchase evidence through the existing order client |

Product access comes from the existing synchronized catalog; rewards introduce no Product API writes. Customer PUT, Product PUT and Allocation endpoints are intentionally absent.

## Architecture and database

Existing `BrandRewardOffer`, `BrandRewardOfferProduct`, `CommerceRewardRedemption`, `UserPointAccount` and `PointTransaction` remain canonical. The redemption model retains its existing physical table mapping to `ShopifyRewardRedemption`; it is not a new Shopify-only store.

Offers gain exact connection identity, `RewardMode`, closed provider configuration and a durable reserved-claim counter. The counter survives privileged row/account deletion and is decremented only by safe transactional compensation; historical issued capacity cannot reappear through a cascade. The admin user-deletion route serializes a C7 history check with deletion and directs operators to deactivate accounts that have C7 claims. Claims snapshot connection/tenant, offer terms, native template, verified-email timestamp, customer/tag/coupon IDs, owner, attempt markers and canonical order linkage. No duplicate raw email, provider secret or raw Customer response is stored. Snapshot identity intentionally survives connection deletion; reconnecting another tenant cannot redirect a historical claim.

Migration `20261008010000_commerce7_rewards` is additive. It adds columns/enums/indexes to reward tables, requires C7 connection/configuration and bounded limits, prevents exclusive activation, and permits capacity release only for refunded, never-issued claims without a coupon attempt. Existing provider data keeps defaults; the new capacity counter is backfilled only for C7 offers. No financial or points tables are rewritten. Existing unique code/idempotency/ledger keys remain decisive. Indexes support offer/user capacity and provider queues.

Fixed amounts and minimums are safe integer cents, bounded by the existing Prisma Int representation. CAD/USD/EUR/GBP/AUD/NZD/ZAR discounts are allowed; unverified monetary exponents are rejected rather than treated as two-decimal currencies. Percentages are whole values 1–100, persisted as basis points and mapped to provider units. Canonical order money continues using the existing BigInt/minor-unit pipeline. Discount scopes are whole store or exact catalog products matching the native template; collections/departments are unavailable.

### Claim state machine

1. Serializable transaction reads the authenticated active user's verified email stamp, original connected tenant/currency, persisted offer window and caps. Product-scoped offers recheck synchronized availability. It conditionally increments the durable offer capacity counter, checks per-user unreleased claims, creates one claim and spends through `applyPointLedgerEvent` atomically. The database also constrains the counter to the offer ceiling. Unique server idempotency keys bind user + offer + browser request key. An SSI conflict retries the whole short transaction; a losing 26th claim has no debit or provider call.
2. `POINTS_DEBITED / AWAITING_CUSTOMER`: points and capacity are reserved. A matching provider customer must exist. No CRM account is fabricated.
3. A compare-and-swap grants one durable `PROVISIONING` owner. Provider requests occur outside database transactions. A claim's verified-email stamp must remain unchanged; initial lookup is unique and exhaustive within limits. Subsequent reads use the pinned ID.
4. Create/recover one opaque Manual Customer tag. Until CRM assignment is verified, the claim is `AWAITING_ELIGIBILITY` with `MANUAL_PROVIDER_SETUP_REQUIRED`. Merchant assigns it only to the exact displayed native customer ID.
5. Re-read identity/membership and validate the tag's member list. Persist the coupon-attempt marker before POST. Generate a 128-bit random `SQRA` + 32 hexadecimal code, with stable claim start/expiry and native template scope/eligibility. Match the entire closed response against reserved terms.
6. `ISSUED / READY` exposes the code only to its owner. `entitlementEverGranted=true` permanently consumes issuance capacity. `USED` requires exact paid purchase evidence, not merely creation of an order or coupon.
7. Safe pre-coupon cancellation atomically writes one ledger refund and releases capacity. Explicit authorization/setup rejection before possible issuance also compensates. A transient read failure is retryable and cancellable. A lost write response becomes `MANUAL_REVIEW`; attempted writes are never blindly repeated and possible benefits are never blindly refunded.
8. Native expiry hides the code and the worker moves issued claims to `EXPIRED`. Deactivation stops new reservations while preserving already reserved terms. Native deletion produces `CANCELLED / REVOKED`; it neither refunds points nor recycles an issued slot. Historical purchases may still be linked without reopening the revoked claim.

The browser guards repeat clicks and retains its request key after a network failure, including a lost initial response. Explicit terminal responses clear that key for a later intentional claim. API requests cannot choose customer, tenant, Brand, points price, discount or code. Campaign/experience eligibility uses the existing server resolver. Brand management uses the existing role + active-Brand authorization policy.

### Reconciliation

The existing authenticated `POST /api/internal/reconcile-redemptions` runs independent Shopify, C7 provisioning and C7 purchase observers. Existing manually managed Cron scheduling and secret are retained. C7 provisioning processes one due claim per invocation, at most 20 automatic attempts; user/admin checks remain available. Expiry batches are bounded to 20.

Purchase observation scans at most one due claim and five canonical orders per invocation, within a 25-second provider-read budget. Its cursor/check timestamp live on the claim. Failed/disconnected claims rotate fairly without advancing their cursor. Exhausted scans restart so later payment and backfills can be observed. Latency therefore grows with claim/order volume; this is a small bounded initial rollout, not an immediate webhook acknowledgement guarantee.

A match requires C7 provider, exact Brand + original connection, native order ID, pinned customer ID, coupon ID + case-insensitive code, matching provider update version, canonical PAID status, positive gross total and no cancellation. Expired/revoked claims require a purchase within validity. The worker re-reads canonical financial/version evidence in a serializable transaction and records the claim link once. It writes no order, order event, attribution, financial, inventory or points data. Later refunds/fulfillment preserve the historical link. If first observed after partial/full refund, missing identity, or an unknown coupon representation, the claim remains unlinked for review.

The Commerce7 Order/Update subscription and webhook handler are unchanged. Do not add Order/Create. The prior sandbox registration repair and order #1005/#1002 behavior are not redesigned here.

## Merchant setup and readiness

### App Development Center — operator only

In the SQRATCH app, select its development version (or Add Version to copy an existing published version), then Step 1: APIs & Webhooks → Add API Access. Add missing access below; preserve existing access needed by catalog/orders/refunds.

| Endpoint | Access | Why |
| --- | --- | --- |
| Coupon | Full | Read templates/recovery; create and delete reward coupons |
| Tag | Full | Read and create claim-specific Manual Customer tag definitions |
| Customer | Read | Resolve verified-email identity; read tag membership |
| Product | Read | Existing synchronized catalog and optional operator verification |
| Order | Read | Existing ingestion plus exact reward purchase observation |

Do not request Customer Full, Product Full or Allocation for this implementation. Preserve the sole Order/Update callback `https://www.sqratch.com/api/commerce7/webhooks/orders`, its authentication, and existing install/uninstall URLs. Save the version. For a published app, submit the updated version for approval; approve the resulting upgrade in the test tenant's app interface before assuming the permissions exist. Normal version upgrades do not require uninstall/reinstall. If a private development installation offers no upgrade path, ask Commerce7 Support for its supported version transition; do not repeat the earlier uninstall workaround automatically.

Readiness shows connection/currency, backend credential presence, required access and the manual eligibility requirement. Credentials present is not proof of granted permissions. Saving a discount validates native template/tag access; authorization failures use a controlled setup error. This code has not verified live tenant permissions.

### Native template and per-claim handoff

1. In Settings → Tags → Customer create a dedicated empty Manual Customer tag for the template. Do not share it with existing groups.
2. In Commerce7 Admin create a test coupon restricted to that tag, with a total per-store usage limit of one, no shipping discount, and whole-store or exact selected product scope. Keep it future-dated or otherwise unavailable to real shoppers.
3. Privately GET that coupon and tag. Confirm the returned single tag ID and native eligibility/scope values. The code requires native `usageLimitType=Per Store`, `usageLimit=1`; any different representation fails closed for adapter review. No inferred Specific Tags enum is sent.
4. In Brand Rewards choose Commerce7, enter the template ID, matching synchronized products, discount, points, window, caps and validity. Save inactive, review, then activate for synthetic QA. Templates provide native enum/scope evidence; their amount/dates/code are replaced by persisted offer/claim terms.
5. On a pending claim, use Recent claims to locate the exact CRM customer ID and opaque tag title/ID. Confirm the claimant's same verified email in Commerce7 CRM, assign that tag to that customer only, then Check provider result. Never apply a claim tag in bulk to other customers. The template tag itself grants no claim.

One tag and coupon per claim is deliberate isolation. Caps are bounded (discount ≤1,000, exclusive draft ≤25); this creates provider objects and requires merchant work. Shared offer tags would let another tagged claimant use a leaked code and are rejected as the architecture. Provider administrators remain trusted to preserve native restrictions after issuance.

### Exclusive wine contract collection — operator only

Using synthetic data, create a Manual Customer tag, attach it in CRM, create a tag-restricted coupon, and secure a test product to the tag through Admin. Supply redacted GET /coupon/{id}, /customer/{id}, /product/{id} JSON. Retain native IDs/types/security field structure and enum values while removing names/emails/address/phones. Confirm Group versus Tag terminology, complete nested security fields, customer tag mutation syntax, and web/POS/inbound behavior with Commerce7 Support. For Allocations, obtain an explicit installed-app CRUD/membership and permission contract; a webhook object is insufficient evidence. Until those facts are available, exclusive activation remains disabled and charges no points. A manually created Allocation cannot yet be linked as verified active access through this feature.

## Recovery and revocation

* Missing customer or manual assignment: create/use a same-email Commerce7 account or complete CRM assignment, then retry. Users can cancel while no coupon attempt/benefit exists; refund keys prevent duplicate credit.
* Ambiguous tag/coupon result: let the request finish, inspect the native resource privately and use Check provider result. Recovery compares exact title/code and full terms. Absence after an attempted POST stays manual; it does not authorize another POST or a refund that could coexist with a live coupon.
* Explicit permission denial: fix the app/version access. An unissued compensated claim is terminal; the user makes a fresh claim with a new request key.
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

## Migration, environment and rollout — future operator actions

### Preflight

Back up the target database and verify it is the intended staging/project connection through secure tooling; do not print connection URLs. Review all pending migrations with `npx prisma migrate status`. The previous latest migration is `20261007010000_commerce7_reconciliation_claim`. Inspect this new migration and its constraints against any existing C7 reward rows; unexpected C7 rows missing connection/configuration must be reviewed before migration. Ensure enum names are unused, table sizes/lock duration are acceptable, and enough time is scheduled for index creation. Do not use db push/reset on shared databases.

With DATABASE_URL and DIRECT_URL already securely configured for the explicitly selected target, run later:

```sh
npx prisma validate
npx prisma migrate status
npx prisma migrate deploy
npx prisma generate
```

`migrate deploy` applies **all** pending migrations, so review the complete status first. The source migration was applied only to a disposable local database during tests. Do not deploy this code against an unmigrated schema.

No new production environment variables are required. Retain the existing server-only COMMERCE7_APP_ID, COMMERCE7_APP_SECRET, database configuration and CRON_SECRET. Never add NEXT_PUBLIC credentials. No Vercel settings were changed. Test-only ALLOW_REAL_DATABASE_TESTS / COMMERCE7_REWARDS_REAL_DB must not be enabled against shared databases.

Rollout order: review code/migration → apply to explicitly selected staging → update test-app permissions/version manually → collect redacted native fixtures and perform the QA below → deploy migrated application → create inactive production offers → synthetic/small-cap acceptance → activate selected discount offers. Keep exclusive drafts inactive. Keep the current externally managed reconciliation schedule; do not add a new cron or webhook subscription.

Rollback: disable new C7 offers first. Preserve and service existing claims, points history and provider resources; code rollback cannot revoke a native coupon. Reverting application code is compatible with the additive columns/defaults, but it stops C7 recovery, so retain an operator plan for pending claims. Leave the migration applied. Dropping columns/enums or reversing ledger events is not a safe automatic rollback; any later schema removal requires a separately reviewed migration after all claims are resolved.

## Sandbox acceptance checklist — operator performs provider writes

1. Verify main/dirty diff, migration review, server configuration and manually approved test permissions. Confirm anonymous and wrong-role Brand requests are denied. Test both connected providers and explicit selection.
2. Collect the redacted native tag/customer/coupon/product fixtures above. Validate public, tag, club and product-scope templates; public/shared/wrong-product templates must fail. Verify one-use semantics, fixed-dollar behavior across multiple items, and code length in the real sandbox.
3. Create inactive $10 and 15% offers, minimum subtotal, specific products and whole-store scopes, windows/caps/validity. Update an unclaimed offer, activate, disable, and verify stale terms cannot be edited once a claim exists.
4. Alice uses a verified SQRATCH email and sufficient points. Claim once, double click, and retry a lost response. Check exactly one claim/debit/tag. Missing native customer stays pending; cancel twice returns points once. Wrong/duplicate CRM email fails closed. Changing the verified SQRATCH email blocks provisioning.
5. Assign Alice's unique tag only to the displayed native customer. Check again: one matching coupon becomes ready. Login with the same email, apply the code, verify minimum/scope/amount/expiry/one-use behavior. Bob with a different account must not use Alice's leaked code. Remove/alter membership and confirm native enforcement; this is essential before production activation.
6. Exercise 25 allowed reservations and concurrent claim 26; verify loser has no debit/resource. Issued/used/expired/revoked claims retain capacity. Provider inventory remains separately authoritative; a claim does not reserve a bottle.
7. Simulate read failure and lost tag/coupon response in a controlled test environment. Retry recovers existing exact resources; unknown absence does not create a duplicate or blindly refund. Check durable owner recovery only after stopping its invocation.
8. Save exclusive access-only and optional-15% drafts for a synchronized product. Confirm activation and claims are rejected and no points/provider benefit is issued. Do not describe this draft as usable access. Separately prove any future native access contract before enabling it.
9. Make an actual synthetic paid Commerce7 purchase, capture a redacted populated order GET with coupon identity, and run the existing reconciliation worker. Exact identity/version should link once. If the native representation differs, leave it unlinked and supply the fixture for the closed parser to be extended. Repeat Update, fulfillment, cancellation, partial/full refund and multiple/unknown coupon cases; points and financial arithmetic must not change due to reward observation.
10. Revoke an unused issued coupon, verify native absence and preserved capacity/history, then test expiry and disconnected/original-tenant recovery. Confirm the existing Order/Update subscription still processes fulfillment and order #1002 partial-refund behavior; do not register Create.
11. Run the unchanged Shopify offer, claim, discount, points, lifecycle, storefront and usage flows. Review responsive layout, labels, keyboard access and code copy on a real browser. Automated component execution tests are not a substitute for this operator QA.

## Automated verification and review boundaries

Tests execute domain mapping, real claimant routes, actual TSX with controlled hooks, and an opted-in real PostgreSQL saga. The DB harness requires the existing safety opt-in, a loopback database ending `_test`, and COMMERCE7_REWARDS_REAL_DB=true. It has no live provider traffic and cleans only its own fixtures. It covers cap 25, competing points spends, duplicate keys, cancellation/refund, rollback, durable owners, lost responses, exact customer/connection guards, SQL constraints, capacity surviving a deliberately privileged fixture deletion, and read-only order linkage. Executed admin-route tests protect account-deletion history retention.

Existing Shopify, Commerce7 ingestion/refund/fulfillment and financial invariants remain in the full suite. The generic reconciliation worker is now explicitly Shopify-only so it cannot compensate a pending C7 saga. Shared serializers preserve old contracts; provider-neutral capabilities expose a separate customer-bound workflow while generic bearer-discount C7 methods remain unsupported.

Known limitations requiring acceptance are manual CRM assignment, native object growth, bounded lookup/worker latency, operator recovery after a process crash, unresolved native-write outcomes, and unconfirmed real order coupon representation. Exclusive access is intentionally unavailable. Live provider acceptance, permissions, inventory and browser QA remain operator work. Automated review does not claim those external facts have passed.
