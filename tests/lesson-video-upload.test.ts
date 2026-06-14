import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { createLessonVideoUploadHandler } from "../src/lib/lesson-video-upload-handler";
import {
  parsePublicStorageUrl,
  validateLessonVideoStorageUrl,
  validateVideoUploadMetadata,
} from "../src/lib/storage-upload";
import { requestLessonVideoUploadAuthorization } from "../src/lib/direct-storage-upload";

const creator = {
  userId: "creator-user",
  creatorProfile: {
    id: "creator-profile",
    userId: "creator-user",
    displayName: "Creator",
  },
};

function createRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/uploads/video", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    courseId: "course-1",
    fileName: "lesson.mp4",
    fileType: "video/mp4",
    fileSize: 68 * 1024 * 1024,
    ...overrides,
  };
}

test("unauthenticated and non-creator users cannot obtain upload authorization", async () => {
  let signed = false;
  const handler = createLessonVideoUploadHandler({
    getCreator: async () => null,
    findOwnedCourse: async () => null,
    signUpload: async () => {
      signed = true;
      throw new Error("should not sign");
    },
  });

  const response = await handler(createRequest(validBody()));
  assert.equal(response.status, 403);
  assert.equal(signed, false);
});

test("creator cannot obtain authorization for another creator's course", async () => {
  const handler = createLessonVideoUploadHandler({
    getCreator: async () => creator,
    findOwnedCourse: async () => null,
    signUpload: async () => {
      throw new Error("should not sign");
    },
  });

  const response = await handler(createRequest(validBody()));
  assert.equal(response.status, 404);
});

test("invalid MIME types and invalid sizes are rejected", async () => {
  assert.match(
    validateVideoUploadMetadata({
      fileName: "lesson.mp4",
      fileType: "application/octet-stream",
      fileSize: 100,
    }) || "",
    /Only MP4/,
  );
  assert.match(
    validateVideoUploadMetadata({
      fileName: "lesson.exe",
      fileType: "video/mp4",
      fileSize: 100,
    }) || "",
    /extension/,
  );

  for (const fileSize of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.match(
      validateVideoUploadMetadata({
        fileName: "lesson.mp4",
        fileType: "video/mp4",
        fileSize,
      }) || "",
      /valid video file size/,
    );
  }

  assert.match(
    validateVideoUploadMetadata({
      fileName: "lesson.mp4",
      fileType: "video/mp4",
      fileSize: 251 * 1024 * 1024,
    }) || "",
    /too large/,
  );
});

test("valid MP4 metadata returns one-object signed upload information without server credentials", async () => {
  process.env.SUPABASE_LESSON_VIDEO_BUCKET = "lesson-videos";
  const handler = createLessonVideoUploadHandler({
    getCreator: async () => creator,
    findOwnedCourse: async (courseId, userId) => {
      assert.equal(courseId, "course-1");
      assert.equal(userId, creator.userId);
      return {
        id: "course-1",
        experience: { slug: "owned-experience" },
      };
    },
    signUpload: async ({ bucket, path, upsert }) => {
      assert.equal(bucket, "lesson-videos");
      assert.equal(upsert, false);
      assert.match(
        path,
        /^experiences\/owned-experience\/courses\/course-1\/lessons\/[0-9a-f-]+-lesson\.mp4$/,
      );
      return {
        bucket,
        path,
        signedUrl: "https://project.supabase.co/storage/v1/object/upload/sign/token",
      };
    },
  });

  const response = await handler(createRequest(validBody()));
  const json = await response.json();
  const serialized = JSON.stringify(json);

  assert.equal(response.status, 200);
  assert.equal(json.data.bucket, "lesson-videos");
  assert.ok(json.data.signedUrl);
  assert.doesNotMatch(serialized, /service.role|SUPABASE_SERVICE_ROLE/i);
  assert.doesNotMatch(serialized, /\/object\/public\/lesson-videos/);
});

