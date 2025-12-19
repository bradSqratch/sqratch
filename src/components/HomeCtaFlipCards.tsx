"use client";

import WaitlistInline from "@/components/WaitlistInline";

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { IterationCcw, X } from "lucide-react";

type CardData = {
  key: string;
  title: string;
  description: string;
  bgImageUrl: string;
  cta:
    | { type: "link"; label: string; href: string }
    | {
        type: "waitlist";
        placeholder: string;
        buttonLabel: string;
        onSubmit?: (email: string) => Promise<void> | void;
      };
};

function FlipCard({
  title,
  description,
  isOpen,
  onToggle,
  bgImageUrl,
  cta,
}: {
  title: string;
  description: string;
  isOpen: boolean;
  onToggle: () => void;
  bgImageUrl: string;
  cta: CardData["cta"];
}) {
  return (
    <div className="relative w-full [perspective:1200px]">
      <div
        className={[
          "relative h-[520px] w-full rounded-[28px]",
          "transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          "[transform-style:preserve-3d]",
          isOpen ? "[transform:rotateY(180deg)]" : "[transform:rotateY(0deg)]",
        ].join(" ")}
      >
        {/* FRONT */}
        <div
          className={[
            "group absolute inset-0 rounded-[28px] overflow-hidden",
            "border border-white/15 hover:border-white",
            "transition-colors duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
            "shadow-[0_30px_80px_rgba(0,0,0,0.6)]",
            "[backface-visibility:hidden]",
          ].join(" ")}
        >
          {/* Background (video OR image OR nothing) */}
          {bgImageUrl ? (
            bgImageUrl.endsWith(".mp4") ? (
              <video
                className="absolute inset-0 h-full w-full object-cover"
                src={bgImageUrl}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
              />
            ) : (
              <div
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url('${bgImageUrl}')` }}
              />
            )
          ) : null}

          {/* Front overlay */}
          <div className="pointer-events-none absolute inset-0">
            {/* Base dark overlay */}
            <div
              className={[
                "absolute inset-0",
                "bg-black/80",
                "transition-opacity duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
                "group-hover:opacity-0",
              ].join(" ")}
            />

            {/* Hover gradient overlay */}
            <div
              className={[
                "absolute inset-0",
                "bg-[linear-gradient(to_top,rgba(0,0,0,0.8)_0%,rgba(0,0,0,0.7)_25%,rgba(0,0,0,0.00)_100%)]",
                "opacity-0",
                "transition-opacity duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
                "group-hover:opacity-100",
              ].join(" ")}
            />
          </div>

          {/* + button */}
          <button
            type="button"
            onClick={onToggle}
            aria-label={`Open ${title}`}
            className={[
              "absolute left-1/2 top-7 z-20 -translate-x-1/2",
              "h-12 w-12 rounded-full border border-white/25 bg-black/30",
              "grid place-items-center text-white",
              "cursor-pointer select-none",
              "hover:bg-black/55 hover:border-white/45 hover:scale-[1.03]",
              "active:scale-[0.98]",
              "transition",
              "focus:outline-none focus:ring-2 focus:ring-white/30",
            ].join(" ")}
          >
            <IterationCcw
              className={`h-5 w-5 cursor-pointer transition-transform ${
                isOpen ? "rotate-180" : "rotate-0"
              }`}
              strokeWidth={3}
            />
          </button>

          {/* Center title */}
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <h3 className="text-4xl sm:text-5xl font-semibold tracking-tight text-white group-hover:hidden">
              {title}
            </h3>
          </div>

          {/* CTA area */}
          <div className="absolute bottom-8 left-1/2 z-20 w-[92%] max-w-[420px] -translate-x-1/2">
            {cta.type === "link" ? (
              <motion.a
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.98 }}
                href={cta.href}
                target="_blank"
                rel="noreferrer"
                className={[
                  "mx-auto block w-fit",
                  "rounded-full px-6 py-2.5",
                  "border border-white bg-white text-black",
                  "backdrop-blur-md",
                  "transition",
                ].join(" ")}
              >
                {cta.label}
              </motion.a>
            ) : (
              <WaitlistInline
                placeholder={cta.placeholder}
                buttonLabel={cta.buttonLabel}
                onSubmit={cta.onSubmit}
              />
            )}
          </div>

          {/* Subtle inner glow */}
          <div className="absolute inset-0 pointer-events-none rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
        </div>

        {/* BACK */}
        <div
          className={[
            "absolute inset-0 rounded-[28px] overflow-hidden",
            "border border-white shadow-[0_30px_80px_rgba(0,0,0,0.65)]",
            "[backface-visibility:hidden] [transform:rotateY(180deg)]",
          ].join(" ")}
        >
          {/* Background (video OR image) */}
          {bgImageUrl.endsWith(".mp4") ? (
            <video
              className="absolute inset-0 h-full w-full object-cover"
              src={bgImageUrl}
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url('${bgImageUrl}')` }}
            />
          )}

          {/* Dark overlay tint (stronger for readability) */}
          <div
            className={[
              "pointer-events-none absolute inset-0 bg-black/80",
            ].join(" ")}
          />

          {/* Close button */}
          <button
            type="button"
            onClick={onToggle}
            aria-label={`Close ${title}`}
            className={[
              "absolute left-1/2 top-7 z-20 -translate-x-1/2",
              "h-12 w-12 rounded-full border border-white/25 bg-black/35",
              "grid place-items-center text-white",
              "hover:bg-black/55 hover:border-white/35 transition",
              "focus:outline-none focus:ring-2 focus:ring-white/30",
            ].join(" ")}
          >
            <X
              className={`h-5 w-5 cursor-pointer transition-transform ${
                isOpen ? "rotate-180" : "rotate-0"
              }`}
              strokeWidth={3}
            />
          </button>

          {/* Back text */}
          <div className="relative z-10 h-full px-10 sm:px-12 flex items-center justify-center text-center">
            <p className="text-[15px] sm:text-base leading-relaxed text-white max-w-[44ch] drop-shadow-[0_2px_10px_rgba(0,0,0,0.55)]">
              {description}
            </p>
          </div>

          {/* Subtle inner glow */}
          <div className="absolute inset-0 pointer-events-none rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
        </div>
      </div>
    </div>
  );
}

