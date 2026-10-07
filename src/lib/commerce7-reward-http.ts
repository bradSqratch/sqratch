import { NextResponse } from "next/server";
import { RewardClaimError } from "./commerce7-reward-domain";
import { Commerce7RewardError } from "./commerce/providers/commerce7-rewards-client";
export function rewardErrorResponse(error: unknown) {
  if (error instanceof RewardClaimError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof Commerce7RewardError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "SETUP_INCOMPLETE" ? 409 : 502 });
  // Never return/log raw provider errors or database exception details.
  return NextResponse.json({ error: "Reward processing failed. Please retry or contact the store.", code: "REWARD_PROCESSING_FAILED" }, { status: 500 });
}
