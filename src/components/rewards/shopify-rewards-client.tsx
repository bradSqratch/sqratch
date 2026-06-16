"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Gift, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  fetchJson,
  getErrorMessage,
  formatRewardMoney,
  formatRewardPercentage,
} from "@/components/experience/client-utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type RewardProduct = {
  id: string;
  shopifyProductGid: string;
  title: string | null;
  imageUrl: string | null;
  productUrl: string | null;
};

type ShopifyRewardOffer = {
  id: string;
  title: string;
  description: string | null;
  brand: {
    id: string;
    name: string;
    logoUrl: string | null;
    shopifyShopDomain?: string | null;
  };
  shopUrl: string | null;
  pointsCost: number;
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountAmountCents: number | null;
  discountPercentageBasisPoints: number | null;
  currencyCode: string;
  claimEndsAt: string | null;
  codeValidDays: number;
  appliesTo: "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS";
  minimumSubtotalCents: number | null;
  products: RewardProduct[];
  userPointsBalance: number;
  eligibility: {
    eligible: boolean;
    hasEnoughPoints: boolean;
    limitReached: boolean;
    userLimitReached: boolean;
  };
  computedAvailability: {
    status:
      | "CLAIMABLE"
      | "INACTIVE"
      | "NOT_STARTED"
      | "CLAIM_WINDOW_ENDED"
      | "LIMIT_REACHED"
      | "USER_LIMIT_REACHED"
      | "SHOPIFY_DISCONNECTED";
    label: string;
    claimable: boolean;
  };
};

type ShopifyRewardRedemption = {
  id: string;
  code: string;
  status: "PENDING" | "POINTS_DEBITED" | "ISSUED" | "USED" | "EXPIRED" | "FAILED" | "REFUNDED" | "CANCELLED";
  brand: {
    id: string;
    name: string;
    logoUrl: string | null;
  };
  offer: {
    id: string;
    title: string;
  };
  issuedAt: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  pointsCost: number;
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountAmountCents: number | null;
  discountPercentageBasisPoints: number | null;
  currencyCode: string;
  shopUrl: string | null;
};

