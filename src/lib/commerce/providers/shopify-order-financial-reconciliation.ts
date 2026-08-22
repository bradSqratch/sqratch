/**
 * src/lib/commerce/providers/shopify-order-financial-reconciliation.ts
 *
 * Shopify provider-layer FINANCIAL RECONCILIATION. NOT pure — this is the one
 * module in the Shopify order pipeline that performs real I/O (a live Shopify
 * Admin GraphQL call). It exists because `shopify-order-normalizer.ts` (pure,
 * REST-only) can never safely establish `totalRefundedMinor` /
 * `financialStatus` once refund evidence is present — see that module's
 * REFUNDS header block for the full, docs-verified reasoning. This module is
 * the trustworthy replacement: it asks Shopify directly, at reconciliation
 * time, using real transaction-level settlement evidence.
 *
 * ===========================================================================
 * WHY GraphQL, AND WHY `transactions(kind: REFUND, status: SUCCESS)`
 * ===========================================================================
 * Verified against Shopify's current Admin GraphQL docs (not guessed):
 *   - `Order.totalRefundedSet` exists but its own field description does not
 *     state whether it excludes pending/failed refund attempts — an
 *     ambiguity this module does not rely on.
 *   - `OrderTransaction.status` (`OrderTransactionStatus`: AWAITING_RESPONSE,
 *     ERROR, FAILURE, PENDING, SUCCESS, UNKNOWN) is the UNAMBIGUOUS,
 *     Shopify-documented settlement signal: "To determine if money has
 *     actually been refunded, check the transaction status."
 *   - `OrderTransactionKind.REFUND`: "A partial or full return of captured
 *     funds to the cardholder. A refund can happen only after a capture is
 *     processed. Refund transactions must be created by using the Refund
 *     resource." Every dollar Shopify has actually returned to a customer —
 *     regardless of whether it originated from a line-item, shipping, duty,
 *     or discrepancy adjustment — manifests as a `kind: REFUND` transaction.
 *     Summing `amountSet.shopMoney` for `kind: REFUND, status: SUCCESS`
 *     transactions is therefore both COMPLETE (no refund sub-shape to
 *     enumerate or miss, unlike REST `refund_line_items` /
 *     `refund_shipping_lines`, the latter of which is GraphQL-only and
 *     absent from REST bodies entirely) and SETTLEMENT-SAFE (a pending or
 *     failed transaction contributes nothing).
 *   - `OrderTransaction.amountSet` is a real `{shopMoney, presentmentMoney}`
 *     MoneyBag (unlike the REST Transaction resource, which has no
 *     `amount_set` at all and defaults its bare `amount` to presentment
 *     currency) — `shopMoney` is read exclusively, matching the rest of this
 *     codebase's shop-currency policy.
 *   - `Order.displayFinancialStatus` (`OrderDisplayFinancialStatus`) is
 *     Shopify's own server-computed "current true state" and maps onto the
 *     SAME neutral `CommerceOrderFinancialStatus` enum the REST normalizer
 *     already uses (same value set, uppercase, plus `EXPIRED` which — like
 *     the REST normalizer's `expired` — has no neutral equivalent and maps
 *     to `null` rather than being guessed).
 *
 * ===========================================================================
 * OUTCOME CONTRACT
 * ===========================================================================
 * Exactly three outcomes, matched to the retry semantics the calling webhook
 * layer needs:
 *   RECONCILED      — a trustworthy snapshot. Safe to overlay onto the
 *                      normalized order and ingest.
 *   NOT_ELIGIBLE     — a DETERMINISTIC reason reconciliation cannot happen
 *                      right now (no usable credential, order id not
 *                      resolvable, Shopify says the order doesn't exist, or
 *                      the response shape is unusable). Retrying the SAME
 *                      webhook delivery would not change this. The caller
 *                      must NOT fabricate a value — it defers (null) instead.
 *   TRANSIENT_FAILURE — a network/HTTP/GraphQL-error condition that plausibly
 *                      resolves on retry. The caller must NOT ingest anything
 *                      for this delivery at all, and must ask Shopify to
 *                      redeliver.
 * Never throws.
 *
 * ===========================================================================
 * WHY `Order.transactions` IS NOT CURSOR-PAGINATED HERE (verified, not
 * assumed away)
 * ===========================================================================
 * `Order.transactions` is documented as a PLAIN ARRAY field —
 * `transactions: [OrderTransaction!]!` — not a Relay-style connection. Its
 * only size-related argument is `first: Int` ("Truncate the array result to
 * this size"); there is no `after`, no `pageInfo`, no `hasNextPage`, no
 * `endCursor` on this field, and Shopify exposes no alternative top-level
 * connection (e.g. no `orderTransactions(first, after)` query root) to page
 * through one order's transactions by cursor. A query requesting
 * `pageInfo`/`after` against this field is not merely unsupported — it is
 * not part of the schema and Shopify would reject it outright.
 *
 * Shopify's own platform-wide ceiling for any `first`/`last` argument across
 * the Admin GraphQL API is 250 ("You can retrieve up to a maximum of 250
 * resources. If you need to paginate larger volumes of data, then you can
 * perform a bulk query operation.") — `MAX_TRANSACTIONS_PER_QUERY` below is
 * already at that ceiling; there is no larger single-request value to ask
 * for on this field.
 *
 * Given no cursor forward exists, "financial correctness must not silently
 * depend on <= 250 transactions" is honored the only way this field
 * structurally allows: by DETECTING the boundary. If Shopify returns exactly
 * `MAX_TRANSACTIONS_PER_QUERY` transactions, this module cannot prove that
 * is the complete list (the field gives no total-count or has-more signal),
 * so it refuses to sum and trust a possibly-truncated batch — it fails
 * closed (`NOT_ELIGIBLE` / `TRANSACTION_COUNT_LIMIT_EXCEEDED`) rather than
 * silently persist an undercounted refund total. If Shopify's schema ever
 * adds real pagination to this field (a connection-typed replacement), this
 * module should be migrated to use it and this limitation removed.
 */

