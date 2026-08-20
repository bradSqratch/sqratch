import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { invalidateShopifyCredential } from "@/lib/commerce/providers/shopify-credential-store";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";
import { recordShopifyConnectionLoss } from "@/lib/shopify-connection-transitions";
import { extractCurrencyCodeFromProviderMetadata } from "@/lib/commerce/connection-resolver";

// Shopify sends app/uninstalled immediately when a merchant uninstalls.
// Credentials are cleared but `CommerceConnection.externalAccountId` (the
// shop domain) is PRESERVED so that reinstallation to the same brand is
// seamless — the domain is the stable relink key
// (`@@unique([provider, externalAccountId])`, see connection-sync.ts).
// Shopify will send shop/redact 48 h later if the merchant does not
// reinstall, at which point the canonical row is deleted.
export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  if (verification.shop) {
    const shopDomain = verification.shop;

    // -----------------------------------------------------------------------
    // PHASE 14C-A — CANONICAL-ONLY INVALIDATION. No legacy `Brand` read or
    // write anywhere in this handler.
    // -----------------------------------------------------------------------
    // Selected by SHOP DOMAIN, not brand: a relink can move a brand off this
    // domain before its terminal webhook arrives, and a brand-keyed lookup
    // would then miss the row or hit the wrong (current) shop's connection.
    const canonicalInvalidation = await invalidateShopifyCredential({
      shopDomain,
      status: "UNINSTALLED" as const,
      // PHASE 14B.3 P1 FIX: `app/uninstalled` retries can redeliver the
      // ORIGINAL payload up to 4 hours later. If the merchant reinstalled
      // (same shop domain, same canonical connection row) since Shopify
      // triggered this delivery, applying it now would revoke the fresh
      // install. See `invalidateShopifyCredential`'s STALE_EVENT_IGNORED
      // fence.
      eventTriggeredAt: verification.triggeredAt,
      onInvalidated: async (tx, connection) => {
        // Read canonical providerClientId/currency for the event snapshot —
        // status has already transitioned to UNINSTALLED at this point, but
        // these fields are untouched by that write.
        const row = await (tx as Prisma.TransactionClient).commerceConnection.findUnique({
          where: { id: connection.connectionId },
          select: { providerClientId: true, providerMetadata: true },
        });

        await recordShopifyConnectionLoss(tx as Prisma.TransactionClient, {
          brandId: connection.brandId,
          eventType: "UNINSTALLED",
          snapshot: {
            shopDomain,
            currencyCode: extractCurrencyCodeFromProviderMetadata(row?.providerMetadata ?? null),
            shopifyClientId: row?.providerClientId ?? null,
          },
        });
      },
    });

    // Sanitized audit log: topic + shop domain only — no secrets or PII.
    console.log(
      JSON.stringify({
        event: "shopify_webhook",
        topic: "app/uninstalled",
        shopDomain,
        canonicalInvalidation: canonicalInvalidation.outcome,
      }),
    );
  }

  return new NextResponse(null, { status: 200 });
}
