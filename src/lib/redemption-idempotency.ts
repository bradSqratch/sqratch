/**
 * Pure helper for idempotency-key matching on Shopify reward redemptions.
 *
 * NOTE: The redemption row stores offerId as the authoritative binding identity.
 * Experience slug and campaign ID are request-time routing context that is NOT
 * persisted on the redemption row, so offerId is the only field we can use to
 * confirm that a re-presented idempotency key is for the same redemption intent.
 */

export type IdempotencyMatchResult =
  | "MATCH"
  | "USER_MISMATCH"
  | "OFFER_MISMATCH";

/**
 * Compare an existing redemption row against the incoming request to decide
 * whether the key can safely be reused.
 *
 * - MATCH         → same user AND same offer; return the cached redemption.
 * - USER_MISMATCH → different user; the key is in use by someone else (409).
 * - OFFER_MISMATCH → same user but different offer; the key was already
 *                    consumed for a different reward intent (409).
 */
export function idempotencyMatch(
  existing: { userId: string; offerId: string },
  request: { userId: string; offerId: string },
): IdempotencyMatchResult {
  if (existing.userId !== request.userId) {
    return "USER_MISMATCH";
  }
  if (existing.offerId !== request.offerId) {
    return "OFFER_MISMATCH";
  }
  return "MATCH";
}
