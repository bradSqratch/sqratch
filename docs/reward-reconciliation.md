# Reward Reconciliation and Incident Guide

Call `POST /api/internal/reconcile-redemptions` with `x-cron-secret`. The worker is idempotent, selects a bounded batch, claims rows with compare-and-swap locking, and logs counts without codes or tokens. Supabase Cron is manually managed outside this repository and invokes it every 10 minutes.

Investigate `POINTS_DEBITED` rows older than five minutes and rows marked `needsManualReview`. Confirm Shopify connectivity and discount presence before manual action. Do not directly edit points. If a discount definitely does not exist, use the existing exactly-once refund path.

Token refresh is per Brand. A unique refresh lease prevents stale responses or stale invalid-grant failures from overwriting a newer rotated token. `REQUIRES_RECONNECT` should trigger merchant reconnection, not manual token insertion.
