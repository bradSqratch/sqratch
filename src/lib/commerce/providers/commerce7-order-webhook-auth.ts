/**
 * src/lib/commerce/providers/commerce7-order-webhook-auth.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 4 — Basic-auth verification for the
 * Commerce7 ORDER webhook subscription.
 *
 * WHY BASIC AUTH, AND WHY THIS IS SAFE TO IMPLEMENT (not invented):
 *   Commerce7's generic webhooks documentation (`webhooks.md`) carries no
 *   authentication information at all. Its App Dev Center webhook
 *   SUBSCRIPTION configuration page (`app-apis-webhooks.md`) DOES document
 *   an optional "Username and Password... to secure the webhook" under an
 *   "Advanced" section — the exact same HTTP Basic Auth mechanism already
 *   implemented and tested for the install/uninstall callbacks
 *   (`./commerce7-callback-auth.ts`). This is a genuine, officially
 *   documented mechanism, not a guess — structurally weaker than a
 *   cryptographic body signature (Commerce7 itself calls it optional, and
 *   its strength is only as good as the operator's own configuration
 *   choice), a caveat repeated in the final round report rather than hidden.
 *
 * Uses a SEPARATE credential (`getCommerce7OrderWebhookConfig`) from the
 * install/uninstall callback's — see that function's doc comment in
 * `./commerce7.ts` for why.
 *
 * Same fixed-sanitized-body-on-every-failure discipline as
 * `verifyCommerce7CallbackAuth`: a caller cannot distinguish "no header"
 * from "wrong username" from "wrong password", and neither the supplied nor
 * the expected credential is ever logged or echoed. Comparison is
 * constant-time via `timingSafeEqualString`.
 */

import { NextResponse } from "next/server";
import { timingSafeEqualString } from "@/lib/security/timing-safe-equal";
import { getCommerce7OrderWebhookConfig } from "./commerce7";

export type Commerce7OrderWebhookAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

function unauthorized(): NextResponse {
  return new NextResponse(null, { status: 401 });
}

/**
 * Verifies `Authorization: Basic <base64(user:pass)>` against backend-only
 * configuration. Returns a ready-to-send response on failure so the route
 * cannot accidentally continue past a failed check.
 *
 * A MISSING configuration is deliberately NOT "open" — it fails closed with
 * a 500, exactly like `verifyCommerce7CallbackAuth`. The order webhook route
 * stays fail-closed until an operator has actually configured this
 * credential pair in both SQRATCH's environment and Commerce7's Dev Center.
 */
export function verifyCommerce7OrderWebhookAuth(
  request: { headers: { get(name: string): string | null } },
): Commerce7OrderWebhookAuthResult {
  const config = getCommerce7OrderWebhookConfig();

  if (!config) {
    return {
      ok: false,
      response: new NextResponse(null, { status: 500 }),
    };
  }

  const header = request.headers.get("authorization");

  if (!header || !header.toLowerCase().startsWith("basic ")) {
    return { ok: false, response: unauthorized() };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return { ok: false, response: unauthorized() };
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return { ok: false, response: unauthorized() };
  }

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  // Both comparisons always run — no short-circuit on the username — so the
  // response time does not reveal which half matched.
  const usernameOk = timingSafeEqualString(username, config.username);
  const passwordOk = timingSafeEqualString(password, config.password);

  if (!usernameOk || !passwordOk) {
    return { ok: false, response: unauthorized() };
  }

  return { ok: true };
}
