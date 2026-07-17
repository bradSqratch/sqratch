import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isWelcomeEmailEligible } from "../src/lib/welcome-email";

const root = process.cwd();
const read = (...segments: string[]) =>
  readFileSync(path.join(root, ...segments), "utf8");
const legacyRole = "EX" + "TERNAL";
const legacySignupPath = ["src", "app", "api", "users", "signup", "route.ts"];

test("current Prisma roles exclude the retired role", () => {
  const schema = read("prisma", "schema.prisma");
  const roleBlock = schema.match(/enum Role \{([\s\S]*?)\}/)?.[1] || "";
  const roles: string[] = roleBlock.match(/[A-Z_]+/g) || [];

  assert.deepEqual(roles, ["USER", "ADMIN", "CREATOR", "BRAND_ADMIN"]);
  assert.equal(roles.includes(legacyRole), false);
});

test("current authentication and dashboard role unions exclude the retired role", () => {
  for (const segments of [
    ["src", "app", "types", "next-auth.d.ts"],
    ["src", "components", "app-sidebar.tsx"],
    ["src", "app", "(withSidebar)", "dashboard", "page.tsx"],
    ["src", "app", "api", "me", "dashboard-summary", "route.ts"],
  ]) {
    assert.doesNotMatch(read(...segments), new RegExp(legacyRole));
  }
});

test("role-removal migration aborts on legacy rows and preserves supported roles", () => {
  const migration = read(
    "prisma",
    "migrations",
    "20260716130000_remove_external_role",
    "migration.sql",
  );

  assert.match(migration, new RegExp(`WHERE "role"::text = '${legacyRole}'`));
  assert.match(migration, /RAISE EXCEPTION/);
  for (const role of ["USER", "ADMIN", "CREATOR", "BRAND_ADMIN"]) {
    assert.match(migration, new RegExp(`'${role}'`));
  }
  assert.match(migration, /SET DEFAULT 'USER'::"Role"/);
});

test("welcome migration removes only the legacy queue trigger", () => {
  const migration = read(
    "prisma",
    "migrations",
    "20260716131000_verified_user_welcome_queue",
    "migration.sql",
  );

  assert.match(migration, /DROP TRIGGER IF EXISTS "trg_enqueue_welcome_email"/);
  assert.match(
    migration,
    /DROP FUNCTION IF EXISTS public\.enqueue_welcome_email\(\)/,
  );
  assert.match(migration, /"welcomeEligible" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(
    migration,
    /"verificationEligible" BOOLEAN NOT NULL DEFAULT false/,
  );
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'SKIPPED'/);
  assert.doesNotMatch(migration, /DROP TRIGGER.*Make/i);
});

