import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendWelcomeEmail } from "@/helpers/mailer";

function requireCronSecret(req: Request) {
  const got = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  return !!got && !!expected && got === expected;
}

export async function POST(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const cutoffMinutes = 45;
  const cutoff = new Date(now.getTime() - cutoffMinutes * 60 * 1000); // 45 minutes ago

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

    if (claimed.count !== 1) continue; // someone else took it

    try {
      await sendWelcomeEmail(job.email);

      await prisma.emailQueue.update({
        where: { id: job.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
        },
      });

      processed++;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown email worker error";
      console.error("[email-worker] FAILED", {
        id: job.id,
        message,
      });

      await prisma.emailQueue.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          lastError: message.slice(0, 2000),
        },
      });
    }
  }

  return NextResponse.json({ ok: true, processed });
}
