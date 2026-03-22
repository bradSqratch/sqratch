import { redirect } from "next/navigation";

export default function LegacyPrintQrPage() {
  redirect("/dashboard/admin/campaigns");
}
