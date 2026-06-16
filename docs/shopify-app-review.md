# Shopify App Review Checklist

- App URL and callback use `https://www.sqratch.com`.
- Embedded launch obtains and verifies an App Bridge session token before token exchange.
- Requested scopes are exactly `read_products,read_discounts,write_discounts`.
- Webhooks are TOML-managed; all routes verify raw-body HMAC.
- Uninstall clears active credentials while preserving non-sensitive history.
- Reviewer can install, authenticate or create a SQRATCH account, select/create a Brand, view products, create a reward, redeem points, copy a single-use code, disconnect, and reinstall.
- `/privacy`, `/terms`, `/support`, and support email are public.
- Provide reviewer credentials through Partner Dashboard review notes, never source control.

Custom app regression: select `shopify.app.custom.toml`, verify `LEGACY_OFFLINE`, product fetch, discounts, disconnect, and reinstall independently from the public app credentials.
