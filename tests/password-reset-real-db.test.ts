import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("PASSWORD_RESET_REAL_DB");
process.env.EMAIL_VERIFICATION_CODE_PEPPER ||= "test-pepper-for-password-reset";

async function world(overrides: { isActive?: boolean; isEmailVerified?: boolean } = {}) {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const oldPassword = "OldPassw0rd!";
  const user = await prisma.user.create({
    data: {
      email: `${key}@example.test`, name: "Synthetic", password: await bcrypt.hash(oldPassword, 4),
      isEmailVerified: overrides.isEmailVerified ?? true, isActive: overrides.isActive ?? true,
    },
  });
  return { prisma, user, oldPassword, cleanup: () => prisma.user.deleteMany({ where: { id: user.id } }) };
}
const allow = () => ({ success: true, remaining: 5, resetAt: Date.now() + 1000 });
const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("forgot then reset: one-time token, new password, sessions revoked, email verification untouched", { skip: skipReason }, async () => {
  const { forgotPasswordImpl } = await import("../src/app/api/auth/forgot-password/route");
  const { resetPasswordImpl } = await import("../src/app/api/auth/reset-password/route");
  const { authOptions } = await import("../src/app/api/auth/[...nextauth]/options");
  const w = await world({ isEmailVerified: false });
  try {
    const mails: Array<{ email: string; token: string }> = [];
    const pending: Array<Promise<void>> = [];
    const forgotDeps = {
      db: w.prisma, rateLimit: allow,
      sendResetEmail: async (m: { email: string; token: string }) => { mails.push(m); },
      runAfterResponse: (task: () => Promise<void>) => { pending.push(task()); },
    };
    const unknown = await forgotPasswordImpl(post("/api/auth/forgot-password", { email: `${randomUUID()}@example.test` }), forgotDeps);
    const known = await forgotPasswordImpl(post("/api/auth/forgot-password", { email: w.user.email }), forgotDeps);
    await Promise.all(pending);
    assert.deepEqual(await unknown.json(), await known.json());
    assert.equal(mails.length, 1);
    const { token } = mails[0];

    const stored = await w.prisma.passwordResetToken.findMany({ where: { userId: w.user.id } });
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].tokenHash, token);
    assert.ok(stored[0].expires.getTime() - Date.now() <= 30 * 60 * 1000 + 5000);

    const jwt = authOptions.callbacks!.jwt!;
    const before = await jwt({ token: { id: w.user.id, sessionVersion: 0 } } as never);
    assert.equal((before as { accountInvalidated?: boolean }).accountInvalidated, undefined);

    const resetDeps = { db: w.prisma, rateLimit: allow };
    const weak = await resetPasswordImpl(post("/api/auth/reset-password", { token, password: "short" }), resetDeps);
    assert.equal(weak.status, 400);
    assert.equal(await w.prisma.passwordResetToken.count({ where: { userId: w.user.id, consumedAt: null } }), 1, "a weak password does not spend the token");

    const ok = await resetPasswordImpl(post("/api/auth/reset-password", { token, password: "NewPassw0rd!", confirmPassword: "NewPassw0rd!" }), resetDeps);
    assert.equal(ok.status, 200);
    const after = await w.prisma.user.findUniqueOrThrow({ where: { id: w.user.id } });
    assert.equal(await bcrypt.compare("NewPassw0rd!", after.password!), true);
    assert.equal(await bcrypt.compare(w.oldPassword, after.password!), false);
    assert.equal(after.sessionVersion, w.user.sessionVersion + 1);
    assert.equal(after.isEmailVerified, false);

    const stale = await jwt({ token: { id: w.user.id, sessionVersion: 0 } } as never);
    assert.equal((stale as { accountInvalidated?: boolean }).accountInvalidated, true, "pre-reset sessions are rejected");

    const reuse = await resetPasswordImpl(post("/api/auth/reset-password", { token, password: "Another1Pass!" }), resetDeps);
    assert.equal(reuse.status, 400);
    assert.equal(await bcrypt.compare("NewPassw0rd!", (await w.prisma.user.findUniqueOrThrow({ where: { id: w.user.id } })).password!), true);
  } finally {
    await w.cleanup();
  }
});

test("a newer token replaces the older one, and concurrent requests leave exactly one valid token", { skip: skipReason }, async () => {
  const { issuePasswordResetToken, resetPasswordWithToken } = await import("../src/lib/auth/password-reset");
  const w = await world();
  try {
    const first = await issuePasswordResetToken(w.prisma, w.user.id);
    const second = await issuePasswordResetToken(w.prisma, w.user.id);
    assert.equal((await resetPasswordWithToken(w.prisma, { token: first.token, newPassword: "NewPassw0rd!" })).status, "invalid");

    await Promise.all(Array.from({ length: 8 }, () => issuePasswordResetToken(w.prisma, w.user.id)));
    assert.equal(await w.prisma.passwordResetToken.count({ where: { userId: w.user.id } }), 1);
    assert.equal((await resetPasswordWithToken(w.prisma, { token: second.token, newPassword: "NewPassw0rd!" })).status, "invalid");
  } finally {
    await w.cleanup();
  }
});

