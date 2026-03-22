"use client";

import {
  LogOut,
  LayoutDashboard,
  QrCode,
  User,
  Sparkles,
  BookOpen,
  MessageSquareText,
  HelpCircle,
  BarChart3,
  Store,
  FlagIcon,
  Users,
  ShieldCheck,
  Building2,
  Megaphone,
  type LucideIcon,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

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

type Role = "ADMIN" | "BRAND_ADMIN" | "CREATOR" | "USER" | "EXTERNAL";

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
  const visible = items.filter((i) => canSee(role, i));
  if (visible.length === 0) return null;

  return (
    <SidebarGroup className="mt-4">
      <SidebarGroupLabel className="text-white/70 text-xs font-semibold uppercase tracking-wider px-3 py-2">
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="space-y-1">
          {visible.map((item) => (
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
  );
}

export function AppSidebar() {
  const router = useRouter();
  const { data: session } = useSession();

  const role = (session?.user?.role ?? "USER") as Role;

  const common: NavItem[] = [
    { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
    { title: "Profile", url: "/profile", icon: User },
  ];

  // Keep your existing behavior: Admin or User can see Generate QR
  const generateQr: NavItem[] = [
    {
      title: "Generate QR",
      url: "/generateQR",
      icon: QrCode,
      roles: ["ADMIN", "USER"],
    },
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
      title: "Shopify",
      url: "/dashboard/brand/shopify",
      icon: Store,
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
    {
      title: "Analytics",
      url: "/admin/analytics",
      icon: BarChart3,
      roles: ["ADMIN"],
    },
  ];

  const data = {
    user: {
      name: session?.user?.name || "SQRATCH",
      email: session?.user?.email || "dummyemail@gmail.com",
      avatar:
        session?.user?.imageUrl ||
        session?.user?.image ||
        "../../P_logo.png",
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
    <Sidebar className="border-r border-white/10 bg-[#070A1A]/75 backdrop-blur-xl">
      <SidebarHeader
        onClick={() => router.push("/dashboard")}
        className="transition-all duration-200 text-white bg-transparent cursor-pointer hover:bg-white/5 rounded-lg mx-2 mt-2"
      >
        <NavUser user={data.user} />
      </SidebarHeader>

      <SidebarContent className="text-white bg-transparent px-2">
        <Section label="Common" items={common} role={role} />
        <Section label="Tools" items={generateQr} role={role} />
        <Section label="Creator" items={creator} role={role} />
        <Section label="Brand" items={brand} role={role} />
        <Section label="Admin" items={adminNew} role={role} />
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
  );
}
