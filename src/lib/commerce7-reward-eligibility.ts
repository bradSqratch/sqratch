export type Commerce7RewardEligibility = "ANYONE_WITH_CODE" | "CLAIMANT_ONLY";

/** Deployed offers and claims without a mode retain their customer binding.
 * Unknown explicit modes fail closed; exclusive access always stays bound. */
export function storedCommerce7Eligibility(config: unknown, rewardMode?: string): Commerce7RewardEligibility | null {
  if (rewardMode === "EXCLUSIVE_PRODUCT_ACCESS") return "CLAIMANT_ONLY";
  if (!config || typeof config !== "object" || Array.isArray(config)) return "CLAIMANT_ONLY";
  const mode = (config as Record<string, unknown>).eligibilityMode;
  if (mode === undefined) return "CLAIMANT_ONLY";
  return mode === "ANYONE_WITH_CODE" || mode === "CLAIMANT_ONLY" ? mode : null;
}
