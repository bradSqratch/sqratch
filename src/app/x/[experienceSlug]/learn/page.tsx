import { ExperienceLearnClient } from "@/components/experience/learn-client";

export default async function ExperienceLearnPage({
  params,
}: {
  params: Promise<{ experienceSlug: string }>;
}) {
  const { experienceSlug } = await params;

  return <ExperienceLearnClient experienceSlug={experienceSlug} />;
}
