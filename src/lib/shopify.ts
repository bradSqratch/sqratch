import crypto from "crypto";

export const SHOPIFY_API_VERSION = "2026-04";
export const SHOPIFY_SCOPES = [
  "read_products",
  "read_discounts",
  "write_discounts",
].join(",");
export const SHOPIFY_PENDING_INSTALL_TTL_MS = 24 * 60 * 60 * 1000;

export function isValidShopDomain(value: string) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value.trim());
}

export function buildShopifyHmac(
  searchParams: URLSearchParams,
  secret: string,
) {
  const entries = Array.from(searchParams.entries())
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHmac("sha256", secret).update(entries).digest("hex");
}

export function verifyShopifyWebhookHmac(options: {
  rawBody: string | Buffer;
  hmac: string | null;
  secret: string;
}) {
  if (!options.hmac) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", options.secret)
    .update(options.rawBody)
    .digest("base64");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(options.hmac, "utf8");

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function createOauthState() {
  return crypto.randomBytes(24).toString("hex");
}

export function buildShopifyPendingInstallService(id: string) {
  return `shopify_pending_install:${id}`;
}

export function getShopifyAppUrl(origin?: string) {
  return (
    process.env.SHOPIFY_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    origin ||
    "http://localhost:3000"
  );
}

export function buildShopifyDashboardRedirect(options?: {
  origin?: string;
  connected?: string;
  error?: string;
}) {
  const url = new URL(
    "/dashboard/brand/shopify",
    getShopifyAppUrl(options?.origin),
  );

  if (options?.connected) {
    url.searchParams.set("connected", options.connected);
  }

  if (options?.error) {
    url.searchParams.set("error", options.error);
  }

  return url;
}

export async function registerShopifyWebhooks(options: {
  shop: string;
  accessToken: string;
  origin?: string;
}) {
  const callbackOrigin = getShopifyAppUrl(options.origin);
  const webhooks = [
    {
      topic: "APP_UNINSTALLED",
      path: "/api/shopify/webhooks/app/uninstalled",
    },
    {
      topic: "CUSTOMERS_DATA_REQUEST",
      path: "/api/shopify/webhooks/customers/data_request",
    },
    {
      topic: "CUSTOMERS_REDACT",
      path: "/api/shopify/webhooks/customers/redact",
    },
    {
      topic: "SHOP_REDACT",
      path: "/api/shopify/webhooks/shop/redact",
    },
  ];

  await Promise.allSettled(
    webhooks.map((webhook) =>
      fetch(
        `https://${options.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": options.accessToken,
          },
          body: JSON.stringify({
            query: `
            mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
              webhookSubscriptionCreate(
                topic: $topic
                webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
              ) {
                userErrors { field message }
              }
            }
          `,
            variables: {
              topic: webhook.topic,
              callbackUrl: new URL(webhook.path, callbackOrigin).toString(),
            },
          }),
        },
      ),
    ),
  );
}
