# Phase 3.5: Product Pagination and Brand Catalog Completion

Phase 3.5 removes the persisted Shopify catalog's one-page ceiling while preserving the existing Shopify product-route contract. It also completes the brand-curation path from the brand dashboard through the public Experience Shop.

## Catalog synchronization

`CommerceAdapter` now has optional provider-neutral page methods. A page accepts an opaque cursor and page size, and returns normalized products, an opaque next cursor, and explicit completion. The established `syncProducts` method remains a single-page operation for existing Shopify callers and route compatibility.

`syncBrandCommerceProducts` owns logical catalog pagination. It fetches pages until the provider explicitly completes, applies bounded page, product, and elapsed-time guards, rejects missing, blank, repeated, self-referential, and cyclic cursors, and deduplicates overlapping products by stable external key. Later-page data deterministically wins while counts use the final unique catalog.

Only a fully fetched and fully persisted catalog is `SUCCEEDED`. Provider-page failures, invalid pages, timeout/bound exits, and persistence failures become `PARTIAL` or `FAILED` and never mark unseen products unavailable. Connection sync metadata is stamped only after the persisted catalog completes. A future background worker may be needed for catalogs that cannot complete within the synchronous request bound.

`PARTIAL` outcomes preserve the existing catalog and never mark products absent from the partial result inactive. The brand dashboard displays the server-classified partial reason (for example, a timeout, cursor problem, safety bound, or partial write failure) with conservative fetched/write counts where available. Retrying starts a fresh synchronization from the beginning; it does not resume the prior run.

Shopify pagination reuses the existing GraphQL `after` / `endCursor` path. It does not change scopes, token refresh behavior, Shopify configuration, products, orders, or inventory access. Currency remains sourced from the authoritative brand/store configuration and prices remain integer minor units in persistence.

Shopify may include an `endCursor` on a final page even when `hasNextPage` is false. The Shopify adapter therefore exposes a next cursor only when `hasNextPage` is true; a complete provider-neutral page always has `nextCursor: null`.

## Brand catalog completion

The brand products dashboard now exposes a bounded integer display order (0 through 1,000,000), sends it with the existing selection PATCH request, and preserves an explicit zero.

The public Experience Shop still gives current direct `ExperienceProductLink` rows absolute precedence. With no direct links, brands with no `BrandCommerceProduct` rows retain the legacy live-Shopify fallback. Once any selection exists, the persisted curated catalog is authoritative: only visible, active products belonging to that brand are returned; title and optional description overrides are applied; and rows are ordered by display order, title, then product id. This lets a brand intentionally show an empty storefront by hiding every selected product. Product images always come from the synchronized `ConnectedCommerceProduct`; the legacy `imageUrlOverride` column is intentionally dormant and ignored without a migration.

`isAvailable` records whether a product was present and active in the latest complete provider sync. It does not represent live physical inventory, and Phase 3.5 does not request inventory scopes.

The public serializer selects only allowlisted product and curation fields. It never exposes provider metadata, connection secrets, or credentials. Existing click analytics and provider checkout URLs remain unchanged. `isVisibleInShop` controls public storefront display. `isCampaignEligible` records eligibility for a future campaign-assignment step; neither flag currently authorizes a creator to attach a lesson product. Experience/Lesson links are not migrated.

## Creator compatibility and Phase 4

The creator lesson-product picker remains a legacy compatibility path and may fetch the connected Shopify catalog directly. Phase 3.5 deliberately does not make `isVisibleInShop` or `isCampaignEligible` creator authorization, and it does not add campaign-specific assignment.

The intended hierarchy for the next phase is:

```
ConnectedCommerceProduct
    ↓
BrandCommerceProduct.isCampaignEligible
    ↓
CampaignCommerceProduct
    ↓
Creator may select products assigned to the Experience’s campaign
```

Recommended next phase: **Phase 4 — Campaign product curation and creator product selection**.

## Verification

All automated coverage uses the blocked database URL and injected fakes or mocks. Focused tests cover multi-page and guard behavior, completion-only reconciliation, duplicate handling, route compatibility, display-order persistence, curated/public fallback and overrides, cross-brand filtering, secret non-disclosure, and click analytics. No schema migration or production database operation is part of this phase.
