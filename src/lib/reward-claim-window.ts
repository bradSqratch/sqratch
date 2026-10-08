/**
 * Claim-window helpers for the reward editor. The editor uses `<input type="datetime-local">`, whose value is browser-local
 * wall time with minute precision and no offset. These helpers convert explicitly through the platform's local-time rules,
 * so DST offsets come from the date itself, never from "now". The claim window (when a reward can be claimed) is independent
 * of coupon validity (how long an issued coupon stays usable).
 */
export const DEFAULT_CLAIM_WINDOW_DAYS = 30;

const pad = (value: number) => String(value).padStart(2, "0");

/** A `datetime-local` value (YYYY-MM-DDTHH:mm) for an instant, in the browser's local time. */
export function toLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Parses a `datetime-local` value as browser-local wall time. Blank or malformed values are null. A wall time that does not
 * exist (inside a spring-forward DST gap) is normalized by the platform to the next valid instant.
 */
export function fromLocalDateTimeInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isFinite(date.getTime()) && date.getMonth() === month - 1 ? date : null;
}

/**
 * The prefilled window for a NEW reward, computed when the form is created (never at module load): starts now (to the minute)
 * and ends 30 calendar days later at the same local wall time, even across a DST change.
 */
export function defaultClaimWindow(now: Date = new Date()): { starts: string; ends: string } {
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + DEFAULT_CLAIM_WINDOW_DAYS);
  return { starts: toLocalDateTimeInput(start), ends: toLocalDateTimeInput(end) };
}

/** Client-side check matching the server rule (end strictly after start). Blank sides are open-ended. */
export function claimWindowError(starts: string, ends: string): string | null {
  const start = starts ? fromLocalDateTimeInput(starts) : null;
  const end = ends ? fromLocalDateTimeInput(ends) : null;
  if (starts && !start) return "Enter a valid claim start date and time.";
  if (ends && !end) return "Enter a valid claim end date and time.";
  if (start && end && end.getTime() <= start.getTime()) return "Claim end must be after claim start.";
  return null;
}

/** UTC ISO string for the API, or null for an open-ended side. */
export function claimWindowIso(value: string): string | null {
  return value ? fromLocalDateTimeInput(value)?.toISOString() ?? null : null;
}
