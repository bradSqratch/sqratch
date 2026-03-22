import { redirect } from "next/navigation";

export default function AdminUsersRedirectPage() {
  redirect("/admin/user-management");
}
