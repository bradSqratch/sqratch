import { headers } from "next/headers";
import React from "react";
import { getBrandAdminContext } from "@/lib/brand-auth";
import { AccessDeniedPanel } from "@/components/auth/access-denied-panel";
import { SwitchAccountButton } from "@/components/auth/switch-account-button";

const SHOPIFY_ADMIN_URL = "https://admin.shopify.com";

export default async function BrandLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await getBrandAdminContext({ allowWithoutBrand: true });

  // A genuine denial is: no eligible Brand-management role/membership at all.
  // When the account IS eligible but simply hasn't picked an active Brand yet
  // (selectionRequired), children render as usual so the existing Brand
  // selector can prompt for a choice — that is not an access-denied state.
  if (!context || (!context.membership && !context.selectionRequired)) {
    const pathname = (await headers()).get("x-pathname") || "";
    const isShopifyInstall = pathname.startsWith(
      "/dashboard/brand/shopify/install",
    );

    return (
      <AccessDeniedPanel
        title="Brand Admin access required"
        description={
          isShopifyInstall
            ? "Connecting a Shopify store requires an approved SQRATCH Brand Admin account. This account does not have that access."
            : "This SQRATCH account does not have Brand Admin access."
        }
        requiredAccess="Brand Admin"
        primaryAction={{ label: "Return to dashboard", href: "/dashboard" }}
        secondaryAction={
          isShopifyInstall
            ? { label: "Return to Shopify Admin", href: SHOPIFY_ADMIN_URL }
            : undefined
        }
      >
        <SwitchAccountButton />
      </AccessDeniedPanel>
    );
  }

  return <>{children}</>;
}
