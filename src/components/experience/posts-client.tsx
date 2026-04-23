"use client";

import { FormEvent, useEffect, useState } from "react";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { ExperienceShell, GatePanel, LoadingView, ErrorView, PageCard } from "@/components/experience/experience-shell";
import { useExperience } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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

type Comment = {
  id: string;
  body: string;
  createdAt: string;
  canDelete?: boolean;
  user: {
    id: string;
    name: string;
  };
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function PostCard({
  post,
  canComment,
}: {
  post: PostsResponse["posts"][number];
  canComment: boolean;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentDeletingId, setCommentDeletingId] = useState<string | null>(null);
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);

  async function loadComments() {
    if (comments || commentsLoading) {
      return;
    }

    setCommentsLoading(true);
    setCommentError(null);

    try {
      const result = await fetchJson<Comment[]>(
        `/api/posts/${post.id}/comments`,
      );
      setComments(result);
    } catch (error) {
      setCommentError(getErrorMessage(error, "Failed to load comments."));
    } finally {
      setCommentsLoading(false);
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!commentDraft.trim() || commentSaving) {
      return;
    }

    setCommentSaving(true);
    setCommentError(null);

    try {
      const created = await fetchJson<Comment>(`/api/posts/${post.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: commentDraft }),
      });

      setComments((previous) => [...(previous || []), created]);
      setCommentDraft("");
      setCommentError(null);
    } catch (error) {
      setCommentError(getErrorMessage(error, "Failed to add comment."));
    } finally {
      setCommentSaving(false);
    }
  }

  async function deleteComment(commentId: string) {
    if (commentDeletingId) {
      return;
    }

    setCommentError(null);
    setCommentDeletingId(commentId);

    try {
      await fetchJson(`/api/posts/${post.id}/comments/${commentId}`, {
        method: "DELETE",
      });
      setComments((previous) =>
        previous?.filter((comment) => comment.id !== commentId) || [],
      );
    } catch (error) {
      setCommentError(getErrorMessage(error, "Failed to delete comment."));
    } finally {
      setCommentDeletingId(null);
    }
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-black/20 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          {post.title && (
            <h3 className="text-xl font-semibold text-[#988dbf]">
              {post.title}
            </h3>
          )}
          <p className="mt-1 text-sm text-white/50">{formatDate(post.createdAt)}</p>
        </div>
        {post.isPinned && (
          <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-xs text-amber-200">
            Pinned
          </span>
        )}
      </div>

      <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-white/75">
        {post.body}
      </p>

      <div className="mt-5 flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadComments()}
          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
        >
          {comments ? "Refresh comments" : `View comments (${post.commentCount})`}
        </Button>
      </div>

      {commentsLoading && <p className="mt-4 text-sm text-white/55">Loading comments...</p>}
      {commentError && <p className="mt-4 text-sm text-red-300">{commentError}</p>}

      {comments && (
        <div className="mt-5 space-y-3">
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="rounded-2xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{comment.user.name}</p>
                  {comment.canDelete && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void deleteComment(comment.id)}
                      disabled={commentDeletingId === comment.id}
                      className="h-7 rounded-full border-red-200/50 bg-transparent px-3 text-xs text-red-100 hover:bg-red-500/10"
                    >
                      {commentDeletingId === comment.id ? "Deleting..." : "Delete"}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-white/45">
                  {formatDate(comment.createdAt)}
                </p>
              </div>
              <p className="mt-2 text-sm leading-6 text-white/70">{comment.body}</p>
            </div>
          ))}
        </div>
      )}

      {canComment && (
        <form onSubmit={submitComment} className="mt-5 space-y-3">
          <Textarea
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            placeholder="Add a comment"
            className="min-h-[110px] border-white/10 bg-black/25 text-white placeholder:text-white/35"
          />
          <Button
            type="submit"
            disabled={commentSaving || !commentDraft.trim()}
            className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
          >
            {commentSaving ? "Posting..." : "Post Comment"}
          </Button>
        </form>
      )}
    </div>
  );
}

export function ExperiencePostsClient({
  experienceSlug,
}: {
  experienceSlug: string;
}) {
  const { data, loading, error, reload } = useExperience(experienceSlug);
  const [postsData, setPostsData] = useState<PostsResponse | null>(null);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data?.canInteract) {
      return;
    }

    setPostsLoading(true);
    fetchJson<PostsResponse>(`/api/posts?experienceSlug=${experienceSlug}`)
      .then(setPostsData)
      .catch((error) =>
        setPostsError(getErrorMessage(error, "Failed to load posts.")),
      )
      .finally(() => setPostsLoading(false));
  }, [data?.canInteract, experienceSlug]);

  async function submitPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!postsData?.canCreate || !body.trim()) {
      return;
    }

    setSaving(true);
    setPostsError(null);

    try {
      await fetchJson("/api/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          experienceId: postsData.experience.id,
          title,
          body,
        }),
      });

      setTitle("");
      setBody("");
      await Promise.all([
        reload(),
        fetchJson<PostsResponse>(`/api/posts?experienceSlug=${experienceSlug}`).then(
          setPostsData,
        ),
      ]);
    } catch (error) {
      setPostsError(getErrorMessage(error, "Failed to create post."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <LoadingView label="Loading posts..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Experience not found."} />;
  }

  return (
    <ExperienceShell
      experience={data}
      activeTab="posts"
      actions={
        <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
          <p className="text-sm text-white/55">Posts</p>
          <p className="mt-2 text-3xl font-semibold">{data.counts.posts}</p>
        </div>
      }
    >
      {!data.canInteract ? (
        <GatePanel
          experience={data}
          title="Posts Are Locked"
          description="Log in and unlock the linked campaign to read the creator feed and join the comments."
        />
      ) : (
        <div className="space-y-6">
          {postsData?.canCreate && (
            <PageCard>
              <h2 className="text-2xl font-semibold text-[#988dbf]">Publish a post</h2>
              <p className="mt-2 text-sm leading-6 text-white/70">
                Only the creator who owns this experience can publish new posts.
              </p>

              <form onSubmit={submitPost} className="mt-6 space-y-4">
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Post title (optional)"
                  className="border-white/10 bg-black/25 text-white placeholder:text-white/35"
                />
                <Textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Write your update"
                  className="min-h-[160px] border-white/10 bg-black/25 text-white placeholder:text-white/35"
                />
                <Button
                  type="submit"
                  disabled={saving || !body.trim()}
                  className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
                >
                  {saving ? "Publishing..." : "Publish post"}
                </Button>
              </form>
            </PageCard>
          )}

          {postsLoading && (
            <PageCard>
              <p className="text-sm text-white/65">Loading post feed...</p>
            </PageCard>
          )}
          {postsError && (
            <PageCard>
              <p className="text-sm text-red-300">{postsError}</p>
            </PageCard>
          )}

          {postsData && postsData.posts.length === 0 && (
            <PageCard>
              <p className="text-sm text-white/65">No posts published yet.</p>
            </PageCard>
          )}

          {postsData?.posts.map((post) => (
            <PostCard key={post.id} post={post} canComment={data.canInteract} />
          ))}
        </div>
      )}
    </ExperienceShell>
  );
}
