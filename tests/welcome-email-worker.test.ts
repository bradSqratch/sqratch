import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  processWelcomeEmailQueue,
  retryDelayMsForAttempt,
  type WelcomeEmailQueueJob,
  type WelcomeEmailWorkerStore,
} from "@/lib/welcome-email-worker";

const now = new Date("2026-07-17T14:00:00.000Z");

type StoredJob = WelcomeEmailQueueJob & {
  status: "PENDING" | "SENDING" | "SENT" | "SKIPPED" | "FAILED";
  lastError: string | null;
  sentAt: Date | null;
};

type StoredAccount = {
  email: string;
  name: string | null;
  role: "USER" | "ADMIN" | "CREATOR" | "BRAND_ADMIN";
  isEmailVerified: boolean;
  hasCreatorRequest: boolean;
  hasBrandRequest: boolean;
};

function sameTime(left: Date | null, right: Date) {
  return left?.getTime() === right.getTime();
}

function makeJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: BigInt(1),
    userId: "user-1",
    attempts: 0,
    createdAt: new Date("2026-07-17T13:00:00.000Z"),
    nextAttemptAt: null,
    claimedAt: null,
    verificationEligible: true,
    status: "PENDING",
    lastError: null,
    sentAt: null,
    ...overrides,
  };
}

function eligibleAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    email: "person@example.com",
    name: "Person",
    role: "USER",
    isEmailVerified: true,
    hasCreatorRequest: false,
    hasBrandRequest: false,
    ...overrides,
  };
}

function createStore(
  jobs: StoredJob[],
  accounts = new Map<string, StoredAccount>([["user-1", eligibleAccount()]]),
): WelcomeEmailWorkerStore {
  const find = (id: bigint) => jobs.find((job) => job.id === id);

  return {
    async findStaleSendingJobs({ staleBefore, limit }) {
      return jobs
        .filter(
          (job) =>
            job.status === "SENDING" &&
            job.claimedAt !== null &&
            job.claimedAt <= staleBefore,
        )
        .sort(
          (left, right) =>
            left.claimedAt!.getTime() - right.claimedAt!.getTime() ||
            Number(left.id - right.id),
        )
        .slice(0, limit);
    },
    async recoverStaleJob(input) {
      const job = find(input.id);
      if (
        !job ||
        job.status !== "SENDING" ||
        job.attempts !== input.attempts ||
        !job.claimedAt ||
        job.claimedAt > input.staleBefore
      ) {
        return false;
      }

      job.status = input.terminal ? "FAILED" : "PENDING";
      job.claimedAt = null;
      job.nextAttemptAt = input.nextAttemptAt;
      job.lastError = input.terminal
        ? "Welcome email claim expired after maximum attempts."
        : "Welcome email claim expired; retry scheduled.";
      return true;
    },
    async findEligibleJobs({ now: eligibleAt, limit }) {
      return jobs
        .filter(
          (job) =>
            job.status === "PENDING" &&
            job.attempts < 5 &&
            (job.nextAttemptAt === null || job.nextAttemptAt <= eligibleAt),
        )
        .sort(
          (left, right) =>
            (left.nextAttemptAt?.getTime() ?? 0) -
              (right.nextAttemptAt?.getTime() ?? 0) ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            Number(left.id - right.id),
        )
        .slice(0, limit);
    },
    async claimJob(input) {
      const job = find(input.id);
      if (
        !job ||
        job.status !== "PENDING" ||
        job.attempts >= 5 ||
        (job.nextAttemptAt !== null && job.nextAttemptAt > input.claimedAt) ||
        job.attempts + 1 !== input.attempts
      ) {
        return false;
      }

      job.status = "SENDING";
      job.claimedAt = input.claimedAt;
      job.attempts += 1;
      return true;
    },
    async findWelcomeAccount(userId) {
      return accounts.get(userId) ?? null;
    },
    async markSkipped(input) {
      const job = find(input.id);
      if (!job || job.status !== "SENDING" || !sameTime(job.claimedAt, input.claimedAt)) {
        return false;
      }
      job.status = "SKIPPED";
      job.claimedAt = null;
      job.nextAttemptAt = null;
      job.lastError = input.reason;
      return true;
    },
    async markSent(input) {
      const job = find(input.id);
      if (!job || job.status !== "SENDING" || !sameTime(job.claimedAt, input.claimedAt)) {
        return false;
      }
      job.status = "SENT";
      job.sentAt = input.sentAt;
      job.claimedAt = null;
      job.nextAttemptAt = null;
      job.lastError = null;
      return true;
    },
    async releaseForRetry(input) {
      const job = find(input.id);
      if (!job || job.status !== "SENDING" || !sameTime(job.claimedAt, input.claimedAt)) {
        return false;
      }
      job.status = "PENDING";
      job.claimedAt = null;
      job.nextAttemptAt = input.nextAttemptAt;
      job.lastError = input.reason;
      return true;
    },
    async markTerminalFailure(input) {
      const job = find(input.id);
      if (!job || job.status !== "SENDING" || !sameTime(job.claimedAt, input.claimedAt)) {
        return false;
      }
      job.status = "FAILED";
      job.claimedAt = null;
      job.nextAttemptAt = null;
      job.lastError = input.reason;
      return true;
    },
  };
}

