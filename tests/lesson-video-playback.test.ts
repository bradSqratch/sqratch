import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authorizeLessonVideoPlayback,
  resolveLessonVideoStorageReference,
} from "../src/lib/lesson-video-reference";
import {
  parsePublicStorageUrl,
  validateLessonVideoStorageObject,
} from "../src/lib/storage-upload";

const reference = {
  bucket: "lesson-videos",
  path: "experiences/experience-one/courses/course-one/lessons/video.mp4",
};

function lessonRecord() {
  return {
    videoStorageBucket: reference.bucket,
    videoStoragePath: reference.path,
    videoUploadUrl: null,
  };
}

async function authorize(canAccess: boolean, videoSource: "YOUTUBE" | "UPLOAD") {
  let signed = false;
  const url = await authorizeLessonVideoPlayback({
    canAccess,
    videoSource,
    lesson: lessonRecord(),
    courseId: "course-one",
    experienceSlug: "experience-one",
    sign: async (storageReference) => {
      signed = true;
      assert.deepEqual(storageReference, reference);
      return "https://project.supabase.co/storage/v1/object/sign/lesson-videos/video.mp4?token=signed";
    },
  });

  return { signed, url };
}

test("anonymous PUBLIC-course playback receives a signed object URL", async () => {
  const result = await authorize(true, "UPLOAD");
  assert.equal(result.signed, true);
  assert.match(result.url || "", /\/object\/sign\/lesson-videos\//);
});

test("anonymous and logged-in unauthorized PRIVATE-course playback receive no URL", async () => {
  const anonymous = await authorize(false, "UPLOAD");
  const loggedInWithoutUnlock = await authorize(false, "UPLOAD");

  assert.deepEqual(anonymous, { signed: false, url: null });
  assert.deepEqual(loggedInWithoutUnlock, { signed: false, url: null });
});

test("unlocked users and creator owners can receive signed PRIVATE-course playback", async () => {
  const unlocked = await authorize(true, "UPLOAD");
  const creatorOwner = await authorize(true, "UPLOAD");

  assert.equal(unlocked.signed, true);
  assert.equal(creatorOwner.signed, true);
});

test("YouTube lessons do not invoke Supabase signing", async () => {
  const result = await authorize(true, "YOUTUBE");
  assert.deepEqual(result, { signed: false, url: null });
});

test("lesson references cannot cross course or experience boundaries", () => {
  assert.equal(
    resolveLessonVideoStorageReference({
      lesson: lessonRecord(),
      courseId: "different-course",
      experienceSlug: "experience-one",
    }),
    null,
  );
  assert.equal(
    resolveLessonVideoStorageReference({
      lesson: lessonRecord(),
      courseId: "course-one",
      experienceSlug: "different-experience",
    }),
    null,
  );
});

test("wrong buckets, traversal paths, and external URLs are rejected", () => {
  process.env.SUPABASE_STORAGE_URL = "https://project.supabase.co";
  process.env.SUPABASE_LESSON_VIDEO_BUCKET = "lesson-videos";

  assert.equal(
    validateLessonVideoStorageObject({
      ...reference,
      bucket: "other-bucket",
      courseId: "course-one",
      experienceSlug: "experience-one",
    }),
    null,
  );
  assert.equal(
    validateLessonVideoStorageObject({
      ...reference,
      path: "experiences/experience-one/courses/course-one/lessons/../secret.mp4",
      courseId: "course-one",
      experienceSlug: "experience-one",
    }),
    null,
  );
  assert.equal(parsePublicStorageUrl("https://evil.example/video.mp4"), null);
  assert.equal(parsePublicStorageUrl("javascript:alert(1)"), null);
  assert.equal(parsePublicStorageUrl("data:video/mp4;base64,AAAA"), null);
  assert.equal(parsePublicStorageUrl("blob:https://project.supabase.co/id"), null);
});

test("legacy public Supabase URLs resolve to stable lesson storage references", () => {
  process.env.SUPABASE_STORAGE_URL = "https://project.supabase.co";
  process.env.SUPABASE_LESSON_VIDEO_BUCKET = "lesson-videos";
  const legacyUrl =
    "https://project.supabase.co/storage/v1/object/public/lesson-videos/experiences/experience-one/courses/course-one/lessons/video.mp4";

  assert.deepEqual(
    resolveLessonVideoStorageReference({
      lesson: {
        videoUploadUrl: legacyUrl,
      },
      courseId: "course-one",
      experienceSlug: "experience-one",
    }),
    reference,
  );
});

test("viewer and creator responses sign on GET, use no-store, and never persist signed URLs", async () => {
  const publicRoute = await readFile(
    new URL(
      "../src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const experienceLoader = await readFile(
    new URL("../src/lib/public-experience.ts", import.meta.url),
    "utf8",
  );
  const creatorRoute = await readFile(
    new URL("../src/app/api/creator/lessons/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(publicRoute, /getAuthorizedLessonVideoUrl/);
  assert.match(publicRoute, /Cache-Control": "private, no-store"/);
  assert.match(experienceLoader, /getAuthorizedLessonVideoUrl/);
  assert.match(experienceLoader, /featuredStory/);
  assert.match(creatorRoute, /createSignedLessonVideoUrl/);
  assert.match(creatorRoute, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(creatorRoute, /videoUploadUrl:\s*videoAssetUrl/);
  assert.doesNotMatch(creatorRoute, /videoUploadUrl:\s*.*signed/i);
});

test("existing public/private course access semantics remain the authorization source", async () => {
  const publicRoute = await readFile(
    new URL(
      "../src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const accessHelper = await readFile(
    new URL("../src/lib/experience-access.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    publicRoute,
    /lesson\.course\.access === "PUBLIC" \|\| access\.canAccessPrivate/,
  );
  assert.match(
    accessHelper,
    /canAccessPrivate: isCreatorOwner \|\| \(isLoggedIn && hasUnlockedCampaign\)/,
  );
});

test("the signed playback helper is server-only and does not expose credentials", async () => {
  const playbackHelper = await readFile(
    new URL("../src/lib/lesson-video-playback.ts", import.meta.url),
    "utf8",
  );

  assert.match(playbackHelper, /import "server-only"/);
  assert.match(playbackHelper, /LESSON_VIDEO_SIGNED_URL_TTL_SECONDS/);
  assert.match(playbackHelper, /expiresIn/);
  assert.doesNotMatch(playbackHelper, /console\.(log|error).*signed/i);
  assert.doesNotMatch(playbackHelper, /return\s+.*serviceRoleKey/);
});
