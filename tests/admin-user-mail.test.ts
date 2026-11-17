import "./env-setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.EMAIL_VERIFICATION_CODE_PEPPER ||= "test-pepper-for-admin-user-mail";

const throwingDb = new Proxy({}, { get() { throw new Error("database must not be touched"); } }) as never;
const json = (body: unknown) =>
  new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => Promise.resolve({ id });
const never = async () => { throw new Error("mail must not be sent"); };

test("create user is admin-only and does not reach the database or mailer otherwise", async () => {
  const { createUserImpl } = await import("../src/app/api/admin/user-management/get-or-create-users/route");
  for (const session of [null, { user: { role: "USER" } }, { user: { role: "BRAND_ADMIN" } }, { user: {} }]) {
    const response = await createUserImpl(json({ name: "A", email: "a@example.test", password: "Passw0rd!x", role: "USER" }), {
      getSession: async () => session as never, db: throwingDb, sendVerificationEmail: never,
    });
    assert.equal(response.status, 403);
  }
});

test("resend is admin-only, validated before any database or mail work", async () => {
  const { resendVerificationImpl } = await import("../src/app/api/admin/user-management/resend-verification/[id]/route");
  const allow = () => ({ success: true, remaining: 1, resetAt: Date.now() + 1000 });
  for (const session of [null, { user: { id: "u", role: "USER" } }, { user: { role: "ADMIN" } }]) {
    const response = await resendVerificationImpl(new Request("http://localhost/x", { method: "POST" }), params("t"), {
      getSession: async () => session as never, db: throwingDb, sendVerificationEmail: never, rateLimit: allow,
    });
    assert.equal(response.status, 403);
  }
});

test("resend is rate limited per target and per administrator before touching the database", async () => {
  const { resendVerificationImpl } = await import("../src/app/api/admin/user-management/resend-verification/[id]/route");
  const keys: string[] = [];
  const deny = (key: string) => { keys.push(key); return { success: false, remaining: 0, resetAt: Date.now() + 60_000 }; };
  const response = await resendVerificationImpl(new Request("http://localhost/x", { method: "POST" }), params("target-1"), {
    getSession: async () => ({ user: { id: "admin-1", role: "ADMIN" } }), db: throwingDb, sendVerificationEmail: never, rateLimit: deny,
  });
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
  assert.deepEqual(keys, ["admin-resend-verify-admin:admin-1"]);

  const targetKeys: string[] = [];
  const perTargetOnly = (key: string) => { targetKeys.push(key); return key.startsWith("admin-resend-verify:") ? { success: false, remaining: 0, resetAt: Date.now() + 60_000 } : { success: true, remaining: 5, resetAt: Date.now() + 60_000 }; };
  const second = await resendVerificationImpl(new Request("http://localhost/x", { method: "POST" }), params("target-1"), {
    getSession: async () => ({ user: { id: "admin-1", role: "ADMIN" } }), db: throwingDb, sendVerificationEmail: never, rateLimit: perTargetOnly,
  });
  assert.equal(second.status, 429);
  assert.deepEqual(targetKeys, ["admin-resend-verify-admin:admin-1", "admin-resend-verify:target-1"]);
});

test("the create route no longer sends mail inside the creation try block's failure path", () => {
  const source = readFileSync("src/app/api/admin/user-management/get-or-create-users/route.ts", "utf8");
  assert.match(source, /let emailSent = true;\s*try \{\s*await deps\.sendVerificationEmail/);
  assert.match(source, /status: 201/);
  assert.doesNotMatch(source, /from "@\/helpers\/mailer"/);
});

test("the admin page offers Resend email for unverified accounts and surfaces delivery failure", () => {
  const page = readFileSync("src/app/(withSidebar)/admin/user-management/page.tsx", "utf8");
  assert.match(page, /resend-verification\/\$\{user\.id\}/);
  assert.match(page, /isEmailVerified === false/);
  assert.match(page, /created\.emailSent === false/);
});

test("unique-violation detection works for the driver-adapter and legacy error shapes", async () => {
  const { isUniqueViolationOn } = await import("../src/lib/prisma-errors");
  const adapter = { code: "P2002", meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index: "User_email_key" } } } } };
  const adapterFields = { code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields: ["email"] } } } } };
  const legacy = { code: "P2002", meta: { target: ["email"] } };
  const legacyString = { code: "P2002", meta: { target: "User_email_key" } };
  for (const shape of [adapter, adapterFields, legacy, legacyString]) assert.equal(isUniqueViolationOn(shape, "email"), true);
  assert.equal(isUniqueViolationOn({ code: "P2002", meta: { target: ["slug"] } }, "email"), false);
  assert.equal(isUniqueViolationOn({ code: "P2002", meta: { driverAdapterError: { cause: { constraint: { index: "User_emailVerified_key" } } } } }, "email"), false);
  assert.equal(isUniqueViolationOn({ code: "P2025", meta: { target: ["email"] } }, "email"), false);
  assert.equal(isUniqueViolationOn(null, "email"), false);
  assert.equal(isUniqueViolationOn(new Error("x"), "email"), false);
});

test("the password-change and email-transfer transactions both remove pending reset tokens", () => {
  for (const path of ["src/app/api/user/change-password/route.ts", "src/lib/auth/transfer-email.ts"]) {
    assert.match(readFileSync(path, "utf8"), /passwordResetToken\.deleteMany\(\{ where: \{ userId: user\.id \} \}\)/, path);
  }
  const resend = readFileSync("src/app/api/admin/user-management/resend-verification/[id]/route.ts", "utf8");
  assert.match(resend, /welcomeEligible: previous\?\.welcomeEligible \?\? false/);
  assert.match(resend, /!user\.isActive/);
});
