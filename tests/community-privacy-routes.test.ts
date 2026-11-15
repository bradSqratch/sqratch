import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { publicDisplayName } from "../src/lib/display-name";

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
function load(file: string, db: object, userId: string) {
  const exports: Record<string, Handler> = {};
  const access = { canInteract: true, isCreatorOwner: userId === "owner", viewer: { userId, session: { user: { role: "USER" } } }, experience: { id: "exp", slug: "exp", title: "Experience", qaDailyQuestionLimit: 5 } };
  const modules: Record<string, unknown> = {
    "next/server": { NextRequest, NextResponse },
    "@/lib/display-name": { publicDisplayName },
    "@/lib/experience-access": { getViewerContext: async () => access.viewer, getExperienceAccessContext: async () => access, isExperienceVisibleToViewer: (experience: { isActive: boolean; creator: { userId: string } }, id: string) => experience.isActive || experience.creator.userId === id },
    "@/lib/brand-context": { resolveActiveBrandContext: async () => null },
    "@/lib/prisma": { __esModule: true, default: db },
  };
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(source, { exports, require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected dependency ${id}`); return modules[id]; }, console, Date });
  return exports;
}
const params = (key: string, value: string) => ({ params: Promise.resolve({ [key]: value }) });
const post = { experience: { slug: "exp", creator: { userId: "owner" }, campaigns: [] } };

test("comment list and create return safe names and preserve owner permissions", async () => {
  for (const name of [null, "", "  Jane  "]) {
    const user = { id: "person", name, email: "secret@example.test" };
    const comment = { id: "comment", body: "Text", createdAt: new Date(), user };
    let writes = 0;
    const handlers = load("src/app/api/posts/[postId]/comments/route.ts", { post: { findUnique: async () => post }, postComment: { findMany: async () => [comment], create: async () => { writes++; return comment; } } }, "owner");
    for (const [method, expectedStatus] of [["GET", 200], ["POST", 201]] as const) {
      const request = new NextRequest("https://example.test/api/posts/post/comments", { method, ...(method === "POST" ? { body: JSON.stringify({ body: "Text" }) } : {}) });
      const response = await handlers[method](request, params("postId", "post"));
      assert.equal(response.status, expectedStatus);
      const body = await response.json();
      const result = method === "GET" ? body.data[0] : body.data;
      assert.equal(result.user.name, name?.trim() || "SQRATCH member");
      assert.equal(result.canDelete, true);
      assert.doesNotMatch(JSON.stringify(body), /secret@example\.test|"email"/);
    }
    assert.equal(writes, 1);
  }
});

test("Q&A list and owner answer return neutral names without email fields", async () => {
  for (const name of [null, "", "  Jane  "]) {
    const person = { id: "person", name, email: "secret@example.test" };
    const answer = { id: "answer", body: "Answer", createdAt: new Date(), answeredBy: person };
    const question = { id: "question", body: "Question", status: "ANSWERED", createdAt: new Date(), askedBy: person, answers: [answer] };
    const db = { question: { findMany: async () => [question], count: async () => 0, findUnique: async () => ({ id: "question", experience: { isActive: true, creator: { userId: "owner" } } }) }, questionAnswer: { findFirst: async () => null }, $transaction: async (fn: (tx: object) => Promise<unknown>) => fn({ questionAnswer: { create: async () => ({ id: "answer" }), findUniqueOrThrow: async () => answer }, question: { update: async () => ({}) } }) };
    const list = load("src/app/api/questions/route.ts", db, "owner");
    const get = await list.GET(new NextRequest("https://example.test/api/questions?experienceSlug=exp"), params("unused", "unused"));
    assert.equal(get.status, 200);
    const result = await get.json();
    assert.equal(result.data.questions[0].askedBy.name, name?.trim() || "SQRATCH member");
    assert.equal(result.data.questions[0].answers[0].answeredBy.name, name?.trim() || "SQRATCH member");
    assert.doesNotMatch(JSON.stringify(result), /secret@example\.test|"email"/);
    const answering = load("src/app/api/questions/[questionId]/answer/route.ts", db, "owner");
    const response = await answering.POST(new NextRequest("https://example.test/api/questions/question/answer", { method: "POST", body: JSON.stringify({ body: "Answer" }) }), params("questionId", "question"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.answeredBy.name, name?.trim() || "SQRATCH member");
    assert.doesNotMatch(JSON.stringify(body), /secret@example\.test|"email"/);
    const nonOwner = load("src/app/api/questions/[questionId]/answer/route.ts", db, "other");
    const denied = await nonOwner.POST(new NextRequest("https://example.test/api/questions/question/answer", { method: "POST", body: JSON.stringify({ body: "Answer" }) }), params("questionId", "question"));
    assert.equal(denied.status, 403);
  }
});
