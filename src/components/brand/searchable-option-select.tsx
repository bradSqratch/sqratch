"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { useLatestRequest } from "@/hooks/use-latest-request";

export type PickedOption = { id: string; name: string };
type OptionItem = PickedOption & { detail: string | null };
type OptionsPage = { items: OptionItem[]; nextCursor: string | null };

/**
 * A filter choice that searches the server instead of listing everything, so
 * a brand with thousands of batches or campaigns can still find any of them.
 * Results arrive a page at a time; "Load more" follows the server cursor.
 */
export function SearchableOptionSelect({
  label,
  type,
  value,
  onChange,
  allLabel,
  params,
  includeAll = true,
}: {
  label: string;
  type: "batches" | "campaigns";
  value: PickedOption | null;
  onChange: (option: PickedOption | null) => void;
  allLabel: string;
  /** Extra query parameters, for example the archived view or a campaign scope. */
  params?: Record<string, string | null | undefined>;
  includeAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<OptionItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useLatestRequest();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const paramsKey = JSON.stringify(params ?? {});

  const load = useCallback(
    async (cursor: string | null) => {
      const request = beginRequest();
      setLoading(true);
      setError(null);
      try {
        const search = new URLSearchParams({ type, limit: "25" });
        if (query.trim()) search.set("q", query.trim());
        if (cursor) search.set("cursor", cursor);
        for (const [key, entry] of Object.entries(JSON.parse(paramsKey) as Record<string, string | null | undefined>)) {
          if (entry) search.set(key, entry);
        }
        const page = await fetchJson<OptionsPage>(`/api/brand/qr-batches/options?${search.toString()}`, { signal: request.signal });
        if (!request.isCurrent()) return;
        setItems((current) => (cursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (loadError) {
        if (request.isCurrent()) setError(getErrorMessage(loadError, "Could not load options."));
      } finally {
        if (request.isCurrent()) setLoading(false);
      }
    },
    [beginRequest, type, query, paramsKey],
  );

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(null), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [open, load, query]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown as unknown as EventListener);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown as unknown as EventListener);
    };
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(option: PickedOption | null) {
    onChange(option);
    setQuery("");
    close();
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-3 text-sm text-copy-70">
      <span id={`${listId}-label`}>{label}</span>
      <button
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        aria-labelledby={`${listId}-label`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
        className="h-10 min-w-[220px] max-w-[280px] truncate rounded-xl border border-edge/10 bg-inset/20 px-3 text-left text-sm text-ink"
      >
        {value ? value.name : allLabel}
      </button>
      {open ? (
        <div
          className="absolute left-0 top-12 z-30 w-[320px] rounded-xl border border-edge/20 bg-card p-3 shadow-xl dark:bg-[#050814]"
          role="group"
          aria-label={`${label} choices`}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <input
            autoFocus
            type="search"
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}...`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-2 h-9 w-full rounded-lg border border-edge/10 bg-inset/20 px-3 text-sm text-ink"
          />
          <ul id={listId} className="max-h-60 overflow-y-auto">
            {includeAll ? (
              <li>
                <button type="button" onClick={() => choose(null)} aria-current={!value ? "true" : undefined} className="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-glass-10">
                  {allLabel}
                </button>
              </li>
            ) : null}
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => choose({ id: item.id, name: item.name })}
                  aria-current={value?.id === item.id ? "true" : undefined}
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-glass-10"
                >
                  <span className="block truncate">{item.name}</span>
                  {item.detail ? <span className="block truncate text-xs text-copy-55">{item.detail}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {loading ? <p className="px-2 py-1 text-xs text-copy-60">Loading...</p> : null}
          {!loading && !error && items.length === 0 ? <p className="px-2 py-1 text-xs text-copy-60">No matches.</p> : null}
          {error ? (
            <p role="alert" className="px-2 py-1 text-xs text-red-700 dark:text-red-300">
              {error}{" "}
              <button type="button" className="underline" onClick={() => void load(null)}>
                Retry
              </button>
            </p>
          ) : null}
          {nextCursor && !loading ? (
            <button type="button" onClick={() => void load(nextCursor)} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-copy-70 underline">
              Load more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
