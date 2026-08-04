import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUMMY_PASSWORD_HASH,
  evaluateCredentialLogin,
  type CredentialLoginDeps,
  type CredentialLoginUser,
} from "@/lib/auth/credential-login";

const REAL_HASH = "real-hash-for-existing-user";
const CORRECT_PASSWORD = "correct-password";

function makeUser(overrides: Partial<CredentialLoginUser> = {}): CredentialLoginUser {
  return {
    id: "user-1",
    name: "Test User",
    email: "user@example.com",
    password: REAL_HASH,
    role: "USER",
    isEmailVerified: true,
    imageUrl: null,
    sessionVersion: 0,
    ...overrides,
  };
}

function makeDeps(overrides: {
  user?: CredentialLoginUser | null;
  hasPendingApproval?: boolean;
}) {
  const calls: Array<{ candidate: string; hash: string }> = [];

  const deps: CredentialLoginDeps = {
    findUserByEmail: async () => overrides.user ?? null,
    hasPendingApproval: async () => overrides.hasPendingApproval ?? false,
    // Simulates bcrypt.compare: only "correct" for the real hash + the fixed
    // correct password, everything else (including the dummy hash) is false.
    comparePassword: async (candidate, hash) => {
      calls.push({ candidate, hash });
      return candidate === CORRECT_PASSWORD && hash === REAL_HASH;
    },
  };

  return { deps, calls };
}

test("nonexistent email + any password returns generic invalid credentials", async () => {
  const { deps } = makeDeps({ user: null });
  const result = await evaluateCredentialLogin(
    { email: "ghost@example.com", password: "whatever" },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, "invalid_credentials");
    assert.equal(result.message, "Invalid email or password");
  }
});

test("existing email + wrong password returns the same generic invalid credentials", async () => {
  const { deps } = makeDeps({ user: makeUser() });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: "wrong-password" },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, "invalid_credentials");
    assert.equal(result.message, "Invalid email or password");
  }
});

test("unverified account + wrong password does not reveal verification state", async () => {
  const { deps } = makeDeps({ user: makeUser({ isEmailVerified: false }) });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: "wrong-password" },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, "invalid_credentials");
  }
});

test("pending applicant + wrong password does not reveal approval state", async () => {
  const { deps } = makeDeps({
    user: makeUser({ role: "CREATOR" }),
    hasPendingApproval: true,
  });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: "wrong-password" },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, "invalid_credentials");
  }
});

test("unverified account + correct password surfaces the verification message", async () => {
  const { deps } = makeDeps({ user: makeUser({ isEmailVerified: false }) });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: CORRECT_PASSWORD },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, "email_unverified");
  }
});

test("pending applicant + correct password surfaces the approval-pending message", async () => {
  const { deps } = makeDeps({
    user: makeUser({ role: "CREATOR" }),
    hasPendingApproval: true,
  });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: CORRECT_PASSWORD },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, "approval_pending");
  }
});

test("verified active account + correct password succeeds", async () => {
  const { deps } = makeDeps({ user: makeUser() });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: CORRECT_PASSWORD },
    deps,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.user.email, "user@example.com");
    assert.equal(result.user.role, "USER");
  }
});

test("ADMIN role bypasses the pending-approval check even with a pending request", async () => {
  const { deps } = makeDeps({
    user: makeUser({ role: "ADMIN" }),
    hasPendingApproval: true,
  });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: CORRECT_PASSWORD },
    deps,
  );
  assert.equal(result.ok, true);
});

test("a missing account still performs a password comparison against the fixed dummy hash", async () => {
  const { deps, calls } = makeDeps({ user: null });
  await evaluateCredentialLogin(
    { email: "ghost@example.com", password: "whatever" },
    deps,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hash, DUMMY_PASSWORD_HASH);
});

test("an existing passwordless account also uses the dummy hash comparison path", async () => {
  const { deps, calls } = makeDeps({ user: makeUser({ password: null }) });
  const result = await evaluateCredentialLogin(
    { email: "user@example.com", password: "whatever" },
    deps,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hash, DUMMY_PASSWORD_HASH);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, "invalid_credentials");
  }
});
