process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.EMAIL_VERIFICATION_CODE_PEPPER = "test-pepper";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import type { PrismaClient } from "@prisma/client";

type TransferModule = typeof import("../src/lib/auth/transfer-email");
type VerificationModule = typeof import("../src/lib/auth/email-verification");
type TemplatesModule = typeof import("../src/helpers/emailTemplates");

let TransferEmailError: TransferModule["TransferEmailError"];
let normalizeTransferEmail: TransferModule["normalizeTransferEmail"];
let transferUserEmail: TransferModule["transferUserEmail"];
let hashEmailVerificationCode: VerificationModule["hashEmailVerificationCode"];
let issueEmailVerificationChallenge: VerificationModule["issueEmailVerificationChallenge"];
let buildEmailTransferVerificationHtml: TemplatesModule["buildEmailTransferVerificationHtml"];

before(async () => {
  ({ TransferEmailError, normalizeTransferEmail, transferUserEmail } = await import(
    "../src/lib/auth/transfer-email"
  ));
  ({ hashEmailVerificationCode, issueEmailVerificationChallenge } = await import(
    "../src/lib/auth/email-verification"
  ));
  ({ buildEmailTransferVerificationHtml } = await import("../src/helpers/emailTemplates"));
});

type FakeUser = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  password: string | null;
};

function makeDb(users: FakeUser[], options?: { p2002?: boolean }) {
  const state = {
    users: users.map((user) => ({ ...user })),
    userUpdates: [] as Array<Record<string, unknown>>,
    tokensDeleted: [] as string[],
    tokens: [] as Array<{
      userId: string;
      email: string;
      codeHash: string;
      expires: Date;
      welcomeEligible: boolean;
    }>,
  };

  const tx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.users.find((user) => user.id === where.id) ?? null,
      findFirst: async ({
        where,
      }: {
        where: { email: { equals: string; mode?: string } };
      }) => {
        assert.equal(where.email.mode, "insensitive");
        return state.users.find(
          (user) =>
            user.email.toLowerCase() === where.email.equals.toLowerCase(),
        ) ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (options?.p2002) {
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: { target: ["email"] },
          });
        }
        assert.deepEqual(Object.keys(where), ["id"]);
        state.userUpdates.push({ id: where.id, ...data });
        return {};
      },
    },
    emailVerificationToken: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        state.tokensDeleted.push(where.userId);
        return { count: 1 };
      },
      create: async ({ data }: { data: (typeof state.tokens)[number] }) => {
        state.tokens.push(data);
        return data;
      },
    },
  };

  const db = {
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaClient;

  return { db, state };
}

const brand: FakeUser = {
  id: "brand-1",
  name: "Brand Admin",
  email: "setup@temp.test",
  role: "BRAND_ADMIN",
  password: "hash",
};

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TransferEmailError);
    assert.equal((error as InstanceType<TransferModule["TransferEmailError"]>).code, code);
    return true;
  });
}

describe("normalizeTransferEmail", () => {
  test("trims and lowercases", () => {
    assert.equal(normalizeTransferEmail("  Client@Example.COM "), "client@example.com");
  });
  test("rejects malformed and oversized values", () => {
    assert.equal(normalizeTransferEmail(""), null);
    assert.equal(normalizeTransferEmail("not-an-email"), null);
    assert.equal(normalizeTransferEmail("a b@c.com"), null);
    assert.equal(normalizeTransferEmail(`${"a".repeat(250)}@x.com`), null);
  });
});

