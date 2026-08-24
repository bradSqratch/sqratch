/**
 * src/lib/commerce/provider-installation.ts
 *
 * PHASE 16B — provider-neutral lifecycle for a provider-side app installation
 * that may not yet be linked to a SQRATCH Brand, plus the single-use link
 * intent that hands an authenticated provider admin over to an authenticated
 * SQRATCH Brand Admin.
 *
 * AUTHORITY BOUNDARY: `CommerceProviderInstallation` records only that a
 * provider account has the app installed. It carries no `brandId` and confers
 * no ownership. `CommerceConnection` remains the sole Brand/provider/account
 * identity authority, and its `@@unique([provider, externalAccountId])` remains
 * the cross-Brand collision backstop.
 *
 * SECRETS: nothing in this module reads or writes `CommerceConnectionSecret`,
 * and no raw link token is ever persisted — only its SHA-256 digest.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  CommerceInstallationStatus,
  type CommerceProvider,
  type Prisma,
} from "@prisma/client";

type TxClient = Prisma.TransactionClient;

/** Raw link tokens are 256 bits of CSPRNG output, base64url-encoded. */
const LINK_TOKEN_BYTES = 32;

/** Link intents are deliberately short-lived — this is a handoff, not a session. */
export const LINK_INTENT_TTL_MS = 10 * 60 * 1000;

/**
 * SHA-256 hex digest. Used for link-token storage: the token is high-entropy
 * random (not a password), so a plain cryptographic digest is the right
 * primitive — a slow KDF would buy nothing against a 256-bit random preimage.
 */
export function hashLinkToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateLinkToken(): string {
  return randomBytes(LINK_TOKEN_BYTES).toString("base64url");
}

/**
 * Marks a provider account as installed, creating the record on first install
 * and returning an UNINSTALLED record to INSTALLED on reinstall. Idempotent:
 * repeating an install for an already-INSTALLED account is a no-op update.
 */
export async function markProviderInstallationInstalled(
  tx: TxClient,
  input: { provider: CommerceProvider; externalAccountId: string },
): Promise<{ id: string; reinstalled: boolean }> {
  const existing = await tx.commerceProviderInstallation.findUnique({
    where: {
      provider_externalAccountId: {
        provider: input.provider,
        externalAccountId: input.externalAccountId,
      },
    },
    select: { id: true, status: true },
  });

  if (!existing) {
    const created = await tx.commerceProviderInstallation.create({
      data: {
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        status: CommerceInstallationStatus.INSTALLED,
        installedAt: new Date(),
        uninstalledAt: null,
      },
      select: { id: true },
    });

    return { id: created.id, reinstalled: false };
  }

  const wasUninstalled = existing.status === CommerceInstallationStatus.UNINSTALLED;

  await tx.commerceProviderInstallation.update({
    where: { id: existing.id },
    data: {
      status: CommerceInstallationStatus.INSTALLED,
      uninstalledAt: null,
      ...(wasUninstalled ? { installedAt: new Date() } : {}),
    },
  });

  return { id: existing.id, reinstalled: wasUninstalled };
}

/**
 * Marks a provider account uninstalled and invalidates every outstanding link
 * intent for it — an uninstalled tenant must never remain linkable through a
 * token minted while it was installed.
 *
 * Returns `transitioned: false` when the account was already UNINSTALLED (or
 * unknown), so callers only record a lifecycle event on a genuine transition.
 */
export async function markProviderInstallationUninstalled(
  tx: TxClient,
  input: { provider: CommerceProvider; externalAccountId: string },
): Promise<{ id: string | null; transitioned: boolean; intentsInvalidated: number }> {
  const existing = await tx.commerceProviderInstallation.findUnique({
    where: {
      provider_externalAccountId: {
        provider: input.provider,
        externalAccountId: input.externalAccountId,
      },
    },
    select: { id: true, status: true },
  });

  if (!existing) {
    return { id: null, transitioned: false, intentsInvalidated: 0 };
  }

  const transitioned = existing.status !== CommerceInstallationStatus.UNINSTALLED;

  if (transitioned) {
    await tx.commerceProviderInstallation.update({
      where: { id: existing.id },
      data: {
        status: CommerceInstallationStatus.UNINSTALLED,
        uninstalledAt: new Date(),
      },
    });
  }

  // Always run, even when the installation was already UNINSTALLED: a redelivered
  // uninstall must still leave no live intent behind.
  const invalidated = await tx.commerceConnectionLinkIntent.updateMany({
    where: { installationId: existing.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return {
    id: existing.id,
    transitioned,
    intentsInvalidated: invalidated.count,
  };
}

export type CreatedLinkIntent = {
  /** Returned to the caller exactly once. Never persisted, never logged. */
  rawToken: string;
  expiresAt: Date;
};

/**
 * Mints a single-use link intent for an installation. The caller is responsible
 * for having already authenticated the provider-side admin.
 */
export async function createLinkIntent(
  tx: TxClient,
  input: { installationId: string; now?: Date },
): Promise<CreatedLinkIntent> {
  const now = input.now ?? new Date();
  const rawToken = generateLinkToken();
  const expiresAt = new Date(now.getTime() + LINK_INTENT_TTL_MS);

  await tx.commerceConnectionLinkIntent.create({
    data: {
      installationId: input.installationId,
      tokenHash: hashLinkToken(rawToken),
      expiresAt,
    },
  });

  return { rawToken, expiresAt };
}

export type LinkIntentResolution =
  | {
      ok: true;
      intentId: string;
      installationId: string;
      provider: CommerceProvider;
      externalAccountId: string;
    }
  | { ok: false; reason: "NOT_FOUND" | "EXPIRED" | "CONSUMED" | "NOT_INSTALLED" };

/**
 * Read-only resolution of a raw token, for rendering the confirmation screen.
 * Deliberately does NOT consume the intent — consumption happens only on
 * explicit confirmation, via `consumeLinkIntent`.
 */
export async function resolveLinkIntent(
  db: TxClient,
  input: { rawToken: string; now?: Date },
): Promise<LinkIntentResolution> {
  const now = input.now ?? new Date();
  const intent = await db.commerceConnectionLinkIntent.findUnique({
    where: { tokenHash: hashLinkToken(input.rawToken) },
    select: {
      id: true,
      installationId: true,
      consumedAt: true,
      expiresAt: true,
      installation: {
        select: { provider: true, externalAccountId: true, status: true },
      },
    },
  });

  if (!intent) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  if (intent.consumedAt) {
    return { ok: false, reason: "CONSUMED" };
  }

  if (intent.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "EXPIRED" };
  }

  if (intent.installation.status !== CommerceInstallationStatus.INSTALLED) {
    return { ok: false, reason: "NOT_INSTALLED" };
  }

  return {
    ok: true,
    intentId: intent.id,
    installationId: intent.installationId,
    provider: intent.installation.provider,
    externalAccountId: intent.installation.externalAccountId,
  };
}

/**
 * Atomically consumes a link intent. The compare-and-swap lives entirely in the
 * WHERE clause — `consumedAt IS NULL AND expiresAt > now` — so when two requests
 * race, Postgres arbitrates and exactly one `updateMany` reports `count === 1`.
 * A read-then-write would be a check-then-act race and is deliberately avoided.
 */
export async function consumeLinkIntent(
  tx: TxClient,
  input: { intentId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await tx.commerceConnectionLinkIntent.updateMany({
    where: {
      id: input.intentId,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });

  return result.count === 1;
}
