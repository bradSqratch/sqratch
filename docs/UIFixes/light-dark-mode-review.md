# Light and dark appearance review

Date: October 18, 2026. Branch: `codex/system-light-dark-theme`.

## Final design refinements

The light palette was subsequently refined to ivory pages, raised cream cards, restrained lavender actions, a pale sage sidebar, and a warm neutral top bar. Shared shadcn primitives receive light-only surface, field, table, focus, and spacing refinements. The original browser audit below records the earlier palette values.

Public pages now expose a single sun/moon button on the right of the shared navbar. It reflects the resolved theme and toggles between light and dark; the first visit follows system appearance. The footer has no appearance selector. The dashboard retains its System/Light/Dark selector, sharing the same browser preference.

The light homepage hero uses a faint champagne sky overlay, a centered transparent glass card, a pearlescent About pill, and two newly generated cube images encoded as transparent six-second WebM loops. Cube instances vary through code scale/flips/rotation, and reduced-motion users receive still artwork. Existing images and videos are unchanged. Hero CSS is imported separately to ensure the development browser receives the current styles.

Responsive checks covered 390, 768, 1024, 1440, 1920, and 2560px widths. Tablet/desktop headings stayed on one line; mobile wrapped. No horizontal page overflow was observed. Desktop and mobile screenshots were inspected. All new hero styles are scoped to light mode.

Final pre-commit checks: typecheck passed; ESLint passed for all 79 changed/new TypeScript files; diff whitespace validation passed. Earlier focused test coverage is recorded below.

## Result

The existing dark canvas and blue glows are now the dark theme. Light mode uses the supplied Anthropic screenshot as its visual reference: warm ivory paper, cream and sand panels, charcoal copy, muted sage/peach/lavender stat tiles, warm borders, and soft shadows. SQRATCH branding and existing layouts remain in place.

Dashboard navigation uses a pale sage sidebar, a sand top bar, and a deeper sage hover/active tint. Menu borders retain their width on hover, avoiding layout jumps; transitions are limited to colors/shadows and respect reduced motion. Keyboard focus and current-section indicators are included. Mobile navigation shares the sage surface.

A root `next-themes` provider selects system appearance by default. The Appearance selector in the dashboard header offers System, Light, and Dark. Its preference is stored only in this browser (`sqratch-theme`), with no account/database setting. System follows OS appearance changes. The pre-content theme script avoids a light/dark flash; hydration differences are scoped to the root HTML element. Native date/datetime/select controls and toast notifications follow the active theme.

Shared palettes cover page shells, tables, inputs, disabled/loading/error states, menus, dialogs, public experience components, and provider connection screens. Image/video scrims, QR artwork, and inverse button copy retain their required contrast.

## Browser coverage and data-safety audit

All ten supplied accounts were signed into successfully. Review used the local development app, including desktop, phone (390px), and tablet (768px) header checks. Shared templates were reviewed with representative existing records; every record and every modal permutation was not opened separately.

| Account/context | Screens or states inspected |
| --- | --- |
| Super admin | Dashboard, approvals and approval history, user management and Create User dialog, brands, campaigns and create form, points, profile |
| Ski brand | Dashboard, brand profile, campaigns, new/edit campaign forms, campaign products, experience sponsorships, QR batches, disconnected store, products, rewards, analytics |
| Commerce7 sandbox brand | Dashboard, QR batches and new-batch form, connected store/settings/readiness, products, rewards and existing claims, analytics, order operations and order detail with refund summary |
| BigHeadWines brand | Dashboard, connected Shopify store, products, rewards, analytics |
| Shopify review brand | Dashboard, store, Shopify connection/disconnected state, order explorer, products, rewards |
| Max creator | Dashboard, experiences, new/edit experience, courses, experience course management, course lessons, posts, experience post editor, Q&A, analytics |
| Wine Cinema creator | Dashboard, experiences, courses, posts, Q&A, analytics |
| Commerce7 sandbox creator | Dashboard, experience/course/post navigation, Q&A, analytics, points |
| Shopify review creator | Dashboard, experiences, courses, posts, Q&A, analytics, points |
| Commerce7 sandbox user | Dashboard, points, profile, user home with empty unlocked-campaign/continue-watching sections |
| Public/auth | Homepage, about, contact, support, privacy, terms, login, signup, verification form, approval-pending, 404 |
| Installation errors | Commerce7 connect/link without context, Shopify installation without an install session |

