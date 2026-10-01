import crypto from "crypto";
import type { PublicExperienceEntryContext } from "@/lib/campaign-context";

/**
 * A short-lived, server-signed proof that navigation into an Experience came
 * from a specific Campaign page.  `/x/:slug` itself deliberately means a
 * direct (unscoped) entry, so an old `UserSession.campaignId` must not be
 * enough to keep a visitor in campaign context.
 *
 * This is intentionally an integrity token, not an authorization token.  The
 * receiving Experience still validates the session campaign against its own
 * CampaignExperience rows before using it anywhere.
 */
type CampaignExperienceEntryPayload = {
  campaignId: string;
  experienceSlug: string;
  expiresAt: number;
};

const TOKEN_VERSION = "v1";
const TOKEN_TTL_MS = 2 * 60 * 1000;
// A login/signup/verify round-trip is far slower than a page hop, so the token
// that carries campaign context back from auth lives longer.  It is still
// bounded, bound to one Experience, and only ever matched against the
// visitor's own session campaign.
const RETURN_TOKEN_TTL_MS = 60 * 60 * 1000;

function getSigningSecret() {
  const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;

  if (!secret) {
    throw new Error("NEXTAUTH_SECRET or AUTH_SECRET is required for campaign Experience entry.");
  }

  return secret;
}

function sign(payload: string) {
  return crypto
    .createHmac("sha256", getSigningSecret())
    .update(`${TOKEN_VERSION}.${payload}`)
    .digest("base64url");
}

function safelyDecodePayload(encoded: string): CampaignExperienceEntryPayload | null {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;

    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as CampaignExperienceEntryPayload).campaignId !== "string" ||
      typeof (value as CampaignExperienceEntryPayload).experienceSlug !== "string" ||
      !Number.isFinite((value as CampaignExperienceEntryPayload).expiresAt)
    ) {
      return null;
    }

    return value as CampaignExperienceEntryPayload;
  } catch {
    return null;
  }
}

export function createCampaignExperienceEntryToken(options: {
  campaignId: string;
  experienceSlug: string;
  now?: number;
  ttlMs?: number;
}) {
  const payload = Buffer.from(
    JSON.stringify({
      campaignId: options.campaignId,
      experienceSlug: options.experienceSlug,
      expiresAt: (options.now ?? Date.now()) + (options.ttlMs ?? TOKEN_TTL_MS),
    } satisfies CampaignExperienceEntryPayload),
  ).toString("base64url");

  return `${TOKEN_VERSION}.${payload}.${sign(payload)}`;
}

/**
 * Proof, carried in the login/signup `next` URL, that the visitor leaving an
 * Experience page for auth was legitimately in this campaign context.  Minted
 * only from a server-validated CAMPAIGN entry context; returns null for a
 * DIRECT visitor (or if signing is unavailable), so no token means no context.
 */
export function mintCampaignReturnToken(options: {
  entryContext: PublicExperienceEntryContext;
  experienceSlug: string;
  now?: number;
}): string | null {
  if (options.entryContext.kind !== "CAMPAIGN") {
    return null;
  }

  try {
    return createCampaignExperienceEntryToken({
      campaignId: options.entryContext.campaignId,
      experienceSlug: options.experienceSlug,
      now: options.now,
      ttlMs: RETURN_TOKEN_TTL_MS,
    });
  } catch {
    return null;
  }
}

export function verifyCampaignExperienceEntryToken(options: {
  token: string | null | undefined;
  experienceSlug: string;
  now?: number;
}): string | null {
  const token = options.token || "";
  const [version, encodedPayload, suppliedSignature, ...rest] = token.split(".");

  if (
    version !== TOKEN_VERSION ||
    !encodedPayload ||
    !suppliedSignature ||
    rest.length > 0
  ) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  const suppliedBytes = Buffer.from(suppliedSignature);
  const expectedBytes = Buffer.from(expectedSignature);

  if (
    suppliedBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null;
  }

  const payload = safelyDecodePayload(encodedPayload);

  if (
    !payload ||
    payload.experienceSlug !== options.experienceSlug ||
    payload.expiresAt < (options.now ?? Date.now())
  ) {
    return null;
  }

  return payload.campaignId;
}

