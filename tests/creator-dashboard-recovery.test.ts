import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const POSTS = "src/app/(withSidebar)/dashboard/creator/experiences/[id]/posts/page.tsx";
const ANALYTICS = "src/app/(withSidebar)/dashboard/creator/analytics/page.tsx";
const QA = "src/app/(withSidebar)/dashboard/creator/qa/page.tsx";

test("a failed post save keeps the editor mounted and the typed content intact", () => {
  const page = read(POSTS);
  const saveBody = page.slice(page.indexOf("async function submitPost"), page.indexOf("return (\n    <CreatorPageShell"));
  // The save error is its own state and never touches the page-level load error.
  assert.match(saveBody, /setSaveError\(/);
  assert.doesNotMatch(saveBody, /setError\(/);
  // Typed text is cleared only after a successful publish.
  assert.ok(saveBody.indexOf('setTitle("")') > saveBody.indexOf('await fetchJson("/api/posts"'));
  assert.ok(saveBody.indexOf('setTitle("")') < saveBody.indexOf("catch (failure)"));
  // The inline message sits inside the form card, not in the branch that replaces the page.
  const render = page.slice(page.indexOf("return (\n    <CreatorPageShell"));
  assert.ok(render.indexOf("{saveError &&") > render.indexOf("<form onSubmit"));
  // A publish refreshes the list without flashing the full-page loading state.
  assert.match(page, /await load\(\{ silent: true \}\)/);
  assert.match(page, /if \(!silent\) \{\s*setLoading\(true\);/);
  assert.match(page, /Your post was published, but the list could not be refreshed\./);
});

test("analytics and Q&A use stable selector options and guard every independent panel", () => {
  const analytics = read(ANALYTICS);
  for (const name of ["beginEngagement", "beginCommerce", "beginConversion"]) {
    assert.match(analytics, new RegExp(`const ${name} = useLatestRequest\\(\\)`));
  }
  assert.equal((analytics.match(/signal: request\.signal/g) ?? []).length, 3);
  assert.match(analytics, /\{experienceOptions\.map\(\(experience\)/);
  assert.doesNotMatch(analytics, /data\?\.experiences\.map/);
  assert.match(analytics, /setExperienceOptions\(result\.options\?\.experiences \?\? result\.experiences\)/);
  // Every panel offers a retry on failure.
  assert.equal((analytics.match(/>\s*Retry\s*</g) ?? []).length, 3);

  const qa = read(QA);
  assert.match(qa, /const beginRequest = useLatestRequest\(\)/);
  assert.match(qa, /\{options\.map\(\(experience\)/);
  assert.doesNotMatch(qa, /data\?\.experiences\.map/);
  assert.match(qa, /if \(!request\.isCurrent\(\)\) return;/);
  // The existing deep link is read at first render and followed when it changes.
  assert.match(qa, /useState\(\s*searchParams\.get\("experienceId"\) \|\| ""/);
  assert.match(qa, /setSelectedExperienceId\(linkedExperienceId\)/);
});

test("the creator routes keep their authorization and add options without removing fields", () => {
  const analytics = read("src/app/api/creator/analytics/route.ts");
  assert.match(analytics, /creatorId: creator\.creatorProfile\.id/);
  assert.match(analytics, /options: \{ experiences: ownedExperiences \}/);
  assert.match(analytics, /\n        experiences,\n/);
  const questions = read("src/app/api/questions/route.ts");
  assert.match(questions, /options: \{ experiences: creatorProfile\.experiences \}/);
  assert.match(questions, /experiences: selectedExperiences/);
});
