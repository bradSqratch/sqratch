import React, { Suspense } from "react";
import Link from "next/link"; // Import Link for navigation.
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

export const metadata = {
  title: "Admin Panel - SQRATCH",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <div className="flex h-screen w-full">
        <AppSidebar />
        {/* SidebarInset to contain breadcrumbs and main content */}
        <SidebarInset className="flex flex-col w-full">
          {/* Header with Sticky Styling */}
          <header className="flex h-16 shrink-0 items-center justify-between transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12 bg-transparent backdrop-blur-md border-b border-white/10">
            {" "}
            {/* Added styling classes from new code. */}
            <div className="flex items-center gap-3 px-4 sm:px-6">
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
                <h1 className="text-white text-3xl font-bold tracking-tight">
                  SQRATCH<sup className="text-sm align-super">™</sup>
                </h1>
              </Link>
              {/* Mobile-only centered logo */}
              <Link
                href="/dashboard"
                className="sm:hidden justify-self-center flex items-center ml-12" // Flex on mobile, hidden on small and larger screens.
              >
                <h1 className="text-white text-2xl font-bold tracking-tight">
                  SQRATCH<sup className="text-xs align-super">™</sup>
                </h1>
              </Link>
            </div>
            <div className="pr-4 text-white"></div>
          </header>

          {/* Main Content Area */}
          <div className="flex-1 bg-transparent">
            <Suspense fallback={<div>Loading...</div>}>
              <main>{children}</main>
              <Toaster richColors />
            </Suspense>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
