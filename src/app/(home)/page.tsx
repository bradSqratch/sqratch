// src/app/(home)/page.tsx
"use client";

import PublicHeader from "@/components/publicHeader";

export default function HomePage() {
  return (
    <div className="relative min-h-screen">
      {/* Header */}
      <PublicHeader showAdminLogin />

      {/* MEDIA LAYER */}

      {/* Mobile: <640px */}
      <div className="absolute inset-0 sm:hidden">
        <video
          className="absolute inset-0 w-full h-full object-cover"
          src="/assets/homepage/hero_video_mobile.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
      </div>

      {/* Tablet / Small laptops: 640px–1279px */}
      <div className="absolute inset-0 hidden sm:block xl:hidden">
        {/* Landscape (4:3) */}
        <video
          className="hidden landscape:block absolute inset-0 w-full h-full object-cover"
          src="/assets/homepage/hero_video_ipad_4x3.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/assets/homepage/home_bg.jpeg"
        />
        {/* Portrait (3:4) */}
        <video
          className="hidden portrait:block absolute inset-0 w-full h-full object-cover"
          src="/assets/homepage/hero_video_ipad_3x4.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/assets/homepage/home_bg.jpeg"
        />
      </div>

      {/* Large laptops / 4K monitors: ≥1280px */}
      <div className="absolute inset-0 hidden xl:block">
        <video
          className="absolute inset-0 w-full h-full object-cover"
          src="/assets/homepage/hero_video_laptop.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/assets/homepage/home_bg.jpeg"
        />
      </div>

      {/* Dim overlay for readability */}
      <div className="absolute inset-0 bg-black/30" />

      {/* CONTENT */}
      <main className="relative z-10 pt-16 flex flex-col items-center justify-center min-h-screen sm:pt-16">
        {/* Add hero content here if needed */}
      </main>
    </div>
  );
}
