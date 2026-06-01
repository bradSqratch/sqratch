import { Coins, Hammer, Info, QrCode } from "lucide-react";
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
import { getUserPointsOverview } from "@/lib/points";

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
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

  const qrTransactions = overview.transactions.filter(
    (transaction) => transaction.reason === "QR_SCAN",
  );

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
              Your current SQRATCH points from redeemed QR codes. Each eligible
              QR code adds one point once.
            </p>
          </div>

          <div className="hidden items-center gap-3 rounded-3xl border border-white/10 bg-white/5 px-5 py-4 text-white/80 md:flex">
            <Coins className="h-5 w-5 text-amber-300" />
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/45">
                Current Balance
              </p>
              <p className="text-2xl font-semibold text-white">
                {overview.totals.currentPoints}
              </p>
            </div>
          </div>
        </div>

        <Card className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
          <CardContent className="flex flex-col gap-4 p-8 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-white/45">
                Current Balance
              </p>
              <h2 className="mt-3 text-6xl font-semibold tracking-tight text-white">
                {overview.totals.currentPoints}
              </h2>
              <p className="mt-3 text-sm text-white/55">
                {qrTransactions.length} redeemed QR
                {qrTransactions.length === 1 ? "" : "s"} recorded
              </p>
            </div>

            <div className="flex w-full flex-col gap-3 md:w-auto md:items-end">
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-5 py-4 text-white/80">
                <QrCode className="h-5 w-5 text-amber-300" />
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-white/45">
                    Rule
                  </p>
                  <p className="text-sm text-white/75">
                    1 point per redeemed QR code
                  </p>
                </div>
              </div>

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
                    able to mint.
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </CardContent>
        </Card>

        <ShopifyRewardsClient currentPoints={overview.totals.currentPoints} />

        <Card className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
          <CardContent className="p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">Reward History</h2>
                <p className="mt-1 text-sm text-white/55">
                  Most recent points activity for your account.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {qrTransactions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-5 py-8 text-sm text-white/55">
                  No points earned yet. Scan an eligible QR code and log in to
                  start earning SQRATCH points.
                </div>
              ) : (
                qrTransactions.map((transaction) => {
                  return (
                    <div
                      key={transaction.id}
                      className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-black/20 px-5 py-4 md:flex-row md:items-center md:justify-between"
                    >
                      <div className="flex items-start gap-4">
                        <div className="rounded-2xl border border-white/10 bg-white/8 p-3">
                          <QrCode className="h-5 w-5 text-white/80" />
                        </div>

                        <div>
                          <p className="text-sm font-semibold text-white">
                            QR scan reward
                          </p>
                          {transaction.campaign ? (
                            <p className="mt-1 text-sm text-white/65">
                              {transaction.campaign.name}
                              {transaction.campaign.brand
                                ? ` by ${transaction.campaign.brand.name}`
                                : ""}
                            </p>
                          ) : null}
                          {transaction.qrCodeData ? (
                            <p className="mt-1 text-xs text-white/45">
                              QR: {transaction.qrCodeData}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-4 md:flex-col md:items-end">
                        <p className="text-xl font-semibold text-emerald-300">
                          +{transaction.points}
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
