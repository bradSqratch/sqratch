import { ExperienceLessonClient } from "@/components/experience/lesson-client";

export default async function ExperienceLessonPage({
  params,
}: {
  params: Promise<{ experienceSlug: string; lessonId: string }>;
}) {
  const { experienceSlug, lessonId } = await params;

  return (
    <ExperienceLessonClient
      experienceSlug={experienceSlug}
      lessonId={lessonId}
    />
  );
}
