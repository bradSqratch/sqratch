import { NextResponse } from "next/server";
import { timingSafeEqualString } from "@/lib/security/timing-safe-equal";
import { runCommerce7ReconciliationWorker } from "@/lib/commerce/providers/commerce7-reconciliation-worker";

export async function POST(request: Request) {
  return commerce7ReconciliationWorkerPostImpl(request);
}

export async function commerce7ReconciliationWorkerPostImpl(request: Request, run = runCommerce7ReconciliationWorker) {
  if (!timingSafeEqualString(request.headers.get("x-cron-secret"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const counts = await run();
    // Counts only: no tenant, order, destination, token or raw error.
    console.info("[commerce7-reconciliation-worker] completed", counts);
    return NextResponse.json({ ok: counts.failed === 0, counts }, { status: counts.failed ? 503 : 200 });
  } catch {
    console.error("[commerce7-reconciliation-worker] failed");
    return NextResponse.json({ error: "Reconciliation worker failed." }, { status: 500 });
  }
}
