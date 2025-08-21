"use client";

import React, { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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

export default function AdminDashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [currentMonthStats, setCurrentMonthStats] =
    useState<DashboardStats | null>(null);
  const [allTimeStats, setAllTimeStats] = useState<DashboardStats | null>(null);
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

  useEffect(() => {
    if (status === "loading") return;
    if (!session || session.user.role !== "ADMIN") {
      router.push("/dashboard");
    } else {
      fetchStats();
      const iv = setInterval(fetchStats, 45_000);
      return () => clearInterval(iv);
    }
  }, [status, session, router, fetchStats]);

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

  if (loading || !currentMonthStats || !allTimeStats) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-8 space-y-10">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Admin Dashboard</h1>
        <Button
          onClick={fetchStats}
          disabled={loading}
          className="bg-[#3b639a]"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* All-Time Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-4">
          \ud83d\udcca All Time Stats
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-6">
          <Card
            style={{ backgroundColor: "var(--card-colour-1)" }}
            className="text-white shadow-md"
          >
            <CardHeader>
              <CardTitle>Total Redemptions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-4xl font-bold">
                {allTimeStats.totalRedemptions}
              </p>
            </CardContent>
          </Card>

          <Card
            style={{ backgroundColor: "var(--card-colour-4)" }}
            className="text-white shadow-md"
          >
            <CardHeader>
              <CardTitle>Active Campaigns</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-4xl font-bold">
                {allTimeStats.activeCampaigns}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="mt-6">
          <h3 className="text-xl font-semibold mb-2">Campaign Breakdown</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 gap-4">
            {allTimeStats.campaignStats.map((c) => (
              <Card
                key={c.campaignId}
                style={{ backgroundColor: "var(--card-colour-3)" }}
                className="text-white shadow-md"
              >
                <CardHeader>
                  <CardTitle>{c.campaignName}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p>Total QR Codes: {c.totalQRCodes}</p>
                  <p>Redeemed: {c.redeemedCount}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Current Month Section */}
      <section>
        <h2 className="text-2xl font-semibold mb-4">📅 Current Month Stats</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-6">
          <Card
            style={{ backgroundColor: "var(--card-colour-2)" }}
            className="text-white shadow-md"
          >
            <CardHeader>
              <CardTitle>Total Redemptions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-4xl font-bold">
                {currentMonthStats.totalRedemptions}
              </p>
            </CardContent>
          </Card>

          <Card
            style={{ backgroundColor: "var(--card-colour-4)" }}
            className="text-white shadow-md"
          >
            <CardHeader>
              <CardTitle>Active Campaigns</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-4xl font-bold">
                {currentMonthStats.activeCampaigns}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="mt-6">
          <h3 className="text-xl font-semibold mb-2">Campaign Breakdown</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 gap-4">
            {currentMonthStats.campaignStats.map((c) => (
              <Card
                key={c.campaignId}
                style={{ backgroundColor: "var(--card-colour-3)" }}
                className="text-white shadow-md"
              >
                <CardHeader>
                  <CardTitle>{c.campaignName}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p>Total QR Codes: {c.totalQRCodes}</p>
                  <p>Redeemed: {c.redeemedCount}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <div className="pt-10">
        <Button className="bg-green-600 text-white" onClick={handleExport}>
          Export Reports
        </Button>
      </div>
    </div>
  );
}
