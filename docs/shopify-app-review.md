# Shopify App Review Checklist

- App URL and callback use `https://www.sqratch.com`.
- Embedded launch obtains and verifies an App Bridge session token before token exchange.
- Requested scopes are exactly `read_products,read_orders,read_themes,read_discounts,write_discounts`; `read_all_orders` and `write_themes` are not requested.
- `read_orders` is a Shopify **protected customer data** scope: the Partner Dashboard protected-customer-data request must be approved for the app, and the declared data-use answers must match what the privacy policy says (`src/content/legal/privacy.ts`, "Shopify Order and Conversion Information"). SQRATCH receives order payloads that can carry customer fields but reads/stores none of them — see `SHOPIFY_ORDER_PII_KEYS` in `src/lib/commerce/providers/shopify-order-normalizer.ts`, which `tests/shopify-order-normalizer.test.ts` asserts mechanically.
- Webhooks are TOML-managed; all routes verify raw-body HMAC.
- Uninstall clears active credentials while preserving non-sensitive history.
- **Use the preapproved Brand Admin review account supplied in the Partner Dashboard review notes.** A brand-new normal SQRATCH signup (`USER` role) cannot link Shopify — see "Shopify authorization requirements" below.
- `/privacy`, `/terms`, `/support`, and support email are public.
- Provide reviewer credentials through Partner Dashboard review notes, never source control.

Custom app regression: select `shopify.app.custom.toml`, verify `LEGACY_OFFLINE`, product fetch, discounts, disconnect, and reinstall independently from the public app credentials.

## Shopify authorization requirements

Connecting a Shopify store to SQRATCH requires an eligible **Brand Admin**
account — see [Brand-management authorization policy](agent-context.md#brand-management-authorization-policy)
for the full eligibility rule. In short:

- A normal `USER` or `CREATOR` SQRATCH account can never link Shopify, even if
  the review environment has a stray Brand membership row for that account.
- Brand approval happens **outside** the installation flow, through the
  normal SQRATCH approval/admin workflow. The installation flow itself never
  creates a Brand — the reviewer selects an existing eligible Brand from the
  accounts the review credentials already have access to.
- A global `ADMIN` account may act on any active Brand but must explicitly
  select which Brand it is connecting — SQRATCH never silently picks one on
  the administrator's behalf.

### What the reviewer sees with the wrong account

If the review account is logged in as a `USER` or `CREATOR` when it reaches
the Shopify connection page, SQRATCH shows an explicit "Brand Admin access
required" screen inside the normal app shell (not a blank page, redirect
loop, or generic error) with:

- **Switch SQRATCH account** — signs out of the current SQRATCH session only
  (the Shopify App Bridge / Shopify Admin session is untouched), returns to
  SQRATCH login, and after logging in with an eligible Brand Admin account
  returns to the exact same Shopify installation URL so the connection can
  continue.
- **Return to Shopify Admin** / **Return to dashboard** as secondary options.

Reaching this screen does not consume or invalidate the pending Shopify
installation — it remains available (encrypted, short-lived, single-use) so
switching to the correct account and returning to the same URL completes the
original connection.
