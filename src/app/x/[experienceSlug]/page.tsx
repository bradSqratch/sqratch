import { notFound } from "next/navigation";
import { ExperienceHubClient } from "@/components/experience/hub-client";
import { loadPublicExperience } from "@/lib/public-experience";

export default async function ExperienceHubPage({
  params,
}: {
  params: Promise<{ experienceSlug: string }>;
}) {
  const { experienceSlug } = await params;
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
