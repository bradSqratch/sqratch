import "./env-setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

process.env.EMAIL_VERIFICATION_CODE_PEPPER = "test-pepper-for-password-reset";

const request = (body: unknown, ip = "203.0.113.5") =>
  new NextRequest("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

type FakeUser = { id: string; email: string; name: string | null; isActive: boolean };
function fakeDb(users: FakeUser[]) {
  const tokens: Array<{ userId: string; tokenHash: string; expires: Date }> = [];
  const tx = {
    user: { update: async () => ({}) },
    passwordResetToken: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].userId === where.userId) tokens.splice(i, 1);
      },
      create: async ({ data }: { data: { userId: string; tokenHash: string; expires: Date } }) => { tokens.push(data); },
    },
  };
  const db = {
    user: { findUnique: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { db: db as never, tokens };
}
const allow = () => ({ success: true, remaining: 1, resetAt: Date.now() + 1000 });

test("tokens are random, 43 characters, and stored only as a keyed hash", async () => {
  const lib = await import("../src/lib/auth/password-reset");
  const a = lib.generatePasswordResetToken();
  const b = lib.generatePasswordResetToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 43);
  assert.ok(lib.isWellFormedResetToken(a));
  for (const bad of ["", "short", `${a}x`, `${a.slice(0, 42)}+`, null, undefined, 42]) assert.equal(lib.isWellFormedResetToken(bad), false);
  const hash = lib.hashPasswordResetToken(a);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, lib.hashPasswordResetToken(a));
  assert.ok(!hash.includes(a));
  process.env.EMAIL_VERIFICATION_CODE_PEPPER = "a-different-pepper";
  assert.notEqual(lib.hashPasswordResetToken(a), hash);
  process.env.EMAIL_VERIFICATION_CODE_PEPPER = "test-pepper-for-password-reset";
  assert.equal(lib.PASSWORD_RESET_TTL_MS, 30 * 60 * 1000);
});

test("forgot-password answers identically for existing, unknown and inactive accounts and mails only active ones", async () => {
  const { forgotPasswordImpl } = await import("../src/app/api/auth/forgot-password/route");
  const { db, tokens } = fakeDb([
    { id: "u1", email: "active@example.test", name: "Ada", isActive: true },
    { id: "u2", email: "inactive@example.test", name: null, isActive: false },
  ]);
  const sent: Array<{ email: string; token: string }> = [];
  const pending: Array<Promise<void>> = [];
  const deps = {
    db, rateLimit: allow,
    sendResetEmail: async (input: { email: string; token: string }) => { sent.push(input); },
    runAfterResponse: (task: () => Promise<void>) => { pending.push(task()); },
  };
  const results: Array<{ status: number; body: unknown }> = [];
  for (const email of ["active@example.test", " ACTIVE@Example.test ", "nobody@example.test", "inactive@example.test"]) {
    const response = await forgotPasswordImpl(request({ email }), deps);
    results.push({ status: response.status, body: await response.json() });
  }
  await Promise.all(pending);
  assert.ok(results.every((r) => r.status === 200));
  assert.deepEqual(new Set(results.map((r) => JSON.stringify(r.body))).size, 1);
  assert.deepEqual(sent.map((s) => s.email), ["active@example.test", "active@example.test"]);
  assert.equal(tokens.length, 1, "the second request replaced the first token");
  assert.ok(!JSON.stringify(tokens).includes(sent[1].token), "plaintext token is never stored");
});

test("forgot-password validates input, throttles per IP and silently skips over the per-address limit", async () => {
  const { forgotPasswordImpl } = await import("../src/app/api/auth/forgot-password/route");
  const { db } = fakeDb([{ id: "u1", email: "a@example.test", name: null, isActive: true }]);
  let scheduled = 0;
  const base = { db, sendResetEmail: async () => {}, runAfterResponse: () => { scheduled += 1; } };
  assert.equal((await forgotPasswordImpl(request("not json"), { ...base, rateLimit: allow })).status, 400);
  assert.equal((await forgotPasswordImpl(request({ email: "nope" }), { ...base, rateLimit: allow })).status, 400);
  assert.equal(scheduled, 0);

  const ipDenied = await forgotPasswordImpl(request({ email: "a@example.test" }), {
    ...base, rateLimit: (key: string) => ({ success: !key.includes(":ip:"), remaining: 0, resetAt: Date.now() + 60_000 }),
  });
  assert.equal(ipDenied.status, 429);

  const emailDenied = await forgotPasswordImpl(request({ email: "a@example.test" }), {
    ...base, rateLimit: (key: string) => ({ success: !key.includes(":email:"), remaining: 0, resetAt: Date.now() + 60_000 }),
  });
  assert.equal(emailDenied.status, 200);
  assert.equal(scheduled, 0, "nothing is scheduled once the address is over its limit");
  assert.ok(!JSON.stringify(await emailDenied.json()).includes("limit"));
});

test("reset-password rejects malformed input before touching the database", async () => {
  const { resetPasswordImpl, RESET_LINK_INVALID_MESSAGE } = await import("../src/app/api/auth/reset-password/route");
  const throwingDb = new Proxy({}, { get() { throw new Error("database must not be touched"); } }) as never;
  const post = (body: unknown) => new NextRequest("http://localhost/api/auth/reset-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const deps = { db: throwingDb, rateLimit: allow };

  const weak = await resetPasswordImpl(post({ token: "x", password: "short" }), deps);
  assert.equal(weak.status, 400);
  assert.match((await weak.json()).error, /8-72 characters/);
  const mismatch = await resetPasswordImpl(post({ token: "x", password: "Passw0rd!x", confirmPassword: "other" }), deps);
  assert.equal(mismatch.status, 400);
  const malformed = await resetPasswordImpl(post({ token: "not-a-token", password: "Passw0rd!x" }), deps);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, RESET_LINK_INVALID_MESSAGE);
  const limited = await resetPasswordImpl(post({ token: "x", password: "Passw0rd!x" }), { ...deps, rateLimit: () => ({ success: false, remaining: 0, resetAt: Date.now() + 1000 }) });
  assert.equal(limited.status, 429);
});

test("recovery code never logs tokens or addresses, links carry the token in the fragment, and responses are not cached", () => {
  const files = [
    "src/lib/auth/password-reset.ts",
    "src/app/api/auth/forgot-password/route.ts",
    "src/app/api/auth/reset-password/route.ts",
  ].map((path) => readFileSync(path, "utf8"));
  for (const source of files) {
    for (const match of source.matchAll(/console\.(log|info|warn|error)\(([^;]*)\);/g)) {
      const withoutStrings = match[2].replace(/"[^"]*"/g, "");
      assert.doesNotMatch(withoutStrings, /token|email|password/i, match[0]);
    }
  }
  const mailer = readFileSync("src/helpers/mailer.ts", "utf8");
  assert.match(mailer, /\/reset-password#token=/);
  assert.doesNotMatch(mailer, /reset-password\?token=/);
  for (const route of ["forgot-password", "reset-password"]) {
    assert.match(readFileSync(`src/app/api/auth/${route}/route.ts`, "utf8"), /withAuthNoStore\(/);
  }
  const resetPage = readFileSync("src/app/(auth)/reset-password/page.tsx", "utf8");
  assert.match(resetPage, /window\.history\.replaceState/);
  assert.match(readFileSync("src/app/(auth)/login/page.tsx", "utf8"), /href="\/forgot-password"/);
});
