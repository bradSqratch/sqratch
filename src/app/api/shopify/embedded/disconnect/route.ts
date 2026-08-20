import { NextResponse } from "next/server";
import { verifySessionTokenFromRequest } from "@/lib/shopify-session-token";
import {
  disconnectEmbeddedConnectedBrand,
  findEmbeddedConnectedBrand,
  type EmbeddedConnectedBrand,
} from "@/lib/shopify-embedded-connection";

type EmbeddedDisconnectDependencies = {
  verifySessionTokenFromRequest: typeof verifySessionTokenFromRequest;
  findEmbeddedConnectedBrand: (
    shopDomain: string,
    clientId: string,
  ) => Promise<EmbeddedConnectedBrand | null>;
  disconnectEmbeddedConnectedBrand: typeof disconnectEmbeddedConnectedBrand;
};

const realDependencies: EmbeddedDisconnectDependencies = {
  verifySessionTokenFromRequest,
  findEmbeddedConnectedBrand,
  disconnectEmbeddedConnectedBrand,
};

export async function embeddedDisconnectPostImpl(
  request: Request,
  dependencies: EmbeddedDisconnectDependencies = realDependencies,
) {
  const verified = dependencies.verifySessionTokenFromRequest(request);
  if (!verified.ok) {
    console.warn("[shopify/embedded/disconnect]", {
      outcome: "verify_failed",
      status: verified.status,
    });
    return NextResponse.json({ error: "Unauthorized." }, { status: verified.status });
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  if (!clientId) {
    console.error("[shopify/embedded/disconnect]", { outcome: "misconfigured" });
    return NextResponse.json({ error: "Authentication unavailable." }, { status: 401 });
  }

  try {
    const brand = await dependencies.findEmbeddedConnectedBrand(
      verified.shop,
      clientId,
    );

    if (!brand) {
      console.info("[shopify/embedded/disconnect]", {
        outcome: "already_disconnected",
        shop: verified.shop,
      });
      return NextResponse.json({
        data: { linked: false, brandName: null, connectionStatus: null },
      });
    }

    const result = await dependencies.disconnectEmbeddedConnectedBrand({
      brandId: brand.id,
      shopDomain: verified.shop,
      clientId,
    });

    console.info("[shopify/embedded/disconnect]", {
      outcome: result.count === 1 ? "disconnected" : "already_disconnected",
      shop: verified.shop,
    });

    return NextResponse.json({
      data: { linked: false, brandName: null, connectionStatus: null },
    });
  } catch {
    console.error("[shopify/embedded/disconnect]", { outcome: "disconnect_failed" });
    return NextResponse.json(
      { error: "Could not disconnect Shopify." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return embeddedDisconnectPostImpl(request);
}
