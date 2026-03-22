"use client";

import Link from "next/link";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ExperienceResponse = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  coverImageUrl: string | null;
  status: "DRAFT" | "PUBLISHED";
};

type PostsResponse = {
  experience: {
    id: string;
    slug: string;
    title: string;
  };
  creator: {
    displayName: string;
  };
  canCreate: boolean;
  posts: Array<{
    id: string;
    title: string | null;
    body: string;
    isPinned: boolean;
    createdAt: string;
    commentCount: number;
  }>;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export default function CreatorExperiencePostsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: experienceId } = use(params);
  const [experience, setExperience] = useState<ExperienceResponse | null>(null);
  const [postsData, setPostsData] = useState<PostsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const isDraft = useMemo(
    () => experience?.status === "DRAFT",
    [experience?.status],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const experienceResult = await fetchJson<ExperienceResponse>(
        `/api/creator/experiences/${experienceId}`,
      );
      setExperience(experienceResult);

      const postsResult = await fetchJson<PostsResponse>(
        `/api/posts?experienceSlug=${experienceResult.slug}`,
      );
      setPostsData(postsResult);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load posts."));
    } finally {
      setLoading(false);
    }
  }, [experienceId]);

  useEffect(() => {
    if (!experienceId) {
      return;
    }

    void load();
  }, [experienceId, load]);

  async function submitPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!experience || !postsData?.canCreate || !body.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await fetchJson("/api/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          experienceId: experience.id,
          title,
          body,
        }),
      });

      setTitle("");
      setBody("");
      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to publish post."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CreatorPageShell
      title={experience ? `${experience.title} Posts` : "Manage Posts"}
      description="Posts belong directly to an experience. Publish creator updates here, then review the live post feed and comment activity for this experience."
      actions={
        experience ? (
          <div className="flex flex-wrap gap-3">
            <Button
              asChild
              variant="outline"
              className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              <Link href="/dashboard/creator/experiences">Back to experiences</Link>
            </Button>
            <Button
              asChild
              className="rounded-full border border-white bg-white text-black"
            >
              <Link href={`/x/${experience.slug}/posts`}>Open live posts page</Link>
            </Button>
          </div>
        ) : null
      }
    >
      {loading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading posts...</p>
        </PageCard>
      ) : error ? (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      ) : !experience || !postsData ? (
        <PageCard>
          <p className="text-sm text-white/65">Experience not found.</p>
        </PageCard>
      ) : (
        <>
          <PageCard>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-2xl font-semibold">{experience.title}</h2>
                  <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                    {experience.status}
                  </span>
                </div>
                <p className="mt-2 text-sm text-white/55">/{experience.slug}</p>
                {experience.description && (
                  <p className="mt-4 max-w-3xl text-sm leading-6 text-white/70">
                    {experience.description}
                  </p>
                )}
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 px-5 py-4 text-center">
                <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                  Posts
                </p>
                <p className="mt-2 text-2xl font-semibold">
                  {postsData.posts.length}
                </p>
              </div>
            </div>
          </PageCard>

          <PageCard>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">Create post</h2>
                <p className="mt-2 text-sm text-white/65">
                  Creator posts are attached directly to this experience, not to a
                  course. Courses hold lessons; posts and Q&amp;A sit alongside
                  them under the experience.
                </p>
              </div>
              {isDraft && (
                <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-3 py-1 text-xs text-amber-200">
                  Draft experience
                </span>
              )}
            </div>

            <form onSubmit={(event) => void submitPost(event)} className="mt-5 space-y-4">
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Optional post title"
                className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write the update you want to publish to this experience."
                className="min-h-[160px] border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
              <Button
                type="submit"
                disabled={!postsData.canCreate || saving || !body.trim()}
                className="rounded-full border border-white bg-white text-black"
              >
                {saving ? "Publishing..." : "Publish post"}
              </Button>
            </form>
          </PageCard>

          <div className="space-y-5">
            {postsData.posts.length === 0 ? (
              <PageCard>
                <p className="text-sm text-white/65">
                  No posts published for this experience yet.
                </p>
              </PageCard>
            ) : (
              postsData.posts.map((post) => (
                <PageCard key={post.id}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-xl font-semibold">
                          {post.title || "Untitled post"}
                        </h2>
                        {post.isPinned && (
                          <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-xs text-amber-200">
                            Pinned
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-white/50">
                        {formatDate(post.createdAt)}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center">
                      <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                        Comments
                      </p>
                      <p className="mt-2 text-2xl font-semibold">
                        {post.commentCount}
                      </p>
                    </div>
                  </div>

                  <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-white/75">
                    {post.body}
                  </p>
                </PageCard>
              ))
            )}
          </div>
        </>
      )}
    </CreatorPageShell>
  );
}
