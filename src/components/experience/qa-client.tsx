"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { ExperienceShell, GatePanel, LoadingView, ErrorView, PageCard } from "@/components/experience/experience-shell";
import { useExperience } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type QuestionsResponse = {
  experience: {
    id: string;
    slug: string;
    title: string;
  };
  canAnswer: boolean;
  dailyLimit: number;
  remainingToday: number;
  questions: Array<{
    id: string;
    body: string;
    status: "OPEN" | "ANSWERED" | "CLOSED";
    createdAt: string;
    askedBy: {
      id: string;
      name: string;
    };
    answers: Array<{
      id: string;
      body: string;
      createdAt: string;
      answeredBy: {
        id: string;
        name: string;
      };
    }>;
  }>;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function QuestionCard({
  question,
  canAnswer,
  onAnswered,
}: {
  question: QuestionsResponse["questions"][number];
  canAnswer: boolean;
  onAnswered: () => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await fetchJson(`/api/questions/${question.id}/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: draft }),
      });

      setDraft("");
      await onAnswered();
    } catch (error) {
      setError(getErrorMessage(error, "Failed to save answer."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-black/20 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
          {question.status}
        </span>
        <p className="text-xs uppercase tracking-[0.24em] text-white/45">
          {question.askedBy.name} • {formatDate(question.createdAt)}
        </p>
      </div>

      <p className="mt-4 text-sm leading-7 text-white/80">{question.body}</p>

      {question.answers.length > 0 ? (
        <div className="mt-5 space-y-3">
          {question.answers.map((answer) => (
            <div
              key={answer.id}
              className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4"
            >
              <p className="text-xs uppercase tracking-[0.24em] text-emerald-200/70">
                Answered by {answer.answeredBy.name}
              </p>
              <p className="mt-2 text-sm leading-6 text-emerald-50/90">
                {answer.body}
              </p>
            </div>
          ))}
        </div>
      ) : canAnswer ? (
        <form onSubmit={submitAnswer} className="mt-5 space-y-3">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write an answer"
            className="min-h-[120px] border-white/10 bg-black/25 text-white placeholder:text-white/35"
          />
          {error && <p className="text-sm text-red-300">{error}</p>}
          <Button
            type="submit"
            disabled={saving || !draft.trim()}
            className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
          >
            {saving ? "Saving..." : "Publish answer"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export function ExperienceQAClient({
  experienceSlug,
}: {
  experienceSlug: string;
}) {
  const { data, loading, error, reload } = useExperience(experienceSlug);
  const [qaData, setQaData] = useState<QuestionsResponse | null>(null);
  const [qaLoading, setQaLoading] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const loadQuestions = useCallback(async () => {
    setQaLoading(true);
    setQaError(null);

    try {
      const result = await fetchJson<QuestionsResponse>(
        `/api/questions?experienceSlug=${experienceSlug}`,
      );
      setQaData(result);
    } catch (error) {
      setQaError(getErrorMessage(error, "Failed to load questions."));
    } finally {
      setQaLoading(false);
    }
  }, [experienceSlug]);

  useEffect(() => {
    if (!data?.canInteract) {
      return;
    }

    void loadQuestions();
  }, [data?.canInteract, experienceSlug, loadQuestions]);

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!qaData || !draft.trim() || qaData.remainingToday <= 0) {
      return;
    }

    setSaving(true);
    setQaError(null);

    try {
      await fetchJson("/api/questions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          experienceId: qaData.experience.id,
          body: draft,
        }),
      });

      setDraft("");
      await Promise.all([loadQuestions(), reload()]);
    } catch (error) {
      setQaError(getErrorMessage(error, "Failed to submit question."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <LoadingView label="Loading Q&A..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Experience not found."} />;
  }

  return (
    <ExperienceShell
      experience={data}
      activeTab="qa"
      actions={
        <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
          <p className="text-sm text-white/55">Daily question limit</p>
          <p className="mt-2 text-3xl font-semibold">
            {qaData?.remainingToday ?? data.qaDailyQuestionLimit}
          </p>
          <p className="mt-2 text-sm text-white/55">Remaining today</p>
        </div>
      }
    >
      {!data.canInteract ? (
        <GatePanel
          experience={data}
          returnTo={`/x/${data.slug}/qa`}
          title="Q&A Is Locked"
          description="Log in and unlock the linked campaign to submit questions and see creator answers."
        />
      ) : (
        <div className="space-y-6">
          <PageCard>
            <h2 className="text-2xl font-semibold text-[#988dbf]">Ask the creator</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
              You can submit up to {qaData?.dailyLimit || data.qaDailyQuestionLimit} question
              {qaData?.dailyLimit === 1 || data.qaDailyQuestionLimit === 1 ? "" : "s"} per day for this
              experience.
            </p>

            {qaData && qaData.remainingToday > 0 ? (
              <form onSubmit={submitQuestion} className="mt-6 space-y-4">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Ask your question"
                  className="min-h-[140px] border-white/10 bg-black/25 text-white placeholder:text-white/35"
                />
                <Button
                  type="submit"
                  disabled={saving || !draft.trim()}
                  className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
                >
                  {saving ? "Sending..." : "Submit question"}
                </Button>
              </form>
            ) : (
              <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-5 text-sm text-white/65">
                You have reached today&apos;s limit for this experience.
              </div>
            )}

            {qaError && <p className="mt-4 text-sm text-red-300">{qaError}</p>}
          </PageCard>

          {qaLoading && (
            <PageCard>
              <p className="text-sm text-white/65">Loading questions...</p>
            </PageCard>
          )}

          {qaData && qaData.questions.length === 0 && (
            <PageCard>
              <p className="text-sm text-white/65">
                No questions have been submitted yet.
              </p>
            </PageCard>
          )}

          {qaData?.questions.map((question) => (
            <QuestionCard
              key={question.id}
              question={question}
              canAnswer={qaData.canAnswer}
              onAnswered={loadQuestions}
            />
          ))}
        </div>
      )}
    </ExperienceShell>
  );
}
