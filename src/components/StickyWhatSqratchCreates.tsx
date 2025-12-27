// src/components/StickyWhatSqratchCreates.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { whatSqratchCreatesSteps } from "@/data/whatSqratchCreatesSteps";
import { AnimatePresence, motion } from "framer-motion";

export default function StickyWhatSqratchCreates() {
  const [activeIndex, setActiveIndex] = useState(-1);
  const blockRefs = useRef<Array<HTMLDivElement | null>>([]);
  const steps = useMemo(() => whatSqratchCreatesSteps, []);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isSquareMode = activeIndex === 0 || activeIndex === 1;
  const isExpandedMode = activeIndex >= 2;

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = 0;
    videoRef.current.play().catch(() => {});
  }, [activeIndex]);

  useEffect(() => {
    let raf = 0;

    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const firstTriggerY = window.innerHeight * 0.65;
        const restTriggerY = window.innerHeight * 0.4;

        let nextIndex = -1;

        for (let i = 0; i < blockRefs.current.length; i++) {
          const el = blockRefs.current[i];
          if (!el) continue;

          const rect = el.getBoundingClientRect();
          const triggerY = i === 0 ? firstTriggerY : restTriggerY;

          if (rect.top <= triggerY) nextIndex = i;
        }

        setActiveIndex((prev) => (prev === nextIndex ? prev : nextIndex));
      });
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const activeStep = activeIndex >= 0 ? steps[activeIndex] : null;

  return (
    <section className="relative bg-[#0C0B30] py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col lg:flex-row lg:gap-20">
          {/* LEFT: Sticky Image Column */}
          <div className="hidden lg:block lg:w-1/2 relative">
            <div className="sticky top-0 h-screen flex items-center justify-center">
              <motion.div
                className="relative flex items-center justify-center overflow-hidden rounded-[30px]"
                // Animate the box itself (this is the “expand all 4 sides”)
                animate={{
                  width: "min(420px, 90vw)",
                  height: isExpandedMode ? "70vh" : "min(420px, 90vw)",
                }}
                transition={{ duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}
              >
                <AnimatePresence mode="sync">
                  {activeStep && (
                    <motion.video
                      key={activeStep.video}
                      src={activeStep.video}
                      ref={videoRef}
                      className={[
                        "absolute inset-0 h-full w-full",
                        isSquareMode
                          ? "object-cover scale-x-[1.22] scale-y-[1.02]"
                          : "object-contain",
                      ].join(" ")}
                      muted
                      playsInline
                      autoPlay
                      loop
                      preload="metadata"
                      controls={false}
                      initial={
                        activeIndex === 0
                          ? { opacity: 0, y: 30, scale: 0.95 }
                          : { opacity: 0, y: 0, scale: 1 }
                      }
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{
                        duration: activeIndex === 0 ? 0.4 : 0.4,
                        ease: "easeOut",
                      }}
                      exit={{
                        opacity: 0,
                        transition: { duration: 0.25, ease: "easeOut" },
                      }}
                    />
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
          </div>

          {/* MOBILE ONLY: Inline Image */}
          <div className="lg:hidden py-12 flex justify-center">
            {activeStep ? (
              <motion.div
                className="relative overflow-hidden rounded-[30px]"
                animate={{
                  width: "min(420px, 90vw)",
                  height: isExpandedMode ? "60vh" : "min(420px, 90vw)",
                }}
                transition={{ duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}
              >
                <video
                  key={activeStep.video}
                  src={activeStep.video}
                  className={[
                    "absolute inset-0 h-full w-full",
                    isSquareMode
                      ? "object-cover scale-x-[1.22] scale-y-[1.02]"
                      : "object-contain",
                  ].join(" ")}
                  muted
                  playsInline
                  autoPlay
                  loop
                  preload="metadata"
                />
              </motion.div>
            ) : (
              <div className="h-[200px]" />
            )}
          </div>

          {/* RIGHT: Scrolling Text */}
          <div className="lg:w-1/2 lg:pl-10 lg:pt-24">
            {steps.map((step, i) => (
              <motion.div
                key={i}
                ref={(el) => {
                  blockRefs.current[i] = el;
                }}
                className="min-h-[80vh] flex flex-col justify-center py-10"
                // === CHANGE START: Animation for First Item Only ===
                // If it's the first item (i===0), we bind it to activeIndex state.
                // If activeIndex >= 0 (video is shown), we show the text.
                // Otherwise, we keep it hidden (opacity 0, y 30) to wait for sync.
                initial={i === 0 ? { opacity: 0, y: 30 } : {}}
                animate={
                  i === 0
                    ? activeIndex >= 0
                      ? { opacity: 1, y: 0 }
                      : { opacity: 0, y: 30 }
                    : {}
                }
                transition={{ duration: 0.4, ease: "easeOut" }}
                // === CHANGE END ===
              >
                <p className="text-[18px] font-semibold uppercase tracking-[0.18em] text-[#CDCDCD]/60">
                  HOW SQRATCH WORKS
                </p>

                <h2 className="mt-4 text-[32px] leading-[1.2] font-bold tracking-[-0.02em] text-white sm:text-[40px]">
                  {step.title}
                </h2>

                <p className="mt-0 text-[18px] leading-[1.6] font-medium text-white/85">
                  {step.subtitle}
                </p>

                <p className="mt-5 text-[16px] leading-[1.85] text-slate-200/80 max-w-[60ch]">
                  {step.paragraph}
                </p>
              </motion.div>
            ))}

            {/* Bottom spacer to allow smooth exit */}
            <div className="h-[20vh]" />
          </div>
        </div>
      </div>
    </section>
  );
}
