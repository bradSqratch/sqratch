import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { termsOfService } from "@/content/legal/terms";

export const metadata: Metadata = {
  title: "Terms of Service | SQRATCH",
  description: "Terms of Service for SQRATCH and the SQRATCH Shopify app.",
};

export default function TermsPage() {
  return <LegalPage document={termsOfService} />;
}
