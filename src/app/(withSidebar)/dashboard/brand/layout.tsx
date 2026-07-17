import { redirect } from "next/navigation";
import { getBrandAdminContext } from "@/lib/brand-auth";
import { resolveActiveBrandContext } from "@/lib/brand-context";
import React from "react";

export default async function BrandLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await getBrandAdminContext({ allowWithoutBrand: true });
  const active = context?.userId
    ? await resolveActiveBrandContext({
        userId: context.userId,
        minimumRole: "MANAGER",
      })
    : null;

  if (!active || (!active.membership && !active.selectionRequired)) {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
