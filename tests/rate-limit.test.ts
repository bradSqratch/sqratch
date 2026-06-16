import assert from "node:assert/strict";
import test from "node:test";

import { rateLimit, getRequestIp, store } from "../src/lib/rate-limit";

// Helper to build a minimal mock request with headers.
function mockRequest(headers: Record<string, string | undefined>) {
  return {
    headers: {
      get(name: string): string | null {
        return headers[name] ?? null;
      },
    },
  };
}

test("rateLimit — passes within limit", () => {
  const key = `test-pass-${Date.now()}-${Math.random()}`;
  const r1 = rateLimit(key, 5, 60_000);
  const r2 = rateLimit(key, 5, 60_000);
  const r3 = rateLimit(key, 5, 60_000);
  assert.equal(r1.success, true);
  assert.equal(r2.success, true);
  assert.equal(r3.success, true);
});

test("rateLimit — rejects after limit exhausted", () => {
  const key = `test-reject-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 5; i++) {
    rateLimit(key, 5, 60_000);
  }
  const r6 = rateLimit(key, 5, 60_000);
  assert.equal(r6.success, false);
  assert.equal(r6.remaining, 0);
});

test("rateLimit — resets after window expiry (via store manipulation)", () => {
  const key = `test-reset-${Date.now()}-${Math.random()}`;
  // Exhaust the limit.
  for (let i = 0; i < 5; i++) {
    rateLimit(key, 5, 60_000);
  }
  assert.equal(rateLimit(key, 5, 60_000).success, false);

  // Simulate window expiry by backdating resetAt.
  store.set(key, { count: 5, resetAt: Date.now() - 1 });

  const after = rateLimit(key, 5, 60_000);
  assert.equal(after.success, true);
  assert.equal(after.remaining, 4);
});

test("rateLimit — remaining count decrements correctly", () => {
  const key = `test-remaining-${Date.now()}-${Math.random()}`;
  const r1 = rateLimit(key, 5, 60_000);
  const r2 = rateLimit(key, 5, 60_000);
  const r3 = rateLimit(key, 5, 60_000);
  assert.equal(r1.remaining, 4);
  assert.equal(r2.remaining, 3);
  assert.equal(r3.remaining, 2);
});

test("rateLimit — different keys are independent", () => {
  const keyA = `test-keyA-${Date.now()}-${Math.random()}`;
  const keyB = `test-keyB-${Date.now()}-${Math.random()}`;

  // Exhaust keyA.
  for (let i = 0; i < 5; i++) {
    rateLimit(keyA, 5, 60_000);
  }
  assert.equal(rateLimit(keyA, 5, 60_000).success, false);

  // keyB should still succeed.
  assert.equal(rateLimit(keyB, 5, 60_000).success, true);
});

test("getRequestIp — parses x-forwarded-for, takes first IP", () => {
  const req = mockRequest({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" });
  assert.equal(getRequestIp(req), "1.2.3.4");
});

test("getRequestIp — falls back to x-real-ip when no forwarded header", () => {
  const req = mockRequest({ "x-real-ip": "10.0.0.1" });
  assert.equal(getRequestIp(req), "10.0.0.1");
});

test("getRequestIp — returns 'unknown' when no IP headers present", () => {
  const req = mockRequest({});
  assert.equal(getRequestIp(req), "unknown");
});
