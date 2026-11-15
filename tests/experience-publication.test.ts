import "./env-setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getExperienceAccessContextImpl, isExperienceVisibleToViewer } from "../src/lib/experience-access";

const experience = {
  id: "exp", slug: "draft", title: "Draft", isActive: false,
  description: null, coverImageUrl: null, whyVideoSource: null,
  whyYoutubeUrl: null, whyVideoUploadUrl: null, qaDailyQuestionLimit: 1,
  creator: { id: "creator", userId: "owner", displayName: null, bio: null, avatarUrl: null, user: { name: null } },
  campaigns: [],
};

function deps(userId: string | null, published = false) {
  return {
    getViewer: async () => ({ session: null, userId, sessionId: null }),
    findExperience: (async () => ({ ...experience, isActive: published })) as never,
    getViewerSession: (async () => null) as never,
    findUnlock: (async () => null) as never,
  };
}

test("draft public viewer access is denied for everyone including its owner", async () => {
  for (const userId of [null, "other", "admin", "owner"]) {
    assert.equal(await getExperienceAccessContextImpl("draft", undefined, deps(userId)), null);
  }
});

test("published experience retains private unlock rules", async () => {
  const visitor = await getExperienceAccessContextImpl("draft", undefined, deps("visitor", true));
  assert.equal(visitor?.isPublished, true);
  assert.equal(visitor?.isOwnerPreview, false);
  assert.equal(visitor?.canAccessPrivate, false);
  const owner = await getExperienceAccessContextImpl("draft", undefined, deps("owner", true));
  assert.equal(owner?.isOwnerPreview, false);
  assert.equal(owner?.canAccessPrivate, true);
});

test("direct comment and answer routes use the same owner-only draft visibility policy", () => {
  const draft = { isActive: false, creator: { userId: "owner" } };
  assert.equal(isExperienceVisibleToViewer(draft, "owner"), true);
  for (const viewer of [null, "other", "admin", "brand-admin"]) assert.equal(isExperienceVisibleToViewer(draft, viewer), false);
  assert.equal(isExperienceVisibleToViewer({ ...draft, isActive: true }, "other"), true);
});
