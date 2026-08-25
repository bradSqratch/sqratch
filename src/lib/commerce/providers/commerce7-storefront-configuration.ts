/**
 * src/lib/commerce/providers/commerce7-storefront-configuration.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 1 — the write path for merchant-confirmed
 * Commerce7 storefront configuration: exact-connection resolution, field
 * validation (delegated to `./commerce7-connection-config.ts`), the
 * `providerMetadata` merge-preserving persistence, and derived-state
 * invalidation scoped to the EXACT connection being reconfigured.
 *
 * PHASE 18 REPAIR (P1-2): the connection-row write and every required
 * derived-state invalidation now happen inside ONE Prisma transaction
 * (`runInTransaction` below). Before this repair they were three separate,
 * non-transactional statements: if the configuration write succeeded but an
 * invalidation write failed, the connection would advertise the NEW
 * configuration while `ConnectedCommerceProduct` rows kept stale
 * money/public-destination data computed under the OLD one — and a retry
 * would see no config diff (the write already "succeeded"), so the
 * invalidation could be silently lost forever. Any failure inside the
 * transaction now rolls back the configuration write too, so a retry always
 * starts from a genuinely consistent prior state.
 *
 * Resolution semantics deliberately mirror
 * `syncCommerceConnectionById` in `../product-sync.ts` (the established
 * exact-connection pattern): missing/foreign connectionId and wrong-provider
 * both throw before any write; a mismatch and a genuinely-missing id are
 * indistinguishable to the caller. Not-CONNECTED throws a distinct, nameable
 * error since the connection is genuinely this brand's own Commerce7 account.
 */

import { CommerceProvider, type CommerceConnectionStatus, type Prisma } from "@prisma/client";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../errors";
import {
  validateCommerce7CurrencyCode,
  validateCommerce7ProductRoute,
  validateCommerce7StorefrontUrl,
} from "./commerce7-connection-config";

export type Commerce7StorefrontConfigurationInput = {
  brandId: string;
  connectionId: string;
  storefrontUrl: string;
  productRoute: string;
  currencyCode: string;
};

export type Commerce7StorefrontConfigurationField =
  | "storefrontUrl"
  | "productRoute"
  | "currencyCode";

export type Commerce7StorefrontConfigurationResult =
  | {
      ok: true;
      storefrontUrl: string;
      productRoute: string;
      currencyCode: string;
      requiresProductSync: boolean;
    }
  | { ok: false; field: Commerce7StorefrontConfigurationField; error: string };

export type Commerce7ConnectionConfigRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  storefrontUrl: string | null;
  providerMetadata: unknown;
};

/**
 * Everything the configuration save needs, scoped to run against ONE
 * transaction client (`Prisma.TransactionClient` in the default
 * implementation) so every read/write below participates in the SAME
 * database transaction — never a second, independent connection.
 */
export type Commerce7ConfigTransactionClient = {
  findConnection(connectionId: string): Promise<Commerce7ConnectionConfigRow | null>;
  updateConnectionConfiguration(
    connectionId: string,
    data: { storefrontUrl: string; providerMetadata: Record<string, unknown> },
  ): Promise<void>;
  /** Scoped to the EXACT connection only — never brand-wide, never another connection. */
  invalidateCurrencyDerivedProductData(connectionId: string): Promise<void>;
  /** Scoped to the EXACT connection only — never brand-wide, never another connection. */
  invalidatePublicDestinationDerivedProductData(connectionId: string): Promise<void>;
};

