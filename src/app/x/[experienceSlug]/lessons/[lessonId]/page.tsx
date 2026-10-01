import { ExperienceLessonClient } from "@/components/experience/lesson-client";
import { enforceExperienceEntryContext } from "@/lib/experience-entry-guard";

export default async function ExperienceLessonPage({
  params,
  searchParams,
}: {
  params: Promise<{ experienceSlug: string; lessonId: string }>;
  searchParams: Promise<{ campaignEntry?: string | string[] }>;
}) {
  const { experienceSlug, lessonId } = await params;
  const query = await searchParams;

  // Direct/external entry to any Experience route must not inherit a stale
  // campaign; see `enforceExperienceEntryContext`.
  await enforceExperienceEntryContext({
    experienceSlug,
    campaignEntry: query.campaignEntry,
  });

  return (
    <ExperienceLessonClient
      experienceSlug={experienceSlug}
      lessonId={lessonId}
    />
  );
}
