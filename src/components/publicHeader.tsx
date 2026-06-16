// components/publicHeader.tsx
"use client";

import Link from "next/link";
import Image from "next/image";

type PublicHeaderProps = {
  showAdminLogin?: boolean;
};

export default function PublicHeader({
  showAdminLogin = false,
}: PublicHeaderProps) {
  return (
    <header className="fixed top-0 w-full inset-x-0 z-50 bg-white/85 backdrop-blur-md border-b border-black/5">
      <div className="mx-auto px-3 sm:px-6">
        <div className="h-15 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/sqratchLogo.png"
              alt="SQRATCH Logo"
              width={120}
              height={40}
              priority
              className="h-10 w-auto"
            />
          </Link>

          {showAdminLogin && (
            <Link href="/login" className="neo-btn rounded-xl">
              Admin Login
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
