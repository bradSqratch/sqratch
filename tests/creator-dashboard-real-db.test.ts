import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("CREATOR_DASHBOARD_REAL_DB");

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const make = async (label: string) => {
    const user = await prisma.user.create({ data: { email: `${key}-${label}@example.test`, role: "CREATOR" } });
    const profile = await prisma.creatorProfile.create({ data: { userId: user.id } });
    return { user, profile };
  };
  const creator = await make("creator");
  const stranger = await make("stranger");
  const experiences = await Promise.all(
    ["Alpha", "Bravo", "Charlie"].map((title) =>
      prisma.experience.create({ data: { title: `${title} ${key}`, slug: `${title.toLowerCase()}-${key}`, creatorId: creator.profile.id } }),
    ),
  );
  const foreign = await prisma.experience.create({ data: { title: `Foreign ${key}`, slug: `foreign-${key}`, creatorId: stranger.profile.id } });
  const asker = await prisma.user.create({ data: { email: `${key}-asker@example.test`, name: "Asker" } });
  await prisma.question.create({ data: { experienceId: experiences[0].id, askedById: asker.id, body: "About alpha?" } });
  await prisma.question.create({ data: { experienceId: experiences[1].id, askedById: asker.id, body: "About bravo?" } });
  await prisma.question.create({ data: { experienceId: foreign.id, askedById: asker.id, body: "About foreign?" } });
  return { prisma, key, creator, stranger, experiences, foreign, asker };
}