import type { CommerceOrderFinancialStatus } from "@prisma/client";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { getValidAccessToken } from "@/lib/shopify-token-manager";
import { decimalStringToBigIntMinorUnits, getCurrencyExponent } from "../money";

export type ShopifyOrderFinancialSnapshot = {
  externalOrderId: string;
  /** Always the shop's own currency — see the file header. */
  currencyCode: string;
  minorUnitExponent: number;
  totalMinor: bigint;
  /** Sum of settled (`status: SUCCESS`) `kind: REFUND` transactions only. */
  totalRefundedMinor: bigint;
  financialStatus: CommerceOrderFinancialStatus | null;
  /** Shopify's own `Order.updatedAt` at reconciliation time. */
  providerUpdatedAt: Date;
};

export type ReconcileShopifyOrderFinancialsResult =
  | { outcome: "RECONCILED"; snapshot: ShopifyOrderFinancialSnapshot }
  | {
      outcome: "NOT_ELIGIBLE";
      reason:
        | "NO_CREDENTIAL"
        | "INVALID_ORDER_ID"
        | "ORDER_NOT_FOUND"
        | "MALFORMED_SNAPSHOT"
        | "TRANSACTION_COUNT_LIMIT_EXCEEDED";
    }
  | { outcome: "TRANSIENT_FAILURE" };

/**
 * Shopify's platform-wide ceiling for a `first` argument on this field (see
 * the file header's pagination note) — already the maximum obtainable in one
 * request, not a tunable "page size."
 */
const MAX_TRANSACTIONS_PER_QUERY = 250;

/**
 * PURE. Maps `Order.displayFinancialStatus` (verified enum, Admin GraphQL
 * `2026-04`: AUTHORIZED, EXPIRED, PAID, PARTIALLY_PAID, PARTIALLY_REFUNDED,
 * PENDING, REFUNDED, VOIDED) onto the same neutral enum the REST normalizer's
 * `mapShopifyFinancialStatus` already produces. `EXPIRED` has no neutral
 * equivalent (same treatment as REST's `expired`) and any unrecognized value
 * maps to `null` rather than being guessed.
 */
