// src/app/(withSidebar)/dashboard/page.tsx
"use client";

import React, { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import Papa from "papaparse";

// Types
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

type UserData = {
  id: string;
  name: string | null;
  email: string;
  points: number;
  role: string;
};

function GradientStatCard({
  colorVar, // e.g. "var(--card-colour-1)"
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
        "relative rounded-[24px] p-[1.25px]",
        // Border gradient: bright TL -> darker BR (like ref)
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
        {/* top-left shine */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(255,255,255,0.42)_0%,rgba(255,255,255,0.18)_30%,rgba(255,255,255,0.00)_60%)]" />

        {/* bottom-right falloff (key) */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_100%,rgba(0,0,0,0.74)_0%,rgba(0,0,0,0.40)_36%,rgba(0,0,0,0.00)_70%)]" />

        {/* subtle diagonal depth */}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.05)_0%,rgba(0,0,0,0.00)_42%,rgba(0,0,0,0.22)_100%)]" />

        {/* tiny vignette to avoid flat look */}
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
    <GradientStatCard colorVar={colorVar} className="min-h-[140px]">
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

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [currentMonthStats, setCurrentMonthStats] =
    useState<DashboardStats | null>(null);
  const [allTimeStats, setAllTimeStats] = useState<DashboardStats | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const currentMonthRes = await axios.get<{ data: DashboardStats }>(
        "/api/dashboard-stats?scope=current-month"
      );
      const allTimeRes = await axios.get<{ data: DashboardStats }>(
        "/api/dashboard-stats?scope=all"
      );

      setCurrentMonthStats(currentMonthRes.data.data);
      setAllTimeStats(allTimeRes.data.data);
    } catch (err) {
      console.error("Failed to load dashboard stats", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchUserData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ data: UserData }>("/api/user/me");
      setUserData(res.data.data);
    } catch (err) {
      console.error("Failed to load user data", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    if (!session) {
      router.push("/login");
      return;
    }

    if (session.user.role === "ADMIN") {
      fetchStats();
      const iv = setInterval(fetchStats, 45_000);
      return () => clearInterval(iv);
    } else if (session.user.role === "EXTERNAL") {
      fetchUserData();
    } else {
      setLoading(false);
    }
  }, [status, session, router, fetchStats, fetchUserData]);

  const handleExport = () => {
    if (!allTimeStats || !currentMonthStats) return;

    const csvData: any[] = [];

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Loading dashboard...</p>
      </div>
    );
  }

  // EXTERNAL (unchanged from your latest)
  if (session?.user.role === "EXTERNAL" && userData) {
    return (
      <div className="relative min-h-screen overflow-hidden">
        <video
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-65"
          src="/assets/dashboard/purple-lines.mp4"
          autoPlay
          loop
          muted
          playsInline
        />
        <div className="pointer-events-none absolute inset-0 bg-black/35" />

        <div className="relative z-10 flex min-h-screen items-center justify-center px-6">
          <div
            className={[
              "relative",
              "w-[min(860px,92vw)]",
              "h-[min(420px,60vh)]",
              "rounded-[28px]",
              "backdrop-blur-3xl",
              "border border-white/15",
              "shadow-[0_30px_90px_rgba(0,0,0,0.55)]",
              "overflow-hidden",
              "grid place-items-center",
            ].join(" ")}
          >
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom_right,rgba(190,220,255,0.14)_0%,rgba(190,220,255,0.06)_35%,rgba(190,220,255,0.00)_100%)]" />
            <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]" />

            <div className="relative text-center">
              <div className="text-[84px] sm:text-[220px] font-semibold tracking-[-0.04em] text-white drop-shadow-[0_10px_60px_rgba(168,85,247,0.35)]">
                {userData.points}
              </div>
              <div className="mt-2 text-[14px] sm:text-[16px] font-semibold tracking-[0.22em] text-white/70">
                YOUR SQRATCH POINTS
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ADMIN (all cards upgraded)
  if (session?.user.role === "ADMIN" && currentMonthStats && allTimeStats) {
    return (
      <div className="min-h-screen p-8 space-y-10">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold">Admin Dashboard</h1>
          <div>
            <Button
              onClick={fetchStats}
              disabled={loading}
              className="bg-[#3E93DE] text-white"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              className="ml-4 bg-[var(--card-colour-1)] text-white"
              onClick={handleExport}
            >
              Export Reports
            </Button>
          </div>
        </div>

        {/* All-Time Section */}
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

        {/* Current Month Section */}
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
            <h3 className="text-xl font-semibold mb-3">Campaign Breakdown</h3>
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
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <p>Access Denied or Unknown Role</p>
    </div>
  );
}
