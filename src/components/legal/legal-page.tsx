import CommonNavbar from "@/components/commonNavbar";
import SiteFooter from "@/components/home/site-footer";
import type { LegalDocument } from "@/content/legal/types";

export function LegalPage({ document }: { document: LegalDocument }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#020015] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_6%,rgba(99,102,241,0.28),rgba(2,0,21,0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_14%_28%,rgba(236,72,153,0.12),rgba(2,0,21,0)_62%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_86%_30%,rgba(34,211,238,0.08),rgba(2,0,21,0)_62%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(2,0,21,0)_35%,rgba(2,0,21,0.92)_100%)]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto w-full max-w-5xl px-6 pb-16 pt-28 sm:pt-32 lg:px-8">
          <div className="text-center">
            <p className="text-sm uppercase tracking-[0.28em] text-white/45">
              {document.eyebrow}
            </p>
            <h1 className="mt-4 bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)] bg-clip-text text-[40px] font-bold leading-[105%] tracking-[-0.03em] text-transparent drop-shadow-[0_0_12px_rgba(236,236,236,0.45)] sm:text-[56px] lg:text-[64px]">
              {document.title}
            </h1>
            <div className="mt-5 flex flex-col items-center justify-center gap-2 text-sm text-white/58 sm:flex-row sm:gap-4">
              <span>Effective Date: {document.effectiveDate}</span>
              <span className="hidden text-white/25 sm:inline">•</span>
              <span>Company: {document.company}</span>
              <span className="hidden text-white/25 sm:inline">•</span>
              <a
                href={`mailto:${document.contact}`}
                className="underline decoration-white/25 underline-offset-4 hover:decoration-white/70"
              >
                {document.contact}
              </a>
            </div>
          </div>

          <article className="mt-10 rounded-[28px] border border-white/15 bg-white/6 p-5 shadow-[0_30px_90px_rgba(0,0,0,0.55)] backdrop-blur-xl sm:p-8 lg:p-10">
            <div className="space-y-5 text-[15px] leading-7 text-white/76 sm:text-[16px] sm:leading-8">
              {document.intro.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>

            <div className="mt-10 space-y-8">
              {document.sections.map((section) => (
                <section
                  key={section.title}
                  className="rounded-3xl border border-white/10 bg-black/20 p-5 sm:p-6"
                >
                  <h2 className="text-xl font-semibold tracking-[-0.01em] text-purple-200 sm:text-2xl">
                    {section.title}
                  </h2>

                  {section.paragraphs ? (
                    <div className="mt-4 space-y-4 text-[15px] leading-7 text-white/72 sm:text-[16px] sm:leading-8">
                      {section.paragraphs.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                      ))}
                    </div>
                  ) : null}

                  {section.bullets ? (
                    <ul className="mt-4 space-y-2 text-[15px] leading-7 text-white/72 sm:text-[16px] sm:leading-8">
                      {section.bullets.map((bullet) => (
                        <li key={bullet} className="flex gap-3">
                          <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-purple-200/75" />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ))}
            </div>
          </article>
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
