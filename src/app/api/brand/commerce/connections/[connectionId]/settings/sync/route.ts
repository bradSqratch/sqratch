import { NextRequest, NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import { syncCommerce7ConnectionSettings } from "@/lib/commerce/providers/commerce7-settings-sync";
import type { Commerce7StorefrontConfigurationResult } from "@/lib/commerce/providers/commerce7-storefront-configuration";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  CommerceProviderApiError,
} from "@/lib/commerce/errors";

/**
 * `POST /api/brand/commerce/connections/[connectionId]/settings/sync`
 *
 * PHASE 20 (settings sync round, Part 4) — fetches a CONNECTED Commerce7
 * connection's AUTHORITATIVE store settings from Commerce7's Setting API and
 * persists them, replacing the retired manual storefront-configuration form
 * (see `@/lib/commerce/providers/commerce7-settings-sync` for the full
 * fetch-then-persist flow, and `@/lib/commerce/providers/commerce7-settings`
 * for the hard security boundary on the raw Setting response).
 *
 * The tenant used for the Commerce7 request comes ONLY from this exact,
 * brand-owned `CommerceConnection.externalAccountId` — never from the
 * browser. The response body is ALWAYS the narrow safe DTO
 * (`{storefrontUrl, currencyCode, productRoute, requiresProductSync}`),
 * never the raw Commerce7 Setting payload.
 */
export type Commerce7SettingsSyncRouteDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  sync(
    input: Parameters<typeof syncCommerce7ConnectionSettings>[0],
  ): Promise<Commerce7StorefrontConfigurationResult>;
};

const DEFAULT_DEPS: Commerce7SettingsSyncRouteDeps = {
  getContext: getBrandManagementContext,
  sync: syncCommerce7ConnectionSettings,
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return commerce7SettingsSyncPostImpl({}, connectionId);
}

export async function commerce7SettingsSyncPostImpl(
  overrides: Partial<Commerce7SettingsSyncRouteDeps> = {},
  connectionId?: string,
) {
  const deps: Commerce7SettingsSyncRouteDeps = { ...DEFAULT_DEPS, ...overrides };

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

    let result: Commerce7StorefrontConfigurationResult;
    try {
      result = await deps.sync({ brandId: brand.id, connectionId });
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
      // A provider failure (unreachable, credential rejection, malformed or
      // zero/multiple settings rows, missing field) — deliberately sanitized:
      // never surface the underlying provider message/body.
      if (error instanceof CommerceProviderApiError) {
        return NextResponse.json(
          { error: "Could not synchronize settings from Commerce7. Try again shortly." },
          { status: 502 },
        );
      }
      throw error;
    }

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, field: result.field, code: "SETTINGS_INVALID" },
        { status: 422 },
      );
    }

    return NextResponse.json({
      data: {
        storefrontUrl: result.storefrontUrl,
        currencyCode: result.currencyCode,
        productRoute: result.productRoute,
        requiresProductSync: result.requiresProductSync,
      },
    });
  } catch (error) {
    console.error("[brand/commerce/connections/[connectionId]/settings/sync][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to synchronize commerce settings." },
      { status: 500 },
    );
  }
}
