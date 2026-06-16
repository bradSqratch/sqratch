# Points Ledger Invariants

- `User.points` is a denormalized balance; `PointTransaction` is the immutable audit ledger.
- Every balance mutation and ledger row must occur in the same database transaction.
- Reward debit uses a conditional update so balances cannot become negative.
- Reward debit/refund reasons are `SHOPIFY_REWARD_REDEMPTION` and `SHOPIFY_REWARD_REFUND`.
- `(shopifyRewardRedemptionId, reason)` is unique after the reconciliation migration, making refunds exactly once.
- QR awards retain their existing `(userId, qrCodeId)` idempotency constraint.
- Never delete ledger rows to repair a balance. Add an explicit compensating transaction.

Reconciliation handles rows stuck in `POINTS_DEBITED` in bounded batches. It either confirms the Shopify discount, refunds once when absence is definitive, or retains the row for retry/manual review when Shopify status is ambiguous.
