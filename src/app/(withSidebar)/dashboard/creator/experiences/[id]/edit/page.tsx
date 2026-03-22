import { CreatorExperienceForm } from "@/components/creator/experience-form";

export default async function CreatorEditExperiencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <CreatorExperienceForm mode="edit" experienceId={id} />;
}
