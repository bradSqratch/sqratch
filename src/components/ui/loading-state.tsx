import { cn } from "@/lib/utils";

type LoadingStateProps = {
  label?: string;
  className?: string;
};

export function LoadingState({
  label = "Loading…",
  className,
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/70",
        className,
      )}
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="size-3 animate-spin rounded-full border-2 border-violet-200/30 border-t-violet-200"
      />
      <span>{label}</span>
    </div>
  );
}
