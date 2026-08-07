# Phase 4 — Campaign Product Curation and Creator Authorization

## Scope

Phase 4 adds an opt-in, provider-neutral authorization layer between a brand's
persisted catalog and creator lesson product links. It does not move existing
`ExperienceProductLink` or `LessonProductLink` records, alter public-shop
visibility, or consume campaign eligibility in a public storefront.

## Compatibility policy

`Campaign.commerceProductCurationEnabled` defaults to `false`. While it is
false, the creator picker and product attachment route retain the existing
live-Shopify compatibility behavior. Turning it on never changes historical
links. A curated campaign with zero active assignments deliberately authorizes
zero new products; there is no provider fallback in curated mode.

## Data model and integrity

`CampaignCommerceProduct` stores a reversible assignment from a campaign to a
`BrandCommerceProduct`, with `isActive`, `deactivatedAt`, and `displayOrder`.
It has one lifecycle row per `(campaignId, brandCommerceProductId)`, so
reactivation reuses history rather than deleting it. Composite foreign keys
bind the assignment's `brandId` to both its Campaign and BrandCommerceProduct;
cross-brand assignment rows cannot be inserted by application bypasses.

The pre-existing BrandCommerceProduct-to-ConnectedCommerceProduct relation is
left intact by the additive migration. Runtime authorization additionally
requires the connected product to belong to the same brand, remain available,
and remain campaign eligible. The reconciliation tool reports any historical
drift without destructive repair.

## Brand workflow

On a campaign edit page, enable **Use a curated campaign product catalog** and
open **Manage campaign products**. The product manager lists persisted brand
catalog records only. It permits assignment/reactivation only for available,
campaign-eligible products, supports display order `0` through `1000000`, and
deactivates assignments instead of deleting them. Product URLs, provider ids,
metadata, credentials, and tokens are never accepted as authorization input.

## Creator workflow

The picker resolves campaigns from the lesson's Experience on the server:

- No curated campaign: legacy picker unchanged.
- Exactly one curated campaign: it is inferred.
- More than one curated campaign: the creator must explicitly select a linked
  campaign before products are shown or attached.
- An unrelated, foreign-brand, or unknown campaign id receives a controlled
  `404` and reveals no catalog state.

Curated picker rows use internal `ConnectedCommerceProduct` ids. The attach and
replacement routes resolve that id again server-side through an active campaign
assignment and derive the snapshot from the persisted catalog. Client title,
image, URL, provider ids, and brand id cannot grant access or override that
snapshot. Existing links remain displayed and removable even after a product
becomes ineligible, unavailable, or deactivated; only new/replacement links
fail closed.

## Reconciliation

Run, against an explicitly selected non-production database only:

```bash
npx tsx scripts/reconcile-campaign-commerce-products.ts
```

It is a dry run by default. It audits missing and cross-brand relations,
availability/eligibility drift, and duplicate active rows without logging
provider metadata, URLs, or credentials. `--apply` performs only a
deterministic reversible repair: duplicate active assignments after the oldest
row are deactivated. It never deletes or changes Lesson/Experience links,
creates assignments, or enables curation.

## Migration deployment

`20260807120000_add_campaign_commerce_product_curation` is additive and is not
applied by this implementation. Its SQL contains preflight queries for the
prior product-catalog migration, required tables, pre-existing wrong-brand
selection drift, and partial manual objects. It has no automatic rollback,
because dropping the new assignment table after use would destroy curation
history. Export or back up assignments before any manual rollback. Apply only
through the normal reviewed deployment process after preflight succeeds.

## Phase 5 boundary

Phase 5 can consider migrating/canonicalizing legacy Experience and Lesson
product links once rollout data shows curation is stable. That migration is
explicitly out of scope here.