function formatDate(value: string | null, nullLabel = "—"): string {
  if (!value) {
    return nullLabel;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function getIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `reward-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function displayStatus(status: ShopifyRewardRedemption["status"]) {
  if (status === "ISSUED") return "Available";
  if (status === "USED") return "Used";
  if (status === "EXPIRED") return "Expired";
  if (status === "FAILED") return "Failed";
  if (status === "REFUNDED") return "Refunded — points returned";
  if (status === "CANCELLED") return "Cancelled";
  return "Processing";
}

function isUsable(status: ShopifyRewardRedemption["status"]) {
  return status === "ISSUED";
}

export function ShopifyRewardsClient({
  currentPoints,
}: {
  currentPoints: number;
}) {
  const router = useRouter();
  const [offers, setOffers] = useState<ShopifyRewardOffer[]>([]);
  const [redemptions, setRedemptions] = useState<ShopifyRewardRedemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeemingOfferId, setRedeemingOfferId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [issuedCodeByOffer, setIssuedCodeByOffer] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // Stores the idempotency key for in-flight or uncertain redemptions, keyed
  // by offerId. The same key is reused when retrying after a transport error.
  // Cleared on confirmed success or confirmed terminal failure so that a new
  // intentional redemption of the same offer gets a fresh key.
  const pendingKeyByOffer = useRef<Record<string, string>>({});

  const pointsBalance = useMemo(() => {
    return offers[0]?.userPointsBalance ?? currentPoints;
  }, [currentPoints, offers]);

  async function loadRewards() {
    setLoading(true);
    setError(null);

    try {
      const [offerData, redemptionData] = await Promise.all([
        fetchJson<ShopifyRewardOffer[]>("/api/rewards/shopify"),
        fetchJson<ShopifyRewardRedemption[]>("/api/rewards/shopify/redemptions"),
      ]);
      setOffers(offerData);
      setRedemptions(redemptionData);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load Shopify rewards."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRewards();
  }, []);

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    window.setTimeout(() => setCopiedCode(null), 1800);
  }

  async function redeemOffer(offer: ShopifyRewardOffer) {
    setRedeemingOfferId(offer.id);
    setError(null);

    // Reuse an existing pending key for this offer so that retries after
    // transport errors / uncertain responses submit the same key and the server
    // returns the already-committed redemption row instead of creating a new one.
    if (!pendingKeyByOffer.current[offer.id]) {
      pendingKeyByOffer.current[offer.id] = getIdempotencyKey();
    }
    const idempotencyKey = pendingKeyByOffer.current[offer.id];

    try {
      const redemption = await fetchJson<ShopifyRewardRedemption>(
        "/api/rewards/shopify/redeem",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            offerId: offer.id,
            idempotencyKey,
          }),
        },
      );
      // Confirmed success — clear the key so a future redemption of the same
      // offer gets a fresh key (a new intent).
      delete pendingKeyByOffer.current[offer.id];
      setIssuedCodeByOffer((current) => ({
        ...current,
        [offer.id]: redemption.code,
      }));
      router.refresh();
      await loadRewards();
    } catch (redeemError) {
      const message = getErrorMessage(redeemError, "Failed to redeem this reward.");
      // Terminal server-side failures (insufficient points, refunded, etc.) are
      // not retryable with the same intent — clear the key so the next click
      // starts a fresh redemption.
      const terminalPhrases = ["Not enough SQRATCH points", "Points were refunded", "Idempotency key was already used"];
      if (terminalPhrases.some((phrase) => message.includes(phrase))) {
        delete pendingKeyByOffer.current[offer.id];
      }
      setError(message);
    } finally {
      setRedeemingOfferId(null);
    }
  }

  async function refreshRedemption(redemptionId: string) {
    setRefreshingId(redemptionId);
    setError(null);

    try {
      await fetchJson(
        `/api/rewards/shopify/redemptions/${redemptionId}/refresh-status`,
        {
          method: "POST",
        },
      );
      await loadRewards();
    } catch (refreshError) {
      setError(getErrorMessage(refreshError, "Failed to refresh reward status."));
    } finally {
      setRefreshingId(null);
    }
  }

  return (
    <div className="space-y-8">
      <Card className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-white/45">
                Shopify Rewards
              </p>
              <h2 className="mt-2 text-2xl font-semibold">
                Available Shopify Rewards
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">
                Redeem SQRATCH points for single-use Shopify discount codes.
                Copy and paste this code at Shopify checkout.
              </p>
            </div>
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.2em] text-amber-100/65">
                Current points
              </p>
              <p className="text-2xl font-semibold text-amber-100">
                {pointsBalance}
              </p>
            </div>
          </div>

          {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {loading ? (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/55">
                Loading Shopify rewards...
              </div>
            ) : offers.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-5 text-sm text-white/55">
                No Shopify rewards are available right now.
              </div>
            ) : (
              offers.map((offer) => {
                const issuedCode = issuedCodeByOffer[offer.id];
                const primaryProduct = offer.products.find(
                  (product) => product.productUrl,
                );

                return (
                  <div
                    key={offer.id}
                    className="rounded-3xl border border-white/10 bg-black/25 p-5"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm text-white/55">
                          {offer.brand.name}
                        </p>
                        <h3 className="mt-1 text-xl font-semibold">
                          {offer.title}
                        </h3>
                      </div>
                      <Gift className="h-6 w-6 text-amber-300" />
                    </div>

                    {offer.description ? (
                      <p className="mt-3 text-sm leading-6 text-white/60">
                        {offer.description}
                      </p>
                    ) : null}

                    <div className="mt-4 grid gap-3 text-sm text-white/70 sm:grid-cols-2">
                      <p>
                        <span className="text-white/45">Cost:</span>{" "}
                        {offer.pointsCost} points
                      </p>
                      <p>
                        <span className="text-white/45">Discount:</span>{" "}
                        {offer.discountType === "PERCENTAGE"
                          ? formatRewardPercentage(offer.discountPercentageBasisPoints)
                          : formatRewardMoney(offer.discountAmountCents, offer.currencyCode)}
                      </p>
                      <p>
                        <span className="text-white/45">Claim by:</span>{" "}
                        {formatDate(offer.claimEndsAt, "Ongoing")}
                      </p>
                      <p>
                        <span className="text-white/45">Code expires:</span>{" "}
                        {offer.codeValidDays} days after claim
                      </p>
                    </div>

                    <p className="mt-4 text-xs uppercase tracking-[0.18em] text-white/40">
                      {offer.appliesTo === "ALL_PRODUCTS"
                        ? "Applies to all products"
                        : `Applies to ${offer.products.length} selected product${
                            offer.products.length === 1 ? "" : "s"
                          }`}
                    </p>
                    <p className="mt-2 text-xs text-white/45">
                      Single-use code. Anyone with the code can use it once.
                    </p>

                    {issuedCode ? (
                      <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-emerald-100/60">
                          Generated code
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <code className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-lg font-semibold text-white">
                            {issuedCode}
                          </code>
                          <Button
                            type="button"
                            onClick={() => void copyCode(issuedCode)}
                            className="rounded-full border border-white bg-white text-black"
                          >
                            {copiedCode === issuedCode ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                            Copy code
                          </Button>
                        </div>
                        <p className="mt-2 text-sm text-emerald-100/75">
                          Copy and paste this code at Shopify checkout.
                        </p>
                      </div>
                    ) : null}

                    <div className="mt-5 flex flex-wrap gap-3">
                      {offer.computedAvailability.status === "LIMIT_REACHED" ||
                      offer.computedAvailability.status ===
                        "USER_LIMIT_REACHED" ? (
                        <span className="inline-flex items-center rounded-full border border-amber-300/25 bg-amber-300/10 px-4 py-2 text-sm text-amber-100">
                          {offer.computedAvailability.label}
                        </span>
                      ) : (
                        <Button
                          type="button"
                          onClick={() => void redeemOffer(offer)}
                          disabled={
                            !offer.eligibility.eligible ||
                            redeemingOfferId === offer.id
                          }
                          className="rounded-full border border-white bg-white text-black hover:bg-white/90"
                        >
                          {redeemingOfferId === offer.id
                            ? "Redeeming..."
                            : offer.computedAvailability.claimable
                              ? "Redeem"
                              : offer.computedAvailability.label}
                        </Button>
                      )}
                      {(primaryProduct?.productUrl || offer.shopUrl) ? (
                        <a
                          href={primaryProduct?.productUrl || offer.shopUrl || "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-white/75 transition-colors hover:bg-white/10"
                        >
                          <ExternalLink className="h-4 w-4" />
                          Open Shopify
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
        <CardContent className="p-6">
          <h2 className="text-xl font-semibold">Shopify Reward Redemptions</h2>
          <p className="mt-1 text-sm text-white/55">
            Your claimed discount codes and their current Shopify usage status.
          </p>

          <div className="mt-6 space-y-3">
            {loading ? (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/55">
                Loading redemptions...
              </div>
            ) : redemptions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-5 text-sm text-white/55">
                No Shopify reward codes claimed yet.
              </div>
            ) : (
              redemptions.map((redemption) => (
                <div
                  key={redemption.id}
                  className="rounded-2xl border border-white/10 bg-black/20 p-5"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <code className="rounded-xl border border-white/10 bg-white/8 px-3 py-2 text-base font-semibold">
                          {redemption.code}
                        </code>
                        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                          {displayStatus(redemption.status)}
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-white/75">
                        {redemption.offer.title} by {redemption.brand.name}
                      </p>
                      <p className="mt-1 text-sm text-white/50">
                        {redemption.discountType === "PERCENTAGE"
                          ? `${formatRewardPercentage(redemption.discountPercentageBasisPoints)} off`
                          : `${formatRewardMoney(redemption.discountAmountCents, redemption.currencyCode)} off`}{" "}
                        for {redemption.pointsCost} points
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {isUsable(redemption.status) ? (
                        <Button
                          type="button"
                          onClick={() => void copyCode(redemption.code)}
                          className="rounded-full border border-white bg-white text-black"
                        >
                          {copiedCode === redemption.code ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                          Copy
                        </Button>
                      ) : null}
                      {redemption.status === "ISSUED" ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void refreshRedemption(redemption.id)}
                          disabled={refreshingId === redemption.id}
                          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                        >
                          <RefreshCw className="h-4 w-4" />
                          {refreshingId === redemption.id
                            ? "Refreshing..."
                            : "Refresh status"}
                        </Button>
                      ) : null}
                      {redemption.shopUrl && redemption.status === "ISSUED" ? (
                        <a
                          href={redemption.shopUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-white/75 transition-colors hover:bg-white/10"
                        >
                          <ExternalLink className="h-4 w-4" />
                          Open store
                        </a>
                      ) : null}
                    </div>
                  </div>

                  {(redemption.status === "PENDING" || redemption.status === "POINTS_DEBITED") ? (
                    <div className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100/80">
                      This reward is still being processed. If it remains in this state for more
                      than 30 minutes, please contact support — your points will not be lost.
                    </div>
                  ) : null}
                  {redemption.status === "FAILED" ? (
                    <div className="mt-3 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200/80">
                      Reward generation failed. Your points should be returned automatically. If
                      your balance has not been restored within a few minutes, contact support.
                    </div>
                  ) : null}

                  <div className="mt-4 grid gap-2 text-xs text-white/45 sm:grid-cols-3">
                    <p>Issued: {formatDate(redemption.issuedAt, "—")}</p>
                    <p>Expiry: {formatDate(redemption.expiresAt, "No expiry")}</p>
                    <p>
                      Used:{" "}
                      {redemption.usedAt ? formatDate(redemption.usedAt) : "Not used"}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
