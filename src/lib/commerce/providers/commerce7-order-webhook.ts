/**
 * src/lib/commerce/providers/commerce7-order-webhook.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 4 — shared request handling for the
 * Commerce7 order webhook route. Mirrors `./shopify-order-webhook.ts`'s
 * verify -> resolve -> normalize -> ingest pipeline and response policy,
 * with two provider-specific differences documented below.
 *
 * ===========================================================================
 * AUTHENTICATION: BASIC AUTH, NOT HMAC — SEE
 * `./commerce7-order-webhook-auth.ts` FOR THE FULL JUSTIFICATION
 * ===========================================================================
 * `verifyCommerce7OrderWebhookAuth` proves the REQUEST came from a caller
 * who knows the shared operator-configured credential. Commerce7's generic
 * webhook payload (`{object, action, payload, user, tenantId}`) carries
 * `tenantId` in the BODY rather than in a header covered by a cryptographic
 * body signature — so, UNLIKE Shopify's HMAC (which binds the shop identity
 * to the exact bytes delivered), this mechanism's guarantee is bounded by
 * "the caller knows the shared secret," not "this exact body is untampered
 * and genuinely from Commerce7." This is the explicit trade-off of using
 * the only documented mechanism Commerce7 offers; it is treated as
 * sufficient per this round's explicit permission to use ANY officially
 * documented mechanism, and is called out again in the final round report.
 *
 * ===========================================================================
 * DEDUPLICATION: DIGEST IS PRIMARY, NOT A FALLBACK
 * ===========================================================================
 * Commerce7 documents NO per-delivery unique id header (no
 * `X-Shopify-Webhook-Id` equivalent was found in `webhooks.md` or
 * `app-apis-webhooks.md`). `resolveCommerce7ProviderEventId` therefore
 * ALWAYS uses `digest:<sha256 of the raw body>` — this is Commerce7's
 * PRIMARY dedup key, not a fallback as it is for Shopify. Two byte-identical
 * deliveries correctly deduplicate. The residual risk, stated rather than
 * hidden: two genuinely DIFFERENT logical events whose JSON bodies happen to
 * be byte-identical would collide and the second would read as
 * ALREADY_PROCESSED — in practice this requires the SAME `id`, `action`, and
 * every order field to match exactly, which is a normal case only for a
 * literal redelivery of the same event, not for two distinct events.
 *
 * ===========================================================================
 * SUPPORTED ACTIONS
 * ===========================================================================
 * Only `object: "Order"` with `action: "Create"` or `"Update"` is
 * processed — matching this round's explicit scope ("support Create/Update,
 * avoid duplicate rows"). Any other object/action is a deterministic no-op:
 * 200, not ingested, not an error. `payload.user` is NEVER read for any
 * identity purpose (see the file's `logWebhook` — it is not even in the log
 * line).
 *
 * ===========================================================================
 * RESPONSE POLICY — IDENTICAL TO SHOPIFY'S: 200 = SETTLED, 500 = REDELIVER
 * ===========================================================================
 * See `isRetryableOrderIngestionOutcome` in `../order-ingestion.ts`, the
 * single source of truth this module defers to, same as Shopify's wiring.
 */

import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { CommerceProvider, type CommerceConnectionStatus } from "@prisma/client";
import { normalizeCommerce7Tenant } from "./commerce7";
import { verifyCommerce7OrderWebhookAuth } from "./commerce7-order-webhook-auth";
import type { Commerce7OrderNormalizationContext } from "./commerce7-order-normalizer";
import {
  prepareCommerce7OrderForIngestion,
  type PrepareCommerce7OrderForIngestionResult,
} from "./commerce7-order-refund-reconciliation";
import {
  ingestNormalizedOrder,
  isRetryableOrderIngestionOutcome,
  type OrderIngestionDeps,
} from "../order-ingestion";
import { extractCurrencyCodeFromProviderMetadata } from "../connection-resolver";

const SUPPORTED_ACTIONS = new Set(["Create", "Update"]);

export type Commerce7OrderWebhookConnection = {
  id: string;
  brandId: string;
  currencyCode: string | null;
  /**
   * PHASE 16-18 REPAIR (P1-3): the connection's live status. A fresh
   * independent review found this resolver too permissive — the PRIOR
   * repair (P2-4D) deliberately reused `isIngestibleConnectionStatus`
   * (PENDING / CONNECTED / REQUIRES_RECONNECT all ingestible), reasoning
   * that a webhook needs no outbound token so a REQUIRES_RECONNECT
   * connection's genuine order history should not be discarded. This
   * round's review overrides that judgment call for the WEBHOOK boundary
   * specifically: the required invariant here is `status === CONNECTED`,
   * full stop, before normalization, event-claiming, or any
   * `CommerceOrder`/`CommerceOrderLineItem`/`CommerceOrderEvent` mutation.
   * This is a deliberate, review-mandated TIGHTENING scoped to THIS
   * resolver only — `isIngestibleConnectionStatus` itself is UNCHANGED
   * (still used by `ingestNormalizedOrder`'s own downstream gate, and by
   * Shopify's webhook flow, which this round does not touch) so this
   * narrowing cannot regress Shopify or the shared ingestion service's own
   * behavior for any OTHER caller.
   */
  status: CommerceConnectionStatus;
};

