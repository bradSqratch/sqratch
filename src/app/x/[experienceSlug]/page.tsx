import { notFound } from "next/navigation";
import { ExperienceHubClient } from "@/components/experience/hub-client";
import { loadPublicExperience } from "@/lib/public-experience";
import { verifyCampaignExperienceEntryToken } from "@/lib/public-experience-entry";
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
  const signedCampaignEntry = Array.isArray(query.campaignEntry)
    ? null
    : verifyCampaignExperienceEntryToken({
        token: query.campaignEntry,
        experienceSlug,
      });
  const viewerSession = signedCampaignEntry
    ? await getViewerSessionRecord()
    : null;
  // The token is only a proof of the handoff URL; require the cookie-backed
  // session that the handoff route just stamped to name that exact campaign.
  // A replayed token must never preserve some other stale campaign context.
  const campaignEntry =
    signedCampaignEntry && viewerSession?.campaignId === signedCampaignEntry
      ? signedCampaignEntry
      : null;

  // `/x/:slug` is the direct/unscoped public entry point.  A campaign page
  // uses a short-lived server-signed handoff token; anything else — including
  // a stale campaign session — is explicitly cleared before Experience data
  // is resolved.
  if (!campaignEntry) {
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
