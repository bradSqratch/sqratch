"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReactNode } from "react";
import CommonNavbar from "@/components/commonNavbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { ExperienceShellData } from "@/components/experience/use-experience";

type ExperienceTab = "hub" | "learn" | "posts" | "qa" | "shop";

type ExperienceShellProps = {
  experience: ExperienceShellData;
  activeTab: ExperienceTab;
  children: ReactNode;
  actions?: ReactNode;
};

const tabHrefMap: Record<ExperienceTab, (slug: string) => string> = {
  hub: (slug) => `/x/${slug}`,
  learn: (slug) => `/x/${slug}/learn`,
  posts: (slug) => `/x/${slug}/posts`,
  qa: (slug) => `/x/${slug}/qa`,
  shop: (slug) => `/x/${slug}/shop`,
};

export function ExperienceShell({
  experience,
  activeTab,
  children,
  actions,
}: ExperienceShellProps) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#020015] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(99,102,241,0.30),rgba(2,0,21,0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_55%,rgba(99,102,241,0.13),rgba(2,0,21,0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_10%_90%,rgba(236,72,153,0.10),rgba(2,0,21,0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(2,0,21,0)_35%,rgba(2,0,21,0.85)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 pb-12 pt-28 sm:pt-32">
          <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
            <Card className="overflow-hidden rounded-[32px] border border-white/15 bg-white/6 text-white backdrop-blur-xl">
              <CardContent className="p-0">
                <div className="relative min-h-[280px]">
                  {experience.coverImageUrl ? (
                    <img
                      src={experience.coverImageUrl}
                      alt={experience.title}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(99,102,241,0.25),rgba(236,72,153,0.18),rgba(2,0,21,0.4))]" />
                  )}

                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,0,21,0.1),rgba(2,0,21,0.82))]" />

                  <div className="relative flex h-full flex-col justify-end gap-5 p-8">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill label="Experience" />
                      {experience.canAccessPrivate && (
                        <StatusPill
                          label="Private content unlocked"
                          tone="success"
                        />
                      )}
                      {experience.canInteract && (
                        <StatusPill label="Posts + Q&A live" tone="info" />
                      )}
                    </div>

                    <div className="space-y-3">
                      <h1 className="text-4xl font-bold leading-tight tracking-[-0.03em] sm:text-5xl">
                        {experience.title}
                      </h1>
                      {experience.description && (
                        <p className="max-w-3xl text-base leading-7 text-white/75 sm:text-lg">
                          {experience.description}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[32px] border border-white/15 bg-white/6 text-white backdrop-blur-xl">
              <CardContent className="flex h-full flex-col justify-between gap-6 p-8">
                <div className="space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.28em] text-white/45">
                      Creator
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold">
                      {experience.creator.displayName}
                    </h2>
                  </div>

                  {experience.creator.bio && (
                    <p className="text-sm leading-6 text-white/70">
                      {experience.creator.bio}
                    </p>
                  )}

                  <div className="space-y-2 text-sm text-white/65">
                    <p>{experience.isLoggedIn ? "Logged in" : "Guest session"}</p>
                    <p>
                      {experience.hasUnlockedCampaign
                        ? "Campaign unlocked"
                        : "Campaign unlock required for private content"}
                    </p>
                  </div>
                </div>

                {actions}
              </CardContent>
            </Card>
          </section>

          <ExperienceTabsNav
            activeTab={activeTab}
            experienceSlug={experience.slug}
            className="mt-8"
          />

          <div className="mt-8">{children}</div>
        </main>

        <div className="pb-6 text-center text-white/55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}

export function ExperienceTabsNav({
  activeTab,
  experienceSlug,
  className,
}: {
  activeTab: ExperienceTab;
  experienceSlug: string;
  className?: string;
}) {
  const router = useRouter();

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) =>
        router.push(tabHrefMap[value as ExperienceTab](experienceSlug))
      }
      className={className}
    >
      <TabsList
        variant="line"
        className="rounded-full border border-white/10 bg-white/6 p-1"
      >
        <TabsTrigger
          value="hub"
          className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
        >
          Hub
        </TabsTrigger>
        <TabsTrigger
          value="learn"
          className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
        >
          Learn
        </TabsTrigger>
        <TabsTrigger
          value="posts"
          className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
        >
          Posts
        </TabsTrigger>
        <TabsTrigger
          value="qa"
          className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
        >
          Q&amp;A
        </TabsTrigger>
        <TabsTrigger
          value="shop"
          className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
        >
          Shop
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export function GatePanel({
  experience,
  title,
  description,
}: {
  experience: ExperienceShellData;
  title: string;
  description: string;
}) {
  const unlockHref = experience.campaigns[0]
    ? `/c/${experience.campaigns[0].id}`
    : `/x/${experience.slug}`;

  return (
    <Card className="rounded-[28px] border border-white/15 bg-white/6 text-white backdrop-blur-xl">
      <CardContent className="space-y-5 p-8">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold">{title}</h2>
          <p className="max-w-2xl text-sm leading-6 text-white/70">
            {description}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {!experience.isLoggedIn && (
            <Button
              asChild
              className="rounded-full border border-white bg-white text-black"
            >
              <Link href="/login">Log In</Link>
            </Button>
          )}

          <Button
            asChild
            variant="outline"
            className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            <Link href={unlockHref}>Unlock Campaign</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function LoadingView({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#020015] text-white">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-white border-t-transparent" />
        <p className="text-white/80">{label}</p>
      </div>
    </div>
  );
}

export function ErrorView({
  message,
  href = "/",
}: {
  message: string;
  href?: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#020015] px-6 text-white">
      <Card className="w-full max-w-lg rounded-[28px] border border-white/15 bg-white/6 text-white backdrop-blur-xl">
        <CardContent className="space-y-5 p-8 text-center">
          <p className="text-red-300">{message}</p>
          <Button
            asChild
            className="rounded-full border border-white bg-white text-black"
          >
            <Link href={href}>Go Back</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function PageCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "rounded-[28px] border border-white/15 bg-white/6 text-white backdrop-blur-xl",
        className,
      )}
    >
      <CardContent className="p-6 sm:p-8">{children}</CardContent>
    </Card>
  );
}

export function ProgressBar({
  value,
  label,
}: {
  value: number;
  label?: string;
}) {
  const normalizedValue = Math.max(0, Math.min(100, value));

  return (
    <div className="space-y-2">
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,#f8fafc,#60a5fa,#22c55e)] transition-all"
          style={{ width: `${normalizedValue}%` }}
        />
      </div>
      {label && <p className="text-xs text-white/55">{label}</p>}
    </div>
  );
}

function StatusPill({
  label,
  tone = "default",
}: {
  label: string;
  tone?: "default" | "success" | "info";
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-semibold",
        tone === "default" && "border-white/15 bg-white/8 text-white/80",
        tone === "success" &&
          "border-emerald-400/30 bg-emerald-500/15 text-emerald-200",
        tone === "info" &&
          "border-sky-400/30 bg-sky-500/15 text-sky-200",
      )}
    >
      {label}
    </span>
  );
}
