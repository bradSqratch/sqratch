"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

function roleLabel(role?: string) {
  if (!role) return "UNKNOWN";
  return role.replaceAll("_", " ");
}

export function DashboardTopbarUser() {
  const router = useRouter();
  const { data: session, status } = useSession();

  // Layout-level auth guard (in addition to middleware)
  if (status === "loading") return null;

  if (!session) {
    router.replace("/login");
    return null;
  }

  const name = session.user?.name ?? "SQRATCH";
  const role = (session.user as any)?.role as string | undefined;

  return (
    <div className="flex items-center gap-3 text-white/85">
      <div className="hidden sm:block text-sm font-medium">{name}</div>
      <div className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold tracking-wide text-white/80">
        {roleLabel(role)}
      </div>
    </div>
  );
}
