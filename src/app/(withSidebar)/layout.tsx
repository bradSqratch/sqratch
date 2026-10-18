import type { Metadata } from "next";
import React, { Suspense } from "react";
import Link from "next/link"; // Import Link for navigation.
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { DashboardTopbarUser } from "@/components/dashboard-topbar-user";
import { SqratchLogo } from "@/components/brand/sqratch-logo";
import { hasPendingApproval } from "@/lib/approval-gating";
import { ThemeSelect } from "@/components/theme-select";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  if (
    session?.user?.id &&
    session.user.role !== "ADMIN" &&
    (await hasPendingApproval(session.user.id))
  ) {
    redirect("/approval-pending");
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        {/* SidebarInset to contain breadcrumbs and main content */}
        <SidebarInset className="flex min-w-0 flex-col w-auto">
          {/* Header with Sticky Styling */}
          <header
            className="
              sticky top-0 z-30
              flex h-16 shrink-0 items-center justify-between
              bg-topbar dark:bg-[linear-gradient(180deg,rgba(var(--header-rgb),0.85)_0%,rgba(var(--header-rgb),0.55)_100%)]
              backdrop-blur-xl
              border-b border-edge/10
              shadow-[0_8px_28px_rgba(72,57,34,0.06)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.35)]
              transition-[width,height]
              ease-linear
              group-has-data-[collapsible=icon]/sidebar-wrapper:h-12
            "
          >
            {/* Added styling classes from new code. */}
            <div className="flex min-w-0 items-center gap-2 px-3 sm:gap-3 sm:px-6">
              {" "}
              {/* Added padding for consistent spacing. */}
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 h-4 hidden sm:block"
              />{" "}
              {/* Hidden on mobile. */}
              {/* Desktop/Tablet logo (left-aligned) */}
              <Link
                href="/dashboard"
                className="hidden sm:flex items-center" // Hidden on mobile, flex on small and larger screens.
              >
                <SqratchLogo priority className="h-8 w-auto" />
              </Link>
              {/* Mobile-only centered logo */}
              <Link
                href="/dashboard"
                className="sm:hidden flex min-w-0 items-center"
              >
                <SqratchLogo priority className="h-6 w-auto" />
              </Link>
            </div>
            {/* NEW: user name + role + guard */}
            <div className="flex shrink-0 items-center gap-2 pr-3 sm:gap-3 sm:pr-4">
              <ThemeSelect />
              <DashboardTopbarUser />
            </div>
          </header>

          {/* Main Content Area */}
          <div className="flex-1 bg-transparent">
            <Suspense
              fallback={<div className="p-6 text-copy-70">Loading...</div>}
            >
              <div>{children}</div>
              <Toaster richColors />
            </Suspense>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
