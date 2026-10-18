"use client";

import { Moon, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

const subscribe = () => () => {};

export function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);

  return (
    <label className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-background/80 px-2.5 py-1.5 text-foreground">
      <SunMoon aria-hidden="true" className="size-4" />
      <span className="sr-only">Appearance</span>
      <select
        aria-label="Appearance"
        className="max-w-20 cursor-pointer rounded-sm bg-transparent text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={mounted ? theme : "system"}
        disabled={!mounted}
        onChange={(event) => setTheme(event.target.value)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

/** Compact public-site control that follows the system until manually toggled. */
export function PublicThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="rounded-full border border-edge/15 bg-background/60 text-foreground shadow-sm backdrop-blur-sm hover:bg-accent hover:text-accent-foreground"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      disabled={!mounted}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? (
        <Moon aria-hidden="true" className="size-4" />
      ) : (
        <Sun aria-hidden="true" className="size-4" />
      )}
    </Button>
  );
}
