// src/app/contact/page.tsx
"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import CommonNavbar from "@/components/commonNavbar";
import SiteFooter from "@/components/home/site-footer";
import { Copy, Check, Mail, MapPin } from "lucide-react";

const COMPANY = "Sqratch Inc.";
const ADDRESS_LINE_1 = "280 Albert Street, Suite 706";
const ADDRESS_LINE_2 = "Ottawa ON K1P 5P3";
const PRESS_EMAIL = "press@sqratch.com";
const SUPPORT_EMAIL = "support@sqratch.com";

export default function ContactPage() {
  const [copied, setCopied] = useState<null | "press" | "support" | "address">(
    null
  );

  const copyToClipboard = async (
    text: string,
    which: "press" | "support" | "address"
  ) => {
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
          For product help, account access, Shopify app questions, or press
          inquiries, use the contacts below.
        </motion.p>

        {/* Glass card */}
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: "easeOut", delay: 0.18 }}
          className="
            mt-10 w-full max-w-4xl
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
            {/* Support */}
            <div className="rounded-[20px] border border-white/10 bg-black/25 p-6">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
                  <Mail className="h-5 w-5 text-white/90" />
                </div>
                <div>
                  <p className="text-[14px] uppercase tracking-[0.25em] text-white/50">
                    Support
                  </p>
                  <h2 className="text-[20px] font-semibold text-white">
                    Product help
                  </h2>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="min-w-0 truncate text-[15px] text-white/90 underline decoration-white/25 underline-offset-4 hover:decoration-white/70 sm:text-[16px]"
                >
                  {SUPPORT_EMAIL}
                </a>

                <button
                  type="button"
                  onClick={() => copyToClipboard(SUPPORT_EMAIL, "support")}
                  className="shrink-0 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] text-white/90 hover:bg-white/10 transition"
                >
                  {copied === "support" ? (
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
                  href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                    "Support inquiry — SQRATCH"
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
                  Email Support <Mail className="h-4 w-4" />
                </a>
              </div>
            </div>

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
                  className="min-w-0 truncate text-[15px] text-white/90 underline decoration-white/25 underline-offset-4 hover:decoration-white/70 sm:text-[16px]"
                >
                  {PRESS_EMAIL}
                </a>

                <button
                  type="button"
                  onClick={() => copyToClipboard(PRESS_EMAIL, "press")}
                  className="shrink-0 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[13px] text-white/90 hover:bg-white/10 transition"
                >
                  {copied === "press" ? (
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
            <div className="rounded-[24px] border border-white/10 bg-[radial-gradient(700px_260px_at_12%_0%,rgba(168,85,247,0.16),rgba(0,0,0,0)_60%),rgba(0,0,0,0.25)] p-6 md:col-span-2">
              <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-center">
                <div className="flex items-start gap-4">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/5 ring-1 ring-white/10">
                    <MapPin className="h-5 w-5 text-purple-200" />
                  </div>
                  <div>
                    <p className="text-[14px] uppercase tracking-[0.25em] text-white/50">
                      Office
                    </p>
                    <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-white">
                      Sqratch Inc.
                    </h2>
                    <p className="mt-2 text-[17px] leading-relaxed text-white/78">
                      {ADDRESS_LINE_1}
                      <br />
                      {ADDRESS_LINE_2}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 md:justify-end">
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
        </motion.div>
      </main>

      <div className="relative z-10">
        <SiteFooter />
      </div>
    </div>
  );
}
