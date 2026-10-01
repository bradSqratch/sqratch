import { ExperienceQAClient } from "@/components/experience/qa-client";
import { enforceExperienceEntryContext } from "@/lib/experience-entry-guard";

export default async function ExperienceQAPage({
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

  return <ExperienceQAClient experienceSlug={experienceSlug} />;
}
