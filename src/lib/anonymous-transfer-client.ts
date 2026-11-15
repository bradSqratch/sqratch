/**
 * Browser-side helpers for the anonymous-progress transfer. Authentication and
 * transfer are separate outcomes: a transfer that cannot finish must never be
 * reported as a failed sign-in or a failed verification.
 */
export type ClientTransferStatus = "complete" | "retry_required";

export const TRANSFER_PENDING_PARAM = "transfer";
export const TRANSFER_PENDING_VALUE = "pending";
export const TRANSFER_REQUEST_TIMEOUT_MS = 8000;

/** Reads `{ data: { status } }` (merge route) or `{ transfer: { status } }` (verification). */
export function readTransferStatus(payload: unknown): ClientTransferStatus {
  const body = payload as { data?: { status?: unknown }; transfer?: { status?: unknown } } | null;
  const status = body?.data?.status ?? body?.transfer?.status;
  return status === "complete" ? "complete" : "retry_required";
}

/** Asks the server to transfer this browser's anonymous progress. Never throws. */
export async function requestAnonymousTransfer(
  fetchImpl: typeof fetch = fetch,
): Promise<ClientTransferStatus> {
  try {
    // Never hold a redirect on a stalled request: a timeout is just an incomplete
    // transfer, which the destination page offers to retry.
    const signal =
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(TRANSFER_REQUEST_TIMEOUT_MS)
        : undefined;
    const response = await fetchImpl("/api/progress/merge", {
      method: "POST",
      credentials: "include",
      signal,
    });
    if (!response.ok) return "retry_required";
    return readTransferStatus(await response.json().catch(() => null));
  } catch {
    return "retry_required";
  }
}

function splitPath(path: string) {
  const hashIndex = path.indexOf("#");
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = withoutHash.indexOf("?");
  return {
    pathname: queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash,
    params: new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : ""),
    hash,
  };
}

/** Adds the non-sensitive pending flag to an internal path, keeping its query and hash. */
export function withTransferPending(path: string): string {
  const { pathname, params, hash } = splitPath(path);
  params.set(TRANSFER_PENDING_PARAM, TRANSFER_PENDING_VALUE);
  return `${pathname}?${params.toString()}${hash}`;
}

/** Removes the pending flag, keeping every other parameter. */
export function withoutTransferPending(path: string): string {
  const { pathname, params, hash } = splitPath(path);
  params.delete(TRANSFER_PENDING_PARAM);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
