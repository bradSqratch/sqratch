# Commerce7 rewards: template-free refinement after df53568

Base: deployed `df535687c237c09bbf46c3e675bb8897ff722f2d`, `main`. The operator confirms `20261008010000_commerce7_rewards` is already applied in production. Its migration and the Prisma schema are unchanged. **No migration is needed.** This work performs no Commerce7 or shared-database mutation, commit, push or deployment.

> **For standard Commerce7 discount rewards, no Commerce7 coupon needs to be created manually. Configure the reward in SQRATCH. SQRATCH creates the claim's single-use native Commerce7 coupon when points are redeemed.**

## Why the design changed

The earlier refinement made a Brand Admin create a native Commerce7 coupon first, copy its internal ID into SQRATCH, and let SQRATCH read it at save time to learn the native enum values. That put Commerce7 implementation detail in the Brand's hands, made every offer save depend on a provider read, and produced the opaque 502s that motivated the earlier diagnostics. Commerce7 documents direct `POST /coupon`, and the operator supplied real sandbox reads, so the template was removed. **SQRATCH is the reward template authority**; Commerce7 holds only the per-claim result.

## Resulting architecture

| Stage | Before | Now |
| --- | --- | --- |
| Offer save/edit | `GET /coupon/{templateId}` (+ `GET /tag/customer/{id}` for claimant-only), validated and stored a native template copy | Validates SQRATCH configuration and the synchronized catalog only. **Zero provider calls**; no provider client is constructed. |
| Claim reservation | Snapshot = the stored template copy | Snapshot built from the offer's own rows: eligibility, scope, product IDs, discount, minimum, title (`snapshotVersion: 2`). An offer whose branch the contract cannot express is refused **before any debit**. |
| Issuance | Payload derived from the template's native values | `POST /coupon` built from the frozen snapshot through one typed contract module |
| Customer-bound only | Unchanged | Unchanged: verified email, exact pinned native customer, one unique Manual Customer tag per claim, membership verification, manual CRM assignment |

The durable sequence is preserved exactly: reservation + points → durable owner → attempt marker → recovery lookup by stable code → single POST → exact verification → `READY`.

### The single contract (`src/lib/commerce7-coupon-contract.ts`)

Every Coupon enum SQRATCH may send lives here, pure and client-safe. A value is either observed or `null`, and `null` fails closed.

| Value | Evidence | Status |
| --- | --- | --- |
| `appliesTo: "Store"`, `availableTo: "Everyone"` | Operator's real sandbox Coupon GET; documented create example | Verified |
| `usageLimitType: "Per Store"`, `usageLimit: 1` | Specified for this work; first sandbox claim confirms | Verified by spec, QA item 2 |
| `Dollar Off` / `Percentage Off`, `No Discount`, `Enabled` | Documented create example | Verified |
| Selected-product `appliesTo`, product-ID list shape | Coupons page has no enum table. Promotions page lists `Product` for a different object | **Unverified, fail closed** |
| Customer-tag `availableTo` | No Coupon evidence. Live Product security reads `Tag` where the docs say `Group` | **Unverified, fail closed** |

I did not infer Coupon values from a sibling object or from the Product-security read: the live tenant has already shown that public enums drift, and a wrongly accepted enum could silently mean something else. Failing closed is scoped to **only** those two branches. **Anyone with the code + All products is fully functional on its own.**

An unverified branch (claimant-only, selected products) can be saved as a draft but not activated, and cannot be reserved. The Brand UI labels it "draft only" and disables Active. To enable one: add the redacted Coupon GET to `tests/fixtures/commerce7-rewards/`, set the one contract value, and remove nothing else. The mapping function and every test already exercise the plumbing with an injected hypothetical contract.

### Payload (anyone with the code, all products, $10, $50 minimum)

```json
{ "code": "SQRA…32 hex", "title": "SQRATCH <offer title> <8-hex ref>", "status": "Enabled",
  "usageLimitType": "Per Store", "usageLimit": 1, "appliesTo": "Store",
  "productDiscountType": "Dollar Off", "productDiscount": 1000, "shippingDiscountType": "No Discount",
  "minimumCartAmount": 5000, "availableTo": "Everyone",
  "startDate": "2026-10-10T00:00:00.000Z", "endDate": "2026-11-09T00:00:00.000Z" }
```

Optional fields are omitted when empty, as in the documented create example (`appliesToObjectIds`, `availableToObjectIds`, `shippingDiscount`, and `minimumCartAmount` when none). Money is integer minor units with no float math; percentages are whole values mapped from basis points. The title carries a non-reversible claim reference and never the code, an email or the claim ID.

### Legacy compatibility policy

