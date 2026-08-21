import { NextRequest, NextResponse } from "next/server";
import {
  CommerceProvider,
  Prisma,
  type RewardAppliesTo,
  type CommerceRewardRedemption,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";
import {
  debitShopifyRewardPoints,
  getUserSpendablePointBalance,
  refundShopifyRewardPoints,
} from "@/lib/points";
import { getRewardClaimContext } from "@/lib/reward-access";
import { createShopifyRewardDiscountCode } from "@/lib/shopify-discounts";
import { getValidAccessToken } from "@/lib/shopify-token-manager";
import {
  CLAIM_COUNTED_REDEMPTION_STATUSES,
  generateRewardCode,
  getRewardOfferAvailability,
} from "@/lib/reward-offers";
import {
  computeShopifyRewardCompatibility,
  type ShopifyRewardCompatibilityReason,
} from "@/lib/shopify-reward-compatibility";
import { idempotencyMatch } from "@/lib/redemption-idempotency";
import {
  getActiveCommerceConnection,
  isConnectionUsable,
  resolveCommerceConnectionSummaryWithClient,
} from "@/lib/commerce/connection-service";
import { normalizeExternalAccountId } from "@/lib/commerce/connection-sync";
import { defaultCommerceAdapterRegistry } from "@/lib/commerce/default-registry";
import {
  CommerceConnectionNotFoundError,
  CommerceProviderApiError,
  UnsupportedCapabilityError,
  UnsupportedProviderError,
} from "@/lib/commerce/errors";
import type { CommerceAdapterRegistry } from "@/lib/commerce/registry";
import type { CommerceConnectionSummary, CreateDiscountInput } from "@/lib/commerce/types";

// ---------------------------------------------------------------------------
// Commerce cutover: discount issuance routes through the provider-neutral
// CommerceAdapter when a real CommerceConnection.id is available, and falls
// back to the legacy direct `createShopifyRewardDiscountCode` call otherwise
// (`summary.id === null`). See `issueDiscountViaAdapter` below for the
// error-mapping contract that keeps both paths byte-identical.
// ---------------------------------------------------------------------------

/**
 * Injectable seam for the commerce-connection lookup + adapter registry —
 * the ONLY part of this route's dependencies that changed for the cutover.
 * Every other dependency (session, prisma, points, token resolution) is
 * untouched. Defaults to the real provider-neutral service; tests override
 * both fields to exercise the adapter path without a DB or network.
 */
export type ShopifyRewardRedeemCommerceDeps = {
  getConnectionSummary(brandId: string): Promise<CommerceConnectionSummary | null>;
  /** Adapter registry used for provider selection — never hard-coded. */
  registry: CommerceAdapterRegistry;
};

const DEFAULT_COMMERCE_DEPS: ShopifyRewardRedeemCommerceDeps = {
  getConnectionSummary: (brandId) =>
    getActiveCommerceConnection(brandId, CommerceProvider.SHOPIFY),
  registry: defaultCommerceAdapterRegistry,
};

/**
 * The exact shape `createShopifyRewardDiscountCode` returns (see
 * `src/lib/shopify-discounts.ts`), widened just enough that BOTH the legacy
 * direct-call result and the adapter-derived result can be assigned to it
 * without re-shaping the legacy call site at all. Everything downstream
 * (persisted-field mapping, response status) reads only this shape, so it
 * cannot see which path produced it.
 */
export type DiscountCreationOutcome =
  | {
      ok: true;
      discountNodeId: string;
      startsAt: Date;
      endsAt: Date | null;
      userErrors: Prisma.InputJsonValue[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      userErrors?: Prisma.InputJsonValue[];
    };

/**
 * Narrows `CommerceProviderApiError.details` (deliberately `unknown` — see
 * `../errors.ts`, kept provider-neutral) to the JSON-serializable array
 * shape the `providerErrorDetails` Json column accepts. The only producer of
 * this field today (`ShopifyCommerceAdapter.createDiscount`) always passes
 * through `createShopifyRewardDiscountCode`'s own `userErrors` array —
 * itself always plain `{field, message, code}` objects, see
 * `shopify-discounts.ts` — so a shape check beyond `Array.isArray` is
 * unnecessary. A type guard, not a cast: nothing here uses `as`.
 */
function isJsonUserErrorArray(value: unknown): value is Prisma.InputJsonValue[] {
  return Array.isArray(value);
}

/**
 * Builds the neutral `CreateDiscountInput` from the same `discountConfig` /
 * `code` / `issuedAt` values the legacy direct call uses — kept as its own
 * function so both the route and tests construct it identically.
 */
export function buildCreateDiscountInput(
  discountConfig: {
    brandName: string;
    title: string;
    codeValidDays: number;
    discountType: "FIXED_AMOUNT" | "PERCENTAGE";
    discountAmountCents: number | null;
    discountPercentageBasisPoints: number | null;
    appliesTo: RewardAppliesTo;
    externalProductIds: string[];
    minimumSubtotalCents: number | null;
  },
  code: string,
  issuedAt: Date,
): CreateDiscountInput {
  return {
    code,
    title: `${discountConfig.brandName} - ${discountConfig.title}`,
    issuedAt,
    validDays: discountConfig.codeValidDays,
    discountType: discountConfig.discountType,
    discountAmountCents: discountConfig.discountAmountCents,
    discountPercentageBasisPoints: discountConfig.discountPercentageBasisPoints,
    appliesTo: discountConfig.appliesTo,
    externalProductIds: discountConfig.externalProductIds,
    minimumSubtotalCents: discountConfig.minimumSubtotalCents,
  };
}

/**
 * Issues the discount via the provider-neutral adapter, then maps the
 * result (or a thrown typed error) back onto EXACTLY the
 * `DiscountCreationOutcome` shape `createShopifyRewardDiscountCode` itself
 * would have produced for the same real Shopify outcome — see the
 * per-branch comments below for the field-by-field justification.
 *
 * `preResolvedAccessToken` MUST already be resolved by the caller (via
 * `getValidAccessToken`, exactly as the legacy path does) — this function
 * never resolves its own token, so a request never triggers two independent
 * token resolutions (see `CreateDiscountOptions` in `../types.ts`).
 */
export async function issueDiscountViaAdapter(
  registry: CommerceAdapterRegistry,
  connectionId: string,
  provider: CommerceProvider,
  preResolvedAccessToken: string,
  input: CreateDiscountInput,
): Promise<DiscountCreationOutcome> {
  try {
    // Provider selection ALWAYS goes through the registry — never a
    // hard-coded `new ShopifyCommerceAdapter()`.
    const adapter = registry.get(provider);
    const capabilities = adapter.getCapabilities();

    if (!capabilities.canCreateDiscount || !adapter.createDiscount) {
      throw new UnsupportedCapabilityError(provider, "createDiscount");
    }

    const result = await adapter.createDiscount(connectionId, input, {
      preResolvedAccessToken,
    });

    return {
      ok: true,
      discountNodeId: result.externalDiscountId,
      // Shopify's create mutation always echoes back the exact `startsAt`
      // it was given (verified in `src/lib/shopify-discounts.ts`:
      // `node.codeDiscount?.startsAt ? new Date(...) : startsAt` — the
      // fallback is the same `startsAt` we sent, and the echoed value
      // round-trips to the identical instant). `input.issuedAt` is that
      // same value, so this is the same moment the legacy path persists via
      // `discount.startsAt` — `ProviderDiscount` deliberately carries no
      // separate field for it (see `../types.ts`) because nothing needs one
      // beyond what the caller already knows.
      startsAt: input.issuedAt,
      endsAt: result.expiresAt,
      // `createShopifyRewardDiscountCode` only returns `ok:true` when its
      // own `userErrors` array is empty (see shopify-discounts.ts) —
      // deterministically `[]` on every success, matching the legacy path
      // byte-for-byte.
      userErrors: [],
    };
  } catch (error) {
    if (error instanceof CommerceProviderApiError) {
      // `httpStatus` / `details` are threaded through by
      // ShopifyCommerceAdapter.createDiscount from
      // createShopifyRewardDiscountCode's own `status` / `userErrors` — the
      // exact values the direct-call path would have produced for the same
      // failure.
      return {
        ok: false,
        status: error.httpStatus || 502,
        error: error.message,
        userErrors: isJsonUserErrorArray(error.details) ? error.details : undefined,
      };
    }
    if (
      error instanceof CommerceConnectionNotFoundError ||
      error instanceof UnsupportedCapabilityError ||
      // UnsupportedProviderError has no legacy-path equivalent (this route's
      // upstream connectivity gate only ever reaches here for Shopify), but
      // this is a MONEY PATH with points already debited — catching it here
      // too (rather than letting it fall through to the route's generic
      // outer 500) guarantees the refund still runs. Purely defensive: it
      // cannot occur today given that gate.
      error instanceof UnsupportedProviderError
    ) {
      return { ok: false, status: 502, error: error.message };
    }
    throw error;
  }
}

/**
 * Fail-safe wrapper around `commerceDeps.getConnectionSummary` — matches the
 * `safe*` wrapper idiom in `src/lib/commerce/connection-sync.ts` (catch and
 * sanitized-log every failure, NEVER throw into the caller). ANY error
 * resolving it falls back to `null`, which the caller already treats as "no
 * usable CommerceConnection.id — use the legacy direct
 * `createShopifyRewardDiscountCode` path" (see `summary.id === null` below)
 * with `discountConfig.shopDomain`/`tokenResult.accessToken`, both of which
 * are ALREADY canonically resolved by the time this is consulted (the
 * former inside the reservation transaction, the latter via
 * `getValidAccessToken`) — so a failure here degrades to a different but
 * still fully canonical code path, never to a legacy `Brand` read. Called
 * OUTSIDE the Serializable reservation transaction (same as the unwrapped
 * call was) so a slow or failing lookup can never lengthen or interfere
 * with it.
 */
async function safeGetCommerceConnectionSummary(
  getConnectionSummary: ShopifyRewardRedeemCommerceDeps["getConnectionSummary"],
  brandId: string,
): Promise<CommerceConnectionSummary | null> {
  try {
    return await getConnectionSummary(brandId);
  } catch {
    // Sanitized: brandId + a fixed outcome tag only, never the caught error
    // object's message (defense in depth — nothing here is expected to
    // carry a credential, but this matches the caution the connection-sync
    // `safe*` wrappers already apply to mirror-table failures).
    console.error("[rewards/shopify/redeem][commerce-mirror]", {
      outcome: "connection_summary_lookup_failed",
      brandId,
    });
    return null;
  }
}

/**
 * PHASE 14C-A: CANONICAL CONNECTION GATE, FAIL-CLOSED. Every currently
 * installed Shopify merchant already has a canonical `CommerceConnection` +
 * `CommerceConnectionSecret` (operator-verified live DB evidence) — there is
 * no legitimate legacy source of truth left to fall back to. A failure to
 * resolve the canonical connection is therefore treated as NOT CONNECTED,
 * the same as a genuine disconnection, rather than rescued by a `Brand`
 * read: on a money-adjacent gate, "unknown" must never be upgraded to
 * "assume connected, proceed" once `Brand` is no longer an independent
 * source of truth (that would be the fail-OPEN direction). This replaces
 * the Phase 14B.4B "Priority-1" legacy-fallback behavior — see
 * tests/shopify-reward-adapter-cutover.test.ts's updated "mirror outage"
 * test for the new contract.
 */
async function resolveGateConnectionSummary(
  getConnectionSummary: ShopifyRewardRedeemCommerceDeps["getConnectionSummary"],
  brandId: string,
): Promise<CommerceConnectionSummary | null> {
  try {
    return await getConnectionSummary(brandId);
  } catch {
    console.error("[rewards/shopify/redeem][commerce-gate]", {
      outcome: "connection_summary_lookup_failed_fail_closed",
      brandId,
    });
    return null;
  }
}

/** The exact `data` object persisted on a successful discount issuance today. */
export function buildIssuedRedemptionData(
  discount: Extract<DiscountCreationOutcome, { ok: true }>,
) {
  return {
    status: "ISSUED" as const,
    externalDiscountId: discount.discountNodeId,
    externalDiscountStatus: "ACTIVE" as const,
    externalUsageCount: 0,
    issuedAt: discount.startsAt,
    expiresAt: discount.endsAt,
    providerErrorDetails: discount.userErrors,
  };
}

/** The exact `data` object persisted on a failed discount issuance today (points already refunded by the caller). */
export function buildRefundedDiscountFailureData(
  discount: Extract<DiscountCreationOutcome, { ok: false }>,
) {
  return {
    status: "REFUNDED" as const,
    errorMessage: discount.error,
    providerErrorDetails: discount.userErrors || undefined,
  };
}

function mapIncompatibilityToErrorCode(
  reasons: ShopifyRewardCompatibilityReason[],
): "CURRENCY_MISMATCH" | "PRODUCT_SOURCE_MISMATCH" {
  return reasons.includes("CURRENCY_REVIEW_REQUIRED")
    ? "CURRENCY_MISMATCH"
    : "PRODUCT_SOURCE_MISMATCH";
}

function cleanIdempotencyKey(value: unknown) {
  const key = String(value || "").trim();
  return key.length > 0 && key.length <= 160 ? key : null;
}

const redemptionErrorResponses: Record<
  string,
  { error: string; status: number }
> = {
  OFFER_NOT_AVAILABLE: {
    error: "Reward offer is not available.",
    status: 409,
  },
  SHOPIFY_DISCONNECTED: {
    error: "Shopify is not connected for this brand.",
    status: 400,
  },
  INSUFFICIENT_POINTS: {
    error: "Not enough SQRATCH points for this reward.",
    status: 409,
  },
  INACTIVE: {
    error: "Inactive",
    status: 409,
  },
  NOT_STARTED: {
    error: "Not started",
    status: 409,
  },
  CLAIM_WINDOW_ENDED: {
    error: "Claim window ended",
    status: 409,
  },
  LIMIT_REACHED: {
    error: "Limit reached",
    status: 409,
  },
  USER_LIMIT_REACHED: {
    error: "User limit reached",
    status: 409,
  },
  CURRENCY_MISMATCH: {
    error: "Reward currency does not match the Shopify store currency. Please contact the brand.",
    status: 409,
  },
  PRODUCT_SOURCE_MISMATCH: {
    error: "This reward's products are not available for the connected Shopify store.",
    status: 409,
  },
};

function serializeRedemption(redemption: {
  id: string;
  code: string;
  status: string;
  pointsCost: number;
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountAmountCents: number | null;
  discountPercentageBasisPoints: number | null;
  currencyCode: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
  usedAt: Date | null;
  errorMessage?: string | null;
}) {
  return {
    id: redemption.id,
    code: redemption.code,
    status: redemption.status,
    pointsCost: redemption.pointsCost,
    discountType: redemption.discountType,
    discountAmountCents: redemption.discountAmountCents,
    discountPercentageBasisPoints: redemption.discountPercentageBasisPoints,
    currencyCode: redemption.currencyCode,
    issuedAt: redemption.issuedAt,
    expiresAt: redemption.expiresAt,
    usedAt: redemption.usedAt,
    errorMessage: redemption.errorMessage || null,
  };
}

export async function POST(request: NextRequest) {
  return redeemImpl(request, realAuthResolvers);
}

export async function redeemImpl(
  request: NextRequest,
  deps: AuthResolvers,
  commerceDepsOverrides: Partial<ShopifyRewardRedeemCommerceDeps> = {},
) {
  const commerceDeps: ShopifyRewardRedeemCommerceDeps = {
    ...DEFAULT_COMMERCE_DEPS,
    ...commerceDepsOverrides,
  };
  try {
    const session = await deps.resolveSession();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const offerId = String(body?.offerId || "").trim();
    const idempotencyKey = cleanIdempotencyKey(body?.idempotencyKey);
    const experienceSlug = body?.experienceSlug
      ? String(body.experienceSlug).trim()
      : null;
    const campaignId = body?.campaignId ? String(body.campaignId).trim() : null;

    if (!offerId || !idempotencyKey) {
      return NextResponse.json(
        { error: "offerId and idempotencyKey are required." },
        { status: 400 },
      );
    }

    const existing = await prisma.commerceRewardRedemption.findUnique({
      where: {
        idempotencyKey,
      },
    });

    if (existing) {
      // NOTE: experienceSlug / campaignId are request-time routing context that
      // is NOT persisted on the redemption row.  offerId is the authoritative
      // binding identity for idempotency purposes.
      const matchResult = idempotencyMatch(
        { userId: existing.userId, offerId: existing.offerId },
        { userId: session.user.id, offerId },
      );
      if (matchResult === "USER_MISMATCH") {
        return NextResponse.json(
          { error: "Idempotency key is already in use." },
          { status: 409 },
        );
      }
      if (matchResult === "OFFER_MISMATCH") {
        return NextResponse.json(
          { error: "Idempotency key was already used for a different reward." },
          { status: 409 },
        );
      }
      // MATCH — safe to return the cached redemption
      return NextResponse.json({ data: serializeRedemption(existing) });
    }

    const offer = await prisma.brandRewardOffer.findUnique({
      where: {
        id: offerId,
      },
      include: {
        products: true,
      },
    });

    if (!offer) {
      return NextResponse.json(
        { error: "Reward offer is not available." },
        { status: 404 },
      );
    }

    const rewardContext = await getRewardClaimContext({
      request,
      userId: session.user.id,
      experienceSlug,
      campaignId,
    });

    if (!rewardContext.ok) {
      return NextResponse.json(
        { error: rewardContext.error },
        { status: rewardContext.status },
      );
    }

    if (!rewardContext.brandIds.includes(offer.brandId)) {
      return NextResponse.json(
        { error: "Unlock this experience before claiming rewards." },
        { status: 403 },
      );
    }

    // Recorded on the ledger (via metadata) only when the claim request
    // resolved to exactly one unlocked campaign — never guessed from a list
    // of several (a user can have multiple unlocks, and an experience can be
    // attached to multiple campaigns).
    const deterministicCampaignId =
      rewardContext.campaignIds.length === 1
        ? rewardContext.campaignIds[0]
        : null;

    // CANONICAL CONNECTION GATE. `getActiveCommerceConnection` is the sole
    // authority (see connection-service.ts): the connection resolves from
    // `CommerceConnection` or not at all. PHASE 14C-B2 dropped the legacy
    // `Brand.shopify*` columns outright, so there is no fallback source left.
    // This is a read-only PRE-check — the Serializable transaction below
    // re-derives its own connectivity/compatibility snapshot fresh, exactly
    // as before, as defense in depth against a change that races this check.
    const initialSummary = await resolveGateConnectionSummary(
      commerceDeps.getConnectionSummary,
      offer.brandId,
    );
    if (!initialSummary || !isConnectionUsable(initialSummary)) {
      return NextResponse.json(
        { error: "Shopify is not connected for this brand." },
        { status: 400 },
      );
    }

    // Compute compatibility before beginning the reservation — repeated
    // again with freshly loaded data inside the Serializable transaction
    // below as defense in depth against a change that races this check.
    // Sourced from the CANONICAL summary (shop domain, currency) — never
    // `Brand.shopify*` directly.
    const initialCompatibility = computeShopifyRewardCompatibility({
      offer: {
        discountType: offer.discountType,
        minimumSubtotalCents: offer.minimumSubtotalCents,
        currencyCode: offer.currencyCode,
        appliesTo: offer.appliesTo,
        sourceExternalAccountId: offer.sourceExternalAccountId,
      },
      shopifyConnected: true,
      currentShopDomain: initialSummary.externalAccountId,
      currentStoreCurrency: initialSummary.currencyCode,
    });

    if (!initialCompatibility.compatible) {
      const mapped =
        redemptionErrorResponses[
          mapIncompatibilityToErrorCode(initialCompatibility.reasons)
        ];
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: session.user.id,
      },
      select: {
        id: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const [totalRedemptions, userRedemptions] = await Promise.all([
      offer.maxTotalRedemptions
        ? prisma.commerceRewardRedemption.count({
            where: {
              offerId: offer.id,
              status: {
                in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
              },
            },
          })
        : Promise.resolve(0),
      offer.maxRedemptionsPerUser
        ? prisma.commerceRewardRedemption.count({
            where: {
              offerId: offer.id,
              userId: user.id,
              status: {
                in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
              },
            },
          })
        : Promise.resolve(0),
    ]);
    const availability = getRewardOfferAvailability({
      offer,
      shopifyConnected: true,
      totalRedemptions,
      userRedemptions,
    });

    if (!availability.claimable) {
      return NextResponse.json(
        { error: availability.label },
        { status: 409 },
      );
    }

    const userPointsBalance = await getUserSpendablePointBalance({
      userId: user.id,
    });

    if (userPointsBalance < offer.pointsCost) {
      return NextResponse.json(
        { error: "Not enough SQRATCH points for this reward." },
        { status: 409 },
      );
    }

    const issuedAt = new Date();
    let reservation: {
      redemption: CommerceRewardRedemption;
      discountConfig: {
        brandName: string;
        shopDomain: string;
        brandId: string;
        connectionId: string;
        provider: CommerceProvider;
        title: string;
        codeValidDays: number;
        discountType: "FIXED_AMOUNT" | "PERCENTAGE";
        discountAmountCents: number | null;
        discountPercentageBasisPoints: number | null;
        currencyCode: string;
        appliesTo: RewardAppliesTo;
        externalProductIds: string[];
        minimumSubtotalCents: number | null;
        pointsCost: number;
      };
    } | null = null;

    // Bounded retry loop: up to 3 attempts to handle the rare case where the
    // generated `code` collides with an existing unique value (P2002 on `code`).
    // Because the Serializable transaction rolls back atomically on any error —
    // including a P2002 — the debit and PointTransaction writes are fully
    // unwound before we ever reach the catch block, so retrying with a freshly
    // generated code cannot double-debit the user.
    // A P2002 on `idempotencyKey` (concurrent same-key request) is NOT retried
    // here — it falls through to the concurrent-existing lookup below so that
    // the already-committed row can be returned to the caller.
    const MAX_CODE_COLLISION_RETRIES = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRIES; attempt++) {
      // Regenerate the code on every attempt so a collision gets a fresh value.
      const code = generateRewardCode(offer.codePrefix);

      try {
        reservation = await prisma.$transaction(async (tx) => {
          const currentOffer = await tx.brandRewardOffer.findUnique({
            where: {
              id: offer.id,
            },
            include: {
              brand: {
                select: {
                  name: true,
                },
              },
              products: {
                select: {
                  externalProductId: true,
                },
              },
            },
          });

          if (!currentOffer || currentOffer.brandId !== offer.brandId) {
            throw new Error("OFFER_NOT_AVAILABLE");
          }

          // PHASE 14C-A: resolved INSIDE the Serializable transaction, via
          // the transaction's own `tx` client, so this participates in the
          // transaction's isolation/locking instead of reading a
          // pre-transaction snapshot that could have gone stale by commit
          // time — this IS the transaction-time recheck the pre-transaction
          // gate above deliberately does not substitute for. No legacy
          // Brand fallback: every live Shopify install already has a
          // canonical row (operator-verified), so no row means not
          // connected, full stop.
          const currentSummary = await resolveCommerceConnectionSummaryWithClient(
            tx,
            currentOffer.brandId,
            CommerceProvider.SHOPIFY,
          );
          const shopifyConnected =
            currentSummary !== null && isConnectionUsable(currentSummary);

          if (!shopifyConnected || !currentSummary) {
            throw new Error("SHOPIFY_DISCONNECTED");
          }

          // Re-checked here with data freshly loaded inside the Serializable
          // transaction — defense in depth against a currency/product-source
          // change that raced the pre-transaction check above. Currency
          // validation only applies to currency-dependent offers (FIXED_AMOUNT,
          // or a set minimumSubtotalCents); a percentage reward with no
          // minimum subtotal is never blocked merely for a stored currency
          // difference.
          const currentCompatibility = computeShopifyRewardCompatibility({
            offer: {
              discountType: currentOffer.discountType,
              minimumSubtotalCents: currentOffer.minimumSubtotalCents,
              currencyCode: currentOffer.currencyCode,
              appliesTo: currentOffer.appliesTo,
              sourceExternalAccountId: currentOffer.sourceExternalAccountId,
            },
            shopifyConnected,
            currentShopDomain: currentSummary.externalAccountId,
            currentStoreCurrency: currentSummary.currencyCode,
          });

          if (!currentCompatibility.compatible) {
            throw new Error(
              mapIncompatibilityToErrorCode(currentCompatibility.reasons),
            );
          }

          const [currentTotalRedemptions, currentUserRedemptions] =
            await Promise.all([
              currentOffer.maxTotalRedemptions
                ? tx.commerceRewardRedemption.count({
                    where: {
                      offerId: currentOffer.id,
                      status: {
                        in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
                      },
                    },
                  })
                : Promise.resolve(0),
              currentOffer.maxRedemptionsPerUser
                ? tx.commerceRewardRedemption.count({
                    where: {
                      offerId: currentOffer.id,
                      userId: user.id,
                      status: {
                        in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
                      },
                    },
                  })
                : Promise.resolve(0),
            ]);
          const currentAvailability = getRewardOfferAvailability({
            offer: currentOffer,
            shopifyConnected,
            totalRedemptions: currentTotalRedemptions,
            userRedemptions: currentUserRedemptions,
            now: issuedAt,
          });

          if (!currentAvailability.claimable) {
            throw new Error(currentAvailability.status);
          }

          const createdRedemption = await tx.commerceRewardRedemption.create({
            data: {
              userId: user.id,
              brandId: currentOffer.brandId,
              offerId: currentOffer.id,
              provider: CommerceProvider.SHOPIFY,
              idempotencyKey,
              code,
              status: "PENDING",
              pointsCost: currentOffer.pointsCost,
              discountType: currentOffer.discountType,
              discountAmountCents: currentOffer.discountAmountCents,
              discountPercentageBasisPoints: currentOffer.discountPercentageBasisPoints,
              currencyCode: currentOffer.currencyCode,
              externalAccountId: currentSummary.externalAccountId,
            },
          });

          // Central ledger debit: decrements spendable points (conditional, so
          // the balance can never go negative), records lifetime spent, and
          // writes the negative PointTransaction — all inside this Serializable
          // transaction. Lifetime earned is NOT reduced. Idempotency is
          // enforced by the ledger's unique constraints.
          const debit = await debitShopifyRewardPoints({
            userId: user.id,
            pointsCost: currentOffer.pointsCost,
            commerceRewardRedemptionId: createdRedemption.id,
            campaignId: deterministicCampaignId,
            db: tx,
          });

          if (!debit.applied) {
            if (debit.reason === "INSUFFICIENT_POINTS") {
              throw new Error("INSUFFICIENT_POINTS");
            }
            // DUPLICATE / INVALID here would be a genuine anomaly for a freshly
            // created redemption id — roll the reservation back.
            throw new Error("OFFER_NOT_AVAILABLE");
          }

          const debitedRedemption = await tx.commerceRewardRedemption.update({
            where: {
              id: createdRedemption.id,
            },
            data: {
              status: "POINTS_DEBITED",
            },
          });

          return {
            redemption: debitedRedemption,
            discountConfig: {
              brandName: currentOffer.brand.name,
              shopDomain: currentSummary.externalAccountId,
              brandId: currentOffer.brandId,
              connectionId: currentSummary.id!,
              provider: currentSummary.provider,
              title: currentOffer.title,
              codeValidDays: currentOffer.codeValidDays,
              discountType: currentOffer.discountType,
              discountAmountCents: currentOffer.discountAmountCents,
              discountPercentageBasisPoints: currentOffer.discountPercentageBasisPoints,
              currencyCode: currentOffer.currencyCode,
              appliesTo: currentOffer.appliesTo,
              externalProductIds: currentOffer.products.map(
                (product) => product.externalProductId,
              ),
              minimumSubtotalCents: currentOffer.minimumSubtotalCents,
              pointsCost: currentOffer.pointsCost,
            },
          };
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });

        // Transaction succeeded — exit the retry loop.
        break;
      } catch (error) {
        // Retry ONLY for a P2002 unique violation on the `code` field.
        // A P2002 on `idempotencyKey` means a concurrent request already
        // committed a row for this key — do NOT retry; fall through to the
        // concurrent-existing lookup so that row can be returned to the caller.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const target = (error.meta?.target as string[] | undefined) ?? [];
          if (target.includes("code") && !target.includes("idempotencyKey")) {
            // Code collision — safe to retry because the Serializable TX rolled
            // back fully: no debit or PointTransaction was persisted.
            lastError = error;
            continue;
          }
        }

        // For every other error (known domain errors, P2034 serialization
        // failure, idempotencyKey P2002, etc.) drop out of the loop and handle
        // below.
        lastError = error;
        break;
      }
    }

    if (!reservation) {
      const error = lastError;

      const concurrentExisting =
        await prisma.commerceRewardRedemption.findUnique({
          where: {
            idempotencyKey,
          },
        });

      if (concurrentExisting) {
        // Apply the same user+offer match check as the upfront existing-key
        // branch to guard against returning a row for the wrong offer.
        const concurrentMatch = idempotencyMatch(
          { userId: concurrentExisting.userId, offerId: concurrentExisting.offerId },
          { userId: user.id, offerId },
        );
        if (concurrentMatch === "MATCH") {
          return NextResponse.json({
            data: serializeRedemption(concurrentExisting),
          });
        }
      }

      const errorCode = error instanceof Error ? error.message : "";
      const knownError = redemptionErrorResponses[errorCode];

      if (knownError) {
        return NextResponse.json(
          { error: knownError.error },
          { status: knownError.status },
        );
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        return NextResponse.json(
          { error: "Reward availability changed. Please try again." },
          { status: 409 },
        );
      }

      console.error("[rewards/shopify/redeem][reserve] Error:", error);
      return NextResponse.json(
        { error: "Failed to reserve this reward." },
        { status: 500 },
      );
    }

    const { redemption, discountConfig } = reservation;

    const tokenResult = await getValidAccessToken(discountConfig.brandId, {
      connectionId: discountConfig.connectionId,
    });
    if (!tokenResult.ok) {
      const refunded = await prisma.$transaction(async (tx) => {
        const current = await tx.commerceRewardRedemption.findUnique({
          where: { id: redemption.id },
          select: { status: true },
        });
        if (current?.status !== "POINTS_DEBITED") {
          return tx.commerceRewardRedemption.findUniqueOrThrow({
            where: { id: redemption.id },
          });
        }
        // Restore spendable points + lifetime refunded (never lifetime earned).
        await refundShopifyRewardPoints({
          userId: user.id,
          points: discountConfig.pointsCost,
          commerceRewardRedemptionId: redemption.id,
          campaignId: deterministicCampaignId,
          db: tx,
        });
        return tx.commerceRewardRedemption.update({
          where: { id: redemption.id },
          data: {
            status: "REFUNDED",
            errorMessage: "Shopify token unavailable: " + tokenResult.reason,
          },
        });
      });
      return NextResponse.json(
        {
          error: "Could not create the Shopify discount code. Points were refunded.",
          data: serializeRedemption(refunded),
        },
        { status: 502 },
      );
    }

    // Cutover point: route discount issuance through the provider-neutral
    // CommerceAdapter whenever a real CommerceConnection.id is available;
    // otherwise fall back to the exact legacy direct call. Both branches
    // funnel into the SAME `DiscountCreationOutcome` shape, so every line
    // below this point (persisted-field mapping, refund, response) is
    // identical regardless of which path produced `discount`.
    const commerceSummary = await safeGetCommerceConnectionSummary(
      commerceDeps.getConnectionSummary,
      discountConfig.brandId,
    );

    // PHASE 14B.4B — STRUCTURAL GUARD: a canonical token must never be paired
    // with a shop domain that didn't resolve it. `tokenResult.accessToken`
    // was resolved by `getValidAccessToken`, which as of Phase 14B is
    // canonical-first; `discountConfig.shopDomain` was captured earlier in
    // this request's reservation. Both should always agree — but if a
    // canonical connection exists whose shop domain DISAGREES with the
    // reservation's domain (e.g. a relink raced this request), the adapter
    // path below would issue a discount against `commerceSummary.id`'s shop
    // using a token that may not even belong to it. Refuse and refund rather
    // than risk that pairing, making it structurally impossible to reach
    // `issueDiscountViaAdapter`/`createShopifyRewardDiscountCode` with a
    // token/domain pair that was never jointly resolved.
    if (
      commerceSummary && commerceSummary.id !== null &&
      normalizeExternalAccountId(commerceSummary.externalAccountId) !== normalizeExternalAccountId(discountConfig.shopDomain)
    ) {
      const refunded = await prisma.$transaction(async (tx) => {
        const current = await tx.commerceRewardRedemption.findUnique({
          where: { id: redemption.id },
          select: { status: true },
        });
        if (current?.status !== "POINTS_DEBITED") {
          return tx.commerceRewardRedemption.findUniqueOrThrow({
            where: { id: redemption.id },
          });
        }
        await refundShopifyRewardPoints({
          userId: user.id,
          points: discountConfig.pointsCost,
          commerceRewardRedemptionId: redemption.id,
          campaignId: deterministicCampaignId,
          db: tx,
        });
        return tx.commerceRewardRedemption.update({
          where: { id: redemption.id },
          data: {
            status: "REFUNDED",
            errorMessage: "Shopify connection changed during redemption.",
          },
        });
      });
      return NextResponse.json(
        {
          error: "Could not create the Shopify discount code. Points were refunded.",
          data: serializeRedemption(refunded),
        },
        { status: 502 },
      );
    }

    const discount: DiscountCreationOutcome =
      commerceSummary && commerceSummary.id !== null
        ? await issueDiscountViaAdapter(
            commerceDeps.registry,
            commerceSummary.id,
            commerceSummary.provider,
            tokenResult.accessToken,
            buildCreateDiscountInput(discountConfig, redemption.code, issuedAt),
          )
        : await createShopifyRewardDiscountCode({
            shopDomain: discountConfig.shopDomain,
            accessToken: tokenResult.accessToken,
            title: `${discountConfig.brandName} - ${discountConfig.title}`,
            code: redemption.code,
            issuedAt,
            codeValidDays: discountConfig.codeValidDays,
            discountType: discountConfig.discountType,
            discountAmountCents: discountConfig.discountAmountCents,
            discountPercentageBasisPoints: discountConfig.discountPercentageBasisPoints,
            appliesTo: discountConfig.appliesTo,
            shopifyProductGids: discountConfig.externalProductIds,
            minimumSubtotalCents: discountConfig.minimumSubtotalCents,
          });

    if (!discount.ok) {
      const refunded = await prisma.$transaction(async (tx) => {
        const current = await tx.commerceRewardRedemption.findUnique({
          where: {
            id: redemption.id,
          },
          select: {
            status: true,
          },
        });

        if (current?.status !== "POINTS_DEBITED") {
          return tx.commerceRewardRedemption.findUniqueOrThrow({
            where: {
              id: redemption.id,
            },
          });
        }

        // Restore spendable points + lifetime refunded (never lifetime earned).
        await refundShopifyRewardPoints({
          userId: user.id,
          points: discountConfig.pointsCost,
          commerceRewardRedemptionId: redemption.id,
          campaignId: deterministicCampaignId,
          db: tx,
        });

        return tx.commerceRewardRedemption.update({
          where: {
            id: redemption.id,
          },
          data: buildRefundedDiscountFailureData(discount),
        });
      });

      return NextResponse.json(
        {
          error:
            "Could not create the Shopify discount code. Points were refunded.",
          data: serializeRedemption(refunded),
        },
        { status: discount.status || 502 },
      );
    }

    const issued = await prisma.commerceRewardRedemption.update({
      where: {
        id: redemption.id,
      },
      data: buildIssuedRedemptionData(discount),
    });

    return NextResponse.json({ data: serializeRedemption(issued) });
  } catch (error) {
    console.error("[rewards/shopify/redeem][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to redeem Shopify reward." },
      { status: 500 },
    );
  }
}
