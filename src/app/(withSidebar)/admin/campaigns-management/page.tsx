import { redirect } from "next/navigation";

export default function LegacyCampaignsManagementPage() {
  redirect("/dashboard/admin/campaigns");
}