The review traversed more than 90 screen/account states across 47 route templates (including the 404 and installation error route). No page overflow was observed in the recorded desktop checks. Header appearance controls fit at the checked phone and tablet widths.

## Screens and states not visually verified

These components received theme styling, but the following live flows were intentionally not entered or completed:

- `/c/[campaignSlug]`: its GET handler creates a `campaign_view` analytics record.
- `/x/[experienceSlug]` and its Learn, Posts, Q&A, Shop, course, and lesson routes: experience loading/view beacons create analytics/viewer-session records; video playback can also write progress. Their shared shells, content clients, sticky navigation, status copy, and media contrast were reviewed in source.
- `/q/[qrCodeData]` and the legacy `/redeemQR/[campaignID]/[qrcodeID]` redirect: entry posts to session/scan endpoints and can affect scan/redemption state.
- Successful Shopify installation/brand linking and Commerce7 installation/link-confirmation states: require fresh provider installation context or a one-time token, and confirmation changes connections. Only their missing-context/error screens were opened.
- Signup submission, successful email verification/resend, approvals/rejections, reward claims/coupons, and other save/delete/sync/reconcile/export actions were not executed. Their resulting success, transaction, or confirmation states were not exhaustively exercised.
- Data states not present in supplied accounts, including a populated regular-user continue-watching/unlocked-campaign home and a multi-brand-selection requirement. No records were created to manufacture those states.

No application data-changing controls were submitted and no database commands/migrations were run. However, the log audit revealed that existing GET handlers performed automatic database writes during inspection. This means the review did not fully meet the requested no-data-changes constraint:

- Two `CommerceConnectionSecret` updates acquired/released the refresh lock and rotated the encrypted credential payload/expiry.
- One `CommerceConnection` update refreshed status/scopes alongside that token refresh.
- One `UserPointAccount` upsert used the existing on-demand account helper; that helper derives aggregates from the historical ledger. No new `PointTransaction` insert was observed.

No undo or additional database mutation was attempted. The user was informed when the audit identified these side effects. Later visual checks stayed on the already-loaded Commerce7 order screen and theme/navigation controls. Sign-in/sign-out and browser-local theme preferences were exercised normally. Source changes are confined to appearance, theme wiring, responsive header spacing, and current-navigation indicators.

## Validation

- TypeScript typecheck passed.
- ESLint passed for changed TypeScript/TSX files.
- 99 focused UI, rewards, points, logo/navigation, and lesson-playback checks passed.
- Manual Light/Dark switching, browser reload persistence, and System resolving to the current OS theme were checked. Live OS-theme changes were not forced during review.
- Final navigation check: sage sidebar `#dde4d5`, sand top bar `#e7ddca`, hover/active sage `#c8d4bd`; an actual pointer hover changed text/background over 200ms while the menu item stayed exactly 223×32px. Keyboard focus rings and the 288px-wide mobile sage drawer were verified.
- After auditing the order screen’s mount requests as read-only, the final navigation review recorded zero SQL mutation statements. An initial automatic-review block on reload was resolved by inspecting those specific request paths before retrying.
- The existing dark palette was compared in the browser against the new light palette.
- `git diff --check` passed.
- Graphify was updated with AST extraction. Its update reported existing extraction limitations: 11 files yielded no nodes, and 48 SQL files were skipped because `tree_sitter_sql` is not installed. No dependency was installed to change that scope.

Pre-existing Next.js warnings about unawaited dynamic `params.id` appeared while opening campaign products and experience sponsorships; those pages rendered. They are outside this appearance change.
