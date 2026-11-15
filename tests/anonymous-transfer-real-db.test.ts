import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("ANONYMOUS_TRANSFER_REAL_DB");

type World = Awaited<ReturnType<typeof buildWorld>>;

/** A synthetic brand, campaign, creator, experience, one rewarded lesson and one NEW QR code. */
async function buildWorld(overrides: { lessonReward?: number; courseReward?: number } = {}) {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const sessionId = randomBytes(24).toString("hex");
  const learner = await prisma.user.create({ data: { email: `${key}-learner@example.test` } });
  const creatorUser = await prisma.user.create({ data: { email: `${key}-creator@example.test`, role: "CREATOR" } });
  const profile = await prisma.creatorProfile.create({ data: { userId: creatorUser.id } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const campaign = await prisma.campaign.create({ data: { name: key, slug: key, brandId: brand.id, createdById: creatorUser.id } });
  const experience = await prisma.experience.create({ data: { title: key, slug: key, creatorId: profile.id } });
  const course = await prisma.course.create({
    data: { experienceId: experience.id, title: key, completionPointsReward: overrides.courseReward ?? 10 },
  });
  const lesson = await prisma.lesson.create({
    data: { courseId: course.id, title: key, completionPointsReward: overrides.lessonReward ?? 5 },
  });
  const qr = await prisma.qRCode.create({ data: { qrCodeData: key, campaignId: campaign.id, createdById: creatorUser.id } });
  await prisma.userSession.create({ data: { id: sessionId, anonKey: sessionId, campaignId: campaign.id } });
  return { prisma, key, sessionId, learner, creatorUser, profile, brand, campaign, experience, course, lesson, qr };
}

async function cleanup(world: World, extraUserIds: string[] = []) {
  const { prisma, campaign, qr, sessionId, learner, creatorUser, profile, experience, brand } = world;
  const userIds = [learner.id, creatorUser.id, ...extraUserIds];
  await prisma.pointTransaction.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.campaignUnlock.deleteMany({ where: { campaignId: campaign.id } });
  await prisma.lessonProgress.deleteMany({ where: { OR: [{ sessionId }, { userId: { in: userIds } }] } });
  await prisma.userSession.deleteMany({ where: { id: sessionId } });
  await prisma.qRCode.deleteMany({ where: { id: qr.id } });
  await prisma.campaign.delete({ where: { id: campaign.id } });
  await prisma.experience.delete({ where: { id: experience.id } });
  await prisma.creatorProfile.delete({ where: { id: profile.id } });
  await prisma.brand.delete({ where: { id: brand.id } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seedAnonymous(world: World, opts: { completed?: boolean; position?: number } = {}) {
  const { prisma, sessionId, lesson, campaign, qr } = world;
  await prisma.lessonProgress.create({
    data: { sessionId, lessonId: lesson.id, isCompleted: opts.completed ?? true, lastPositionSeconds: opts.position ?? 90 },
  });
  return prisma.campaignUnlock.create({ data: { campaignId: campaign.id, qrCodeId: qr.id, anonKey: sessionId } });
}

async function ledger(world: World) {
  const { prisma, learner } = world;
  const rows = await prisma.pointTransaction.findMany({ where: { userId: learner.id }, select: { idempotencyKey: true, points: true, reason: true } });
  const account = await prisma.userPointAccount.findUnique({ where: { userId: learner.id } });
  return { rows, keys: rows.map((row) => row.idempotencyKey).sort(), spendable: account?.spendablePoints ?? 0 };
}

test("two concurrent transfers move everything once and award once", { skip: skipReason }, async () => {
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const world = await buildWorld();
  const { prisma, learner, sessionId, lesson, course, qr, campaign } = world;
  try {
    await seedAnonymous(world);
    const call = () => transferAnonymousState({ userId: learner.id, userEmail: learner.email, sessionId });
    const results = await Promise.all(Array.from({ length: 6 }, call));
    for (const result of results) assert.equal(result.status, "complete");
    assert.equal(results.reduce((sum, r) => sum + r.mergedLessons, 0), 1);
    assert.equal(results.reduce((sum, r) => sum + r.mergedUnlocks, 0), 1);

    assert.equal(await prisma.lessonProgress.count({ where: { sessionId } }), 0);
    const progress = await prisma.lessonProgress.findMany({ where: { userId: learner.id, lessonId: lesson.id } });
    assert.equal(progress.length, 1);
    assert.equal(progress[0].isCompleted, true);
    assert.equal(progress[0].lastPositionSeconds, 90);

    const unlocks = await prisma.campaignUnlock.findMany({ where: { campaignId: campaign.id } });
    assert.equal(unlocks.length, 1);
    assert.equal(unlocks[0].userId, learner.id);
    const code = await prisma.qRCode.findUniqueOrThrow({ where: { id: qr.id } });
    assert.equal(code.status, "USED");
    assert.equal(code.redeemedById, learner.id);

    const { keys, spendable } = await ledger(world);
    assert.deepEqual(keys, [`course-completion:${course.id}`, `lesson-completion:${lesson.id}`, `qr-scan:${qr.id}`].sort());
    assert.equal(spendable, 1 + 5 + 10);

    // A third call is a no-op.
    const again = await call();
    assert.deepEqual(again, { status: "complete", mergedLessons: 0, mergedUnlocks: 0, pointsAwarded: 0 });
    assert.equal((await ledger(world)).rows.length, 3);
  } finally {
    await cleanup(world);
  }
});

test("a failed award rolls back that unlock, keeps the anonymous row, and the next call completes", { skip: skipReason }, async () => {
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const world = await buildWorld({ lessonReward: 0, courseReward: 0 });
  const { prisma, learner, sessionId, qr, campaign } = world;
  const fn = `fail_qr_${world.key.replace(/-/g, "")}`;
  try {
    const anonUnlock = await seedAnonymous(world, { completed: false });
    // Disposable database only: make this learner's ledger insert fail like a transient outage. Scoped to the learner's id because real-database test files run concurrently and must not see each other's fault.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW."userId" = '${learner.id}' THEN RAISE EXCEPTION 'forced ledger failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "PointTransaction" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    let failed;
    try {
      failed = await transferAnonymousState({ userId: learner.id, userEmail: learner.email, sessionId });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "PointTransaction"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    assert.equal(failed.status, "retry_required");
    const stillAnonymous = await prisma.campaignUnlock.findUniqueOrThrow({ where: { id: anonUnlock.id } });
    assert.equal(stillAnonymous.userId, null);
    assert.equal((await prisma.qRCode.findUniqueOrThrow({ where: { id: qr.id } })).status, "NEW");
    assert.equal((await ledger(world)).rows.length, 0);

    const retried = await transferAnonymousState({ userId: learner.id, userEmail: learner.email, sessionId });
    assert.equal(retried.status, "complete");
    assert.equal(retried.mergedUnlocks, 1);
    const unlock = await prisma.campaignUnlock.findMany({ where: { campaignId: campaign.id } });
    assert.equal(unlock.length, 1);
    assert.equal(unlock[0].userId, learner.id);
    assert.deepEqual((await ledger(world)).keys, [`qr-scan:${qr.id}`]);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "PointTransaction"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    await cleanup(world);
  }
});

test("a historical ledger row without an idempotency key does not wedge the transfer", { skip: skipReason }, async () => {
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const world = await buildWorld({ lessonReward: 0, courseReward: 0 });
  const { prisma, learner, sessionId, qr } = world;
  try {
    await seedAnonymous(world, { completed: false });
    await prisma.pointTransaction.create({ data: { userId: learner.id, points: 1, reason: "QR_SCAN", qrCodeId: qr.id } });
    const result = await transferAnonymousState({ userId: learner.id, userEmail: learner.email, sessionId });
    assert.equal(result.status, "complete");
    assert.equal(result.mergedUnlocks, 1);
    assert.equal(result.pointsAwarded, 0);
    assert.equal(await prisma.pointTransaction.count({ where: { userId: learner.id } }), 1);
  } finally {
    await cleanup(world);
  }
});

test("progress written after a transfer stays put and moves on the next call; raise-only writes never lower a row", { skip: skipReason }, async () => {
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const { raiseLessonProgress } = await import("../src/lib/lesson-progress");
  const world = await buildWorld({ lessonReward: 0, courseReward: 0 });
  const { prisma, learner, sessionId, lesson } = world;
  try {
    await prisma.lessonProgress.create({ data: { sessionId, lessonId: lesson.id, lastPositionSeconds: 40, isCompleted: false } });
    await transferAnonymousState({ userId: learner.id, sessionId });
    // The anonymous tab keeps saving after the transfer: this row must survive until a later call moves it.
    await prisma.lessonProgress.create({ data: { sessionId, lessonId: lesson.id, lastPositionSeconds: 70, isCompleted: true } });
    assert.equal(await prisma.lessonProgress.count({ where: { sessionId } }), 1);
    await transferAnonymousState({ userId: learner.id, sessionId });
    assert.equal(await prisma.lessonProgress.count({ where: { sessionId } }), 0);
    const merged = await prisma.lessonProgress.findFirstOrThrow({ where: { userId: learner.id, lessonId: lesson.id } });
    assert.equal(merged.lastPositionSeconds, 70);
    assert.equal(merged.isCompleted, true);

    // Concurrent writers, one completes, others report lower positions and not-completed.
    const writers = Array.from({ length: 24 }, (_, i) =>
      raiseLessonProgress(prisma, { userId: learner.id }, { lessonId: lesson.id, lastPositionSeconds: i * 4, isCompleted: false }),
    );
    writers.push(raiseLessonProgress(prisma, { userId: learner.id }, { lessonId: lesson.id, lastPositionSeconds: 500, isCompleted: true }));
    writers.push(transferAnonymousState({ userId: learner.id, sessionId }) as never);
    await Promise.all(writers);
    const final = await prisma.lessonProgress.findFirstOrThrow({ where: { userId: learner.id, lessonId: lesson.id } });
    assert.equal(final.lastPositionSeconds, 500);
    assert.equal(final.isCompleted, true);
    assert.equal(await prisma.lessonProgress.count({ where: { userId: learner.id, lessonId: lesson.id } }), 1);
  } finally {
    await cleanup(world);
  }
});

test("owner, inactive content and unpublished experiences earn nothing; a normal learner is paid once", { skip: skipReason }, async () => {
  const { transferAnonymousState, settleOutstandingCompletionAwards } = await import("../src/lib/anonymous-transfer");
  const world = await buildWorld();
  const { prisma, learner, creatorUser, lesson, course, experience } = world;
  try {
    // Owner completing their own lesson.
    await prisma.lessonProgress.create({ data: { userId: creatorUser.id, lessonId: lesson.id, isCompleted: true } });
    const owner = await transferAnonymousState({ userId: creatorUser.id });
    assert.equal(owner.pointsAwarded, 0);
    assert.equal(await prisma.pointTransaction.count({ where: { userId: creatorUser.id } }), 0);

    // Learner completion on a draft experience, inactive course, then inactive lesson.
    await prisma.lessonProgress.create({ data: { userId: learner.id, lessonId: lesson.id, isCompleted: true } });
    await prisma.experience.update({ where: { id: experience.id }, data: { isActive: false } });
    assert.equal(await settleOutstandingCompletionAwards(learner.id), 0);
    await prisma.experience.update({ where: { id: experience.id }, data: { isActive: true } });
    await prisma.course.update({ where: { id: course.id }, data: { isActive: false } });
    assert.equal(await settleOutstandingCompletionAwards(learner.id), 0);
    await prisma.course.update({ where: { id: course.id }, data: { isActive: true } });
    await prisma.lesson.update({ where: { id: lesson.id }, data: { isActive: false } });
    assert.equal(await settleOutstandingCompletionAwards(learner.id), 0);
    assert.equal(await prisma.pointTransaction.count({ where: { userId: learner.id } }), 0);

    // Everything visible again: sign-in heals the earlier unpaid completion exactly once, with no browser session at all.
    await prisma.lesson.update({ where: { id: lesson.id }, data: { isActive: true } });
    const healed = await transferAnonymousState({ userId: learner.id });
    assert.equal(healed.status, "complete");
    assert.equal(healed.pointsAwarded, 2);
    const repeat = await transferAnonymousState({ userId: learner.id });
    assert.equal(repeat.pointsAwarded, 0);
    const { keys, spendable } = await ledger(world);
    assert.deepEqual(keys, [`course-completion:${course.id}`, `lesson-completion:${lesson.id}`].sort());
    assert.equal(spendable, 15);
  } finally {
    await cleanup(world);
  }
});

test("a QR already redeemed by someone else drops the anonymous unlock without awarding; an existing unlock absorbs a new code", { skip: skipReason }, async () => {
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const world = await buildWorld({ lessonReward: 0, courseReward: 0 });
  const { prisma, learner, creatorUser, sessionId, qr, campaign } = world;
  const other = await prisma.user.create({ data: { email: `${world.key}-other@example.test` } });
  const second = await prisma.qRCode.create({ data: { qrCodeData: `${world.key}-b`, campaignId: campaign.id, createdById: creatorUser.id } });
  try {
    // Redeemed by another account first.
    await prisma.qRCode.update({ where: { id: qr.id }, data: { status: "USED", redeemedById: other.id } });
    await prisma.campaignUnlock.create({ data: { campaignId: campaign.id, qrCodeId: qr.id, anonKey: sessionId } });
    const dropped = await transferAnonymousState({ userId: learner.id, sessionId });
    assert.equal(dropped.status, "complete");
    assert.equal(dropped.mergedUnlocks, 0);
    assert.equal(dropped.pointsAwarded, 0);
    assert.equal(await prisma.campaignUnlock.count({ where: { campaignId: campaign.id } }), 0);
    assert.equal((await prisma.qRCode.findUniqueOrThrow({ where: { id: qr.id } })).redeemedById, other.id);

    // The account already holds an unlock for this campaign; a fresh anonymous code is redeemed and the anonymous row absorbed.
    const kept = await prisma.campaignUnlock.create({ data: { campaignId: campaign.id, userId: learner.id } });
    await prisma.campaignUnlock.create({ data: { campaignId: campaign.id, qrCodeId: second.id, anonKey: sessionId } });
    const absorbed = await transferAnonymousState({ userId: learner.id, sessionId });
    assert.equal(absorbed.status, "complete");
    assert.equal(absorbed.pointsAwarded, 1);
    const unlocks = await prisma.campaignUnlock.findMany({ where: { campaignId: campaign.id } });
    assert.deepEqual(unlocks.map((u) => u.id), [kept.id]);
    assert.equal((await prisma.qRCode.findUniqueOrThrow({ where: { id: second.id } })).redeemedById, learner.id);
  } finally {
    await prisma.pointTransaction.deleteMany({ where: { userId: { in: [learner.id, other.id] } } });
    await prisma.qRCode.deleteMany({ where: { id: second.id } });
    await cleanup(world, [other.id]);
  }
});

test("only the caller's own cookie keys are transferred: another session's rows are untouched", { skip: skipReason }, async () => {
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const world = await buildWorld({ lessonReward: 0, courseReward: 0 });
  const { prisma, learner, sessionId, campaign, lesson } = world;
  const victimSession = randomBytes(24).toString("hex");
  try {
    await prisma.userSession.create({ data: { id: victimSession, anonKey: victimSession } });
    await prisma.lessonProgress.create({ data: { sessionId: victimSession, lessonId: lesson.id, isCompleted: true } });
    await prisma.campaignUnlock.create({ data: { campaignId: campaign.id, anonKey: victimSession } });
    // The service accepts only valid session identifiers and only the ones its caller supplies.
    await transferAnonymousState({ userId: learner.id, sessionId, unlockKeys: ["not-a-valid-session-key", "' OR 1=1 --"] });
    assert.equal(await prisma.lessonProgress.count({ where: { sessionId: victimSession } }), 1);
    const victimUnlock = await prisma.campaignUnlock.findFirstOrThrow({ where: { anonKey: victimSession } });
    assert.equal(victimUnlock.userId, null);
  } finally {
    await prisma.lessonProgress.deleteMany({ where: { sessionId: victimSession } });
    await prisma.campaignUnlock.deleteMany({ where: { anonKey: victimSession } });
    await prisma.userSession.deleteMany({ where: { id: victimSession } });
    await cleanup(world);
  }
});
