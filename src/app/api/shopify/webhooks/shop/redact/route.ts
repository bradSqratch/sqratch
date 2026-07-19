import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";

// Shopify sends shop/redact 48 hours after a merchant uninstalls, confirming
// all shop data must be erased. Per docs/shopify-data-inventory.md §5:
//   - Clear ALL Shopify credentials and token metadata on the Brand record.
//   - Null shopifyShopDomain to release the unique slot (GDPR shop data removal).
//   - Anonymize Shopify-specific metadata on ShopifyRewardRedemption rows.
//   - PRESERVE all SQRATCH business records (PointTransaction,
//     ShopifyRewardRedemption core fields, BrandRewardOffer rows).
//   - Delete any orphaned OAuth state TokenStore rows for this shop.
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

    // Find the brand holding this domain first so we can use its id in the
    // redemption update. updateMany on Brand will null the domain, so we need
    // the id before we null it.
    const brand = await prisma.brand.findFirst({
      where: { shopifyShopDomain: shopDomain },
      select: { id: true },
    });

    const operations: Prisma.PrismaPromise<unknown>[] = [];

    if (brand) {
      // Clear all Shopify credentials, token metadata, and the shop domain on
      // the Brand. Nulling shopifyShopDomain releases the @unique slot so the
      // same shop can re-install in future. Timestamps are retained as an
      // anonymised audit trail (no personal data). Business records are not
      // touched.
      operations.push(
        prisma.brand.update({
          where: { id: brand.id },
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
        // Anonymize Shopify-specific metadata on redemption rows. Core fields
        // (userId, brandId, offerId, code, pointsCost, status, timestamps) are
        // preserved as SQRATCH financial/points ledger entries.
        // Note: shopifyShopDomain is non-nullable in the schema (String) so it
        // cannot be nulled here; the domain is not personal data per the
        // inventory analysis in docs/shopify-data-inventory.md §5.
        prisma.shopifyRewardRedemption.updateMany({
          where: { shopifyShopDomain: shopDomain },
          data: {
            shopifyDiscountNodeId: null,
            shopifyDiscountStatus: null,
            shopifyUserErrors: Prisma.JsonNull,
          },
        }),
        // Redaction is a connection loss for this Brand too — its reward
        // offers must never stay (or become) claimable against a store that
        // no longer exists for it.
        prisma.brandRewardOffer.updateMany({
          where: { brandId: brand.id },
          data: { isActive: false },
        }),
      );
    }

    // Null sourceShopDomain wherever it references the redacted shop, on
    // every Brand this domain ever touched — not just the Brand currently
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
      prisma.experienceProductLink.updateMany({
        where: { sourceShopDomain: shopDomain },
        data: { sourceShopDomain: null },
      }),
      prisma.lessonProductLink.updateMany({
        where: { sourceShopDomain: shopDomain },
        data: { sourceShopDomain: null },
      }),
      // Scrub the redacted domain out of connection history. Rows are kept
      // (event type + timestamp remain useful audit history) but never
      // retain the redacted shop domain, currency, or client id. Matched
      // separately by field so a RELINKED event whose *current* domain is
      // unrelated to this redaction doesn't lose that unrelated data merely
      // because its previousShopDomain happened to be the redacted shop.
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

    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }

    // Sanitized audit log: topic + shop domain (the domain itself is being
    // removed, so logging it here for the final audit trail is appropriate).
    // No customer PII is logged.
    console.log(
      JSON.stringify({
        event: "shopify_webhook",
        topic: "shop/redact",
        shopDomain,
        brandFound: !!brand,
        redactionPerformed: !!brand,
        orphanTokensDeleted: orphanServices.length,
      }),
    );
  }

  return new NextResponse(null, { status: 200 });
}
