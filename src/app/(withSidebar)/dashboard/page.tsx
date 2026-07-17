"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import axios from "axios";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import Papa from "papaparse";

// --------------------
// Types (existing + new)
// --------------------
type Role = "ADMIN" | "BRAND_ADMIN" | "CREATOR" | "USER";

type CampaignStats = {
  campaignId: string;
  campaignName: string;
  totalQRCodes: number;
  redeemedCount: number;
};

type DashboardStats = {
  totalRedemptions: number;
  activeCampaigns: number;
  campaignStats: CampaignStats[];
};

type DashboardSummary = {
  role: Role;
  user: { name: string | null; email: string | null };
  cards: Record<string, string | number | null>;
  recentActivity?: Array<{ label: string; detail?: string; at?: string }>;
};

// --------------------
// Existing UI helpers (unchanged)
// --------------------
function GradientStatCard({
  colorVar,
  children,
  className = "",
}: {
  colorVar: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        "relative rounded-3xl p-[1.25px]",
        "bg-[linear-gradient(135deg,rgba(255,255,255,0.28)_0%,rgba(255,255,255,0.10)_28%,rgba(0,0,0,0.55)_100%)]",
        "shadow-[0_26px_80px_rgba(0,0,0,0.45)]",
        className,
      ].join(" ")}
    >
      <div
        className={[
          "relative overflow-hidden rounded-[22px]",
          "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]",
        ].join(" ")}
        style={{ backgroundColor: colorVar }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(255,255,255,0.42)_0%,rgba(255,255,255,0.18)_30%,rgba(255,255,255,0.00)_60%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_100%,rgba(0,0,0,0.74)_0%,rgba(0,0,0,0.40)_36%,rgba(0,0,0,0.00)_70%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.05)_0%,rgba(0,0,0,0.00)_42%,rgba(0,0,0,0.22)_100%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_80%_at_50%_20%,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.00)_60%)]" />

        <div className="relative z-10">{children}</div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  colorVar,
}: {
  title: string;
  value: number;
  colorVar: string;
}) {
  return (
    <GradientStatCard colorVar={colorVar}>
      <div className="p-6 text-white">
        <div className="text-[15px] font-semibold text-white/90">{title}</div>
        <div className="mt-4 text-5xl font-bold tracking-tight">{value}</div>
      </div>
    </GradientStatCard>
  );
}

function CampaignCard({
  c,
  colorVar = "var(--card-colour-3)",
}: {
  c: CampaignStats;
  colorVar?: string;
}) {
  return (
    <GradientStatCard colorVar={colorVar} className="min-h-35">
      <div className="p-6 text-white">
        <div className="text-[15px] font-semibold text-white/95">
          {c.campaignName}
        </div>

        <div className="mt-5 space-y-1 text-sm text-white/85">
          <div>
            <span className="text-white/70">Total QR Codes:</span>{" "}
            <span className="font-medium text-white/95">{c.totalQRCodes}</span>
          </div>
          <div>
            <span className="text-white/70">Redeemed:</span>{" "}
            <span className="font-medium text-white/95">{c.redeemedCount}</span>
          </div>
        </div>
      </div>
    </GradientStatCard>
  );
}

