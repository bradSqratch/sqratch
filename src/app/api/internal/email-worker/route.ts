import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendWelcomeEmail } from "@/helpers/mailer";

function requireCronSecret(req: Request) {
  const got = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  return !!got && !!expected && got === expected;
}

export async function POST(req: Request) {
  console.log("[email-worker] HIT", {
    ts: new Date().toISOString(),
    url: req.url,
    method: "POST",
    hasHeader: !!req.headers.get("x-cron-secret"),
    headerPrefix: req.headers.get("x-cron-secret")?.slice(0, 6) ?? null,
    envHasSecret: !!process.env.CRON_SECRET,
    envSecretPrefix: process.env.CRON_SECRET?.slice(0, 6) ?? null,
  });

  if (!requireCronSecret(req)) {
    console.warn("[email-worker] UNAUTHORIZED", {
      got: req.headers.get("x-cron-secret")?.slice(0, 10) ?? null,
      expected: process.env.CRON_SECRET?.slice(0, 10) ?? null,
    });

    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const cutoffMinutes = 45;
  const cutoff = new Date(now.getTime() - cutoffMinutes * 60 * 1000); // 45 minutes ago

  console.log("[email-worker] WINDOW", {
    now: now.toISOString(),
    cutoff: cutoff.toISOString(),
    minutesAgo: cutoffMinutes,
  });

  // pick a small batch each run (adjust later)
  const BATCH = 25;

  // 1) Find eligible jobs
  const jobs = await prisma.emailQueue.findMany({
    where: {
      status: "PENDING",
      template: "WELCOME",
      createdAt: { lte: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  console.log("[email-worker] ELIGIBLE_JOBS", {
    count: jobs.length,
    firstId: jobs[0]?.id ?? null,
    firstCreatedAt:
      jobs[0]?.createdAt?.toISOString?.() ?? jobs[0]?.createdAt ?? null,
  });

  if (jobs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  let processed = 0;

  for (const job of jobs) {
    // 2) “Claim” the job so two workers don’t send twice
    // Use updateMany with status guard (atomic-ish)
    const claimed = await prisma.emailQueue.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: {
        status: "SENDING",
        attempts: { increment: 1 },
        lastError: null,
      },
    });

    console.log("[email-worker] CLAIM_ATTEMPT", {
      id: job.id,
      claimed: claimed.count,
    });

    if (claimed.count !== 1) continue; // someone else took it

    try {
      await sendWelcomeEmail(job.email);

      console.log("[email-worker] SENT", { id: job.id, email: job.email });

      await prisma.emailQueue.update({
        where: { id: job.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
        },
      });

      processed++;
    } catch (e: any) {
      console.error("[email-worker] FAILED", {
        id: job.id,
        email: job.email,
        message: e?.message,
        stack: e?.stack,
      });

      await prisma.emailQueue.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          lastError: e?.message?.slice(0, 2000) ?? "Unknown error",
        },
      });
    }
  }

  return NextResponse.json({ ok: true, processed });
}
