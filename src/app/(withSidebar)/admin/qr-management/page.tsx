import { redirect } from "next/navigation";

export default function LegacyQrManagementPage() {
  redirect("/dashboard/admin/campaigns");
}
