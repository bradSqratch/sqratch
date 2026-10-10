/**
 * Commerce7 reward transactions under Postgres contention: bounded, jittered whole-transaction retries for
 * serialization conflicts, a distinct retryable REWARD_BUSY outcome (HTTP 503), and no new retry for anything else.
 * The real-Postgres burst (30 claimants, 25 slots) lives in commerce7-rewards-real-db.test.ts.
 */
import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { rewardTransaction, rewardRetryDelayMs, REWARD_BUSY_MESSAGE, REWARD_TRANSACTION_ATTEMPTS } from "../src/lib/commerce7-rewards";
import { RewardClaimError } from "../src/lib/commerce7-reward-domain";
import { rewardErrorResponse } from "../src/lib/commerce7-reward-http";

const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: "test" });

/** A fake client whose `$transaction` fails per a script, recording each attempt, its fresh tx, and whether it is open. */
function scriptedDb(script: (Error | "ok")[]) {
  const log = { attempts: 0, txs: [] as object[], sleeps: [] as number[], sleptWhileOpen: false, open: false, options: [] as unknown[] };
  const db = {
    async $transaction(work: (tx: object) => Promise<unknown>, options: unknown) {
      const step = script[Math.min(log.attempts, script.length - 1)]; log.attempts++; log.options.push(options);
      const tx = { attempt: log.attempts }; log.txs.push(tx);
      log.open = true;
      try { const value = await work(tx); if (step !== "ok") throw step; return value; }
      finally { log.open = false; }
    },
  };
  const timing = { sleep: async (ms: number) => { if (log.open) log.sleptWhileOpen = true; log.sleeps.push(ms); }, random: () => 1 };
  return { db: db as never, log, timing };
}

test("backoff is exponential, jittered within [cap/2, cap], and capped at 250 ms", () => {
  assert.deepEqual([0, 1, 2, 3].map((retry) => rewardRetryDelayMs(retry, () => 0)), [10, 20, 40, 80]);
  assert.deepEqual([0, 1, 2, 3].map((retry) => rewardRetryDelayMs(retry, () => 1)), [20, 40, 80, 160]);
  assert.equal(rewardRetryDelayMs(20, () => 1), 250); assert.equal(rewardRetryDelayMs(20, () => 0), 125);
});

test("a serialization conflict re-runs the WHOLE transaction after a backoff taken outside it, then succeeds", async () => {
  const { db, log, timing } = scriptedDb([prismaError("P2034"), prismaError("P2034"), "ok"]);
  let runs = 0;
  assert.equal(await rewardTransaction(db, async () => { runs++; return "reserved"; }, timing), "reserved");
  assert.equal(log.attempts, 3); assert.equal(runs, 3, "work runs from the start on every attempt");
  assert.equal(new Set(log.txs).size, 3, "each attempt gets a fresh transaction; nothing partial is carried over");
  assert.deepEqual(log.sleeps, [20, 40]); assert.equal(log.sleptWhileOpen, false, "never sleeps while a transaction is open");
  for (const options of log.options) assert.deepEqual(options, { isolationLevel: "Serializable", timeout: 10000 });
});

/** The pg driver adapter's error for 40001/40P01 when the conflict surfaces at COMMIT (same shape as Prisma's class). */
function adapterError(kind: string) {
  const error = new Error(kind) as Error & { cause: { kind: string } }; error.name = "DriverAdapterError"; error.cause = { kind }; return error;
}

test("a commit-time conflict reported by the pg driver adapter is the same transient contention; other adapter errors are not", async () => {
  const commit = scriptedDb([adapterError("TransactionWriteConflict"), "ok"]);
  assert.equal(await rewardTransaction(commit.db, async () => "reserved", commit.timing), "reserved");
  assert.equal(commit.log.attempts, 2); assert.deepEqual(commit.log.sleeps, [20]);
  const exhausted = scriptedDb([adapterError("TransactionWriteConflict")]);
  await assert.rejects(rewardTransaction(exhausted.db, async () => "never", exhausted.timing), { code: "REWARD_BUSY", status: 503 });
  assert.equal(exhausted.log.attempts, REWARD_TRANSACTION_ATTEMPTS);
  for (const kind of ["UniqueConstraintViolation", "TransactionAlreadyClosed", "SocketTimeout"]) {
    const other = scriptedDb([adapterError(kind)]);
    await assert.rejects(rewardTransaction(other.db, async () => "never", other.timing), (error: Error) => error.name === "DriverAdapterError");
    assert.equal(other.log.attempts, 1, kind);
  }
});

