# Commerce7 rewards implementation handoff

Completed 2026-10-07. All changes are uncommitted on `main`. The implementation is ready for source review and operator sandbox acceptance; it has not been deployed or validated against live native writes. [Design, sources and exact operator guide](/Users/sumedh/Documents/PersonalProjects/sqratch/docs/commerce/commerce7-rewards.md).

## Requested 30-item report

1. **Starting SHA:** `6e7ff3fc563372659a1fb3404d393c9c72098bff`; starting branch `main`, clean worktree. HEAD remains unchanged.
2. **Final Git status:** `main`, 21 modified tracked files and 22 new untracked files. Nothing staged, committed, pushed or deployed. Full status appears below.
3. **Architecture:** existing provider-neutral offers/redemptions/points ledger, with a Commerce7-specific customer-bound saga/client. Shopify retains its working flow and external contracts.
4. **Official contracts:** Coupon create/read/list/delete, Manual Customer tag-definition creation, Customer/email/tag reads and native tag-filter lookup are documented. Native template GET supplies unpublished eligibility/product-scope literals. See the linked guide's source table. Customer tag assignment, complete Product security mutation, Allocation writes and populated order-coupon representation remain unproven externally.
5. **APIs used:** GET/POST/DELETE Coupon; GET/POST Customer tag definitions; GET Customers/cursor/tag filter and customer ID; existing GET Order by ID. Product data comes from the synchronized catalog. No Customer PUT, Product PUT or Allocation API is invented.
6. **Permissions:** manually add missing Coupon: Full, Tag: Full and Customer: Read. Retain Product: Read and Order: Read for catalog/order features. Do not add Customer Full, Product Full or Allocation for this implementation.
7. **Schema/migration:** `20261008010000_commerce7_rewards`, strictly after the existing reconciliation migration. Additive reward configuration/mode, durable capacity counter, saga ownership/attempt/evidence fields, checks and indexes. Applied only to a fresh disposable local test database, never shared/production.
8. **Modes:** DISCOUNT is implemented with manual native eligibility handoff; EXCLUSIVE_PRODUCT_ACCESS is a separate, persisted draft mode with optional discount and a 25-claim ceiling. Exclusive activation is intentionally blocked.
9. **Fixed discount:** bounded integer cents, minimum subtotal, exact native template scope and supported cent currencies; $10 maps to 1000 provider units. No floating point order-money change.
10. **Percentage:** whole 1–100%, stored in basis points; 1500 maps to native 15. Invalid/fractional/overflow values fail validation.
11. **Exclusive wine:** synchronized same-Brand/connection product, points, dates, per-user/total limits and optional discount can be configured. There is no claimable native access entitlement until Commerce7 proves membership/security contracts. No points are charged for the blocked draft.
12. **Email/customer binding:** authenticated active verified SQRATCH user, exact normalized native email, pinned tenant/customer ID, verification-stamp revalidation and unique per-claim native Customer tag. Raw email is transient. A leaked code alone does not grant tag eligibility; real checkout enforcement is an operator acceptance gate.
13. **Concurrency:** short serializable transactions + guarded durable capacity increment + existing ledger keys/guarded balance + unique claim idempotency/code. Real Postgres verifies final slot #25 versus #26, competing spends, duplicate keys, one refund, rollback, owner exclusion, and claim/deletion races. Capacity survives privileged account cascades; the admin route retains C7 history.
14. **Retry/idempotency:** stable browser request key, server namespace bound to user/offer, durable owner and pre-write attempt markers. Lookup recovers a lost successful response. Unknown absence never triggers another POST. Safe pre-coupon cancellation/setup rejection refunds through the ledger. Possible issuance stays explicitly held for review.
15. **Order linkage:** independent bounded observer, exact original connection/Brand/customer/coupon/order/update-version + canonical PAID evidence, serializable recheck, one claim linkage, no financial/attribution/order/points writes. Revocation/refunds preserve observed history. Unknown native shapes stay unlinked. Existing Order/Update webhook remains unchanged; no Order/Create subscription.
16. **Brand UX:** provider selection, real discount CRUD, synchronized product picker, limits/windows, native-template validation, readiness/manual assignment instructions, remaining capacity, claim queue, recovery checks and native revocation. Exclusive drafts cannot be activated.
17. **User UX:** Points and experience rewards, spendable balance, discount/product summaries, availability reasons/window, same-email notice, reserved-points/cancel explanation, guarded claim/retry, code/expiry/copy and validated original-store navigation.
18. **Shopify regression:** full existing suite and focused reward/adapter/connection tests pass. Shopify-only paths are explicitly provider-pinned so C7 rows cannot enter its bearer-discount or compensation pipeline. Existing fixture updates add the required explicit provider rather than weaken assertions.
19. **Security/privacy:** reviewed server-derived identity/configuration, Brand/connection isolation, customer ambiguity, leaked/shared tag rejection, state transitions, persistent owners, points compensation, runtime JSON validation and sanitized errors. No raw Customer/Order logging or duplicate email fields. No live secrets/provider payloads were exposed.
20. **Tests added:** five C7 test files containing 30 test entries, including one separately opted-in real PostgreSQL scenario with extensive assertions. Coverage includes actual routes and actual TSX execution, provider mappings/parsers, fixture rejection, identity, SQL constraints, lost responses, account deletion, capacity, ledger and canonical-order stability. Two documented fixture files distinguish official shapes from intentionally opaque native-read seam fixtures.
21. **Test results:** full suite 2,875 discovered / 2,855 passed / 20 expected environment or opt-in skips / zero failures. Focused suite 454 discovered / 450 passed / four opt-in skips / zero failures. Separate opted-in PostgreSQL scenario: one passed / zero skipped / zero failures. All commands exited 0.
22. **Other validation:** `git diff --check`, `npx tsc --noEmit`, `npm run lint`, `npx prisma validate`, `npx prisma generate` and `npm run build` passed. Final lint: zero errors/warnings. Build generated 130 pages, with database URLs overridden to a blocked local placeholder. Graphify AST update succeeded; its generated outputs are ignored by Git. The disposable Postgres server was stopped.
23. **Remaining P0/P1/P2:** no known findings in the implemented scope after repeated review/fix/test passes. External access contracts and sandbox/browser acceptance are outstanding gates, not asserted successes.
24. **P3/operational limitations:** manual CRM assignment; tag/coupon object growth; initial lookup limited to 1,000 customers and bounded tag search; one claim/five orders per reconciliation invocation; operator recovery for crashed owners or unresolved writes; whole percentages and verified cent currencies only. Native order fixture and exclusive access contracts are external dependencies. Graphify's optional SQL parser is absent, and JSON fixtures have no AST nodes; SQL was reviewed and executed in the disposable database instead.
25. **Manual App Dev Center:** select the SQRATCH app/version → Step 1 APIs & Webhooks → Add API Access → add only missing permissions in item 6 → Save. For published apps use Add Version, configure, submit/approve, then approve the tenant's upgrade. Preserve existing installation URLs/auth and the sole Order/Update callback. Normal upgrades are not an automatic reinstall requirement. Full details are in the guide.
26. **Future migration commands:** with securely configured explicitly selected target credentials: `npx prisma validate`, `npx prisma migrate status`, review ALL pending migrations, `npx prisma migrate deploy`, `npx prisma generate`. Back up and review constraints/table locks first. No `db push`/reset on shared databases. Full preflight/rollback is in the guide.
27. **Vercel/env:** no new production variable or Vercel configuration is required or changed. Retain existing server-only COMMERCE7_APP_ID/COMMERCE7_APP_SECRET and CRON_SECRET. Retain existing externally managed Cron scheduling. No NEXT_PUBLIC credentials. Local DB opt-ins are test-only.
28. **Manual E2E QA:** the guide supplies the exact eleven-stage operator checklist: native fixtures/template/permissions → fixed and percentage offers → Alice pending/cancel/manual tag/ready checkout → Bob leaked-code rejection → cap 25/concurrent loser → lost-response recovery → exclusive activation rejection → exact paid-order/repeat/refund/fulfillment linkage → revoke/expiry → Shopify/browser acceptance. Provider writes were not run by the agent.
29. **Complete changed-file inventory:** 43 files, listed below. Graphify additionally refreshed ignored generated graph files/backups/cache; build/typecheck produced their normal ignored artifacts. No unrelated tracked changes were present initially.
30. **Git diff stat:** exact output below covers tracked changes only. The 22 new untracked files are included in the complete inventory and the aggregate line summary, without staging anything.

