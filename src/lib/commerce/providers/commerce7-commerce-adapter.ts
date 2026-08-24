/**
 * src/lib/commerce/providers/commerce7-commerce-adapter.ts
 *
 * PHASE 16C1 — the Commerce7 `CommerceAdapter`: READ-ONLY product catalog only.
 *
 * EXACT-ACCOUNT BOUNDARY (the Commerce7 equivalent of the Shopify rule):
 *   1. The connection is loaded by `id` AND `provider: COMMERCE7`, so a Shopify
 *      connection id can never resolve here — it fails before any provider I/O.
 *   2. The tenant is taken EXCLUSIVELY from `connection.externalAccountId`.
 *      No caller, and no browser, can supply or influence it.
 *   3. PHASE 16C2: `status === CONNECTED` is required before any
 *      account-specific Commerce7 API call (`syncProducts`,
 *      `fetchProductPage`), via `requireConnected` below — an `UNINSTALLED`
 *      / `DISCONNECTED` / `REQUIRES_RECONNECT` connection throws
 *      `CommerceConnectionNotReadyError` before the app-global credential is
 *      even read. This is DEFENSE IN DEPTH: `../product-sync.ts` already
 *      enforces the same invariant before ever calling into this adapter;
 *      this check exists for a caller that reaches the adapter directly.
 *
 * CREDENTIALS: app-global, from backend environment configuration only. This
 * adapter never reads or writes `CommerceConnectionSecret`.
 *
 * DELIBERATELY NOT IMPLEMENTED: rewards/discounts, orders, carts, attribution,
 * and public storefront destinations. `getCapabilities()` reports exactly what
 * is real, so the neutral layer refuses anything else rather than discovering
 * it at runtime.
 */

import {
  CommerceProvider,
  type CommerceConnectionStatus,
  type Prisma,
} from "@prisma/client";
import type { CommerceAdapter } from "../adapter";
import {
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../errors";
import type {
  CommerceCapabilities,
  CommerceConnectionResult,
  CommerceConnectionSummary,
  ProductSyncPageRequest,
  ProductSyncPageResult,
  ProductSyncResult,
} from "../types";
import { extractCurrencyCodeFromProviderMetadata } from "../connection-resolver";
import {
  fetchAllCommerce7Products,
  fetchCommerce7ProductPage,
  type Commerce7Fetch,
} from "./commerce7-products";

export type Commerce7CommerceConnectionRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  displayName: string;
  externalAccountId: string;
  storefrontUrl: string | null;
  isPrimary: boolean;
  grantedScopes: Prisma.JsonValue | null;
  installedAt: Date | null;
  uninstalledAt: Date | null;
  lastProductSyncAt: Date | null;
  providerMetadata: Prisma.JsonValue | null;
};

export type Commerce7CommerceAdapterDeps = {
  loadConnection(
    connectionId: string,
  ): Promise<Commerce7CommerceConnectionRow | null>;
  markProductSync(connectionId: string, syncedAt: Date): Promise<void>;
  fetchImpl?: Commerce7Fetch;
};

async function defaultLoadConnection(
  connectionId: string,
): Promise<Commerce7CommerceConnectionRow | null> {
  const { default: prisma } = await import("@/lib/prisma");
  // Provider is part of the WHERE, not a post-hoc check: a Shopify connection
  // id simply does not exist for this adapter.
  return prisma.commerceConnection.findFirst({
    where: { id: connectionId, provider: CommerceProvider.COMMERCE7 },
    select: {
      id: true,
      brandId: true,
      provider: true,
      status: true,
      displayName: true,
      externalAccountId: true,
      storefrontUrl: true,
      isPrimary: true,
      grantedScopes: true,
      installedAt: true,
      uninstalledAt: true,
      lastProductSyncAt: true,
      providerMetadata: true,
    },
  });
}

async function defaultMarkProductSync(
  connectionId: string,
  syncedAt: Date,
): Promise<void> {
  const { default: prisma } = await import("@/lib/prisma");
  await prisma.commerceConnection.updateMany({
    where: { id: connectionId, provider: CommerceProvider.COMMERCE7 },
    data: { lastProductSyncAt: syncedAt },
  });
}

const DEFAULT_DEPS: Commerce7CommerceAdapterDeps = {
  loadConnection: defaultLoadConnection,
  markProductSync: defaultMarkProductSync,
};