export default function HomeCtaFlipCards() {
  const cards = useMemo<CardData[]>(
    () => [
      {
        key: "creators",
        title: "Value for Creators",
        description:
          "SQRATCH gives creators, brands, and retailers a direct channel to activate and engage loyal supporters. Transform real-world moments into measurable online action—without added friction, complexity, or cost.",
        bgImageUrl: "/assets/homepage/FlipCard1.mp4",
        cta: {
          type: "link",
          label: "Become a Partner",
          href: "https://calendly.com/sqratch/30min",
        },
      },
      {
        key: "fans",
        title: "Free for Fans",
        description:
          "For fans, SQRATCH is effortless and powerful — scan, connect, and participate. Join exclusive communities of real people, engage directly with experts, and unlock unprecedented rewards.",
        bgImageUrl: "/assets/homepage/FlipCard2.png",
        cta: {
          type: "waitlist",
          placeholder: "Enter your email",
          buttonLabel: "Join the Waitlist",
          onSubmit: async (email) => {
            const res = await fetch("/api/public/waitlist", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, source: "flip-card-fans" }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Something went wrong");
          },
        },
      },
    ],
    []
  );

  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <section className="relative w-full py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {cards.map((c) => (
            <FlipCard
              key={c.key}
              title={c.title}
              description={c.description}
              bgImageUrl={c.bgImageUrl}
              cta={c.cta}
              isOpen={openKey === c.key}
              onToggle={() => setOpenKey((k) => (k === c.key ? null : c.key))}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