test("expired, unknown, malformed and inactive-account tokens all fail the same way and change nothing", { skip: skipReason }, async () => {
  const { issuePasswordResetToken, resetPasswordWithToken, PASSWORD_RESET_TTL_MS } = await import("../src/lib/auth/password-reset");
  const w = await world();
  const inactive = await world({ isActive: false });
  try {
    const issued = await issuePasswordResetToken(w.prisma, w.user.id);
    const late = new Date(Date.now() + PASSWORD_RESET_TTL_MS + 1000);
    assert.equal((await resetPasswordWithToken(w.prisma, { token: issued.token, newPassword: "NewPassw0rd!" }, late)).status, "invalid");
    assert.equal((await resetPasswordWithToken(w.prisma, { token: "A".repeat(43), newPassword: "NewPassw0rd!" })).status, "invalid");
    assert.equal((await resetPasswordWithToken(w.prisma, { token: "bad", newPassword: "NewPassw0rd!" })).status, "invalid");

    const inactiveToken = await issuePasswordResetToken(inactive.prisma, inactive.user.id);
    assert.equal((await resetPasswordWithToken(inactive.prisma, { token: inactiveToken.token, newPassword: "NewPassw0rd!" })).status, "invalid");

    for (const subject of [w, inactive]) {
      const row = await subject.prisma.user.findUniqueOrThrow({ where: { id: subject.user.id } });
      assert.equal(row.sessionVersion, subject.user.sessionVersion);
      assert.equal(await bcrypt.compare(subject.oldPassword, row.password!), true);
    }
    // The unexpired token still works once the clock is honest.
    assert.equal((await resetPasswordWithToken(w.prisma, { token: issued.token, newPassword: "NewPassw0rd!" })).status, "reset");
  } finally {
    await w.cleanup();
    await inactive.cleanup();
  }
});

test("simultaneous submissions of one token change the password exactly once", { skip: skipReason }, async () => {
  const { issuePasswordResetToken, resetPasswordWithToken } = await import("../src/lib/auth/password-reset");
  const w = await world();
  try {
    const { token } = await issuePasswordResetToken(w.prisma, w.user.id);
    const passwords = Array.from({ length: 6 }, (_, i) => `Concurrent${i}Pass!`);
    const outcomes = await Promise.all(passwords.map((newPassword) => resetPasswordWithToken(w.prisma, { token, newPassword })));
    assert.equal(outcomes.filter((o) => o.status === "reset").length, 1);
    assert.equal(outcomes.filter((o) => o.status === "invalid").length, 5);
    const row = await w.prisma.user.findUniqueOrThrow({ where: { id: w.user.id } });
    assert.equal(row.sessionVersion, w.user.sessionVersion + 1);
    const winner = outcomes.findIndex((o) => o.status === "reset");
    assert.equal(await bcrypt.compare(passwords[winner], row.password!), true);
  } finally {
    await w.cleanup();
  }
});

test("a reset and a new request for the same account at the same moment neither deadlock nor lose the account", { skip: skipReason }, async () => {
  const { issuePasswordResetToken, resetPasswordWithToken } = await import("../src/lib/auth/password-reset");
  const w = await world();
  try {
    for (let round = 0; round < 5; round++) {
      const { token } = await issuePasswordResetToken(w.prisma, w.user.id);
      const [reset, reissued] = await Promise.all([
        resetPasswordWithToken(w.prisma, { token, newPassword: `Round${round}Passw0rd!` }),
        issuePasswordResetToken(w.prisma, w.user.id),
      ]);
      assert.ok(["reset", "invalid"].includes(reset.status));
      assert.ok(reissued.token);
    }
    assert.equal(await w.prisma.passwordResetToken.count({ where: { userId: w.user.id } }), 1);
  } finally {
    await w.cleanup();
  }
});

test("an address transfer or a password change cancels outstanding reset links", { skip: skipReason }, async () => {
  const { issuePasswordResetToken, resetPasswordWithToken } = await import("../src/lib/auth/password-reset");
  const { transferUserEmail } = await import("../src/lib/auth/transfer-email");
  const w = await world();
  const admin = await w.prisma.user.create({ data: { email: `${randomUUID()}-admin@example.test`, role: "ADMIN", password: "x" } });
  try {
    const mailedToOldAddress = await issuePasswordResetToken(w.prisma, w.user.id);
    await transferUserEmail(w.prisma, { actingAdminId: admin.id, targetUserId: w.user.id, newEmail: `${randomUUID()}@example.test` });
    assert.equal(await w.prisma.passwordResetToken.count({ where: { userId: w.user.id } }), 0);
    assert.equal((await resetPasswordWithToken(w.prisma, { token: mailedToOldAddress.token, newPassword: "NewPassw0rd!" })).status, "invalid");

    const second = await issuePasswordResetToken(w.prisma, w.user.id);
    const { default: prismaClient } = await import("../src/lib/prisma");
    await prismaClient.$transaction(async (tx) => {
      await tx.user.update({ where: { id: w.user.id }, data: { sessionVersion: { increment: 1 } } });
      await tx.passwordResetToken.deleteMany({ where: { userId: w.user.id } });
    });
    assert.equal((await resetPasswordWithToken(w.prisma, { token: second.token, newPassword: "NewPassw0rd!" })).status, "invalid");
  } finally {
    await w.prisma.user.deleteMany({ where: { id: admin.id } });
    await w.cleanup();
  }
});
