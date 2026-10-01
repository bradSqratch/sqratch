import { ExperiencePostsClient } from "@/components/experience/posts-client";
import { enforceExperienceEntryContext } from "@/lib/experience-entry-guard";

export default async function ExperiencePostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ experienceSlug: string }>;
  searchParams: Promise<{ campaignEntry?: string | string[] }>;
}) {
  const { experienceSlug } = await params;
  const query = await searchParams;

  // Direct/external entry to any Experience route must not inherit a stale
  // campaign; see `enforceExperienceEntryContext`.
  await enforceExperienceEntryContext({
    experienceSlug,
    campaignEntry: query.campaignEntry,
  });

  return <ExperiencePostsClient experienceSlug={experienceSlug} />;
}
