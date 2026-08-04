import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { AccessDeniedPanel } from "@/components/auth/access-denied-panel";

export default async function DashboardAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  if (session?.user?.role !== "ADMIN") {
    return (
      <AccessDeniedPanel
        title="Admin access required"
        description="This SQRATCH account does not have Admin access to platform management tools."
        requiredAccess="Admin"
        primaryAction={{ label: "Return to dashboard", href: "/dashboard" }}
      />
    );
  }

  return <>{children}</>;
}