export function mapShopifyDisplayFinancialStatus(
  value: unknown,
): CommerceOrderFinancialStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value) {
    case "PENDING":
      return "PENDING";
    case "AUTHORIZED":
      return "AUTHORIZED";
    case "PARTIALLY_PAID":
      return "PARTIALLY_PAID";
    case "PAID":
      return "PAID";
    case "PARTIALLY_REFUNDED":
      return "PARTIALLY_REFUNDED";
    case "REFUNDED":
      return "REFUNDED";
    case "VOIDED":
      return "VOIDED";
    default:
      return null;
  }
}

/**
 * PURE. A bare positive-integer Shopify REST order id (as every
 * `externalOrderId` this codebase produces for Shopify always is — see
 * `readIdString` in `shopify-order-normalizer.ts`) to the stable, already
 * Shopify-documented `gid://shopify/<Type>/<id>` convention this codebase
 * already relies on elsewhere (`shopifyProductKeyCandidates` in
 * `shopify-order-webhook.ts`). Anything else is rejected rather than
 * string-interpolated into a query variable value unexamined.
 */
export function buildShopifyOrderGid(externalOrderId: string): string | null {
  return /^\d+$/.test(externalOrderId)
    ? `gid://shopify/Order/${externalOrderId}`
    : null;
}

