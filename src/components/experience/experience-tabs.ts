export type ExperienceTab = "hub" | "learn" | "posts" | "qa" | "shop";

export const EXPERIENCE_TAB_KEYS: readonly ExperienceTab[] = [
  "hub",
  "learn",
  "posts",
  "qa",
  "shop",
];

// Plain, token-free URLs on purpose: campaign context across tabs is kept by
// the server recognising same-Experience navigation, not by URL parameters.
const tabHrefMap: Record<ExperienceTab, (slug: string) => string> = {
  hub: (slug) => `/x/${slug}`,
  learn: (slug) => `/x/${slug}/learn`,
  posts: (slug) => `/x/${slug}/posts`,
  qa: (slug) => `/x/${slug}/qa`,
  shop: (slug) => `/x/${slug}/shop`,
};

export function experienceTabHref(tab: ExperienceTab, slug: string) {
  return tabHrefMap[tab](slug);
}
