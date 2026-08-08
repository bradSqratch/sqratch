import crypto from "crypto";

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
}) {
  const payload = Buffer.from(
    JSON.stringify({
      campaignId: options.campaignId,
      experienceSlug: options.experienceSlug,
      expiresAt: (options.now ?? Date.now()) + TOKEN_TTL_MS,
    } satisfies CampaignExperienceEntryPayload),
  ).toString("base64url");

  return `${TOKEN_VERSION}.${payload}.${sign(payload)}`;
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
