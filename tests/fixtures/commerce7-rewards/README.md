# Commerce7 reward fixtures

`documented-responses.json` uses the field shapes and public enum values in the official [Coupons](https://developer.commerce7.com/docs/coupons), [Tags](https://developer.commerce7.com/docs/tags) and [Customers](https://developer.commerce7.com/docs/customers) documentation checked on 2026-10-07. IDs, titles, dates, codes and email are synthetic. It is a documented public coupon, not evidence of customer-restricted eligibility.

`operator-sandbox-evidence.json` holds real sandbox reads supplied by the operator on 2026-10-07. Field names, enum strings, nulls, empty strings and date precision are exactly as observed; only the tenant resource UUIDs were replaced with synthetic ones.

- **coupon** — a Coupon created in Commerce7 Admin. Proves `appliesTo: "Store"` and `availableTo: "Everyone"`, that an empty object-ID list is read back as `""` (not `null`/`[]`), that a coupon with no discount reads `productDiscountType`/`shippingDiscountType` as `null`, and that dates are minute-aligned.
- **productSecurity** — a Product restricted to a Customer tag. Proves the live tenant says `security.availableTo: "Tag"` (the public Product enum documentation says "Group") and carries `displayOption` and the tag UUID in `availableToObjectIds`. This is read evidence only. No Product-security write contract exists in SQRATCH, and exclusive wine access stays draft-only.
- **customerTag** — the Manual Customer tag referenced above.

Still missing, and therefore still fail-closed (see `src/lib/commerce7-coupon-contract.ts`): a sandbox **Coupon** restricted to specific products, and a sandbox **Coupon** restricted to a Customer tag. Either read would prove the `appliesTo` / `availableTo` strings and the shape of the object-ID lists for that branch.

Unit and real-database tests separately use explicitly opaque eligibility/product-scope strings to prove that the mapping plumbing and legacy template snapshots preserve native values. Those strings are not presented as Commerce7 REST enums. Populated order-coupon examples are still awaiting an operator-provided redacted fixture; tests for that closed reader seam prove rejection and exact-match behavior and do not claim a sandbox contract was observed.
