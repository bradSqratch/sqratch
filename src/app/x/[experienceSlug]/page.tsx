import { notFound } from "next/navigation";
import { ExperienceHubClient } from "@/components/experience/hub-client";
import { loadPublicExperience } from "@/lib/public-experience";
import { enforceExperienceEntryContext } from "@/lib/experience-entry-guard";

export default async function ExperienceHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ experienceSlug: string }>;
  searchParams: Promise<{ campaignEntry?: string | string[] }>;
}) {
  const { experienceSlug } = await params;
  const query = await searchParams;
  // `/x/:slug` opened manually/directly is the direct/unscoped entry point; a
  // stale campaign session is cleared before Experience data is resolved.
  await enforceExperienceEntryContext({
    experienceSlug,
    campaignEntry: query.campaignEntry,
  });

  const result = await loadPublicExperience(experienceSlug);

  if (!result) {
    notFound();
  }

  return (
    <ExperienceHubClient
      experienceSlug={experienceSlug}
      initialData={result.data}
    />
  );
}
