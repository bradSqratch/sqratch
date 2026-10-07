import { resolveCommerceClickAnalyticsDateRange } from "./commerce-click-analytics";

export function defaultBrandAnalyticsDates(now: Date) {
  const result = resolveCommerceClickAnalyticsDateRange({ now });
  if (!result.ok) throw new Error(result.error);
  return {
    dateFrom: result.range.start.toISOString().slice(0, 10),
    dateTo: result.range.end.toISOString().slice(0, 10),
  };
}

/** Empty controls are incomplete input, never implicit server defaults. */
export function brandAnalyticsDateError(dateFrom: string, dateTo: string): string | null {
  if (!dateFrom || !dateTo) return "Choose both From and To dates to load analytics.";
  const result = resolveCommerceClickAnalyticsDateRange({ dateFrom, dateTo });
  return result.ok ? null : result.error;
}
