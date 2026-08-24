/**
 * src/lib/commerce/link-connection.ts
 *
 * PHASE 16B — the transactional core that turns a confirmed link intent into a
 * real `CommerceConnection`.
 *
 * Every precondition is re-checked INSIDE the transaction rather than trusted
 * from the page render: the intent must still be unconsumed and unexpired, the
 * installation must still be INSTALLED, and the tenant must not already belong
 * to a different Brand. Anything checked only at render time is a
 * time-of-check/time-of-use bug waiting to happen.
 */

import {
  CommerceConnectionStatus,
  CommerceInstallationStatus,
  type CommerceProvider,
  type Prisma,
} from "@prisma/client";
import { consumeLinkIntent } from "./provider-installation";
import { recordCommerceConnectionEvent } from "./connection-lifecycle";

type TxClient = Prisma.TransactionClient;

export type LinkConnectionResult =
  | { ok: true; connectionId: string; reconnected: boolean }
  | {
      ok: false;
      reason:
        | "INTENT_UNAVAILABLE"
        | "NOT_INSTALLED"
        | "OWNED_BY_OTHER_BRAND"
        | "BRAND_NOT_AUTHORIZED";
    };

/**
 * Links an installed provider account to a Brand.
 *
 * The caller MUST have already verified that `brandId` is a Brand the current
 * SQRATCH user administers — this function enforces the intent/installation/
 * ownership invariants, not SQRATCH session authorization.
 */
export async function linkProviderInstallationToBrand(
  tx: TxClient,
  input: {
    intentId: string;
    installationId: string;
    provider: CommerceProvider;
    externalAccountId: string;
    brandId: string;
    displayName: string;
    now?: Date;
  },
): Promise<LinkConnectionResult> {
  const now = input.now ?? new Date();

  // 1. CAS-consume first. If we lose this race, nothing else may proceed —
  //    this is what makes concurrent confirmations produce exactly one winner.
  const consumed = await consumeLinkIntent(tx, {
    intentId: input.intentId,
    now,
  });

  if (!consumed) {
    return { ok: false, reason: "INTENT_UNAVAILABLE" };
  }

  // 2. Re-read the installation inside the transaction: an uninstall may have
  //    landed between rendering the confirmation page and confirming it.
  const installation = await tx.commerceProviderInstallation.findUnique({
    where: { id: input.installationId },
    select: { status: true, provider: true, externalAccountId: true },
  });

  if (
    !installation ||
    installation.status !== CommerceInstallationStatus.INSTALLED ||
    installation.provider !== input.provider ||
    installation.externalAccountId !== input.externalAccountId
  ) {
    return { ok: false, reason: "NOT_INSTALLED" };
  }

  // 3. Cross-Brand ownership check. `@@unique([provider, externalAccountId])`
  //    is the hard database backstop; this is the explicit, friendly check that
  //    turns a would-be constraint violation into a clear conflict. A tenant
  //    already owned by Brand A is NEVER implicitly transferred to Brand B —
  //    that requires a deliberate future transfer/support workflow.
  const existing = await tx.commerceConnection.findUnique({
    where: {
      provider_externalAccountId: {
        provider: input.provider,
        externalAccountId: input.externalAccountId,
      },
    },
    select: { id: true, brandId: true, status: true, providerClientId: true },
  });

  if (existing && existing.brandId !== input.brandId) {
    return { ok: false, reason: "OWNED_BY_OTHER_BRAND" };
  }

  // 4. Create, or safely reconnect the SAME Brand's existing connection.
  //    NOTE: `storefrontUrl` is deliberately left null — it is NOT synthesized
  //    from the tenant id. Commerce7's real storefront destination is resolved
  //    by a later catalog/provider phase; guessing it here would produce a
  //    plausible-looking but potentially wrong customer-facing URL.
  //    NOTE: no CommerceConnectionSecret is created. Commerce7's App Secret is
  //    app-global and never stored per connection.
  if (existing) {
    await tx.commerceConnection.update({
      where: { id: existing.id },
      data: {
        status: CommerceConnectionStatus.CONNECTED,
        installedAt: now,
        uninstalledAt: null,
      },
    });

    await recordCommerceConnectionEvent(tx, {
      brandId: input.brandId,
      provider: input.provider,
      eventType: "RECONNECTED",
      snapshot: {
        externalAccountId: input.externalAccountId,
        currencyCode: null,
        providerClientId: existing.providerClientId ?? null,
      },
    });

    return { ok: true, connectionId: existing.id, reconnected: true };
  }

  const created = await tx.commerceConnection.create({
    data: {
      brandId: input.brandId,
      provider: input.provider,
      status: CommerceConnectionStatus.CONNECTED,
      displayName: input.displayName,
      externalAccountId: input.externalAccountId,
      storefrontUrl: null,
      installedAt: now,
      uninstalledAt: null,
    },
    select: { id: true },
  });

  await recordCommerceConnectionEvent(tx, {
    brandId: input.brandId,
    provider: input.provider,
    eventType: "CONNECTED",
    snapshot: {
      externalAccountId: input.externalAccountId,
      currencyCode: null,
      providerClientId: null,
    },
  });

  return { ok: true, connectionId: created.id, reconnected: false };
}
