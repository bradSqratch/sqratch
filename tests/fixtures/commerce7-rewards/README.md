# Commerce7 reward fixtures

`documented-responses.json` uses the field shapes and public enum values in the official [Coupons](https://developer.commerce7.com/docs/coupons), [Tags](https://developer.commerce7.com/docs/tags) and [Customers](https://developer.commerce7.com/docs/customers) documentation checked on 2026-10-07. IDs, titles, dates, codes and email are synthetic. It is a documented public coupon, not evidence of customer-restricted eligibility.

`operator-sandbox-evidence.json` holds real sandbox reads supplied by the operator on 2026-10-07. Field names, enum strings, nulls, empty strings and date precision are exactly as observed; only the tenant resource UUIDs were replaced with synthetic ones.

- **coupon** — a Coupon created in Commerce7 Admin. Proves `appliesTo: "Store"` and `availableTo: "Everyone"`, that an empty object-ID list is read back as `""` (not `null`/`[]`), that a coupon with no discount reads `productDiscountType`/`shippingDiscountType` as `null`, and that dates are minute-aligned.
- **productSecurity** — a Product restricted to a Customer tag (`GET /v1/product/{id}`). Proves the live tenant says `security.availableTo: "Tag"` (the public Product enum documentation says "Group") and carries `displayOption` and the tag UUID in `availableToObjectIds`. Read evidence only; SQRATCH never writes Product security.
- **customerTag** — the Manual Customer tag referenced above.

`live-coupon-create-422.json` is the sanitized response of an operator's direct live probe of `POST /coupon`. It proves the live write schema requires `type`, `discountType` and `discount` and rejects `productDiscountType`, `productDiscount` and `shippingDiscountType`, so the public docs' create example is stale. It does **not** reveal the valid values for the three required fields; those values are proven by `live-coupon-create-201.json`.

`live-coupon-create-201.json` holds the request payloads of the operator's live sandbox probes that returned HTTP 201 (fixed amount, percentage, minimum subtotal), plus the observation that a percentage coupon echoes `dollarOffDiscountApplies: "Once Per Order"`. The 201 response bodies were not supplied, so none is stored; tests that need a read-back object build a synthetic echo and say so. No credential, JWT or header is stored.

`live-coupon-create-product-201.json` is the sanitized HTTP 201 response of a live `POST /v1/coupon` restricted to one product. It proves `appliesTo: "Product"` with the product IDs in `appliesToObjectIds` (selected-product discounts and the optional Exclusive Wine Access discount). The coupon UUID, product UUID and 20-character probe code are replaced with synthetic values; fields whose names were not supplied are not invented.

`live-coupon-percentage-observation.json` records the 2026-10-08 live QA observation that a coupon created with `discountType: "Percentage Off"` and `discount: 15` (HTTP 201) was shown as 0.15% in Commerce7 Admin and took CAD 0.03 off a CAD 18.97 item. It proves the native percentage unit is 1/100 of a percent; a live 1500 = 15% observation is still required before percentage issuance is enabled.

`live-customer-tag-membership.json` holds the operator's live Customer Tag membership requests: the customer's `tags` entries (`GET /v1/customer/{id}`), the `POST /v1/tag-x-object/customer` 201 that succeeded for a customer who already held the tag and then listed it twice, and the `DELETE /v1/tag-x-object/customer/{tagId}/{customerId}` 204 that removed both copies. Only the customer's `tags` array is stored; no other customer field. SQRATCH uses the POST (once, after verified absence) and never the DELETE.

Still missing, and therefore still fail-closed: a live 15% coupon observation (`percentage.verified`) and the live `GET /v1/tag/customer/{id}` shape. A Customer-tag restricted **Coupon** is no longer needed: discount rewards are Anyone with the code only.

`live-order-coupons-1007.json` is the operator-supplied Order Create payload for #1007, reduced to the fields SQRATCH reads, with synthetic UUIDs and a synthetic code. It proves an order `coupons[]` entry carries the native coupon id in `couponId` (the entry's own id is `id`) plus the code; purchase linking matches `couponId` + code.

`live-multi-tag-storefront-observation.json` records the operator's 2026-10-09 storefront test: a product secured to three Manual Customer Tags is purchasable by a customer holding any one of them (OR) and not by a customer holding none.

Evidence that would open a gate, by file name (checked by `tests/commerce7-verification-evidence.test.ts`, which fails if a flag is switched on without its file): `live-coupon-percentage-1500-observation.json` (a manually created native coupon with `discount: 1500`, Admin showing 15% and checkout taking 15%), `live-coupon-customer-tag-restriction.json` (an Admin-created coupon restricted to one Manual Customer Tag, read through the public API without its code, plus tagged-accepted / untagged-refused redemption results; an Exclusive Wine Access grant is not evidence) and `live-multi-tag-storefront-observation.json` (a customer holding only the granted tag can buy a multi-tag product; a customer with none cannot).

Tests that need a response the operator did not supply (for example the fake tenant in `tests/commerce7-reward-harness.ts`) build synthetic ones that follow this evidence and say so.

Unit and real-database tests separately use explicitly opaque eligibility/product-scope strings to prove that the mapping plumbing and legacy template snapshots preserve native values. Those strings are not presented as Commerce7 REST enums. The populated order-coupon shape is now observed (`live-order-coupons-1007.json`).
