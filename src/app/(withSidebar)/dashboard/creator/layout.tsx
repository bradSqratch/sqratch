import { getCreatorContext } from "@/lib/creator-auth";
import { AccessDeniedPanel } from "@/components/auth/access-denied-panel";

export default async function DashboardCreatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Requires the actual CREATOR role plus an existing CreatorProfile —
  // deliberately no ADMIN override (ADMIN must not impersonate or directly
  // edit Creator-owned content).
  const creator = await getCreatorContext();

  if (!creator) {
    return (
      <AccessDeniedPanel
        title="Creator access required"
        description="This SQRATCH account does not have Creator access."
        requiredAccess="Creator"
        primaryAction={{ label: "Return to dashboard", href: "/dashboard" }}
      />
    );
  }

  return <>{children}</>;
}
