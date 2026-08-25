import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  getCommerce7ConnectionDiagnostics,
  type Commerce7ConnectionDiagnostics,
} from "@/lib/commerce/providers/commerce7-diagnostics";

/**
 * `GET /api/brand/commerce/connections/[connectionId]/diagnostics`
 *
 * PHASE 18 — PART 13 (folds in PART 11 webhook health / PART 12
 * order-ingestion visibility). Sanitized, read-only, cheap to render —
 * never a live provider call, never raw `providerMetadata`, never a
 * secret. Exact-connection + brand-ownership resolved the same
 * indistinguishable way as every other Commerce7 route in this codebase:
 * a foreign-brand or nonexistent connectionId both yield 404.
 */
export type Commerce7DiagnosticsDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  getDiagnostics(
    connectionId: string,
    brandId: string,
  ): Promise<Commerce7ConnectionDiagnostics | null>;
};

const DEFAULT_DEPS: Commerce7DiagnosticsDeps = {
  getContext: getBrandManagementContext,
  getDiagnostics: getCommerce7ConnectionDiagnostics,
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return commerce7DiagnosticsGetImpl({}, connectionId);
}

export async function commerce7DiagnosticsGetImpl(
  overrides: Partial<Commerce7DiagnosticsDeps> = {},
  connectionId?: string,
) {
  const deps: Commerce7DiagnosticsDeps = { ...DEFAULT_DEPS, ...overrides };

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
      return NextResponse.json({ error: "A commerce connection id is required." }, { status: 400 });
    }

    const diagnostics = await deps.getDiagnostics(connectionId, context.membership.brand.id);
    if (!diagnostics) {
      return NextResponse.json({ error: "That commerce connection was not found." }, { status: 404 });
    }

    return NextResponse.json({ data: diagnostics });
  } catch (error) {
    console.error(
      "[brand/commerce/connections/[connectionId]/diagnostics][GET] Error:",
      error,
    );
    return NextResponse.json({ error: "Failed to load diagnostics." }, { status: 500 });
  }
}