export type Commerce7OrderWebhookDeps = {
  findConnectionByTenant(
    tenant: string,
  ): Promise<Commerce7OrderWebhookConnection | null>;
  ingest: typeof ingestNormalizedOrder;
  /** Forwarded to the ingestion service so tests can inject a DB-free stack. */
  ingestionDeps: Partial<OrderIngestionDeps>;
  /**
   * PHASE 25 — classifies the raw order and, when it carries Commerce7
   * refund evidence, resolves + reconciles it against the ORIGINAL order
   * before ingestion ever sees it — see
   * `./commerce7-order-refund-reconciliation.ts`. The SAME function
   * `./commerce7-order-backfill.ts` uses, so live webhook and manual
   * Catch-Up/Custom-Range repair can never drift onto different refund
   * semantics. Defaults to the real, network-calling implementation; tests
   * inject a DB/network-free stand-in.
   */
  prepareOrder: typeof prepareCommerce7OrderForIngestion;
};

async function defaultFindConnectionByTenant(
  tenant: string,
): Promise<Commerce7OrderWebhookConnection | null> {
  const { default: prisma } = await import("@/lib/prisma");
  const row = await prisma.commerceConnection.findUnique({
    where: {
      provider_externalAccountId: {
        provider: CommerceProvider.COMMERCE7,
        externalAccountId: tenant,
      },
    },
    select: { id: true, brandId: true, providerMetadata: true, status: true },
  });
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    brandId: row.brandId,
    currencyCode: extractCurrencyCodeFromProviderMetadata(row.providerMetadata),
    status: row.status,
  };
}

const DEFAULT_WEBHOOK_DEPS: Commerce7OrderWebhookDeps = {
  findConnectionByTenant: defaultFindConnectionByTenant,
  ingest: ingestNormalizedOrder,
  ingestionDeps: {},
  prepareOrder: prepareCommerce7OrderForIngestion,
};

