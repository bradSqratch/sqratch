/**
 * Shared validation for creator-configured completion reward points.
 *
 * Rewards are integers, minimum 0, maximum 1000 (0 = no reward). Values are
 * server-validated; never trust a client-supplied points amount when awarding.
 */

export const MAX_COMPLETION_POINTS_REWARD = 1000;

export type ParseRewardPointsResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function parseRewardPoints(
  value: unknown,
  fieldName: string,
): ParseRewardPointsResult {
  const numberValue = Number(value ?? 0);
  if (
    !Number.isInteger(numberValue) ||
    numberValue < 0 ||
    numberValue > MAX_COMPLETION_POINTS_REWARD
  ) {
    return {
      ok: false,
      error: `${fieldName} must be an integer between 0 and ${MAX_COMPLETION_POINTS_REWARD}.`,
    };
  }
  return { ok: true, value: numberValue };
}
