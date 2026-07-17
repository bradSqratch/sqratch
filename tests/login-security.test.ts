import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAuthRequestContext,
  hashLoginEmail,
  logCredentialLoginEvent,
  runWithAuthRequestContext,
} from "@/lib/auth/auth-security";
import {
  AUTH_NO_STORE_CACHE_CONTROL,
  withAuthNoStore,
} from "@/lib/auth/auth-response";

test("credential-login logs use a keyed email hash and a correlation ID", async () => {
  const originalSecret = process.env.NEXTAUTH_SECRET;
  const originalInfo = console.info;
  const rawEmail = "Sensitive.User@example.com";
  const captured: unknown[][] = [];
  let expectedEmailHash = "";
  process.env.NEXTAUTH_SECRET = "test-login-log-secret";
  console.info = (...args: unknown[]) => captured.push(args);

  try {
    expectedEmailHash = hashLoginEmail(rawEmail);
    await runWithAuthRequestContext(
      createAuthRequestContext(
        new Request("https://sqratch.test/api/auth/callback/credentials", {
          headers: { "x-request-id": "request-12345678" },
        }),
      ),
      async () => {
        logCredentialLoginEvent("invalid_credentials", rawEmail);
      },
    );
  } finally {
    console.info = originalInfo;
    if (originalSecret === undefined) {
      delete process.env.NEXTAUTH_SECRET;
    } else {
      process.env.NEXTAUTH_SECRET = originalSecret;
    }
  }

  assert.equal(captured.length, 1);
  const serialized = JSON.stringify(captured[0]);
  assert.doesNotMatch(serialized, new RegExp(rawEmail, "i"));
  assert.doesNotMatch(serialized, /test-login-log-secret/);
  assert.match(serialized, /credential_login/);
  assert.match(serialized, /request-12345678/);
  assert.match(serialized, new RegExp(expectedEmailHash));
});

test("authentication responses are marked no-store without adding sensitive data", async () => {
  const response = withAuthNoStore(
    new Response(JSON.stringify({ ok: false, error: "Invalid credentials." }), {
      headers: { "Content-Type": "application/json" },
    }),
  );

  assert.equal(response.headers.get("Cache-Control"), AUTH_NO_STORE_CACHE_CONTROL);
  assert.equal(response.headers.get("Pragma"), "no-cache");
  const body = await response.text();
  assert.doesNotMatch(body, /password|authorization|session-token/i);
});
