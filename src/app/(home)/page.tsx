"use client";

import Link from "next/link";
import ScratchRevealVideo from "@/components/ScratchRevealVideo";
import StickyWhatSqratchCreates from "@/components/StickyWhatSqratchCreates";
import HomeCtaFlipCards from "@/components/HomeCtaFlipCards";
import WaitlistInline from "@/components/WaitlistInline";

export default function HomePage() {
  return (
    <div className="relative min-h-screen bg-[#020015] text-white">
      {/* ================= HERO SECTION ================= */}
      <section className="relative min-h-screen flex flex-col">
        {/* Video background wrapper */}
        <div className="absolute inset-x-0 top-0 h-[100vh] overflow-hidden">
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
          <div className="absolute bottom-0 h-62 w-full bg-gradient-to-b from-transparent to-[#020121]" />{" "}
        </div>

        {/* Figma Background: radial gradient + image, blend lighten, flipped vertically */}
        <div
          className="pointer-events-none absolute left-0 right-0 -top-[228px] h-[584px] bg-cover bg-center"
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
        <img
          src="/assets/homepage/hero-cube-left.png"
          alt=""
          className="pointer-events-none hidden md:block absolute -left-28 bottom-36 w-64 drop-shadow-[0_0_70px_rgba(147,197,243,0.6)]"
        />
        <img
          src="/assets/homepage/hero-cube-right.png"
          alt=""
          className="pointer-events-none hidden md:block absolute -right-20 top-40 w-60 drop-shadow-[0_0_70px_rgba(244,114,182,0.85)]"
        />

        {/* NAVBAR - Fixed floating header */}
        <header
          className="
            fixed top-0 left-0 right-0 z-50
            bg-black/80
            backdrop-blur-sm
            shadow-[inset_0_-1px_0_rgba(0,50,53,0.2)]
          "
        >
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-1 sm:px-6 lg:px-8">
            {/* Logo */}
            <Link href="/" className="flex items-center">
              <span
                className="
                  logo-text
                  text-white 
                  drop-shadow-[0_0_22px_rgba(255,255,255,0.4)]
                "
              >
                SQRATCH
              </span>
            </Link>

            {/* Actions */}
            <div className="flex items-center gap-4">
              <Link
                href="https://calendly.com/sqratch/30min"
                className="hidden sm:inline-flex h-10 items-center justify-center rounded-full border border-[#ECECEC] bg-transparent px-5 text-[16px] leading-6 font-normal text-[#ECECEC] hover:bg-white hover:text-black transition-colors"
              >
                Become a Partner
              </Link>
            </div>
          </div>
        </header>

        {/* HERO CONTENT */}
        <div className="relative z-10 flex flex-1 items-center">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 sm:px-6 lg:px-8 pb-20 pt-32 text-center sm:pt-36 lg:pt-44">
            {/* Small pill */}
            <div className="flex items-center justify-center rounded-full border border-white/20 bg-white/5 px-6 py-2 text-center text-[17.3345px] leading-[150%] font-normal text-[#F2F4F8] backdrop-blur-md shadow-[0_10px_40px_rgba(15,23,42,0.7)]">
              Nothing Artificial. Real Community.
            </div>

            {/* Headline */}
            <h1
              className="
                mt-16
                w-full
                text-center
                text-[80px]
                font-bold
                leading-[100%]
                tracking-[-0.03em]
                bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)]
                bg-clip-text
                drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
              "
            >
              The internet feels crowded,
              <br />
              but not connected.
            </h1>

            {/* Body */}
            <p className="mt-2 max-w-[700px] text-center text-[22px] font-medium leading-[160%] text-[#ECECEC]/75">
              Every SQRATCH sticker is a tiny portal to something better.
              <br />
              Scratch, scan, instantly connect to a real new world.
            </p>

            {/* CTA buttons */}
            <div className="mt-16 flex flex-wrap items-center justify-center gap-4">
              <WaitlistInline
                placeholder="Enter your email"
                buttonLabel="Join the Waitlist"
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
      </section>

      {/* ============== HOW SQRATCH WORKS SECTION ============== */}
      <section className="bg-[#020121] py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          {/* ROW 1: Title + Learn More */}
          <div className="flex items-center justify-between gap-8">
            <div className="max-w-[530px]">
              {/* Sub Title */}
              <p className="text-[16px] font-semibold uppercase tracking-[0.05em] text-[#CDCDCD]/60">
                How Sqratch works
              </p>

              {/* Heading */}
              <h2 className="mt-3 text-[34px] leading-[40px] font-bold tracking-[-0.02em] text-white">
                A pathway built on participation <br />
                and choice.
              </h2>
            </div>

            {/* Learn More button on the right */}
            {/* <Link
              href="#learn-more"
              className="hidden sm:inline-flex h-[40px] items-center justify-center rounded-full border border-white/35 px-8 text-[17px] font-semibold leading-[120%] text-white hover:bg-white/10 transition-colors"
            >
              Learn More
            </Link> */}
          </div>

          {/* Mobile Learn More (stacked) */}
          <div className="mt-6 sm:hidden">
            <Link
              href="#learn-more"
              className="inline-flex h-[40px] items-center justify-center rounded-full border border-white/35 px-8 text-[17px] font-semibold leading-[120%] text-white hover:bg-white/10 transition-colors"
            >
              Learn More
            </Link>
          </div>

          {/* ROW 2: Steps + Card */}
          <div className="mt-12 flex flex-col gap-12 lg:flex-row lg:items-start lg:justify-between">
            {/* LEFT: Steps */}
            <div className="max-w-[500px] space-y-10">
              {/* Step 1 */}
              <div>
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-10 w-10 flex-none shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#4f46e5] via-[#8b5cf6] to-[#f97316] shadow-[0_15px_45px_rgba(129,140,248,0.9)]">
                    <span className="text-sm font-semibold text-white">1</span>
                  </div>
                  <div>
                    <h3 className="text-[20px] text-base font-semibold text-white">
                      Scratch
                    </h3>
                    <p className="mt-1 text-[14px] leading-relaxed text-slate-300">
                      Everyone in every SQRATCH community is real. No bots, no
                      AI, no machines. Each SQRATCH sticker hides a unique code
                      created for a single person. Revealing it takes intention
                      — a gesture that automated systems cannot imitate.
                    </p>
                  </div>
                </div>
                <div className="mt-6 h-px w-full bg-white/5" />
              </div>

              {/* Step 2 */}
              <div>
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-10 w-10 flex-none shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#22d3ee] via-[#6366f1] to-[#a855f7] shadow-[0_15px_45px_rgba(56,189,248,0.9)]">
                    <span className="text-sm font-semibold text-white">2</span>
                  </div>
                  <div>
                    <h3 className="text-[20px] text-base font-semibold text-white">
                      Scan
                    </h3>
                    <p className="mt-1 text-[14px] leading-relaxed text-slate-300">
                      By joining through SQRATCH, you are surrounded only by
                      real people who share the same passions as you. Scanning
                      presents a clear decision: Do you want to step into this
                      private space designed for people who care?
                    </p>
                  </div>
                </div>
                <div className="mt-6 h-px w-full bg-white/5" />
              </div>

              {/* Step 3 */}
              <div>
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-10 w-10 flex-none shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#f97316] via-[#ec4899] to-[#22d3ee] shadow-[0_15px_45px_rgba(248,113,113,0.9)]">
                    <span className="text-sm font-semibold text-white">3</span>
                  </div>
                  <div>
                    <h3 className="text-[20px] text-base font-semibold text-white">
                      Enter
                    </h3>
                    <p className="mt-1 text-[14px] leading-relaxed text-slate-300">
                      SQRATCH Communities are about participation and belonging.
                      Everyone is equal. Accepting the invitation unlocks a
                      dedicated community shaped by shared interest, unique
                      expertise and genuine participation.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT: Card (Scratch-to-reveal video) */}
            <div className="flex flex-1 justify-center lg:justify-end">
              <div className="relative w-full max-w-[460px]">
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

      {/* ============== MEMBER EXPERIENCE SECTION ============== */}
      {false && (
        <section className="bg-[##0C0B30] py-24">
          <div className="mx-auto flex max-w-6xl flex-col items-center px-4">
            {/* Top title block */}
            <div className="max-w-[800px] text-center">
              <p className="text-[18px] font-semibold uppercase tracking-[0.05em] text-[#CDCDCD]/60">
                Member Experience
              </p>

              <h2 className="mt-4 text-[32px] leading-[1.4] font-semibold text-white sm:text-[40px]">
                Life, but enhanced through
                <br />
                rewarding moments.
              </h2>

              <p className="mt-4 text-[18px] leading-[1.6] text-[#CDCDCD]">
                A private space feels different when everyone chose to be there.
              </p>
            </div>

            {/* Icon grid */}
            <div className="mt-16 grid w-full max-w-[1140px] gap-10 sm:grid-cols-2 lg:grid-cols-3">
              {/* Card 1 */}
              <div className="flex flex-col items-center gap-5 px-4 py-10 text-center lg:border-b lg:border-r lg:border-slate-800/70">
                <div className="flex h-15 w-15 items-center justify-center rounded-full bg-[linear-gradient(146.43deg,#C518C5_17.21%,#4200FF_94.41%)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-7 w-7"
                  />
                </div>
                <h3 className="text-[24px] font-semibold leading-[1.4] text-white">
                  Instant Unlocks
                </h3>
                <p className="max-w-[290px] text-[16px] leading-[1.6] text-[#CDCDCD]">
                  Scratch, scan, and access something meaningful right away.
                </p>
              </div>

              {/* Card 2 */}
              <div className="flex flex-col items-center gap-5 px-4 py-10 text-center lg:border-b lg:border-r lg:border-slate-800/70">
                <div className="flex h-15 w-15 items-center justify-center rounded-full bg-[linear-gradient(146.43deg,#C518C5_17.21%,#4200FF_94.41%)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-7 w-7"
                  />
                </div>
                <h3 className="text-[24px] font-semibold leading-[1.4] text-white">
                  Private Communities
                </h3>
                <p className="max-w-[290px] text-[16px] leading-[1.6] text-[#CDCDCD]">
                  Enter spaces curated around the interests you care about,
                  guided by real practitioners.
                </p>
              </div>

              {/* Card 3 */}
              <div className="flex flex-col items-center gap-5 px-4 py-10 text-center lg:border-b lg:border-slate-800/70">
                <div className="flex h-15 w-15 items-center justify-center rounded-full bg-[linear-gradient(146.43deg,#C518C5_17.21%,#4200FF_94.41%)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-7 w-7"
                  />
                </div>
                <h3 className="text-[24px] font-semibold leading-[1.4] text-white">
                  Personalized Access
                </h3>
                <p className="max-w-[290px] text-[16px] leading-[1.6] text-[#CDCDCD]">
                  Behind-the-scenes content, early drops, digital collectibles,
                  guided experiences, surprise perks.
                </p>
              </div>

              {/* Card 4 */}
              <div className="flex flex-col items-center gap-5 px-4 py-10 text-center lg:border-r lg:border-slate-800/70">
                <div className="flex h-15 w-15 items-center justify-center rounded-full bg-[linear-gradient(146.43deg,#C518C5_17.21%,#4200FF_94.41%)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-7 w-7"
                  />
                </div>
                <h3 className="text-[24px] font-semibold leading-[1.4] text-white">
                  Interactive Experience
                </h3>
                <p className="max-w-[290px] text-[16px] leading-[1.6] text-[#CDCDCD]">
                  Not a broadcast. Not a feed. A focused tribe built around your
                  passions.
                </p>
              </div>

              {/* Card 5 */}
              <div className="flex flex-col items-center gap-5 px-4 py-10 text-center lg:border-r lg:border-slate-800/70">
                <div className="flex h-15 w-15 items-center justify-center rounded-full bg-[linear-gradient(146.43deg,#C518C5_17.21%,#4200FF_94.41%)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-7 w-7"
                  />
                </div>
                <h3 className="text-[24px] font-semibold leading-[1.4] text-white">
                  Physical to Digital
                </h3>
                <p className="max-w-[290px] text-[16px] leading-[1.6] text-[#CDCDCD]">
                  A small action on a product opens a rich digital experience
                  connected to it.
                </p>
              </div>

              {/* Card 6 */}
              <div className="flex flex-col items-center gap-5 px-4 py-10 text-center">
                <div className="flex h-15 w-15 items-center justify-center rounded-full bg-[linear-gradient(146.43deg,#C518C5_17.21%,#4200FF_94.41%)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-7 w-7"
                  />
                </div>
                <h3 className="text-[24px] font-semibold leading-[1.4] text-white">
                  Rewards With Real Value
                </h3>
                <p className="max-w-[290px] text-[16px] leading-[1.6] text-[#CDCDCD]">
                  Engaging, fun, and worth your time. This is a true community
                  shaped by purpose.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ============== BRAND EXPERIENCE SECTION ============== */}
      {false && (
        <section className="relative bg-[#04041B] py-24">
          {/* soft glow behind heading */}
          <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-64 w-full -translate-x-1/2 bg-[radial-gradient(circle_at_top,#4c1d95_0,transparent_60%)] opacity-70" />

          <div className="mx-auto flex max-w-6xl flex-col items-center px-4">
            {/* TITLE BLOCK */}
            <div className="max-w-[800px] text-center">
              <p className="text-[18px] font-semibold uppercase tracking-[0.05em] text-[#CDCDCD]/60">
                Brand Experience
              </p>

              <h2 className="mt-4 text-[32px] font-semibold leading-[1.4] text-white sm:text-[40px] md:text-[48px]">
                Deliver something
                <br className="hidden md:block" /> people truly appreciate.
              </h2>

              <p className="mt-4 text-[18px] leading-[1.6] text-[#CDCDCD]">
                Private entry creates a higher-quality community.
                <br className="hidden md:block" />A higher-quality community
                keeps people engaged.
              </p>
            </div>

            {/* TOP ROW – 2 CARDS */}
            <div className="mt-16 grid w-full gap-8 md:grid-cols-2">
              {/* Card 1 – Analytics Dashboard */}
              <div className="flex h-full flex-col rounded-[20px] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0))] p-10 sm:p-12 shadow-[0_-2px_10px_rgba(233,223,255,0.3),0_-2px_40px_rgba(187,155,255,0.15)] ring-[0.5px] ring-white/50">
                {/* Icon */}
                <div className="mb-6 flex h-[50px] w-[50px] items-center justify-center rounded-2xl bg-[radial-gradient(circle_at_top,#f973ff_0,#7c3aed_40%,#312e81_100%)] shadow-[0_0_36px_rgba(89,29,221,0.75)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-6 w-6"
                  />
                </div>

                {/* Content */}
                <div className="flex flex-1 flex-col gap-4 max-w-[464px]">
                  <h3 className="text-[28px] md:text-[32px] font-medium leading-[1.3] tracking-[-0.01em] text-[#ECECEC]">
                    Analytics Dashboard
                  </h3>
                  <p className="text-[14px] leading-[1.5] text-[#ECECEC]">
                    Our Analytics Dashboard provides a clear and intuitive
                    interface to easily track and analyze your data. From
                    customizable charts to real-time updates, it gives you the
                    insights you need to make confident, data-driven decisions.
                  </p>
                </div>

                {/* Action */}
                <div className="mt-6">
                  <button className="text-[16px] font-medium leading-[1.5] text-white underline">
                    View dashboard
                  </button>
                </div>
              </div>

              {/* Card 2 – Digital Credit Tokens */}
              <div className="flex h-full flex-col rounded-[20px] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0))] p-10 sm:p-12 shadow-[0_-2px_10px_rgba(233,223,255,0.3),0_-2px_40px_rgba(187,155,255,0.15)] ring-[0.5px] ring-white/50">
                {/* Icon */}
                <div className="mb-6 flex h-[50px] w-[50px] items-center justify-center rounded-2xl bg-[radial-gradient(circle_at_top,#fb3bff_0,#a855f7_35%,#4c1d95_100%)] shadow-[0_0_36px_rgba(149,37,201,0.75)]">
                  <img
                    src="/assets/homepage/activity-icon-dummy.svg"
                    alt=""
                    className="h-6 w-6"
                  />
                </div>

                {/* Content */}
                <div className="flex flex-1 flex-col gap-4 max-w-[464px]">
                  <h3 className="text-[28px] md:text-[32px] font-medium leading-[1.3] tracking-[-0.01em] text-[#ECECEC]">
                    Digital Credit Tokens
                  </h3>
                  <p className="text-[14px] leading-[1.5] text-[#ECECEC]">
                    Reward your customers and incentivize engagement with
                    innovative digital credit tokens. Customize them to match
                    your branding and use them as a flexible, scalable way to
                    drive loyalty and repeat business.
                  </p>
                </div>

                {/* Action */}
                <div className="mt-6">
                  <button className="text-[16px] font-medium leading-[1.5] text-white underline">
                    View tokens
                  </button>
                </div>
              </div>
            </div>

            {/* MIDDLE ROW – TEXT + IMAGE CARD */}
            <div className="mt-10 w-full rounded-[20px] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0))] p-8 sm:p-10 md:p-12 shadow-[0_-2px_10px_rgba(233,223,255,0.3),0_-2px_40px_rgba(187,155,255,0.15)] ring-[0.5px] ring-white/50">
              <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
                {/* Left card content */}
                <div className="max-w-[460px]">
                  <div className="mb-6 flex h-[50px] w-[50px] items-center justify-center rounded-2xl bg-[radial-gradient(circle_at_top,#fb3bff_0,#a855f7_35%,#4c1d95_100%)] shadow-[0_0_36px_rgba(201,37,171,0.75)]">
                    <img
                      src="/assets/homepage/activity-icon-dummy.svg"
                      alt=""
                      className="h-6 w-6"
                    />
                  </div>

                  <h3 className="text-[28px] md:text-[32px] font-medium leading-[1.3] tracking-[-0.01em] text-[#ECECEC]">
                    Campaign Collaboration
                  </h3>
                  <p className="mt-4 text-[14px] leading-[1.5] text-[#ECECEC]">
                    Our advanced code-synchronization technology keeps your data
                    accurate and up-to-date, no matter where it’s coming from.
                    Whether you’re integrating multiple sources or working
                    across teams, it’s easy to collaborate and ensure every
                    campaign stays aligned.
                  </p>

                  <button className="mt-6 text-[16px] font-medium leading-[1.5] text-white underline">
                    View code collaboration
                  </button>
                </div>

                {/* Right image block */}
                <div className="flex w-full items-center justify-center md:w-[467px]">
                  <div className="h-[260px] w-full max-w-[467px] rounded-[20px] bg-black shadow-[0_-2px_10px_rgba(233,223,255,0.3),0_-2px_40px_rgba(187,155,255,0.15),0_0_0_2.3px_rgba(0,0,0,0.05),0_0_0_1.1px_rgba(255,255,255,0.1)] ring-[0.5px] ring-white/50 md:h-[300px]">
                    {/* swap this div for an <img> once you have the real asset */}
                  </div>
                </div>
              </div>
            </div>

            {/* BOTTOM CTA CARD */}
            <div className="mt-10 w-full rounded-[20px] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0))] p-10 sm:p-12 md:p-16 text-center shadow-[0_-2px_10px_rgba(233,223,255,0.3),0_-2px_40px_rgba(187,155,255,0.15)] ring-[0.5px] ring-white/50">
              <div className="mx-auto flex max-w-[768px] flex-col items-center gap-6">
                <h3 className="text-[30px] md:text-[40px] leading-[1.2] font-bold text-[#ECECEC]">
                  Our powerful analytics
                  <br className="hidden md:block" />
                  provides invaluable insights.
                </h3>
                <p className="text-[16px] md:text-[18px] leading-[1.5] text-[#ECECEC]">
                  Unlock the power of data with our cutting-edge analytics
                  product. Get instant insights with our user-friendly Analytics
                  Dashboard, and use digital credit tokens to reward your
                  customers and incentivize engagement.
                </p>

                <div className="mt-4">
                  <button className="inline-flex items-center justify-center rounded-full border border-[#ECECEC] px-6 py-3 text-[16px] font-normal text-[#ECECEC]">
                    Download the app
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ============== TESTIMONIALS SECTION ============== */}
      {false && (
        <section className="bg-[#0B0B30] py-24">
          <div className="mx-auto max-w-6xl px-4">
            {/* TITLE ROW */}
            <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
              <div className="max-w-[530px]">
                <p className="text-[18px] font-semibold uppercase tracking-[0.05em] text-[#CDCDCD]/60">
                  Testimonials
                </p>
                <h2 className="mt-4 text-[40px] leading-[1.3] font-semibold text-white sm:text-[48px]">
                  What They Say About
                  <br />
                  Sqartch
                </h2>
              </div>

              {/* See All button */}
              <button className="inline-flex h-[56px] items-center justify-center rounded-full border border-white px-8 text-[17px] font-semibold text-white">
                See All
              </button>
            </div>

            {/* CARDS ROW */}
            <div className="mt-12 grid gap-8 md:grid-cols-3">
              {/* Card 1 */}
              <div className="min-h-[394px] rounded-[30px] bg-[radial-gradient(54.52%_54.52%_at_50%_0%,rgba(131,172,240,0.25)_0.27%,rgba(131,172,240,0)_100%),linear-gradient(180deg,#3E3CA3_0%,#0C0B30_100%)] shadow-[0_25px_80px_rgba(0,0,0,0.85)]">
                <div className="flex h-full flex-col px-10 pb-10 pt-10">
                  {/* Avatar */}
                  <div className="h-20 w-20 rounded-full bg-[#181826]" />

                  {/* Quote */}
                  <div className="mt-8 space-y-3">
                    <h3 className="text-[20px] font-semibold leading-[1.4] text-white">
                      “Secure and Transparent
                      <br />
                      Transactions”
                    </h3>
                    <p className="text-[16px] leading-[1.6] text-[#CDCDCD]">
                      Massa malesuada aliquam fames senectus vitae ornare.
                      Fringilla sit varius mattis ultricies sed nulla.
                    </p>
                  </div>

                  {/* Divider + name */}
                  <div className="mt-auto pt-8">
                    <div className="h-px w-full bg-white/10" />
                    <div className="mt-4 space-y-1">
                      <p className="text-[16px] font-medium text-white">
                        James Reynolds
                      </p>
                      <p className="text-[14px] font-medium text-[#CDCDCD]">
                        Cybersecurity Consultant
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 2 */}
              <div className="min-h-[394px] rounded-[30px] bg-[radial-gradient(54.52%_54.52%_at_50%_0%,rgba(131,172,240,0.25)_0.27%,rgba(131,172,240,0)_100%),linear-gradient(180deg,#3E3CA3_0%,#0C0B30_100%)] shadow-[0_25px_80px_rgba(0,0,0,0.85)]">
                <div className="flex h-full flex-col px-10 pb-10 pt-10">
                  <div className="h-20 w-20 rounded-full bg-[#181826]" />

                  <div className="mt-8 space-y-3">
                    <h3 className="text-[20px] font-semibold leading-[1.4] text-white">
                      “Revolutionary DeFi
                      <br />
                      Platform!”
                    </h3>
                    <p className="text-[16px] leading-[1.6] text-[#CDCDCD]">
                      Massa malesuada aliquam fames senectus vitae ornare.
                      Fringilla sit varius mattis ultricies sed nulla.
                    </p>
                  </div>

                  <div className="mt-auto pt-8">
                    <div className="h-px w-full bg-white/10" />
                    <div className="mt-4 space-y-1">
                      <p className="text-[16px] font-medium text-white">
                        Sarah Thompson
                      </p>
                      <p className="text-[14px] font-medium text-[#CDCDCD]">
                        Financial Analyst
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 3 */}
              <div className="min-h-[394px] rounded-[30px] bg-[radial-gradient(54.52%_54.52%_at_50%_0%,rgba(131,172,240,0.25)_0.27%,rgba(131,172,240,0)_100%),linear-gradient(180deg,#3E3CA3_0%,#0C0B30_100%)] shadow-[0_25px_80px_rgba(0,0,0,0.85)]">
                <div className="flex h-full flex-col px-10 pb-10 pt-10">
                  <div className="h-20 w-20 rounded-full bg-[#181826]" />

                  <div className="mt-8 space-y-3">
                    <h3 className="text-[20px] font-semibold leading-[1.4] text-white">
                      “Empowering Financial
                      <br />
                      Independence”
                    </h3>
                    <p className="text-[16px] leading-[1.6] text-[#CDCDCD]">
                      Massa malesuada aliquam fames senectus vitae ornare.
                      Fringilla sit varius mattis ultricies sed nulla.
                    </p>
                  </div>

                  <div className="mt-auto pt-8">
                    <div className="h-px w-full bg-white/10" />
                    <div className="mt-4 space-y-1">
                      <p className="text-[16px] font-medium text-white">
                        Michael Rodriguez
                      </p>
                      <p className="text-[14px] font-medium text-[#CDCDCD]">
                        Entrepreneur
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ============== FOOTER ============== */}
      <footer className="bg-[#020121] py-16 md:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          {/* THREE COLUMNS */}
          <div className="grid grid-cols-1 gap-12 md:grid-cols-12">
            {/* COLUMN 1 — CONTACT + CAREERS + COPYRIGHT */}
            <div className="flex flex-col gap-10 md:col-span-6 lg:col-span-6">
              {/* Contact */}
              <div className="flex flex-col gap-4">
                <h3 className="text-[24px] font-medium leading-[29px] tracking-[-0.01em] text-white">
                  Contact
                </h3>

                <div className="flex flex-col gap-[10px] text-[18px] leading-[22px] tracking-[-0.01em] text-white">
                  <p className="whitespace-nowrap">
                    Press and Speaking Inquiries:{" "}
                    <a
                      href="mailto:press@sqratch.com"
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                    >
                      press@sqratch.com
                    </a>
                  </p>

                  <p className="whitespace-nowrap">
                    Investor Relations:{" "}
                    <a
                      href="mailto:investors@sqratch.com"
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                    >
                      investors@sqratch.com
                    </a>
                  </p>

                  <p>
                    To inquire about creating a custom SQRATCH campaign for your
                    retail or consumer packaged goods brand, please contact{" "}
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

              {/* Copyright */}
              <p className="text-[16px] text-[#939393] tracking-[-0.01em]">
                © 2026 Sqratch. All rights reserved.
              </p>
            </div>

            {/* COLUMN 2 — ADDRESS + SOCIAL + TERMS */}
            <div className="flex flex-col gap-10 md:col-span-4 lg:col-span-4">
              {/* Address */}
              <div className="flex flex-col gap-4">
                <h3 className="text-[24px] font-medium leading-[29px] tracking-[-0.01em] text-white">
                  Address
                </h3>
                <p className="max-w-[260px] text-[18px] leading-[22px] tracking-[-0.01em] text-white">
                  441 Maclaren St. Suite 310, <br />
                  Ottawa ON K2P 2H3
                </p>
              </div>

              {/* Social */}
              <div className="flex flex-col gap-4">
                <h3 className="text-[24px] font-medium leading-[29px] tracking-[-0.01em] text-white">
                  Social
                </h3>
                <div className="flex flex-col gap-[6px] text-[18px] leading-[22px] tracking-[-0.01em] text-white">
                  {/* <a href="#" className="hover:text-[#CDCDCD]">
                    Twitter
                  </a> */}
                  <a
                    href="https://www.instagram.com/getsqratch"
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-[#CDCDCD]"
                  >
                    Instagram
                  </a>
                  {/* <a href="#" className="hover:text-[#CDCDCD]">
                    TikTok
                  </a> */}
                </div>
              </div>

              {/* Terms + Privacy */}
              <div className="flex flex-row gap-4 text-[16px] text-[#939393] tracking-[-0.01em]">
                <Link href="/terms" className="hover:text-[#ECECEC]">
                  Terms of Service
                </Link>
                <span className="text-[#939393]">•</span>
                <Link href="/privacy" className="hover:text-[#ECECEC]">
                  Privacy Policy
                </Link>
              </div>
            </div>

            {/* COLUMN 3 — EMPTY SPACER WITH LOGO AT BOTTOM */}
            <div className="flex flex-col justify-between md:col-span-2 lg:col-span-2">
              {/* top stays empty */}
              <div />

              {/* bottom-right logo text */}
              <div className="flex justify-end">
                <Link
                  href="https://www.sqratch.com/"
                  className="text-[22px] font-semibold tracking-[-0.03em] text-[#ECECEC] whitespace-nowrap hover:text-white transition"
                >
                  Sqratch Inc.
                </Link>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
