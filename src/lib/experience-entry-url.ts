/**
 * Client-safe helpers for the signed `campaignEntry` query parameter shared by
 * the campaign handoff redirect and the login/signup return URLs.
 */
export const CAMPAIGN_ENTRY_QUERY_PARAM = "campaignEntry";

const INTERNAL_URL_BASE = "https://sqratch.local";

/**
 * Adds (or replaces) the signed campaign-entry token on an internal path.
 * A missing token returns the path untouched, so a DIRECT visitor's login
 * return stays DIRECT.
 */
export function appendCampaignEntryToken(
  internalPath: string,
  token: string | null | undefined,
) {
  if (!token) {
    return internalPath;
  }

  const url = new URL(internalPath, INTERNAL_URL_BASE);
  url.searchParams.set(CAMPAIGN_ENTRY_QUERY_PARAM, token);

  return `${url.pathname}${url.search}${url.hash}`;
}
