import {
  Award,
  BookOpen,
  Coins,
  Gift,
  GraduationCap,
  Hammer,
  Info,
  QrCode,
  RotateCcw,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShopifyRewardsClient } from "@/components/rewards/shopify-rewards-client";
import {
  formatRewardMoney,
  formatRewardPercentage,
} from "@/lib/reward-formatting";
import { getUserPointsOverview } from "@/lib/points";

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

type OverviewTransaction = NonNullable<
  Awaited<ReturnType<typeof getUserPointsOverview>>
>["transactions"][number];

/** Human-readable label + icon for a ledger row, keyed by sourceType then reason. */
function describeTransaction(transaction: OverviewTransaction): {
  label: string;
  Icon: LucideIcon;
} {
  const key = transaction.sourceType ?? transaction.reason;
  switch (key) {
    case "QR_SCAN":
      return { label: "QR scan reward", Icon: QrCode };
    case "LESSON_COMPLETION":
      return { label: "Lesson completed", Icon: GraduationCap };
    case "COURSE_COMPLETION":
      return { label: "Course completed", Icon: BookOpen };
    case "VIDEO_WATCH":
      return { label: "Video watched", Icon: Sparkles };
    case "BONUS":
      return { label: "Bonus points", Icon: Gift };
    case "REFERRAL":
      return { label: "Referral reward", Icon: Gift };
    case "SHOPIFY_REWARD_REDEMPTION":
      return { label: "Reward redeemed", Icon: ShoppingBag };
    case "SHOPIFY_REWARD_REFUND":
      return { label: "Reward refunded", Icon: RotateCcw };
    default:
      return { label: "Points activity", Icon: Coins };
  }
}

const REDEMPTION_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  POINTS_DEBITED: "Processing",
  ISSUED: "Active",
  USED: "Used",
  EXPIRED: "Expired",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
};

function formatRewardDiscount(reward: NonNullable<OverviewTransaction["reward"]>) {
  if (reward.discountType === "PERCENTAGE") {
    const text = formatRewardPercentage(reward.discountPercentageBasisPoints);
    return text ? `${text} off` : null;
  }
  const text = formatRewardMoney(reward.discountAmountCents, reward.currencyCode);
  return text ? `${text} off` : null;
}

type DetailLine = { text: string; emphasis?: boolean };

/**
 * Ordered, hierarchical secondary lines for an activity card. Only fields the
 * server already resolved deterministically are ever present — nothing here
 * infers or guesses a missing campaign/QR association.
 */
function getActivityDetailLines(transaction: OverviewTransaction): DetailLine[] {
  const lines: DetailLine[] = [];
  const key = transaction.sourceType ?? transaction.reason;

  if (transaction.lesson) {
    lines.push({ text: transaction.lesson.title, emphasis: true });
    lines.push({ text: `Course: ${transaction.lesson.course.title}` });
    lines.push({ text: `Experience: ${transaction.lesson.experience.title}` });
  } else if (transaction.course) {
    lines.push({ text: transaction.course.title, emphasis: true });
    lines.push({ text: `Experience: ${transaction.course.experience.title}` });
  } else if (transaction.reward) {
    if (transaction.reward.offer) {
      lines.push({ text: transaction.reward.offer.title, emphasis: true });
    }
    if (transaction.reward.brand) {
      lines.push({ text: transaction.reward.brand.name });
    }
    const discountText = formatRewardDiscount(transaction.reward);
    if (discountText) {
      lines.push({ text: discountText });
    }
    const statusText = REDEMPTION_STATUS_LABELS[transaction.reward.status];
    if (statusText) {
      lines.push({ text: `Status: ${statusText}` });
    }
  } else if (key === "QR_SCAN" && transaction.campaign) {
    lines.push({
      text: transaction.campaign.brand
        ? `${transaction.campaign.name} by ${transaction.campaign.brand.name}`
        : transaction.campaign.name,
      emphasis: true,
    });
  }

  // Campaign context for lesson/course/reward events — QR_SCAN already
  // folds its campaign into the line above.
  if (transaction.campaign && key !== "QR_SCAN") {
    lines.push({ text: `Campaign: ${transaction.campaign.name}` });
  }

  // QR identifiers are only ever populated for QR_SCAN rows (a real,
  // deterministic qrCodeId foreign key) — never inferred for lesson/course
  // completions or redemptions.
  if (transaction.qrCodeData && key === "QR_SCAN") {
    lines.push({ text: `QR: ${transaction.qrCodeData}` });
  }

  return lines;
}

