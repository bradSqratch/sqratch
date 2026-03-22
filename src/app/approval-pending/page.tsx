"use client";

import { signOut } from "next-auth/react";
import CommonNavbar from "@/components/commonNavbar";
import { Button } from "@/components/ui/button";

export default function ApprovalPendingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#020015] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(99,102,241,0.28),rgba(2,0,21,0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_15%_25%,rgba(236,72,153,0.20),rgba(2,0,21,0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_85%_30%,rgba(34,211,238,0.18),rgba(2,0,21,0)_60%)]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-4xl flex-1 items-center justify-center px-6 pt-24 pb-12">
          <div className="w-full max-w-2xl rounded-[32px] border border-white/15 bg-white/6 p-8 text-center shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-10">
            <div className="space-y-4">
              <p className="text-sm uppercase tracking-[0.25em] text-white/45">
                Approval Pending
              </p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                Wait for your approval from the admin
              </h1>
              <p className="mx-auto max-w-xl text-base leading-7 text-white/70">
                You will be notified via email once approved. Until then, your
                account cannot access the dashboard.
              </p>
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button
                type="button"
                className="rounded-full bg-white px-6 text-black hover:bg-white/90"
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
