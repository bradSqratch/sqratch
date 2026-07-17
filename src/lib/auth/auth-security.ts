import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";

type CredentialLoginOutcome =
  | "success"
  | "invalid_credentials"
  | "email_unverified"
  | "approval_pending"
  | "system_error";

type AuthRequestContext = {
  requestId: string;
};

const authRequestContext = new AsyncLocalStorage<AuthRequestContext>();

function getSafeRequestId(value: string | null) {
  const candidate = value?.trim();
  return candidate && /^[a-zA-Z0-9._-]{8,128}$/.test(candidate)
    ? candidate
    : randomUUID();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function hashLoginEmail(email: string) {
  const secret = process.env.NEXTAUTH_SECRET;
  const normalizedEmail = normalizeEmail(email);

  if (!secret || !normalizedEmail) {
    return "unavailable";
  }

  return createHmac("sha256", secret)
    .update(normalizedEmail)
    .digest("hex")
    .slice(0, 24);
}

export function createAuthRequestContext(request: Request): AuthRequestContext {
  return {
    requestId: getSafeRequestId(request.headers.get("x-request-id")),
  };
}

export function runWithAuthRequestContext<T>(
  context: AuthRequestContext,
  callback: () => Promise<T>,
) {
  return authRequestContext.run(context, callback);
}

export function logCredentialLoginEvent(
  outcome: CredentialLoginOutcome,
  email: string,
) {
  console.info("[auth/login]", {
    event: "credential_login",
    outcome,
    requestId: authRequestContext.getStore()?.requestId ?? "unavailable",
    emailHash: hashLoginEmail(email),
  });
}
