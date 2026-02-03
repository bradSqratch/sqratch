"use client";

import React from "react";
import CommonNavbar from "@/components/commonNavbar";
import { Card, CardContent } from "@/components/ui/card";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-[16px] sm:text-[18px] font-semibold tracking-[-0.01em] text-white/90">
        {title}
      </h2>
      <div className="space-y-4 text-[14.5px] sm:text-[15.5px] leading-[1.85] text-white/75">
        {children}
      </div>
    </section>
  );
}

function PullQuote({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/30 p-5 backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(700px_300px_at_20%_0%,rgba(99,102,241,0.20),rgba(0,0,0,0)_55%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(700px_300px_at_90%_90%,rgba(236,72,153,0.12),rgba(0,0,0,0)_55%)]" />
      <div className="relative text-[15px] sm:text-[16px] leading-[1.7] text-white/85">
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
        {/* Primary top glow */}
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(99,102,241,0.30),rgba(2,0,21,0)_70%)]" />
        {/* Left pink glow */}
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_12%_35%,rgba(236,72,153,0.14),rgba(2,0,21,0)_60%)]" />
        {/* Right cyan glow (very subtle) */}
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_88%_38%,rgba(34,211,238,0.10),rgba(2,0,21,0)_60%)]" />
        {/* Vignette */}
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(2,0,21,0)_35%,rgba(2,0,21,0.90)_100%)]" />
        {/* Bottom fade */}
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
      </div>

      {/* Content layer */}
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
              Marketing that gives back — built on usefulness, clarity, and
              respect for your time.
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

            {/* subtle inner gradient so text feels less flat */}
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.05)_0%,rgba(255,255,255,0.02)_30%,rgba(0,0,0,0.00)_100%)]" />

            <CardContent className="relative z-10 p-6 sm:p-10">
              {/* Lead */}
              <div className="space-y-4 text-[15px] sm:text-[16px] leading-[1.9] text-white/80">
                <p className="text-white/85">
                  Hi — we built SQRATCH because we got tired of how marketing
                  works.
                </p>
                <p>
                  Almost everything today is designed to take something from
                  you: your time, your attention, your money, your data — and
                  ultimately, your trust. Very little of it is designed to give
                  anything back.
                </p>
              </div>

              <div className="mt-8 grid gap-6">
                <PullQuote>
                  <span className="text-white font-semibold">
                    SQRATCH is built on a different idea:
                  </span>{" "}
                  marketing does not have to be extractive. It can be about{" "}
                  <span className="text-white">adding value</span> instead of
                  taking it.
                </PullQuote>

                <Section title="Why points exist">
                  <p>
                    We built in points — not as a gimmick, and not as a way to
                    control behaviour — but as a way of recognizing that your
                    attention has value.
                  </p>
                  <p>
                    When you engage thoughtfully, you earn something back. You
                    are not being harvested. You are being rewarded on your
                    terms.
                  </p>
                </Section>

                <Section title="It starts with a sticker">
                  <p>
                    We wanted to build something simple: if you choose to engage
                    with a product after you bought it, you should get something
                    useful in return — real guidance, real expertise, real
                    people who know what they’re talking about.
                  </p>
                  <p>
                    A SQRATCH sticker lives in the real world — on packaging,
                    equipment, tools, and products you actually use. You can
                    ignore it and nothing happens. If you decide to scratch it,
                    you are opting in.
                  </p>
                  <p>
                    Under the surface is a one-time access code. When you scan
                    it, you enter a private learning space built around the
                    product you just bought.
                  </p>
                </Section>

                <Section title="Inside the space">
                  <p>
                    The focus is simple: helping you get more from what you
                    already own — learning how to use things properly,
                    understanding what makes them special, avoiding mistakes,
                    and getting better results.
                  </p>
                  <p>
                    Whether it’s skiing, wine, wellness, tools, or anything
                    else, the goal is always the same: practical understanding
                    that makes ownership more rewarding.
                  </p>
                </Section>

                <PullQuote>
                  We don’t rely on algorithms, feeds, or outrage loops to hold
                  your attention.
                  <br />
                  <span className="text-white font-semibold">
                    We focus on usefulness, clarity, and respect for your time.
                  </span>
                </PullQuote>

                <Section title="For brands and experts">
                  <p>
                    Brands on SQRATCH support expert-led learning so customers
                    can understand and use their products properly.
                  </p>
                  <p>
                    Experts are paid for real knowledge, not popularity. There
                    is no influencer culture, no fake authority, and no pay for
                    praise — just people who know what they’re doing and sharing
                    what they’ve learned.
                  </p>
                </Section>

                <Section title="What we believe">
                  <p>
                    For us, SQRATCH is not about building another platform. It
                    is about showing that business does not have to be
                    manipulative to work — that learning can outperform
                    persuasion — and that trust is still possible online.
                  </p>
                </Section>

                <div className="mt-2 rounded-2xl border border-white/10 bg-white/5 p-6">
                  <div className="text-white/90 font-semibold">
                    A SQRATCH sticker is not marketing.
                  </div>
                  <div className="mt-2 text-white/75 leading-[1.85]">
                    It is a promise: if you choose to engage, you will get
                    something useful in return. No tricks. No traps. No hidden
                    agenda. Just value.
                  </div>
                </div>

                <div className="pt-2 text-white/70 leading-[1.8]">
                  <p>Thanks for being here.</p>
                  <p className="mt-3 text-white/85 font-semibold">
                    The SQRATCH Founders
                    <span className="text-white/60 font-medium">
                      {" "}
                      (Brad, Sumedh, Shaunak, Dan, and Jay)
                    </span>
                  </p>
                </div>
              </div>
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
