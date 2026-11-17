import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("ADMIN_USER_MAIL_REAL_DB");
process.env.EMAIL_VERIFICATION_CODE_PEPPER ||= "test-pepper-for-admin-user-mail";

const post = (body: unknown) =>
  new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a mail failure leaves a created account and challenge; resend and duplicate creation behave", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { createUserImpl } = await import("../src/app/api/admin/user-management/get-or-create-users/route");
  const { resendVerificationImpl } = await import("../src/app/api/admin/user-management/resend-verification/[id]/route");
  const { verifyAndConsumeEmailVerificationCode } = await import("../src/lib/auth/email-verification");
  const key = randomUUID();
  const email = `${key}@example.test`;
  const admin = { user: { id: "admin-id", role: "ADMIN" } };
  const sent: Array<{ email: string; code: string }> = [];
  let mailWorks = false;
  const mailer = async (to: string, code: string) => {
    if (!mailWorks) throw new Error("synthetic mail outage");
    sent.push({ email: to, code });
  };
  const create = () =>
    createUserImpl(post({ name: "Synthetic", email, password: "Passw0rd!x", role: "USER" }), {
      getSession: async () => admin, db: prisma, sendVerificationEmail: mailer,
    });
  const ok = () => ({ success: true, remaining: 5, resetAt: Date.now() + 1000 });

  try {
    const first = await create();
    assert.equal(first.status, 201);
    const body = await first.json();
    assert.equal(body.emailSent, false);
    assert.equal(body.data.emailSent, false);
    assert.match(body.message, /could not be sent/);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    assert.equal(user.isEmailVerified, false);
    assert.equal(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 1);

    // Retrying creation is still a duplicate, not a second account.
    const duplicate = await create();
    assert.equal(duplicate.status, 409);
    assert.equal(await prisma.user.count({ where: { email } }), 1);

    // Resend while the mailer is still down: reported, challenge replaced, nothing leaked.
    const failedResend = await resendVerificationImpl(post({}), Promise.resolve({ id: user.id }), {
      getSession: async () => admin, db: prisma, sendVerificationEmail: mailer, rateLimit: ok,
    });
    assert.equal(failedResend.status, 200);
    assert.equal((await failedResend.json()).data.emailSent, false);
    assert.equal(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 1);

    // Mailer recovers: resend delivers a code that verifies the account.
    mailWorks = true;
    const resend = await resendVerificationImpl(post({}), Promise.resolve({ id: user.id }), {
      getSession: async () => admin, db: prisma, sendVerificationEmail: mailer, rateLimit: ok,
    });
    assert.equal(resend.status, 200);
    assert.equal((await resend.json()).data.emailSent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, email);
    assert.equal(await verifyAndConsumeEmailVerificationCode(email, sent[0].code), "verified");

    // Verified accounts are refused; unknown ids are 404; non-admins are 403.
    const already = await resendVerificationImpl(post({}), Promise.resolve({ id: user.id }), {
      getSession: async () => admin, db: prisma, sendVerificationEmail: mailer, rateLimit: ok,
    });
    assert.equal(already.status, 409);
    const missing = await resendVerificationImpl(post({}), Promise.resolve({ id: "does-not-exist" }), {
      getSession: async () => admin, db: prisma, sendVerificationEmail: mailer, rateLimit: ok,
    });
    assert.equal(missing.status, 404);
    const denied = await resendVerificationImpl(post({}), Promise.resolve({ id: user.id }), {
      getSession: async () => ({ user: { id: "x", role: "USER" } }), db: prisma, sendVerificationEmail: mailer, rateLimit: ok,
    });
    assert.equal(denied.status, 403);
    assert.equal(sent.length, 1);
  } finally {
    await prisma.emailVerificationToken.deleteMany({ where: { email } });
    await prisma.user.deleteMany({ where: { email } });
  }
});

test("resend keeps a self-signup's welcome eligibility and refuses deactivated accounts", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { resendVerificationImpl } = await import("../src/app/api/admin/user-management/resend-verification/[id]/route");
  const { issueEmailVerificationChallenge } = await import("../src/lib/auth/email-verification");
  const key = randomUUID();
  const user = await prisma.user.create({ data: { email: `${key}@example.test`, isEmailVerified: false } });
  const inactive = await prisma.user.create({ data: { email: `${key}-i@example.test`, isEmailVerified: false, isActive: false } });
  const deps = (sent: string[]) => ({
    getSession: async () => ({ user: { id: "admin-id", role: "ADMIN" } }), db: prisma,
    sendVerificationEmail: async (to: string) => { sent.push(to); },
    rateLimit: () => ({ success: true, remaining: 5, resetAt: Date.now() + 1000 }),
  });
  try {
    await issueEmailVerificationChallenge(prisma, user.id, user.email, { welcomeEligible: true });
    const sent: string[] = [];
    const response = await resendVerificationImpl(new Request("http://localhost/x", { method: "POST" }), Promise.resolve({ id: user.id }), deps(sent));
    assert.equal(response.status, 200);
    assert.equal((await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: user.id } })).welcomeEligible, true);

    const refused = await resendVerificationImpl(new Request("http://localhost/x", { method: "POST" }), Promise.resolve({ id: inactive.id }), deps(sent));
    assert.equal(refused.status, 409);
    assert.deepEqual(sent, [user.email]);
  } finally {
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: [user.id, inactive.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, inactive.id] } } });
  }
});
