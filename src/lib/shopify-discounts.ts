import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type DiscountByCodeResponse = {
  data?: {
    codeDiscountNodeByCode?: {
      id: string;
      codeDiscount?: {
        status?: string | null;
        endsAt?: string | null;
        asyncUsageCount?: number | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

type ShopifyUserError = {
  field?: string[] | null;
  message: string;
  code?: string | null;
};

type CreateDiscountResponse = {
  data?: {
    discountCodeBasicCreate?: {
      codeDiscountNode?: {
        id: string;
        codeDiscount?: {
          startsAt?: string | null;
          endsAt?: string | null;
        } | null;
      } | null;
      userErrors?: ShopifyUserError[];
    };
  };
  errors?: Array<{ message?: string }>;
};

type DiscountUsageResponse = {
  data?: {
    node?: {
      id: string;
      codeDiscount?: {
        status?: string | null;
        asyncUsageCount?: number | null;
        usageLimit?: number | null;
        endsAt?: string | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

function formatAmount(cents: number) {
  return (cents / 100).toFixed(2);
}

function formatGraphqlErrors(errors?: Array<{ message?: string }>) {
  return errors?.map((error) => error.message).filter(Boolean).join(" ") || null;
}

export async function createShopifyRewardDiscountCode(input: {
  shopDomain: string;
  accessToken: string;
  title: string;
  code: string;
  issuedAt: Date;
  codeValidDays: number;
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountAmountCents: number | null;
  discountPercentageBasisPoints: number | null;
  appliesTo: "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS";
  shopifyProductGids?: string[];
  minimumSubtotalCents?: number | null;
}) {
  const accessToken = input.accessToken;
  const startsAt = input.issuedAt;
  const endsAt = new Date(
    startsAt.getTime() + input.codeValidDays * 24 * 60 * 60 * 1000,
  );
  const items =
    input.appliesTo === "SPECIFIC_PRODUCTS"
      ? {
          products: {
            productsToAdd: input.shopifyProductGids || [],
          },
        }
      : {
          all: true,
        };
  const minimumRequirement =
    input.minimumSubtotalCents && input.minimumSubtotalCents > 0
      ? {
          subtotal: {
            greaterThanOrEqualToSubtotal: formatAmount(
              input.minimumSubtotalCents,
            ),
          },
        }
      : undefined;

  const value =
    input.discountType === "PERCENTAGE"
      ? {
          percentage: Number((input.discountPercentageBasisPoints! / 10000).toFixed(4)),
        }
      : {
          discountAmount: {
            amount: formatAmount(input.discountAmountCents!),
            appliesOnEachItem: false,
          },
        };

  const response = await fetch(
    `https://${input.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          mutation SqratchRewardDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
            discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
              codeDiscountNode {
                id
                codeDiscount {
                  ... on DiscountCodeBasic {
                    startsAt
                    endsAt
                  }
                }
              }
              userErrors {
                field
                message
                code
              }
            }
          }
        `,
        variables: {
          basicCodeDiscount: {
            title: input.title,
            code: input.code,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            customerSelection: {
              all: true,
            },
            customerGets: {
              value,
              items,
            },
            minimumRequirement,
            usageLimit: 1,
            appliesOncePerCustomer: false,
          },
        },
      }),
      cache: "no-store",
    },
  );

  const json = (await response.json().catch(() => null)) as
    | CreateDiscountResponse
    | null;
  const userErrors =
    json?.data?.discountCodeBasicCreate?.userErrors?.filter(
      (error) => error.message,
    ) || [];
  const node = json?.data?.discountCodeBasicCreate?.codeDiscountNode;
  const graphqlError = formatGraphqlErrors(json?.errors);

  if (!response.ok || graphqlError || userErrors.length > 0 || !node?.id) {
    return {
      ok: false as const,
      status: response.ok ? 502 : response.status || 500,
      error:
        graphqlError ||
        userErrors.map((error) => error.message).join(" ") ||
        "Failed to create Shopify discount code.",
      userErrors,
      startsAt,
      endsAt,
    };
  }

  return {
    ok: true as const,
    discountNodeId: node.id,
    code: input.code,
    startsAt: node.codeDiscount?.startsAt
      ? new Date(node.codeDiscount.startsAt)
      : startsAt,
    endsAt: node.codeDiscount?.endsAt ? new Date(node.codeDiscount.endsAt) : endsAt,
    userErrors,
  };
}

export async function getShopifyDiscountUsageStatus(input: {
  shopDomain: string;
  accessToken: string;
  discountNodeId: string;
}) {
  const accessToken = input.accessToken;
  const response = await fetch(
    `https://${input.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query SqratchDiscountUsage($id: ID!) {
            node(id: $id) {
              ... on DiscountCodeNode {
                id
                codeDiscount {
                  ... on DiscountCodeBasic {
                    status
                    asyncUsageCount
                    usageLimit
                    endsAt
                  }
                }
              }
            }
          }
        `,
        variables: {
          id: input.discountNodeId,
        },
      }),
      cache: "no-store",
    },
  );

  const json = (await response.json().catch(() => null)) as
    | DiscountUsageResponse
    | null;
  const graphqlError = formatGraphqlErrors(json?.errors);
  const discount = json?.data?.node?.codeDiscount;

  if (!response.ok || graphqlError || !discount) {
    return {
      ok: false as const,
      status: response.ok ? 502 : response.status || 500,
      error: graphqlError || "Failed to fetch Shopify discount status.",
    };
  }

  const endsAt = discount.endsAt ? new Date(discount.endsAt) : null;
  const asyncUsageCount = discount.asyncUsageCount || 0;
  const derivedStatus =
    asyncUsageCount >= 1
      ? "USED"
      : endsAt && endsAt.getTime() < Date.now()
        ? "EXPIRED"
        : null;

  return {
    ok: true as const,
    status: discount.status || null,
    asyncUsageCount,
    usageLimit: discount.usageLimit || null,
    endsAt,
    derivedStatus,
  };
}

/**
 * Looks up a Shopify discount code node by its code string.
 *
 * Returns a discriminated union:
 *   { ok:true, exists:true, discountNodeId, status, endsAt, asyncUsageCount }
 *   { ok:true, exists:false }          — code definitely not found on Shopify
 *   { ok:false, status, error }        — HTTP/GraphQL error (AMBIGUOUS — retry later)
 *
 * SECURITY: accessToken is never logged.
 */
export async function getShopifyDiscountByCode(input: {
  shopDomain: string;
  accessToken: string;
  code: string;
}): Promise<
  | { ok: true; exists: true; discountNodeId: string; status: string | null; endsAt: Date | null; asyncUsageCount: number }
  | { ok: true; exists: false }
  | { ok: false; status: number; error: string }
> {
  let response: Response;
  try {
    response = await fetch(
      `https://${input.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": input.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `
            query SqratchDiscountByCode($code: String!) {
              codeDiscountNodeByCode(code: $code) {
                id
                codeDiscount {
                  ... on DiscountCodeBasic {
                    status
                    endsAt
                    asyncUsageCount
                  }
                }
              }
            }
          `,
          variables: { code: input.code },
        }),
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, status: 503, error: "Network error fetching discount by code." };
  }

  const json = (await response.json().catch(() => null)) as DiscountByCodeResponse | null;
  const graphqlError = formatGraphqlErrors(json?.errors);

  if (!response.ok || graphqlError) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status || 500,
      error: graphqlError || "Failed to fetch Shopify discount by code.",
    };
  }

  // Explicit null means the code does not exist on Shopify
  if (json?.data?.codeDiscountNodeByCode === null || json?.data?.codeDiscountNodeByCode === undefined) {
    return { ok: true, exists: false };
  }

  const node = json.data.codeDiscountNodeByCode;
  const codeDiscount = node.codeDiscount;

  return {
    ok: true,
    exists: true,
    discountNodeId: node.id,
    status: codeDiscount?.status ?? null,
    endsAt: codeDiscount?.endsAt ? new Date(codeDiscount.endsAt) : null,
    asyncUsageCount: codeDiscount?.asyncUsageCount ?? 0,
  };
}
