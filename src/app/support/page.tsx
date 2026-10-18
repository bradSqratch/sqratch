import type { Metadata } from "next";
import Link from "next/link";
import CommonNavbar from "@/components/commonNavbar";
import SiteFooter from "@/components/home/site-footer";
import { Mail, MapPin, ShieldCheck } from "lucide-react";
import { PageFade } from "@/components/ui/page-fade";

export const metadata: Metadata = {
  title: "Support | SQRATCH",
  description: "Contact SQRATCH support.",
};

const SUPPORT_EMAIL = "support@sqratch.com";
const PRESS_EMAIL = "press@sqratch.com";

export default function SupportPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-page text-ink">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_8%,rgba(var(--glow-primary-rgb),0.30),rgba(var(--scene-rgb),0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_12%_30%,rgba(var(--glow-secondary-rgb),0.15),rgba(var(--scene-rgb),0)_62%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_88%_32%,rgba(var(--glow-tertiary-rgb),0.10),rgba(var(--scene-rgb),0)_62%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(var(--scene-rgb),0)_35%,rgba(var(--scene-rgb),0.92)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-section" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 pb-16 pt-28 sm:pt-32 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <PageFade as="p" variant="eyebrow" className="text-sm uppercase tracking-[0.28em] text-copy-45">
              Support
            </PageFade>
            <PageFade as="h1" variant="heading" className="mt-4 bg-[image:var(--heading-gradient)] bg-clip-text text-[40px] font-bold leading-[105%] tracking-[-0.03em] text-transparent drop-shadow-[0_0_12px_rgba(236,236,236,0.45)] sm:text-[56px] lg:text-[64px]">
              Contact SQRATCH
            </PageFade>
            <PageFade as="p" variant="supporting-text" className="mt-4 text-[16px] leading-[160%] text-copy-75 sm:text-[18px]">
              For account help, Shopify app questions, rewards, product links,
              or platform issues, contact SQRATCH support.
            </PageFade>
          </div>

          <PageFade as="section" variant="card" className="mt-10 rounded-[28px] border border-edge/15 bg-glass-6 p-6 shadow-[0_8px_28px_rgba(72,57,34,0.06)] dark:shadow-[0_30px_90px_rgba(0,0,0,0.55)] backdrop-blur-xl sm:p-8 lg:p-10">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-[22px] border border-edge/10 bg-inset/25 p-6">
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-glass-5 ring-1 ring-edge/10">
                    <Mail className="h-5 w-5 text-purple-700 dark:text-purple-200" />
                  </div>
                  <div>
                    <p className="text-[13px] uppercase tracking-[0.25em] text-copy-45">
                      Support email
                    </p>
                    <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
                      Product help
                    </h2>
                  </div>
                </div>

                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="mt-5 block break-all text-[20px] font-semibold text-ink underline decoration-white/25 underline-offset-4 transition hover:decoration-white/70"
                >
                  {SUPPORT_EMAIL}
                </a>
                <p className="mt-3 text-[15px] leading-7 text-copy-65">
                  Use this address for SQRATCH account access, Shopify app
                  installation, reward discount, and technical support.
                </p>
              </div>

              <div className="rounded-[22px] border border-edge/10 bg-inset/25 p-6">
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-glass-5 ring-1 ring-edge/10">
                    <Mail className="h-5 w-5 text-purple-700 dark:text-purple-200" />
                  </div>
                  <div>
                    <p className="text-[13px] uppercase tracking-[0.25em] text-copy-45">
                      Press email
                    </p>
                    <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
                      Media inquiries
                    </h2>
                  </div>
                </div>

                <a
                  href={`mailto:${PRESS_EMAIL}`}
                  className="mt-5 block break-all text-[20px] font-semibold text-ink underline decoration-white/25 underline-offset-4 transition hover:decoration-white/70"
                >
                  {PRESS_EMAIL}
                </a>
                <p className="mt-3 text-[15px] leading-7 text-copy-65">
                  Use this address for press, speaking, and media inquiries.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <div className="rounded-[22px] border border-edge/10 bg-inset/25 p-6">
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-glass-5 ring-1 ring-edge/10">
                    <MapPin className="h-5 w-5 text-purple-700 dark:text-purple-200" />
                  </div>
                  <div>
                    <p className="text-[13px] uppercase tracking-[0.25em] text-copy-45">
                      Company
                    </p>
                    <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
                      Sqratch Inc.
                    </h2>
                  </div>
                </div>

                <p className="mt-5 text-[17px] leading-8 text-copy-78">
                  280 Albert Street, Suite 706,
                  <br />
                  Ottawa ON K1P 5P3
                </p>
              </div>

              <div className="rounded-[22px] border border-edge/10 bg-inset/25 p-6">
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-glass-5 ring-1 ring-edge/10">
                    <ShieldCheck className="h-5 w-5 text-purple-700 dark:text-purple-200" />
                  </div>
                  <div>
                    <p className="text-[13px] uppercase tracking-[0.25em] text-copy-45">
                      Legal
                    </p>
                    <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
                      Policies
                    </h2>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <Link
                    href="/privacy"
                    className="rounded-full border border-edge/15 bg-glass-5 px-4 py-2 text-[14px] text-copy-90 transition hover:bg-glass-10"
                  >
                    Privacy Policy
                  </Link>
                  <Link
                    href="/terms"
                    className="rounded-full border border-edge/15 bg-glass-5 px-4 py-2 text-[14px] text-copy-90 transition hover:bg-glass-10"
                  >
                    Terms of Service
                  </Link>
                </div>
              </div>
            </div>
          </PageFade>
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