export default async function DashboardPointsPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    redirect("/login");
  }

  const overview = await getUserPointsOverview(session.user.id);

  if (!overview) {
    redirect("/dashboard");
  }

  const { totals, transactions } = overview;

  const summaryCards: Array<{
    label: string;
    value: number;
    hint: string;
    Icon: LucideIcon;
    accent: string;
  }> = [
    {
      label: "Current Balance",
      value: totals.spendablePoints,
      hint: "Spendable on rewards",
      Icon: Coins,
      accent: "text-amber-300",
    },
    {
      label: "Lifetime Earned",
      value: totals.lifetimeEarnedPoints,
      hint: "Total participation — never reduced by spending",
      Icon: Award,
      accent: "text-emerald-300",
    },
    {
      label: "Lifetime Spent",
      value: totals.lifetimeSpentPoints,
      hint: "Redeemed on rewards",
      Icon: ShoppingBag,
      accent: "text-sky-300",
    },
    {
      label: "Lifetime Refunded",
      value: totals.lifetimeRefundedPoints,
      hint: "Returned to your balance",
      Icon: RotateCcw,
      accent: "text-white/70",
    },
  ];

  return (
    <div className="min-h-screen p-8 text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm uppercase tracking-[0.24em] text-white/45">
              SQRATCH
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">
              Points
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/65">
              Your <span className="text-white/85">current balance</span> can be
              spent on rewards. Your{" "}
              <span className="text-white/85">lifetime earned</span> points track
              your total participation and are never reduced when you spend.
            </p>
          </div>

          <div className="hidden items-center gap-3 rounded-3xl border border-white/10 bg-white/5 px-5 py-4 text-white/80 md:flex">
            <Coins className="h-5 w-5 text-amber-300" />
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/45">
                Current Balance
              </p>
              <p className="text-2xl font-semibold text-white">
                {totals.spendablePoints}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {summaryCards.map((card) => (
            <Card
              key={card.label}
              className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl"
            >
              <CardContent className="flex flex-col gap-3 p-6">
                <div className="flex items-center gap-2 text-white/60">
                  <card.Icon className={`h-4 w-4 ${card.accent}`} />
                  <p className="text-xs uppercase tracking-[0.2em]">
                    {card.label}
                  </p>
                </div>
                <p className="text-4xl font-semibold tracking-tight text-white">
                  {card.value}
                </p>
                <p className="text-xs text-white/45">{card.hint}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
          <CardContent className="flex flex-col gap-4 p-8 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-white/45">
                Lifetime Earned
              </p>
              <h2 className="mt-3 text-6xl font-semibold tracking-tight text-white">
                {totals.lifetimeEarnedPoints}
              </h2>
              <p className="mt-3 text-sm text-white/55">
                Future SQRATCH minting is based on your lifetime earned points —
                spending on rewards never lowers it.
              </p>
            </div>

            <div className="flex w-full flex-col gap-3 md:w-auto md:items-end">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled
                  variant="outline"
                  className="rounded-full border-amber-300/20 bg-amber-300/10 px-4 text-amber-100 hover:bg-amber-300/15"
                >
                  <Hammer className="h-4 w-4" />
                  Mining coming soon
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/20 text-white/55 transition-colors hover:text-white/80"
                      aria-label="Mining info"
                    >
                      <Info className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={8}
                    className="max-w-xs border border-white/10 bg-[#111827] text-white"
                  >
                    Only people who go through the SQRATCH experience will be
                    able to mint, based on lifetime earned points.
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </CardContent>
        </Card>

        <ShopifyRewardsClient currentPoints={totals.spendablePoints} />

        <Card className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
          <CardContent className="p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">Points Activity</h2>
                <p className="mt-1 text-sm text-white/55">
                  Recent activity across QR scans, lessons, courses, rewards,
                  refunds and bonuses.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {transactions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-5 py-8 text-sm text-white/55">
                  No points activity yet. Scan an eligible QR code and log in to
                  start earning SQRATCH points.
                </div>
              ) : (
                transactions.map((transaction) => {
                  const { label, Icon } = describeTransaction(transaction);
                  const isPositive = transaction.points >= 0;
                  const detailLines = getActivityDetailLines(transaction);
                  return (
                    <div
                      key={transaction.id}
                      className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-black/20 px-5 py-4 md:flex-row md:items-center md:justify-between"
                    >
                      <div className="flex min-w-0 items-start gap-4">
                        <div className="shrink-0 rounded-2xl border border-white/10 bg-white/8 p-3">
                          <Icon className="h-5 w-5 text-white/80" aria-hidden="true" />
                        </div>

                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white">
                            {label}
                          </p>
                          {detailLines.length > 0 ? (
                            <div className="mt-1 space-y-0.5">
                              {detailLines.map((line, index) => (
                                <p
                                  key={index}
                                  className={
                                    line.emphasis
                                      ? "break-words text-sm text-white/65"
                                      : "break-words text-xs text-white/45"
                                  }
                                >
                                  {line.text}
                                </p>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center justify-between gap-4 md:flex-col md:items-end">
                        <p
                          className={`text-xl font-semibold ${
                            isPositive ? "text-emerald-300" : "text-red-300"
                          }`}
                        >
                          {isPositive ? "+" : "−"}
                          {Math.abs(transaction.points)}
                        </p>
                        <p className="text-xs text-white/45">
                          {formatDate(transaction.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
