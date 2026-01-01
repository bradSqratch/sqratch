import Link from "next/link";

type CommonNavbarProps = {
  showAdminLogin?: boolean;
};

export default function CommonNavbar({
  showAdminLogin = false,
}: CommonNavbarProps) {
  return (
    <header
      className="
        fixed top-0 left-0 right-0 z-50
        bg-black/80
        backdrop-blur-sm
        shadow-[inset_0_-1px_0_rgba(0,50,53,0.2)]
      "
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-3 py-2 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2">
          <span
            className="
              text-white font-semibold tracking-[-0.03em]
              text-[20px] sm:text-[22px] md:text-[24px]
              drop-shadow-[0_0_22px_rgba(255,255,255,0.4)]
              whitespace-nowrap
              flex items-start gap-1
            "
          >
            <span>SQRATCH</span>
            <sup className="relative top-1.5 md:top-2 -left-1 text-[7px] sm:text-[8px] md:text-[9px] leading-none">
              TM
            </sup>
          </span>
        </Link>

        {showAdminLogin && (
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-full
                  border border-[#ECECEC] bg-transparent
                  h-8 px-3 text-[12px] sm:h-9 sm:px-4 sm:text-[13px] md:h-10 md:px-5 md:text-[14px]
                  leading-none font-normal text-[#ECECEC]
                  hover:bg-white hover:text-black transition-colors
                  whitespace-nowrap"
            >
              Admin Login
            </Link>
          </div>
        )}

        {/* Actions */}
        {/* <div className="flex items-center gap-4">
              <Link
                href="https://calendly.com/sqratch/30min"
                className="
                  inline-flex items-center justify-center rounded-full
                  border border-[#ECECEC] bg-transparent
                  h-8 px-3 text-[12px] sm:h-9 sm:px-4 sm:text-[13px] md:h-10 md:px-5 md:text-[14px]
                  leading-none font-normal text-[#ECECEC]
                  hover:bg-white hover:text-black transition-colors
                  whitespace-nowrap
                "
              >
                Become a Partner
              </Link>
            </div> */}
      </div>
    </header>
  );
}
