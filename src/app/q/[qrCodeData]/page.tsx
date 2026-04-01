"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import CommonNavbar from "@/components/commonNavbar";

export default function QRLandingPage() {
  const params = useParams();
  const router = useRouter();
  const qrCodeData = params.qrCodeData as string;

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        // ensure anonymous session exists
        await fetch("/api/public/session", {
          method: "POST",
          credentials: "include",
        });

        const res = await fetch("/api/public/scan", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ qrCodeData }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data?.error || "Invalid QR code.");
        }

        if (!data?.campaignSlug) {
          throw new Error("Campaign not found for this QR code.");
        }

        router.replace(`/c/${data.campaignSlug}`);
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "Failed to unlock this QR code.",
        );
      }
    };

    if (qrCodeData) {
      run();
    }
  }, [qrCodeData, router]);

  return (
    <div className="relative min-h-screen bg-[#020015] text-white overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(99,102,241,0.30),rgba(2,0,21,0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_55%,rgba(99,102,241,0.13),rgba(2,0,21,0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_10%_90%,rgba(236,72,153,0.10),rgba(2,0,21,0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(2,0,21,0)_35%,rgba(2,0,21,0.85)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pt-28 pb-12 sm:pt-32">
          <div className="w-full max-w-3xl text-center">
            <h1
              className="
                mt-2
                text-[40px] sm:text-[56px] lg:text-[64px]
                font-bold leading-[105%] tracking-[-0.03em]
                bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)]
                bg-clip-text text-transparent
                drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
              "
            >
              {error ? "Invalid QR" : "Unlocking..."}
            </h1>

            <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75">
              {error
                ? "This QR code could not be used."
                : "Please wait while we load your campaign."}
            </p>
          </div>

          <div
            className="
              relative mt-10 w-full max-w-md
              rounded-[28px]
              border border-white/15
              bg-white/6
              backdrop-blur-xl
              shadow-[0_30px_90px_rgba(0,0,0,0.55)]
              overflow-hidden
              p-8 text-center
            "
          >
            <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />

            {error ? (
              <div className="space-y-4">
                <p className="text-red-300">{error}</p>
                <Link
                  href="/"
                  className="inline-flex rounded-full border border-white bg-white px-6 py-3 text-black transition hover:scale-[1.01] active:scale-[0.99]"
                >
                  Go Home
                </Link>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-white border-t-transparent" />
                <p className="text-white/80">Unlocking your experience...</p>
              </div>
            )}
          </div>
        </main>

        <div className="pb-6 text-center text-white/55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}
