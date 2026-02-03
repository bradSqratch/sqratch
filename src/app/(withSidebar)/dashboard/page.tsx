// src/app/(withSidebar)/dashboard/page.tsx
"use client";

import React, { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
        "relative rounded-3xl p-[1.25px]",
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

  // EXTERNAL (match Signup/Redeem background + card styling)
  if (session?.user.role === "EXTERNAL" && userData) {
    return (
      <div className="relative min-h-screen bg-[#020015] text-white overflow-hidden">
        {/* Background (same style as redeemQR) */}
        <div className="pointer-events-none absolute inset-0">
          {/* Primary glow behind hero */}
          <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(99,102,241,0.30),rgba(2,0,21,0)_70%)]" />

          {/* Secondary glow behind the card */}
          <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_55%,rgba(99,102,241,0.13),rgba(2,0,21,0)_65%)]" />

          {/* Accent (pink) */}
          <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_10%_90%,rgba(236,72,153,0.10),rgba(2,0,21,0)_65%)]" />

          {/* Vignette */}
          <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(2,0,21,0)_35%,rgba(2,0,21,0.85)_100%)]" />

          {/* Bottom fade */}
          <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
        </div>

        {/* Content layer */}
        <div className="relative z-10 flex min-h-screen flex-col">
          <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pt-28 pb-12 sm:pt-32">
            <Card
              className={[
                // Same “Signup card” styling
                "relative w-full max-w-215",
                "rounded-[28px] border border-white/15 bg-white/6 backdrop-blur-xl",
                "shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden",
                // Keep your old sizing feel
                "min-h-80 sm:min-h-105",
                "grid place-items-center",
              ].join(" ")}
            >
              <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />

              <CardContent className="relative z-10 text-center py-10">
                <div className="text-[84px] sm:text-[220px] font-semibold tracking-[-0.04em] text-white drop-shadow-[0_10px_60px_rgba(168,85,247,0.25)]">
                  {userData.points}
                </div>

                <div className="mt-2 text-[14px] sm:text-[16px] font-semibold tracking-[0.22em] text-white/70">
                  YOUR SQRATCH POINTS
                </div>
              </CardContent>
            </Card>
          </main>
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
              className="ml-4 bg-[--card-colour-1] text-white"
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
