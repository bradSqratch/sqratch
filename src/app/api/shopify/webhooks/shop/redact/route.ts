import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";
import { deleteShopifyCommerceConnectionByShopDomain } from "@/lib/commerce/connection-sync";
import { invalidateShopifyCredential } from "@/lib/commerce/providers/shopify-credential-store";

// Shopify sends shop/redact 48 hours after a merchant uninstalls, confirming
// all shop data must be erased. Per docs/shopify-data-inventory.md §5:
//   - Anonymize Shopify-specific metadata on ShopifyRewardRedemption rows.
//   - Deactivate and scrub only the reward offers actually tied to this shop
//     domain (offer.sourceShopDomain === this domain) — NOT every offer
//     belonging to a brand that merely once had some connection to it. A
//     brand that has since relinked to, and resaved offers against, a
//     different live shop keeps those offers untouched.
//   - Revoke the canonical credential and erase the CommerceConnection row.
//   - PRESERVE all SQRATCH business records (PointTransaction,
//     ShopifyRewardRedemption core fields, BrandRewardOffer rows).
//   - Delete any orphaned OAuth state TokenStore rows for this shop.
//
// PHASE 14C-B1: identity is resolved from domain-scoped history
// (ShopifyConnectionEvent + ShopifyRewardRedemption), never from a live
// Brand mirror — a mirror lookup silently misses a brand that already
// relinked away.
// PHASE 14C-B2: `Brand` no longer carries ANY Shopify connection or
// credential column, so this handler performs no Brand write at all. Every
// scrub below is keyed on the redacted shop domain itself;
// `historicalBrandIds` survives purely as GDPR audit evidence.
export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  if (verification.shop) {
    const shopDomain = verification.shop;

    // Identify short-lived OAuth-state / pending-install TokenStore rows for this
    // shop. Their service keys are random nonces (shopify_oauth_state:<nonce>,
    // shopify_pending_install:<nonce>) and therefore do NOT contain the shop
    // domain — the shop is only present as a top-level plaintext `shop` field
    // inside the stored JSON payload (true for both the OAuth-state record and
    // both pending-install shapes). The previous `service contains shopDomain`
    // filter could never match, so this is a bounded scan that parses only the
    // small set of shopify_* temp rows and matches on the parsed `shop`. No
    // token value is decrypted — only the plaintext `shop` field is read.
    const TEMP_TOKEN_SCAN_LIMIT = 1000;
    const tempRows = await prisma.tokenStore.findMany({
      where: {
        OR: [
          { service: { startsWith: "shopify_oauth_state:" } },
          { service: { startsWith: "shopify_pending_install:" } },
        ],
      },
      select: { service: true, token: true },
      take: TEMP_TOKEN_SCAN_LIMIT,
    });

    const orphanServices = tempRows
      .filter((row) => {
        try {
          const parsed = JSON.parse(row.token) as { shop?: unknown };
          return parsed?.shop === shopDomain;
        } catch {
          // Unparseable rows are left for TTL expiry rather than guessed at.
          return false;
        }
      })
      .map((row) => row.service);

    // -----------------------------------------------------------------------
    // PHASE 14B.3 — CANONICAL-FIRST INVALIDATION.
    // -----------------------------------------------------------------------
    // Revoke the canonical credential BEFORE touching anything else. Selected
    // by shop domain because redaction is shop-scoped and `Brand` may no
    // longer hold this domain after a relink.
    //
    // This is deliberately a status transition + secret delete, NOT the full
    // row delete: the row is erased at the end of this handler. Doing it in
    // this order means that if any later step fails, the shop is still left
    // in a recorded, credential-less UNINSTALLED state rather than with no
    // revocation on record at all.
    // PHASE 14B.3 P1 FIX: `shop/redact` is even MORE destructive than
    // `app/uninstalled` — it ERASES the CommerceConnection row outright. A
    // redact event redelivered (Shopify retries failed deliveries up to 4
    // hours) after the merchant reinstalled would destroy the fresh
    // connection's row and break its relink key. See
    // `invalidateShopifyCredential`'s STALE_EVENT_IGNORED fence.
    const canonicalInvalidation = await invalidateShopifyCredential({
      shopDomain,
      status: "UNINSTALLED" as const,
      eventTriggeredAt: verification.triggeredAt,
    });

    // A STALE event is a genuine, HMAC-verified webhook and must still be
    // acknowledged with 200 — but nothing below may run: the shop domain now
    // belongs to a connection this event has no authority over.
    let historicalBrandIds: string[] = [];
    if (canonicalInvalidation.outcome !== "STALE_EVENT_IGNORED") {
      // -----------------------------------------------------------------
      // IDENTITY IS RESOLVED FROM DOMAIN-SCOPED HISTORY. Every brand that
      // ever had reward activity or a recorded connection event against
      // `shopDomain` is resolved from that history — this can never pull in
      // an unrelated brand (cross-brand leakage), because both sources are
      // filtered on the exact redacted domain, and it can never miss the
      // brand that actually owned it. (Historically the handler resolved
      // identity from a live `Brand` domain mirror, which silently went stale
      // the moment a brand relinked to a different shop; that column no
      // longer exists as of Phase 14C-B2.)
      //
      // PHASE 14C-B2: this set is now audit-only — it feeds
      // `historicalBrandsFound` in the log below. Every cleanup operation is
      // keyed on the redacted domain itself, never on a brand id.
      // -----------------------------------------------------------------
      const [connectionEventBrands, redemptionBrands] = await Promise.all([
        prisma.shopifyConnectionEvent.findMany({
          where: { OR: [{ shopDomain }, { previousShopDomain: shopDomain }] },
          select: { brandId: true },
          distinct: ["brandId"],
        }),
        prisma.shopifyRewardRedemption.findMany({
          where: { shopifyShopDomain: shopDomain },
          select: { brandId: true },
          distinct: ["brandId"],
        }),
      ]);
      historicalBrandIds = [
        ...new Set([
          ...connectionEventBrands.map((row) => row.brandId),
          ...redemptionBrands.map((row) => row.brandId),
        ]),
      ];

      // PHASE 14C-B2: the legacy `Brand.shopify*` compatibility-mirror lookup
      // and clear that used to sit here are gone — those columns no longer
      // exist. `Brand` holds no Shopify connection or credential state at all
      // now, so there is nothing left on it to redact: the canonical
      // credential is revoked by `invalidateShopifyCredential` above and the
      // `CommerceConnection` row itself is erased below. `historicalBrandIds`
      // is retained purely as GDPR audit evidence (how many brands this shop
      // domain was ever associated with) — every scrub below is keyed on the
      // domain itself, never on a brand id.

      const operations: Prisma.PrismaPromise<unknown>[] = [];

      // Anonymize Shopify-specific metadata on redemption rows — domain-keyed,
      // unconditional on whether any brand's live mirror still matches (a
      // relink must never suppress this). Core fields (userId, brandId,
      // offerId, code, pointsCost, status, timestamps) are preserved as
      // SQRATCH financial/points ledger entries.
      // Note: shopifyShopDomain is non-nullable in the schema (String) so it
      // cannot be nulled here; the domain is not personal data per the
      // inventory analysis in docs/shopify-data-inventory.md §5.
      operations.push(
        prisma.shopifyRewardRedemption.updateMany({
          where: { shopifyShopDomain: shopDomain },
          data: {
            shopifyDiscountNodeId: null,
            shopifyDiscountStatus: null,
            shopifyUserErrors: Prisma.JsonNull,
          },
        }),
      );

      // PHASE 14C-B1.1: an offer is shop-specific iff its own
      // `sourceShopDomain` equals the redacted domain — that field is set to
      // the connected shop's domain on every create/update while a Shopify
      // connection is active (src/lib/reward-offers.ts,
      // src/app/api/brand/rewards/offers/route.ts), for every `appliesTo`
      // value, not only SPECIFIC_PRODUCTS offers. It only goes stale (still
      // pointing at an old shop) until the offer is next saved while
      // connected elsewhere. Scoping to `sourceShopDomain: shopDomain` (never
      // to `historicalBrandIds` alone) is deliberately narrower: a brand that
      // once owned this domain but has since relinked to, and resaved offers
      // against, a different live shop must keep those live offers
      // untouched — only the offers actually tied to THIS domain are
      // deactivated and scrubbed. An offer with a null `sourceShopDomain`
      // (created/last saved while never connected) is never shop-specific to
      // any domain and is therefore never matched here.
      operations.push(
        prisma.brandRewardOffer.updateMany({
          where: { sourceShopDomain: shopDomain },
          data: { isActive: false, sourceShopDomain: null },
        }),
        // PHASE 8: the ExperienceProductLink / LessonProductLink
        // sourceShopDomain scrubs that used to sit here are gone with those
        // tables (20260808130000_remove_legacy_product_link_snapshots). No
        // coverage is lost: the canonical product chain
        // (ConnectedCommerceProduct / BrandCommerceProduct /
        // CampaignLessonProduct) cascades from CommerceConnection, which this
        // webhook deletes outright below, so those rows are removed wholesale
        // rather than needing a field-level scrub.
        // Scrub the redacted domain out of connection history. Rows are kept
        // (event type + timestamp remain useful audit history) but never
        // retain the redacted shop domain, currency, or client id. Matched
        // separately by field so a RELINKED event whose *current* domain is
        // unrelated to this redaction doesn't lose that unrelated data merely
        // because its previousShopDomain happened to be the redacted shop.
        // This runs AFTER `connectionEventBrands` was already resolved above,
        // so nulling these fields here cannot affect that identity resolution.
        prisma.shopifyConnectionEvent.updateMany({
          where: { shopDomain },
          data: { shopDomain: null, currencyCode: null, shopifyClientId: null },
        }),
        prisma.shopifyConnectionEvent.updateMany({
          where: { previousShopDomain: shopDomain },
          data: { previousShopDomain: null, previousCurrencyCode: null },
        }),
      );

      // Delete only the temp tokens whose payload shop matches this shop. An empty
      // `in` list deletes nothing, so this is safe when no orphans were found and
      // never touches other shops' OAuth states or pending installs.
      if (orphanServices.length > 0) {
        operations.push(
          prisma.tokenStore.deleteMany({
            where: { service: { in: orphanServices } },
          }),
        );
      }

      await prisma.$transaction(operations);

      // Provider-neutral CommerceConnection ERASURE. Runs AFTER canonical
      // invalidation and the historical scrub. This deletion is REQUIRED for
      // a successful redaction: a transient failure deliberately returns a
      // retryable non-2xx response so Shopify redelivers the webhook. A
      // missing row is an idempotent success in the strict deleter. Keyed on
      // (provider, externalAccountId) = (SHOPIFY, shopDomain), never Brand.
      try {
        await deleteShopifyCommerceConnectionByShopDomain(shopDomain);
      } catch {
        // Fixed diagnostic only: never expose database details, credentials,
        // HMAC material, or provider payload data in this retryable response.
        console.error("[shopify/webhooks/shop/redact]", {
          outcome: "canonical_connection_erasure_failed_retryable",
        });
        return NextResponse.json(
          { error: "Shop data erasure could not be completed." },
          { status: 500 },
        );
      }
    }

    // Sanitized audit log: topic + shop domain (the domain itself is being
    // removed, so logging it here for the final audit trail is appropriate).
    // No customer PII is logged.
    console.log(
      JSON.stringify({
        event: "shopify_webhook",
        topic: "shop/redact",
        shopDomain,
        historicalBrandsFound: historicalBrandIds.length,
        orphanTokensDeleted:
          canonicalInvalidation.outcome === "STALE_EVENT_IGNORED" ? 0 : orphanServices.length,
        canonicalInvalidation: canonicalInvalidation.outcome,
      }),
    );
  }

  return new NextResponse(null, { status: 200 });
}
