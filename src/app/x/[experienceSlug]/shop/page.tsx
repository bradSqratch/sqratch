import { ExperienceShopClient } from "@/components/experience/shop-client";
import { enforceExperienceEntryContext } from "@/lib/experience-entry-guard";

export default async function ExperienceShopPage({
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

  return <ExperienceShopClient experienceSlug={experienceSlug} />;
}
