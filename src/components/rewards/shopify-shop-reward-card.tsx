"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Gift } from "lucide-react";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import {
  formatRewardMoney,
  formatRewardPercentage,
} from "@/lib/reward-formatting";
import { Button } from "@/components/ui/button";

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
  pointsCost: number;
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountAmountCents: number | null;
  discountPercentageBasisPoints: number | null;
  currencyCode: string;
  claimEndsAt: string | null;
  codeValidDays: number;
  appliesTo: "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS";
  products: RewardProduct[];
  userPointsBalance: number;
  canView: true;
  canRedeem: boolean;
  disabledReason:
    | "NOT_ENOUGH_POINTS"
    | "LIMIT_REACHED"
    | "USER_LIMIT_REACHED"
    | "CLAIM_WINDOW_ENDED"
    | "SHOPIFY_DISCONNECTED"
    | null;
  displayLabel: string;
  pointsShortfall: number;
};

type ShopifyRewardRedemption = {
  id: string;
  code: string;
  status: string;
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

  return `shop-reward-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ShopifyShopRewardCard({
  experienceSlug,
}: {
  experienceSlug: string;
}) {
  const [offers, setOffers] = useState<ShopifyRewardOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeemingOfferId, setRedeemingOfferId] = useState<string | null>(null);
  const [issuedCodeByOffer, setIssuedCodeByOffer] = useState<Record<string, string>>({});
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  // Stores the idempotency key for in-flight or uncertain redemptions, keyed
  // by offerId. The same key is reused when retrying after a transport error.
  // Cleared on confirmed success or confirmed terminal failure so that a new
  // intentional redemption of the same offer gets a fresh key.
  const pendingKeyByOffer = useRef<Record<string, string>>({});

  const pointsBalance = offers[0]?.userPointsBalance ?? 0;

  useEffect(() => {
    async function loadRewards() {
      setLoading(true);
      setError(null);
      setHidden(false);

      try {
        const data = await fetchJson<ShopifyRewardOffer[]>(
          `/api/rewards/shopify?experienceSlug=${encodeURIComponent(
            experienceSlug,
          )}`,
        );
        setOffers(data);
      } catch (loadError) {
        const message = getErrorMessage(loadError, "Failed to load rewards.");

        if (message.toLowerCase().includes("unauthorized")) {
          setHidden(true);
        } else {
          setError(message);
        }
      } finally {
        setLoading(false);
      }
    }

    void loadRewards();
  }, [experienceSlug]);

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
            experienceSlug,
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

      const data = await fetchJson<ShopifyRewardOffer[]>(
        `/api/rewards/shopify?experienceSlug=${encodeURIComponent(
          experienceSlug,
        )}`,
      );
      setOffers(data);
    } catch (redeemError) {
      const message = getErrorMessage(redeemError, "Failed to redeem this reward.");
      // Terminal server-side failures are not retryable with the same intent —
      // clear the key so the next click starts a fresh redemption.
      const terminalPhrases = ["Not enough SQRATCH points", "Points were refunded", "Idempotency key was already used"];
      if (terminalPhrases.some((phrase) => message.includes(phrase))) {
        delete pendingKeyByOffer.current[offer.id];
      }
      setError(message);
    } finally {
      setRedeemingOfferId(null);
    }
  }

  if (hidden || loading || offers.length === 0) {
    return null;
  }

  return (
    <div className="rounded-3xl border border-amber-300/20 bg-[linear-gradient(135deg,rgba(251,191,36,0.14),rgba(199,52,132,0.12),rgba(0,0,0,0.25))] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.28)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-amber-100">
            <Gift className="h-5 w-5" />
            <p className="text-sm uppercase tracking-[0.2em]">SQRATCH Reward</p>
          </div>
          <h2 className="mt-2 text-2xl font-semibold text-white">
            You have {pointsBalance} points
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">
            Claim a single-use Shopify discount code for this brand. Copy and
            paste this code at Shopify checkout.
          </p>
        </div>

        {error ? <p className="text-sm text-red-200">{error}</p> : null}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {offers.map((offer) => {
          const issuedCode = issuedCodeByOffer[offer.id];
          const isMuted = !offer.canRedeem && !issuedCode;
          const disabledDescriptionId = `reward-${offer.id}-disabled-reason`;

          return (
            <div
              key={offer.id}
              className={`rounded-2xl border p-4 ${
                isMuted
                  ? "border-white/5 bg-black/15 opacity-70"
                  : "border-white/10 bg-black/25"
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-white">
                    {offer.title}
                  </h3>
                  <p className="mt-1 text-sm text-white/55">
                    {offer.pointsCost} points for{" "}
                    {offer.discountType === "PERCENTAGE"
                      ? `${formatRewardPercentage(offer.discountPercentageBasisPoints)} off`
                      : `${formatRewardMoney(offer.discountAmountCents, offer.currencyCode)} off`}
                  </p>
                </div>
                <span
                  className={`rounded-full border px-3 py-1 text-xs ${
                    offer.canRedeem
                      ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
                      : "border-white/15 bg-white/5 text-white/65"
                  }`}
                >
                  {offer.canRedeem ? "Claimable" : offer.displayLabel}
                </span>
              </div>

              {offer.disabledReason === "NOT_ENOUGH_POINTS" ? (
                <p
                  id={disabledDescriptionId}
                  className="mt-3 text-sm leading-6 text-white/70"
                >
                  You have {offer.userPointsBalance} points and this reward
                  requires {offer.pointsCost} points. You need {offer.pointsShortfall}{" "}
                  more points to redeem this reward.
                </p>
              ) : isMuted ? (
                <p
                  id={disabledDescriptionId}
                  className="mt-3 text-sm leading-6 text-white/65"
                >
                  This reward is currently unavailable: {offer.displayLabel}.
                </p>
              ) : null}

              <div className="mt-4 grid gap-2 text-sm text-white/65 sm:grid-cols-2">
                <p>
                  <span className="text-white/40">Claim by:</span>{" "}
                  {formatDate(offer.claimEndsAt, "Ongoing")}
                </p>
                <p>
                  <span className="text-white/40">Code expires:</span>{" "}
                  {offer.codeValidDays} days after claim
                </p>
              </div>

              {offer.appliesTo === "SPECIFIC_PRODUCTS" ? (
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                    Applies to
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {offer.products.map((product) => (
                      <span
                        key={product.shopifyProductGid}
                        className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65"
                      >
                        {product.title || product.shopifyProductGid}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-xs uppercase tracking-[0.18em] text-white/35">
                  Applies to all products
                </p>
              )}

              <p className="mt-3 text-xs text-white/45">
                Single-use code. Anyone with the code can use it once.
              </p>

              {issuedCode ? (
                <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-emerald-100/60">
                    Generated code
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-semibold text-white">
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
                      Copy
                    </Button>
                  </div>
                  <p className="mt-2 text-sm text-emerald-100/75">
                    Copy and paste this code at Shopify checkout.
                  </p>
                </div>
              ) : null}

              <div className="mt-4">
                <Button
                  type="button"
                  onClick={() => void redeemOffer(offer)}
                  disabled={
                    !offer.canRedeem || redeemingOfferId === offer.id
                  }
                  aria-describedby={
                    !offer.canRedeem ? disabledDescriptionId : undefined
                  }
                  className="rounded-full border border-white bg-white text-black hover:bg-white/90"
                >
                  {redeemingOfferId === offer.id
                    ? "Redeeming..."
                    : offer.displayLabel}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
