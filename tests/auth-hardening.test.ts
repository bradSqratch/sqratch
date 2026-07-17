import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareEmailVerificationCodeHash,
  generateEmailVerificationCode,
  hashEmailVerificationCode,
} from "@/lib/auth/email-verification-crypto";
import { isValidSessionId } from "@/lib/session-id";

test("email verification codes are cryptographically generated six-digit values", () => {
  const code = generateEmailVerificationCode();
  assert.match(code, /^\d{6}$/);
});

test("email verification hashes use the configured pepper and constant-time comparison", () => {
  process.env.EMAIL_VERIFICATION_CODE_PEPPER = "test-only-email-pepper";
  const hash = hashEmailVerificationCode("person@example.com", "123456");
  assert.equal(
    compareEmailVerificationCodeHash(hash, hash),
    true,
  );
  assert.equal(
    compareEmailVerificationCodeHash(hash, `${hash}0`),
    false,
  );
});

test("anonymous session identifiers accept only generated hex format", () => {
  assert.equal(isValidSessionId("a".repeat(48)), true);
  assert.equal(isValidSessionId("a".repeat(47)), false);
  assert.equal(isValidSessionId("a".repeat(49)), false);
  assert.equal(isValidSessionId("../user-session"), false);
});
