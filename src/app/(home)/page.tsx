// app/page.tsx (or wherever your public landing lives)
"use client";

import PublicHeader from "@/components/publicHeader";

export default function HomePage() {
  return (
    <div
      className="
  relative min-h-screen
  bg-[url('/assets/homepage/home_bg-mobile.jpeg')] bg-cover bg-[left_bottom]
  sm:bg-[url('/assets/homepage/home_bg.jpeg')] sm:bg-center
"
    >
      {/* Header */}
      <PublicHeader showAdminLogin />

      {/* Dim overlay for readability */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Main hero */}
      {/* Main hero */}
      <main className="relative z-10 pt-16 flex flex-col items-center justify-center min-h-screen sm:justify-center sm:pt-0">
        <h1 className="text-5xl font-bold tracking-[-0.5px] text-[#2C70B7] drop-shadow-sm mobile-hero-text">
          Welcome to the real world.
        </h1>
      </main>
    </div>
  );
}
