"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import CommonNavbar from "@/components/commonNavbar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  parsePublicCampaignPayload,
  type PublicCampaignPayload,
} from "@/lib/commerce/public-commerce-response";

/**
 * Owned by `parsePublicCampaignPayload`, which is what actually proves a
 * payload matches at runtime. Aliased rather than re-declared so the rendered
 * shape and the validated shape cannot drift.
 */
type CampaignPayload = PublicCampaignPayload;

export default function CampaignPage() {
  const params = useParams();
  const campaignSlug = params.campaignSlug as string;

  const [data, setData] = useState<CampaignPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(
          `/api/public/campaign/${encodeURIComponent(campaignSlug)}`,
          { credentials: "include" },
        );
        const json = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(json?.error || "Failed to load campaign.");
        }

        // Validated at RUNTIME. This previously assigned `json.data`
        // unchecked, so a malformed body reached the render and threw on
        // `data.experiences.map(...)`. `isUnlocked` in particular must never
        // be coerced — a garbled value would misrepresent whether the
        // campaign is unlocked.
        const parsed = parsePublicCampaignPayload(json?.data);

        if (!parsed) {
          throw new Error("Failed to load campaign.");
        }

        setData(parsed);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Failed to load campaign.",
        );
      } finally {
        setLoading(false);
      }
    };

    if (campaignSlug) {
      load();
    }
  }, [campaignSlug]);

  return (
    <div className="relative min-h-screen bg-page text-ink overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(var(--glow-primary-rgb),0.30),rgba(var(--scene-rgb),0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_55%,rgba(var(--glow-primary-rgb),0.13),rgba(var(--scene-rgb),0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_10%_90%,rgba(var(--glow-secondary-rgb),0.10),rgba(var(--scene-rgb),0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(var(--scene-rgb),0)_35%,rgba(var(--scene-rgb),0.85)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-section" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 pt-28 pb-12 sm:pt-32">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-4">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-edge border-t-transparent" />
                <p className="text-copy-80">Loading campaign...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center">
              <Card className="w-full max-w-md rounded-[28px] border border-edge/15 bg-glass-6 backdrop-blur-xl text-ink">
                <CardContent className="p-8 text-center space-y-4">
                  <p className="text-red-700 dark:text-red-300">{error}</p>
                  <Link
                    href="/"
                    className="inline-flex rounded-full border border-[#c73484] bg-[#c73484] px-6 py-3 text-[#e5e6ea] hover:bg-[#b72f78]"
                  >
                    Go Home
                  </Link>
                </CardContent>
              </Card>
            </div>
          ) : data ? (
            <>
              <div className="max-w-3xl">
                <div className="flex items-center gap-3">
                  <h1
                    className="
                      text-[40px] sm:text-[56px] lg:text-[64px]
                      font-bold leading-[105%] tracking-[-0.03em]
                      bg-[image:var(--heading-gradient)]
                      bg-clip-text text-transparent
                      drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
                    "
                  >
                    {data.name}
                  </h1>

                  {data.isUnlocked && (
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                      Unlocked
                    </span>
                  )}
                </div>

                {data.brand?.name && (
                  <p className="mt-2 text-copy-70">by {data.brand.name}</p>
                )}

                {data.description && (
                  <p className="mt-4 max-w-2xl text-[16px] leading-[160%] text-copy-75">
                    {data.description}
                  </p>
                )}

                {data.hasRedeemedQrWarning && (
                  <div className="mt-5 max-w-2xl rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-700 dark:text-amber-100">
                    This QR code has already been redeemed. You can still view
                    public content, but you will not earn points or unlock
                    private access from this QR code.
                  </div>
                )}
              </div>

              <div className="mt-10">
                <h2 className="mb-4 text-2xl font-semibold text-brand">
                  Experiences
                </h2>

                {data.experiences.length === 0 ? (
                  <Card className="rounded-[28px] border border-edge/15 bg-glass-6 backdrop-blur-xl text-ink">
                    <CardContent className="p-8 text-copy-70">
                      No experiences available for this campaign yet.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {data.experiences.map((exp) => (
                      <Card
                        key={exp.slug}
                        className="rounded-[28px] border border-edge/15 bg-glass-6 backdrop-blur-xl text-ink overflow-hidden"
                      >
                        <CardContent className="p-5 space-y-4">
                          <div className="h-40 rounded-2xl bg-glass-5 border border-edge/10 overflow-hidden">
                            {exp.coverImageUrl ? (
                              <Image
                                src={exp.coverImageUrl}
                                alt={exp.title}
                                width={400}
                                height={160}
                                unoptimized
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center text-copy-40">
                                No cover image
                              </div>
                            )}
                          </div>

                          <div>
                            <h3 className="text-lg font-semibold text-brand">
                              {exp.title}
                            </h3>
                          </div>

                          <Button
                            asChild
                            className="w-full rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
                          >
                            <a
                              href={`/api/public/campaign/${encodeURIComponent(campaignSlug)}/experience/${encodeURIComponent(exp.slug)}`}
                            >
                              Continue
                            </a>
                          </Button>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </main>

        <div className="pb-6 text-center text-copy-55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}
