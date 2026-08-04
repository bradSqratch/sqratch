"use client";

import { signOut } from "next-auth/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { buildLoginPathWithCallback } from "@/lib/safe-redirect";

/**
 * Signs out of the current SQRATCH session only (Shopify/App Bridge session is
 * untouched) and returns the merchant to login with the exact current path +
 * query string preserved as `callbackUrl`, so a subsequent login with an
 * eligible account lands back on the same page (e.g. a Shopify install URL).
 */
export function SwitchAccountButton({
  label = "Switch SQRATCH account",
}: {
  label?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);

  function handleClick() {
    setPending(true);
    const query = searchParams.toString();
    const currentPath = `${pathname}${query ? `?${query}` : ""}`;
    void signOut({ callbackUrl: buildLoginPathWithCallback(currentPath) });
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={handleClick}
      className="rounded-full border-white/25 bg-transparent px-6 text-white hover:bg-white/10"
    >
      {pending ? "Signing out..." : label}
    </Button>
  );
}
