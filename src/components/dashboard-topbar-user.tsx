"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { buildLoginPathWithCallback } from "@/lib/safe-redirect";

function roleLabel(role?: string) {
  if (!role) return "UNKNOWN";
  return role.replaceAll("_", " ");
}

export function DashboardTopbarUser() {
  const router = useRouter();
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "loading" || session) {
      return;
    }

    router.replace(
      buildLoginPathWithCallback(
        `${window.location.pathname}${window.location.search}`,
      ),
    );
  }, [router, session, status]);

  // Layout-level auth guard (in addition to middleware)
  if (status === "loading") return null;

  if (!session) {
    return null;
  }

  const name = session.user?.name ?? "SQRATCH";
  const role = session.user?.role;

  return (
    <div className="hidden items-center gap-3 text-copy-85 lg:flex">
      <div className="hidden max-w-48 truncate text-sm font-medium xl:block">{name}</div>
      <div className="rounded-full border border-edge/15 bg-glass-5 px-3 py-1 text-xs font-semibold tracking-wide text-copy-80">
        {roleLabel(role)}
      </div>
    </div>
  );
}
