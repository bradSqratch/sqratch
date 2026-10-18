"use client";

import {
  LogOut,
  LayoutDashboard,
  QrCode,
  User,
  Coins,
  Sparkles,
  BookOpen,
  MessageSquareText,
  HelpCircle,
  BarChart3,
  Store,
  Package,
  Gift,
  FlagIcon,
  Users,
  ShieldCheck,
  Building2,
  Megaphone,
  type LucideIcon,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";

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

type Role = "ADMIN" | "BRAND_ADMIN" | "CREATOR" | "USER";

type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  roles?: Role[]; // if omitted, visible to all authenticated roles
};

function canSee(role: Role, item: NavItem) {
  if (!item.roles) return true;
  return item.roles.includes(role);
}

function Section({
  label,
  items,
  role,
}: {
  label: string;
  items: NavItem[];
  role: Role;
}) {
  const pathname = usePathname();
  const visible = items.filter((i) => canSee(role, i));
  if (visible.length === 0) return null;

  return (
    <SidebarGroup className="mt-4">
      <SidebarGroupLabel className="text-copy-70 text-xs font-semibold uppercase tracking-wider px-3 py-2">
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="space-y-1">
          {visible.map((item) => {
            const isActive =
              pathname === item.url ||
              (item.url !== "/dashboard" && pathname.startsWith(`${item.url}/`));

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  className="group rounded-lg border border-transparent text-copy-90 transition-[background-color,color,border-color,box-shadow] duration-200 hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar data-[active=true]:border-sidebar-border motion-reduce:transition-none dark:hover:border-edge/20 dark:hover:bg-blue-950/10 dark:hover:backdrop-blur-sm dark:hover:shadow-lg dark:hover:shadow-blue-600/20"
                >
                  <a
                    href={item.url}
                    aria-current={
                      isActive
                        ? pathname === item.url ? "page" : "location"
                        : undefined
                    }
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <item.icon className="w-5 h-5 transition-transform duration-200 dark:group-hover:scale-110 motion-reduce:transition-none motion-reduce:transform-none" />
                    <span className="font-medium">{item.title}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar() {
  const router = useRouter();
  const { data: session } = useSession();

  const role = (session?.user?.role ?? "USER") as Role;

  const common: NavItem[] = [
    { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
    { title: "Points", url: "/dashboard/points", icon: Coins },
    { title: "Profile", url: "/profile", icon: User },
  ];

  const creator: NavItem[] = [
    {
      title: "Experiences",
      url: "/dashboard/creator/experiences",
      icon: Sparkles,
      roles: ["CREATOR"],
    },
    {
      title: "Courses",
      url: "/dashboard/creator/courses",
      icon: BookOpen,
      roles: ["CREATOR"],
    },
    {
      title: "Posts",
      url: "/dashboard/creator/posts",
      icon: MessageSquareText,
      roles: ["CREATOR"],
    },
    {
      title: "Q&A",
      url: "/dashboard/creator/qa",
      icon: HelpCircle,
      roles: ["CREATOR"],
    },
    {
      title: "Analytics",
      url: "/dashboard/creator/analytics",
      icon: BarChart3,
      roles: ["CREATOR"],
    },
  ];

  const brand: NavItem[] = [
    {
      title: "Brand Profile",
      url: "/dashboard/brand/profile",
      icon: Building2,
      roles: ["BRAND_ADMIN"],
    },
    {
      title: "Campaigns",
      url: "/dashboard/brand/campaigns",
      icon: Megaphone,
      roles: ["BRAND_ADMIN"],
    },
    {
      title: "QR Batches",
      url: "/dashboard/brand/qr-batches",
      icon: QrCode,
      roles: ["BRAND_ADMIN"],
    },
    {
      // PHASE 16C2: provider-neutral entry point — a Commerce7 brand should
      // never see a "Shopify" nav item. The dedicated Shopify OAuth/install
      // page (/dashboard/brand/shopify) is unchanged and still reachable
      // (linked from this page for a Shopify-connected brand); this label
      // now points at the neutral status page instead.
      title: "Store",
      url: "/dashboard/brand/commerce",
      icon: Store,
      roles: ["BRAND_ADMIN"],
    },
    {
      title: "Products",
      url: "/dashboard/brand/products",
      icon: Package,
      roles: ["BRAND_ADMIN"],
    },
    {
      title: "Rewards",
      url: "/dashboard/brand/rewards",
      icon: Gift,
      roles: ["BRAND_ADMIN"],
    },
    {
      title: "Analytics",
      url: "/dashboard/brand/analytics",
      icon: BarChart3,
      roles: ["BRAND_ADMIN"],
    },
  ];

  // NEW admin routes (future)
  const adminNew: NavItem[] = [
    {
      title: "Approvals",
      url: "/dashboard/admin/approvals",
      icon: ShieldCheck,
      roles: ["ADMIN"],
    },
    {
      title: "Users",
      url: "/admin/user-management",
      icon: Users,
      roles: ["ADMIN"],
    },
    {
      title: "Brands",
      url: "/dashboard/admin/brands",
      icon: Building2,
      roles: ["ADMIN"],
    },
    {
      title: "Campaigns",
      url: "/dashboard/admin/campaigns",
      icon: FlagIcon,
      roles: ["ADMIN"],
    },
  ];

  const data = {
    user: {
      name: session?.user?.name || "Loading…",
      email: session?.user?.email || "",
      avatar: session?.user?.imageUrl || session?.user?.image || "/P_logo.png",
    },
  };

  const logout = async () => {
    try {
      await signOut({ callbackUrl: "/login" });
      toast.success("Successfully logged out", { description: "Logout" });
    } catch (error) {
      console.error("Error during logout:", error);
      toast.error("Error during logout", {
        description: "Failed to logout. Please try again.",
      });
    }
  };

  return (
    <Sidebar className="border-r border-sidebar-border bg-sidebar dark:bg-[#070A1A]/75 backdrop-blur-xl">
      <SidebarHeader
        onClick={() => router.push("/dashboard")}
        className="text-ink bg-transparent cursor-pointer rounded-lg mx-2 mt-2"
      >
        <NavUser user={data.user} />
      </SidebarHeader>

      <SidebarContent className="text-ink bg-transparent px-2">
        <Section label="Common" items={common} role={role} />
        <Section label="Creator" items={creator} role={role} />
        <Section label="Brand" items={brand} role={role} />
        <Section label="Admin" items={adminNew} role={role} />
      </SidebarContent>

      <SidebarFooter className="text-ink bg-transparent px-2 pb-4">
        <SidebarMenu>
          <SidebarMenuItem key="logout">
            <SidebarMenuButton
              onClick={logout}
              className="group rounded-lg border border-transparent text-red-700 transition-[background-color,color,border-color,box-shadow] duration-200 hover:border-red-700/20 hover:bg-red-500/10 hover:text-red-900 focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transition-none dark:text-red-300 dark:hover:border-red-400/30 dark:hover:bg-red-500/20 dark:hover:text-red-100 dark:hover:backdrop-blur-sm dark:hover:shadow-lg dark:hover:shadow-red-500/20 cursor-pointer"
            >
              <LogOut className="w-5 h-5 transition-transform duration-200 dark:group-hover:scale-110 motion-reduce:transition-none motion-reduce:transform-none" />
              <span className="font-medium">Logout</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
