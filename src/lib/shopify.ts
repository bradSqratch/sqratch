import crypto from "crypto";

export const SHOPIFY_API_VERSION = "2025-01";
export const SHOPIFY_SCOPES = [
  "read_products",
  "write_products",
  "unauthenticated_read_product_listings",
].join(",");

export function isValidShopDomain(value: string) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value.trim());
}

export function buildShopifyHmac(searchParams: URLSearchParams, secret: string) {
  const entries = Array.from(searchParams.entries())
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHmac("sha256", secret).update(entries).digest("hex");
}

export function createOauthState() {
  return crypto.randomBytes(24).toString("hex");
}
