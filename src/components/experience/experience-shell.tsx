"use client";

import Link from "next/link";
import Image from "next/image";
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
import {
  experienceTabHref,
  type ExperienceTab,
} from "@/components/experience/experience-tabs";
import type { ExperienceShellData } from "@/components/experience/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { appendCampaignEntryToken } from "@/lib/experience-entry-url";
import { cn } from "@/lib/utils";
import { normalizeInternalRedirectPath } from "@/lib/safe-redirect";

type ExperienceShellProps = {
  experience: ExperienceShellData;
  activeTab: ExperienceTab;
  children: ReactNode;
  actions?: ReactNode;
  hero?: ReactNode;
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
    <div className="relative min-h-screen overflow-hidden bg-page text-ink">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(var(--glow-primary-rgb),0.30),rgba(var(--scene-rgb),0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_55%,rgba(var(--glow-primary-rgb),0.13),rgba(var(--scene-rgb),0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_10%_90%,rgba(var(--glow-secondary-rgb),0.10),rgba(var(--scene-rgb),0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(var(--scene-rgb),0)_35%,rgba(var(--scene-rgb),0.85)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-section" />
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
              <Card className="overflow-hidden rounded-[32px] border border-edge/15 bg-glass-6 py-0 text-ink backdrop-blur-xl">
                <CardContent className="h-full p-0">
                  <div className="theme-media text-ink relative flex h-full min-h-[280px] flex-col justify-end overflow-hidden">
                    {experience.coverImageUrl ? (
                      <Image
                        src={experience.coverImageUrl}
                        alt={experience.title}
                        fill
                        unoptimized
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(var(--glow-primary-rgb),0.25),rgba(var(--glow-secondary-rgb),0.18),rgba(var(--scene-rgb),0.4))]" />
                    )}

                    <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(var(--scene-rgb),0.1),rgba(var(--scene-rgb),0.82))]" />

                    <div className="relative flex flex-col justify-end gap-5 p-8">
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
                          <p className="max-w-3xl text-base leading-7 text-copy-75 sm:text-lg">
                            {experience.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[32px] border border-edge/15 bg-glass-6 text-ink backdrop-blur-xl">
                <CardContent className="flex h-full flex-col justify-between gap-6 p-8">
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.28em] text-copy-45">
                        Creator
                      </p>
                      <h2 className="mt-2 text-2xl font-semibold">
                        {experience.creator.displayName}
                      </h2>
                    </div>

                    {experience.creator.bio && (
                      <p className="text-sm leading-6 text-copy-70">
                        {experience.creator.bio}
                      </p>
                    )}

                    <div className="space-y-2 text-sm text-copy-65">
                      <p>
                        {experience.isLoggedIn ? "Logged in" : "Guest session"}
                      </p>
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

        <div className="pb-36 text-center text-copy-55 sm:pb-36 lg:pb-40">
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-[linear-gradient(180deg,rgba(var(--scene-rgb),0),rgba(var(--scene-rgb),0.96))]" />
      <div className="relative mx-auto max-w-xl rounded-[28px] border border-edge/12 bg-[linear-gradient(180deg,rgba(var(--dock-rgb),0.96),rgba(var(--dock-rgb),0.98))] p-2 shadow-[0_-18px_70px_rgba(var(--scene-rgb),0.55)] backdrop-blur-2xl sm:max-w-2xl lg:max-w-3xl">
        <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
          {experienceTabs.map(({ key: tabKey, label, icon: Icon }) => {
            const isActive = activeTab === tabKey;

            return (
              <Link
                key={tabKey}
                href={experienceTabHref(tabKey, experienceSlug)}
                className={cn(
                  "flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-[20px] px-2 text-center text-[11px] font-semibold tracking-[0.04em] transition sm:min-h-[82px] sm:gap-2 sm:text-[12px]",
                  isActive
                    ? "bg-glass-12 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                    : "text-copy-52 hover:bg-glass-6 hover:text-copy-78",
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon
                  className={cn(
                    "box-content h-[18px] w-[18px] rounded-[8px] p-1 sm:h-[20px] sm:w-[20px]",
                    isActive
                      ? "text-[#c73484]"
                      : "border border-transparent text-copy-70",
                  )}
                  strokeWidth={2.1}
                />
                <span className={cn(isActive ? "text-[#c73484]" : "")}>
                  {label}
                </span>
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
  returnTo,
}: {
  experience: ExperienceShellData;
  title: string;
  description: string;
  returnTo?: string;
}) {
  const hubHref = `/x/${experience.slug}`;
  const nextHref = normalizeInternalRedirectPath(returnTo, hubHref);
  // Carries the visitor's validated campaign context through login/signup/
  // verification; absent for a direct visitor, whose return stays DIRECT.
  const returnHref = appendCampaignEntryToken(
    nextHref,
    experience.campaignReturnToken,
  );
  const loginHref = `/login?next=${encodeURIComponent(returnHref)}`;
  const signupHref = `/signup?next=${encodeURIComponent(returnHref)}`;
  const canOfferSignup =
    !experience.isLoggedIn && !experience.hasRedeemedQrWarning;
  // Co-sponsored Experiences must never send a visitor to an arbitrary
  // campaign landing page. The server provides a trusted resolution when one
  // exists; a single campaign is the only safe compatibility fallback.
  const campaignId = experience.resolvedCampaignId ||
    (experience.campaigns.length === 1 ? experience.campaigns[0]?.id : null);
  const campaignHref = campaignId ? `/c/${campaignId}` : `/x/${experience.slug}`;

  return (
    <Card className="rounded-[28px] border border-edge/15 bg-glass-6 text-ink backdrop-blur-xl">
      <CardContent className="space-y-5 p-8">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold">{title}</h2>
          <p className="max-w-2xl text-sm leading-6 text-copy-70">
            {description}
          </p>
        </div>

        {experience.hasRedeemedQrWarning && (
          <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-700 dark:text-amber-100">
            This QR code is already redeemed. You can log in and browse public
            content, but you will not earn points or unlock private access from
            this QR code.
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {!experience.isLoggedIn && (
            <Button
              asChild
              className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
            >
              <Link href={loginHref}>Log In</Link>
            </Button>
          )}

          {canOfferSignup ? (
            <Button
              asChild
              variant="outline"
              className="rounded-full border-edge/20 bg-transparent text-ink hover:bg-glass-10"
            >
              <Link href={signupHref}>Sign Up to Unlock</Link>
            </Button>
          ) : (
            <Button
              asChild
              variant="outline"
              className="rounded-full border-edge/20 bg-transparent text-ink hover:bg-glass-10"
            >
              <Link href={campaignHref}>
                {experience.hasRedeemedQrWarning
                  ? "View Campaign"
                  : campaignId
                    ? "Unlock Campaign"
                    : "View Experience"}
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
    <div className="flex min-h-screen items-center justify-center bg-page text-ink">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-edge border-t-transparent" />
        <p className="text-copy-80">{label}</p>
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
    <div className="flex min-h-screen items-center justify-center bg-page px-6 text-ink">
      <Card className="w-full max-w-lg rounded-[28px] border border-edge/15 bg-glass-6 text-ink backdrop-blur-xl">
        <CardContent className="space-y-5 p-8 text-center">
          <p className="text-red-700 dark:text-red-300">{message}</p>
          <Button
            asChild
            className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
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
      data-page-card="true"
      className={cn(
        "rounded-[28px] border border-edge/15 bg-glass-6 text-ink backdrop-blur-xl",
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
      <div className="h-2 overflow-hidden rounded-full bg-glass-10">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,#f8fafc,#60a5fa,#22c55e)] transition-all"
          style={{ width: `${normalizedValue}%` }}
        />
      </div>
      {label && <p className="text-xs text-copy-55">{label}</p>}
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
        tone === "default" && "border-edge/15 bg-glass-8 text-copy-80",
        tone === "success" &&
          "border-emerald-400/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200",
        tone === "info" && "border-sky-400/30 bg-sky-500/15 text-sky-700 dark:text-sky-200",
      )}
    >
      {label}
    </span>
  );
}
