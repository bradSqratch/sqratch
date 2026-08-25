/**
 * src/lib/commerce/providers/commerce7-diagnostics.ts
 *
 * PHASE 18 — PART 13 (folds in PART 11's webhook health and PART 12's
 * order-ingestion visibility): a sanitized, read-only Commerce7 connection
 * diagnostics summary. Every field is a BOOLEAN or a TIMESTAMP derived from
 * already-persisted canonical data — never raw `providerMetadata`, never a
 * credential, never a live provider network call.
 *
 * `orderReadOperational` is a STATIC PRECONDITION check (app-global
 * credentials configured AND connection CONNECTED), never a live
 * `GET /order/{id}` call — this endpoint must be safe and cheap to render
 * on every page load, matching the same "no token refresh / no network
 * call just to render diagnostics" discipline already established for
 * Shopify's own status surfaces.
 *
 * `orderReceiverConfigured` reports SQRATCH's OWN readiness only
 * (`COMMERCE7_ORDER_WEBHOOK_USERNAME`/`PASSWORD` are set). It explicitly
 * does NOT and CANNOT claim "Commerce7's webhook subscription is active" —
 * that fact lives entirely in Commerce7's own App Dev Center and is not
 * observable from here. The two are deliberately never conflated in this
 * module's field names or documentation.
 */

import { CommerceProvider, type CommerceConnectionStatus } from "@prisma/client";
import { getCommerce7AppConfig, getCommerce7OrderWebhookConfig } from "./commerce7";

function readTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type Commerce7ConnectionDiagnosticsRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  storefrontUrl: string | null;
  providerMetadata: unknown;
  lastProductSyncAt: Date | null;
};

export type Commerce7ConnectionDiagnostics = {
  connectionId: string;
  connected: boolean;
  storefrontUrlConfigured: boolean;
  productRouteConfigured: boolean;
  currencyConfigured: boolean;
  productsSynced: boolean;
  lastProductSyncAt: string | null;
  orderReceiverConfigured: boolean;
  latestOrderIngestedAt: string | null;
  latestWebhookProcessedAt: string | null;
  latestFailedWebhookEvent: { receivedAt: string; failureSummary: string | null } | null;
  /** A STATIC precondition check — never a live provider call. See file header. */
  orderReadOperational: boolean;
};

export type Commerce7DiagnosticsDeps = {
  findConnection(connectionId: string): Promise<Commerce7ConnectionDiagnosticsRow | null>;
  hasAnyProduct(connectionId: string): Promise<boolean>;
  findLatestOrderIngestedAt(connectionId: string): Promise<Date | null>;
  findLatestProcessedWebhookAt(connectionId: string): Promise<Date | null>;
  findLatestFailedWebhookEvent(
    connectionId: string,
  ): Promise<{ receivedAt: Date; failureSummary: string | null } | null>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

async function defaultFindConnection(
  connectionId: string,
): Promise<Commerce7ConnectionDiagnosticsRow | null> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findFirst({
    where: { id: connectionId, provider: CommerceProvider.COMMERCE7 },
    select: {
      id: true,
      brandId: true,
      provider: true,
      status: true,
      storefrontUrl: true,
      providerMetadata: true,
      lastProductSyncAt: true,
    },
  });
}

async function defaultHasAnyProduct(connectionId: string): Promise<boolean> {
  const prisma = await getPrisma();
  const row = await prisma.connectedCommerceProduct.findFirst({
    where: { connectionId },
    select: { id: true },
  });
  return row !== null;
}

async function defaultFindLatestOrderIngestedAt(connectionId: string): Promise<Date | null> {
  const prisma = await getPrisma();
  const row = await prisma.commerceOrder.findFirst({
    where: { connectionId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

async function defaultFindLatestProcessedWebhookAt(connectionId: string): Promise<Date | null> {
  const prisma = await getPrisma();
  const row = await prisma.commerceOrderEvent.findFirst({
    where: { connectionId, status: "PROCESSED" },
    orderBy: { receivedAt: "desc" },
    select: { processedAt: true, receivedAt: true },
  });
  return row?.processedAt ?? row?.receivedAt ?? null;
}

async function defaultFindLatestFailedWebhookEvent(
  connectionId: string,
): Promise<{ receivedAt: Date; failureSummary: string | null } | null> {
  const prisma = await getPrisma();
  const row = await prisma.commerceOrderEvent.findFirst({
    where: { connectionId, status: "FAILED" },
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true, failureSummary: true },
  });
  return row ? { receivedAt: row.receivedAt, failureSummary: row.failureSummary } : null;
}

const DEFAULT_DEPS: Commerce7DiagnosticsDeps = {
  findConnection: defaultFindConnection,
  hasAnyProduct: defaultHasAnyProduct,
  findLatestOrderIngestedAt: defaultFindLatestOrderIngestedAt,
  findLatestProcessedWebhookAt: defaultFindLatestProcessedWebhookAt,
  findLatestFailedWebhookEvent: defaultFindLatestFailedWebhookEvent,
};

function readMetadataString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return readTrimmed((raw as Record<string, unknown>)[key]);
}

export async function getCommerce7ConnectionDiagnostics(
  connectionId: string,
  brandId: string,
  deps: Partial<Commerce7DiagnosticsDeps> = {},
): Promise<Commerce7ConnectionDiagnostics | null> {
  const resolved: Commerce7DiagnosticsDeps = { ...DEFAULT_DEPS, ...deps };

  const connection = await resolved.findConnection(connectionId);
  if (!connection || connection.brandId !== brandId) {
    return null;
  }

  const currencyCode = readMetadataString(connection.providerMetadata, "currencyCode");
  const productRoute = readMetadataString(connection.providerMetadata, "productRoute");

  const [hasProducts, latestOrderAt, latestWebhookAt, latestFailedEvent] = await Promise.all([
    resolved.hasAnyProduct(connectionId),
    resolved.findLatestOrderIngestedAt(connectionId),
    resolved.findLatestProcessedWebhookAt(connectionId),
    resolved.findLatestFailedWebhookEvent(connectionId),
  ]);

  const connected = connection.status === "CONNECTED";
  const appConfigured = getCommerce7AppConfig() !== null;

  return {
    connectionId: connection.id,
    connected,
    storefrontUrlConfigured: Boolean(connection.storefrontUrl),
    productRouteConfigured: productRoute !== null,
    currencyConfigured: currencyCode !== null,
    productsSynced: hasProducts,
    lastProductSyncAt: connection.lastProductSyncAt?.toISOString() ?? null,
    orderReceiverConfigured: getCommerce7OrderWebhookConfig() !== null,
    latestOrderIngestedAt: latestOrderAt?.toISOString() ?? null,
    latestWebhookProcessedAt: latestWebhookAt?.toISOString() ?? null,
    latestFailedWebhookEvent: latestFailedEvent
      ? { receivedAt: latestFailedEvent.receivedAt.toISOString(), failureSummary: latestFailedEvent.failureSummary }
      : null,
    // Static precondition only — see file header.
    orderReadOperational: connected && appConfigured,
  };
}
