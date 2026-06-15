import { redirect } from "next/navigation";
import { getBrandAdminContext } from "@/lib/brand-auth";
import React from "react";

export default async function BrandLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = await getBrandAdminContext();

  if (!context?.membership) {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
