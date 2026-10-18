import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

type AccessDeniedLinkAction = {
  label: string;
  href: string;
};

export function AccessDeniedPanel({
  title,
  description,
  requiredAccess,
  primaryAction,
  secondaryAction,
  children,
}: {
  title: string;
  description: string;
  requiredAccess?: string;
  primaryAction?: AccessDeniedLinkAction;
  secondaryAction?: AccessDeniedLinkAction;
  /** Extra actions that need client interactivity, e.g. a switch-account button. */
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6 sm:p-8">
      <div
        role="alert"
        aria-live="polite"
        className="w-full max-w-xl rounded-[28px] border border-edge/15 bg-glass-6 p-8 text-center shadow-[0_8px_28px_rgba(72,57,34,0.06)] dark:shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-10"
      >
        <p className="text-sm uppercase tracking-[0.25em] text-copy-45">
          Access restricted
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          {title}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-copy-70">
          {description}
        </p>
        {requiredAccess ? (
          <p className="mt-3 text-xs text-copy-45">
            Required access: {requiredAccess}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {primaryAction ? (
            <Button
              asChild
              type="button"
              className="rounded-full bg-primary px-6 text-primary-foreground hover:bg-primary/90"
            >
              <Link href={primaryAction.href}>{primaryAction.label}</Link>
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button
              asChild
              type="button"
              variant="outline"
              className="rounded-full border-edge/25 bg-transparent px-6 text-ink hover:bg-glass-10"
            >
              <Link href={secondaryAction.href}>{secondaryAction.label}</Link>
            </Button>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
