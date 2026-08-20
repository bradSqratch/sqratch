import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";
import { safeDeleteShopifyCommerceConnectionByShopDomain } from "@/lib/commerce/connection-sync";
import { invalidateShopifyCredential } from "@/lib/commerce/providers/shopify-credential-store";

// Shopify sends shop/redact 48 hours after a merchant uninstalls, confirming
// all shop data must be erased. Per docs/shopify-data-inventory.md §5:
//   - Anonymize Shopify-specific metadata on ShopifyRewardRedemption rows.
//   - Deactivate reward offers for every brand historically associated with
//     this shop domain.
//   - Clear ALL Shopify credentials and token metadata on any Brand record
//     whose legacy mirror still points at this domain.
//   - Null shopifyShopDomain to release the unique slot (GDPR shop data removal).
//   - PRESERVE all SQRATCH business records (PointTransaction,
//     ShopifyRewardRedemption core fields, BrandRewardOffer rows).
//   - Delete any orphaned OAuth state TokenStore rows for this shop.
//
// PHASE 14C-B1: identity is resolved from domain-scoped history
// (ShopifyConnectionEvent + ShopifyRewardRedemption), NEVER from
// `Brand.shopifyShopDomain` — see the in-function comment below for why a
// live-mirror lookup silently misses a brand that already relinked away.
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
    // this order means that if any later step fails, the canonical connection
    // is already UNINSTALLED with no secret, so `resolveRuntimeCredential`
    // refuses the legacy `Brand` fallback. Deleting the connection first would
    // instead leave NO_CONNECTION — the one state that still permits the
    // compatibility fallback — and a failed `Brand` scrub would then resurrect
    // the credential.
    // PHASE 14B.3 P1 FIX: `shop/redact` is even MORE destructive than
    // `app/uninstalled` — it ERASES the CommerceConnection row outright and
    // nulls `Brand.shopifyShopDomain`. A redact event redelivered (Shopify
    // retries failed deliveries up to 4 hours) after the merchant reinstalled
    // would destroy the fresh connection's row and break its relink key. See
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
    let mirrorBrandsCleared = 0;
    if (canonicalInvalidation.outcome !== "STALE_EVENT_IGNORED") {
      // -----------------------------------------------------------------
      // PHASE 14C-B1 — IDENTITY IS RESOLVED FROM HISTORY, NEVER FROM
      // `Brand.shopifyShopDomain`. That field can no longer be trusted as a
      // routing key: `app/uninstalled` deliberately preserves it (relink
      // policy), so by the time a delayed `shop/redact` for shop X arrives, the
      // brand that actually held X may have already relinked to shop Y — its
      // `Brand.shopifyShopDomain` now reads Y, not X, and a domain-keyed
      // `findFirst` on Brand would silently miss it, skipping the privacy
      // scrub for a real historical connection. Every brand that ever had
      // reward activity or a recorded connection event against `shopDomain`
      // is resolved from that domain-scoped history instead — this can never
      // pull in an unrelated brand (cross-brand leakage) because both sources
      // are filtered on the exact redacted domain, and it can never miss the
      // brand that actually owned it (unlike a live-mirror lookup, which
      // silently goes stale on relink).
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

      // Of the historically-associated brands above, which ones still have
      // their legacy `Brand.shopifyShopDomain` mirror pointing at THIS domain
      // right now. This is the ONLY remaining read of that field, and it is
      // never used to DISCOVER identity (identity is already resolved above)
      // — only to scope which brands' now-stale legacy mirror columns need
      // clearing. A brand that already relinked away has nothing left to
      // clear here (its mirror legitimately reflects its NEW shop), so it is
      // correctly excluded rather than having its current connection's data
      // destroyed.
      const mirrorBrands =
        historicalBrandIds.length > 0
          ? await prisma.brand.findMany({
              where: { id: { in: historicalBrandIds }, shopifyShopDomain: shopDomain },
              select: { id: true },
            })
          : [];
      mirrorBrandsCleared = mirrorBrands.length;

      const operations: Prisma.PrismaPromise<unknown>[] = [];

      for (const mirrorBrand of mirrorBrands) {
        // Clear all Shopify credentials, token metadata, and the shop domain
        // on the Brand. Nulling shopifyShopDomain releases the @unique slot so
        // the same shop can re-install in future. Timestamps are retained as
        // an anonymised audit trail (no personal data). Business records are
        // not touched.
        operations.push(
          prisma.brand.update({
            where: { id: mirrorBrand.id },
            data: {
              shopifyShopDomain: null,
              shopifyAdminAccessTokenEncrypted: null,
              shopifyRefreshTokenEncrypted: null,
              shopifyAccessTokenExpiresAt: null,
              shopifyRefreshTokenExpiresAt: null,
              shopifyGrantedScopes: null,
              shopifyConnectionStatus: "UNINSTALLED",
            },
          }),
        );
      }

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

      // Redaction is a connection loss for every historically-associated
      // brand — their reward offers must never stay (or become) claimable
      // against a store that no longer exists. Scoped to `historicalBrandIds`
      // (resolved above from domain-scoped history only), so this can never
      // touch a brand unrelated to this shop.
      if (historicalBrandIds.length > 0) {
        operations.push(
          prisma.brandRewardOffer.updateMany({
            where: { brandId: { in: historicalBrandIds } },
            data: { isActive: false },
          }),
        );
      }

      // Null sourceShopDomain wherever it references the redacted shop, on
      // every Brand this domain ever touched — not just a brand currently
      // holding it, since a prior relink can leave the domain referenced as
      // sourceShopDomain on another Brand's rows. Rows are never deleted, only
      // the domain reference is cleared (requires product reselection / a
      // currency review already anyway, since sourceShopDomain no longer
      // resolves to anything).
      operations.push(
        prisma.brandRewardOffer.updateMany({
          where: { sourceShopDomain: shopDomain },
          data: { sourceShopDomain: null },
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

      // Provider-neutral CommerceConnection ERASURE. Runs AFTER the canonical
      // invalidation above and after the transaction has committed, and can
      // never fail this webhook (see connection-sync.ts). Keyed on
      // (provider, externalAccountId) = (SHOPIFY, shopDomain), not on any
      // Brand field, so it is correct whether or not a brand's legacy mirror
      // still pointed at this domain.
      await safeDeleteShopifyCommerceConnectionByShopDomain(shopDomain);
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
        mirrorBrandsCleared,
        orphanTokensDeleted:
          canonicalInvalidation.outcome === "STALE_EVENT_IGNORED" ? 0 : orphanServices.length,
        canonicalInvalidation: canonicalInvalidation.outcome,
      }),
    );
  }

  return new NextResponse(null, { status: 200 });
}
