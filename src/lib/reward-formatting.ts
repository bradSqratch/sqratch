/**
 * Pure reward-formatting helpers, safe to import from Server Components,
 * Client Components, and plain server-side lib code alike. No "use client",
 * no React, no browser-only APIs — only Intl formatting.
 */

export function formatRewardMoney(cents: number | null, currencyCode: string) {
  if (cents === null || cents === undefined) return "";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currencyCode,
  }).format(cents / 100);
}

export function formatRewardPercentage(basisPoints: number | null) {
  if (basisPoints === null || basisPoints === undefined) return "";
  const pct = basisPoints / 100;
  return `${Number(pct.toFixed(2))}%`;
}
