import { ExperienceShopClient } from "@/components/experience/shop-client";

export default async function ExperienceShopPage({
  params,
}: {
  params: Promise<{ experienceSlug: string }>;
}) {
  const { experienceSlug } = await params;

  return <ExperienceShopClient experienceSlug={experienceSlug} />;
}
