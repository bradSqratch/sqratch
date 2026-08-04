/**
 * Pure, injectable credential-login policy shared by the real NextAuth
 * `authorize()` callback and its tests.
 *
 * Kept dependency-free of Prisma/bcrypt so behavior (bcrypt is always run,
 * account-state is never revealed before a correct password) can be verified
 * without a live database.
 */

/** Mirrors the `next-auth` module augmentation's `AppRole` without importing it, keeping this file framework-agnostic. */
export type CredentialLoginRole = "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN";

export type CredentialLoginUser = {
  id: string;
  name: string | null;
  email: string;
  password: string | null;
  role: CredentialLoginRole;
  isEmailVerified: boolean;
  imageUrl: string | null;
  sessionVersion: number;
};

export type CredentialLoginDeps = {
  findUserByEmail: (email: string) => Promise<CredentialLoginUser | null>;
  hasPendingApproval: (userId: string) => Promise<boolean>;
  comparePassword: (password: string, hash: string) => Promise<boolean>;
};

export type CredentialLoginSuccess = {
  ok: true;
  outcome: "success";
  user: Pick<
    CredentialLoginUser,
    "id" | "email" | "name" | "role" | "isEmailVerified" | "imageUrl" | "sessionVersion"
  >;
};

export type CredentialLoginFailure = {
  ok: false;
  outcome: "invalid_credentials" | "email_unverified" | "approval_pending";
  message: string;
};

export type CredentialLoginResult = CredentialLoginSuccess | CredentialLoginFailure;

/**
 * Bcrypt hash of a random, never-used dummy password (cost factor 12,
 * matching every real password hash in this codebase). Comparing against
 * this hash when no real user/password exists keeps the same bcrypt work on
 * every branch, so a wrong-password guess can't be timed or otherwise
 * distinguished from an unknown email before credentials are known invalid.
 */
export const DUMMY_PASSWORD_HASH =
  "$2b$12$I58Q/kYdj30yD7Op9WuB2OUidvWWVHDauCVpBt3rIN865rSW8KvOe";

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";
const EMAIL_UNVERIFIED_MESSAGE = "Please verify your email address first.";
const APPROVAL_PENDING_MESSAGE =
  "Wait for your approval from the admin. You will be notified via email once approved.";

export async function evaluateCredentialLogin(
  input: { email: string; password: string },
  deps: CredentialLoginDeps,
): Promise<CredentialLoginResult> {
  const email = input.email.trim().toLowerCase();
  const user = await deps.findUserByEmail(email);

  // Always perform the bcrypt comparison — against the real hash for a
  // password-backed user, or the fixed dummy hash otherwise — before any
  // account-state is revealed.
  const isPasswordCorrect = await deps.comparePassword(
    input.password,
    user?.password || DUMMY_PASSWORD_HASH,
  );

  if (!user || !user.password || !isPasswordCorrect) {
    return {
      ok: false,
      outcome: "invalid_credentials",
      message: INVALID_CREDENTIALS_MESSAGE,
    };
  }

  // Only after the password is confirmed correct do we reveal any
  // account-state that requires a different, actionable message.
  if (!user.isEmailVerified) {
    return {
      ok: false,
      outcome: "email_unverified",
      message: EMAIL_UNVERIFIED_MESSAGE,
    };
  }

  if (user.role !== "ADMIN" && (await deps.hasPendingApproval(user.id))) {
    return {
      ok: false,
      outcome: "approval_pending",
      message: APPROVAL_PENDING_MESSAGE,
    };
  }

  return {
    ok: true,
    outcome: "success",
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      imageUrl: user.imageUrl,
      sessionVersion: user.sessionVersion,
    },
  };
}