test("lesson video URLs must use the configured origin, bucket, and course prefix", () => {
  process.env.SUPABASE_STORAGE_URL = "https://project.supabase.co";
  process.env.SUPABASE_LESSON_VIDEO_BUCKET = "lesson-videos";
  const validUrl =
    "https://project.supabase.co/storage/v1/object/public/lesson-videos/experiences/my-experience/courses/course-1/lessons/id-video.mp4";

  assert.deepEqual(parsePublicStorageUrl(validUrl), {
    bucket: "lesson-videos",
    path: "experiences/my-experience/courses/course-1/lessons/id-video.mp4",
  });
  assert.ok(
    validateLessonVideoStorageUrl({
      url: validUrl,
      courseId: "course-1",
      experienceSlug: "my-experience",
    }),
  );
  assert.equal(
    validateLessonVideoStorageUrl({
      url: validUrl,
      courseId: "course-2",
      experienceSlug: "my-experience",
    }),
    null,
  );
  assert.equal(
    validateLessonVideoStorageUrl({
      url: "https://evil.example/video.mp4",
      courseId: "course-1",
      experienceSlug: "my-experience",
    }),
    null,
  );
});

test("a simulated 68 MB lesson file sends JSON metadata only to Vercel", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  let capturedContentType = "";

  globalThis.fetch = (async (_input, init) => {
    capturedBody = String(init?.body || "");
    capturedContentType = String(
      (init?.headers as Record<string, string>)?.["Content-Type"] || "",
    );
    return new Response(
      JSON.stringify({
        data: {
          bucket: "lesson-videos",
          path: "experiences/e/courses/c/lessons/id-video.mp4",
          signedUrl:
            "https://project.supabase.co/storage/v1/object/upload/sign/token",
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    await requestLessonVideoUploadAuthorization({
      courseId: "course-1",
      file: {
        name: "large.mp4",
        type: "video/mp4",
        size: 68 * 1024 * 1024,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedContentType, "application/json");
  assert.ok(capturedBody.length < 1024);
  assert.match(capturedBody, /71303168/);
  assert.doesNotMatch(capturedBody, /FormData|\\x00/);
});

test("client uploads before lesson persistence and cleans a newly uploaded object after save failure", async () => {
  const source = await readFile(
    new URL(
      "../src/app/(withSidebar)/dashboard/creator/courses/[id]/lessons/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const directUploadIndex = source.indexOf("uploadFileToSignedStorage({");
  const lessonSaveIndex = source.indexOf(
    'await fetchJson("/api/creator/lessons"',
  );
  const cleanupIndex = source.indexOf(
    'await deleteUploadedAsset("", {',
  );

  assert.ok(directUploadIndex >= 0);
  assert.ok(lessonSaveIndex > directUploadIndex);
  assert.ok(cleanupIndex > lessonSaveIndex);
  assert.doesNotMatch(
    source,
    /fetchJson<[^>]*>\(\"\/api\/uploads\/video\"[\s\S]*FormData/,
  );
});

test("lesson replacement cleanup is ordered safely and YouTube persistence remains unchanged", async () => {
  const source = await readFile(
    new URL("../src/app/api/creator/lessons/route.ts", import.meta.url),
    "utf8",
  );
  const updateIndex = source.indexOf(
    "const lesson = await prisma.lesson.update({",
  );
  const cleanupIndex = source.indexOf(
    'await cleanupLessonVideo(oldReference, "PATCH");',
  );

  assert.ok(updateIndex >= 0);
  assert.ok(cleanupIndex > updateIndex);
  assert.match(
    source,
    /youtubeUrl: videoSource === "YOUTUBE" \? youtubeUrl : null/,
  );
  assert.match(
    source,
    /videoStorageBucket: videoReference\?\.bucket \|\| null/,
  );
  assert.doesNotMatch(source, /videoUploadUrl:\s*videoAssetUrl/);
});
