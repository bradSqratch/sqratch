"use client";

import WaitlistInline from "@/components/WaitlistInline";

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { IterationCcw, X } from "lucide-react";

type CardData = {
  key: string;
  title: React.ReactNode;
  subtitle: string;
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
  subtitle,
  description,
  isOpen,
  onToggle,
  bgImageUrl,
  cta,
}: {
  title: React.ReactNode;
  subtitle: string;
  description: string;
  isOpen: boolean;
  onToggle: () => void;
  bgImageUrl: string;
  cta: CardData["cta"];
}) {
  return (
    <div className="relative w-full perspective-distant">
      <div
        className={[
          "relative h-130 w-full rounded-[28px]",
          "transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          "will-change-transform",
          "transform-3d",
          isOpen ? "transform-[rotateY(180deg)]" : "transform-[rotateY(0deg)]",
        ].join(" ")}
      >
        {/* FRONT */}
        <div
          className={[
            "group absolute inset-0 rounded-[28px] overflow-hidden",
            "border border-white/15 hover:border-white",
            "transition-colors duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
            "shadow-[0_30px_80px_rgba(0,0,0,0.6)]",
            "backface-hidden [-webkit-backface-visibility:hidden]",
            "transform-3d",
            "transform-[rotateY(0deg)]",
            isOpen ? "pointer-events-none" : "pointer-events-auto",
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
                "bg-black/60 lg:bg-black/80",
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
              "absolute left-1/2 top-7 -translate-x-1/2 z-20",
              "h-12 w-12 rounded-full border border-white/25 bg-black/30",
              "grid place-items-center text-white",
              "cursor-pointer select-none",
              "hover:bg-black/55 hover:border-white/45 hover:scale-[1.03]",
              "active:scale-[0.98]",
              "transition",
              "focus:outline-none focus:ring-2 focus:ring-white/30",
              "backface-hidden [-webkit-backface-visibility:hidden]",
              "transform-[translateZ(1px)]",
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
            <div className="group-hover:hidden">
              {/* TITLE — 32px */}
              <h4 className="text-[30px] md:text-[32px] sm:text-4xl font-semibold tracking-wide text-white group-hover:hidden">
                {title}
              </h4>
              {/* SUBTITLE — 16px, max 2 lines */}
              <p
                className="
                text-[16px]
                text-white/75
                max-w-[36ch]
                line-clamp-3
                group-hover:hidden
              "
              >
                {subtitle}
              </p>
            </div>
          </div>

          {/* CTA area */}
          <div className="absolute bottom-8 left-1/2 w-[92%] max-w-105 -translate-x-1/2 backface-hidden [-webkit-backface-visibility:hidden] transform-[translateZ(1px)]">
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
            "backface-hidden [-webkit-backface-visibility:hidden]",
            "transform-3d transform-[rotateY(180deg)]",
            isOpen ? "pointer-events-auto" : "pointer-events-none",
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
              "pointer-events-none absolute inset-0 bg-black/60 lg:bg-black/80",
            ].join(" ")}
          />

          {/* Close button */}
          <button
            type="button"
            onClick={onToggle}
            aria-label={`Close ${title}`}
            className={[
              "absolute left-1/2 top-7 -translate-x-1/2 z-20",
              "h-12 w-12 rounded-full border border-white/25 bg-black/35",
              "grid place-items-center text-white",
              "hover:bg-black/55 hover:border-white/35 transition",
              "focus:outline-none focus:ring-2 focus:ring-white/30",
              "backface-hidden [-webkit-backface-visibility:hidden]",
              "transform-[translateZ(1px)]",
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
        title: <>COMMUNITY BUILDERS</>,
        subtitle:
          "Create private, trust-anchored learning communities rooted in real expertise.",
        description:
          "SQRATCH helps experts turn real-world knowledge into private, structured learning environments where users ask questions, learn deeply, and participate with purpose.",
        bgImageUrl: "/assets/homepage/FlipCard1.mp4",
        cta: {
          type: "link",
          label: "Build a Community",
          href: "https://calendly.com/sqratch/30min",
        },
      },
      {
        key: "fans",
        title: <>FOR BRANDS</>,
        subtitle: "Post-purchase education that builds trust — not noise.",
        description:
          "For brands that want to reduce misuse, increase product satisfaction, and build real, long-term engagement through contextual learning — not advertising.",
        bgImageUrl: "/assets/homepage/FlipCard2.mp4",
        cta: {
          type: "link",
          label: "Become A Brand Partner",
          href: "https://calendly.com/sqratch/sqratch-for-brands",
        },
      },
    ],
    []
  );

  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <section className="relative w-full py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-6 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {cards.map((c) => (
            <FlipCard
              key={c.key}
              title={c.title}
              subtitle={c.subtitle}
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
