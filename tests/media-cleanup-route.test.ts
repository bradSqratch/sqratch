import "./env-setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { assertExpectedBrand, getBrandContextFailure } from "../src/lib/brand-auth";

function harness(role: string, referenced: boolean) {
  const deleted: string[] = [];
  const brand = { id: "brand", name: "Brand", slug: "brand" };
  const context = { membership: { brand }, selectionRequired: false };
  const modules: Record<string, unknown> = {
    "next/server": { NextRequest, NextResponse },
    "next-auth": { getServerSession: async () => ({ user: { id: "owner", role } }) },
    "@/app/api/auth/[...nextauth]/options": { authOptions: {} },
    "@/lib/media-references": { isMediaReferenced: async () => referenced },
    "@/lib/brand-auth": { assertExpectedBrand, getBrandContextFailure, getBrandAdminContext: async () => context },
    "@/lib/brand-context": { resolveActiveBrandContext: async () => context },
    "@/lib/prisma": { __esModule: true, default: { course: { findFirst: async () => ({ id: "course", experience: { slug: "exp" } }) }, experience: { findFirst: async () => ({ id: "exp" }) } } },
    "@/lib/storage-upload": {
      getLessonVideoBucket: () => "lesson-videos",
      parsePublicStorageUrl: (url: string) => { const match = new URL(url).pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/); return match ? { bucket: match[1], path: match[2] } : null; },
      validateLessonVideoStorageObject: ({ bucket, path }: { bucket: string; path: string }) => bucket === "lesson-videos" && path.startsWith("experiences/exp/courses/course/lessons/") ? { bucket, path } : null,
      validateLessonVideoStorageUrl: () => null,
      deleteFileFromStorage: async (bucket: string, path: string) => { deleted.push(`${bucket}/${path}`); return true; },
      deleteStorageObjectByUrl: async (url: string) => { deleted.push(url); return true; },
    },
  };
  const exports: Record<string, (request: NextRequest) => Promise<Response>> = {};
  const output = ts.transpileModule(readFileSync("src/app/api/uploads/storage-object/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(output, { exports, require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected dependency ${id}`); return modules[id]; }, process, console });
  return { call: (body: unknown, headers: Record<string, string> = {}) => exports.DELETE(new NextRequest("https://sqratch.test/api/uploads/storage-object", { method: "DELETE", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })), deleted };
}

test("attached objects are rejected for each authorized role", async () => {
  for (const [role, body] of [
    ["ADMIN", { url: "https://storage.test/storage/v1/object/public/brand-assets/brands/brand/logo/a.png" }],
    ["BRAND_ADMIN", { url: "https://storage.test/storage/v1/object/public/brand-assets/brands/brand/logo/a.png" }],
    ["CREATOR", { url: "https://storage.test/storage/v1/object/public/user-avatars/users/owner/avatar/a.png" }],
    ["CREATOR", { courseId: "course", bucket: "lesson-videos", path: "experiences/exp/courses/course/lessons/video.mp4" }],
  ] as const) {
    const h = harness(role, true); const response = await h.call(body);
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "ASSET_IN_USE"); assert.deepEqual(h.deleted, []);
  }
});

test("lesson bucket/path authorization cannot delete an unrelated supplied URL", async () => {
  const h = harness("CREATOR", false);
  const response = await h.call({ courseId: "course", bucket: "lesson-videos", path: "experiences/exp/courses/course/lessons/video.mp4", url: "https://storage.test/storage/v1/object/public/brand-assets/brands/other/logo.png" });
  assert.equal(response.status, 200);
  assert.deepEqual(h.deleted, ["lesson-videos/experiences/exp/courses/course/lessons/video.mp4"]);
});

test("an administrator's brand-page cleanup rejects a stale brand", async () => {
  const h = harness("ADMIN", false);
  const response = await h.call({ url: "https://storage.test/storage/v1/object/public/brand-assets/brands/brand/logo/a.png" }, { "x-sqratch-expected-brand": "old-brand" });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "BRAND_CONTEXT_MISMATCH"); assert.deepEqual(h.deleted, []);
});
