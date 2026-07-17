import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { getBrandAdminContext } from "@/lib/brand-auth";

export default async function GenerateQRRedirectPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (session.user.role === "BRAND_ADMIN") {
    const context = await getBrandAdminContext();
    if (context?.membership) {
      redirect("/dashboard/brand/qr-batches/new");
    }
    if (context?.selectionRequired) {
      redirect("/dashboard/brand/profile");
    }
  }

  if (session.user.role === "ADMIN") {
    const context = await getBrandAdminContext();
    if (context?.membership) {
      redirect("/dashboard/brand/qr-batches/new");
    }
    if (context?.selectionRequired) {
      redirect("/dashboard/brand/profile");
    }
  }

  // Redirect all others (including unauthorized brand admins and old users)
  redirect("/dashboard");
}
