import React from "react";
import CommonNavbar from "@/components/commonNavbar";
import { Card } from "@/components/ui/card";

/** Page frame shared by the account-recovery pages (same look as login). */
export function AuthPageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-section text-ink">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(var(--glow-primary-rgb),0.28),rgba(var(--scene-rgb),0)_70%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-section" />
      </div>
      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pt-20 pb-12 sm:pt-32">
          <div className="w-full max-w-3xl text-center">
            <h1 className="mt-2 text-[36px] font-bold leading-[110%] tracking-[-0.03em] sm:text-[52px]">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-3 text-[16px] leading-[160%] text-copy-75 sm:text-[18px]">{subtitle}</p>
            ) : null}
          </div>
          <Card className="relative mt-10 w-full max-w-md overflow-hidden rounded-[28px] border border-edge/15 bg-glass-6 px-6 py-6 backdrop-blur-xl sm:px-8">
            {children}
          </Card>
        </main>
        <div className="pb-6 text-center text-copy-55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}

export const authInputClass =
  "mt-2 rounded-2xl border-edge/10 bg-inset/30 text-ink placeholder:text-copy-40 focus-visible:ring-0 focus-visible:border-edge/25";
export const authButtonClass =
  "w-full rounded-full py-6 border border-edge bg-primary text-primary-foreground hover:scale-[1.01] active:scale-[0.99] transition";
