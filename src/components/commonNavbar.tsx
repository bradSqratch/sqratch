import Link from "next/link";
import { SqratchLogo } from "@/components/brand/sqratch-logo";
import { PublicThemeToggle } from "@/components/theme-select";

export type CommonNavbarProps = {
  logoHref?: string;
  showAdminLogin?: boolean;
  variant?: "dark" | "light";
};

export default function CommonNavbar({
  logoHref = "/",
  showAdminLogin = false,
  variant = "dark",
}: CommonNavbarProps) {
  const isLight = variant === "light";

  return (
    <header
      className={
        isLight
          ? "fixed inset-x-0 top-0 z-50 border-b border-black/5 bg-card/85 backdrop-blur-md"
          : `
        fixed top-0 left-0 right-0 z-50
        bg-card/85 dark:bg-black/80
        backdrop-blur-sm
        shadow-[inset_0_-1px_0_rgba(0,50,53,0.2)]
      `
      }
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-3 py-2 sm:px-6 lg:px-8">
        <Link href={logoHref} className="flex items-center">
          <SqratchLogo
            priority
            className="h-[22px] w-auto drop-shadow-[0_0_22px_rgba(255,255,255,0.4)] sm:h-[24px] md:h-[26px]"
          />
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          {showAdminLogin && (
            <Link
              href="/login"
              className={`inline-flex items-center justify-center rounded-full
                  border bg-transparent
                  h-8 px-3 text-[12px] sm:h-9 sm:px-4 sm:text-[13px] md:h-10 md:px-5 md:text-[14px]
                  leading-none font-normal transition-colors whitespace-nowrap ${
                    isLight
                      ? "border-black/20 text-black hover:bg-black hover:text-white"
                      : "border-edge text-ink hover:bg-primary hover:text-primary-foreground"
                  }`}
            >
              Admin Login
            </Link>
          )}
          <PublicThemeToggle />
        </div>

        {/* Actions */}
        {/* <div className="flex items-center gap-4">
              <Link
                href="https://calendly.com/sqratch"
                className="
                  inline-flex items-center justify-center rounded-full
                  border border-edge bg-transparent
                  h-8 px-3 text-[12px] sm:h-9 sm:px-4 sm:text-[13px] md:h-10 md:px-5 md:text-[14px]
                  leading-none font-normal text-ink
                  hover:bg-primary hover:text-primary-foreground transition-colors
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