export type Commerce7StorefrontConfigurationDeps = {
  /**
   * PHASE 18 REPAIR (P1-2): runs `fn` with a transactional client. Any
   * throw from `fn` — including the ownership/provider/status errors this
   * module itself raises, and any write failure inside `fn` — must roll
   * back EVERY write `fn` made through that client and re-throw the
   * original error, unchanged, to the caller. The default implementation
   * delegates this guarantee to `prisma.$transaction`.
   */
  runInTransaction<T>(fn: (client: Commerce7ConfigTransactionClient) => Promise<T>): Promise<T>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

function connectionSelect() {
  return {
    id: true,
    brandId: true,
    provider: true,
    status: true,
    storefrontUrl: true,
    providerMetadata: true,
  } as const;
}

/**
 * Builds the transaction client from a live Prisma transaction handle
 * (`tx`, a `Prisma.TransactionClient`) — every method here issues its query
 * through `tx`, never the module-level `prisma` singleton, so all four
 * operations participate in the one enclosing transaction.
 */
function buildTransactionClient(
  tx: Prisma.TransactionClient,
): Commerce7ConfigTransactionClient {
  return {
    async findConnection(connectionId) {
      return tx.commerceConnection.findUnique({
        where: { id: connectionId },
        select: connectionSelect(),
      });
    },
    // PHASE 19 REPAIR (real-lock round, Part 5A): this is a genuine SQL
    // UPDATE against real (non-empty) fields, so it takes a real Postgres
    // row-level lock on this exact CommerceConnection row for the rest of
    // THIS transaction — the same lock a concurrent product-sync write
    // acquires via `lockCommerceConnectionForTransaction` (see
    // `../connection-row-lock.ts`). The two therefore fully serialize
    // against each other: whichever transaction's UPDATE reaches Postgres
    // first holds the lock until it commits/rolls back, and the other
    // genuinely waits. Either ordering is safe — see that module's header
    // and `tests/commerce-connection-lock.test.ts`'s ORDER 1/ORDER 2 proofs.
    async updateConnectionConfiguration(connectionId, data) {
      await tx.commerceConnection.update({
        where: { id: connectionId },
        data: {
          storefrontUrl: data.storefrontUrl,
          providerMetadata: data.providerMetadata as Prisma.InputJsonValue,
        },
      });
    },
    // Currency/price fields are genuinely nullable on `ConnectedCommerceProduct`,
    // so a currency change nulls them outright — a stale price under the OLD
    // currency must never be displayed as though it were priced in the new one.
    async invalidateCurrencyDerivedProductData(connectionId) {
      await tx.connectedCommerceProduct.updateMany({
        where: { connectionId },
        data: {
          currencyCode: null,
          priceMinMinor: null,
          priceMaxMinor: null,
          priceMinorUnitExponent: null,
        },
      });
    },
    // `productUrl` is NOT NULL in schema, so invalidation cannot null it out.
    // The actual public-exposure gate is `hasPublicStorefrontUrl` (see the
    // field's doc comment in prisma/schema.prisma) — flipping it to `false`
    // is the fail-closed equivalent of nulling the derived destination.
    async invalidatePublicDestinationDerivedProductData(connectionId) {
      await tx.connectedCommerceProduct.updateMany({
        where: { connectionId },
        data: { hasPublicStorefrontUrl: false },
      });
    },
  };
}

async function defaultRunInTransaction<T>(
  fn: (client: Commerce7ConfigTransactionClient) => Promise<T>,
): Promise<T> {
  const prisma = await getPrisma();
  return prisma.$transaction((tx) => fn(buildTransactionClient(tx)));
}

const DEFAULT_DEPS: Commerce7StorefrontConfigurationDeps = {
  runInTransaction: defaultRunInTransaction,
};

function readExistingMetadata(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Validates and persists a Brand Admin's explicit Commerce7 storefront
 * configuration for ONE exact, owned, CONNECTED connection.
 *
 * Field validation runs BEFORE any transaction is opened — pure, no I/O, so
 * a malformed request never touches the database at all. Everything from
 * the connection lookup onward runs inside ONE transaction (P1-2): the
 * ownership/provider/status checks, the configuration write, and every
 * required derived-state invalidation either all commit together or none
 * of them do.
 *
 * Throws `CommerceConnectionNotFoundError` for a missing OR foreign-brand
 * connectionId (deliberately indistinguishable), `CommerceConnectionMismatchError`
 * for a connection that is not COMMERCE7, and `CommerceConnectionNotReadyError`
 * for a COMMERCE7 connection that is not currently CONNECTED — each of these
 * thrown from inside the transaction, so Prisma rolls back before
 * re-throwing. Field validation failures are returned (not thrown) as
 * `{ok: false}` so a route layer can map them to a 400 with a
 * field-scoped message.
 */
export async function configureCommerce7Storefront(
  input: Commerce7StorefrontConfigurationInput,
  deps: Partial<Commerce7StorefrontConfigurationDeps> = {},
): Promise<Commerce7StorefrontConfigurationResult> {
  const resolved: Commerce7StorefrontConfigurationDeps = { ...DEFAULT_DEPS, ...deps };

  const storefrontResult = validateCommerce7StorefrontUrl(input.storefrontUrl);
  if (!storefrontResult.ok) {
    return { ok: false, field: "storefrontUrl", error: storefrontResult.error };
  }
  const routeResult = validateCommerce7ProductRoute(input.productRoute);
  if (!routeResult.ok) {
    return { ok: false, field: "productRoute", error: routeResult.error };
  }
  const currencyResult = validateCommerce7CurrencyCode(input.currencyCode);
  if (!currencyResult.ok) {
    return { ok: false, field: "currencyCode", error: currencyResult.error };
  }

  return resolved.runInTransaction(async (client) => {
    const connection = await client.findConnection(input.connectionId);

    if (!connection || connection.brandId !== input.brandId) {
      throw new CommerceConnectionNotFoundError(input.connectionId);
    }
    if (connection.provider !== CommerceProvider.COMMERCE7) {
      throw new CommerceConnectionMismatchError(
        input.connectionId,
        CommerceProvider.COMMERCE7,
        connection.provider,
      );
    }
    if (connection.status !== "CONNECTED") {
      throw new CommerceConnectionNotReadyError(
        connection.id,
        connection.provider,
        connection.status,
      );
    }

    const existingMetadata = readExistingMetadata(connection.providerMetadata);
    const existingProductRoute =
      typeof existingMetadata.productRoute === "string" ? existingMetadata.productRoute : null;
    const existingCurrencyCode =
      typeof existingMetadata.currencyCode === "string" ? existingMetadata.currencyCode : null;

    const currencyChanged = existingCurrencyCode !== currencyResult.value;
    const storefrontChanged = (connection.storefrontUrl ?? null) !== storefrontResult.value;
    const routeChanged = existingProductRoute !== routeResult.value;

    const nextMetadata: Record<string, unknown> = {
      ...existingMetadata,
      currencyCode: currencyResult.value,
      productRoute: routeResult.value,
    };

    await client.updateConnectionConfiguration(input.connectionId, {
      storefrontUrl: storefrontResult.value,
      providerMetadata: nextMetadata,
    });

    if (currencyChanged) {
      await client.invalidateCurrencyDerivedProductData(input.connectionId);
    }
    if (storefrontChanged || routeChanged) {
      await client.invalidatePublicDestinationDerivedProductData(input.connectionId);
    }

    return {
      ok: true,
      storefrontUrl: storefrontResult.value,
      productRoute: routeResult.value,
      currencyCode: currencyResult.value,
      requiresProductSync: currencyChanged || storefrontChanged || routeChanged,
    };
  });
}
