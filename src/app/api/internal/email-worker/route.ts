import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendWelcomeEmail } from "@/helpers/mailer";
import {
  processWelcomeEmailQueue,
  type WelcomeEmailWorkerStore,
} from "@/lib/welcome-email-worker";

function requireCronSecret(req: Request) {
  const got = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  return !!got && !!expected && got === expected;
}

const store: WelcomeEmailWorkerStore = {
  async findStaleSendingJobs({ staleBefore, limit }) {
    return prisma.emailQueue.findMany({
      where: {
        template: "WELCOME",
        status: "SENDING",
        OR: [
          { claimedAt: { lte: staleBefore } },
          // Pre-retry-schema SENDING rows have no claimedAt. Use their
          // creation time only after the same stale window has elapsed.
          { claimedAt: null, createdAt: { lte: staleBefore } },
        ],
      },
      select: {
        id: true,
        userId: true,
        attempts: true,
        createdAt: true,
        nextAttemptAt: true,
        claimedAt: true,
        verificationEligible: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });
  },
  async recoverStaleJob(input) {
    const result = await prisma.emailQueue.updateMany({
      where: {
        id: input.id,
        template: "WELCOME",
        status: "SENDING",
        attempts: input.attempts,
        OR: [
          { claimedAt: { lte: input.staleBefore } },
          { claimedAt: null, createdAt: { lte: input.staleBefore } },
        ],
      },
      data: input.terminal
        ? {
            status: "FAILED",
            claimedAt: null,
            nextAttemptAt: null,
            lastError: "Welcome email claim expired after maximum attempts.",
          }
        : {
            status: "PENDING",
            claimedAt: null,
            nextAttemptAt: input.nextAttemptAt,
            lastError: "Welcome email claim expired; retry scheduled.",
          },
    });
    return result.count === 1;
  },
  async findEligibleJobs({ now, limit }) {
    return prisma.emailQueue.findMany({
      where: {
        template: "WELCOME",
        status: "PENDING",
        attempts: { lt: 5 },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      select: {
        id: true,
        userId: true,
        attempts: true,
        createdAt: true,
        nextAttemptAt: true,
        claimedAt: true,
        verificationEligible: true,
      },
      orderBy: [
        { nextAttemptAt: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: limit,
    });
  },
  async claimJob(input) {
    const result = await prisma.emailQueue.updateMany({
      where: {
        id: input.id,
        template: "WELCOME",
        status: "PENDING",
        attempts: { lt: 5 },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.claimedAt } }],
      },
      data: {
        status: "SENDING",
        claimedAt: input.claimedAt,
        attempts: { increment: 1 },
      },
    });
    return result.count === 1;
  },
  async findWelcomeAccount(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
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

    if (!user) return null;
    return {
      email: user.email,
      name: user.name,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      hasCreatorRequest: user.creatorRequests.length > 0,
      hasBrandRequest: user.brandRequests.length > 0,
    };
  },
  async markSkipped(input) {
    const result = await prisma.emailQueue.updateMany({
      where: {
        id: input.id,
        status: "SENDING",
        claimedAt: input.claimedAt,
      },
      data: {
        status: "SKIPPED",
        claimedAt: null,
        nextAttemptAt: null,
        lastError: input.reason,
      },
    });
    return result.count === 1;
  },
  async markSent(input) {
    const result = await prisma.emailQueue.updateMany({
      where: {
        id: input.id,
        status: "SENDING",
        claimedAt: input.claimedAt,
      },
      data: {
        status: "SENT",
        sentAt: input.sentAt,
        claimedAt: null,
        nextAttemptAt: null,
        lastError: null,
      },
    });
    return result.count === 1;
  },
  async releaseForRetry(input) {
    const result = await prisma.emailQueue.updateMany({
      where: {
        id: input.id,
        status: "SENDING",
        claimedAt: input.claimedAt,
      },
      data: {
        status: "PENDING",
        claimedAt: null,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.reason,
      },
    });
    return result.count === 1;
  },
  async markTerminalFailure(input) {
    const result = await prisma.emailQueue.updateMany({
      where: {
        id: input.id,
        status: "SENDING",
        claimedAt: input.claimedAt,
      },
      data: {
        status: "FAILED",
        claimedAt: null,
        nextAttemptAt: null,
        lastError: input.reason,
      },
    });
    return result.count === 1;
  },
};

export async function POST(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const summary = await processWelcomeEmailQueue({
      store,
      sendWelcomeEmail,
    });
    console.info("[email-worker] completed", summary);
    return NextResponse.json({ ok: true, summary });
  } catch {
    console.error("[email-worker] failed", {
      outcome: "worker_error",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: "Email worker failed." },
      { status: 500 },
    );
  }
}
