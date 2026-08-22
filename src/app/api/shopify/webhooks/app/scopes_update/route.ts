/**
 * POST /api/shopify/webhooks/app/scopes_update
 *
 * ===========================================================================
 * WHAT THIS IS — AND WHAT IT IS EMPHATICALLY NOT
 * ===========================================================================
 * Both SQRATCH Shopify configurations use Shopify-MANAGED installation
 * (`use_legacy_install_flow` is `false` in `shopify.app.toml` and absent from
 * `shopify.app.custom.toml`, which means the same thing). Under managed
 * installation Shopify itself decides and applies what an installation holds —
 * including granting a newly-declared scope to an already-installed merchant
 * without a full re-OAuth — and then ANNOUNCES the resulting scope set on the
 * `app/scopes_update` topic.
 *
 * This route is the receiver for that announcement: a passive one-way
 * synchronization of SQRATCH's cached provider-neutral view
 * (`CommerceConnection.grantedScopes`, read by `hasSufficientScopes` /
 * `hasOrderAttributionScope` / `hasThemeVerificationScope`) onto what
 * Shopify reports it has already granted. It grants no permission,
 * approves nothing, and performs no authorization decision. Any future
 * authorization logic belongs in the install/OAuth path, not here.
 *
 * ONE EXCEPTION: it MAY heal a connection stuck in a false, scope-drift-caused
 * `REQUIRES_RECONNECT` back to `CONNECTED` — never a genuine credential
 * failure — via `healScopeDriftReconnect` (`src/lib/shopify-token-manager.ts`).
 * This is not a new authorization decision: the connection was never actually
 * unauthenticated, only mis-flagged by a since-fixed bug that required an
 * optional, additive scope for baseline connectivity. See that function's doc
 * comment for the exact eligibility proof this route supplies.
 *
 * ===========================================================================
 * VERIFICATION — REUSED, NOT REIMPLEMENTED
 * ===========================================================================
 * `verifyShopifyWebhookRequest` (`src/lib/shopify-webhooks.ts`) is called
 * exactly as the sibling routes call it: it reads the body as RAW BYTES,
 * verifies HMAC-SHA-256 over those bytes with a constant-time compare, and only
 * THEN attempts `JSON.parse` (yielding `payload: null` on malformed JSON rather
 * than throwing). Nothing is parsed before it is authenticated, and its 401 /
 * 500 responses are returned verbatim.
 *
 * Topic identity comes from this route's URL PATH, never from the spoofable
 * `x-shopify-topic` header — the convention every existing webhook route here
 * already follows.
 *
 * ===========================================================================
 * IDENTITY: THE SHOP DOMAIN HEADER IS THE ONLY TENANT SELECTOR
 * ===========================================================================
 * The connection row is resolved solely from the verified
 * `X-Shopify-Shop-Domain` header (normalized to trimmed-lowercase by the
 * shared verifier, matching `app/uninstalled`'s exact lookup), against the
 * `@@unique([provider, externalAccountId])` `CommerceConnection` key — no
 * legacy `Brand` lookup at all (Phase 14C-A). NO field of the request
 * body — not `shop_id`, not `id`, not `application_id` — participates in
 * row selection, so a signed payload for shop A can never reach shop B's
 * row. Only the `current` scope list is read out of the body, and only
 * after verification.
 *
 * ===========================================================================
 * RESPONSE POLICY
 * ===========================================================================
 * 401 on an invalid/absent signature (from the shared verifier). 200 for every
 * DETERMINISTIC outcome — applied, unknown shop, malformed payload, or a
 * superseded compare-and-swap — because a Shopify retry of any of those would
 * produce the identical result and only create a retry storm. 500 ONLY for a
 * genuinely transient storage failure, which is the case a retry can fix.
 */

import { NextResponse, type NextRequest } from "next/server";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";
import {
  applyGrantedScopesUpdate,
  healScopeDriftReconnect,
} from "@/lib/shopify-token-manager";

// Topic identity is bound to this route's URL PATH, never to a request header.
const TOPIC = "app/scopes_update";

