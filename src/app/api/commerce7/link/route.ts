import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getBrandAdminContext } from "@/lib/brand-auth";
import { resolveLinkIntent } from "@/lib/commerce/provider-installation";
import { linkProviderInstallationToBrand } from "@/lib/commerce/link-connection";

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
    const status = result.reason === "OWNED_BY_OTHER_BRAND" ? 409 : 409;
    const error =
      result.reason === "OWNED_BY_OTHER_BRAND"
        ? "That Commerce7 store is already connected to a different SQRATCH brand. Contact support to transfer it."
        : result.reason === "NOT_INSTALLED"
          ? "The SQRATCH app is no longer installed on that Commerce7 tenant."
          : "This connection link is no longer valid.";

    return NextResponse.json({ error }, { status });
  }

  console.log(
    JSON.stringify({
      event: "commerce7_link",
      tenantId: intent.externalAccountId,
      reconnected: result.reconnected,
    }),
  );

  return NextResponse.json({
    ok: true,
    brandName: authorizedBrand.name,
    reconnected: result.reconnected,
  });
}