test("legacy claim API is absent while normal self-service signup remains", () => {
  assert.equal(existsSync(path.join(root, ...legacySignupPath)), false);
  assert.equal(
    existsSync(
      path.join(root, "src", "app", "api", "auth", "signup", "route.ts"),
    ),
    true,
  );

  const signup = read("src", "app", "(auth)", "signup", "page.tsx");
  assert.doesNotMatch(signup, new RegExp("registered" + "email", "i"));
  assert.doesNotMatch(signup, new RegExp("isInvited" + "ClaimFlow"));
  assert.doesNotMatch(signup, new RegExp("/api/users/" + "signup"));
  assert.match(signup, /axios\.post\("\/api\/auth\/signup"/);
  assert.match(signup, /verify-email\?email=.*&next=/);
  assert.match(signup, /normalizeInternalRedirectPath/);
});

test("admin user management exposes only supported roles and defaults to USER", () => {
  const page = read(
    "src",
    "app",
    "(withSidebar)",
    "admin",
    "user-management",
    "page.tsx",
  );
  const adminAuth = read("src", "lib", "admin-auth.ts");
  const createRoute = read(
    "src",
    "app",
    "api",
    "admin",
    "user-management",
    "get-or-create-users",
    "route.ts",
  );
  const updateRoute = read(
    "src",
    "app",
    "api",
    "admin",
    "user-management",
    "update-or-delete-users",
    "[id]",
    "route.ts",
  );

  assert.doesNotMatch(page, new RegExp(legacyRole));
  assert.doesNotMatch(adminAuth, new RegExp(legacyRole));
  assert.match(createRoute, /normalizeUserRole\(role\)/);
  assert.match(createRoute, /welcomeEligible: false/);
  assert.match(updateRoute, /normalizeUserRole\(body\.role\)/);
  assert.match(page, /role: "USER"/);
  for (const role of ["USER", "CREATOR", "BRAND_ADMIN", "ADMIN"]) {
    assert.match(page, new RegExp(`"${role}"`));
  }
});

test("welcome eligibility is limited to verified ordinary self-service users", () => {
  assert.equal(
    isWelcomeEmailEligible({
      isEmailVerified: true,
      role: "USER",
      hasCreatorRequest: false,
      hasBrandRequest: false,
    }),
    true,
  );

  for (const ineligible of [
    {
      isEmailVerified: false,
      role: "USER" as const,
      hasCreatorRequest: false,
      hasBrandRequest: false,
    },
    {
      isEmailVerified: true,
      role: "USER" as const,
      hasCreatorRequest: true,
      hasBrandRequest: false,
    },
    {
      isEmailVerified: true,
      role: "USER" as const,
      hasCreatorRequest: false,
      hasBrandRequest: true,
    },
    {
      isEmailVerified: true,
      role: "CREATOR" as const,
      hasCreatorRequest: false,
      hasBrandRequest: false,
    },
    {
      isEmailVerified: true,
      role: "BRAND_ADMIN" as const,
      hasCreatorRequest: false,
      hasBrandRequest: false,
    },
    {
      isEmailVerified: true,
      role: "ADMIN" as const,
      hasCreatorRequest: false,
      hasBrandRequest: false,
    },
  ]) {
    assert.equal(isWelcomeEmailEligible(ineligible), false);
  }
});

test("welcome queue is verification-driven and worker-revalidated", () => {
  const verification = read("src", "lib", "auth", "email-verification.ts");
  const welcome = read("src", "lib", "welcome-email.ts");
  const worker = read(
    "src",
    "app",
    "api",
    "internal",
    "email-worker",
    "route.ts",
  );
  const mailer = read("src", "helpers", "mailer.ts");
  const template = read("src", "helpers", "emailTemplates.ts");
  const signupRoute = read("src", "app", "api", "auth", "signup", "route.ts");

  assert.match(verification, /enqueueWelcomeEmailIfEligible/);
  assert.match(verification, /welcomeEligible: challenge\.welcomeEligible/);
  assert.match(welcome, /emailQueue\.upsert/);
  assert.match(welcome, /uq_email_queue_user_template/);
  assert.match(welcome, /verificationEligible: true/);
  assert.match(signupRoute, /welcomeEligible: requestedRole == null/);
  assert.match(worker, /isWelcomeEmailEligible/);
  assert.match(worker, /job\.verificationEligible/);
  assert.match(worker, /status: "SKIPPED"/);
  assert.doesNotMatch(worker, /cutoffMinutes|45 minutes ago/);
  assert.match(mailer, /getAppBaseUrl\(\).*\/login/);
  assert.doesNotMatch(
    mailer,
    new RegExp("/signup\\?" + "registered" + "email="),
  );
  assert.match(template, /LOG IN TO SQRATCH/);
});

test("Posts and Q&A interaction policy remains owner or logged-in unlock", () => {
  const access = read("src", "lib", "experience-access.ts");
  assert.match(
    access,
    /canInteract: isCreatorOwner \|\| \(isLoggedIn && hasUnlockedCampaign\)/,
  );
});

test("unsafe legacy QR user/email route remains absent", () => {
  assert.equal(
    existsSync(
      path.join(
        root,
        "src",
        "app",
        "api",
        "users",
        "add-user-send-verify-email",
        "route.ts",
      ),
    ),
    false,
  );
});
