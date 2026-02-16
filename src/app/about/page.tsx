"use client";

import React from "react";
import CommonNavbar from "@/components/commonNavbar";
import { Card, CardContent } from "@/components/ui/card";

function FeatureRow({
  title,
  description,
}: {
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-2xl border border-white/10 bg-black/25 p-4 backdrop-blur-xl">
      <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-white/70 shadow-[0_0_18px_rgba(236,236,236,0.25)]" />
      <div>
        <div className="text-[15px] font-semibold text-white/90">{title}</div>
        <div className="mt-1 text-[14.5px] leading-[1.75] text-white/72">
          {description}
        </div>
      </div>
    </div>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(700px_300px_at_20%_0%,rgba(99,102,241,0.18),rgba(0,0,0,0)_55%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(700px_300px_at_90%_90%,rgba(236,72,153,0.10),rgba(0,0,0,0)_55%)]" />
      <div className="relative text-[15px] sm:text-[16px] leading-[1.7] text-white/82">
        {children}
      </div>
    </div>
  );
}

export default function AboutPage() {
  return (
    <div className="relative min-h-screen bg-[#020015] text-white overflow-hidden">
      {/* Background glows (match your redeem/login vibe) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(99,102,241,0.30),rgba(2,0,21,0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_12%_35%,rgba(236,72,153,0.14),rgba(2,0,21,0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_88%_38%,rgba(34,211,238,0.10),rgba(2,0,21,0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(2,0,21,0)_35%,rgba(2,0,21,0.90)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center px-6 pt-24 pb-12 sm:pt-28">
          {/* Hero */}
          <div className="w-full max-w-4xl text-center">
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
              About SQRATCH
            </h1>

            <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75">
              A single, consistent source of product knowledge — for customers
              and retail teams.
            </p>
          </div>

          {/* Main glass card */}
          <Card
            className="
              relative mt-10 w-full max-w-4xl
              rounded-[28px]
              border border-white/15
              bg-white/6
              backdrop-blur-xl
              shadow-[0_30px_90px_rgba(0,0,0,0.55)]
              overflow-hidden
            "
          >
            <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.05)_0%,rgba(255,255,255,0.02)_30%,rgba(0,0,0,0.00)_100%)]" />

            <CardContent className="relative z-10 p-6 sm:p-10">
              {/* Lead */}
              <div className="space-y-4 text-[15px] sm:text-[16px] leading-[1.9] text-white/80">
                <p className="text-white/85">
                  SQRATCH provides a single, consistent source of product
                  knowledge for both customers and retail teams.
                </p>
                <p>
                  With SQRATCH, each product links to clear, well-produced
                  videos made by real experts and experienced storytellers.
                </p>
              </div>

              {/* Feature list (better than a wall of text) */}
              <div className="mt-8 grid gap-4">
                <FeatureRow
                  title="One product → one trusted source"
                  description="Each product points to a clear set of videos and guidance, so customers and staff aren’t guessing, searching, or relying on random content."
                />
                <FeatureRow
                  title="Quality content, not filler"
                  description="Videos are made to be useful and enjoyable — clear demonstrations, real context, and practical takeaways."
                />
                <FeatureRow
                  title="Simple, respectful access"
                  description="No accounts. No sign-ups. No forced email capture. Just scan and learn."
                />
              </div>

              {/* Privacy callout */}
              <div className="mt-8">
                <Callout>
                  <span className="text-white font-semibold">
                    Privacy isn’t a feature — it’s the default.
                  </span>{" "}
                  Access is simple and respectful, with no accounts, sign-ups,
                  or tracking required. Customers get useful information without
                  sacrificing privacy or providing an email address.
                </Callout>
              </div>

              {/* Secondary emphasis card */}
              <div className="mt-8 rounded-2xl border border-white/10 bg-black/25 p-6 backdrop-blur-xl">
                <div className="text-white/90 font-semibold">
                  Built for the real world
                </div>
                <div className="mt-2 text-white/75 leading-[1.85]">
                  SQRATCH works at the moment it matters — after purchase, in
                  the home, or on the retail floor — giving people the knowledge
                  they need to use a product properly and confidently.
                </div>
              </div>

              {/* Optional CTA row (enable if you want) */}
              {/*
              <div className="mt-10 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/5 p-5">
                <div className="text-white/80">
                  Want to see what a SQRATCH experience looks like?
                </div>
                <a
                  href="/redeemQR"
                  className="rounded-full border border-white bg-white px-6 py-2 text-black transition hover:scale-[1.01] active:scale-[0.99]"
                >
                  Try a demo
                </a>
              </div>
              */}
            </CardContent>
          </Card>
        </main>

        <div className="pb-6 text-center text-white/55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}
