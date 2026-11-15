import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { raiseLessonProgress } from "../src/lib/lesson-progress";

const read = (path: string) => readFileSync(path, "utf8");

test("verification and sign-in transfer through the one shared service", () => {
  const verify = read("src/app/api/auth/verify-email/route.ts");
  const merge = read("src/app/api/progress/merge/route.ts");
  for (const source of [verify, merge]) {
    assert.match(source, /transferAnonymousState\(/);
    assert.doesNotMatch(source, /awardQrScanPoint|awardLessonCompletionPoints|awardCourseCompletionPoints|redeemQrCodeForUser/);
    assert.doesNotMatch(source, /lessonProgress\.deleteMany|campaignUnlock\.(update|delete)/);
  }
});

test("a request body can never nominate an anonymous session", () => {
  const verify = read("src/app/api/auth/verify-email/route.ts");
  assert.doesNotMatch(verify, /anonKey\s*:\s*bodyAnonKey|bodyAnonKey/);
  assert.match(verify, /const \{ email, code \}/);
  const keys = read("src/lib/anon-merge-keys.ts");
  assert.doesNotMatch(keys, /bodyAnonKey/);
});

test("a consumed code never turns a verified account into an error", () => {
  const verify = read("src/app/api/auth/verify-email/route.ts");
  const afterVerified = verify.slice(verify.indexOf('outcome !== "verified"'));
  // The transfer sits in its own try/catch and the success response always carries ok: true and its status.
  assert.match(afterVerified, /try \{\s*transfer = await transferAnonymousState\(/);
  assert.match(afterVerified, /ok: true,[\s\S]*transfer,/);
});

test("the service never swallows a ledger failure inside a transaction and keeps ledger keys", () => {
  const service = read("src/lib/anonymous-transfer.ts");
  assert.doesNotMatch(service, /idempotencyKey:\s*`(?!lesson-completion:|course-completion:)/);
  const unlockBody = service.slice(service.indexOf("async function moveUnlock"), service.indexOf("async function awardQrPointOnce"));
  assert.doesNotMatch(unlockBody, /\bcatch\b/);
  assert.match(unlockBody, /FOR UPDATE/);
  const lessonBody = service.slice(service.indexOf("async function moveLessonProgressRow"), service.indexOf("async function moveUnlock"));
  assert.match(lessonBody, /FOR UPDATE/);
  assert.doesNotMatch(service, /lessonProgress\.deleteMany/);
});

test("lesson progress writes are raise-only", () => {
  const helper = read("src/lib/lesson-progress.ts");
  assert.match(helper, /lastPositionSeconds: \{ lt: position \}/);
  assert.match(helper, /isCompleted: false \}/);
  // The only write that touches isCompleted sets it to true; nothing ever writes false over an existing row.
  assert.doesNotMatch(helper, /data:\s*\{[^}]*isCompleted:\s*false/);
  assert.doesNotMatch(helper, /lastPositionSeconds:\s*\{\s*(decrement|set)/);
  const route = read("src/app/api/progress/lesson/route.ts");
  assert.match(route, /raiseLessonProgress\(/);
  assert.doesNotMatch(route, /existing\.isCompleted \|\| isCompleted/);
});

const progressRow = { lessonId: "l", lastPositionSeconds: 10, isCompleted: true, updatedAt: new Date() };
function fakeProgressDb(findResults: Array<typeof progressRow | null>) {
  const calls = { createMany: 0 };
  const db = {
    lessonProgress: {
      createMany: async () => { calls.createMany++; return { count: 0 }; },
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => findResults.shift() ?? null,
    },
  };
  return { calls, db: db as unknown as Parameters<typeof raiseLessonProgress>[0] };
}

test("an anonymous save whose row was claimed by a sign-in mid-write is recreated, not reported as saved", async () => {
  const { calls, db } = fakeProgressDb([null, progressRow]);
  const saved = await raiseLessonProgress(db, { sessionId: "s" }, { lessonId: "l", lastPositionSeconds: 10, isCompleted: true });
  assert.equal(saved.isCompleted, true);
  assert.equal(calls.createMany, 2, "the row is recreated once so the next transfer moves it");
});

test("a save that cannot be stored is an error rather than a false success", async () => {
  await assert.rejects(raiseLessonProgress(fakeProgressDb([null, null]).db, { sessionId: "s" }, { lessonId: "l", lastPositionSeconds: 1, isCompleted: false }));
  await assert.rejects(raiseLessonProgress(fakeProgressDb([null]).db, { userId: "u" }, { lessonId: "l", lastPositionSeconds: 1, isCompleted: false }));
});