describe("transferUserEmail", () => {
  test("moves the email, unverifies, bumps sessionVersion and issues a 24h OTP for the new address", async () => {
    const { db, state } = makeDb([{ ...brand }]);
    const before = Date.now();
    const result = await transferUserEmail(db, {
      actingAdminId: "admin-1",
      targetUserId: "brand-1",
      newEmail: "  Client@Example.com ",
    });

    assert.equal(result.newEmail, "client@example.com");
    assert.equal(result.oldEmail, "setup@temp.test");

    assert.deepEqual(state.userUpdates, [
      {
        id: "brand-1",
        email: "client@example.com",
        isEmailVerified: false,
        emailVerifiedAt: null,
        sessionVersion: { increment: 1 },
      },
    ]);

    assert.deepEqual(state.tokensDeleted, ["brand-1"]);
    assert.equal(state.tokens.length, 1);
    const token = state.tokens[0];
    assert.equal(token.email, "client@example.com");
    assert.equal(token.welcomeEligible, false);
    const ttl = token.expires.getTime() - before;
    assert.ok(ttl > 23.9 * 3600_000 && ttl < 24.1 * 3600_000);

    // The OTP only verifies against the NEW address.
    assert.equal(
      token.codeHash,
      hashEmailVerificationCode("client@example.com", result.code),
    );
    assert.notEqual(
      token.codeHash,
      hashEmailVerificationCode("setup@temp.test", result.code),
    );
  });

  test("rejects invalid email, self transfer, admin target and passwordless accounts", async () => {
    const admin: FakeUser = { ...brand, id: "admin-2", role: "ADMIN" };
    const passwordless: FakeUser = { ...brand, id: "nopass", password: null };
    const { db, state } = makeDb([{ ...brand }, admin, passwordless]);

    await expectCode(
      transferUserEmail(db, { actingAdminId: "a", targetUserId: "brand-1", newEmail: "nope" }),
      "INVALID_EMAIL",
    );
    await expectCode(
      transferUserEmail(db, { actingAdminId: "brand-1", targetUserId: "brand-1", newEmail: "x@y.com" }),
      "SELF_TRANSFER",
    );
    await expectCode(
      transferUserEmail(db, { actingAdminId: "a", targetUserId: "admin-2", newEmail: "x@y.com" }),
      "ADMIN_TARGET",
    );
    await expectCode(
      transferUserEmail(db, { actingAdminId: "a", targetUserId: "nopass", newEmail: "x@y.com" }),
      "PASSWORD_REQUIRED",
    );
    await expectCode(
      transferUserEmail(db, { actingAdminId: "a", targetUserId: "missing", newEmail: "x@y.com" }),
      "USER_NOT_FOUND",
    );
    assert.equal(state.userUpdates.length, 0);
    assert.equal(state.tokens.length, 0);
  });

  test("rejects the same email (case-insensitive) and an email used by another user", async () => {
    const other: FakeUser = { ...brand, id: "other", email: "Taken@Example.com" };
    const { db, state } = makeDb([{ ...brand }, other]);

    await expectCode(
      transferUserEmail(db, { actingAdminId: "a", targetUserId: "brand-1", newEmail: "SETUP@temp.test" }),
      "SAME_EMAIL",
    );
    await expectCode(
      transferUserEmail(db, { actingAdminId: "a", targetUserId: "brand-1", newEmail: "taken@example.com" }),
      "EMAIL_IN_USE",
    );
    assert.equal(state.userUpdates.length, 0);
  });

  test("maps a database unique violation to EMAIL_IN_USE", async () => {
    const { db } = makeDb([{ ...brand }], { p2002: true });
    await expectCode(
      transferUserEmail(db, { actingAdminId: "a", targetUserId: "brand-1", newEmail: "race@example.com" }),
      "EMAIL_IN_USE",
    );
  });
});

describe("issueEmailVerificationChallenge", () => {
  test("keeps the 10 minute default lifetime when ttlMs is omitted", async () => {
    const created: Array<{ expires: Date }> = [];
    const fakeTx = {
      emailVerificationToken: {
        deleteMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: { expires: Date } }) => {
          created.push(data);
          return data;
        },
      },
    } as unknown as Parameters<typeof issueEmailVerificationChallenge>[0];

    const before = Date.now();
    await issueEmailVerificationChallenge(fakeTx, "u", "a@b.com", {
      welcomeEligible: false,
    });
    const ttl = created[0].expires.getTime() - before;
    assert.ok(ttl > 9.9 * 60_000 && ttl < 10.1 * 60_000);
  });
});

describe("transfer email OTP template", () => {
  test("shows the code, links to the verify page and escapes input", () => {
    const html = buildEmailTransferVerificationHtml({
      name: "<b>Pat</b>",
      email: "client@example.com",
      code: "123456",
      verifyUrl: "https://sqratch.com/verify-email?email=client%40example.com",
      expiresLabel: "24 hours",
    });
    assert.ok(html.includes("123456"));
    assert.ok(html.includes("24 hours"));
    assert.ok(html.includes('href="https://sqratch.com/verify-email?email=client%40example.com"'));
    assert.ok(html.includes("&lt;b&gt;Pat&lt;/b&gt;"));
    assert.ok(!html.includes("<b>Pat</b>"));
    assert.ok(!html.includes("<script"));
  });
});

describe("admin user PATCH route", () => {
  test("refuses email changes and points to Transfer email", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/app/api/admin/user-management/update-or-delete-users/[id]/route.ts",
      ),
      "utf8",
    );
    assert.match(source, /EMAIL_CHANGE_NOT_ALLOWED/);
    assert.match(source, /data: \{ name, role, isActive \}/);
  });
});
