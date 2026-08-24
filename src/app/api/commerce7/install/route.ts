import { NextRequest, NextResponse } from "next/server";
import {
  CommerceConnectionStatus,
  CommerceProvider,
  type Prisma,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { verifyCommerce7CallbackAuth } from "@/lib/commerce/providers/commerce7-callback-auth";
import { normalizeCommerce7Tenant } from "@/lib/commerce/providers/commerce7";
import { markProviderInstallationInstalled } from "@/lib/commerce/provider-installation";
import { recordCommerceConnectionEvent } from "@/lib/commerce/connection-lifecycle";

/**
 * POST /api/commerce7/install
 *
 * Commerce7 calls this with Basic auth (configured in the App Dev Center) when a
 * winery installs the SQRATCH app on their tenant.
 *
 * WHAT THIS DOES NOT DO:
 *   - It does NOT create a Brand, and does NOT infer one from the installer's
 *     email. Install proves someone installed the app on a tenant; it proves
 *     nothing about which SQRATCH Brand should own that tenant. Linking is a
 *     separate, explicitly-confirmed act by an authenticated SQRATCH Brand
 *     Admin (see /commerce7/connect -> /commerce7/link).
 *   - It does NOT create an unowned CommerceConnection.
 *   - It does NOT store a credential. Commerce7's App Secret is app-global and
 *     lives in backend environment configuration only.
 *   - It does NOT depend on the temporary `sqratch-connection-code` Client
 *     Setting, which is being retired. Unknown Client Settings in the body are
 *     tolerated and ignored.
 *   - It does NOT touch Shopify.
 *
 * The installer's name/email in the payload are deliberately NOT persisted:
 * nothing in this phase needs them, and not storing provider-side personal data
 * is the cheapest way to keep it out of scope for erasure obligations.
 *
 * LOGGING: the request body is never logged (it carries installer PII and any
 * configured Client Settings), and callback credentials are never logged.
 */
export async function POST(request: NextRequest) {
  const auth = verifyCommerce7CallbackAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await request.json().catch(() => null);
  const tenantId = normalizeCommerce7Tenant(
    (body as { tenantId?: unknown } | null)?.tenantId as string | undefined,
  );

  if (!tenantId) {
    return NextResponse.json(
      { error: "A valid tenantId is required." },
      { status: 400 },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const installation = await markProviderInstallationInstalled(
      tx as Prisma.TransactionClient,
      { provider: CommerceProvider.COMMERCE7, externalAccountId: tenantId },
    );

    // If this tenant was already linked to a Brand before being uninstalled,
    // return that SAME connection to CONNECTED rather than creating a second
    // one. `@@unique([provider, externalAccountId])` makes a duplicate
    // impossible anyway; this branch exists so a reinstall is a reconnect
    // rather than a hard error, and so the Brand relationship survives.
    const connection = await tx.commerceConnection.findUnique({
      where: {
        provider_externalAccountId: {
          provider: CommerceProvider.COMMERCE7,
          externalAccountId: tenantId,
        },
      },
      select: { id: true, brandId: true, status: true, providerClientId: true },
    });

    let reconnected = false;

    if (connection && connection.status !== CommerceConnectionStatus.CONNECTED) {
      await tx.commerceConnection.update({
        where: { id: connection.id },
        data: {
          status: CommerceConnectionStatus.CONNECTED,
          installedAt: new Date(),
          uninstalledAt: null,
        },
      });

      // Only a genuine state transition writes lifecycle history — a repeated
      // install callback for an already-CONNECTED tenant records nothing.
      await recordCommerceConnectionEvent(tx as Prisma.TransactionClient, {
        brandId: connection.brandId,
        provider: CommerceProvider.COMMERCE7,
        eventType: "RECONNECTED",
        snapshot: {
          externalAccountId: tenantId,
          currencyCode: null,
          providerClientId: connection.providerClientId ?? null,
        },
      });

      reconnected = true;
    }

    return {
      reinstalled: installation.reinstalled,
      linked: Boolean(connection),
      reconnected,
    };
  });

  // Sanitized audit line: tenant + outcome only. No credentials, no payload,
  // no installer identity.
  console.log(
    JSON.stringify({
      event: "commerce7_callback",
      topic: "install",
      tenantId,
      reinstalled: result.reinstalled,
      linked: result.linked,
      reconnected: result.reconnected,
    }),
  );

  return NextResponse.json({ ok: true, tenantId, linked: result.linked });
}
