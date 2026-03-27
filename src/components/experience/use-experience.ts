"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ensurePublicSession,
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";

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

export function useExperience(experienceSlug: string) {
  const [data, setData] = useState<PublicExperienceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      await ensurePublicSession();
      const result = await fetchJson<PublicExperienceData>(
        `/api/public/experience/${experienceSlug}`,
      );
      setData(result);
    } catch (error) {
      setError(getErrorMessage(error, "Failed to load experience."));
    } finally {
      setLoading(false);
    }
  }, [experienceSlug]);

  useEffect(() => {
    if (!experienceSlug) {
      return;
    }

    void load();
  }, [experienceSlug, load]);

  return {
    data,
    loading,
    error,
    reload: load,
  };
}
