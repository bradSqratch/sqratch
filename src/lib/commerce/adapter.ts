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
  CreateDiscountOptions,
  GetDiscountInput,
  GetDiscountOptions,
  NormalizedWebhookEvent,
  ProductSyncResult,
  ProviderDiscount,
  ProviderDiscountLookup,
  WebhookRequestInput,
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
   * Fetches and normalizes the connection's live product catalog. Products
   * are never persisted — this is a fetch-and-normalize operation, not a
   * reconciliation against stored rows.
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
   * Records a fully persisted catalog sync. It is deliberately separate from
   * page fetching so a partial/timed-out run never advertises itself as a
   * completed connection sync.
   */
  completeProductSync?(connectionId: string, completedAt: Date): Promise<void>;

  /**
   * Creates a discount code on the provider for the given
   * `CommerceConnection.id`. Optional: only implemented by adapters whose
   * `getCapabilities().canCreateDiscount` is `true`. `options` is an
   * escape hatch for caller-transport plumbing (see
   * `CreateDiscountOptions` in `./types.ts`) — it never carries business
   * data and every implementation must behave identically to omitting it
   * when no option is set.
   */
  createDiscount?(
    connectionId: string,
    input: CreateDiscountInput,
    options?: CreateDiscountOptions,
  ): Promise<ProviderDiscount>;

  /**
   * Looks up a discount using the exact persisted connection identity. This
   * is intentionally separate from business reconciliation policy.
   */
  getDiscount?(
    connectionId: string,
    input: GetDiscountInput,
    options?: GetDiscountOptions,
  ): Promise<ProviderDiscountLookup>;

  /**
   * Revokes/deactivates a previously created discount. Optional: only
   * implemented by adapters whose `getCapabilities().canRevokeDiscount` is
   * `true`. No provider currently supported implements this.
   */
  revokeDiscount?(connectionId: string, externalDiscountId: string): Promise<void>;

  /**
   * Verifies an inbound webhook request's authenticity and parses it into a
   * `NormalizedWebhookEvent`. Optional: only implemented by adapters whose
   * `getCapabilities().canVerifyWebhooks` is `true`.
   */
  verifyAndParseWebhook?(connectionId: string, input: WebhookRequestInput): Promise<NormalizedWebhookEvent>;
}
