# Phase 11.1 — Canonical immutable Campaign ownership

Phase 11.1 makes `Campaign.brandId` required and immutable. Campaign creation
still assigns one owner: Brand-admin creation derives it from the authenticated
membership, and platform-admin creation validates an explicitly selected Brand.
Campaign editing changes metadata only; a stale same-Brand echo is compatible,
but a distinct owner is rejected with `CAMPAIGN_BRAND_IMMUTABLE`.

The unapplied migration first blocks on legacy null owners, then installs a
PostgreSQL trigger that rejects ownership changes. It does not backfill, update,
or delete Campaign data.

`CommerceClickAttribution.brandId` is removed because it duplicated
`attributedBrandId` and made historical attribution depend on mutable
relationships. `attributedBrandId` remains the sole durable, non-FK Brand
snapshot. Existing null values stay unknown. Product authorization remains an
optional `productCampaignId` FK to `Campaign.id` with `ON DELETE SET NULL`; it
is not an acquisition or historical Brand attribution field.

Legacy field audit:

- `Brand.shopify*` fields: active compatibility mirror for the Shopify adapter.
- `CommerceConnection` and catalog tables: canonical provider-neutral commerce
  connection/catalog architecture.
- Reward Shopify metadata: active provider compatibility for redemption flows.
- `CommerceOrder*`: forward seam; order webhook transport is not enabled merely
  by these provider-neutral persistence models.
- `attributedBrandId`: canonical click history scope; the old click `brandId`
  is the redundant field removed by this phase.