* Reads never break: the Brand DTO exposes only `eligibilityMode` and `discountEnabled`.
* The stored template ID is **never fetched, required or shown**, and request DTOs no longer carry it (a stale client's value is ignored).
* Verified branch (bearer + all products): the stored template is ignored; new claims use the contract. Unverified branch: the already-validated template copy is the only evidence of the native enum, so it is frozen into the claim and used, and such offers keep issuing exactly as before. Edits keep it only while it still matches; otherwise the offer becomes a draft-only unverified branch.
* Historical claim snapshots parse in their old shape with discount terms from the immutable claim columns. Anything malformed fails closed with a neutral message. A claim already mid-issuance recovers its existing coupon by code, so upgrading cannot create a second one. No claim is mutated.

## Defects found and repaired in the existing refinement

| Sev | Finding | Repair |
| --- | --- | --- |
| P1 | The coupon parser rejected the **real** sandbox Coupon GET: it requires string discount types and array ID lists, but a tenant reads empty lists as `""` and absent discounts as `null`. Every readback of a created coupon would have become `INVALID_PROVIDER_RESPONSE`/manual review. | Parser normalizes the observed representations; fixture added; strict match still applies to every benefit-defining field. |
| P1 | A definitive `POST /coupon` rejection (4xx) or a 429 left the attempt marker set, so the claim could never be retried or refunded and ended in permanent manual review. Template-free payloads make deterministic rejections more likely. | Definitive refusals clear the marker and refund once; 429 clears it and stays retryable; 408/409/5xx/timeouts stay uncertain. Same for tag creation. |
| P2 | Exact-millisecond date equality against minute-aligned provider dates would turn a successful create into a spurious `COUPON_CONFLICT`. | Window is minute-aligned UTC and compared at minute granularity; stable across retries and recovery. |
| P2 | `shippingDiscountType` read back as `null` (real GET) was treated as a mismatch against "No Discount"; the cosmetic title was part of the strict match. | Normalized; title excluded from the benefit match. |
| P2 | Brand UI serialized a malformed money field (`"1e2"`) as `null`, silently **dropping a minimum subtotal**. | Rejected in the form before any request. |
| P2 | Legacy validation errors said "Template must be…" and could reach claimants. | Neutral "Reward configuration needs review." |
| P2 | Brand DTO could return `commerce7Config: null` for an unreadable row, crashing the edit form. | Always an object. |
| P2 | Coupon enum literals were duplicated in the validator and matcher. | One contract module; tests guard against guessed `Product`/`Tag`/`Group` values. |

**Pre-existing, not fixed here (needs a migration, which this task excludes):** `brand_reward_offer_discount_check` from `20260615075700` requires a discount amount or percentage on every offer, and the already-applied rewards migration never relaxed it, so saving an **access-only exclusive draft** fails on a migration-built database. HEAD's real-DB test only passes on a `db push` schema. Exclusive access is draft-only and unreleased, so impact is limited to that draft. A follow-up task was filed.

## Exact changed files

| File | Change |
| --- | --- |
| `src/lib/commerce7-coupon-contract.ts` | New. The single typed provider contract and scope resolver. |
| `src/lib/commerce7-reward-eligibility.ts` | Shared mode type and defensive stored-mode reader (earlier refinement; new file). |
| `src/lib/commerce7-reward-domain.ts` | Template-free offer parsing; versioned claim snapshot (build/parse/serialize); legacy snapshot compatibility; scope and term resolution; Brand DTO/readiness/diagnostic serializers. |
| `src/lib/commerce7-rewards.ts` | Save makes no provider call; contract gate at activation and reservation; staged provisioning with definitive/ambiguous classification and sanitized diagnostics. |
| `src/lib/commerce/providers/commerce7-rewards-client.ts` | Direct coupon builder, normalized exact match, real-GET parser, POST classification; template-era `tag(id)` removed. |
| `src/lib/commerce/providers/commerce7-products.ts` | Comment only: records the observed live `Tag` value. No behavior change. |
| `src/lib/commerce/providers/commerce7-reward-orders.ts` | Customer check conditional on snapshotted eligibility (earlier refinement). |
| `src/lib/commerce/types.ts` | Capability literals (`NATIVE_COUPON`, optional customer binding). |
| `src/app/api/brand/rewards/commerce7/route.ts` | Template-free DTOs, contract-aware readiness, bounded claim diagnostic. |
| `src/app/api/rewards/commerce7/route.ts` | Mode-aware customer listing (earlier refinement). |
| `src/components/rewards/commerce7-brand-rewards.tsx` | Template field and instructions removed; draft-only handling; money validation. |
| `src/components/rewards/commerce7-rewards-client.tsx` | Conditional customer guidance (earlier refinement). |
| `tests/commerce7-reward-harness.ts` | New shared harness: real saga + provider client against a stateful fake tenant. |
| `tests/commerce7-rewards-template-free.test.ts`, `…-coupon-contract…`, `…-coupon-provider…`, `…-reward-snapshot…`, `…-product-security-evidence…` | New suites. |
| `tests/commerce7-rewards*.test.ts`, `…-ux…`, `…-real-db…` | Rewritten or adapted. |
| `tests/fixtures/commerce7-rewards/operator-sandbox-evidence.json`, `README.md` | Redacted real sandbox reads; evidence log. |
| `docs/commerce/commerce7-rewards.md`, this file, `…-implementation-report.md` | Updated. |

## Verification

Starting from 2,889 tests, the final full suite is **2,947 tests: 2,927 passed, 20 skipped (opt-in real-DB), 0 failed, 0 cancelled**. Explicit regression runs: Shopify + shared reward suites **640/640**; Commerce7 order/refund/reconciliation/ingestion/catalog **291 passed, 3 skipped, 0 failed**. `git diff --check`, `npx tsc --noEmit`, `npm run lint` (zero findings), `npx prisma validate`, `npx prisma generate` and `npm run build` all pass (the last three with unreachable placeholder database URLs).

The opt-in real-Postgres suite was also run, **only** against a throwaway loopback cluster created for the run and deleted afterwards (migration SQL replayed with `psql`; one redundant historical migration conflicts with the baseline, and the pre-existing CHECK above was dropped in that scratch database only to mirror the original test environment). It passed, including cap-25 SSI concurrency, SQL constraints, the legacy-shape saga and the new template-free bearer path. No shared database was contacted.

Behavioral tests prove: save makes zero provider calls; one coupon per claim; exact Per Store / Everyone / Store payload; exact fixed, percentage, minimum and date mapping; double-click and replay idempotency; an ambiguous POST never reposts or refunds; definitive rejection refunds once; 429 retries once; safe cancellation refunds once; legacy offers and mid-issuance claims; claimant-only verified email, pinned customer, unique tag and leaked-code protection (with an injected verified contract); exclusive access stays blocked; tenant and Brand isolation; and a closed, sanitized diagnostic vocabulary. Five targeted mutations of production code were each caught by these tests.

These tests do not prove live Commerce7 behavior.

## Exact manual sandbox QA — operator only

1. Confirm the already-applied migration, existing tenant installation and granted Coupon: Full, Tag: Full, Customer: Read, Product: Read, Order: Read. Preserve Order/Update registration; add no webhook or permission. Do not create any template coupon.
2. Create an **Anyone with the code / All products** offer (inactive), then activate it. Confirm saving created nothing in Commerce7. Claim once with a user who has no matching Commerce7 customer. In Admin and via GET confirm exactly one new coupon titled `SQRATCH …`, `Per Store`/`1`, Everyone, whole store, correct discount and minimum, and the dates (check whether Commerce7 keeps minute-aligned UTC or shifts them to store-day boundaries; a shift would surface as `COUPON_VERIFY`/manual review). A definitive 4xx would refund the points and record `COUPON_CREATE:WRITE_REJECTED`; please capture that token and a redacted GET.
3. Redeem that coupon with a different account: the discount applies once and a second use is rejected. Verify fixed-dollar behavior across multiple items and the 36-character code.
4. Double-click and retry the claim after a lost browser response: same claim, one debit, one coupon. Cancel an unissued claim twice: one refund. Run 25 claims plus a concurrent 26th: the loser has no debit or coupon.
5. **Capture the two missing fixtures** and send the redacted GET JSON: a Coupon restricted to **specific products**, and a Coupon restricted to a **Customer tag**. These unlock the two draft-only branches. Meanwhile confirm both options save as drafts, cannot be activated, and show "draft only".
6. If a legacy claimant-only or selected-product offer is live, confirm it still issues, and that editing it without changing scope keeps working.
7. Make a synthetic paid purchase with a claim coupon and run the existing reconciliation worker: it links once; an unknown coupon representation stays unlinked. Capture a redacted populated order coupon fixture.
8. Revoke an unused coupon, test expiry and original-connection disconnect/reconnect. Save exclusive drafts: activation and claims are rejected and no Product, Tag or Customer write occurs. Run the unchanged Shopify flows and review the Brand form in a real browser (mobile layout, keyboard access, "draft only" labels, money validation).

## Provider evidence still required

* A Coupon restricted to specific products (the `appliesTo` string and the `appliesToObjectIds` shape).
* A Coupon restricted to a Customer tag (the `availableTo` string and `availableToObjectIds` shape).
* Confirmation that `POST /coupon` accepts omitted optional fields and `Per Store`/`1` (first sandbox claim), and how dates are stored.
* A populated order GET showing the coupon identity.
* A supported Customer tag-membership write, and a Product-security write confirmed against the **live** `Tag` enum (the public docs say `Group`). Exclusive access stays blocked regardless: the Product read is evidence only and no write exists.
