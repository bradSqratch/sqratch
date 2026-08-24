import { NextRequest, NextResponse } from "next/server";
import {
  CommerceConnectionStatus,
  CommerceProvider,
  type Prisma,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { verifyCommerce7CallbackAuth } from "@/lib/commerce/providers/commerce7-callback-auth";
import { normalizeCommerce7Tenant } from "@/lib/commerce/providers/commerce7";
import { markProviderInstallationUninstalled } from "@/lib/commerce/provider-installation";
import { recordCommerceConnectionEvent } from "@/lib/commerce/connection-lifecycle";

/**
 * POST /api/commerce7/uninstall
 *
 * The real sandbox uninstall payload is exactly `{ "tenantId": "<tenant>" }`.
 *
 * NO STALE-GENERATION FENCING IS POSSIBLE HERE — AND NONE IS CLAIMED.
 *   Shopify's `app/uninstalled` handler compares a webhook-supplied event
 *   timestamp against the connection's `installedAt` to ignore a redelivered
 *   webhook that arrives after a reinstall. The observed Commerce7 uninstall
 *   payload carries NO event timestamp, generation id, or event id, so that
 *   comparison cannot be reproduced. Inventing one — e.g. comparing against
 *   "now" — would be worse than nothing: it would look like a fence while
 *   actually depending on delivery latency.
 *
 *   PRACTICAL EXPOSURE: a delayed uninstall delivered after a reinstall would
 *   mark the freshly reinstalled tenant UNINSTALLED. The recovery path is
 *   benign and already implemented — the merchant's next install callback
 *   returns the SAME connection to CONNECTED (see ../install/route.ts), no
 *   credential is destroyed (Commerce7 stores none per tenant), and no product,
 *   order, ledger, or history row is deleted by this handler. This limitation
 *   is narrowly scoped to Commerce7 and does not affect Shopify.
 *
 * PRESERVES: the Brand relationship, the CommerceConnection row itself, and all
 * products/orders/history/ledger data. Nothing is deleted here. No
 * CommerceConnectionSecret operation occurs (Commerce7 has none). No Shopify
 * code path is touched.
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
    const installation = await markProviderInstallationUninstalled(
      tx as Prisma.TransactionClient,
      { provider: CommerceProvider.COMMERCE7, externalAccountId: tenantId },
    );

    const connection = await tx.commerceConnection.findUnique({
      where: {
        provider_externalAccountId: {
          provider: CommerceProvider.COMMERCE7,
          externalAccountId: tenantId,
        },
      },
      select: { id: true, brandId: true, status: true, providerClientId: true },
    });

    let connectionTransitioned = false;

    if (connection && connection.status !== CommerceConnectionStatus.UNINSTALLED) {
      await tx.commerceConnection.update({
        where: { id: connection.id },
        data: {
          status: CommerceConnectionStatus.UNINSTALLED,
          uninstalledAt: new Date(),
        },
      });

      // Exactly one lifecycle event, and only on a genuine transition — a
      // duplicate uninstall delivery records nothing further.
      await recordCommerceConnectionEvent(tx as Prisma.TransactionClient, {
        brandId: connection.brandId,
        provider: CommerceProvider.COMMERCE7,
        eventType: "UNINSTALLED",
        snapshot: {
          externalAccountId: tenantId,
          currencyCode: null,
          providerClientId: connection.providerClientId ?? null,
        },
      });

      connectionTransitioned = true;
    }

    return {
      installationTransitioned: installation.transitioned,
      intentsInvalidated: installation.intentsInvalidated,
      connectionTransitioned,
    };
  });

  console.log(
    JSON.stringify({
      event: "commerce7_callback",
      topic: "uninstall",
      tenantId,
      installationTransitioned: result.installationTransitioned,
      connectionTransitioned: result.connectionTransitioned,
      intentsInvalidated: result.intentsInvalidated,
    }),
  );

  return NextResponse.json({ ok: true, tenantId });
}
