import assert from "node:assert/strict";
import { test } from "node:test";
import { realDbTest } from "./helpers/real-db";

const gate = realDbTest("LESSON_INTEGRITY_REAL_DB");
test("concurrent uploaded lesson retries create one lesson", { skip: gate.skipReason }, async () => {
  const { default: db } = await import("../src/lib/prisma");
  const { createLessonOnce } = await import("../src/lib/lesson-create");
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const user = await db.user.create({ data: { email: `lesson-create-${unique}@example.test` } });
  try {
    const creator = await db.creatorProfile.create({ data: { userId: user.id } });
    const experience = await db.experience.create({ data: { creatorId: creator.id, title: "Fixture", slug: `lesson-fixture-${unique}` } });
    const course = await db.course.create({ data: { experienceId: experience.id, title: "Fixture" } });
    const input = { courseId: course.id, title: "Lesson", videoSource: "UPLOAD" as const, videoStorageBucket: "lesson-videos", videoStoragePath: `fixture/${unique}.mp4` };
    const results = await Promise.all([createLessonOnce(input), createLessonOnce(input)]);
    assert.deepEqual(results.map((r) => r.created).sort(), [false, true]);
    assert.equal(results[0].lesson.id, results[1].lesson.id);
    assert.equal(await db.lesson.count({ where: { courseId: course.id, videoStoragePath: input.videoStoragePath } }), 1);
  } finally {
    await db.user.delete({ where: { id: user.id } });
  }
});
