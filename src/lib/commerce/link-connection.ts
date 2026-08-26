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
 *
 * PHASE 20 (one-active-Commerce7-store round): a Brand may have many
 * historical DISCONNECTED/UNINSTALLED Commerce7 connections but at most ONE
 * ACTIVE one. This is enforced HERE, inside the same transaction, immediately
 * after the pre-existing cross-Brand ownership check and before any write —
 * see `../brand-row-lock.ts` for why a Brand-level lock (rather than a
 * per-connection lock) is the only mechanism that can close the race between
 * two DIFFERENT, not-yet-active tenants both linking to the same Brand for
 * the first time. LOCK ORDER IS Brand -> CommerceConnection, always — this
 * function locks the Brand FIRST, before touching any `CommerceConnection`
 * row, and `../providers/commerce7-connection-lifecycle.ts`'s
 * disconnect/reconnect follow the identical order, so no path can deadlock
 * against this one. Deliberately scoped to `provider === COMMERCE7` only —
 * Shopify never calls this function (confirmed: the only caller is
 * `src/app/api/commerce7/link/route.ts`), and this invariant must never
 * apply to it even if that changes in the future.
 */

import {
  CommerceConnectionStatus,
  CommerceInstallationStatus,
  CommerceProvider,
  type Prisma,
} from "@prisma/client";
import { consumeLinkIntent } from "./provider-installation";
import { recordCommerceConnectionEvent } from "./connection-lifecycle";
import { lockBrandForTransaction } from "./brand-row-lock";
import { COMMERCE7_FREE_SLOT_STATUSES } from "./providers/commerce7-active-slot";

type TxClient = Prisma.TransactionClient;

export type LinkConnectionResult =
  | { ok: true; connectionId: string; reconnected: boolean }
  | {
      ok: false;
      reason:
        | "INTENT_UNAVAILABLE"
        | "NOT_INSTALLED"
        | "OWNED_BY_OTHER_BRAND"
        | "BRAND_NOT_AUTHORIZED"
        | "COMMERCE7_STORE_ALREADY_CONNECTED";
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

  // 0. PHASE 20: real-lock the Brand FIRST, before anything else — this is
  //    the serialization point the one-active-Commerce7-store invariant
  //    depends on (see this file's header and ../brand-row-lock.ts). Lock
  //    order is always Brand -> CommerceConnection.
  await lockBrandForTransaction(tx, input.brandId);

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

  // 3b. PHASE 20: one-active-Commerce7-store-per-Brand. A DIFFERENT
  //     Commerce7 connection (not this exact tenant's own row) that still
  //     occupies this Brand's active slot blocks linking/reconnecting this
  //     one — the merchant must explicitly disconnect it first (see
  //     ./providers/commerce7-active-slot.ts for the exact predicate).
  //     Scoped to COMMERCE7 only; Shopify never reaches this function.
  if (input.provider === CommerceProvider.COMMERCE7) {
    const conflicting = await tx.commerceConnection.findFirst({
      where: {
        brandId: input.brandId,
        provider: CommerceProvider.COMMERCE7,
        status: { notIn: [...COMMERCE7_FREE_SLOT_STATUSES] },
        ...(existing ? { id: { not: existing.id } } : {}),
      },
      select: { id: true },
    });
    if (conflicting) {
      return { ok: false, reason: "COMMERCE7_STORE_ALREADY_CONNECTED" };
    }
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