async function run(
  jobs: StoredJob[],
  sendWelcomeEmail: () => Promise<unknown> = async () => undefined,
  options: { at?: Date; accounts?: Map<string, StoredAccount> } = {},
) {
  return processWelcomeEmailQueue({
    store: createStore(jobs, options.accounts),
    sendWelcomeEmail: async () => sendWelcomeEmail(),
    now: options.at ?? now,
  });
}

test("an eligible new PENDING welcome job is claimed and sent immediately", async () => {
  const job = makeJob();
  const summary = await run([job]);

  assert.equal(summary.inspected, 1);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.sent, 1);
  assert.equal(job.status, "SENT");
  assert.equal(job.attempts, 1);
  assert.equal(job.claimedAt, null);
  assert.equal(job.nextAttemptAt, null);
  assert.equal(job.lastError, null);
});

for (const [attempts, expectedDelay, expectedStatus] of [
  [0, 5 * 60 * 1000, "PENDING"],
  [1, 15 * 60 * 1000, "PENDING"],
  [2, 60 * 60 * 1000, "PENDING"],
  [3, 6 * 60 * 60 * 1000, "PENDING"],
  [4, null, "FAILED"],
] as const) {
  test(`failed attempt ${attempts + 1} uses the bounded retry policy`, async () => {
    const job = makeJob({ attempts });
    const summary = await run([job], async () => {
      throw new Error("smtp rejected person@example.com password=not-safe-to-store");
    });

    assert.equal(job.attempts, attempts + 1);
    assert.equal(job.status, expectedStatus);
    assert.equal(job.claimedAt, null);
    assert.equal(job.lastError, "Welcome email delivery failed.");
    if (expectedDelay === null) {
      assert.equal(job.nextAttemptAt, null);
      assert.equal(summary.terminalFailed, 1);
    } else {
      assert.equal(job.nextAttemptAt?.getTime(), now.getTime() + expectedDelay);
      assert.equal(summary.scheduledForRetry, 1);
    }
  });
}

test("jobs before nextAttemptAt are not processed, but become eligible at that time", async () => {
  const dueAt = new Date(now.getTime() + 60_000);
  const job = makeJob({ nextAttemptAt: dueAt });

  const before = await run([job]);
  assert.equal(before.inspected, 0);
  assert.equal(job.attempts, 0);

  const atDueTime = await run([job], async () => undefined, { at: dueAt });
  assert.equal(atDueTime.sent, 1);
  assert.equal(job.status, "SENT");
});

