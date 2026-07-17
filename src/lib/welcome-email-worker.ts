import { isWelcomeEmailEligible } from "@/lib/welcome-email";

export const WELCOME_EMAIL_BATCH_SIZE = 25;
export const WELCOME_EMAIL_MAX_ATTEMPTS = 5;
export const WELCOME_EMAIL_STALE_CLAIM_MS = 15 * 60 * 1000;

const RETRY_DELAYS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
] as const;

export type WelcomeEmailQueueJob = {
  id: bigint;
  userId: string;
  attempts: number;
  createdAt: Date;
  nextAttemptAt: Date | null;
  claimedAt: Date | null;
  verificationEligible: boolean;
};

type WelcomeEmailAccount = {
  email: string;
  name: string | null;
  role: "USER" | "ADMIN" | "CREATOR" | "BRAND_ADMIN";
  isEmailVerified: boolean;
  hasCreatorRequest: boolean;
  hasBrandRequest: boolean;
};

type ClaimedJob = Pick<WelcomeEmailQueueJob, "id" | "attempts"> & {
  claimedAt: Date;
};

export type WelcomeEmailWorkerStore = {
  findStaleSendingJobs: (input: {
    staleBefore: Date;
    limit: number;
  }) => Promise<WelcomeEmailQueueJob[]>;
  recoverStaleJob: (input: {
    id: bigint;
    attempts: number;
    staleBefore: Date;
    now: Date;
    nextAttemptAt: Date | null;
    terminal: boolean;
  }) => Promise<boolean>;
  findEligibleJobs: (input: {
    now: Date;
    limit: number;
  }) => Promise<WelcomeEmailQueueJob[]>;
  claimJob: (input: ClaimedJob) => Promise<boolean>;
  findWelcomeAccount: (userId: string) => Promise<WelcomeEmailAccount | null>;
  markSkipped: (input: ClaimedJob & { reason: string }) => Promise<boolean>;
  markSent: (input: ClaimedJob & { sentAt: Date }) => Promise<boolean>;
  releaseForRetry: (input: ClaimedJob & {
    nextAttemptAt: Date;
    reason: string;
  }) => Promise<boolean>;
  markTerminalFailure: (input: ClaimedJob & { reason: string }) => Promise<boolean>;
};

export type WelcomeEmailWorkerSummary = {
  inspected: number;
  claimed: number;
  sent: number;
  skipped: number;
  scheduledForRetry: number;
  terminalFailed: number;
  staleRecovered: number;
  claimConflicts: number;
  durationMs: number;
};

export type WelcomeEmailWorkerOptions = {
  store: WelcomeEmailWorkerStore;
  sendWelcomeEmail: (input: {
    email: string;
    name: string | null;
  }) => Promise<unknown>;
  now?: Date;
  batchSize?: number;
};

export function retryDelayMsForAttempt(attempts: number): number | null {
  return RETRY_DELAYS_MS[attempts - 1] ?? null;
}

export function retryAtForAttempt(now: Date, attempts: number): Date | null {
  const delay = retryDelayMsForAttempt(attempts);
  return delay === null ? null : new Date(now.getTime() + delay);
}

function safeFailureReason(): string {
  // Provider errors may include recipient addresses or transport details. Keep
  // only a stable, non-sensitive category in the queue and logs.
  return "Welcome email delivery failed.";
}

function emptySummary(): WelcomeEmailWorkerSummary {
  return {
    inspected: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    scheduledForRetry: 0,
    terminalFailed: 0,
    staleRecovered: 0,
    claimConflicts: 0,
    durationMs: 0,
  };
}

/**
 * Processes welcome-email jobs with at-least-once semantics. Exactly-once
 * delivery is impossible when an SMTP provider accepts a message immediately
 * before a worker crashes; stale claims are recovered conservatively with the
 * same bounded retry schedule used for explicit delivery failures.
 */
export async function processWelcomeEmailQueue(
  options: WelcomeEmailWorkerOptions,
): Promise<WelcomeEmailWorkerSummary> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? WELCOME_EMAIL_BATCH_SIZE;
  const staleBefore = new Date(now.getTime() - WELCOME_EMAIL_STALE_CLAIM_MS);
  const summary = emptySummary();

  const staleJobs = await options.store.findStaleSendingJobs({
    staleBefore,
    limit: batchSize,
  });

  for (const job of staleJobs) {
    const terminal = job.attempts >= WELCOME_EMAIL_MAX_ATTEMPTS;
    const recovered = await options.store.recoverStaleJob({
      id: job.id,
      attempts: job.attempts,
      staleBefore,
      now,
      nextAttemptAt: terminal ? null : retryAtForAttempt(now, job.attempts),
      terminal,
    });

    if (recovered) {
      summary.staleRecovered += 1;
      if (terminal) {
        summary.terminalFailed += 1;
      } else {
        summary.scheduledForRetry += 1;
      }
    }
  }

  const jobs = await options.store.findEligibleJobs({ now, limit: batchSize });
  summary.inspected = jobs.length;

  for (const job of jobs) {
    const claim: ClaimedJob = {
      id: job.id,
      attempts: job.attempts + 1,
      claimedAt: now,
    };
    const claimed = await options.store.claimJob(claim);

    if (!claimed) {
      summary.claimConflicts += 1;
      continue;
    }

    summary.claimed += 1;

    try {
      const user = await options.store.findWelcomeAccount(job.userId);
      const eligible =
        user !== null &&
        job.verificationEligible &&
        isWelcomeEmailEligible({
          isEmailVerified: user.isEmailVerified,
          role: user.role,
          hasCreatorRequest: user.hasCreatorRequest,
          hasBrandRequest: user.hasBrandRequest,
        });

      if (!eligible) {
        const skipped = await options.store.markSkipped({
          ...claim,
          reason: "Skipped: account is not eligible for a welcome email.",
        });
        if (skipped) summary.skipped += 1;
        continue;
      }

      await options.sendWelcomeEmail({ email: user.email, name: user.name });
      const sent = await options.store.markSent({ ...claim, sentAt: now });
      if (sent) summary.sent += 1;
    } catch {
      const reason = safeFailureReason();
      const terminal = claim.attempts >= WELCOME_EMAIL_MAX_ATTEMPTS;

      if (terminal) {
        const failed = await options.store.markTerminalFailure({
          ...claim,
          reason,
        });
        if (failed) summary.terminalFailed += 1;
        continue;
      }

      const nextAttemptAt = retryAtForAttempt(now, claim.attempts);
      if (!nextAttemptAt) {
        const failed = await options.store.markTerminalFailure({
          ...claim,
          reason,
        });
        if (failed) summary.terminalFailed += 1;
        continue;
      }

      const released = await options.store.releaseForRetry({
        ...claim,
        nextAttemptAt,
        reason,
      });
      if (released) summary.scheduledForRetry += 1;
    }
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}
