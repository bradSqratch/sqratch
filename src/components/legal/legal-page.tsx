import CommonNavbar from "@/components/commonNavbar";
import SiteFooter from "@/components/home/site-footer";
import type {
  LegalBlock,
  LegalDocument,
  LegalSection,
} from "@/content/legal/types";

function renderText(text: string) {
  const parts = text.split(
    /(support@sqratch\.com|https:\/\/sqratch\.com\/privacy|\bnot\b)/g,
  );

  return parts.map((part, index) => {
    if (part === "support@sqratch.com") {
      return (
        <a
          key={`${part}-${index}`}
          href="mailto:support@sqratch.com"
          className="font-medium text-purple-200 underline decoration-purple-200/35 underline-offset-4 transition hover:decoration-purple-200"
        >
          {part}
        </a>
      );
    }

    if (part === "https://sqratch.com/privacy") {
      return (
        <a
          key={`${part}-${index}`}
          href="/privacy"
          className="font-medium text-purple-200 underline decoration-purple-200/35 underline-offset-4 transition hover:decoration-purple-200"
        >
          {part}
        </a>
      );
    }

    if (part === "not") {
      return (
        <strong
          key={`${part}-${index}`}
          className="font-semibold text-white/90"
        >
          {part}
        </strong>
      );
    }

    return part;
  });
}

function LegalBlockContent({ block }: { block: LegalBlock }) {
  if (block.type === "subheading") {
    return (
      <h3 className="pt-3 text-[17px] font-semibold tracking-[-0.01em] text-white sm:text-[18px]">
        {block.text}
      </h3>
    );
  }

  if (block.type === "bullets") {
    return (
      <ul className="space-y-2.5 pl-1">
        {block.items.map((item) => (
          <li key={item} className="flex gap-3">
            <span className="mt-[0.72rem] h-1.5 w-1.5 shrink-0 rounded-full bg-purple-200/75" />
            {block.code ? (
              <code className="rounded-md border border-emerald-300/15 bg-emerald-300/8 px-2 py-0.5 font-mono text-[0.9em] text-emerald-200">
                {item}
              </code>
            ) : (
              <span>{renderText(item)}</span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  if (block.type === "contact") {
    return (
      <address className="not-italic leading-7 text-white/78">
        {block.lines.map((line) => (
          <span key={line} className="block">
            {renderText(line)}
          </span>
        ))}
      </address>
    );
  }

  if (block.type === "definitions") {
    return (
      <dl className="space-y-4">
        {block.items.map((item) => (
          <div key={item.term}>
            <dt className="inline font-semibold text-white/90">{item.term}</dt>
            <dd className="inline"> {renderText(item.description)}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return <p>{renderText(block.text)}</p>;
}

function LegalSectionContent({ section }: { section: LegalSection }) {
  if (section.blocks) {
    return (
      <div className="mt-5 space-y-4 text-[15px] leading-7 text-white/72 sm:text-[16px] sm:leading-8">
        {section.blocks.map((block, index) => (
          <LegalBlockContent
            key={`${section.title}-${block.type}-${index}`}
            block={block}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      {section.paragraphs ? (
        <div className="mt-4 space-y-4 text-[15px] leading-7 text-white/72 sm:text-[16px] sm:leading-8">
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{renderText(paragraph)}</p>
          ))}
        </div>
      ) : null}

      {section.bullets ? (
        <ul className="mt-4 space-y-2 text-[15px] leading-7 text-white/72 sm:text-[16px] sm:leading-8">
          {section.bullets.map((bullet) => (
            <li key={bullet} className="flex gap-3">
              <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-purple-200/75" />
              <span>{renderText(bullet)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function LegalPage({ document }: { document: LegalDocument }) {
  const usesStructuredBlocks = document.sections.some(
    (section) => section.blocks,
  );

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
            <div className="mx-auto max-w-3xl">
              <div className="space-y-5 text-[15px] leading-7 text-white/76 sm:text-[16px] sm:leading-8">
                {document.intro.map((paragraph) => (
                  <p key={paragraph}>{renderText(paragraph)}</p>
                ))}
              </div>

              <div
                className={
                  usesStructuredBlocks
                    ? "mt-10 divide-y divide-white/10"
                    : "mt-10 space-y-8"
                }
              >
                {document.sections.map((section) => (
                  <section
                    key={section.title}
                    className={
                      usesStructuredBlocks
                        ? "py-8 first:pt-0 last:pb-0 sm:py-10"
                        : "rounded-3xl border border-white/10 bg-black/20 p-5 sm:p-6"
                    }
                  >
                    <h2 className="text-xl font-semibold tracking-[-0.01em] text-purple-200 sm:text-2xl">
                      {section.title}
                    </h2>

                    <LegalSectionContent section={section} />
                  </section>
                ))}
              </div>
            </div>
          </article>
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
