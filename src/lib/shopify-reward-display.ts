import type { RewardOfferAvailabilityStatus } from "@/lib/reward-offers";

export type ShopifyRewardDisabledReason =
  | "NOT_ENOUGH_POINTS"
  | "LIMIT_REACHED"
  | "USER_LIMIT_REACHED"
  | "CLAIM_WINDOW_ENDED"
  | "SHOPIFY_DISCONNECTED"
  | null;

type RewardAvailability = {
  status: RewardOfferAvailabilityStatus;
  label: string;
  claimable: boolean;
};

function getAvailabilityDisabledReason(
  availability: RewardAvailability,
): ShopifyRewardDisabledReason {
  switch (availability.status) {
    case "LIMIT_REACHED":
      return "LIMIT_REACHED";
    case "USER_LIMIT_REACHED":
      return "USER_LIMIT_REACHED";
    case "SHOPIFY_DISCONNECTED":
      return "SHOPIFY_DISCONNECTED";
    case "INACTIVE":
    case "NOT_STARTED":
    case "CLAIM_WINDOW_ENDED":
      // The public rewards query normally filters these states out. Keep the
      // response safe if an offer changes between its query and evaluation.
      return "CLAIM_WINDOW_ENDED";
    case "CLAIMABLE":
      return null;
  }
}

export function getShopifyRewardDisplayState(input: {
  userPointsBalance: number;
  pointsCost: number;
  availability: RewardAvailability;
}) {
  const pointsShortfall = Math.max(
    0,
    input.pointsCost - input.userPointsBalance,
  );
  const availabilityDisabledReason = getAvailabilityDisabledReason(
    input.availability,
  );
  const disabledReason =
    availabilityDisabledReason ??
    (pointsShortfall > 0 ? "NOT_ENOUGH_POINTS" : null);
  const canRedeem = disabledReason === null;

  return {
    canView: true as const,
    canRedeem,
    disabledReason,
    displayLabel: canRedeem
      ? "Redeem"
      : disabledReason === "NOT_ENOUGH_POINTS"
        ? "Not enough points"
        : input.availability.label,
    pointsShortfall,
  };
}
