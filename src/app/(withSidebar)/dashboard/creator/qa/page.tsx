"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useLatestRequest } from "@/hooks/use-latest-request";

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
  /** Every experience the creator owns, regardless of the selected filter. */
  options?: {
    experiences: Array<{
      id: string;
      title: string;
      slug: string;
    }>;
  };
  questions: CreatorInboxQuestion[];
  answeredQuestions?: CreatorInboxQuestion[];
};

type ExperienceOption = { id: string; title: string; slug: string };

export default function CreatorQAPage() {
  const searchParams = useSearchParams();
  const [selectedExperienceId, setSelectedExperienceId] = useState(
    searchParams.get("experienceId") || "",
  );
  const [data, setData] = useState<CreatorInboxResponse | null>(null);
  // Selector options outlive any single response: they come from the full list
  // of owned experiences, are kept across a failed reload, and are never
  // narrowed by the selected filter.
  const [options, setOptions] = useState<ExperienceOption[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const beginRequest = useLatestRequest();

  // Keep a deep link such as /dashboard/creator/qa?experienceId=… in sync when
  // the same page is reached again with a different experience.
  const linkedExperienceId = searchParams.get("experienceId") || "";
  useEffect(() => {
    setSelectedExperienceId(linkedExperienceId);
  }, [linkedExperienceId]);

  const load = useCallback(async () => {
    const request = beginRequest();
    setLoadError(null);

    try {
      const query = new URLSearchParams({ creatorInbox: "1" });
      if (selectedExperienceId) {
        query.set("experienceId", selectedExperienceId);
      }

      const result = await fetchJson<CreatorInboxResponse>(
        `/api/questions?${query.toString()}`,
        { signal: request.signal },
      );
      // A slower, older response must never replace a newer selection.
      if (!request.isCurrent()) return;
      setData(result);
      setOptions(result.options?.experiences ?? result.experiences);
    } catch (failure) {
      if (!request.isCurrent()) return;
      setLoadError(getErrorMessage(failure, "Failed to load creator Q&A inbox."));
    }
  }, [selectedExperienceId, beginRequest]);

  // The answer handler can outlive the render that created it. Always reload
  // with the CURRENT selection, never the one captured when the answer was sent.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  async function answerQuestion(questionId: string) {
    const body = drafts[questionId]?.trim();

    if (!body) {
      return;
    }

    setSavingId(questionId);
    setAnswerError(null);

    try {
      await fetchJson(`/api/questions/${questionId}/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      });

      setDrafts((current) => ({ ...current, [questionId]: "" }));
      await loadRef.current();
    } catch (saveError) {
      setAnswerError(getErrorMessage(saveError, "Failed to answer question."));
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
            aria-label="Experience"
            onChange={(event) => {
              // Show loading for the new selection rather than the previous one's questions.
              setData(null);
              setSelectedExperienceId(event.target.value);
            }}
            className="flex h-10 rounded-md border border-edge/10 bg-inset/20 px-3 text-sm text-ink"
          >
            <option value="">All experiences</option>
            {options.map((experience) => (
              <option key={experience.id} value={experience.id}>
                {experience.title}
              </option>
            ))}
          </select>
        </div>
      </PageCard>

      {answerError && (
        <PageCard>
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">{answerError}</p>
        </PageCard>
      )}

      {data && loadError && (
        <PageCard>
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-red-700 dark:text-red-300">
              Could not refresh the inbox. {loadError}
            </p>
            <Button type="button" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </PageCard>
      )}

      {!data && loadError ? (
        <PageCard>
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>
            <Button type="button" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </PageCard>
      ) : !data ? (
        <PageCard>
          <p role="status" className="text-sm text-copy-65">Loading questions...</p>
        </PageCard>
      ) : data.questions.length === 0 ? (
        <PageCard>
          <p className="text-sm text-copy-65">No unanswered questions.</p>
        </PageCard>
      ) : (
        <div className="space-y-5">
          {data.questions.map((question) => (
            <PageCard key={question.id}>
              <p className="text-xs uppercase tracking-[0.24em] text-copy-45">
                {question.experience.title} • {question.askedBy.name}
              </p>
              <p className="mt-4 text-sm leading-7 text-copy-80">
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
                className="mt-5 min-h-[140px] border-edge/10 bg-inset/20 text-ink placeholder:text-copy-35"
              />
              <Button
                type="button"
                onClick={() => void answerQuestion(question.id)}
                disabled={savingId === question.id || !drafts[question.id]?.trim()}
                className="mt-4 rounded-full border border-edge bg-primary text-primary-foreground"
              >
                {savingId === question.id ? "Sending..." : "Answer question"}
              </Button>
            </PageCard>
          ))}
        </div>
      )}

      <PageCard>
        <p className="text-sm font-semibold text-ink">Answered questions</p>
        {!data?.answeredQuestions || data.answeredQuestions.length === 0 ? (
          <p className="mt-3 text-sm text-copy-65">No answered questions yet.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {data.answeredQuestions.map((question) => {
              const latestAnswer = question.answers?.[question.answers.length - 1];
              return (
                <div
                  key={question.id}
                  className="rounded-2xl border border-edge/10 bg-inset/20 p-4"
                >
                  <p className="text-xs uppercase tracking-[0.24em] text-copy-45">
                    {question.experience.title} • {question.askedBy.name}
                  </p>
                  <p className="mt-3 text-sm leading-6 text-copy-80">
                    {question.body}
                  </p>
                  {latestAnswer && (
                    <div className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3">
                      <p className="text-xs uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-200/80">
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
