// src/app/not-found.tsx
import Link from "next/link";
import CommonNavbar from "@/components/commonNavbar";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-[#05050f]">
      {/* Your existing header */}
      <CommonNavbar />

      {/* Background (contact-page vibe) */}
      <div className="relative min-h-screen overflow-hidden pt-16 sm:pt-20">
        {/* gradient washes */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-40 -top-30 h-130 w-130 rounded-full bg-fuchsia-600/20 blur-[90px]" />
          <div className="absolute -right-35 -top-20 h-130 w-130 rounded-full bg-blue-600/20 blur-[90px]" />
          <div className="absolute left-1/2 top-[40%] h-150 w-175 -translate-x-1/2 rounded-full bg-indigo-500/10 blur-[110px]" />
          <div className="absolute inset-0 bg-black/45" />
        </div>

        {/* Card */}
        <div className="relative z-10 mx-auto flex max-w-6xl items-center px-6 pb-10 pt-6">
          <div className="w-full rounded-3xl border border-white/10 bg-white/3 backdrop-blur-xl shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
            <div className="grid grid-cols-1 gap-10 p-8 md:grid-cols-2 md:gap-10 md:p-12">
              {/* LEFT */}
              <div className="flex flex-col justify-center">
                <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/4 px-3 py-1 text-xs text-white/70">
                  <span className="h-2 w-2 rounded-full bg-pink-500" />
                  NOT FOUND
                </div>

                <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-5xl">
                  Oops, Wrong Turn…
                </h1>

                <p className="mt-4 max-w-md text-base leading-relaxed text-white/70">
                  This page doesn’t exist (or you don’t have access to it). If
                  you were trying to use an admin tool, start from your
                  dashboard and navigate from there.
                </p>

                <div className="mt-7 flex flex-wrap items-center gap-3">
                  <Link
                    href="/dashboard"
                    className="inline-flex items-center justify-center rounded-full bg-[#3E93DE] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_32px_rgba(62,147,222,0.35)] hover:opacity-95 transition"
                  >
                    Back to Dashboard
                  </Link>

                  <Link
                    href="/contact"
                    className="inline-flex items-center justify-center rounded-full border border-white/15 bg-white/3 px-5 py-2.5 text-sm font-semibold text-white/85 hover:bg-white/6 hover:text-white transition"
                  >
                    Contact
                  </Link>
                </div>
              </div>

              {/* RIGHT: Better illustration */}
              <div className="flex items-center justify-center">
                <div className="relative w-full max-w-md">
                  <div className="absolute inset-0 rounded-3xl bg-linear-to-br from-pink-500/10 to-blue-500/10 blur-2xl" />
                  <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/2 p-6">
                    <Illustration404 />
                  </div>

                  <div className="mt-4 text-center text-xs text-white/45">
                    404 — Page not found
                  </div>
                </div>
              </div>
            </div>

            {/* Footer inside card */}
            <div className="flex items-center justify-between border-t border-white/10 px-8 py-5 text-xs text-white/45 md:px-12">
              <div>
                © {new Date().getFullYear()} SQRATCH. All rights reserved.
              </div>
              <div className="flex items-center gap-4">
                <Link
                  className="hover:text-white/70 transition"
                  href="/privacy"
                >
                  Privacy
                </Link>
                <Link className="hover:text-white/70 transition" href="/terms">
                  Terms
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function Illustration404() {
  return (
    <svg
      viewBox="0 0 900 520"
      className="h-auto w-full"
      aria-label="404 illustration"
    >
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgba(255,77,141,0.35)" />
          <stop offset="1" stopColor="rgba(62,147,222,0.35)" />
        </linearGradient>

        <radialGradient id="rg" cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="rgba(255,255,255,0.10)" />
          <stop offset="1" stopColor="rgba(255,255,255,0.00)" />
        </radialGradient>

        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow
            dx="0"
            dy="18"
            stdDeviation="18"
            floodColor="rgba(0,0,0,0.55)"
          />
        </filter>

        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="10" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* base */}
      <rect
        x="0"
        y="0"
        width="900"
        height="520"
        rx="26"
        fill="rgba(255,255,255,0.02)"
      />
      <rect x="0" y="0" width="900" height="520" rx="26" fill="url(#rg)" />

      {/* floating particles */}
      <g opacity="0.9">
        <circle cx="120" cy="110" r="10" fill="rgba(255,77,141,0.75)" />
        <circle cx="175" cy="85" r="6" fill="rgba(255,255,255,0.25)" />
        <rect
          x="740"
          y="90"
          width="14"
          height="14"
          rx="3"
          fill="rgba(62,147,222,0.85)"
        />
        <circle cx="780" cy="150" r="8" fill="rgba(255,255,255,0.18)" />
        <rect
          x="110"
          y="220"
          width="18"
          height="18"
          rx="4"
          fill="rgba(255,77,141,0.55)"
        />
      </g>

      {/* “window” */}
      <g filter="url(#softShadow)">
        <rect
          x="90"
          y="70"
          width="720"
          height="340"
          rx="26"
          fill="rgba(0,0,0,0.25)"
          stroke="rgba(255,255,255,0.10)"
        />
        <rect
          x="120"
          y="105"
          width="660"
          height="270"
          rx="22"
          fill="rgba(255,255,255,0.03)"
        />
      </g>

      {/* 404 tiles */}
      <g filter="url(#glow)">
        <rect
          x="170"
          y="135"
          width="160"
          height="85"
          rx="18"
          fill="rgba(255,255,255,0.05)"
          stroke="rgba(255,255,255,0.10)"
        />
        <rect
          x="370"
          y="135"
          width="160"
          height="85"
          rx="18"
          fill="rgba(255,255,255,0.05)"
          stroke="rgba(255,255,255,0.10)"
        />
        <rect
          x="570"
          y="135"
          width="160"
          height="85"
          rx="18"
          fill="rgba(255,255,255,0.05)"
          stroke="rgba(255,255,255,0.10)"
        />

        <text
          x="250"
          y="193"
          textAnchor="middle"
          fontSize="62"
          fill="rgba(255,255,255,0.80)"
          fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Arial"
        >
          4
        </text>
        <text
          x="450"
          y="193"
          textAnchor="middle"
          fontSize="62"
          fill="rgba(255,255,255,0.80)"
          fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Arial"
        >
          0
        </text>
        <text
          x="650"
          y="193"
          textAnchor="middle"
          fontSize="62"
          fill="rgba(255,255,255,0.80)"
          fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Arial"
        >
          4
        </text>

        {/* accent underline */}
        <path
          d="M225 240 L305 240"
          stroke="rgba(255,77,141,0.85)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M425 240 L505 240"
          stroke="rgba(62,147,222,0.85)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M625 240 L705 240"
          stroke="rgba(255,77,141,0.55)"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </g>

      {/* “lost” pile + character */}
      <g transform="translate(180,270)">
        <rect
          x="0"
          y="150"
          width="540"
          height="18"
          rx="9"
          fill="rgba(255,255,255,0.08)"
        />
        <rect
          x="35"
          y="60"
          width="150"
          height="115"
          rx="18"
          fill="rgba(255,255,255,0.04)"
          stroke="rgba(255,255,255,0.10)"
        />
        <rect
          x="205"
          y="35"
          width="170"
          height="140"
          rx="18"
          fill="rgba(255,255,255,0.04)"
          stroke="rgba(255,255,255,0.10)"
        />
        <rect
          x="395"
          y="80"
          width="145"
          height="95"
          rx="18"
          fill="rgba(255,255,255,0.04)"
          stroke="rgba(255,255,255,0.10)"
        />

        {/* tiny character */}
        <circle cx="285" cy="205" r="16" fill="rgba(255,255,255,0.75)" />
        <path
          d="M285 222 C265 222, 255 238, 255 252 C255 286, 315 286, 315 252 C315 238, 305 222, 285 222Z"
          fill="rgba(255,255,255,0.14)"
        />
        <circle cx="278" cy="203" r="3" fill="rgba(0,0,0,0.55)" />
        <circle cx="292" cy="203" r="3" fill="rgba(0,0,0,0.55)" />
        <path
          d="M276 212 C285 218, 294 212, 294 212"
          stroke="rgba(255,77,141,0.75)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>

      {/* subtle border glow */}
      <rect
        x="90"
        y="70"
        width="720"
        height="340"
        rx="26"
        fill="none"
        stroke="url(#g1)"
        opacity="0.45"
      />
    </svg>
  );
}