// --------------------
// NEW: small reusable card
// --------------------
function SimpleOverviewCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: React.ReactNode;
  hint?: string;
}) {
  const textValue = typeof value === "string" ? value : null;
  const isLongText = textValue ? textValue.length > 10 : false;
  const valueClassName = textValue
    ? `mt-3 ${isLongText ? "text-lg" : "text-xl"} font-semibold leading-snug text-white break-words`
    : "mt-3 text-3xl font-bold tracking-tight text-white";

  return (
    <Card className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_20px_70px_rgba(0,0,0,0.35)]">
      <CardContent className="p-6">
        <div className="text-sm font-semibold text-white/75">{title}</div>
        <div className={valueClassName}>{value}</div>
        {hint ? <div className="mt-2 text-xs text-white/55">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  // Existing ADMIN stats
  const [currentMonthStats, setCurrentMonthStats] =
    useState<DashboardStats | null>(null);
  const [allTimeStats, setAllTimeStats] = useState<DashboardStats | null>(null);

  // NEW: unified summary
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [activeBrandRequired, setActiveBrandRequired] = useState(false);

  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const role = session?.user?.role as Role | undefined;

  const fetchStats = useCallback(async () => {
    try {
      const currentMonthRes = await axios.get<{ data: DashboardStats }>(
        "/api/dashboard-stats?scope=current-month",
      );
      const allTimeRes = await axios.get<{ data: DashboardStats }>(
        "/api/dashboard-stats?scope=all",
      );

      setCurrentMonthStats(currentMonthRes.data.data);
      setAllTimeStats(allTimeRes.data.data);
    } catch (err) {
      console.error("Failed to load dashboard stats", err);
      setErrorMsg("Failed to load admin analytics cards.");
    }
  }, []);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await axios.get<{ data: DashboardSummary }>(
        "/api/me/dashboard-summary",
      );
      setSummary(res.data.data);
    } catch (err) {
      const responseData = axios.isAxiosError(err)
        ? (err.response?.data as { code?: string } | undefined)
        : undefined;
      if (
        axios.isAxiosError(err) &&
        err.response?.status === 409 &&
        responseData?.code === "ACTIVE_BRAND_REQUIRED"
      ) {
        setActiveBrandRequired(true);
        return;
      }
      console.error("Failed to load dashboard summary", err);
      setErrorMsg("Failed to load dashboard summary.");
    }
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    if (!session) {
      router.push("/login");
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setActiveBrandRequired(false);

    // What we load depends on role
    const jobs: Array<Promise<void>> = [];

    // Always load summary for unified cards (all roles)
    jobs.push(fetchSummary());

    // Keep the existing ADMIN analytics behavior.
    if (role === "ADMIN") {
      jobs.push(fetchStats());
    }

    Promise.allSettled(jobs).finally(() => setLoading(false));

    // Keep your refresh for ADMIN stats only
    if (role === "ADMIN") {
      const iv = setInterval(() => {
        fetchStats();
        fetchSummary();
      }, 45_000);
      return () => clearInterval(iv);
    }
  }, [status, session, router, role, fetchStats, fetchSummary]);

  const handleExport = () => {
    if (!allTimeStats || !currentMonthStats) return;

    const csvData: Array<Record<string, string | number>> = [];

    allTimeStats.campaignStats.forEach((c) => {
      csvData.push({
        Timeframe: "All Time",
        Campaign: c.campaignName,
        TotalQRCodes: c.totalQRCodes,
        Redeemed: c.redeemedCount,
      });
    });

    currentMonthStats.campaignStats.forEach((c) => {
      csvData.push({
        Timeframe: "Current Month",
        Campaign: c.campaignName,
        TotalQRCodes: c.totalQRCodes,
        Redeemed: c.redeemedCount,
      });
    });

    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "campaign_dashboard_report.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const summaryCards = useMemo(() => summary?.cards ?? {}, [summary]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-white/80">
        <p>Loading dashboard...</p>
      </div>
    );
  }

  if (!session || !role) {
    return (
      <div className="flex items-center justify-center min-h-screen text-white/80">
        <p>Unauthorized</p>
      </div>
    );
  }

  if (role === "BRAND_ADMIN" && activeBrandRequired) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 text-white">
        <Card className="w-full max-w-lg rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl">
          <CardContent className="space-y-5 p-8 text-center">
            <h1 className="text-2xl font-semibold">Select an active brand</h1>
            <p className="text-sm leading-6 text-white/65">
              Choose which brand you want to manage before loading brand dashboard data.
            </p>
            <Button
              type="button"
              onClick={() => router.push("/dashboard/brand/profile")}
              className="rounded-full bg-white text-black hover:bg-white/90"
            >
              Choose brand
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // --------------------
  // ADMIN: keep your existing cards, add unified cards below them
  // --------------------
  if (role === "ADMIN" && currentMonthStats && allTimeStats) {
    return (
      <div className="min-h-screen p-8 space-y-10 text-white">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold">Admin Dashboard</h1>
          <div>
            <Button
              onClick={async () => {
                setLoading(true);
                setErrorMsg(null);
                await Promise.allSettled([fetchStats(), fetchSummary()]);
                setLoading(false);
              }}
              disabled={loading}
              className="bg-[#3E93DE] text-white"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              className="ml-4 bg-[--card-colour-1] text-white"
              onClick={handleExport}
            >
              Export Reports
            </Button>
          </div>
        </div>

        {errorMsg ? (
          <div className="text-sm text-red-300">{errorMsg}</div>
        ) : null}

        {/* All-Time Section (UNCHANGED) */}
        <section>
          <h2 className="text-2xl font-semibold mb-4">All Time Stats</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <StatCard
              title="Total Redemptions"
              value={allTimeStats.totalRedemptions}
              colorVar="var(--card-colour-1)"
            />
            <StatCard
              title="Active Campaigns"
              value={allTimeStats.activeCampaigns}
              colorVar="var(--card-colour-4)"
            />
          </div>

          <div className="mt-8">
            <h3 className="text-xl font-semibold mb-3">Campaign Breakdown</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {allTimeStats.campaignStats.map((c) => (
                <CampaignCard
                  key={c.campaignId}
                  c={c}
                  colorVar="var(--card-colour-3)"
                />
              ))}
            </div>
          </div>
        </section>

        {/* Current Month Section (UNCHANGED) */}
        <section>
          <h2 className="text-2xl font-semibold mb-4">Current Month Stats</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <StatCard
              title="Total Redemptions"
              value={currentMonthStats.totalRedemptions}
              colorVar="var(--card-colour-2)"
            />
            <StatCard
              title="Active Campaigns"
              value={currentMonthStats.activeCampaigns}
              colorVar="var(--card-colour-4)"
            />
          </div>

          <div className="mt-8">
            <h3 className="text-xl font-semibold mb-3">
              Current Month Campaign Breakdown
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {currentMonthStats.campaignStats.map((c) => (
                <CampaignCard
                  key={`${c.campaignId}-month`}
                  c={c}
                  colorVar="var(--card-colour-3)"
                />
              ))}
            </div>
          </div>
        </section>

        {/* NEW: Unified role cards BELOW existing cards */}
        {summary ? (
          <section className="pt-2">
            <h2 className="text-2xl font-semibold mb-4">Overview</h2>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <SimpleOverviewCard
                title="Approvals Pending"
                value={summaryCards.approvalsPending ?? 0}
              />
              <SimpleOverviewCard
                title="Total Brands"
                value={summaryCards.totalBrands ?? 0}
              />
              <SimpleOverviewCard
                title="Total Campaigns"
                value={summaryCards.totalCampaigns ?? 0}
              />
              <SimpleOverviewCard
                title="Recent Scans"
                value={summaryCards.recentScans ?? 0}
              />
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  // --------------------
  // BRAND_ADMIN / CREATOR / USER unified pages
  // --------------------
  if (summary) {
    return (
      <div className="min-h-screen p-8 space-y-8 text-white">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold">Dashboard</h1>
          <Button
            onClick={async () => {
              setLoading(true);
              setErrorMsg(null);
              await Promise.allSettled([fetchSummary()]);
              setLoading(false);
            }}
            className="bg-[#3E93DE] text-white"
          >
            Refresh
          </Button>
        </div>

        {errorMsg ? (
          <div className="text-sm text-red-300">{errorMsg}</div>
        ) : null}

        {/* Role-based overview cards */}
        {summary.role === "BRAND_ADMIN" ? (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <SimpleOverviewCard
              title="Campaigns"
              value={summaryCards.campaignsCount ?? 0}
            />
            <SimpleOverviewCard
              title="QR Batches"
              value={summaryCards.qrBatchCount ?? 0}
            />
            <SimpleOverviewCard
              title="Product Sync"
              value={summaryCards.productSyncStatus ?? "—"}
              hint="Shopify connection + catalog status"
            />
            <SimpleOverviewCard
              title="Recent Scans"
              value={summaryCards.recentScans ?? 0}
            />
          </div>
        ) : null}

        {summary.role === "CREATOR" ? (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <SimpleOverviewCard
              title="Experiences"
              value={summaryCards.experiencesCount ?? 0}
            />
            <SimpleOverviewCard
              title="Drafts"
              value={summaryCards.draftsCount ?? 0}
            />
            <SimpleOverviewCard
              title="Unanswered Q&A"
              value={summaryCards.unansweredQACount ?? 0}
            />
            <SimpleOverviewCard title="Views" value={summaryCards.views ?? 0} />
          </div>
        ) : null}

        {summary.role === "USER" ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <SimpleOverviewCard
                title="Unlocked Campaigns"
                value={summaryCards.unlockedCampaignsCount ?? 0}
              />
              <SimpleOverviewCard
                title="Continue Watching"
                value={summaryCards.continueWatchingLessonsCount ?? 0}
              />
              <SimpleOverviewCard
                title="Recent Activity"
                value={summaryCards.recentActivityCount ?? 0}
              />
            </div>

            {/* Recent activity list */}
            <Card className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl">
              <CardContent className="p-6">
                <div className="text-sm font-semibold text-white/75">
                  Recent Activity
                </div>
                <div className="mt-4 space-y-3">
                  {(summary.recentActivity ?? []).length === 0 ? (
                    <div className="text-sm text-white/55">
                      No activity yet.
                    </div>
                  ) : (
                    (summary.recentActivity ?? []).map((a, idx) => (
                      <div
                        key={idx}
                        className="flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3"
                      >
                        <div>
                          <div className="text-sm font-medium text-white">
                            {a.label}
                          </div>
                          {a.detail ? (
                            <div className="text-xs text-white/60">
                              {a.detail}
                            </div>
                          ) : null}
                        </div>
                        {a.at ? (
                          <div className="text-xs text-white/55">{a.at}</div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen text-white/80">
      <p>Access Denied or Unknown Role</p>
    </div>
  );
}