test("stale SENDING jobs are recovered with backoff while fresh claims are untouched", async () => {
  const stale = makeJob({
    id: BigInt(1),
    status: "SENDING",
    attempts: 1,
    claimedAt: new Date(now.getTime() - 16 * 60 * 1000),
  });
  const fresh = makeJob({
    id: BigInt(2),
    status: "SENDING",
    attempts: 1,
    claimedAt: new Date(now.getTime() - 14 * 60 * 1000),
  });

  const summary = await run([stale, fresh]);
  assert.equal(summary.staleRecovered, 1);
  assert.equal(summary.scheduledForRetry, 1);
  assert.equal(stale.status, "PENDING");
  assert.equal(
    stale.nextAttemptAt?.getTime(),
    now.getTime() + retryDelayMsForAttempt(1)!,
  );
  assert.equal(fresh.status, "SENDING");
  assert.equal(fresh.attempts, 1);
});

test("a stale claim that already exhausted attempts becomes terminal FAILED", async () => {
  const job = makeJob({
    status: "SENDING",
    attempts: 5,
    claimedAt: new Date(now.getTime() - 16 * 60 * 1000),
  });
  const summary = await run([job]);

  assert.equal(summary.staleRecovered, 1);
  assert.equal(summary.terminalFailed, 1);
  assert.equal(job.status, "FAILED");
  assert.equal(job.nextAttemptAt, null);
  assert.equal(job.claimedAt, null);
});

test("attempts increment only for an atomic successful claim", async () => {
  const job = makeJob();
  const store = createStore([job]);
  const claim = { id: job.id, attempts: 1, claimedAt: now };

  const [first, second] = await Promise.all([
    store.claimJob(claim),
    store.claimJob(claim),
  ]);

  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(job.attempts, 1);
  assert.equal(job.status, "SENDING");
});

test("a successful retry becomes SENT and clears retry fields", async () => {
  const job = makeJob({
    attempts: 1,
    nextAttemptAt: now,
    lastError: "Welcome email delivery failed.",
  });
  const summary = await run([job]);

  assert.equal(summary.sent, 1);
  assert.equal(job.status, "SENT");
  assert.equal(job.attempts, 2);
  assert.equal(job.nextAttemptAt, null);
  assert.equal(job.claimedAt, null);
  assert.equal(job.lastError, null);
});

test("ineligible welcome jobs become SKIPPED and are never retried", async () => {
  const job = makeJob();
  const accounts = new Map<string, StoredAccount>([
    ["user-1", eligibleAccount({ role: "CREATOR" })],
  ]);
  const first = await run([job], async () => undefined, { accounts });
  const second = await run([job], async () => undefined, { accounts });

  assert.equal(first.skipped, 1);
  assert.equal(second.inspected, 0);
  assert.equal(job.status, "SKIPPED");
  assert.equal(job.claimedAt, null);
  assert.equal(job.nextAttemptAt, null);
});

test("verification-ineligible and already-sent jobs never send another welcome email", async () => {
  const verificationIneligible = makeJob({ verificationEligible: false });
  const alreadySent = makeJob({
    id: BigInt(2),
    status: "SENT",
    attempts: 1,
    sentAt: new Date(now.getTime() - 60_000),
  });
  let sends = 0;
  const summary = await run(
    [verificationIneligible, alreadySent],
    async () => {
      sends += 1;
    },
  );

  assert.equal(summary.skipped, 1);
  assert.equal(sends, 0);
  assert.equal(verificationIneligible.status, "SKIPPED");
  assert.equal(alreadySent.status, "SENT");
  assert.equal(alreadySent.attempts, 1);
});

test("the retry migration is additive and preserves existing queue rows", () => {
  const migration = readFileSync(
    "prisma/migrations/20260717140000_welcome_email_worker_retries/migration.sql",
    "utf8",
  );

  assert.match(migration, /ADD COLUMN "nextAttemptAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "claimedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /idx_email_queue_ready/);
  assert.match(migration, /idx_email_queue_stale_claim/);
  assert.doesNotMatch(migration, /\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bUPDATE\b/i);
});

test("worker summaries contain aggregate counts and no recipient data", async () => {
  const job = makeJob();
  const summary = await run([job]);
  const serialized = JSON.stringify(summary);

  assert.match(serialized, /"inspected":1/);
  assert.match(serialized, /"sent":1/);
  assert.doesNotMatch(serialized, /person@example\.com|Person|password/i);
});
