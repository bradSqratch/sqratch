"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import type { PublicExperienceData } from "@/components/experience/types";

export function useExperience(
  experienceSlug: string,
  initialData: PublicExperienceData | null = null,
) {
  const [data, setData] = useState<PublicExperienceData | null>(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
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
    setData(initialData);
    setLoading(!initialData);
    setError(null);
  }, [experienceSlug, initialData]);

  useEffect(() => {
    if (!experienceSlug) {
      return;
    }

    if (initialData) {
      return;
    }

    void load();
  }, [experienceSlug, initialData, load]);

  return {
    data,
    loading,
    error,
    reload: load,
  };
}
