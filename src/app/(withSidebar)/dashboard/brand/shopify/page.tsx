import { BrandShopifyClient } from "./BrandShopifyClient";

export default function BrandShopifyPage() {
  return (
    <BrandShopifyClient
      isPublicShopifyApp={process.env.SHOPIFY_APP_DISTRIBUTION === "public"}
    />
  );
}
