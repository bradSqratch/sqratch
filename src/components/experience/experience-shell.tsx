"use client";

import Link from "next/link";
import {
  BookOpen,
  HelpCircle,
  ShoppingBag,
  Sparkles,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { ReactNode } from "react";
import CommonNavbar from "@/components/commonNavbar";
import type { ExperienceShellData } from "@/components/experience/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ExperienceTab = "hub" | "learn" | "posts" | "qa" | "shop";

type ExperienceShellProps = {
  experience: ExperienceShellData;
  activeTab: ExperienceTab;
  children: ReactNode;
  actions?: ReactNode;
  hero?: ReactNode;
};

const tabHrefMap: Record<ExperienceTab, (slug: string) => string> = {
  hub: (slug) => `/x/${slug}`,
  learn: (slug) => `/x/${slug}/learn`,
  posts: (slug) => `/x/${slug}/posts`,
  qa: (slug) => `/x/${slug}/qa`,
  shop: (slug) => `/x/${slug}/shop`,
};

const experienceTabs: Array<{
  key: ExperienceTab;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "hub", label: "WHY", icon: Sparkles },
  { key: "learn", label: "Learn", icon: BookOpen },
  { key: "posts", label: "Posts", icon: SquarePen },
  { key: "qa", label: "Q&A", icon: HelpCircle },
  { key: "shop", label: "Shop", icon: ShoppingBag },
];

export function ExperienceShell({
  experience,
  activeTab,
  children,
  actions,
  hero,
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

        <main
          className={cn(
            "mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 pb-40 sm:pb-40 lg:pb-44",
            hero ? "pt-[44px] sm:pt-[52px]" : "pt-28 sm:pt-32",
          )}
        >
          {hero ? (
            <section>{hero}</section>
          ) : (
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
          )}

          <div className="mt-8">{children}</div>
        </main>

        <div className="pb-36 text-center text-white/55 sm:pb-36 lg:pb-40">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>

        <StickyExperienceTabsNav
          activeTab={activeTab}
          experienceSlug={experience.slug}
        />
      </div>
    </div>
  );
}

function StickyExperienceTabsNav({
  activeTab,
  experienceSlug,
}: {
  activeTab: ExperienceTab;
  experienceSlug: string;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-[linear-gradient(180deg,rgba(2,0,21,0),rgba(2,0,21,0.96))]" />
      <div className="relative mx-auto max-w-xl rounded-[28px] border border-white/12 bg-[linear-gradient(180deg,rgba(14,16,36,0.96),rgba(8,10,24,0.98))] p-2 shadow-[0_-18px_70px_rgba(2,0,21,0.55)] backdrop-blur-2xl sm:max-w-2xl lg:max-w-3xl">
        <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
          {experienceTabs.map(({ key: tabKey, label, icon: Icon }) => {
            const isActive = activeTab === tabKey;

            return (
              <Link
                key={tabKey}
                href={tabHrefMap[tabKey](experienceSlug)}
                className={cn(
                  "flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-[20px] px-2 text-center text-[11px] font-semibold tracking-[0.04em] transition sm:min-h-[82px] sm:gap-2 sm:text-[12px]",
                  isActive
                    ? "bg-white/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                    : "text-white/52 hover:bg-white/6 hover:text-white/78",
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon
                  className={cn(
                    "h-[18px] w-[18px] sm:h-[20px] sm:w-[20px]",
                    isActive ? "text-white" : "text-white/70",
                  )}
                  strokeWidth={2.1}
                />
                <span>{label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
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
  const nextHref = `/x/${experience.slug}`;
  const loginHref = `/login?next=${encodeURIComponent(nextHref)}`;
  const signupHref = `/signup?next=${encodeURIComponent(nextHref)}`;
  const campaignHref = experience.campaigns[0]
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

        {experience.hasRedeemedQrWarning && (
          <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100">
            This QR code is already redeemed. You can log in and browse public
            content, but private access requires a different QR code.
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {!experience.isLoggedIn && (
            <Button
              asChild
              className="rounded-full border border-white bg-white text-black"
            >
              <Link href={loginHref}>Log In</Link>
            </Button>
          )}

          {!experience.isLoggedIn ? (
            <Button
              asChild
              variant="outline"
              className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              <Link href={signupHref}>Sign Up to Unlock</Link>
            </Button>
          ) : (
            <Button
              asChild
              variant="outline"
              className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              <Link href={campaignHref}>
                {experience.hasRedeemedQrWarning
                  ? "View Campaign"
                  : "Unlock Campaign"}
              </Link>
            </Button>
          )}
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