const FINANCIAL_SNAPSHOT_QUERY = `
  query SqratchOrderFinancialSnapshot($id: ID!) {
    order(id: $id) {
      updatedAt
      displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      transactions(first: ${MAX_TRANSACTIONS_PER_QUERY}) {
        kind
        status
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

type GraphQLMoney = { amount?: unknown; currencyCode?: unknown };
type GraphQLTransaction = {
  kind?: unknown;
  status?: unknown;
  amountSet?: { shopMoney?: GraphQLMoney };
};
type GraphQLOrderResponse = {
  data?: {
    order?: {
      updatedAt?: unknown;
      displayFinancialStatus?: unknown;
      totalPriceSet?: { shopMoney?: GraphQLMoney };
      transactions?: unknown;
    } | null;
  };
  errors?: unknown;
};

export type ReconcileShopifyOrderFinancialsDeps = {
  fetchImpl?: typeof fetch;
  /** Defaults to the real `getValidAccessToken`. Injectable for tests. */
  getAccessToken?: (
    brandId: string,
    options: { connectionId: string; expectedExternalAccountId: string },
  ) => Promise<{ ok: true; accessToken: string } | { ok: false }>;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Mirrors `readMoneyAmount`'s bare-value handling in the normalizer, scoped to just string/number (a GraphQL `MoneyV2.amount` is always a decimal string, never a MoneyBag-nested one). */
function readMoneyValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

async function defaultGetAccessToken(
  brandId: string,
  options: { connectionId: string; expectedExternalAccountId: string },
): Promise<{ ok: true; accessToken: string } | { ok: false }> {
  const result = await getValidAccessToken(brandId, options);
  return result.ok ? { ok: true, accessToken: result.accessToken } : { ok: false };
}

/**
 * Fetches the authoritative Shopify financial snapshot for one order. See
 * the file header for the full outcome contract and settlement reasoning.
 */
export async function reconcileShopifyOrderFinancials(
  params: {
    brandId: string;
    connectionId: string;
    shopDomain: string;
    externalOrderId: string;
  },
  deps: ReconcileShopifyOrderFinancialsDeps = {},
): Promise<ReconcileShopifyOrderFinancialsResult> {
  const gid = buildShopifyOrderGid(params.externalOrderId);
  if (!gid) {
    return { outcome: "NOT_ELIGIBLE", reason: "INVALID_ORDER_ID" };
  }

  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const tokenResult = await getAccessToken(params.brandId, {
    connectionId: params.connectionId,
    expectedExternalAccountId: params.shopDomain,
  });
  if (!tokenResult.ok) {
    return { outcome: "NOT_ELIGIBLE", reason: "NO_CREDENTIAL" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(
      `https://${params.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": tokenResult.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query: FINANCIAL_SNAPSHOT_QUERY,
          variables: { id: gid },
        }),
      },
    );
  } catch {
    return { outcome: "TRANSIENT_FAILURE" };
  }

  if (!response.ok) {
    return { outcome: "TRANSIENT_FAILURE" };
  }

  let payload: GraphQLOrderResponse;
  try {
    payload = (await response.json()) as GraphQLOrderResponse;
  } catch {
    return { outcome: "TRANSIENT_FAILURE" };
  }

  // A GraphQL `errors` array on an otherwise well-formed, previously-valid
  // query (throttling, an internal Shopify error) is environmental, not a
  // deterministic rejection of this order's data — retryable.
  if (payload.errors) {
    return { outcome: "TRANSIENT_FAILURE" };
  }

  const graphqlOrder = payload.data?.order;
  if (graphqlOrder === undefined) {
    return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
  }
  // Shopify affirmatively returns `order: null` when the id does not
  // resolve (deleted, wrong shop) — distinct, documented, deterministic.
  if (graphqlOrder === null) {
    return { outcome: "NOT_ELIGIBLE", reason: "ORDER_NOT_FOUND" };
  }

  const currencyCode = readNonEmptyString(graphqlOrder.totalPriceSet?.shopMoney?.currencyCode);
  const totalAmountRaw = readMoneyValue(graphqlOrder.totalPriceSet?.shopMoney?.amount);
  const updatedAtRaw = readNonEmptyString(graphqlOrder.updatedAt);
  if (!currencyCode || totalAmountRaw === null || !updatedAtRaw) {
    return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
  }

  const providerUpdatedAt = new Date(updatedAtRaw);
  if (Number.isNaN(providerUpdatedAt.getTime())) {
    return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
  }

  const { exponent } = getCurrencyExponent(currencyCode);
  const totalParsed = decimalStringToBigIntMinorUnits(totalAmountRaw, exponent);
  if (!totalParsed.ok) {
    return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
  }

  const rawTransactions = graphqlOrder.transactions;
  if (!Array.isArray(rawTransactions)) {
    return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
  }

  // FAIL CLOSED ON POSSIBLE TRUNCATION. `transactions(first: N)` on this
  // field is a plain truncating list, not a paginated connection (see the
  // file header) — Shopify gives no total-count or has-more signal. Getting
  // back exactly the requested ceiling is indistinguishable from "the order
  // has exactly that many transactions" and "there are more we never saw."
  // Summing and returning RECONCILED here could silently understate a
  // refund total forever, with no later signal to correct it — so this
  // never persists a possibly-partial sum.
  if (rawTransactions.length >= MAX_TRANSACTIONS_PER_QUERY) {
    return { outcome: "NOT_ELIGIBLE", reason: "TRANSACTION_COUNT_LIMIT_EXCEEDED" };
  }

  let totalRefundedMinor = BigInt(0);
  for (const entry of rawTransactions as GraphQLTransaction[]) {
    if (entry?.kind !== "REFUND" || entry?.status !== "SUCCESS") {
      // PENDING / FAILURE / ERROR / AWAITING_RESPONSE / UNKNOWN, and every
      // non-REFUND kind (AUTHORIZATION, CAPTURE, SALE, VOID, CHANGE, ...):
      // no settled refund money moved. This is the settlement gate.
      continue;
    }
    const shopMoney = entry.amountSet?.shopMoney;
    const transactionCurrency = readNonEmptyString(shopMoney?.currencyCode);
    const transactionAmountRaw = readMoneyValue(shopMoney?.amount);
    if (!transactionCurrency || transactionAmountRaw === null) {
      return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
    }
    // Defensive re-check, never assumed: a settled REFUND transaction's own
    // shop-currency code must match the order's. A mismatch is unreconcilable
    // data, never silently summed under the wrong currency.
    if (transactionCurrency !== currencyCode) {
      return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
    }
    const transactionParsed = decimalStringToBigIntMinorUnits(transactionAmountRaw, exponent);
    if (!transactionParsed.ok) {
      return { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" };
    }
    totalRefundedMinor += transactionParsed.minorUnits;
  }

  return {
    outcome: "RECONCILED",
    snapshot: {
      externalOrderId: params.externalOrderId,
      currencyCode,
      minorUnitExponent: exponent,
      totalMinor: totalParsed.minorUnits,
      totalRefundedMinor,
      financialStatus: mapShopifyDisplayFinancialStatus(graphqlOrder.displayFinancialStatus),
      providerUpdatedAt,
    },
  };
}