## Independent review findings resolved

| Finding | Resolution and evidence |
| --- | --- |
| Generic reconciliation could process a C7 claim | Explicit Shopify provider predicates; full regression suite |
| Ambiguous writes could repeat resources or return points beside a live coupon | Durable owner/attempt markers, exact recovery, manual hold; synthetic saga + real Postgres |
| Initial identity/tag membership could accept ambiguity or a shared tag | Exact verified-email exhaustion, pinned ID rechecks, proven tag filter, duplicate-page rejection; contract/DB tests |
| Late React responses and repeated requests could corrupt context or create another logical claim | Context/sequence guards, stable request keys, busy ref and terminal-key rotation; actual TSX tests |
| Order-check failures could starve other claims; revocation could hide historical purchase | Fair claim-owned checkpoint updates and revoked-state linkage; pure + Postgres tests |
| Account deletion could recycle lifetime issuance capacity or delete new history | Durable capacity counter/check constraint; serializable admin retention guard; actual deletion-route/claim race against Postgres |

## Complete inventory

- Added: [docs/commerce/commerce7-rewards-implementation-report.md](/Users/sumedh/Documents/PersonalProjects/sqratch/docs/commerce/commerce7-rewards-implementation-report.md)
- Added: [docs/commerce/commerce7-rewards.md](/Users/sumedh/Documents/PersonalProjects/sqratch/docs/commerce/commerce7-rewards.md)
- Added: [prisma/migrations/20261008010000_commerce7_rewards/migration.sql](/Users/sumedh/Documents/PersonalProjects/sqratch/prisma/migrations/20261008010000_commerce7_rewards/migration.sql)
- Modified: [prisma/schema.prisma](/Users/sumedh/Documents/PersonalProjects/sqratch/prisma/schema.prisma)
- Modified: [src/app/(withSidebar)/dashboard/brand/rewards/page.tsx](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/(withSidebar)/dashboard/brand/rewards/page.tsx)
- Modified: [src/app/(withSidebar)/dashboard/points/page.tsx](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/(withSidebar)/dashboard/points/page.tsx)
- Modified: [src/app/api/admin/user-management/update-or-delete-users/[id]/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/admin/user-management/update-or-delete-users/[id]/route.ts)
- Added: [src/app/api/brand/rewards/commerce7/claims/[claimId]/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/brand/rewards/commerce7/claims/[claimId]/route.ts)
- Added: [src/app/api/brand/rewards/commerce7/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/brand/rewards/commerce7/route.ts)
- Modified: [src/app/api/brand/rewards/offers/[offerId]/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/brand/rewards/offers/[offerId]/route.ts)
- Modified: [src/app/api/brand/rewards/offers/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/brand/rewards/offers/route.ts)
- Modified: [src/app/api/internal/reconcile-redemptions/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/internal/reconcile-redemptions/route.ts)
- Added: [src/app/api/rewards/commerce7/claims/[claimId]/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/rewards/commerce7/claims/[claimId]/route.ts)
- Added: [src/app/api/rewards/commerce7/claims/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/rewards/commerce7/claims/route.ts)
- Added: [src/app/api/rewards/commerce7/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/rewards/commerce7/route.ts)
- Modified: [src/app/api/rewards/shopify/redeem/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/rewards/shopify/redeem/route.ts)
- Modified: [src/app/api/rewards/shopify/route.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/app/api/rewards/shopify/route.ts)
- Modified: [src/components/experience/shop-client.tsx](/Users/sumedh/Documents/PersonalProjects/sqratch/src/components/experience/shop-client.tsx)
- Added: [src/components/rewards/commerce7-brand-rewards.tsx](/Users/sumedh/Documents/PersonalProjects/sqratch/src/components/rewards/commerce7-brand-rewards.tsx)
- Added: [src/components/rewards/commerce7-rewards-client.tsx](/Users/sumedh/Documents/PersonalProjects/sqratch/src/components/rewards/commerce7-rewards-client.tsx)
- Modified: [src/lib/commerce/providers/commerce7-commerce-adapter.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/commerce/providers/commerce7-commerce-adapter.ts)
- Added: [src/lib/commerce/providers/commerce7-reward-orders.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/commerce/providers/commerce7-reward-orders.ts)
- Added: [src/lib/commerce/providers/commerce7-rewards-client.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/commerce/providers/commerce7-rewards-client.ts)
- Modified: [src/lib/commerce/types.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/commerce/types.ts)
- Added: [src/lib/commerce7-reward-domain.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/commerce7-reward-domain.ts)
- Added: [src/lib/commerce7-reward-http.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/commerce7-reward-http.ts)
- Added: [src/lib/commerce7-rewards.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/commerce7-rewards.ts)
- Modified: [src/lib/reward-offers.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/reward-offers.ts)
- Modified: [src/lib/reward-reconciliation.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/src/lib/reward-reconciliation.ts)
- Modified: [tests/commerce-connection-service.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce-connection-service.test.ts)
- Modified: [tests/commerce7-installation-linking.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce7-installation-linking.test.ts)
- Modified: [tests/commerce7-product-catalog.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce7-product-catalog.test.ts)
- Added: [tests/commerce7-rewards-isolation.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce7-rewards-isolation.test.ts)
- Added: [tests/commerce7-rewards-real-db.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce7-rewards-real-db.test.ts)
- Added: [tests/commerce7-rewards-routes.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce7-rewards-routes.test.ts)
- Added: [tests/commerce7-rewards-ux.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce7-rewards-ux.test.ts)
- Added: [tests/commerce7-rewards.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/commerce7-rewards.test.ts)
- Added: [tests/fixtures/commerce7-rewards/README.md](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/fixtures/commerce7-rewards/README.md)
- Added: [tests/fixtures/commerce7-rewards/documented-responses.json](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/fixtures/commerce7-rewards/documented-responses.json)
- Modified: [tests/integration-coverage.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/integration-coverage.test.ts)
- Modified: [tests/reward-provider-expansion-migration.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/reward-provider-expansion-migration.test.ts)
- Modified: [tests/shopify-commerce-adapter.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/shopify-commerce-adapter.test.ts)
- Modified: [tests/shopify-reward-adapter-cutover.test.ts](/Users/sumedh/Documents/PersonalProjects/sqratch/tests/shopify-reward-adapter-cutover.test.ts)

