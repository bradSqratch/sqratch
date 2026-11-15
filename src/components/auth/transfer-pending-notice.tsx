"use client";

import { Suspense, useCallback, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  requestAnonymousTransfer,
  TRANSFER_PENDING_PARAM,
  TRANSFER_PENDING_VALUE,
  withoutTransferPending,
} from "@/lib/anonymous-transfer-client";

type NoticeState = "pending" | "retrying" | "still-pending" | "done";

function NoticeInner({ className = "" }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, setState] = useState<NoticeState>("pending");
  const inFlight = useRef(false);
  const flagged = searchParams.get(TRANSFER_PENDING_PARAM) === TRANSFER_PENDING_VALUE;

  const retry = useCallback(async () => {
    if (inFlight.current) return; // One request at a time; a double click sends nothing extra.
    inFlight.current = true;
    setState("retrying");
    try {
      const status = await requestAnonymousTransfer();
      if (status === "complete") {
        setState("done");
        const query = searchParams.toString();
        router.replace(withoutTransferPending(`${pathname}${query ? `?${query}` : ""}`));
      } else {
        setState("still-pending");
      }
    } finally {
      inFlight.current = false;
    }
  }, [pathname, router, searchParams]);

  if (!flagged && state !== "done") return null;

  if (state === "done") {
    return (
      <p role="status" className={`rounded-xl border border-edge/15 bg-glass-5 px-4 py-3 text-sm text-copy-80 ${className}`}>
        Your earlier progress is now attached to your account.
      </p>
    );
  }

  return (
    <div
      role={state === "still-pending" ? "alert" : "status"}
      className={`flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/40 bg-amber-100/60 px-4 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-100 ${className}`}
    >
      <span>
        {state === "still-pending"
          ? "We could not attach your earlier progress yet. Nothing is lost — try again in a moment."
          : "You are signed in. Your earlier progress is still being attached to your account."}
      </span>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={state === "retrying"}
        className="rounded-lg border border-current px-3 py-1 font-medium disabled:opacity-60"
      >
        {state === "retrying" ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

/** Shown after sign-in when the browser's earlier progress could not be attached yet. */
export function TransferPendingNotice({ className }: { className?: string }) {
  return (
    <Suspense fallback={null}>
      <NoticeInner className={className} />
    </Suspense>
  );
}
