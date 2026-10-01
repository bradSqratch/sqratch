import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ExperienceHubClient } from "@/components/experience/hub-client";
import { loadPublicExperience } from "@/lib/public-experience";
import { resolveExperienceHubEntry } from "@/lib/public-experience-entry";
import {
  clearViewerSessionCampaignContext,
  getViewerSessionRecord,
} from "@/lib/session";

export default async function ExperienceHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ experienceSlug: string }>;
  searchParams: Promise<{ campaignEntry?: string | string[] }>;
}) {
  const { experienceSlug } = await params;
  const query = await searchParams;
  const signedToken = Array.isArray(query.campaignEntry)
    ? null
    : query.campaignEntry;
  const viewerSession = await getViewerSessionRecord();
  const requestHeaders = await headers();
  // A signed handoff token proves the Campaign -> Experience hop; bottom-tab
  // navigation inside the Experience (e.g. Shop -> WHY) is recognised from the
  // browser's same-origin Referer.  Either way the cookie-backed session
  // campaign is what is kept, and it is re-validated against this
  // Experience's campaigns downstream.  Every other entry is DIRECT.
  const entry = resolveExperienceHubEntry({
    token: signedToken,
    experienceSlug,
    sessionCampaignId: viewerSession?.campaignId ?? null,
    referer: requestHeaders.get("referer"),
    host: requestHeaders.get("x-forwarded-host") || requestHeaders.get("host"),
    secFetchSite: requestHeaders.get("sec-fetch-site"),
  });

  // `/x/:slug` opened manually/directly (typed URL, bookmark, external link,
  // another page of the app) is the direct/unscoped public entry point: a
  // stale campaign session is explicitly cleared before Experience data is
  // resolved.
  if (!entry.keepSessionCampaign) {
    await clearViewerSessionCampaignContext();
  }

  const result = await loadPublicExperience(experienceSlug);

  if (!result) {
    notFound();
  }

  return (
    <ExperienceHubClient
      experienceSlug={experienceSlug}
      initialData={result.data}
    />
  );
}
