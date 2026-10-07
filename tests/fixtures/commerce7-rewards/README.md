# Commerce7 reward fixtures

`documented-responses.json` uses the field shapes and public enum values in the official [Coupons](https://developer.commerce7.com/docs/coupons), [Tags](https://developer.commerce7.com/docs/tags) and [Customers](https://developer.commerce7.com/docs/customers) documentation checked on 2026-10-07. IDs, titles, dates, codes and email are synthetic. It is a documented public coupon, not evidence of customer-restricted eligibility.

Unit and real-database tests separately use explicitly opaque eligibility/product-scope strings to prove that native-read values are preserved. Those strings are not presented as Commerce7 REST enums. Populated order-coupon and exclusive security/membership examples are still awaiting operator-provided redacted fixtures. Tests for those closed reader seams prove rejection and exact-match behavior; they do not claim a sandbox contract was observed.
