import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchJson, RequestError, isDefiniteSaveRejection } from "../src/components/experience/client-utils";
import { isMediaReferenced } from "../src/lib/media-references";
import type { Prisma } from "@prisma/client";

test("save errors distinguish rejection from unknown and preserve error messages", async t => {
  for (const [status, outcome] of [[400, "rejected"], [409, "rejected"], [500, "unknown"], [503, "unknown"]] as const) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "Save failed", code: "CODE" }), { status }));
    await assert.rejects(fetchJson("/save"), error => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.message, "Save failed");
      assert.equal(error.outcome, outcome);
      assert.equal(error.status, status);
      assert.equal(error.code, "CODE");
      assert.equal(isDefiniteSaveRejection(error), outcome === "rejected");
      return true;
    });
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network failed"); });
  await assert.rejects(fetchJson("/save"), error => error instanceof RequestError && error.status === null && error.outcome === "unknown" && error.message === "Network failed");
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response("truncated", { status: 200 }));
  await assert.rejects(fetchJson("/save"), error => error instanceof RequestError && error.outcome === "unknown");
  assert.equal(isDefiniteSaveRejection(new Error("unknown")), false);
});

test("referenced storage objects are protected for lessons, avatars, brand assets and WHY videos", async () => {
  process.env.SUPABASE_STORAGE_URL = "https://storage.example";
  process.env.SUPABASE_STORAGE_SERVICE_ROLE_KEY = "test-only";
  for (const referenced of ["lesson", "user", "brand", "experience", null]) {
    const calls: string[] = [];
    const db = Object.fromEntries(["lesson", "user", "brand", "experience"].map(model => [model, { findFirst: async () => {
      calls.push(model);
      return referenced === model ? { id: "attached" } : null;
    } }])) as unknown as Pick<Prisma.TransactionClient, "lesson" | "user" | "brand" | "experience">;
    assert.equal(await isMediaReferenced(db, { bucket: "bucket", path: "path" }, "https://storage.example/asset"), referenced !== null);
    if (referenced === "lesson") assert.deepEqual(calls, ["lesson"]);
  }
});

test("bucket and path cleanup checks legacy public URLs including encoded and query variants", async () => {
  process.env.SUPABASE_STORAGE_URL = "https://storage.example";
  process.env.SUPABASE_STORAGE_SERVICE_ROLE_KEY = "test-only";
  let lessonQuery: unknown;
  const db = {
    lesson: { findFirst: async (query: unknown) => { lessonQuery = query; return { id: "legacy" }; } },
  } as unknown as Pick<Prisma.TransactionClient, "lesson" | "user" | "brand" | "experience">;
  assert.equal(await isMediaReferenced(db, { bucket: "bucket", path: "a b/video.mp4" }), true);
  const text = JSON.stringify(lessonQuery);
  assert.match(text, /a%20b\/video.mp4/);
  assert.match(text, /video.mp4\?/);
});
