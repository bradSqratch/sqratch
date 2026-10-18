"use client";

import { signOut } from "next-auth/react";
import CommonNavbar from "@/components/commonNavbar";
import { Button } from "@/components/ui/button";

export default function ApprovalPendingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-page text-ink">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(var(--glow-primary-rgb),0.28),rgba(var(--scene-rgb),0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_15%_25%,rgba(var(--glow-secondary-rgb),0.20),rgba(var(--scene-rgb),0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_85%_30%,rgba(var(--glow-tertiary-rgb),0.18),rgba(var(--scene-rgb),0)_60%)]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-4xl flex-1 items-center justify-center px-6 pt-24 pb-12">
          <div className="w-full max-w-2xl rounded-[32px] border border-edge/15 bg-glass-6 p-8 text-center shadow-[0_8px_28px_rgba(72,57,34,0.06)] dark:shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-10">
            <div className="space-y-4">
              <p className="text-sm uppercase tracking-[0.25em] text-copy-45">
                Approval Pending
              </p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                Wait for your approval from the admin
              </h1>
              <p className="mx-auto max-w-xl text-base leading-7 text-copy-70">
                You will be notified via email once approved. Until then, your
                account cannot access the dashboard.
              </p>
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button
                type="button"
                className="rounded-full bg-primary px-6 text-primary-foreground hover:bg-primary/90"
                onClick={() => void signOut({ callbackUrl: "/login" })}
              >
                Return to Login
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
