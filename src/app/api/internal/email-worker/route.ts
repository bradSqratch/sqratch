import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendWelcomeEmail } from "@/helpers/mailer";
import { isWelcomeEmailEligible } from "@/lib/welcome-email";

function requireCronSecret(req: Request) {
  const got = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  return !!got && !!expected && got === expected;
}

export async function POST(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // pick a small batch each run (adjust later)
  const BATCH = 25;

  // 1) Find eligible jobs
  const jobs = await prisma.emailQueue.findMany({
    where: {
      status: "PENDING",
      template: "WELCOME",
    },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  if (jobs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, skipped: 0 });
  }

  let processed = 0;
  let skipped = 0;

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
      const user = await prisma.user.findUnique({
        where: { id: job.userId },
        select: {
          email: true,
          name: true,
          role: true,
          isEmailVerified: true,
          creatorRequests: {
            select: { id: true },
            take: 1,
          },
          brandRequests: {
            select: { id: true },
            take: 1,
          },
        },
      });

      const eligible =
        user !== null &&
        job.verificationEligible &&
        isWelcomeEmailEligible({
          isEmailVerified: user.isEmailVerified,
          role: user.role,
          hasCreatorRequest: user.creatorRequests.length > 0,
          hasBrandRequest: user.brandRequests.length > 0,
        });

      if (!eligible) {
        await prisma.emailQueue.updateMany({
          where: { id: job.id, status: "SENDING" },
          data: {
            status: "SKIPPED",
            lastError: "Skipped: account is not eligible for a welcome email.",
          },
        });
        skipped += 1;
        continue;
      }

      if (!user) {
        continue;
      }

      await sendWelcomeEmail({
        email: user.email,
        name: user.name,
      });

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

  return NextResponse.json({ ok: true, processed, skipped });
}
