"use client";

import {
  LogOut,
  LayoutDashboard,
  QrCode,
  FlagIcon,
  ListTodo,
  Printer,
  UserPlus,
  Users,
} from "lucide-react";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { NavUser } from "@/components/nav-user";
import { toast } from "sonner";

export function AppSidebar() {
  const router = useRouter();
  const { data: session } = useSession(); // Use session data to determine the user's role.

  // Menu items.
  const items = [
    {
      title: "Dashboard",
      url: "/dashboard",
      icon: LayoutDashboard,
    },
  ];

  if (session?.user?.role === "ADMIN" || session?.user?.role === "USER") {
    items.push({
      title: "Generate QR",
      url: "/generateQR",
      icon: QrCode,
    });
  }

  // Admin-specific items.
  const adminItems = [
    {
      title: "Community Management",
      url: "/admin/community-management",
      icon: Users,
    },
    {
      title: "Campaign Management",
      url: "/admin/campaigns-management",
      icon: FlagIcon,
    },
    {
      title: "QR Management",
      url: "/admin/qr-management",
      icon: ListTodo,
    },
    {
      title: "Print QR",
      url: "/admin/print-qr",
      icon: Printer,
    },
    {
      title: "User Management",
      url: "/admin/user-management",
      icon: UserPlus,
    },
  ];

  const data = {
    user: {
      name: session?.user?.name || "SQRATCH",
      email: session?.user?.email || "dummyemail@gmail.com",
      avatar: session?.user?.image || "../../P_logo.png",
    },
  };

  const logout = async () => {
    try {
      await signOut({ callbackUrl: "/login" }); // NextAuth's signOut method
      toast.success("Successfully logged out", {
        description: "Logout",
      });
    } catch (error) {
      console.error("Error during logout:", error);
      toast.error("Error during logout", {
        description: "Failed to logout. Please try again.",
      });
    }
  };

  const showNavigation = items.length > 0;

  return (
    <>
      <Sidebar className="border-r border-white/10 bg-[#070A1A]/75 backdrop-blur-xl">
        <SidebarHeader
          onClick={() => router.push("/dashboard")}
          className="transition-all duration-200 text-white bg-transparent cursor-pointer hover:bg-white/5 rounded-lg mx-2 mt-2"
        >
          <NavUser user={data.user} />
        </SidebarHeader>
        <SidebarContent className="text-white bg-transparent px-2">
          {showNavigation && (
            <SidebarGroup>
              <SidebarGroupLabel className="text-white/70 text-xs font-semibold uppercase tracking-wider px-3 py-2">
                Navigation
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="space-y-1">
                  {items.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        className="text-white/90 hover:text-white hover:bg-blue-950/10 hover:backdrop-blur-sm hover:border hover:border-white/20 hover:shadow-lg hover:shadow-blue-600/20 rounded-lg transition-all duration-200 group"
                      >
                        <a
                          href={item.url}
                          className="flex items-center gap-3 px-3 py-2"
                        >
                          <item.icon className="w-5 h-5 group-hover:scale-110 transition-transform duration-200" />
                          <span className="font-medium">{item.title}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {/* Admin Section */}
          {session?.user?.role === "ADMIN" && (
            <SidebarGroup className="mt-4">
              <SidebarGroupLabel className="text-white/70 text-xs font-semibold uppercase tracking-wider px-3 py-2">
                Admin
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="space-y-1">
                  {adminItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        className="text-white/90 hover:text-white hover:bg-blue-950/40 hover:backdrop-blur-sm hover:border hover:border-white/20 hover:shadow-lg hover:shadow-blue-600/20 rounded-lg transition-all duration-200 group"
                      >
                        <a
                          href={item.url}
                          className="flex items-center gap-3 px-3 py-2"
                        >
                          <item.icon className="w-5 h-5 group-hover:scale-110 transition-transform duration-200" />
                          <span className="font-medium">{item.title}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter className="text-white bg-transparent px-2 pb-4">
          <SidebarMenu>
            <SidebarMenuItem key="logout">
              <SidebarMenuButton
                onClick={logout}
                className="text-red-300 hover:text-red-100 hover:bg-red-500/20 hover:backdrop-blur-sm hover:border hover:border-red-400/30 hover:shadow-lg hover:shadow-red-500/20 rounded-lg transition-all duration-200 cursor-pointer group"
              >
                <LogOut className="w-5 h-5 group-hover:scale-110 transition-transform duration-200" />
                <span className="font-medium">Logout</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </>
  );
}