function normalizeGrantedScopes(raw: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((scope): scope is string => typeof scope === "string")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function toCommerceConnectionSummary(
  row: Commerce7CommerceConnectionRow,
): CommerceConnectionSummary {
  return {
    id: row.id,
    brandId: row.brandId,
    provider: row.provider,
    status: row.status,
    displayName: row.displayName,
    externalAccountId: row.externalAccountId,
    storefrontUrl: row.storefrontUrl,
    isPrimary: row.isPrimary,
    grantedScopes: normalizeGrantedScopes(row.grantedScopes),
    installedAt: row.installedAt,
    uninstalledAt: row.uninstalledAt,
    lastProductSyncAt: row.lastProductSyncAt,
    currencyCode: extractCurrencyCodeFromProviderMetadata(row.providerMetadata),
  };
}

/** Commerce7 cursor pagination has no caller-selectable page size. */
const COMMERCE7_REPORTED_PAGE_LIMIT = 50;

export class Commerce7CommerceAdapter implements CommerceAdapter {
  readonly provider = CommerceProvider.COMMERCE7;

  private readonly deps: Commerce7CommerceAdapterDeps;

  constructor(deps: Partial<Commerce7CommerceAdapterDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /**
   * Phase 16C1 reality: catalog reads only.
   *
   * `products.publicDestinations` is FALSE because no verified Commerce7
   * storefront base URL exists yet — see the fail-closed note in
   * `commerce7-products.ts`. Every reward capability is false because none is
   * implemented; claiming one would let the neutral reward path attempt a
   * provider call that does not exist.
   */
  getCapabilities(): CommerceCapabilities {
    return {
      products: { sync: true, publicDestinations: false },
      rewards: {
        create: false,
        lookup: false,
        usageLookup: false,
        revoke: false,
        fixedAmount: false,
        percentage: false,
        minimumSubtotal: false,
        productSpecific: false,
        singleUse: false,
      },
    };
  }

  private async loadCommerce7Connection(
    connectionId: string,
  ): Promise<Commerce7CommerceConnectionRow | null> {
    const row = await this.deps.loadConnection(connectionId);
    // Defence in depth: the query already pins the provider, but an injected
    // test/dep must not be able to smuggle another provider's row through.
    return row?.provider === CommerceProvider.COMMERCE7 ? row : null;
  }

  async getConnection(connectionId: string): Promise<CommerceConnectionResult> {
    const row = await this.loadCommerce7Connection(connectionId);

    if (!row) {
      return { ok: false, reason: "NOT_FOUND" };
    }

    if (row.status !== "CONNECTED") {
      return { ok: false, reason: "NOT_CONNECTED" };
    }

    return { ok: true, connection: toCommerceConnectionSummary(row) };
  }

  /**
   * PHASE 16C2: DEFENSE IN DEPTH. `syncCommerceConnectionById` /
   * `syncBrandCommerceProducts` (`../product-sync.ts`) already enforce
   * `status === CONNECTED` before ever calling into this adapter — this is
   * the second, independent check for a caller that reaches the adapter
   * directly. Throws BEFORE any Commerce7 API call (`fetchAllCommerce7Products`
   * / `fetchCommerce7ProductPage`), i.e. before the app-global credential is
   * even read.
   */
  private requireConnected(row: Commerce7CommerceConnectionRow): void {
    if (row.status !== "CONNECTED") {
      throw new CommerceConnectionNotReadyError(row.id, row.provider, row.status);
    }
  }

  /**
   * Whole-catalog fetch-and-normalize. Products are not persisted here; the
   * neutral sync service owns reconciliation.
   */
  async syncProducts(connectionId: string): Promise<ProductSyncResult> {
    const row = await this.loadCommerce7Connection(connectionId);

    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }
    this.requireConnected(row);

    const products = await fetchAllCommerce7Products(
      { tenant: row.externalAccountId },
      { fetchImpl: this.deps.fetchImpl },
    );

    const syncedAt = new Date();
    await this.deps.markProductSync(connectionId, syncedAt);

    return {
      connectionId,
      provider: CommerceProvider.COMMERCE7,
      products,
      productCount: products.length,
      syncedAt,
      hasNextPage: false,
      limit: COMMERCE7_REPORTED_PAGE_LIMIT,
    };
  }

  /**
   * One opaque-cursor page for the persisted catalog sync. The neutral service
   * supplies each `cursor` verbatim from the previous page and applies its own
   * repeated-cursor / max-page / elapsed-time guards on top of this.
   *
   * No `prepareProductSync` is implemented: Shopify needs one to gather
   * publication evidence, whereas Commerce7 publication is unconditionally
   * false in this phase, so there is nothing to prepare.
   */
  async fetchProductPage(
    connectionId: string,
    request: ProductSyncPageRequest,
  ): Promise<ProductSyncPageResult> {
    const row = await this.loadCommerce7Connection(connectionId);

    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }
    this.requireConnected(row);

    const page = await fetchCommerce7ProductPage(
      {
        tenant: row.externalAccountId,
        cursor: request.cursor ?? null,
        ...(request.signal ? { signal: request.signal } : {}),
      },
      { fetchImpl: this.deps.fetchImpl },
    );

    return {
      products: page.products,
      nextCursor: page.nextCursor,
      isComplete: page.isComplete,
      fetchedAt: new Date(),
      limit: request.limit ?? COMMERCE7_REPORTED_PAGE_LIMIT,
    };
  }

  async completeProductSync(
    connectionId: string,
    completedAt: Date,
  ): Promise<void> {
    await this.deps.markProductSync(connectionId, completedAt);
  }
}
