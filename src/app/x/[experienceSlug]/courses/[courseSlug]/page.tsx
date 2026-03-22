import { ExperienceCourseClient } from "@/components/experience/course-client";

export default async function ExperienceCoursePage({
  params,
}: {
  params: Promise<{ experienceSlug: string; courseSlug: string }>;
}) {
  const { experienceSlug, courseSlug } = await params;

  return (
    <ExperienceCourseClient
      experienceSlug={experienceSlug}
      courseSlug={courseSlug}
    />
  );
}
