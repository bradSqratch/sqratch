import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { NextRequest, NextResponse } from "next/server";
import ts from "typescript";

test("uncertain cover persistence retains new upload; committed saves clean only the old asset", async () => {
  for (const uncertain of [true, false]) {
    const cleaned: string[] = [];
    const modules: Record<string, unknown> = {
      "next/server": { NextRequest, NextResponse },
      "@/lib/creator-auth": { getCreatorContext: async () => ({ userId: "creator", creatorId: "profile" }), getOwnedExperienceForCreator: async () => ({ id: "experience", slug: "example", coverImageUrl: "old" }), slugifyValue: (value: string) => value },
      "@/lib/prisma": { __esModule: true, default: { experience: { update: async () => { if (uncertain) throw new Error("Lost commit response"); return { id: "experience", coverImageUrl: "new", updatedAt: new Date() }; } } } },
      "@/lib/media-cleanup": { cleanupUnreferencedMedia: async (url: string) => { cleaned.push(url); return true; } },
      "@/lib/storage-upload": { getMaxUploadBytes: () => 10000, uploadFileToStorage: async (options: { upsert: boolean }) => { assert.equal(options.upsert, false); return { bucket: "covers", path: "new", fileUrl: "new" }; } },
    };
    const exports: { POST?: (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response> } = {};
    runInNewContext(ts.transpileModule(readFileSync("src/app/api/creator/experiences/[id]/cover/route.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require(name: string) { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; }, File, process, crypto, console: { error() {} } });
    const form = new FormData();
    form.set("file", new File(["image"], "image.png", { type: "image/png" }));
    const response = await exports.POST!(new NextRequest("http://localhost/cover", { method: "POST", body: form }), { params: Promise.resolve({ id: "experience" }) });
    assert.equal(response.status, uncertain ? 500 : 200);
    assert.deepEqual(cleaned, uncertain ? [] : ["old"]);
  }
});
