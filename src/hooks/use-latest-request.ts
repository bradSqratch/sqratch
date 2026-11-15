"use client";

import { useCallback, useEffect, useRef } from "react";

export type LatestRequest = {
  /** Pass to `fetch`; aborted as soon as a newer request begins or the component unmounts. */
  signal: AbortSignal;
  /** False once a newer request has begun (or the component unmounted). Check before applying any result. */
  isCurrent: () => boolean;
};

/**
 * Pure guard behind {@link useLatestRequest}: only the most recent `begin()`
 * is current, and beginning a new one aborts the previous request's signal.
 */
export function createLatestRequestGuard() {
  let controller: AbortController | null = null;
  let sequence = 0;
  return {
    begin(): LatestRequest {
      controller?.abort();
      const next = new AbortController();
      controller = next;
      const id = ++sequence;
      return { signal: next.signal, isCurrent: () => id === sequence };
    },
    /** Invalidates and aborts whatever is in flight without starting anything new. */
    cancel() {
      controller?.abort();
      controller = null;
      sequence += 1;
    },
  };
}

/**
 * One guard per independent panel. Rapid filter changes can resolve out of
 * order; with this, a slow older response can never overwrite a newer one, and
 * a superseded request is cancelled on the network where possible.
 */
export function useLatestRequest() {
  const guard = useRef<ReturnType<typeof createLatestRequestGuard> | null>(null);
  if (!guard.current) guard.current = createLatestRequestGuard();
  useEffect(() => {
    const current = guard.current;
    return () => current?.cancel();
  }, []);
  return useCallback(() => guard.current!.begin(), []);
}
