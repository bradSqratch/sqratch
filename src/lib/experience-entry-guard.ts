import { headers } from "next/headers";
import { resolveExperienceEntry } from "@/lib/public-experience-entry";
import {
  clearViewerSessionCampaignContext,
  getViewerSessionRecord,
} from "@/lib/session";

/**
 * The single server-side entry policy for EVERY public Experience page
 * (`/x/:slug` and all its sub-routes). It must run before any Experience data
 * is resolved.
 *
 * A request keeps the visitor's session campaign only when it carries a valid
 * signed `campaignEntry` token for that exact campaign (campaign handoff or
 * login return), or is a same-Experience navigation (bottom tabs, lesson links).
 * Anything else — typed URL, bookmark, external link, another Experience, the
 * app home — is a DIRECT entry and clears the stale campaign first. The session
 * campaign is never granted here, only kept or cleared, and it is still
 * validated against the Experience's campaigns downstream.
 */
export async function enforceExperienceEntryContext(options: {
  experienceSlug: string;
  campaignEntry?: string | string[] | null;
}) {
  const token = Array.isArray(options.campaignEntry)
    ? null
    : options.campaignEntry ?? null;
  // The session campaign only matters for matching a token, so skip the lookup
  // when there is none.
  const viewerSession = token ? await getViewerSessionRecord() : null;
  const requestHeaders = await headers();
  const entry = resolveExperienceEntry({
    token,
    experienceSlug: options.experienceSlug,
    sessionCampaignId: viewerSession?.campaignId ?? null,
    referer: requestHeaders.get("referer"),
    host: requestHeaders.get("x-forwarded-host") || requestHeaders.get("host"),
    secFetchSite: requestHeaders.get("sec-fetch-site"),
  });

  if (!entry.keepSessionCampaign) {
    await clearViewerSessionCampaignContext();
  }

  return entry;
}