/**
 * True only when the request is a same-origin navigation that originated from
 * a page of the SAME Experience (`/x/:slug` or `/x/:slug/...`) — i.e. a visitor
 * pressing a tab such as WHY while already inside the Experience.
 *
 * The signed handoff token above only proves the Campaign -> Experience hop and
 * expires after minutes, so it cannot be what keeps a visitor in campaign
 * context for the rest of the visit. The browser-controlled `Referer` (which
 * page scripts cannot forge) and `Sec-Fetch-Site` headers are the signal for
 * "still navigating inside this Experience".  A manually typed URL, a
 * bookmark, an external site, another Experience, or the visitor's home page
 * carries none of these, so it stays a DIRECT entry.
 *
 * This never grants or selects a campaign: it only declines to clear the
 * visitor's existing session campaign, which is still validated against the
 * Experience's CampaignExperience rows before use.  A missing/stripped Referer
 * fails closed to DIRECT.
 */
export function isSameExperienceNavigation(options: {
  referer: string | null | undefined;
  host: string | null | undefined;
  secFetchSite?: string | null;
  experienceSlug: string;
}): boolean {
  const { referer, host, secFetchSite, experienceSlug } = options;

  if (!referer || !host || !experienceSlug) {
    return false;
  }

  if (secFetchSite && secFetchSite !== "same-origin") {
    return false;
  }

  let refererUrl: URL;

  try {
    refererUrl = new URL(referer);
  } catch {
    return false;
  }

  if (
    (refererUrl.protocol !== "https:" && refererUrl.protocol !== "http:") ||
    refererUrl.host.toLowerCase() !== host.toLowerCase()
  ) {
    return false;
  }

  const [, root, slugSegment] = refererUrl.pathname.split("/");

  if (root !== "x" || !slugSegment) {
    return false;
  }

  try {
    return decodeURIComponent(slugSegment) === experienceSlug;
  } catch {
    return false;
  }
}

/**
 * Decides whether a request for ANY public Experience page (`/x/:slug`,
 * `/x/:slug/shop`, `/learn`, `/posts`, `/qa`, courses and lessons) keeps the
 * visitor's session campaign context or is a DIRECT entry that must clear it.
 *
 *  - `signed_entry`: a valid, unexpired token (campaign handoff, or a
 *    login-return token minted by an Experience page) naming the exact campaign
 *    the cookie-backed session is stamped with.
 *  - `in_experience_navigation`: the visitor navigated here from another page
 *    of this same Experience (bottom tabs, lesson links).
 *  - `direct`: anything else, including forged/expired/mismatched tokens.
 */
export function resolveExperienceEntry(options: {
  token: string | null | undefined;
  experienceSlug: string;
  sessionCampaignId: string | null | undefined;
  referer: string | null | undefined;
  host: string | null | undefined;
  secFetchSite?: string | null;
  now?: number;
}): { keepSessionCampaign: boolean; reason: "signed_entry" | "in_experience_navigation" | "direct" } {
  const signedCampaignId = verifyCampaignExperienceEntryToken({
    token: options.token,
    experienceSlug: options.experienceSlug,
    now: options.now,
  });

  if (signedCampaignId && options.sessionCampaignId === signedCampaignId) {
    return { keepSessionCampaign: true, reason: "signed_entry" };
  }

  if (
    isSameExperienceNavigation({
      referer: options.referer,
      host: options.host,
      secFetchSite: options.secFetchSite,
      experienceSlug: options.experienceSlug,
    })
  ) {
    return { keepSessionCampaign: true, reason: "in_experience_navigation" };
  }

  return { keepSessionCampaign: false, reason: "direct" };
}