/**
 * Reads the granted-scope list out of an already-VERIFIED `app/scopes_update`
 * payload and returns it in the comma-separated storage form the scope readers
 * in `shopify-token-manager.ts` expect.
 *
 * Shopify's payload for this topic carries `previous` and `current` scope-handle
 * arrays (plus `id`, `shop_id`, `updated_at`). Only `current` is read — it is
 * the post-change state, i.e. what the installation holds now. `previous` is
 * deliberately ignored: acting on a delta would make the write order-dependent,
 * whereas writing the absolute `current` state is idempotent under retries and
 * self-corrects after any missed delivery.
 *
 * Returns `null` for anything not shaped like that payload (missing `current`,
 * `current` not an array, or any non-string element) so the caller can treat it
 * as a deterministic no-op instead of writing a half-understood value.
 *
 * An EMPTY `current` array is a legitimate, honored state — a verified statement
 * that the installation now holds no scopes — and is stored as an empty string,
 * which every reader correctly treats as insufficient.
 */
export function extractCurrentScopes(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const current = (payload as { current?: unknown }).current;

  if (!Array.isArray(current)) {
    return null;
  }

  if (!current.every((scope): scope is string => typeof scope === "string")) {
    return null;
  }

  return current
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
    .join(",");
}

export async function POST(request: NextRequest) {
  // 1. Authenticate the raw bytes before anything reads the parsed payload.
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  const shopDomain = verification.shop;

  // 2. No shop header -> nothing identifiable to synchronize. Deterministic.
  if (!shopDomain) {
    logScopesUpdate(null, "NO_SHOP_DOMAIN", null);
    return new NextResponse(null, { status: 200 });
  }

  // 3. Read ONLY the scope list from the verified body.
  const grantedScopes = extractCurrentScopes(verification.payload);

  if (grantedScopes === null) {
    logScopesUpdate(shopDomain, "MALFORMED_PAYLOAD", null);
    return new NextResponse(null, { status: 200 });
  }

  // 4. Resolve by verified shop domain and write the cache under a
  //    compare-and-swap scoped to that row's own id (see
  //    `applyGrantedScopesUpdate`). A transient DB failure propagates so the
  //    500 below asks Shopify to retry; nothing else does.
  let outcome: string;
  let healedConnection = false;
  try {
    // `applyGrantedScopesUpdate` already resolves the row once and reports
    // `wasScopeDriftReconnect` from that SAME lookup — a genuine scope-drift
    // REQUIRES_RECONNECT (status REQUIRES_RECONNECT, credential still on
    // file) versus either a healthy connection or a genuine credential
    // failure (which always clears the credential in the same write that
    // sets REQUIRES_RECONNECT — see `markRequiresReconnect`). A second,
    // separate lookup here would be both redundant and racy (two reads of
    // one row are not the atomic read a real concurrent write could
    // interleave with).
    const result = await applyGrantedScopesUpdate({ shopDomain, grantedScopes });
    outcome = result.applied ? "APPLIED" : result.reason;

    // 5. This webhook's arrival is Shopify's own authenticated notice that
    //    the installation is live; combined with the credential-present
    //    signature above, that is exactly the evidence
    //    `healScopeDriftReconnect` requires (see its doc comment). A genuine
    //    credential failure (token already cleared) is never eligible here,
    //    and this never runs for a connection that was already healthy.
    if (result.applied && result.wasScopeDriftReconnect) {
      healedConnection = await healScopeDriftReconnect(
        result.brandId,
        result.connectionId,
      ).catch(() => false);
    }
  } catch {
    // Never log the error object — it can carry a connection string.
    logScopesUpdate(shopDomain, "WRITE_FAILED", grantedScopes);
    return new NextResponse(null, { status: 500 });
  }

  logScopesUpdate(shopDomain, healedConnection ? `${outcome}_HEALED` : outcome, grantedScopes);

  return new NextResponse(null, { status: 200 });
}

/**
 * Sanitized audit log: topic, shop domain, outcome tag, and a scope COUNT.
 * Never a payload excerpt, never a secret, never PII. Scope handles are not
 * logged individually, matching the minimal-log convention of the sibling
 * webhook routes.
 */
function logScopesUpdate(
  shopDomain: string | null,
  outcome: string,
  grantedScopes: string | null,
) {
  console.log(
    JSON.stringify({
      event: "shopify_webhook",
      topic: TOPIC,
      shopDomain: shopDomain || null,
      outcome,
      scopeCount:
        grantedScopes === null
          ? null
          : grantedScopes.split(",").filter(Boolean).length,
    }),
  );
}
