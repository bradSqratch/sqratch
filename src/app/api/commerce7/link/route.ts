import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getBrandAdminContext } from "@/lib/brand-auth";
import { resolveLinkIntent } from "@/lib/commerce/provider-installation";
import { linkProviderInstallationToBrand } from "@/lib/commerce/link-connection";
import { syncCommerce7ConnectionSettings } from "@/lib/commerce/providers/commerce7-settings-sync";

/**
 * POST /api/commerce7/link
 *
 * Confirms a Commerce7 tenant -> SQRATCH Brand link.
 *
 * TWO INDEPENDENT AUTHORITIES MUST BOTH HOLD:
 *   1. The one-time link token, proving a privileged Commerce7 Admin Owner
 *      initiated this from inside the Commerce7 admin.
 *   2. A live SQRATCH session whose user administers the requested Brand.
 *
 * Neither alone is sufficient, and the Brand is never inferred from a matching
 * email address on either side.
 *
 * The token is never logged. All state checks are re-evaluated inside the
 * transaction (see link-connection.ts) so nothing relies on what the page saw.
 *
 * PHASE 20 (settings sync round, Part 7): once the link transaction commits,
 * this route attempts ONE automatic Commerce7 settings synchronization
 * (`syncCommerce7ConnectionSettings`) — deliberately AFTER commit, never
 * inside the secure link transaction, since Commerce7 HTTP must never happen
 * while a lock is held. A settings-sync failure here is non-fatal: the
 * connection this transaction just created/reconnected is left exactly as
 * committed (CONNECTED, but with no/stale storefront config — which is
 * already fail-closed for public product authority, see
 * `commerce7-products.ts`'s `computeCommerce7ProductDestination`), and the
 * response tells the caller settings still need to be synchronized so the UI
 * can prompt a retry rather than silently failing.
 */
export async function POST(request: NextRequest) {
  const context = await getBrandAdminContext({ allowWithoutBrand: true });

  if (!context) {
    return NextResponse.json(
      { error: "Sign in as a SQRATCH brand admin to connect a store." },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    brandId?: unknown;
  } | null;

  const token = typeof body?.token === "string" ? body.token : null;
  const brandId = typeof body?.brandId === "string" ? body.brandId : null;

  if (!token || !brandId) {
    return NextResponse.json(
      { error: "A connection token and brand are required." },
      { status: 400 },
    );
  }

  // The requested Brand must be one this SESSION genuinely administers — never
  // one merely named in the request body.
  const authorizedBrand = context.brands.find((brand) => brand.id === brandId);

  if (!authorizedBrand) {
    return NextResponse.json(
      { error: "You do not have admin access to that brand." },
      { status: 403 },
    );
  }

  const intent = await resolveLinkIntent(prisma, { rawToken: token });

  if (!intent.ok) {
    return NextResponse.json(
      { error: "This connection link is no longer valid." },
      { status: 409 },
    );
  }

  const result = await prisma.$transaction((tx) =>
    linkProviderInstallationToBrand(tx as Prisma.TransactionClient, {
      intentId: intent.intentId,
      installationId: intent.installationId,
      provider: intent.provider,
      externalAccountId: intent.externalAccountId,
      brandId: authorizedBrand.id,
      // Temporary, safe display value. The real provider-side store name is
      // resolved by a later Commerce7 catalog phase; nothing is synthesized
      // into storefrontUrl here.
      displayName: intent.externalAccountId,
    }),
  );

  if (!result.ok) {
    const error =
      result.reason === "OWNED_BY_OTHER_BRAND"
        ? "That Commerce7 store is already connected to a different SQRATCH brand. Contact support to transfer it."
        : result.reason === "NOT_INSTALLED"
          ? "The SQRATCH app is no longer installed on that Commerce7 tenant."
          : result.reason === "COMMERCE7_STORE_ALREADY_CONNECTED"
            ? "This Brand is already connected to another Commerce7 store. Disconnect the current Commerce7 store before connecting this one."
            : "This connection link is no longer valid.";
    const code = result.reason === "COMMERCE7_STORE_ALREADY_CONNECTED" ? "COMMERCE7_STORE_ALREADY_CONNECTED" : undefined;

    return NextResponse.json({ error, ...(code ? { code } : {}) }, { status: 409 });
  }

  console.log(
    JSON.stringify({
      event: "commerce7_link",
      tenantId: intent.externalAccountId,
      reconnected: result.reconnected,
    }),
  );

  // PHASE 20 (Part 7): one automatic settings-sync attempt, strictly AFTER
  // the link transaction has committed — never inside it, and never with
  // any lock held. Non-fatal: the connection this transaction just
  // created/reconnected is preserved exactly as committed either way.
  let settingsSynced = false;
  try {
    const syncResult = await syncCommerce7ConnectionSettings({
      brandId: authorizedBrand.id,
      connectionId: result.connectionId,
    });
    settingsSynced = syncResult.ok;
  } catch (settingsError) {
    console.error(
      JSON.stringify({
        event: "commerce7_link_settings_sync_failed",
        tenantId: intent.externalAccountId,
        message: settingsError instanceof Error ? settingsError.message : "unknown error",
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    brandName: authorizedBrand.name,
    reconnected: result.reconnected,
    settingsSynced,
  });
}
