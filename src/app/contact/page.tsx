// src/app/contact/page.tsx
"use client";

import React, { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import CommonNavbar from "@/components/commonNavbar";
import { Copy, Check, Mail, MapPin } from "lucide-react";

const COMPANY = "Sqratch Inc.";
const ADDRESS_LINE_1 = "280 Albert Street, Suite 707";
const ADDRESS_LINE_2 = "Ottawa ON K1P 5P3";
const PRESS_EMAIL = "press@sqratch.com";

export default function ContactPage() {
  const [copied, setCopied] = useState<null | "email" | "address">(null);

  const copyToClipboard = async (text: string, which: "email" | "address") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // if clipboard blocked, do nothing
    }
  };

  const fullAddress = `${COMPANY}\n${ADDRESS_LINE_1}\n${ADDRESS_LINE_2}`;

  return (
    <div className="relative min-h-screen bg-[#020015] text-white overflow-hidden">
      {/* Background vibe (similar language to homepage) */}
      <div className="pointer-events-none absolute inset-0">
        {/* base gradient */}
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(99,102,241,0.28),rgba(2,0,21,0)_70%)]" />
        {/* deeper fade */}
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_15%_25%,rgba(236,72,153,0.20),rgba(2,0,21,0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_85%_30%,rgba(34,211,238,0.18),rgba(2,0,21,0)_60%)]" />
        {/* bottom fade into #020121 */}
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
      </div>

      {/* Navbar */}
      <CommonNavbar />

      {/* Content */}
      <main className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-6 pt-28 pb-16 sm:pt-32">
        {/* Top pill */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="flex items-center justify-center rounded-full border border-white/20 bg-white/5 px-6 py-1 text-center text-[14px] leading-[150%] font-normal text-[#F2F4F8] backdrop-blur-md shadow-[0_10px_40px_rgba(15,23,42,0.7)]"
        >
          Press & Address
        </motion.div>

        {/* Headline */}
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.05 }}
          className="
            mt-10 w-full text-center
            text-[40px] sm:text-[56px] lg:text-[64px]
            font-bold leading-[105%] tracking-[-0.03em]
            bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)]
            bg-clip-text text-transparent
            drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
          "
        >
          Contact SQRATCH
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.12 }}
          className="mt-3 max-w-3xl text-center text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75"
        >
          If you’re reaching out for press inquiries, use the email below. For
          official correspondence, use the address listed.
        </motion.p>

        {/* Glass card */}
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: "easeOut", delay: 0.18 }}
          className="
            mt-10 w-full max-w-3xl
            rounded-[28px]
            border border-white/15
            bg-white/6
            backdrop-blur-xl
            shadow-[0_30px_90px_rgba(0,0,0,0.55)]
            overflow-hidden
          "
        >
          {/* subtle inner border glow */}
          <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />

          <div className="grid gap-6 p-6 sm:p-10 md:grid-cols-2">
            {/* Press */}
            <div className="rounded-[20px] border border-white/10 bg-black/25 p-6">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
                  <Mail className="h-5 w-5 text-white/90" />
                </div>
                <div>
                  <p className="text-[14px] uppercase tracking-[0.25em] text-white/50">
                    Press inquiries
                  </p>
                  <h2 className="text-[20px] font-semibold text-white">
                    Email
                  </h2>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                <a
                  href={`mailto:${PRESS_EMAIL}`}
                  className="break-all text-[16px] text-white/90 underline decoration-white/25 underline-offset-4 hover:decoration-white/70"
                >
                  {PRESS_EMAIL}
                </a>

                <button
                  type="button"
                  onClick={() => copyToClipboard(PRESS_EMAIL, "email")}
                  className="shrink-0 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] text-white/90 hover:bg-white/10 transition"
                >
                  {copied === "email" ? (
                    <>
                      <Check className="h-4 w-4" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" /> Copy
                    </>
                  )}
                </button>
              </div>

              <div className="mt-5">
                <a
                  href={`mailto:${PRESS_EMAIL}?subject=${encodeURIComponent(
                    "Press inquiry — SQRATCH"
                  )}`}
                  className="
                    inline-flex w-full items-center justify-center gap-2
                    rounded-full
                    border border-white bg-white text-black
                    px-5 py-3 text-[15px] font-medium
                    hover:scale-[1.01] active:scale-[0.99]
                    transition
                  "
                >
                  Email Press <Mail className="h-4 w-4" />
                </a>
              </div>
            </div>

            {/* Address */}
            <div className="rounded-[20px] border border-white/10 bg-black/25 p-6">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
                  <MapPin className="h-5 w-5 text-white/90" />
                </div>
                <div>
                  <p className="text-[14px] uppercase tracking-[0.25em] text-white/50">
                    Office
                  </p>
                  <h2 className="text-[20px] font-semibold text-white">
                    Address
                  </h2>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                <p className="text-[18px] font-semibold tracking-[-0.02em] text-white">
                  {COMPANY}
                </p>
                <p className="mt-1 text-[16px] leading-relaxed text-white/80">
                  {ADDRESS_LINE_1}
                  <br />
                  {ADDRESS_LINE_2}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(fullAddress, "address")}
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-[14px] text-white/90 hover:bg-white/10 transition"
                  >
                    {copied === "address" ? (
                      <>
                        <Check className="h-4 w-4" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4" /> Copy address
                      </>
                    )}
                  </button>

                  {/* Optional: maps link. Safe + useful. */}
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                      `${ADDRESS_LINE_1}, ${ADDRESS_LINE_2}`
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center rounded-full border border-white/15 bg-white/5 px-4 py-2 text-[14px] text-white/90 hover:bg-white/10 transition"
                  >
                    Open in Maps
                  </a>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom bar (links) */}
          <div className="flex flex-col gap-4 border-t border-white/10 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-10">
            <p className="text-[14px] text-white/55">
              © {new Date().getFullYear()} Sqratch. All rights reserved.
            </p>

            <div className="flex items-center gap-4 text-[14px] text-white/55">
              <Link href="#" className="hover:text-white/80 transition">
                Privacy
              </Link>
              <span className="opacity-40">•</span>
              <Link href="#" className="hover:text-white/80 transition">
                Terms
              </Link>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
