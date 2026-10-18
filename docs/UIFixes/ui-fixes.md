# UI Fixes

Run date: 2026-10-17. App run locally (`npm run dev`) against the configured Supabase DB. Review was read-only: no forms were submitted, no Redeem/Sync/Disconnect/Generate/Save buttons were clicked, and nothing in the QRCode, User or points tables was touched. Logging in does create auth sessions as normal.

## Enhancements made

### 1. Dashboard navbar stopped being sticky after one viewport
- **Where:** every page under `src/app/(withSidebar)/` (reported on `/dashboard/points`).
- **Cause:** the layout wrapper used `h-screen` (fixed 100vh), so the sticky header's containing block was only one viewport tall and it scrolled away after that.
- **Fix:** `src/app/(withSidebar)/layout.tsx`: `h-screen` -> `min-h-screen`.
- **Verified:** on Points, after scrolling 964px (past one viewport) the header is still at `top: 0`.
- **Also:** the inner `<main>` became a `<div>` (the sidebar inset already renders a `<main>`; nested `<main>` is invalid HTML).

### 2. Whole page overflowed horizontally; tables and buttons were clipped
- **Where:** all sidebar pages. Most visible on Brand > QR Batches (Qty column cut off, Export button clipped).
- **Cause:** the content area was `w-full` next to the 256px sidebar spacer, so it was wider than the space left. Page `scrollWidth` was 1265px in a 1024px viewport.
- **Fix:** `layout.tsx`: `SidebarInset` now uses `min-w-0 w-auto` so it shrinks to the remaining space.
- **Verified:** QR Batches `scrollWidth` is 1009px of 1024px, with no horizontal page scroll.
- **Related fix:** `brand/qr-batches/page.tsx`: the Campaign and Batch filter selects in "QR Code List" now wrap (`sm:flex-wrap`) instead of forcing the page wider.

### 3. Product Sync card broke "DISCONNECTED" mid-word; raw enum shown
- **Where:** `src/app/(withSidebar)/dashboard/page.tsx` (Brand Admin dashboard).
- **Fix:** stat rows use `sm:grid-cols-2 xl:grid-cols-4` (they were 4 columns from `sm`, too narrow beside the sidebar), long status text is `text-base tracking-wide`, and the status is humanized (`NEEDS_ATTENTION` -> "Needs attention", `DISCONNECTED` -> "Disconnected") via `formatStatusLabel`.

### 4. Inconsistent status tiles on Store and Products
- **Where:** `brand/commerce/BrandCommerceClient.tsx` (Provider and Status tiles), `brand/products/BrandProductsClient.tsx` (Connection status tile).
- **Problem:** "Not connected" rendered in `text-2xl`, wrapping onto two lines, next to small-text tiles.
- **Fix:** `text-2xl` -> `text-lg`, so it fits on one line and matches the neighbouring tiles.

### 5. Date picker icons nearly invisible on dark background
- **Where:** Brand Analytics and Creator Analytics date inputs.
- **Fix:** `src/app/globals.css`: `input[type="date"] { color-scheme: dark; }`, so the calendar icon and popup render in dark mode.

### 6. Creator Analytics filters had no labels
- **Where:** `creator/analytics/page.tsx`.
- **Problem:** two identical `mm/dd/yyyy` boxes plus an unlabeled select.
- **Fix:** labelled "Experience", "From", "To" (visible labels, full-width controls).

### 7. Brand Products: sync history pushed the catalog ~9,000px down
- **Where:** `brand/products/BrandProductsClient.tsx`.
- **Fix:** the Sync history list is capped at `max-h-80` and scrolls internally.

### 8. Long experience descriptions filled the cards
- **Where:** Creator > Experiences and Creator > Courses.
- **Fix:** description clamped to 4 lines (`line-clamp-4`). Full text remains in the edit screen.

### 9. Sidebar user block
- **Where:** `components/app-sidebar.tsx`, `components/nav-user.tsx`.
- **Fixes:** while the session loads, the sidebar no longer flashes a fake identity ("SQRATCH / dummyemail@gmail.com"); it shows "Loading…". Truncated names and emails now have tooltips. The text avatar fallback uses real initials instead of a hardcoded "PA". Most users see the default `/P_logo.png` image, so this applies only if an avatar image fails to load.

