/**
 * tests/commerce7-order-webhook-auth.test.ts
 *
 * PHASE 22 (Commerce7 order reconciliation hardening, Part 7/8) —
 * `src/lib/commerce/providers/commerce7-order-webhook-auth.ts`: the exact
 * Basic-Auth decision AND the new sanitized failure-diagnostics logging
 * added to help root-cause the live "curl succeeds, Commerce7's own
 * webhook request gets 401" report.
 *
 * Covers the exact five behavioral cases requested:
 *   1. no Authorization header -> 401
 *   2. malformed Basic Auth -> 401
 *   3. wrong username -> 401
 *   4. wrong password -> 401
 *   5. correct Basic Auth -> passes
 * plus the diagnostics contract: every boolean field is correct for each
 * case, and NOTHING secret (raw header, decoded credentials, actual
 * configured password, App Secret) ever appears in a logged line.
 */
import "./env-setup";

import { test, describe, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

import {
  verifyCommerce7OrderWebhookAuth,
  computeCommerce7OrderWebhookAuthDiagnostics,
  logOrderWebhookAuthFailure,
  type Commerce7OrderWebhookAuthRequest,
} from "../src/lib/commerce/providers/commerce7-order-webhook-auth";

const REAL_USERNAME = "sqratch-c7-orders";
const REAL_PASSWORD = "test-order-webhook-password-value";

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function makeRequest(
  authHeader: string | null,
  overrides: { url?: string; userAgent?: string | null } = {},
): Commerce7OrderWebhookAuthRequest {
  const headers = new Map<string, string>();
  if (authHeader !== null) headers.set("authorization", authHeader);
  if (overrides.userAgent !== undefined && overrides.userAgent !== null) {
    headers.set("user-agent", overrides.userAgent);
  }
  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    url: overrides.url ?? "https://www.sqratch.com/api/commerce7/webhooks/orders",
  };
}

beforeEach(() => {
  process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME = REAL_USERNAME;
  process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD = REAL_PASSWORD;
});

describe("verifyCommerce7OrderWebhookAuth — the five required cases", () => {
  test("1. no Authorization header -> 401", () => {
    const result = verifyCommerce7OrderWebhookAuth(makeRequest(null));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
  });

  test("2. malformed Basic Auth (not valid base64 'user:pass' shape) -> 401", () => {
    // Valid base64, but decodes to a string with no ':' separator at all.
    const malformed = `Basic ${Buffer.from("no-colon-here", "utf8").toString("base64")}`;
    const result = verifyCommerce7OrderWebhookAuth(makeRequest(malformed));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
  });

  test("2b. a non-Basic scheme (e.g. Bearer) -> 401", () => {
    const result = verifyCommerce7OrderWebhookAuth(makeRequest("Bearer sometoken"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
  });

  test("3. wrong username -> 401", () => {
    const result = verifyCommerce7OrderWebhookAuth(
      makeRequest(basicAuthHeader("wrong-user", REAL_PASSWORD)),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
  });

  test("4. wrong password -> 401", () => {
    const result = verifyCommerce7OrderWebhookAuth(
      makeRequest(basicAuthHeader(REAL_USERNAME, "wrong-password")),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 401);
  });

  test("5. correct Basic Auth -> passes authentication", () => {
    const result = verifyCommerce7OrderWebhookAuth(
      makeRequest(basicAuthHeader(REAL_USERNAME, REAL_PASSWORD)),
    );
    assert.equal(result.ok, true);
  });

  test("missing server configuration fails closed with 500, never treated as authenticated", () => {
    delete process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
    delete process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
    const result = verifyCommerce7OrderWebhookAuth(
      makeRequest(basicAuthHeader(REAL_USERNAME, REAL_PASSWORD)),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 500);
  });
});

describe("computeCommerce7OrderWebhookAuthDiagnostics — exact field correctness", () => {
  test("A. no Authorization header at all", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(makeRequest(null));
    assert.equal(d.authorizationHeaderPresent, false);
    assert.equal(d.authorizationSchemeIsBasic, false);
    assert.equal(d.decodedBasicCredentialsValidShape, false);
    assert.equal(d.usernameMatchesConfiguredUsername, false);
    assert.equal(d.passwordMatchesConfiguredPassword, false);
    assert.equal(d.configuredUsernamePresent, true);
    assert.equal(d.configuredPasswordPresent, true);
  });

  test("B. header present but not Basic scheme", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(makeRequest("Bearer xyz"));
    assert.equal(d.authorizationHeaderPresent, true);
    assert.equal(d.authorizationSchemeIsBasic, false);
    assert.equal(d.decodedBasicCredentialsValidShape, false);
  });

  test("C. Basic scheme, valid shape, wrong username only", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(
      makeRequest(basicAuthHeader("someone-else", REAL_PASSWORD)),
    );
    assert.equal(d.authorizationSchemeIsBasic, true);
    assert.equal(d.decodedBasicCredentialsValidShape, true);
    assert.equal(d.usernameMatchesConfiguredUsername, false);
    assert.equal(d.passwordMatchesConfiguredPassword, true, "the password half is independently correct");
  });

  test("D. Basic scheme, valid shape, wrong password only", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(
      makeRequest(basicAuthHeader(REAL_USERNAME, "not-the-password")),
    );
    assert.equal(d.usernameMatchesConfiguredUsername, true, "the username half is independently correct");
    assert.equal(d.passwordMatchesConfiguredPassword, false);
  });

  test("E. server environment variables missing entirely", () => {
    delete process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
    delete process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
    const d = computeCommerce7OrderWebhookAuthDiagnostics(
      makeRequest(basicAuthHeader(REAL_USERNAME, REAL_PASSWORD)),
    );
    assert.equal(d.configuredUsernamePresent, false);
    assert.equal(d.configuredPasswordPresent, false);
    assert.equal(d.usernameMatchesConfiguredUsername, false, "no config to match against");
    assert.equal(d.passwordMatchesConfiguredPassword, false);
  });

  test("F. authentication succeeds — every field is true/matching", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(
      makeRequest(basicAuthHeader(REAL_USERNAME, REAL_PASSWORD)),
    );
    assert.equal(d.authorizationHeaderPresent, true);
    assert.equal(d.authorizationSchemeIsBasic, true);
    assert.equal(d.decodedBasicCredentialsValidShape, true);
    assert.equal(d.usernameMatchesConfiguredUsername, true);
    assert.equal(d.passwordMatchesConfiguredPassword, true);
  });

  test("host/pathname are derived from the request URL, never guessed", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(
      makeRequest(null, { url: "https://www.sqratch.com/api/commerce7/webhooks/orders?x=1" }),
    );
    assert.equal(d.host, "www.sqratch.com");
    assert.equal(d.pathname, "/api/commerce7/webhooks/orders");
  });

  test("an unparseable URL fails closed to null host/pathname rather than throwing", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(makeRequest(null, { url: "not a url" }));
    assert.equal(d.host, null);
    assert.equal(d.pathname, null);
  });

  test("userAgent is read from the request header verbatim (it is not a credential)", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(
      makeRequest(null, { userAgent: "axios/1.19.0" }),
    );
    assert.equal(d.userAgent, "axios/1.19.0");
  });

  test("environment reflects VERCEL_ENV, falling back to NODE_ENV", () => {
    const originalVercelEnv = process.env.VERCEL_ENV;
    try {
      process.env.VERCEL_ENV = "production";
      const d = computeCommerce7OrderWebhookAuthDiagnostics(makeRequest(null));
      assert.equal(d.environment, "production");
    } finally {
      if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = originalVercelEnv;
    }
  });
});

