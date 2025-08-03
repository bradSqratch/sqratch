// components/layout/PublicHeader.tsx
"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

type PublicHeaderProps = {
  showAdminLogin?: boolean;
};

export default function PublicHeader({
  showAdminLogin = false,
}: PublicHeaderProps) {
  return (
    <header className="flex items-center justify-between p-4 bg-black shadow">
      <Link href="/">
        <img
          src="/sqratchLogo.png"
          alt="SQRATCH Logo"
          className="h-10 w-auto"
        />
      </Link>
      {showAdminLogin && (
        <Link href="/login">
          <Button
            variant="ghost"
            className="text-amber-100 border-amber-100 border-1 hover:bg-amber-100"
          >
            Admin Login
          </Button>
        </Link>
      )}
    </header>
  );
}
