import crypto from "crypto";
import { decryptSecret } from "@/lib/crypto";

// NOTE: registerShopifyWebhooks has been removed. All webhook subscriptions
// (app/uninstalled + the 3 GDPR compliance topics) are declared via
// shopify.app.toml / shopify.app.custom.toml config. Shopify does not allow
// registering compliance topics (CUSTOMERS_DATA_REQUEST, CUSTOMERS_REDACT,
// SHOP_REDACT) via the API at all, so runtime registration was both redundant
// and partly unsupported.

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

/** Timing-safe string equality — returns false when lengths differ. */
export function safeHmacEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createOauthState() {
  return crypto.randomBytes(24).toString("hex");
}

export function buildShopifyPendingInstallService(id: string) {
  return `shopify_pending_install:${id}`;
}

export function getShopifyAppUrl(origin?: string) {
  const resolved =
    process.env.SHOPIFY_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    (process.env.NODE_ENV !== "production" ? origin : undefined) ||
    (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined);

  if (process.env.NODE_ENV === "production") {
    if (!resolved) {
      throw new Error(
        "[Shopify] No app URL configured for production. " +
          "Set SHOPIFY_APP_URL, NEXT_PUBLIC_APP_URL, or NEXTAUTH_URL.",
      );
    }
    if (!resolved.startsWith("https://")) {
      throw new Error(
        `[Shopify] App URL must use HTTPS in production. Got: ${resolved}`,
      );
    }
  }

  return resolved as string;
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

export async function getShopifyShopCurrency(input: {
  shopDomain: string;
  encryptedToken: string;
}) {
  try {
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
            query SqratchShopCurrency {
              shop {
                currencyCode
              }
            }
          `,
        }),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return {
        ok: false as const,
        error: `Shopify request failed with status ${response.status}`,
      };
    }

    const json = await response.json().catch(() => null);
    if (!json) {
      return { ok: false as const, error: "Empty response from Shopify" };
    }

    if (json.errors && json.errors.length > 0) {
      const msg = (json.errors as Array<{ message?: string }>)
        .map((e) => e.message)
        .filter(Boolean)
        .join(" ");
      return { ok: false as const, error: msg || "Unknown Shopify error" };
    }

    const currencyCode = json.data?.shop?.currencyCode;
    if (!currencyCode) {
      return { ok: false as const, error: "Currency code missing from shop query response" };
    }

    const normalized = String(currencyCode).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) {
      return { ok: false as const, error: `Invalid currency code: ${normalized}` };
    }

    return { ok: true as const, currencyCode: normalized };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error querying currency";
    return { ok: false as const, error: message };
  }
}
