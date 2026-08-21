import type {
  CommerceConnectionEventType,
  CommerceProvider,
  Prisma,
} from "@prisma/client";

type TxClient = Prisma.TransactionClient;

export type CommerceConnectionLifecycleSnapshot = {
  externalAccountId: string | null;
  currencyCode: string | null;
  providerClientId: string | null;
};

/**
 * Appends provider-neutral connection lifecycle history. Events deliberately
 * carry identity snapshots rather than a live connection FK, so privacy
 * erasure can delete a CommerceConnection without deleting its audit history.
 */
export async function recordCommerceConnectionEvent(
  tx: TxClient,
  input: {
    brandId: string;
    provider: CommerceProvider;
    eventType: CommerceConnectionEventType;
    snapshot: CommerceConnectionLifecycleSnapshot;
    previousSnapshot?: Pick<
      CommerceConnectionLifecycleSnapshot,
      "externalAccountId" | "currencyCode"
    >;
  },
) {
  await tx.commerceConnectionEvent.create({
    data: {
      brandId: input.brandId,
      provider: input.provider,
      eventType: input.eventType,
      externalAccountId: input.snapshot.externalAccountId,
      previousExternalAccountId: input.previousSnapshot?.externalAccountId ?? null,
      currencyCode: input.snapshot.currencyCode,
      previousCurrencyCode: input.previousSnapshot?.currencyCode ?? null,
      providerClientId: input.snapshot.providerClientId,
    },
  });
}

/** Gets the latest retained external-account snapshot for one provider only. */
export async function resolveLastKnownExternalAccountId(
  tx: TxClient,
  brandId: string,
  provider: CommerceProvider,
): Promise<string | null> {
  const lastEvent = await tx.commerceConnectionEvent.findFirst({
    where: { brandId, provider, externalAccountId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { externalAccountId: true },
  });

  return lastEvent?.externalAccountId ?? null;
}
