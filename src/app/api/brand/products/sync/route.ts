import { NextResponse } from "next/server";
import { CommerceProvider } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import {
  syncBrandCommerceProducts,
  syncCommerceConnectionById,
  type ProductSyncOutcome,
} from "@/lib/commerce/product-sync";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  UnsupportedCapabilityError,
  UnsupportedProviderError,
} from "@/lib/commerce/errors";

/**
 * `POST /api/brand/products/sync` — triggers a product sync for the brand's
 * active commerce connection for ONE provider via `syncBrandCommerceProducts`
 * (`src/lib/commerce/product-sync.ts`, which this route never reimplements
 * or bypasses).
 *
 * A `SKIPPED` outcome (no canonical connection) is ALWAYS surfaced as an error — never
 * mapped onto a 200, which would misreport "nothing to sync" as "sync
 * succeeded".
 *
 * Guards against overlapping runs: refuses a new run while a `RUNNING` run
 * for this brand is younger than `RUNNING_RUN_STALE_AFTER_MS`, returning
 * 409. A `RUNNING` row older than that is treated as abandoned (e.g. a
 * crashed process) and does not block a new attempt.
 */

const RUNNING_RUN_STALE_AFTER_MS = 5 * 60 * 1000;

export type RunningSyncRun = { id: string; connectionId: string; startedAt: Date };

export type BrandProductsSyncDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  /** Finds a `RUNNING` sync run for this brand started within the concurrency window, or `null`. */
  findRunningRun(brandId: string, notBefore: Date): Promise<RunningSyncRun | null>;
  /**
   * `connectionId` is OPTIONAL and, when present, is an EXACT
   * `CommerceConnection.id` the caller selected — never merely "sync
   * whichever connection this provider prefers". Ownership/provider
   * verification happens inside `syncCommerceConnectionById`, before any
   * provider I/O; this dep only chooses which entry point to call.
   */
  runSync(
    brandId: string,
    provider: CommerceProvider,
    connectionId: string | null,
  ): Promise<ProductSyncOutcome>;
};

/**
 * PHASE 16C1: the provider is explicit rather than hard-coded, so a brand on
 * Commerce7 syncs through the same neutral service. DEFAULTS to SHOPIFY, so
 * every existing caller (the Products dashboard posts no body) keeps
 * byte-identical behavior. Only the two known providers are accepted — an
 * unrecognized value is rejected rather than silently treated as Shopify.
 */
function parseProvider(value: unknown): CommerceProvider | null {
  if (value === undefined || value === null) {
    return CommerceProvider.SHOPIFY;
  }
  if (value === CommerceProvider.SHOPIFY || value === CommerceProvider.COMMERCE7) {
    return value;
  }
  return null;
}

async function defaultFindRunningRun(
  brandId: string,
  notBefore: Date,
): Promise<RunningSyncRun | null> {
  return prisma.commerceProductSyncRun.findFirst({
    where: { brandId, status: "RUNNING", startedAt: { gte: notBefore } },
    orderBy: [{ startedAt: "desc" }],
    select: { id: true, connectionId: true, startedAt: true },
  });
}

async function defaultRunSync(
  brandId: string,
  provider: CommerceProvider,
  connectionId: string | null,
): Promise<ProductSyncOutcome> {
  if (connectionId) {
    return syncCommerceConnectionById(
      { brandId, provider, connectionId },
      { triggeredBy: "brand-api" },
    );
  }
  return syncBrandCommerceProducts(brandId, provider, {
    triggeredBy: "brand-api",
  });
}

const DEFAULT_DEPS: BrandProductsSyncDeps = {
  getContext: getBrandManagementContext,
  findRunningRun: defaultFindRunningRun,
  runSync: defaultRunSync,
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = body as { provider?: unknown; connectionId?: unknown } | null;
  return productsSyncImpl({}, parsed?.provider, parsed?.connectionId);
}

export async function productsSyncImpl(
  overrides: Partial<BrandProductsSyncDeps> = {},
  requestedProvider?: unknown,
  requestedConnectionId?: unknown,
) {
  const deps: BrandProductsSyncDeps = { ...DEFAULT_DEPS, ...overrides };

  const provider = parseProvider(requestedProvider);
  if (!provider) {
    return NextResponse.json(
      { error: "Unsupported commerce provider.", code: "UNSUPPORTED_PROVIDER" },
      { status: 400 },
    );
  }

  // Only a non-empty string is ever treated as an exact-connection request —
  // anything else silently falls back to the provider-preferred lookup,
  // exactly today's behavior.
  const connectionId =
    typeof requestedConnectionId === "string" && requestedConnectionId.trim()
      ? requestedConnectionId.trim()
      : null;

  try {
    const context = await deps.getContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    // The ONLY brand id ever used below.
    const brand = context.membership.brand;

    const notBefore = new Date(Date.now() - RUNNING_RUN_STALE_AFTER_MS);
    const runningRun = await deps.findRunningRun(brand.id, notBefore);

    if (runningRun) {
      return NextResponse.json(
        {
          error: "A product sync is already in progress for this brand.",
          code: "SYNC_IN_PROGRESS",
          runId: runningRun.id,
        },
        { status: 409 },
      );
    }

    let outcome: ProductSyncOutcome;
    try {
      outcome = await deps.runSync(brand.id, provider, connectionId);
    } catch (error) {
      if (error instanceof UnsupportedProviderError || error instanceof UnsupportedCapabilityError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }
      // A caller-selected connectionId that does not exist, does not belong
      // to this brand, or belongs to a different provider — verified INSIDE
      // syncCommerceConnectionById before any provider I/O. Not-found and
      // wrong-brand are deliberately indistinguishable to the caller.
      if (error instanceof CommerceConnectionNotFoundError) {
        return NextResponse.json(
          { error: "That commerce connection was not found.", code: error.code },
          { status: 404 },
        );
      }
      if (error instanceof CommerceConnectionMismatchError) {
        return NextResponse.json(
          { error: "That connection does not belong to the requested provider.", code: error.code },
          { status: 400 },
        );
      }
      // The connection exists, belongs to this brand, and matches the
      // requested provider — but its lifecycle status is not CONNECTED
      // (UNINSTALLED / DISCONNECTED / REQUIRES_RECONNECT). Distinct from the
      // 404/400 cases above: this is a real, owned, correctly-identified
      // connection, so a controlled 409 is safe to return — never the same
      // 404 used for a foreign/nonexistent id, and never a silent fallback
      // to a different connection.
      if (error instanceof CommerceConnectionNotReadyError) {
        return NextResponse.json(
          { error: "Commerce connection is not connected.", code: error.code },
          { status: 409 },
        );
      }
      throw error;
    }

    if (outcome.status === "SKIPPED") {
      const message =
        outcome.reason === "NO_CONNECTION"
          ? "No commerce connection is configured for this brand."
          : "This brand's commerce connection needs to be reconnected before syncing products.";
      return NextResponse.json({ error: message, code: outcome.reason }, { status: 400 });
    }

    if (outcome.status === "FAILED") {
      return NextResponse.json(
        {
          error: "Product sync failed.",
          code: "SYNC_FAILED",
          runId: outcome.runId,
          failureSummary: outcome.failureSummary,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      data: {
        status: outcome.status,
        connectionId: outcome.connectionId,
        runId: outcome.runId,
        stats: outcome.stats,
        hasNextPage: outcome.hasNextPage,
        failureSummary: outcome.failureSummary,
      },
    });
  } catch (error) {
    console.error("[brand/products/sync][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to sync products." },
      { status: 500 },
    );
  }
}