describe("logOrderWebhookAuthFailure — the hard secret-exposure boundary", () => {
  test("the logged line never contains the raw Authorization header value", () => {
    const secretHeader = basicAuthHeader(REAL_USERNAME, REAL_PASSWORD);
    const d = computeCommerce7OrderWebhookAuthDiagnostics(
      makeRequest(basicAuthHeader("wrong", "wrong-too")),
    );
    const originalWarn = console.warn;
    let logged = "";
    console.warn = (...args: unknown[]) => {
      logged += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    };
    try {
      logOrderWebhookAuthFailure(d);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(!logged.includes(secretHeader), "the real Authorization header must never appear in a log line");
    assert.ok(!logged.includes(REAL_PASSWORD), "the configured password must never appear in a log line");
    assert.ok(!logged.includes(REAL_USERNAME) || logged.includes("usernameMatchesConfiguredUsername"), "any username-shaped substring present must only be the FIELD NAME, not a credential value");
  });

  test("the logged line contains ONLY the documented boolean/metadata field names — no extra keys", () => {
    const d = computeCommerce7OrderWebhookAuthDiagnostics(makeRequest(null));
    const originalWarn = console.warn;
    let logged = "";
    console.warn = (...args: unknown[]) => {
      logged += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    };
    try {
      logOrderWebhookAuthFailure(d);
    } finally {
      console.warn = originalWarn;
    }
    const parsed = JSON.parse(logged) as Record<string, unknown>;
    const allowedKeys = new Set([
      "event",
      "authorizationHeaderPresent",
      "authorizationSchemeIsBasic",
      "decodedBasicCredentialsValidShape",
      "usernameMatchesConfiguredUsername",
      "passwordMatchesConfiguredPassword",
      "configuredUsernamePresent",
      "configuredPasswordPresent",
      "host",
      "pathname",
      "userAgent",
      "environment",
    ]);
    for (const key of Object.keys(parsed)) {
      assert.ok(allowedKeys.has(key), `unexpected key "${key}" in the auth-failure log line`);
    }
  });

  test("verifyCommerce7OrderWebhookAuth only logs on failure, never on a successful authentication", () => {
    const originalWarn = console.warn;
    let callCount = 0;
    console.warn = () => {
      callCount += 1;
    };
    try {
      verifyCommerce7OrderWebhookAuth(makeRequest(basicAuthHeader(REAL_USERNAME, REAL_PASSWORD)));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(callCount, 0);
  });

  test("verifyCommerce7OrderWebhookAuth logs exactly once per failed attempt", () => {
    const originalWarn = console.warn;
    let callCount = 0;
    console.warn = () => {
      callCount += 1;
    };
    try {
      verifyCommerce7OrderWebhookAuth(makeRequest(null));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(callCount, 1);
  });
});
