/**
 * Unit tests for account / session integrity hardening (Batch 5).
 *
 * All dependencies are mocked via plain in-memory fakes — no HTTP, no Prisma,
 * no Next.js runtime required.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

// ─── Helpers mirroring the production logic ───────────────────────────────────

/**
 * Email normalisation — mirrors the PATCH handler:
 *   const email = String(body.email || "").trim().toLowerCase();
 */
function normaliseEmail(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

/**
 * Blocking-check logic extracted from the DELETE handler.
 * Returns a 409 payload when blocking records exist, or null when safe to delete.
 */
async function checkDeletionBlockers(
  id: string,
  countCampaigns: (id: string) => Promise<number>,
  countQrCodes: (id: string) => Promise<number>,
): Promise<{ status: 409; body: object } | null> {
  const [campaignCount, qrCodeCount] = await Promise.all([
    countCampaigns(id),
    countQrCodes(id),
  ]);
  if (campaignCount > 0 || qrCodeCount > 0) {
    return {
      status: 409,
      body: {
        error:
          "Cannot delete user: they have created campaigns or QR codes. Deactivate the account instead.",
        blockers: { campaigns: campaignCount, qrCodes: qrCodeCount },
      },
    };
  }
  return null;
}

/**
 * The re-check branch of the JWT callback (the `else` path — subsequent requests).
 * Returns the updated token, or null if the user is deactivated/deleted.
 */
async function jwtRecheck(
  token: Record<string, unknown>,
  findUser: (id: string) => Promise<{
    role: string;
    isActive: boolean;
    isEmailVerified: boolean;
  } | null>,
): Promise<Record<string, unknown> | null> {
  const RECHECK_MS = 5 * 60 * 1000;
  const lastCheck = (token.roleCheckedAt as number | undefined) ?? 0;

  if (Date.now() - lastCheck > RECHECK_MS) {
    const fresh = await findUser(token.id as string);
    if (!fresh || !fresh.isActive) {
      return null;
    }
    return {
      ...token,
      role: fresh.role,
      isActive: fresh.isActive,
      isEmailVerified: fresh.isEmailVerified,
      roleCheckedAt: Date.now(),
    };
  }

  return token;
}

async function safeJwtRecheck(
  token: Record<string, unknown>,
  findUser: Parameters<typeof jwtRecheck>[1],
) {
  try {
    return await jwtRecheck(token, findUser);
  } catch {
    return token;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Email normalisation", () => {
  test("uppercased email with whitespace is lowercased and trimmed", () => {
    assert.equal(normaliseEmail("  User@Example.COM  "), "user@example.com");
  });

  test("already-lowercase email is unchanged", () => {
    assert.equal(normaliseEmail("user@example.com"), "user@example.com");
  });

  test("mixed-case email is normalised", () => {
    assert.equal(normaliseEmail("User@Example.COM"), "user@example.com");
  });
});

describe("Blocked deletion returns 409", () => {
  test("returns 409 when user has campaigns", async () => {
    const result = await checkDeletionBlockers(
      "user-1",
      async () => 2, // 2 campaigns
      async () => 0,
    );
    assert.ok(result !== null, "expected a blocker result");
    assert.equal(result.status, 409);
    const body = result.body as {
      error: string;
      blockers: { campaigns: number; qrCodes: number };
    };
    assert.ok(body.error.includes("Cannot delete user"));
    assert.equal(body.blockers.campaigns, 2);
    assert.equal(body.blockers.qrCodes, 0);
  });

  test("returns 409 when user has QR codes", async () => {
    const result = await checkDeletionBlockers(
      "user-2",
      async () => 0,
      async () => 5, // 5 QR codes
    );
    assert.ok(result !== null);
    assert.equal(result.status, 409);
    const body = result.body as {
      error: string;
      blockers: { campaigns: number; qrCodes: number };
    };
    assert.equal(body.blockers.qrCodes, 5);
  });

  test("returns null (safe to delete) when no blocking records exist", async () => {
    const result = await checkDeletionBlockers(
      "user-3",
      async () => 0,
      async () => 0,
    );
    assert.equal(result, null);
  });
});

describe("Deactivated user loses access", () => {
  test("jwt recheck returns null when user.isActive is false", async () => {
    const token: Record<string, unknown> = {
      id: "user-deactivated",
      role: "CREATOR",
      isActive: true,
      roleCheckedAt: 0, // far in the past → triggers recheck
    };

    const result = await jwtRecheck(token, async () => ({
      role: "CREATOR",
      isActive: false, // deactivated
      isEmailVerified: true,
    }));

    assert.equal(result, null);
  });

  test("jwt recheck returns null when user no longer exists in DB", async () => {
    const token: Record<string, unknown> = {
      id: "user-deleted",
      role: "CREATOR",
      isActive: true,
      roleCheckedAt: 0,
    };

    const result = await jwtRecheck(token, async () => null);
    assert.equal(result, null);
  });
});

describe("Role change is reflected in token", () => {
  test("token.role is updated from DB when RECHECK_MS has elapsed", async () => {
    const token: Record<string, unknown> = {
      id: "user-promoted",
      role: "CREATOR",
      isActive: true,
      isEmailVerified: true,
      roleCheckedAt: 0, // far in the past → triggers recheck
    };

    const result = await jwtRecheck(token, async () => ({
      role: "ADMIN",
      isActive: true,
      isEmailVerified: true,
    }));

    assert.ok(result !== null);
    assert.equal(result.role, "ADMIN");
    assert.equal(result.isActive, true);
  });
});

describe("No DB call within recheck interval", () => {
  test("findUser is NOT called when roleCheckedAt is recent", async () => {
    let called = false;

    const token: Record<string, unknown> = {
      id: "user-recent",
      role: "CREATOR",
      isActive: true,
      roleCheckedAt: Date.now(), // just now → within 5-minute window
    };

    const result = await jwtRecheck(token, async () => {
      called = true;
      return { role: "ADMIN", isActive: true, isEmailVerified: true };
    });

    assert.equal(called, false, "findUser should not have been called");
    // Token returned as-is
    assert.equal(result?.role, "CREATOR");
  });
});

describe("Database outage during session revalidation", () => {
  test("keeps the existing token to avoid an outage-driven sign-out loop", async () => {
    const token = { id: "user-active", role: "USER", roleCheckedAt: 0 };
    const result = await safeJwtRecheck(token, async () => {
      throw new Error("database unavailable");
    });
    assert.equal(result, token);
  });
});