## Final git status --short

```text
 M prisma/schema.prisma
 M src/app/(withSidebar)/dashboard/brand/rewards/page.tsx
 M src/app/(withSidebar)/dashboard/points/page.tsx
 M src/app/api/admin/user-management/update-or-delete-users/[id]/route.ts
 M src/app/api/brand/rewards/offers/[offerId]/route.ts
 M src/app/api/brand/rewards/offers/route.ts
 M src/app/api/internal/reconcile-redemptions/route.ts
 M src/app/api/rewards/shopify/redeem/route.ts
 M src/app/api/rewards/shopify/route.ts
 M src/components/experience/shop-client.tsx
 M src/lib/commerce/providers/commerce7-commerce-adapter.ts
 M src/lib/commerce/types.ts
 M src/lib/reward-offers.ts
 M src/lib/reward-reconciliation.ts
 M tests/commerce-connection-service.test.ts
 M tests/commerce7-installation-linking.test.ts
 M tests/commerce7-product-catalog.test.ts
 M tests/integration-coverage.test.ts
 M tests/reward-provider-expansion-migration.test.ts
 M tests/shopify-commerce-adapter.test.ts
 M tests/shopify-reward-adapter-cutover.test.ts
?? docs/commerce/commerce7-rewards-implementation-report.md
?? docs/commerce/commerce7-rewards.md
?? prisma/migrations/20261008010000_commerce7_rewards/
?? src/app/api/brand/rewards/commerce7/
?? src/app/api/rewards/commerce7/
?? src/components/rewards/commerce7-brand-rewards.tsx
?? src/components/rewards/commerce7-rewards-client.tsx
?? src/lib/commerce/providers/commerce7-reward-orders.ts
?? src/lib/commerce/providers/commerce7-rewards-client.ts
?? src/lib/commerce7-reward-domain.ts
?? src/lib/commerce7-reward-http.ts
?? src/lib/commerce7-rewards.ts
?? tests/commerce7-rewards-isolation.test.ts
?? tests/commerce7-rewards-real-db.test.ts
?? tests/commerce7-rewards-routes.test.ts
?? tests/commerce7-rewards-ux.test.ts
?? tests/commerce7-rewards.test.ts
?? tests/fixtures/
```

