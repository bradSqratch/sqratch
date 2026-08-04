import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { timingSafeEqualString } from "@/lib/security/timing-safe-equal";

test("matching secrets return true", () => {
  assert.equal(timingSafeEqualString("shared-secret-value", "shared-secret-value"), true);
});

test("a wrong secret returns false", () => {
  assert.equal(timingSafeEqualString("shared-secret-value", "wrong-secret-value"), false);
});

test("a missing incoming value (null, e.g. absent header) returns false without throwing", () => {
  assert.doesNotThrow(() => {
    assert.equal(timingSafeEqualString(null, "shared-secret-value"), false);
  });
});

test("a missing expected value (undefined, e.g. unset env var) returns false without throwing", () => {
  assert.doesNotThrow(() => {
    assert.equal(timingSafeEqualString("shared-secret-value", undefined), false);
  });
});

test("both values missing returns false without throwing", () => {
  assert.doesNotThrow(() => {
    assert.equal(timingSafeEqualString(null, undefined), false);
  });
});

test("different-length secrets return false without throwing", () => {
  assert.doesNotThrow(() => {
    assert.equal(timingSafeEqualString("short", "a-much-longer-secret-value"), false);
  });
});

test("empty strings are treated as missing, not as a valid match", () => {
  assert.equal(timingSafeEqualString("", ""), false);
});

test("comparison failures never include the compared values in a thrown error", () => {
  try {
    timingSafeEqualString("short", "a-much-longer-secret-value");
  } catch (error) {
    // Should never reach here, but if the implementation changes and starts
    // throwing, make sure it at least never leaks either value.
    const message = String(error);
    assert.doesNotMatch(message, /short/);
    assert.doesNotMatch(message, /a-much-longer-secret-value/);
  }
});

test("both internal worker routes use the shared constant-time helper, not ===", () => {
  const emailWorkerSource = readFileSync(
    join(process.cwd(), "src/app/api/internal/email-worker/route.ts"),
    "utf8",
  );
  const reconcileSource = readFileSync(
    join(process.cwd(), "src/app/api/internal/reconcile-redemptions/route.ts"),
    "utf8",
  );

  for (const source of [emailWorkerSource, reconcileSource]) {
    assert.match(source, /timingSafeEqualString/);
    assert.doesNotMatch(source, /got === expected/);
  }
});
