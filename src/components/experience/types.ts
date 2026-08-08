export type ExperienceShellData = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  creator: {
    id?: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
  };
  campaigns: Array<{
    id: string;
    name: string;
    brand: {
      id: string;
      name: string;
      slug: string;
      logoUrl: string | null;
    } | null;
  }>;
  canAccessPrivate: boolean;
  canInteract: boolean;
  isLoggedIn: boolean;
  hasUnlockedCampaign: boolean;
  isCreatorOwner: boolean;
  hasRedeemedQrWarning: boolean;
  /** Server-resolved public acquisition context, never inferred client-side. */
  resolvedCampaignId?: string | null;
};

export type PublicExperienceData = ExperienceShellData & {
  /**
   * The campaign context resolved SERVER-SIDE for this visitor (see
   * `resolvePublicCampaignId`), or null when this Experience has two or more
   * eligible sponsors and the visitor carries no trusted campaign signal.
   * Always one of `campaigns[].id` when non-null. Clients must render a neutral
   * placeholder on null rather than falling back to `campaigns[0]`, which would
   * show one sponsor's branding to another sponsor's visitor.
   */
  resolvedCampaignId: string | null;
  featuredStory: {
    id: string;
    lessonId: string | null;
    kind: "EXPERIENCE" | "LESSON";
    title: string;
    courseTitle: string | null;
    videoSource: "YOUTUBE" | "UPLOAD";
    youtubeUrl: string | null;
    videoAssetUrl: string | null;
  } | null;
  courses: Array<{
    id: string;
    title: string;
    description: string | null;
    access: "PUBLIC" | "PRIVATE";
    lessonCount: number;
  }>;
  courseSummary: {
    visibleCourseCount: number;
    visibleLessonCount: number;
    publicCourseCount: number;
    privateCourseCount: number;
  };
  counts: {
    posts: number;
    questions: number;
  };
  qaDailyQuestionLimit: number;
};
