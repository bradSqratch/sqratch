import { ExperiencePostsClient } from "@/components/experience/posts-client";

export default async function ExperiencePostsPage({
  params,
}: {
  params: Promise<{ experienceSlug: string }>;
}) {
  const { experienceSlug } = await params;

  return <ExperiencePostsClient experienceSlug={experienceSlug} />;
}