test("exhausted contention becomes REWARD_BUSY (503) after a bounded number of attempts and a bounded total wait", async () => {
  const { db, log, timing } = scriptedDb([prismaError("P2034")]);
  await assert.rejects(rewardTransaction(db, async () => "never", timing), (error: unknown) => {
    assert.ok(error instanceof RewardClaimError); assert.equal(error.code, "REWARD_BUSY"); assert.equal(error.status, 503); assert.equal(error.message, REWARD_BUSY_MESSAGE);
    assert.doesNotMatch(error.message, /P2034|Prisma|serializ|transaction/i);
    return true;
  });
  assert.equal(log.attempts, REWARD_TRANSACTION_ATTEMPTS); assert.equal(REWARD_TRANSACTION_ATTEMPTS, 5);
  assert.equal(log.sleeps.length, REWARD_TRANSACTION_ATTEMPTS - 1, "no sleep after the final attempt");
  assert.ok(log.sleeps.reduce((sum, ms) => sum + ms, 0) <= 300, "worst-case waiting stays well inside the request limit");
});

test("a unique violation (same idempotency key committed first) is retried immediately and is never reported as busy", async () => {
  const converges = scriptedDb([prismaError("P2002"), "ok"]);
  assert.equal(await rewardTransaction(converges.db, async () => "existing claim", converges.timing), "existing claim");
  assert.equal(converges.log.attempts, 2); assert.deepEqual(converges.log.sleeps, []);
  const persistent = scriptedDb([prismaError("P2002")]);
  await assert.rejects(rewardTransaction(persistent.db, async () => "never", persistent.timing), (error: unknown) => {
    assert.ok(error instanceof Prisma.PrismaClientKnownRequestError); assert.equal(error.code, "P2002"); return true;
  });
  assert.equal(persistent.log.attempts, REWARD_TRANSACTION_ATTEMPTS); assert.deepEqual(persistent.log.sleeps, []);
});

test("domain refusals, transaction timeouts and unexpected errors are never retried", async () => {
  for (const failure of [new RewardClaimError("SOLD_OUT", "Sold out."), new RewardClaimError("INSUFFICIENT_POINTS", "No points."), prismaError("P2028"), new Error("boom")]) {
    const { db, log, timing } = scriptedDb([failure]);
    await assert.rejects(rewardTransaction(db, async () => "never", timing), (error: unknown) => error === failure);
    assert.equal(log.attempts, 1, String(failure)); assert.deepEqual(log.sleeps, []);
  }
});

test("a domain refusal raised by the work itself is final even mid-contention", async () => {
  const { db, log, timing } = scriptedDb([prismaError("P2034"), "ok"]);
  let runs = 0;
  await assert.rejects(rewardTransaction(db, async () => { runs++; if (runs === 2) throw new RewardClaimError("SOLD_OUT", "Sold out."); return "never"; }, timing), { code: "SOLD_OUT" });
  assert.equal(log.attempts, 2); assert.deepEqual(log.sleeps, [20]);
});

test("REWARD_BUSY is a labelled, retryable 503 with Retry-After; other failures keep their statuses and leak nothing", async () => {
  const busy = rewardErrorResponse(new RewardClaimError("REWARD_BUSY", REWARD_BUSY_MESSAGE, 503));
  assert.equal(busy.status, 503); assert.equal(busy.headers.get("Retry-After"), "1");
  assert.deepEqual(await busy.json(), { error: "The reward is busy. Please try again.", code: "REWARD_BUSY" });
  const soldOut = rewardErrorResponse(new RewardClaimError("SOLD_OUT", "This reward is sold out."));
  assert.equal(soldOut.status, 409); assert.equal(soldOut.headers.get("Retry-After"), null);
  // A raw database error that somehow escaped stays a generic 500, without Prisma internals or a retry hint.
  const raw = rewardErrorResponse(prismaError("P2034"));
  assert.equal(raw.status, 500); assert.equal(raw.headers.get("Retry-After"), null);
  const body = JSON.stringify(await raw.json()); assert.match(body, /REWARD_PROCESSING_FAILED/); assert.doesNotMatch(body, /P2034|simulated|Prisma/);
});
