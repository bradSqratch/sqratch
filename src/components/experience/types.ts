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
};

export type PublicExperienceData = ExperienceShellData & {
  featuredStory: {
    id: string;
    lessonId: string | null;
    kind: "CAMPAIGN" | "LESSON";
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
