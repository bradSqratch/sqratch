import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  getAllCommerceConnectionsForBrand,
  isConnectionUsable,
  toSafeConnectionSummary,
  type CommerceConnectionListResult,
} from "@/lib/commerce/connection-service";

/**
 * `GET /api/brand/commerce/connections`
 *
 * PHASE 16 BIG ROUND / SUBPHASE 3 — the full-list counterpart to
 * `/api/brand/commerce/status` (which reports only the single PREFERRED
 * connection). A multi-provider/multi-account selector UI needs every
 * connection the brand actually has, sanitized (no secrets/tokens — see
 * `toSafeConnectionSummary`), so it can auto-select when exactly one usable
 * connection exists and otherwise let the Brand Admin choose an explicit
 * `provider` + `connectionId` before syncing or configuring anything.
 *
 * PHASE 18 REPAIR (P2-4B): `complete` is now propagated end to end. A
 * per-provider read failure inside `getAllCommerceConnectionsForBrand` no
 * longer silently reads as "that provider simply has zero connections" —
 * `autoSelectConnectionId` is FORCED `null` whenever `complete: false`,
 * even if exactly one connection happens to be visible, because there is no
 * way to know whether a hidden failed provider ALSO has one (which would
 * make the visible one not actually the brand's only connection). The
 * internal failure reason itself is never exposed to the client — only the
 * fact that completeness could not be established.
 */
export type BrandCommerceConnectionsDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  getConnections(brandId: string): Promise<CommerceConnectionListResult>;
};

const DEFAULT_DEPS: BrandCommerceConnectionsDeps = {
  getContext: getBrandManagementContext,
  getConnections: (brandId) => getAllCommerceConnectionsForBrand(brandId),
};

export async function GET() {
  return commerceConnectionsGetImpl();
}

export async function commerceConnectionsGetImpl(
  overrides: Partial<BrandCommerceConnectionsDeps> = {},
) {
  const deps: BrandCommerceConnectionsDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const brand = context.membership.brand;
    const result = await deps.getConnections(brand.id);
    const safe = result.connections.map(toSafeConnectionSummary);
    const usable = safe.filter(isConnectionUsable);

    return NextResponse.json({
      data: {
        connections: safe.map((connection) => ({
          connectionId: connection.id,
          provider: connection.provider,
          status: connection.status,
          displayName: connection.displayName,
          externalAccountId: connection.externalAccountId,
          isConnected: connection.status === "CONNECTED",
          lastProductSyncAt: connection.lastProductSyncAt,
          storefrontUrl: connection.storefrontUrl,
          currencyCode: connection.currencyCode,
          productRoute: connection.productRoute ?? null,
        })),
        // Whether EVERY provider was successfully queried. A caller must
        // treat `false` as "this list may be missing connections" — never
        // as "the brand genuinely has fewer connections than it does."
        complete: result.complete,
        // Convenience for the common case: exactly one usable (CONNECTED)
        // connection AND a complete read means the UI can auto-select it
        // instead of forcing a choice. `null` whenever the read is
        // incomplete (regardless of how many connections are visible), or
        // when zero/more-than-one qualify — the caller must then show
        // either an empty state, a controlled error, or an explicit
        // selector, never silently proceed on unverified completeness.
        autoSelectConnectionId:
          result.complete && usable.length === 1 ? usable[0].id : null,
      },
    });
  } catch (error) {
    console.error("[brand/commerce/connections][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load commerce connections." },
      { status: 500 },
    );
  }
}
