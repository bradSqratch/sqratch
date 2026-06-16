/**
 * tests/shopify-session-token.test.ts
 *
 * Unit tests for the Shopify App Bridge session-token verifier.
 *
 * Uses node:test + node:assert/strict.  No network.  No DB.
 *
 * A local `mintToken` helper creates HS256 JWTs so we can test both
 * happy-path and adversarial scenarios without an external library.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Set env vars BEFORE importing the module under test so that any top-level
// reads of process.env see consistent values.
// ---------------------------------------------------------------------------
process.env.SHOPIFY_API_KEY = "test-api-key-12345";
process.env.SHOPIFY_API_SECRET = "test-api-secret-abcdef";

import {
  verifySessionToken,
  verifySessionTokenFromRequest,
  type SessionTokenPayload,
} from "../src/lib/shopify-session-token";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_API_KEY = "test-api-key-12345";
const TEST_API_SECRET = "test-api-secret-abcdef";
const TEST_SHOP_DOMAIN = "mystore.myshopify.com";
const TEST_DEST = `https://${TEST_SHOP_DOMAIN}`;
const TEST_ISS = `${TEST_DEST}/admin`;
const OTHER_SECRET = "completely-different-secret-xyz";
const OTHER_API_KEY = "different-api-key-99999";

/** Fixed "now" used in all time-sensitive assertions (seconds). */
const FIXED_NOW_S = Math.floor(new Date("2026-06-15T12:00:00Z").getTime() / 1000);

// ---------------------------------------------------------------------------
// JWT minting helper
// ---------------------------------------------------------------------------

function base64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

interface MintOptions {
  secret?: string;
  overrides?: Partial<SessionTokenPayload>;
  /** If true, corrupt the signature after signing. */
  corruptSignature?: boolean;
  /** Override the number of dot-separated segments (default: 3). */
  segmentCount?: number;
}

/**
 * Mint a valid-by-default HS256 JWT, then apply any overrides or corruption
 * specified in `options`.
 */
function mintToken(options: MintOptions = {}): string {
  const secret = options.secret ?? TEST_API_SECRET;

  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

  const baseClaims: SessionTokenPayload = {
    aud: TEST_API_KEY,
    dest: TEST_DEST,
    iss: TEST_ISS,
    sub: "42",
    jti: "test-jti-1",
    exp: FIXED_NOW_S + 60,  // 1 minute from now
    nbf: FIXED_NOW_S - 10,  // 10 seconds ago
    iat: FIXED_NOW_S - 10,
  };

  const claims: SessionTokenPayload = { ...baseClaims, ...options.overrides };
  const payload = base64urlEncode(JSON.stringify(claims));

  const signingInput = `${header}.${payload}`;
  let signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  if (options.corruptSignature) {
    // Flip the first character.
    signature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  }

  const fullToken = `${header}.${payload}.${signature}`;

  if (options.segmentCount !== undefined && options.segmentCount !== 3) {
    // Return fewer or more segments as requested.
    const segs = fullToken.split(".");
    if (options.segmentCount < 3) {
      return segs.slice(0, options.segmentCount).join(".");
    }
    // More than 3 — append extra segments.
    const extra = Array(options.segmentCount - 3).fill("extra").join(".");
    return `${fullToken}.${extra}`;
  }

  return fullToken;
}

// ---------------------------------------------------------------------------
// Helper: build a Request with an Authorization header.
// ---------------------------------------------------------------------------
function makeRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) {
    headers["authorization"] = authorization;
  }
  return new Request("https://example.com/api/test", { headers });
}

// ---------------------------------------------------------------------------
// verifySessionToken — happy path
// ---------------------------------------------------------------------------

describe("verifySessionToken — valid token", () => {
  test("returns ok:true with the correct shop hostname", () => {
    const token = mintToken();
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return; // narrow type

    assert.equal(result.shop, TEST_SHOP_DOMAIN);
    assert.equal(result.payload.aud, TEST_API_KEY);
    assert.equal(result.payload.sub, "42");
  });

  test("result does not include the raw token or secret", () => {
    const token = mintToken();
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    const resultStr = JSON.stringify(result);
    assert.ok(
      !resultStr.includes(token),
      "Raw token must not appear in the result",
    );
    assert.ok(
      !resultStr.includes(TEST_API_SECRET),
      "Secret must not appear in the result",
    );
  });
});

// ---------------------------------------------------------------------------
// verifySessionToken — signature verification
// ---------------------------------------------------------------------------