## git diff --stat

```text
 prisma/schema.prisma                               | 42 ++++++++++++++++++++++
 .../(withSidebar)/dashboard/brand/rewards/page.tsx | 11 +++++-
 src/app/(withSidebar)/dashboard/points/page.tsx    |  2 ++
 .../update-or-delete-users/[id]/route.ts           | 14 +++++++-
 .../api/brand/rewards/offers/[offerId]/route.ts    | 13 +++++--
 src/app/api/brand/rewards/offers/route.ts          | 20 +++++++++--
 .../api/internal/reconcile-redemptions/route.ts    | 30 +++++++++-------
 src/app/api/rewards/shopify/redeem/route.ts        |  5 +--
 src/app/api/rewards/shopify/route.ts               |  1 +
 src/components/experience/shop-client.tsx          |  2 ++
 .../providers/commerce7-commerce-adapter.ts        | 14 +++++---
 src/lib/commerce/types.ts                          | 14 ++++++++
 src/lib/reward-offers.ts                           |  2 +-
 src/lib/reward-reconciliation.ts                   |  1 +
 tests/commerce-connection-service.test.ts          |  8 +++--
 tests/commerce7-installation-linking.test.ts       |  5 ++-
 tests/commerce7-product-catalog.test.ts            |  6 +++-
 tests/integration-coverage.test.ts                 | 16 +++++++++
 tests/reward-provider-expansion-migration.test.ts  |  8 +++--
 tests/shopify-commerce-adapter.test.ts             |  2 ++
 tests/shopify-reward-adapter-cutover.test.ts       |  3 ++
 21 files changed, 185 insertions(+), 34 deletions(-)
```

Working-tree aggregate including untracked additions: **43 files, 2071 insertions, 34 deletions**. This is a calculated inventory summary, not staged Git output.
