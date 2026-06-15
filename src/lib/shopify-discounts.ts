import { decryptSecret } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

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
  encryptedToken: string;
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
  const accessToken = decryptSecret(input.encryptedToken);
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
  encryptedToken: string;
  discountNodeId: string;
}) {
  const accessToken = decryptSecret(input.encryptedToken);
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
