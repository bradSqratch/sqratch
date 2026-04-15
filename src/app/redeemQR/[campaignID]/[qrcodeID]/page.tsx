import { redirect } from "next/navigation";

type Props = {
  params: Promise<{
    campaignID: string;
    qrcodeID: string;
  }>;
};

export default async function LegacyRedeemQRPage({ params }: Props) {
  const { qrcodeID } = await params;
  redirect(`/q/${encodeURIComponent(qrcodeID)}`);
}