async function cleanup(w: Awaited<ReturnType<typeof world>>) {
  const { prisma } = w;
  const userIds = [w.creator.user.id, w.stranger.user.id, w.asker.id];
  await prisma.question.deleteMany({ where: { askedById: w.asker.id } });
  await prisma.experience.deleteMany({ where: { id: { in: [...w.experiences.map((e) => e.id), w.foreign.id] } } });
  await prisma.creatorProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test("analytics and Q&A selectors list every owned experience however results are filtered", { skip: skipReason }, async () => {
  const { creatorAnalyticsGetImpl } = await import("../src/app/api/creator/analytics/route");
  const { questionsGetImpl } = await import("../src/app/api/questions/route");
  const w = await world();
  const ownedIds = w.experiences.map((e) => e.id).sort();
  const asCreator = async () => ({ userId: w.creator.user.id, creatorProfile: { id: w.creator.profile.id, userId: w.creator.user.id, displayName: null } });
  const viewer = async () => ({ session: null, userId: w.creator.user.id, sessionId: null }) as never;
  const analytics = async (query: string) => {
    const response = await creatorAnalyticsGetImpl(new NextRequest(`http://localhost/api/creator/analytics${query}`), asCreator);
    assert.equal(response.status, 200);
    return (await response.json()).data as { experiences: Array<{ id: string }>; options: { experiences: Array<{ id: string }> }; byExperience: Array<{ id: string }> };
  };
  const inbox = async (query: string) => {
    const response = await questionsGetImpl(new NextRequest(`http://localhost/api/questions?creatorInbox=1${query}`), viewer);
    assert.equal(response.status, 200);
    return (await response.json()).data as { experiences: Array<{ id: string }>; options: { experiences: Array<{ id: string }> }; questions: Array<{ body: string }> };
  };
  try {
    // Unfiltered: options and results agree.
    let a = await analytics("");
    assert.deepEqual(a.options.experiences.map((e) => e.id).sort(), ownedIds);
    assert.equal(a.byExperience.length, 3);

    // Filtered: results narrow, options do not.
    a = await analytics(`?experienceId=${w.experiences[1].id}`);
    assert.deepEqual(a.experiences.map((e) => e.id), [w.experiences[1].id]);
    assert.equal(a.byExperience.length, 1);
    assert.deepEqual(a.options.experiences.map((e) => e.id).sort(), ownedIds);

    let q = await inbox("");
    assert.deepEqual(q.options.experiences.map((e) => e.id).sort(), ownedIds);
    assert.deepEqual(q.questions.map((x) => x.body).sort(), ["About alpha?", "About bravo?"]);
    q = await inbox(`&experienceId=${w.experiences[1].id}`);
    assert.deepEqual(q.questions.map((x) => x.body), ["About bravo?"]);
    assert.deepEqual(q.experiences.map((e) => e.id), [w.experiences[1].id]);
    assert.deepEqual(q.options.experiences.map((e) => e.id).sort(), ownedIds);

    // Another creator's experience id yields nothing and never leaks into the options.
    a = await analytics(`?experienceId=${w.foreign.id}`);
    assert.equal(a.byExperience.length, 0);
    assert.deepEqual(a.options.experiences.map((e) => e.id).sort(), ownedIds);
    q = await inbox(`&experienceId=${w.foreign.id}`);
    assert.deepEqual(q.questions, []);
    assert.deepEqual(q.options.experiences.map((e) => e.id).sort(), ownedIds);
    assert.ok(!JSON.stringify(q).includes("About foreign?"));

    // Authorization is unchanged: no creator context and no viewer are refused.
    assert.equal((await creatorAnalyticsGetImpl(new NextRequest("http://localhost/api/creator/analytics"), async () => null)).status, 403);
    assert.equal((await questionsGetImpl(new NextRequest("http://localhost/api/questions?creatorInbox=1"), (async () => ({ session: null, userId: null, sessionId: null })) as never)).status, 401);
  } finally {
    await cleanup(w);
  }
});

test("creator engagement uses strict UTC days, a 30-day default, and rejects invalid ranges", { skip: skipReason }, async () => {
  const { creatorAnalyticsGetImpl } = await import("../src/app/api/creator/analytics/route");
  const w = await world();
  const experience = w.experiences[0];
  const asCreator = async () => ({ userId: w.creator.user.id, creatorProfile: { id: w.creator.profile.id, userId: w.creator.user.id, displayName: null } });
  const dayOffset = (days: number) => new Date(Date.now() - days * 86_400_000);
  const ymd = (date: Date) => date.toISOString().slice(0, 10);
  const at = (day: Date, hhmm: string) => new Date(`${ymd(day)}T${hhmm}:00.000Z`);
  const view = (createdAt: Date) => w.prisma.analyticsEvent.create({ data: { name: "experience_view", experienceId: experience.id, createdAt } });
  const get = async (query: string) => creatorAnalyticsGetImpl(new NextRequest(`http://localhost/api/creator/analytics${query}`), asCreator);
  const views = async (query: string) => {
    const response = await get(query);
    assert.equal(response.status, 200);
    const body = (await response.json()).data as { totals: { views: number }; range: { start: string; end: string } };
    return body;
  };
  try {
    await view(dayOffset(5));
    await view(dayOffset(40));
    const boundaryDay = dayOffset(10);
    await view(at(boundaryDay, "23:30"));
    await view(new Date(at(boundaryDay, "00:00").getTime() + 86_400_000 + 30 * 60_000)); // 00:30 UTC the next day

    // No dates: the last 30 UTC days, never all-time. 5 days ago and the boundary-day evening count; 40 days ago does not.
    let result = await views("");
    assert.equal(result.totals.views, 3);
    assert.equal(ymd(new Date(result.range.start)), ymd(dayOffset(29)));
    assert.equal(ymd(new Date(result.range.end)), ymd(new Date()));

    // A single UTC day includes its last minute and excludes the next day's first, whatever the server timezone.
    result = await views(`?dateFrom=${ymd(boundaryDay)}&dateTo=${ymd(boundaryDay)}`);
    assert.equal(result.totals.views, 1);

    // An explicit longer range reaches the older event.
    result = await views(`?dateFrom=${ymd(dayOffset(60))}`);
    assert.equal(result.totals.views, 4);

    // Invalid input is a 400 with a reason, not a 500 or a silently different period.
    for (const query of ["?dateFrom=not-a-date", "?dateTo=2026-02-30", `?dateFrom=${ymd(dayOffset(1))}&dateTo=${ymd(dayOffset(3))}`, `?dateFrom=${ymd(dayOffset(500))}&dateTo=${ymd(new Date())}`]) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.ok(typeof (await response.json()).error === "string");
    }
  } finally {
    await w.prisma.analyticsEvent.deleteMany({ where: { experienceId: { in: w.experiences.map((e) => e.id) } } });
    await cleanup(w);
  }
});
