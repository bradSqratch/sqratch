/**
 * Deterministic email address validation shared by client and server code.
 *
 * Rules (RFC 5321/5322 "dot-atom" subset, ASCII only):
 * - exactly one "@"; whole address <= 254 chars, local part <= 64 chars
 * - local part: atext characters in dot-separated segments, so no leading,
 *   trailing or consecutive dots and no spaces or quotes
 * - domain: at least two labels, each 1-63 chars of letters, digits and inner
 *   hyphens (no leading/trailing hyphen), and a top-level label that is letters
 *   only (2-63) or a punycode label (xn--...). Bare hosts and IP literals are
 *   rejected on purpose: a login email must be deliverable on the public
 *   internet.
 *
 * Internationalised (non-ASCII) addresses are not accepted.
 */
export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;

const LOCAL_SEGMENT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TOP_LEVEL_LABEL = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;

export function isValidEmail(value: unknown): boolean {
  if (typeof value !== "string") return false;

  const email = value.trim();
  if (!email || email.length > MAX_EMAIL_LENGTH) return false;

  const parts = email.split("@");
  if (parts.length !== 2) return false;

  const [local, domain] = parts;
  if (!local || local.length > MAX_LOCAL_PART_LENGTH) return false;
  if (!local.split(".").every((segment) => LOCAL_SEGMENT.test(segment))) {
    return false;
  }

  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;

  return TOP_LEVEL_LABEL.test(labels[labels.length - 1]);
}

/** Trimmed, lowercased address, or null when it is not a valid email. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return isValidEmail(email) ? email : null;
}
