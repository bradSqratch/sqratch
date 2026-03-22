import { ExperienceQAClient } from "@/components/experience/qa-client";

export default async function ExperienceQAPage({
  params,
}: {
  params: Promise<{ experienceSlug: string }>;
}) {
  const { experienceSlug } = await params;

  return <ExperienceQAClient experienceSlug={experienceSlug} />;
}
