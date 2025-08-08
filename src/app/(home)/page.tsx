// app/page.tsx (or wherever your public landing lives)
"use client";

import PublicHeader from "@/components/publicHeader";

export default function HomePage() {
  return (
    <div className="relative min-h-screen bg-[url('/assets/homepage/home_bg.jpeg')] bg-cover bg-center">
      {/* Header */}
      <PublicHeader showAdminLogin />

      {/* Dim overlay for readability */}
      <div className="absolute inset-0 bg-black/20" />

      {/* Main hero */}
      <main className="relative z-10 pt-16 flex items-center justify-center min-h-screen">
        <h1 className="text-5xl font-semibold tracking-[-0.5px] text-[#2C70B7] drop-shadow-sm">
          Welcome to the real world.
        </h1>
      </main>
    </div>
  );
}