/** SHA-256 hex digest of the raw request body — the PRIMARY dedup key, see file header. */
export function computeCommerce7PayloadDigest(rawBody: string): string {
  return crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** Always digest-based — see the file header's DEDUPLICATION section. */
export function resolveCommerce7ProviderEventId(payloadDigest: string): string {
  return `digest:${payloadDigest}`;
}

export type Commerce7OrderWebhookResult = {
  handled: boolean;
  outcome: string;
};

/**
 * Runs the full verify -> resolve -> normalize -> ingest pipeline for one
 * Commerce7 order webhook delivery. Never lets an unhandled exception
 * escape — see the identical rationale in
 * `handleShopifyOrderWebhook`.
 */
export async function handleCommerce7OrderWebhook(
  request: NextRequest,
  deps: Partial<Commerce7OrderWebhookDeps> = {},
): Promise<NextResponse> {
  try {
    return await runCommerce7OrderWebhook(request, deps);
  } catch {
    // Not bound and never logged — see the identical rationale in
    // handleShopifyOrderWebhook.
    logWebhook("", "UNEXPECTED_ERROR", null);
    return new NextResponse(null, { status: 500 });
  }
}

async function runCommerce7OrderWebhook(
  request: NextRequest,
  deps: Partial<Commerce7OrderWebhookDeps> = {},
): Promise<NextResponse> {
  const resolved: Commerce7OrderWebhookDeps = { ...DEFAULT_WEBHOOK_DEPS, ...deps };

  // 1. Authenticate BEFORE anything reads the parsed payload.
  const auth = verifyCommerce7OrderWebhookAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const rawBody = await request.text();
  const payloadDigest = computeCommerce7PayloadDigest(rawBody);
  const providerEventId = resolveCommerce7ProviderEventId(payloadDigest);

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    logWebhook("", "MALFORMED_PAYLOAD", null);
    return new NextResponse(null, { status: 200 });
  }

  const body = payload as Record<string, unknown>;
  const object = typeof body.object === "string" ? body.object : null;
  const action = typeof body.action === "string" ? body.action : null;
  const tenant = normalizeCommerce7Tenant(
    typeof body.tenantId === "string" ? body.tenantId : null,
  );

  // 2. Validate object/action BEFORE any connection lookup or ingestion —
  // a deterministic no-op never needs to touch the DB.
  if (object !== "Order" || !action || !SUPPORTED_ACTIONS.has(action)) {
    logWebhook(tenant ?? "", "UNSUPPORTED_EVENT", { object, action });
    return new NextResponse(null, { status: 200 });
  }

  if (!tenant) {
    logWebhook("", "MISSING_TENANT", null);
    return new NextResponse(null, { status: 200 });
  }

  // 3. Resolve tenant to a connection. An unknown tenant is answered 200
  // with no processing — asking Commerce7 to retry would never change that.
  const connection = await resolved.findConnectionByTenant(tenant);
  if (!connection) {
    logWebhook(tenant, "NO_CONNECTION", null);
    return new NextResponse(null, { status: 200 });
  }

  // 3b. PHASE 16-18 REPAIR (P1-3) — resolver-level gate: the exact tenant
  // connection must be `CONNECTED`, full stop, before normalization or
  // event-claiming ever runs (see `Commerce7OrderWebhookConnection.status`'s
  // doc comment for why this is now stricter than the shared
  // `isIngestibleConnectionStatus` predicate). PENDING/REQUIRES_RECONNECT/
  // DISCONNECTED/UNINSTALLED/ERROR are all rejected here, identically:
  // authenticated-but-non-connected is a safe, deterministic, idempotent
  // 200 no-op, matching the unknown-tenant response above — retrying would
  // never change the outcome, and provider-facing behavior for an unknown
  // vs. a known-but-not-connected tenant is deliberately indistinguishable
  // (never leaks lifecycle detail to the provider).
  if (connection.status !== "CONNECTED") {
    logWebhook(tenant, "CONNECTION_NOT_CONNECTED", { status: connection.status });
    return new NextResponse(null, { status: 200 });
  }

  // 4. PREPARE (classify + refund-aware normalize). Currency comes ONLY
  // from the resolved connection — never from the payload, which documents
  // no currency field. See `./commerce7-order-refund-reconciliation.ts` for
  // the classify -> reconcile -> overlay pipeline this now runs through
  // instead of a bare `normalizeCommerce7Order` call.
  const context: Commerce7OrderNormalizationContext = {
    connectionId: connection.id,
    brandId: connection.brandId,
    provider: CommerceProvider.COMMERCE7,
    currencyCode: connection.currencyCode,
  };
  const prepared: PrepareCommerce7OrderForIngestionResult = await resolved.prepareOrder(
    body.payload,
    context,
    tenant,
  );

  // 4b. TRANSIENT refund-reconciliation failure. Mirrors
  // `handleShopifyOrderWebhook`'s TRANSIENT_FAILURE handling exactly: NO
  // claim is taken (ingest is never called), so Commerce7's redelivery of
  // this exact webhook starts completely fresh, and the existing stored
  // order state (if any) is left untouched — never overwritten with a
  // refund-blind guess.
  if (prepared.outcome === "TRANSIENT_FAILURE") {
    logWebhook(tenant, "REFUND_RECONCILIATION_TRANSIENT_FAILURE", null);
    return new NextResponse(null, { status: 500 });
  }

  // 5. Ingest (idempotent). No `expandProductKeyCandidates` override —
  // Commerce7's catalog and order APIs both report the same UUID product-id
  // format, so the generic `providerProductKeyCandidates` default suffices.
  const outcome = await resolved.ingest(
    {
      providerEventId,
      topic: `commerce7:order:${action}`,
      payloadDigest,
      connectionId: connection.id,
      brandId: connection.brandId,
      provider: CommerceProvider.COMMERCE7,
    },
    prepared.order,
    resolved.ingestionDeps,
  );

  logWebhook(tenant, outcome.status, {
    reason: outcome.reason,
    lineItemCount: outcome.lineItemCount,
    attributionLinked: outcome.attributionLinked,
    warnings: prepared.warnings,
    refundReconciliationOutcome: prepared.refundReconciliationOutcome,
    refundReconciliationReason: prepared.refundReconciliationReason,
  });

  return new NextResponse(null, {
    status: isRetryableOrderIngestionOutcome(outcome) ? 500 : 200,
  });
}

function logWebhook(
  tenant: string,
  outcome: string,
  detail: Record<string, unknown> | null,
): void {
  // Sanitized: tenant, classified outcome/warning tags, and counts only. No
  // customer field, no order total, no payload excerpt, no credential, and
  // NEVER the payload's `user` field.
  console.log(
    JSON.stringify({
      event: "commerce7_order_webhook",
      tenant,
      outcome,
      detail: detail ?? {},
    }),
  );
}
