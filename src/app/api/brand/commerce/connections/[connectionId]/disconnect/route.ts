import { NextRequest, NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  disconnectCommerce7Connection,
  type Commerce7DisconnectResult,
} from "@/lib/commerce/providers/commerce7-connection-lifecycle";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "@/lib/commerce/errors";

/**
 * `POST /api/brand/commerce/connections/[connectionId]/disconnect`
 *
 * PHASE 20 HOTFIX (Part 5) — lets a Brand Admin pause a CONNECTED Commerce7
 * connection from inside SQRATCH, without uninstalling the Commerce7 app.
 * See `@/lib/commerce/providers/commerce7-connection-lifecycle` for the full
 * rationale and the exact set of things this deliberately never touches.
 *
 * Deliberately Commerce7-only: the service throws
 * `CommerceConnectionMismatchError` for any other provider — a Shopify
 * connectionId can never reach this write path.
 */
export type Commerce7DisconnectDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  disconnect(
    input: Parameters<typeof disconnectCommerce7Connection>[0],
  ): Promise<Commerce7DisconnectResult>;
};

const DEFAULT_DEPS: Commerce7DisconnectDeps = {
  getContext: getBrandManagementContext,
  disconnect: disconnectCommerce7Connection,
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return commerce7DisconnectPostImpl({}, connectionId);
}

export async function commerce7DisconnectPostImpl(
  overrides: Partial<Commerce7DisconnectDeps> = {},
  connectionId?: string,
) {
  const deps: Commerce7DisconnectDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    if (!connectionId || typeof connectionId !== "string" || !connectionId.trim()) {
      return NextResponse.json(
        { error: "A commerce connection id is required." },
        { status: 400 },
      );
    }

    const brand = context.membership.brand;

    let result: Commerce7DisconnectResult;
    try {
      result = await deps.disconnect({ brandId: brand.id, connectionId });
    } catch (error) {
      // A caller-selected connectionId that does not exist, or does not
      // belong to this brand — deliberately indistinguishable to the caller.
      if (error instanceof CommerceConnectionNotFoundError) {
        return NextResponse.json(
          { error: "That commerce connection was not found.", code: error.code },
          { status: 404 },
        );
      }
      // The connection is real and owned but is not a Commerce7 connection —
      // Shopify connections are never affected by this route.
      if (error instanceof CommerceConnectionMismatchError) {
        return NextResponse.json(
          { error: "That connection is not a Commerce7 connection.", code: error.code },
          { status: 400 },
        );
      }
      // The connection is real, owned, and Commerce7 — but not in a state
      // this action can transition (not CONNECTED, and not already
      // DISCONNECTED, which is handled as a normal idempotent result below).
      if (error instanceof CommerceConnectionNotReadyError) {
        return NextResponse.json(
          { error: "Commerce connection is not connected.", code: error.code },
          { status: 409 },
        );
      }
      throw error;
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[brand/commerce/connections/[connectionId]/disconnect][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to disconnect commerce connection." },
      { status: 500 },
    );
  }
}
