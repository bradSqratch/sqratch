import { NextRequest, NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  reconnectCommerce7Connection,
  type Commerce7ReconnectResult,
} from "@/lib/commerce/providers/commerce7-connection-lifecycle";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "@/lib/commerce/errors";

/**
 * `POST /api/brand/commerce/connections/[connectionId]/reconnect`
 *
 * PHASE 20 HOTFIX (Part 6) — the counterpart to `./disconnect`: lets a Brand
 * Admin resume a SQRATCH-DISCONNECTED Commerce7 connection, but ONLY when
 * the Commerce7 app is still actually installed on that exact tenant. This
 * never pretends SQRATCH can remotely reinstall Commerce7, and never bypasses
 * the Commerce7 install callback's own provider authority — it only reads
 * the durable installation record that callback maintains. See
 * `@/lib/commerce/providers/commerce7-connection-lifecycle` for the full
 * rationale.
 *
 * `APP_NOT_INSTALLED`, `COMMERCE7_STORE_ALREADY_CONNECTED`, and
 * `SETTINGS_SYNC_FAILED` are all normal, controlled business outcomes (no
 * mutation occurred for any of them), distinct from the thrown
 * ownership/provider/state errors below. `SETTINGS_SYNC_FAILED`'s `reason`
 * is already a sanitized classification (never a raw provider message/body
 * — see `commerce7-connection-lifecycle.ts`'s `classifyProviderFailure`).
 */
export type Commerce7ReconnectDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  reconnect(
    input: Parameters<typeof reconnectCommerce7Connection>[0],
  ): Promise<Commerce7ReconnectResult>;
};

const DEFAULT_DEPS: Commerce7ReconnectDeps = {
  getContext: getBrandManagementContext,
  reconnect: reconnectCommerce7Connection,
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return commerce7ReconnectPostImpl({}, connectionId);
}

export async function commerce7ReconnectPostImpl(
  overrides: Partial<Commerce7ReconnectDeps> = {},
  connectionId?: string,
) {
  const deps: Commerce7ReconnectDeps = { ...DEFAULT_DEPS, ...overrides };

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

    let result: Commerce7ReconnectResult;
    try {
      result = await deps.reconnect({ brandId: brand.id, connectionId });
    } catch (error) {
      if (error instanceof CommerceConnectionNotFoundError) {
        return NextResponse.json(
          { error: "That commerce connection was not found.", code: error.code },
          { status: 404 },
        );
      }
      if (error instanceof CommerceConnectionMismatchError) {
        return NextResponse.json(
          { error: "That connection is not a Commerce7 connection.", code: error.code },
          { status: 400 },
        );
      }
      if (error instanceof CommerceConnectionNotReadyError) {
        return NextResponse.json(
          { error: "Commerce connection is not connected.", code: error.code },
          { status: 409 },
        );
      }
      throw error;
    }

    if (result.status === "APP_NOT_INSTALLED") {
      return NextResponse.json(
        {
          error: "SQRATCH is no longer installed in this Commerce7 account.",
          code: "APP_NOT_INSTALLED",
        },
        { status: 409 },
      );
    }
    if (result.status === "COMMERCE7_STORE_ALREADY_CONNECTED") {
      return NextResponse.json(
        {
          error:
            "This Brand is already connected to another Commerce7 store. Disconnect the current Commerce7 store before reconnecting this one.",
          code: "COMMERCE7_STORE_ALREADY_CONNECTED",
        },
        { status: 409 },
      );
    }
    if (result.status === "SETTINGS_SYNC_FAILED") {
      return NextResponse.json(
        {
          error: "Could not synchronize settings from Commerce7. Try again shortly.",
          code: "SETTINGS_SYNC_FAILED",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[brand/commerce/connections/[connectionId]/reconnect][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to reconnect commerce connection." },
      { status: 500 },
    );
  }
}
