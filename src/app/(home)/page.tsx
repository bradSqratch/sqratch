"use client";

import Link from "next/link";
import ScratchRevealVideo from "@/components/ScratchRevealVideo";
import StickyWhatSqratchCreates from "@/components/StickyWhatSqratchCreates";
import HomeCtaFlipCards from "@/components/HomeCtaFlipCards";
import WaitlistInline from "@/components/WaitlistInline";
import { motion } from "framer-motion";
import CommonNavbar from "@/components/commonNavbar";

export default function HomePage() {
  return (
    <div className="relative min-h-screen bg-[#020015] text-white">
      {/* ================= HERO SECTION ================= */}
      <section className="relative min-h-screen flex flex-col overflow-x-hidden">
        {/* Video background wrapper */}
        <div className="absolute inset-x-0 top-0 h-screen overflow-hidden">
          {/* Background video */}
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src="/assets/homepage/hero-bg-video.mp4"
            autoPlay
            loop
            muted
            playsInline
          />
          {/* Gradient overlay – applies ONLY to video */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: "#020043",
              opacity: 0.8,
            }}
          />
          <div className="absolute bottom-0 h-62 w-full bg-linear-to-b from-transparent to-[#020121]" />
        </div>

        {/* Figma Background: radial gradient + image, blend lighten, flipped vertically */}
        <div
          className="pointer-events-none absolute left-0 right-0 -top-57 h-146 bg-cover bg-center"
          style={{
            backgroundImage: `
              radial-gradient(
                127.88% 53.54% at 50% 49.91%,
                rgba(24, 15, 79, 0) 0%,
                #020121 100%
              ),
              url('/assets/homepage/hero-overlay-blob.png')
            `,
            mixBlendMode: "lighten",
            transformOrigin: "center",
          }}
        />

        {/* Decorative cubes */}
        <motion.img
          src="/assets/homepage/hero-cube-left.png"
          alt=""
          className="pointer-events-none hidden lg:block absolute -left-28 bottom-36 w-64 drop-shadow-[0_0_70px_rgba(147,197,243,0.6)]"
          initial={{ opacity: 0, rotate: -6, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, rotate: 0, y: [0, -10, 0], scale: 1 }}
          transition={{
            opacity: { duration: 0.45, ease: "easeOut" },
            rotate: { duration: 0.55, ease: "easeOut" },
            scale: { duration: 0.45, ease: "easeOut" },
            y: {
              duration: 5.4,
              repeat: Infinity,
              repeatType: "mirror",
              ease: "easeInOut",
            },
            delay: 0.12,
          }}
        />

        <motion.img
          src="/assets/homepage/hero-cube-right.png"
          alt=""
          className="pointer-events-none hidden lg:block absolute -right-20 top-40 w-60 drop-shadow-[0_0_70px_rgba(244,114,182,0.85)]"
          initial={{ opacity: 0, rotate: -6, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, rotate: 0, y: [0, -10, 0], scale: 1 }}
          transition={{
            opacity: { duration: 0.45, ease: "easeOut" },
            rotate: { duration: 0.55, ease: "easeOut" },
            scale: { duration: 0.45, ease: "easeOut" },
            y: {
              duration: 5.4,
              repeat: Infinity,
              repeatType: "mirror",
              ease: "easeInOut",
            },
            delay: 0.12,
          }}
        />

        {/* NAVBAR */}
        <CommonNavbar />

        {/* HERO CONTENT */}
        <div className="relative z-10 flex flex-1 items-center">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 sm:px-6 lg:px-8 pb-20 pt-32 text-center sm:pt-36 lg:pt-38">
            {/* Small pill */}
            <Link href="/about" className="inline-block">
              <div
                className="
                  flex items-center justify-center
                  rounded-full
                  border border-white/20
                  bg-white/5
                  px-6 py-1
                  text-center text-[14px] leading-[150%] font-normal
                  text-[#F2F4F8]
                  backdrop-blur-md
                  shadow-[0_10px_40px_rgba(15,23,42,0.7)]
                  transition
                  hover:bg-white/10 hover:border-white/30
                  hover:shadow-[0_10px_50px_rgba(99,102,241,0.35)]
                  active:scale-[0.98]
                  cursor-pointer
                "
              >
                About SQRATCH
              </div>
            </Link>

            {/* Headline */}
            <h1
              className="
                mt-16 sm:mt-14 lg:mt-16
                w-full
                text-center
                text-[40px] sm:text-[56px] md:text-[60px] lg:text-[80px]
                font-bold
                leading-[105%] sm:leading-[100%]
                tracking-[-0.03em]
                bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)]
                bg-clip-text
                drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
              "
            >
              {/* Mobile */}
              <span className="sm:hidden">
                Modern products promise outcomes.
                <br />
                SQRATCH delivers the learning
                <br />
                that makes them real.
              </span>

              {/* Desktop / iPad */}
              <span className="hidden sm:inline">
                Learn From SQRATCH
                <br />
              </span>
            </h1>
            {/* Body */}
            <p className="mt-2 max-w-175 text-center text-[20px] lg:text-[22px] font-medium leading-[150%] sm:leading-[160%] text-[#ECECEC]/75">
              {/* visible on Mobile */}
              <span className="sm:hidden">
                SQRATCH is the trusted learning layer for physical products —
                private, expert education at the moment it matters.
              </span>

              {/* visible on Desktop */}
              <span className="hidden sm:inline">
                SQRATCH is the trusted learning layer for physical products —
                <br />
                private, expert education at the moment it matters.
              </span>
            </p>
            {/* CTA buttons */}
            <div className="mt-16 flex flex-wrap w-full items-center justify-center gap-4 sm:w-auto sm:flex-row sm:flex-wrap">
              <div className="w-full max-w-67.5 sm:max-w-none">
                <WaitlistInline
                  placeholder="Enter your email"
                  buttonLabel=" Explore How It Works"
                  onSubmit={async (email) => {
                    try {
                      const res = await fetch("/api/public/waitlist", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          email,
                          source: "homepage-hero",
                        }),
                      });

                      const data = await res.json();

                      if (!res.ok) {
                        throw new Error(data.error || "Something went wrong");
                      }

                      // The WaitlistInline component will handle the success state UI
                      console.log("Joined waitlist:", data);
                    } catch (error) {
                      // Re-throw so the component knows an error occurred
                      console.error("Waitlist error:", error);
                      throw error;
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============== HOW SQRATCH WORKS SECTION ============== */}
      <section className="bg-[#020121] py-24">
        <div className="mx-auto max-w-6xl px-6 sm:px-6 lg:px-8">
          {/* ROW 1: Title + Learn More */}
          <div className="flex items-center justify-between gap-8">
            <div className="max-w-132.5">
              {/* Sub Title */}
              <p className="text-[16px] font-semibold uppercase tracking-[0.30em] text-[#FFFFFF]/50">
                How Sqratch works
              </p>

              {/* Heading */}
              <h2 className="mt-2 sm:mt-3 text-[28px] leading-8.5 sm:text-[32px] sm:leading-10 font-bold tracking-[-0.02em] text-white">
                A pathway built on participation <br />
                and choice.
              </h2>
            </div>
          </div>

          {/* ROW 2: Steps + Card */}
          <div className="mt-12 flex flex-col gap-12 lg:flex-row lg:items-start lg:justify-between">
            {/* LEFT: Steps */}
            <div className="order-2 lg:order-1 max-w-125 space-y-10 mx-auto lg:mx-0 mt-2 md:mt-14 lg:mt-0">
              {/* Step 1 */}
              <div>
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-10 w-10 flex-none shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-[#4f46e5] via-[#8b5cf6] to-[#f97316] shadow-[0_15px_45px_rgba(129,140,248,0.9)]">
                    <span className="text-sm font-semibold text-white">1</span>
                  </div>
                  <div>
                    <h3 className="text-[22px] text-base font-semibold text-white">
                      Scratch
                    </h3>
                    <p className="mt-1 text-[16px] leading-relaxed text-slate-300">
                      A SQRATCH sticker opens the door to what your product can
                      really do. Scratch to reveal your private access code.
                    </p>
                  </div>
                </div>
                <div className="mt-6 h-px w-full bg-white/5" />
              </div>

              {/* Step 2 */}
              <div>
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-10 w-10 flex-none shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-[#22d3ee] via-[#6366f1] to-[#a855f7] shadow-[0_15px_45px_rgba(56,189,248,0.9)]">
                    <span className="text-sm font-semibold text-white">2</span>
                  </div>
                  <div>
                    <h3 className="text-[22px] text-base font-semibold text-white">
                      Scan
                    </h3>
                    <p className="mt-1 text-[16px] leading-relaxed text-slate-300">
                      Scan to learn from people who know the product — how to
                      use it better, why it matters, and how to enjoy it more.
                    </p>
                  </div>
                </div>
                <div className="mt-6 h-px w-full bg-white/5" />
              </div>

              {/* Step 3 */}
              <div>
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-10 w-10 flex-none shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-[#f97316] via-[#ec4899] to-[#22d3ee] shadow-[0_15px_45px_rgba(248,113,113,0.9)]">
                    <span className="text-sm font-semibold text-white">3</span>
                  </div>
                  <div>
                    <h3 className="text-[22px] text-base font-semibold text-white">
                      Learn
                    </h3>
                    <p className="mt-1 text-[16px] leading-relaxed text-slate-300">
                      Skiers learn new tricks. Wine lovers discover what’s in
                      their glass. Every product becomes more useful and more
                      rewarding.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT: Card (Scratch-to-reveal video) */}
            <div className="order-1 lg:order-2 flex flex-1 justify-center lg:justify-end">
              <div className="relative w-full max-w-115">
                {/* Background glow */}
                <div className="absolute inset-0 rounded-[28px] shadow-[0_0_160px_rgba(59,130,246,0.55)]" />

                <div className="relative z-10 w-full">
                  <ScratchRevealVideo
                    backgroundSrc="/assets/homepage/sqratch_qr_bg.png"
                    filmSrc="/assets/homepage/scratchable_film.png"
                    videoSrc="/assets/homepage/skii_video.mp4"
                    revealAtPercent={50}
                    brushRadius={55}
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============== WHAT SQRATCH CREATES SECTION ============== */}
      <StickyWhatSqratchCreates />

      {/* ============== CTA FLIP CARDS SECTION ============== */}
      <HomeCtaFlipCards />

      {/* ============== FOOTER ============== */}
      <footer className="bg-[#020121] py-16 md:py-20">
        <div className="mx-auto max-w-6xl px-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-12">
            {/* First row: Contact + Address & Social */}
            <div className="flex flex-col gap-12 md:grid md:grid-cols-2 md:gap-12">
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-4">
                  <h3 className="text-[22px] md:text-[24px] font-bold leading-7.25 tracking-[-0.01em] text-purple-300">
                    Get in Touch — Partners, Press, & Collaborations
                  </h3>

                  <div className="flex flex-col gap-2.5 text-[16px] md:text-[18px] leading-5.5 tracking-[-0.01em] text-white">
                    <p className="whitespace-normal wrap-break-word">
                      <span className="font-semibold">
                        Press and Speaking Inquiries:
                      </span>{" "}
                      <a
                        href="mailto:press@sqratch.com"
                        className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                      >
                        press@sqratch.com
                      </a>
                    </p>

                    <p className="whitespace-normal wrap-break-word">
                      <span className="font-semibold">
                        Investor & Partner Inquiries:
                      </span>{" "}
                      <a
                        href="mailto:investors@sqratch.com"
                        className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                      >
                        investors@sqratch.com
                      </a>
                    </p>

                    <p>
                      To inquire about creating a custom SQRATCH campaign for
                      your retail or consumer packaged goods brand, please
                      contact{" "}
                      <a
                        href="mailto:campaigns@sqratch.com"
                        className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                      >
                        campaigns@sqratch.com
                      </a>{" "}
                      or book a half hour discovery session on{" "}
                      <a
                        href="https://calendly.com/sqratch/30min"
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                      >
                        Calendly here
                      </a>
                      .
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-10 md:max-w-sm pl-0 md:pl-20">
                <div className="flex flex-col gap-2">
                  <h3 className="text-[22px] md:text-[24px] font-bold leading-7.25 tracking-[-0.01em] text-purple-300">
                    Address
                  </h3>
                  <div className="flex flex-col gap-0">
                    <Link
                      href="https://www.sqratch.com/"
                      className="text-[22px] font-semibold tracking-[-0.03em] text-[#ECECEC] whitespace-nowrap hover:text-white transition"
                    >
                      Sqratch Inc.
                    </Link>
                    <p className="max-w-65 text-[16px] md:text-[18px] leading-5.5 tracking-[-0.01em] text-white">
                      441 Maclaren St. Suite 310, <br />
                      Ottawa ON K2P 2H3
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <h3 className="text-[22px] md:text-[24px] font-bold leading-7.25 tracking-[-0.01em] text-purple-300">
                    Social
                  </h3>
                  <div className="flex flex-col gap-1.5 text-[16px] md:text-[18px] leading-5.5 tracking-[-0.01em] text-white">
                    <a
                      href="https://www.instagram.com/getsqratch"
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-[#CDCDCD]"
                    >
                      Instagram
                    </a>
                  </div>
                </div>
              </div>
            </div>

            {/* Second row: Terms & Privacy + Copyright */}
            <div className="flex flex-col gap-6 md:gap-12 border-t border-white/10 pt-8 md:grid md:grid-cols-2 md:items-center">
              <div className="flex flex-row gap-4 text-[14px] md:text-[16px] text-[#939393] tracking-[-0.01em]">
                <Link href="/terms" className="hover:text-[#ECECEC]">
                  Terms of Service
                </Link>
                <span className="text-[#939393]">•</span>
                <Link href="/privacy" className="hover:text-[#ECECEC]">
                  Privacy Policy
                </Link>
              </div>

              <p className="text-[14px] md:text-[16px] text-[#939393] tracking-[-0.01em] text-left pl-0 md:pl-20">
                © {new Date().getFullYear()} SQRATCH Inc. All rights reserved.
              </p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
