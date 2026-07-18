import { NextResponse } from "next/server";
import { verifySessionTokenFromRequest } from "@/lib/shopify-session-token";
import {
  findEmbeddedConnectedBrand,
  type EmbeddedConnectedBrand,
} from "@/lib/shopify-embedded-connection";

type EmbeddedStatusDependencies = {
  verifySessionTokenFromRequest: typeof verifySessionTokenFromRequest;
  findEmbeddedConnectedBrand: (
    shopDomain: string,
    clientId: string,
  ) => Promise<EmbeddedConnectedBrand | null>;
};

const realDependencies: EmbeddedStatusDependencies = {
  verifySessionTokenFromRequest,
  findEmbeddedConnectedBrand,
};

export async function embeddedStatusPostImpl(
  request: Request,
  dependencies: EmbeddedStatusDependencies = realDependencies,
) {
  const verified = dependencies.verifySessionTokenFromRequest(request);
  if (!verified.ok) {
    console.warn("[shopify/embedded/status]", {
      outcome: "verify_failed",
      status: verified.status,
    });
    return NextResponse.json({ error: "Unauthorized." }, { status: verified.status });
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  if (!clientId) {
    console.error("[shopify/embedded/status]", { outcome: "misconfigured" });
    return NextResponse.json({ error: "Authentication unavailable." }, { status: 401 });
  }

  try {
    const brand = await dependencies.findEmbeddedConnectedBrand(
      verified.shop,
      clientId,
    );

    console.info("[shopify/embedded/status]", {
      outcome: brand ? "linked" : "unlinked",
      shop: verified.shop,
    });

    return NextResponse.json({
      data: brand
        ? {
            linked: true,
            brandName: brand.name,
            connectionStatus: brand.shopifyConnectionStatus,
          }
        : {
            linked: false,
            brandName: null,
            connectionStatus: null,
          },
    });
  } catch {
    console.error("[shopify/embedded/status]", { outcome: "lookup_failed" });
    return NextResponse.json(
      { error: "Could not check the Shopify connection." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return embeddedStatusPostImpl(request);
}
