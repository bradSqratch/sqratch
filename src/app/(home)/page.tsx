// src/app/(home)/page.tsx
"use client";

import PublicHeader from "@/components/publicHeader";

export default function HomePage() {
  return (
    <div className="relative min-h-screen">
      {/* Header */}
      <PublicHeader showAdminLogin />

      {/* MEDIA LAYER */}
      {/* Mobile: image bg */}
      <div
        className="
          absolute inset-0 bg-[url('/assets/homepage/home_bg-mobile.jpeg')] bg-cover bg-[left_bottom]
          sm:hidden
        "
      />

      {/* Desktop/Tablet: video bg */}
      <div className="absolute inset-0 hidden sm:block">
        <video
          className="w-full h-full object-cover"
          src="/assets/homepage/hero_video.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
      </div>

      {/* Dim overlay for readability (above media, below content) */}
      <div className="absolute inset-0 bg-black/30" />

      {/* CONTENT */}
      <main className="relative z-10 pt-16 flex flex-col items-center justify-center min-h-screen sm:pt-16">
        {/* <h1 className="text-5xl font-bold tracking-[-0.5px] text-[#2C70B7] drop-shadow-sm mobile-hero-text text-center">
          Welcome to the real world.
        </h1> */}
      </main>
    </div>
  );
}
