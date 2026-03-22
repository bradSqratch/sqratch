import { ExperienceHubClient } from "@/components/experience/hub-client";

export default async function ExperienceHubPage({
  params,
}: {
  params: Promise<{ experienceSlug: string }>;
}) {
  const { experienceSlug } = await params;

  return <ExperienceHubClient experienceSlug={experienceSlug} />;
}
