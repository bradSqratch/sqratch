"use client";

import Link from "next/link";
import { useState } from "react";
import { ExperienceShell, GatePanel, LoadingView, ErrorView, PageCard } from "@/components/experience/experience-shell";
import { useExperience } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function ExperienceHubClient({
  experienceSlug,
}: {
  experienceSlug: string;
}) {
  const { data, loading, error } = useExperience(experienceSlug);
  const [activeTab, setActiveTab] = useState("learn");

  if (loading) {
    return <LoadingView label="Loading experience..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Experience not found."} />;
  }

  return (
    <ExperienceShell
      experience={data}
      activeTab="hub"
      actions={
        <div className="space-y-3">
          <Button
            asChild
            className="w-full rounded-full border border-white bg-white text-black"
          >
            <Link href={`/x/${data.slug}/learn`}>Start Learning</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="w-full rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            <Link href={`/x/${data.slug}/posts`}>Open Posts</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="w-full rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            <Link href={`/x/${data.slug}/shop`}>Browse Shop</Link>
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <PageCard>
          <p className="text-sm text-white/55">Visible courses</p>
          <p className="mt-2 text-4xl font-semibold">
            {data.courseSummary.visibleCourseCount}
          </p>
        </PageCard>
        <PageCard>
          <p className="text-sm text-white/55">Posts</p>
          <p className="mt-2 text-4xl font-semibold">{data.counts.posts}</p>
        </PageCard>
        <PageCard>
          <p className="text-sm text-white/55">Q&amp;A threads</p>
          <p className="mt-2 text-4xl font-semibold">{data.counts.questions}</p>
        </PageCard>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mt-8 space-y-6"
      >
        <TabsList className="rounded-full border border-white/10 bg-white/6 p-1">
          <TabsTrigger
            value="learn"
            className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
          >
            Learn
          </TabsTrigger>
          <TabsTrigger
            value="posts"
            className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
          >
            Posts
          </TabsTrigger>
          <TabsTrigger
            value="qa"
            className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
          >
            Q&amp;A
          </TabsTrigger>
        </TabsList>

        <TabsContent value="learn">
          <PageCard>
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold">Learn</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                  Public courses are available immediately. Private courses open
                  after login and campaign unlock.
                </p>
              </div>
              <Button
                asChild
                className="rounded-full border border-white bg-white text-black"
              >
                <Link href={`/x/${data.slug}/learn`}>View All Courses</Link>
              </Button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {data.courses.slice(0, 4).map((course) => (
                <div
                  key={course.id}
                  className="rounded-3xl border border-white/10 bg-black/20 p-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold">{course.title}</h3>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                      {course.access}
                    </span>
                  </div>
                  {course.description && (
                    <p className="mt-3 text-sm leading-6 text-white/70">
                      {course.description}
                    </p>
                  )}
                  <p className="mt-4 text-xs uppercase tracking-[0.24em] text-white/45">
                    {course.lessonCount} lessons
                  </p>
                </div>
              ))}
            </div>
          </PageCard>
        </TabsContent>

        <TabsContent value="posts">
          {data.canInteract ? (
            <PageCard>
              <h2 className="text-2xl font-semibold">Creator Posts</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                Discussions, drops, and creator updates live here. Commenting is
                available once you have access.
              </p>
              <div className="mt-6 flex items-center justify-between rounded-3xl border border-white/10 bg-black/20 p-5">
                <div>
                  <p className="text-sm text-white/55">Current feed size</p>
                  <p className="mt-2 text-3xl font-semibold">{data.counts.posts}</p>
                </div>
                <Button
                  asChild
                  className="rounded-full border border-white bg-white text-black"
                >
                  <Link href={`/x/${data.slug}/posts`}>Open Posts</Link>
                </Button>
              </div>
            </PageCard>
          ) : (
            <GatePanel
              experience={data}
              title="Posts Are Locked"
              description="Log in and unlock the linked campaign to join the creator feed and comment on posts."
            />
          )}
        </TabsContent>

        <TabsContent value="qa">
          {data.canInteract ? (
            <PageCard>
              <h2 className="text-2xl font-semibold">Q&amp;A</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                Ask the creator questions directly. Your daily limit for this
                experience is {data.qaDailyQuestionLimit}.
              </p>
              <div className="mt-6 flex items-center justify-between rounded-3xl border border-white/10 bg-black/20 p-5">
                <div>
                  <p className="text-sm text-white/55">Questions so far</p>
                  <p className="mt-2 text-3xl font-semibold">
                    {data.counts.questions}
                  </p>
                </div>
                <Button
                  asChild
                  className="rounded-full border border-white bg-white text-black"
                >
                  <Link href={`/x/${data.slug}/qa`}>Open Q&amp;A</Link>
                </Button>
              </div>
            </PageCard>
          ) : (
            <GatePanel
              experience={data}
              title="Q&A Is Locked"
              description="Log in and unlock the linked campaign to ask questions and follow creator answers."
            />
          )}
        </TabsContent>
      </Tabs>
    </ExperienceShell>
  );
}
