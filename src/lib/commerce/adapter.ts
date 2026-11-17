/**
 * src/lib/commerce/adapter.ts
 *
 * The `CommerceAdapter` interface every commerce provider integration must
 * implement. Kept intentionally narrow — orders, attribution, purchase
 * points, and creator commissions are out of scope until a caller actually
 * needs them through this abstraction.
 *
 * `connectionId` parameters throughout are always a `CommerceConnection.id`
 * (the Prisma model), never a provider-side account id.
 */

import type { CommerceProvider } from "@prisma/client";
import type {
  CommerceCapabilities,
  CommerceConnectionResult,
  ProductSyncPageRequest,
  ProductSyncPreparationRequest,
  ProductSyncPageResult,
  CreateDiscountInput,
  GetDiscountInput,
  ProductSyncResult,
  ProviderDiscount,
  ProviderDiscountLookup,
  CommerceProductAccessSecurity,
} from "./types";

export interface CommerceAdapter {
  /** The provider this adapter implements. */
  readonly provider: CommerceProvider;

  /** Reports which optional methods on this adapter are actually implemented. */
  getCapabilities(): CommerceCapabilities;

  /**
   * Looks up a connection by its `CommerceConnection.id` and returns the
   * neutral summary, or a typed failure reason if it cannot be found /
   * is not connected.
   */
  getConnection(connectionId: string): Promise<CommerceConnectionResult>;

  /**
   * READ-ONLY preview of the connection's live product catalog (one page for
   * providers that paginate). It fetches and normalizes only: it never writes
   * the connection row, `lastProductSyncAt`, sync-run history or any product
   * row, so opening a page that lists provider products cannot change what the
   * brand sees as its last sync.
   */
  previewProducts(connectionId: string): Promise<ProductSyncResult>;

  /**
   * Legacy single-call sync: the same fetch as `previewProducts`, then it
   * stamps `CommerceConnection.lastProductSyncAt`. The persisted catalog sync
   * (`product-sync.ts`) does not depend on that stamp; it records completion
   * through `completeProductSync` after the rows are saved. New callers that
   * only need to read products must use `previewProducts`.
   */
  syncProducts(connectionId: string): Promise<ProductSyncResult>;

  /**
   * Optionally prepares opaque provider context for one complete persisted
   * catalog sync. A preparation failure prevents product writes, which lets
   * providers avoid replacing known catalog facts with incomplete evidence.
   */
  prepareProductSync?(
    connectionId: string,
    request: ProductSyncPreparationRequest,
  ): Promise<unknown>;

  /**
   * Fetches one opaque-cursor product page. Optional so existing adapters and
   * the long-standing single-page `syncProducts` route contract remain
   * compatible while catalog persistence can opt into complete pagination.
   */
  fetchProductPage?(
    connectionId: string,
    request: ProductSyncPageRequest,
  ): Promise<ProductSyncPageResult>;

  /**
   * Optionally reads access security (for example a product secured to a Customer Tag) for specific products, one by one,
   * when the catalog listing did not include it. Read-only. Products the provider no longer has, or whose read failed, are
   * omitted from the result so the caller keeps them unknown rather than treating them as unsecured. The caller bounds how
   * many ids are requested per sync.
   */
  fetchProductAccessSecurity?(
    connectionId: string,
    externalIds: string[],
    request: { signal?: AbortSignal },
  ): Promise<Map<string, CommerceProductAccessSecurity | null>>;

  /**
   * Records a fully persisted catalog sync. It is deliberately separate from
   * page fetching so a partial/timed-out run never advertises itself as a
   * completed connection sync.
   */
  completeProductSync?(connectionId: string, completedAt: Date): Promise<void>;

  /**
   * Creates a discount code on the provider for the given
   * `CommerceConnection.id`. Optional: only implemented by adapters whose
   * `getCapabilities().rewards.create` is `true`. Credential resolution is
   * adapter-owned; provider tokens never cross this generic boundary.
   */
  createDiscount?(
    connectionId: string,
    input: CreateDiscountInput,
  ): Promise<ProviderDiscount>;

  /**
   * Looks up a discount using the exact persisted connection identity. This
   * is intentionally separate from business reconciliation policy.
   */
  getDiscount?(
    connectionId: string,
    input: GetDiscountInput,
  ): Promise<ProviderDiscountLookup>;

  /**
   * Revokes/deactivates a previously created discount. Optional: only
   * implemented by adapters whose `getCapabilities().rewards.revoke` is
   * `true`. No provider currently supported implements this.
   */
  revokeDiscount?(
    connectionId: string,
    externalDiscountId: string,
  ): Promise<void>;
}
