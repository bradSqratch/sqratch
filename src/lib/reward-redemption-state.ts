/**
 * Formal state machine for CommerceRewardRedemption.
 * Pure module — no DB access. Single source of truth for all status logic.
 */

import { CommerceRewardRedemptionStatus } from "@prisma/client";

// Re-export the enum for convenience.
export { CommerceRewardRedemptionStatus };

/** All 8 redemption statuses. */
export const REDEMPTION_STATUSES = [
  CommerceRewardRedemptionStatus.PENDING,
  CommerceRewardRedemptionStatus.POINTS_DEBITED,
  CommerceRewardRedemptionStatus.ISSUED,
  CommerceRewardRedemptionStatus.USED,
  CommerceRewardRedemptionStatus.EXPIRED,
  CommerceRewardRedemptionStatus.FAILED,
  CommerceRewardRedemptionStatus.REFUNDED,
  CommerceRewardRedemptionStatus.CANCELLED,
] as const;

type Status = CommerceRewardRedemptionStatus;

/**
 * Valid forward transitions.
 * Same-status transitions (idempotent no-ops) are NOT listed here —
 * they are handled separately in isValidTransition / assertTransition.
 */
export const ALLOWED_TRANSITIONS: Record<Status, Status[]> = {
  [CommerceRewardRedemptionStatus.PENDING]: [
    CommerceRewardRedemptionStatus.POINTS_DEBITED,
    CommerceRewardRedemptionStatus.FAILED,
    CommerceRewardRedemptionStatus.CANCELLED,
  ],
  [CommerceRewardRedemptionStatus.POINTS_DEBITED]: [
    CommerceRewardRedemptionStatus.ISSUED,
    CommerceRewardRedemptionStatus.REFUNDED,
    CommerceRewardRedemptionStatus.FAILED,
  ],
  [CommerceRewardRedemptionStatus.ISSUED]: [
    CommerceRewardRedemptionStatus.USED,
    CommerceRewardRedemptionStatus.EXPIRED,
  ],
  [CommerceRewardRedemptionStatus.USED]: [],
  [CommerceRewardRedemptionStatus.EXPIRED]: [],
  [CommerceRewardRedemptionStatus.REFUNDED]: [],
  [CommerceRewardRedemptionStatus.FAILED]: [],
  [CommerceRewardRedemptionStatus.CANCELLED]: [],
};

/**
 * Statuses from which no further progression is possible.
 */
export const TERMINAL_STATUSES: Status[] = [
  CommerceRewardRedemptionStatus.USED,
  CommerceRewardRedemptionStatus.EXPIRED,
  CommerceRewardRedemptionStatus.REFUNDED,
  CommerceRewardRedemptionStatus.FAILED,
  CommerceRewardRedemptionStatus.CANCELLED,
];

/**
 * Statuses that count toward total / per-user claim limits.
 * This is the single source of truth — reward-offers.ts re-exports it.
 */
export const CLAIM_COUNTED_REDEMPTION_STATUSES: Status[] = [
  CommerceRewardRedemptionStatus.PENDING,
  CommerceRewardRedemptionStatus.POINTS_DEBITED,
  CommerceRewardRedemptionStatus.ISSUED,
  CommerceRewardRedemptionStatus.USED,
  CommerceRewardRedemptionStatus.EXPIRED,
];

/**
 * Only ISSUED redemptions may be advanced by a Shopify status refresh.
 */
export const REFRESH_ELIGIBLE_STATUSES: Status[] = [
  CommerceRewardRedemptionStatus.ISSUED,
];

/**
 * POINTS_DEBITED redemptions are eligible for reconciliation by a later batch job.
 */
export const RECONCILIATION_ELIGIBLE_STATUSES: Status[] = [
  CommerceRewardRedemptionStatus.POINTS_DEBITED,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if `s` is a terminal status (no further transitions possible). */
export function isTerminal(s: Status): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** Returns true if the redemption is eligible for a Shopify status refresh. */
export function canRefresh(s: Status): boolean {
  return REFRESH_ELIGIBLE_STATUSES.includes(s);
}

/** Returns true if the redemption status counts toward claim limits. */
export function countsTowardLimit(s: Status): boolean {
  return CLAIM_COUNTED_REDEMPTION_STATUSES.includes(s);
}

/**
 * Returns true if the transition from `from` to `to` is valid.
 * Same-status transitions are treated as idempotent no-ops and return true.
 */
export function isValidTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Asserts that the transition from `from` to `to` is valid.
 * Throws an Error with a clear message on invalid transitions.
 * Same-status transitions are treated as idempotent no-ops (no throw).
 */
export function assertTransition(from: Status, to: Status): void {
  if (isValidTransition(from, to)) return;
  throw new Error(
    `Invalid redemption state transition: ${from} → ${to}. ` +
      `Allowed transitions from ${from}: [${ALLOWED_TRANSITIONS[from].join(", ") || "none"}].`,
  );
}