describe("verifySessionToken — signature checks", () => {
  test("rejects a token signed with the wrong secret (bad signature → 401)", () => {
    const token = mintToken({ secret: OTHER_SECRET });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid signature");
  });

  test("rejects a token with a corrupted signature (tampered → 401)", () => {
    const token = mintToken({ corruptSignature: true });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid signature");
  });

  test("rejects a malformed token (only 2 segments → 401)", () => {
    const token = mintToken({ segmentCount: 2 });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "malformed token");
  });

  test("rejects a malformed token (only 1 segment → 401)", () => {
    const result = verifySessionToken({
      token: "notavalidjwt",
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "malformed token");
  });

  test("rejects a token for a different app (different secret → invalid signature)", () => {
    // Token signed with OTHER_SECRET but presented with TEST_API_SECRET
    const token = mintToken({ secret: OTHER_SECRET, overrides: { aud: OTHER_API_KEY } });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    // Signature fails first (before audience check), so status is 401.
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid signature");
  });
});

// ---------------------------------------------------------------------------
// verifySessionToken — audience claim
// ---------------------------------------------------------------------------

describe("verifySessionToken — audience check", () => {
  test("rejects token with wrong aud → 403", () => {
    // Signed with the correct secret but aud points to a different app.
    const token = mintToken({ overrides: { aud: OTHER_API_KEY } });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.equal(result.reason, "wrong audience");
  });
});

// ---------------------------------------------------------------------------
// verifySessionToken — time-based claims
// ---------------------------------------------------------------------------