### 10. Admin sidebar "Analytics" link led to a 404
- **Where:** `src/components/app-sidebar.tsx` (Super Admin nav).
- **Problem:** the link pointed to `/admin/analytics`, which has no page and showed the "Oops, Wrong Turn" 404.
- **Fix:** removed the dead link. No admin analytics page exists in the codebase, so adding one is a separate feature. The Admin Dashboard already shows all-time stats and the per-campaign breakdown.

### 11. Admin Users header cramped at laptop widths
- **Where:** `src/app/(withSidebar)/admin/user-management/page.tsx`.
- **Problem:** the title "Admin Users" wrapped to two lines because the search box and Create User button took the row from `sm` upward.
- **Fix:** the header stacks until `xl` and the title is `text-3xl` below `sm`. This last change is typechecked and linted but was **not re-checked in the browser** (the dev server stopped before I could reload).

### 12. Legacy review and cleanup
- **Live DB (read-only check):** no legacy tables or columns remain. Earlier migrations (`remove_legacy_product_link_snapshots`, `drop_legacy_brand_shopify_columns`, `remove_legacy_user_points`, etc.) already dropped them. The lesson "Related Products" feature runs on the current `CampaignLessonProduct` model and was left untouched.
- **Expired `TokenStore` rows:** deleted 41 expired rows (20 `shopify_oauth_state:*`, 21 `shopify_pending_install:*`; none were active). These keys are **not legacy code**: they are the live Shopify install flow, so no code was removed. Every reader (`oauth/callback`, `installations/[installId]`, `embedded/session`) already treats an expired row as missing, so the delete cannot change behavior. The table is now empty. New installs create fresh rows as before.
- **Wording:** Admin Users subtitle no longer says "legacy table view"; the lessons page says "store products" instead of "Shopify products" (Commerce7 brands use it too).
- **Removed:** the redirect-only stubs `/admin/qr-management`, `/admin/campaigns-management` and `/admin/print-qr` (nothing linked to them), and their rows in `docs/codebase-map.md`. Old bookmarks to them now show the 404 page.

## Screens reviewed

Logged in as: Super Admin (`admin@gmail.com`), Ski Brand Admin, Creator Max, BigHeadWines (Shopify brand admin), Commerce7 Sandbox Brand, Commerce7 Sandbox User.
- Public/auth: home, login, campaign page (`/c/ski-campaign`)
- Common: Dashboard, Points (balance cards and empty states), Profile
- Brand: Brand Profile, Campaigns, QR Batches (+ create form, view only), Store (not connected, Shopify, Commerce7), Products (not connected and Shopify), Rewards, Analytics, Order operations, Shopify Connect
- Super Admin: Admin Dashboard (all-time stats, campaign breakdown), Approvals, Users, Brands, Campaigns. (The old `/admin/qr-management`, `/admin/campaigns-management` and `/admin/print-qr` stubs were removed.)
- Creator: Dashboard, Experiences, Courses, Posts, Q&A, Analytics, Edit Experience, Experience Courses, Course Lessons

## Observed but not changed (suggestions)
- Creator > Course Lessons is about 12,700px tall because every lesson edit form is expanded; collapsible rows (accordion) would help.
- Points page repeats "Current balance" (header pill and first stat card).
- Brand Profile "Cover image" URL input has no label or placeholder.

## Screens NOT reviewed

- **Super Admin tools that create data:** `/generateQR`, Export Reports, Create User, Create Campaign and Approve/Reject actions were not used.
- Accounts not logged into separately: `connor@sqratch.com` (Wine Cinema creator), `commerce7sandboxcreator@sqratch.com`, `shopifyreviewbrand@sqratch.com`, `shopifyreviewcreator@sqratch.com`. Their pages use the same components as those reviewed above, but their specific data states (e.g. Shopify reward redemptions with claimed codes, the Commerce7 creator view) were not seen.
- User pages with data: Points Activity and Shopify Reward Redemptions were only seen in their empty state (the data-bearing layout from your screenshot was not re-checked). Redeem, Copy and Refresh status actions were skipped on purpose.
- `/generateQR` (creates QR codes), brand QR batch creation, reward creation, product sync, Shopify disconnect and all other write actions were skipped.
- Lesson and experience public pages (`/experience/...`), signup, verify-email, approval-pending, support, about and legal pages.
- Mobile/tablet layouts were not tested; the review used a 1024px-wide viewport.
