import { BrandCampaignForm } from "@/components/brand/campaign-form";

export default async function BrandEditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <BrandCampaignForm mode="edit" campaignId={id} />;
}