describe("verifySessionToken — time claims", () => {
  test("rejects an expired token (exp in the past → 401)", () => {
    const token = mintToken({
      overrides: {
        exp: FIXED_NOW_S - 60, // 1 minute ago
      },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "token expired");
  });

  test("accepts a token where exp is within the clock skew window", () => {
    // exp is 3 seconds in the past — within the 5s skew allowance.
    const token = mintToken({
      overrides: { exp: FIXED_NOW_S - 3 },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, true);
  });

  test("rejects a token with nbf in the future (not yet valid → 401)", () => {
    const token = mintToken({
      overrides: {
        nbf: FIXED_NOW_S + 60, // 1 minute from now
      },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "token not yet valid");
  });

  test("rejects a token with iat in the future (not yet valid → 401)", () => {
    const token = mintToken({
      overrides: {
        iat: FIXED_NOW_S + 60, // 1 minute from now
        nbf: FIXED_NOW_S - 10, // nbf is fine
      },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "token not yet valid");
  });
});

// ---------------------------------------------------------------------------
// verifySessionToken — dest / iss validation
// ---------------------------------------------------------------------------

describe("verifySessionToken — destination / issuer checks", () => {
  test("rejects when iss hostname differs from dest hostname → 401", () => {
    const token = mintToken({
      overrides: {
        dest: "https://shopA.myshopify.com",
        iss: "https://shopB.myshopify.com/admin",
      },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid destination");
  });

  test("rejects when dest is not a *.myshopify.com domain → 401", () => {
    const token = mintToken({
      overrides: {
        dest: "https://evil.example.com",
        iss: "https://evil.example.com/admin",
      },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid destination");
  });

  test("rejects when dest is a malformed URL → 401", () => {
    const token = mintToken({
      overrides: {
        dest: "not-a-url",
        iss: "not-a-url/admin",
      },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid destination");
  });

  test("rejects when dest host differs from iss host (same TLD, different store) → 401", () => {
    const token = mintToken({
      overrides: {
        dest: "https://store-one.myshopify.com",
        iss: "https://store-two.myshopify.com/admin",
      },
    });
    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid destination");
  });
});

// ---------------------------------------------------------------------------
// verifySessionToken — required sub claim
// ---------------------------------------------------------------------------

describe("verifySessionToken — sub claim", () => {
  test("rejects a token without sub → 401", () => {
    const claims: Partial<SessionTokenPayload> = {
      aud: TEST_API_KEY,
      dest: TEST_DEST,
      iss: TEST_ISS,
      exp: FIXED_NOW_S + 60,
      nbf: FIXED_NOW_S - 10,
      iat: FIXED_NOW_S - 10,
    };
    // Omit sub entirely by building the token manually.
    const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64urlEncode(JSON.stringify(claims));
    const signingInput = `${header}.${payload}`;
    const signature = crypto
      .createHmac("sha256", TEST_API_SECRET)
      .update(signingInput)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    const token = `${header}.${payload}.${signature}`;

    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "missing subject");
  });
});

// ---------------------------------------------------------------------------
// verifySessionTokenFromRequest — Authorization header handling
// ---------------------------------------------------------------------------

describe("verifySessionTokenFromRequest", () => {
  test("returns ok:true for a valid Bearer token", () => {
    // We need to ensure that env vars are correct (set at top of file) and
    // override `now` — but verifySessionTokenFromRequest uses Date.now() so we
    // mint a token valid for the real current time instead.
    const realNowS = Math.floor(Date.now() / 1000);
    const realToken = mintToken({
      overrides: {
        exp: realNowS + 300,
        nbf: realNowS - 10,
        iat: realNowS - 10,
      },
    });

    const req = makeRequest(`Bearer ${realToken}`);
    const result = verifySessionTokenFromRequest(req);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.shop, TEST_SHOP_DOMAIN);
  });

  test("returns 401 when Authorization header is missing", () => {
    const req = makeRequest(); // no Authorization header
    const result = verifySessionTokenFromRequest(req);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "missing token");
  });

  test("returns 401 when Authorization header is present but blank after Bearer", () => {
    const req = makeRequest("Bearer ");
    const result = verifySessionTokenFromRequest(req);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "missing token");
  });

  test("returns 401 when Authorization header does not start with Bearer", () => {
    const token = mintToken();
    const req = makeRequest(`Basic ${token}`);
    const result = verifySessionTokenFromRequest(req);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
    assert.equal(result.reason, "missing token");
  });

  test("propagates token-level errors (bad signature) through the request wrapper", () => {
    const token = mintToken({ corruptSignature: true });
    const req = makeRequest(`Bearer ${token}`);
    const result = verifySessionTokenFromRequest(req);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 401);
  });

  test("returns 401 when SHOPIFY_API_KEY env var is missing", () => {
    const savedKey = process.env.SHOPIFY_API_KEY;
    delete process.env.SHOPIFY_API_KEY;

    try {
      const token = mintToken();
      const req = makeRequest(`Bearer ${token}`);
      const result = verifySessionTokenFromRequest(req);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, 401);
      // Must NOT reveal which env var is missing.
      assert.ok(
        !result.reason.includes("SHOPIFY_API_KEY"),
        "Reason must not name the missing env var",
      );
    } finally {
      process.env.SHOPIFY_API_KEY = savedKey;
    }
  });

  test("returns 401 when SHOPIFY_API_SECRET env var is missing", () => {
    const savedSecret = process.env.SHOPIFY_API_SECRET;
    delete process.env.SHOPIFY_API_SECRET;

    try {
      const token = mintToken();
      const req = makeRequest(`Bearer ${token}`);
      const result = verifySessionTokenFromRequest(req);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.status, 401);
      assert.ok(
        !result.reason.includes("SHOPIFY_API_SECRET"),
        "Reason must not name the missing env var",
      );
    } finally {
      process.env.SHOPIFY_API_SECRET = savedSecret;
    }
  });

  test("result from request wrapper does not contain raw token or secret", () => {
    const token = mintToken({ corruptSignature: true });
    const req = makeRequest(`Bearer ${token}`);
    const result = verifySessionTokenFromRequest(req);

    const resultStr = JSON.stringify(result);
    assert.ok(
      !resultStr.includes(TEST_API_SECRET),
      "Secret must not appear in result",
    );
    // Token itself should not be echoed back.
    assert.ok(
      !resultStr.includes(token),
      "Raw token must not appear in result",
    );
  });
});

// ---------------------------------------------------------------------------
// Security property: signature verified BEFORE claims are parsed/trusted
// ---------------------------------------------------------------------------

describe("Security: signature checked before claims trusted", () => {
  test("a token with valid-looking claims but wrong secret is rejected at signature step", () => {
    // This token would pass all claim checks if claims were parsed first,
    // but it is signed with the wrong secret.
    const token = mintToken({
      secret: OTHER_SECRET,
      overrides: {
        aud: TEST_API_KEY,  // audience looks correct
        dest: TEST_DEST,
        iss: TEST_ISS,
        sub: "100",
        exp: FIXED_NOW_S + 3600,
        nbf: FIXED_NOW_S - 10,
        iat: FIXED_NOW_S - 10,
      },
    });

    const result = verifySessionToken({
      token,
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      now: FIXED_NOW_S,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    // Must be 401 "invalid signature" — NOT a claim-level error like "wrong audience".
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid signature");
  });
});
