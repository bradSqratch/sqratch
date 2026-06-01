import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="bg-[#020121] py-16 md:py-20">
      <div className="mx-auto max-w-6xl px-6 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-12">
          <div className="flex flex-col gap-12 md:grid md:grid-cols-2 md:gap-12">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-4">
                <h3 className="text-[22px] md:text-[24px] font-bold leading-7.25 tracking-[-0.01em] text-purple-300">
                  Get in Touch - Partners, Press, & Collaborations
                </h3>

                <div className="flex flex-col gap-2.5 text-[16px] md:text-[18px] leading-5.5 tracking-[-0.01em] text-white">
                  <p className="whitespace-normal wrap-break-word">
                    <span className="font-semibold">
                      Press and Speaking Inquiries:
                    </span>{" "}
                    <a
                      href="mailto:press@sqratch.com"
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                    >
                      press@sqratch.com
                    </a>
                  </p>

                  <p className="whitespace-normal wrap-break-word">
                    <span className="font-semibold">
                      Investor & Partner Inquiries:
                    </span>{" "}
                    <a
                      href="mailto:investors@sqratch.com"
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                    >
                      investors@sqratch.com
                    </a>
                  </p>

                  <p className="whitespace-normal wrap-break-word">
                    <span className="font-semibold">Support:</span>{" "}
                    <a
                      href="mailto:support@sqratch.com"
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                    >
                      support@sqratch.com
                    </a>
                  </p>

                  <p>
                    To inquire about creating a custom SQRATCH campaign for your
                    retail or consumer packaged goods brand, please contact{" "}
                    <a
                      href="mailto:campaigns@sqratch.com"
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                    >
                      campaigns@sqratch.com
                    </a>{" "}
                    or book a half hour discovery session on{" "}
                    <a
                      href="https://calendly.com/sqratch/30min"
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                    >
                      Calendly here
                    </a>
                    .
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-10 pl-0 md:max-w-sm md:pl-20">
              <div className="flex flex-col gap-2">
                <h3 className="text-[22px] md:text-[24px] font-bold leading-7.25 tracking-[-0.01em] text-purple-300">
                  Address
                </h3>
                <div className="flex flex-col gap-0">
                  <Link
                    href="https://sqratch.com/"
                    className="text-[22px] font-semibold tracking-[-0.03em] text-[#ECECEC] whitespace-nowrap hover:text-white transition"
                  >
                    Sqratch Inc.
                  </Link>
                  <p className="max-w-65 text-[16px] md:text-[18px] leading-5.5 tracking-[-0.01em] text-white">
                    280 Albert Street, Suite 706, <br />
                    Ottawa ON K1P 5P3
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                <h3 className="text-[22px] md:text-[24px] font-bold leading-7.25 tracking-[-0.01em] text-purple-300">
                  Social
                </h3>
                <div className="flex flex-col gap-1.5 text-[16px] md:text-[18px] leading-5.5 tracking-[-0.01em] text-white">
                  <a
                    href="https://www.instagram.com/getsqratch"
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-[#CDCDCD]"
                  >
                    Instagram
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-6 border-t border-white/10 pt-8 md:grid md:grid-cols-2 md:items-center md:gap-12">
            <div className="flex flex-row gap-4 text-[14px] md:text-[16px] text-[#939393] tracking-[-0.01em]">
              <Link href="/support" className="hover:text-[#ECECEC]">
                Support
              </Link>
              <span className="text-[#939393]">•</span>
              <Link href="/terms" className="hover:text-[#ECECEC]">
                Terms of Service
              </Link>
              <span className="text-[#939393]">•</span>
              <Link href="/privacy" className="hover:text-[#ECECEC]">
                Privacy Policy
              </Link>
            </div>

            <p className="text-left text-[14px] md:text-[16px] text-[#939393] tracking-[-0.01em] md:pl-20">
              © {new Date().getFullYear()} SQRATCH Inc. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
