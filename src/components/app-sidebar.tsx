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
    {
      title: "Generate QR",
      url: "/generateQR",
      icon: QrCode,
    },
  ];

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

  const USERorADMINisAllowed =
    session?.user?.role === "ADMIN" || session?.user?.role === "USER";

  return (
    <>
      <Sidebar>
        <SidebarHeader
          onClick={() => router.push("/dashboard")}
          className="transition-colors text-white bg-[var(--leftsidebar-primary)]"
        >
          <NavUser user={data.user} />
        </SidebarHeader>
        <SidebarContent className="text-white bg-[var(--leftsidebar-primary)]">
          {USERorADMINisAllowed && (
            <SidebarGroup>
              <SidebarGroupLabel className="text-white">
                Navigation
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        className="hover:bg-[var(--sidebar-accent)] hover:text-shadow-gray-700 transition-colors"
                      >
                        <a href={item.url}>
                          <item.icon />

                          <span>{item.title}</span>
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
            <SidebarGroup>
              <SidebarGroupLabel className="text-white">
                Admin
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {adminItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        className="hover:bg-[var(--sidebar-accent)] hover:text-shadow-gray-700 transition-colors"
                      >
                        <a href={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter className="text-white bg-[var(--leftsidebar-primary)]">
          <SidebarMenu>
            <SidebarMenuItem key="logout">
              <SidebarMenuButton
                onClick={logout}
                className="hover:bg-[var(--sidebar-accent)] hover:text-shadow-gray-700 transition-colors"
              >
                <LogOut />
                <span>Logout</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </>
  );
}
