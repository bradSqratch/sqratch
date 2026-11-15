import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import ts from "typescript";

test("owner can read and publish a draft through creator management", async () => {
  const experience = { id: "draft-id", title: "Draft", slug: "draft", isActive: false, coverImageUrl: null, whyVideoUploadUrl: null };
  let owner = true;
  const exports: Record<string, (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>> = {};
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@prisma/client": { Prisma: { PrismaClientKnownRequestError: class extends Error {} } },
    "@/lib/creator-auth": {
      getCreatorContext: async () => ({ userId: "creator" }),
      getOwnedExperienceForCreator: async () => owner ? experience : null,
      normalizeVideoSource: () => null, normalizeExperienceStatus: (s: string) => s,
      isPublishedStatus: (s: string) => s === "PUBLISHED", slugifyValue: (s: string) => s,
    },
    "@/lib/prisma": { __esModule: true, default: { experience: { findFirst: async () => null, update: async ({ data }: { data: typeof experience }) => ({ ...experience, ...data }) } } },
    "@/lib/media-cleanup": { cleanupUnreferencedMedia: async () => true },
  };
  const source = readFileSync("src/app/api/creator/experiences/[id]/route.ts", "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: (name: string) => modules[name], console });
  const context = { params: Promise.resolve({ id: experience.id }) };
  const read = await exports.GET(new NextRequest("http://localhost"), context);
  assert.equal((await read.json()).data.status, "DRAFT");
  const publish = await exports.PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ title: "Draft", slug: "draft", status: "PUBLISHED" }) }), context);
  assert.equal(publish.status, 200);
  assert.equal((await publish.json()).data.status, "PUBLISHED");
  owner = false;
  assert.equal((await exports.GET(new NextRequest("http://localhost"), context)).status, 404);
});
