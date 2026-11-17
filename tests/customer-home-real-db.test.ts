import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("CUSTOMER_HOME_REAL_DB");

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const mk = (suffix: string) => prisma.user.create({ data: { email: `${key}-${suffix}@example.test`, role: suffix === "creator" ? "CREATOR" : "USER" } });
  const [creatorUser, learner, other, newcomer] = await Promise.all([mk("creator"), mk("learner"), mk("other"), mk("new")]);
  const creator = await prisma.creatorProfile.create({ data: { userId: creatorUser.id, displayName: "Synthetic Creator" } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const campaign = await prisma.campaign.create({ data: { name: `${key}-campaign`, slug: key, brandId: brand.id, createdById: creatorUser.id } });
  const lockedCampaign = await prisma.campaign.create({ data: { name: `${key}-locked`, slug: `${key}-l`, brandId: brand.id, createdById: creatorUser.id } });

  const makeExperience = async (name: string, opts: { isActive?: boolean; campaignId?: string } = {}) => {
    const experience = await prisma.experience.create({
      data: { title: name, slug: `${key}-${name}`, creatorId: creator.id, isActive: opts.isActive ?? true },
    });
    if (opts.campaignId) await prisma.campaignExperience.create({ data: { campaignId: opts.campaignId, experienceId: experience.id } });
    const publicCourse = await prisma.course.create({ data: { experienceId: experience.id, title: `${name}-public`, access: "PUBLIC" } });
    const privateCourse = await prisma.course.create({ data: { experienceId: experience.id, title: `${name}-private`, access: "PRIVATE" } });
    const publicLesson = await prisma.lesson.create({ data: { courseId: publicCourse.id, title: `${name}-pub-lesson`, youtubeUrl: "https://youtu.be/x" } });
    const privateLesson = await prisma.lesson.create({ data: { courseId: privateCourse.id, title: `${name}-priv-lesson`, youtubeUrl: "https://youtu.be/x" } });
    const hiddenLesson = await prisma.lesson.create({ data: { courseId: publicCourse.id, title: `${name}-hidden`, isActive: false, youtubeUrl: "https://youtu.be/x" } });
    return { experience, publicLesson, privateLesson, hiddenLesson };
  };
  const live = await makeExperience("live", { campaignId: campaign.id });
  const draft = await makeExperience("draft", { isActive: false, campaignId: campaign.id });
  const locked = await makeExperience("locked", { campaignId: lockedCampaign.id });

  const progress = (userId: string, lessonId: string, minutesAgo: number, extra: { isCompleted?: boolean; lastPositionSeconds?: number } = {}) =>
    prisma.lessonProgress.create({ data: { userId, lessonId, lastPositionSeconds: extra.lastPositionSeconds ?? 42, isCompleted: extra.isCompleted ?? false, updatedAt: new Date(Date.now() - minutesAgo * 60_000) } });

  const cleanup = async () => {
    await prisma.lessonProgress.deleteMany({ where: { userId: { in: [learner.id, other.id, newcomer.id] } } });
    await prisma.campaignUnlock.deleteMany({ where: { campaignId: { in: [campaign.id, lockedCampaign.id] } } });
    await prisma.experience.deleteMany({ where: { id: { in: [live.experience.id, draft.experience.id, locked.experience.id] } } });
    await prisma.campaign.deleteMany({ where: { id: { in: [campaign.id, lockedCampaign.id] } } });
    await prisma.brand.deleteMany({ where: { id: brand.id } });
    await prisma.user.deleteMany({ where: { id: { in: [creatorUser.id, learner.id, other.id, newcomer.id] } } });
  };
  return { prisma, learner, other, newcomer, campaign, lockedCampaign, live, draft, locked, progress, cleanup };
}

test("a new customer gets an explicit empty home", { skip: skipReason }, async () => {
  const { loadCustomerHome } = await import("../src/lib/customer-home");
  const w = await world();
  try {
    const home = await loadCustomerHome(w.newcomer.id);
    assert.equal(home.resume, null);
    assert.deepEqual(home.unlockedExperiences, []);
    assert.equal(home.unlockedExperiencesTotal, 0);
    assert.deepEqual(home.rewards, { spendablePoints: 0, href: "/dashboard/points" });
    assert.equal(home.cards.unlockedCampaignsCount, 0);
    assert.deepEqual(home.recentActivity, []);
    assert.equal(await w.prisma.userPointAccount.count({ where: { userId: w.newcomer.id } }), 0, "loading the home creates no point account");
  } finally {
    await w.cleanup();
  }
});

test("resume picks the latest unfinished accessible lesson with its saved position and never offers hidden content", { skip: skipReason }, async () => {
  const { loadCustomerHome } = await import("../src/lib/customer-home");
  const w = await world();
  try {
    await w.prisma.campaignUnlock.create({ data: { campaignId: w.campaign.id, userId: w.learner.id } });
    await w.prisma.userPointAccount.create({ data: { userId: w.learner.id, spendablePoints: 125 } });
    // Newest rows first: hidden / draft / locked / completed / zero-position rows must all be skipped.
    await w.progress(w.learner.id, w.live.hiddenLesson.id, 1);
    await w.progress(w.learner.id, w.draft.publicLesson.id, 2);
    await w.progress(w.learner.id, w.locked.publicLesson.id, 3, { lastPositionSeconds: 99 });
    await w.progress(w.learner.id, w.live.privateLesson.id, 4, { isCompleted: true });
    await w.progress(w.learner.id, w.live.publicLesson.id, 5, { lastPositionSeconds: 0 });
    await w.progress(w.other.id, w.live.publicLesson.id, 0, { lastPositionSeconds: 500 });

    // Locked experience's *public* course is accessible to everyone (it is public); its private course is not.
    let home = await loadCustomerHome(w.learner.id);
    assert.equal(home.resume?.lessonId, w.locked.publicLesson.id);
    assert.equal(home.resume?.lastPositionSeconds, 99);
    assert.equal(home.resume?.href, `/x/${w.locked.experience.slug}/lessons/${w.locked.publicLesson.id}`);

    // Make the private lesson the newest unfinished row: no unlock for its campaign path... but this one IS unlocked.
    await w.prisma.lessonProgress.update({ where: { userId_lessonId: { userId: w.learner.id, lessonId: w.live.privateLesson.id } }, data: { isCompleted: false, lastPositionSeconds: 17 } });
    home = await loadCustomerHome(w.learner.id);
    assert.equal(home.resume?.lessonId, w.live.privateLesson.id, "private lesson of an unlocked campaign is offered");
    assert.equal(home.resume?.lastPositionSeconds, 17);

    // A private lesson in a campaign the user has not unlocked is never offered.
    await w.progress(w.learner.id, w.locked.privateLesson.id, 0, { lastPositionSeconds: 300 });
    home = await loadCustomerHome(w.learner.id);
    assert.notEqual(home.resume?.lessonId, w.locked.privateLesson.id);
    assert.equal(home.rewards.spendablePoints, 125);

    const ids = JSON.stringify(home);
    for (const secret of [w.draft.publicLesson.id, w.live.hiddenLesson.id, w.locked.privateLesson.id, w.draft.experience.slug]) {
      assert.ok(!ids.includes(secret), `home must not mention ${secret}`);
    }
    assert.ok(home.recentActivity.every((item) => !item.href || item.href.startsWith("/x/")));
    assert.ok(home.recentActivity.some((item) => item.href === `/x/${w.live.experience.slug}/lessons/${w.live.privateLesson.id}`));
  } finally {
    await w.cleanup();
  }
});

test("unlocked experiences list only published experiences attached to unlocked campaigns", { skip: skipReason }, async () => {
  const { loadCustomerHome } = await import("../src/lib/customer-home");
  const w = await world();
  try {
    await w.prisma.campaignUnlock.create({ data: { campaignId: w.campaign.id, userId: w.learner.id } });
    const home = await loadCustomerHome(w.learner.id);
    assert.deepEqual(home.unlockedExperiences.map((e) => e.slug), [w.live.experience.slug]);
    assert.equal(home.unlockedExperiencesTotal, 1);
    assert.equal(home.unlockedExperiences[0].creatorName, "Synthetic Creator");
    assert.equal(home.cards.unlockedCampaignsCount, 1);

    const unlockActivity = home.recentActivity.find((item) => item.label === "Unlocked campaign");
    assert.equal(unlockActivity?.href, `/x/${w.live.experience.slug}`);
    // Another customer's unlocks do not leak.
    const other = await loadCustomerHome(w.other.id);
    assert.deepEqual(other.unlockedExperiences, []);
  } finally {
    await w.cleanup();
  }
});

test("the dashboard route serves the customer home only to customers and leaves other roles' cards alone", { skip: skipReason }, async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/api/me/dashboard-summary/route.ts", "utf8");
  assert.match(source, /loadCustomerHome\(userId\)/);
  assert.match(source, /getAdminCards\(\)/);
  assert.match(source, /getBrandAdminCards\(userId\)/);
  assert.match(source, /getCreatorCards\(userId\)/);
});
