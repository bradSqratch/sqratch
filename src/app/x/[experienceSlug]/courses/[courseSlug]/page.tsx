import { ExperienceCourseClient } from "@/components/experience/course-client";
import { enforceExperienceEntryContext } from "@/lib/experience-entry-guard";

export default async function ExperienceCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ experienceSlug: string; courseSlug: string }>;
  searchParams: Promise<{ campaignEntry?: string | string[] }>;
}) {
  const { experienceSlug, courseSlug } = await params;
  const query = await searchParams;

  // Direct/external entry to any Experience route must not inherit a stale
  // campaign; see `enforceExperienceEntryContext`.
  await enforceExperienceEntryContext({
    experienceSlug,
    campaignEntry: query.campaignEntry,
  });

  return (
    <ExperienceCourseClient
      experienceSlug={experienceSlug}
      courseSlug={courseSlug}
    />
  );
}
