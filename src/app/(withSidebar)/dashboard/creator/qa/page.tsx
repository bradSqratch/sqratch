"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type CreatorInboxQuestion = {
  id: string;
  body: string;
  status: "OPEN" | "ANSWERED";
  createdAt: string;
  experience: {
    id: string;
    title: string;
    slug: string;
  };
  askedBy: {
    id: string;
    name: string;
  };
  answers?: Array<{
    id: string;
    body: string;
    createdAt: string;
    answeredBy: {
      id: string;
      name: string;
    };
  }>;
};

type CreatorInboxResponse = {
  experiences: Array<{
    id: string;
    title: string;
    slug: string;
  }>;
  questions: CreatorInboxQuestion[];
  answeredQuestions?: CreatorInboxQuestion[];
};

export default function CreatorQAPage() {
  const searchParams = useSearchParams();
  const [selectedExperienceId, setSelectedExperienceId] = useState(
    searchParams.get("experienceId") || "",
  );
  const [data, setData] = useState<CreatorInboxResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);

    try {
      const query = new URLSearchParams({ creatorInbox: "1" });
      if (selectedExperienceId) {
        query.set("experienceId", selectedExperienceId);
      }

      const result = await fetchJson<CreatorInboxResponse>(
        `/api/questions?${query.toString()}`,
      );
      setData(result);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load creator Q&A inbox."));
    }
    // selectedExperienceId is in deps below
  }, [selectedExperienceId]);

  useEffect(() => {
    void load();
  }, [load, selectedExperienceId]);

  async function answerQuestion(questionId: string) {
    const body = drafts[questionId]?.trim();

    if (!body) {
      return;
    }

    setSavingId(questionId);
    setError(null);

    try {
      await fetchJson(`/api/questions/${questionId}/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      });

      setDrafts((current) => ({ ...current, [questionId]: "" }));
      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to answer question."));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <CreatorPageShell
      title="Creator Q&A Inbox"
      description="Review unanswered questions across your experiences and respond inline."
    >
      <PageCard>
        <div className="flex flex-wrap items-center gap-4">
          <select
            value={selectedExperienceId}
            onChange={(event) => setSelectedExperienceId(event.target.value)}
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">All experiences</option>
            {data?.experiences.map((experience) => (
              <option key={experience.id} value={experience.id}>
                {experience.title}
              </option>
            ))}
          </select>
        </div>
      </PageCard>

      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      {!data ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading questions...</p>
        </PageCard>
      ) : data.questions.length === 0 ? (
        <PageCard>
          <p className="text-sm text-white/65">No unanswered questions.</p>
        </PageCard>
      ) : (
        <div className="space-y-5">
          {data.questions.map((question) => (
            <PageCard key={question.id}>
              <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                {question.experience.title} • {question.askedBy.name}
              </p>
              <p className="mt-4 text-sm leading-7 text-white/80">
                {question.body}
              </p>
              <Textarea
                value={drafts[question.id] || ""}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                placeholder="Write an answer"
                className="mt-5 min-h-[140px] border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
              <Button
                type="button"
                onClick={() => void answerQuestion(question.id)}
                disabled={savingId === question.id || !drafts[question.id]?.trim()}
                className="mt-4 rounded-full border border-white bg-white text-black"
              >
                {savingId === question.id ? "Sending..." : "Answer question"}
              </Button>
            </PageCard>
          ))}
        </div>
      )}

      <PageCard>
        <p className="text-sm font-semibold text-white">Answered questions</p>
        {!data?.answeredQuestions || data.answeredQuestions.length === 0 ? (
          <p className="mt-3 text-sm text-white/65">No answered questions yet.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {data.answeredQuestions.map((question) => {
              const latestAnswer = question.answers?.[question.answers.length - 1];
              return (
                <div
                  key={question.id}
                  className="rounded-2xl border border-white/10 bg-black/20 p-4"
                >
                  <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                    {question.experience.title} • {question.askedBy.name}
                  </p>
                  <p className="mt-3 text-sm leading-6 text-white/80">
                    {question.body}
                  </p>
                  {latestAnswer && (
                    <div className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3">
                      <p className="text-xs uppercase tracking-[0.2em] text-emerald-200/80">
                        Answered by {latestAnswer.answeredBy.name}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-emerald-50/90">
                        {latestAnswer.body}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </PageCard>
    </CreatorPageShell>
  );
}
