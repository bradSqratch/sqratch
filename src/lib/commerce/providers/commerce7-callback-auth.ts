/**
 * src/lib/commerce/providers/commerce7-callback-auth.ts
 *
 * PHASE 16B — Basic-auth verification for the install/uninstall callbacks
 * Commerce7 POSTs to SQRATCH.
 *
 * Both callbacks answer with the SAME fixed sanitized body on every failure, so
 * a caller cannot distinguish "no header" from "wrong username" from "wrong
 * password" — and neither the supplied nor the expected credential is ever
 * logged or echoed. Comparison is constant-time via the shared
 * `timingSafeEqualString` helper.
 */

import { NextResponse } from "next/server";
import { timingSafeEqualString } from "@/lib/security/timing-safe-equal";
import { getCommerce7CallbackConfig } from "./commerce7";

export type Commerce7CallbackAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Invalid Commerce7 callback credentials." },
    { status: 401 },
  );
}

/**
 * Verifies `Authorization: Basic <base64(user:pass)>` against backend-only
 * configuration. Returns a ready-to-send response on failure so routes cannot
 * accidentally continue past a failed check.
 */
export function verifyCommerce7CallbackAuth(
  request: { headers: { get(name: string): string | null } },
): Commerce7CallbackAuthResult {
  const config = getCommerce7CallbackConfig();

  if (!config) {
    // Misconfiguration must never read as a successful auth, and must not
    // reveal which variable is missing.
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Commerce7 callback is not configured." },
        { status: 500 },
      ),
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
