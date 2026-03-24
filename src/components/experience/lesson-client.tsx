"use client";

import Image from "next/image";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { ExperienceShell, GatePanel, LoadingView, ErrorView, PageCard } from "@/components/experience/experience-shell";
import type { ExperienceShellData } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";

type YouTubePlayer = {
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  destroy?: () => void;
};

type YouTubePlayerState = {
  PLAYING: number;
  PAUSED: number;
  ENDED: number;
};

type YouTubePlayerFactory = new (
  elementId: string,
  options: {
    videoId: string;
    playerVars?: Record<string, string | number>;
    events?: {
      onReady?: (event: { target: YouTubePlayer }) => void;
      onStateChange?: (event: { target: YouTubePlayer; data: number }) => void;
    };
  },
) => YouTubePlayer;

type YouTubeNamespace = {
  Player: YouTubePlayerFactory;
  PlayerState?: YouTubePlayerState;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

type LessonResponse = {
  experience: ExperienceShellData;
  course: {
    id: string;
    title: string;
    access: "PUBLIC" | "PRIVATE";
  };
  lesson: {
    id: string;
    title: string;
    description: string | null;
    videoSource: "YOUTUBE" | "UPLOAD";
    youtubeUrl: string | null;
    videoAssetUrl: string | null;
  };
  previousLesson: {
    id: string;
    title: string;
  } | null;
  nextLesson: {
    id: string;
    title: string;
  } | null;
  canAccess: boolean;
};

type LessonProgressResponse = {
  lessonProgress: Array<{
    lessonId: string;
    isCompleted: boolean;
    lastPositionSeconds: number;
    updatedAt: string;
  }>;
  courseProgress: Array<{
    courseId: string;
    totalLessons: number;
    completedLessons: number;
    progressPercent: number;
  }>;
};

type LessonProductsResponse = {
  items: Array<{
    id: string;
    productUrl: string;
    title: string | null;
    imageUrl: string | null;
    priceText: string | null;
    currency: string | null;
    brandId: string | null;
  }>;
};

async function loadYouTubeApi() {
  if (window.YT?.Player) {
    return window.YT;
  }

  await new Promise<void>((resolve) => {
    const existingScript = document.getElementById("youtube-iframe-api");

    if (!existingScript) {
      const script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(script);
    }

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };

    if (window.YT?.Player) {
      resolve();
    }
  });

  return window.YT;
}

function extractYouTubeId(url: string) {
  try {
    const parsed = new URL(url);

    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace("/", "");
    }

    if (parsed.searchParams.get("v")) {
      return parsed.searchParams.get("v");
    }

    const parts = parsed.pathname.split("/");
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

export function ExperienceLessonClient({
  experienceSlug,
  lessonId,
}: {
  experienceSlug: string;
  lessonId: string;
}) {
  const [data, setData] = useState<LessonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LessonProgressResponse | null>(null);
  const [products, setProducts] = useState<LessonProductsResponse["items"]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [clickingProductId, setClickingProductId] = useState<string | null>(null);
  const ytPlayerRef = useRef<YouTubePlayer | null>(null);
  const ytPollRef = useRef<number | null>(null);
  const playerId = useId();
  const startedSentRef = useRef(false);
  const completedSentRef = useRef(false);
  const lastProgressSentAtRef = useRef(0);
  const submittingRef = useRef(false);

  const currentLessonProgress = progress?.lessonProgress[0] || null;

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [lessonResult, progressResult] = await Promise.all([
          fetchJson<LessonResponse>(
            `/api/public/experience/${experienceSlug}/lessons/${lessonId}`,
          ),
          fetchJson<LessonProgressResponse>(`/api/progress/lesson?lessonId=${lessonId}`),
        ]);

        setData(lessonResult);
        setProgress(progressResult);
      } catch (error) {
        setError(getErrorMessage(error, "Failed to load lesson."));
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [experienceSlug, lessonId]);

  useEffect(() => {
    if (!data?.canAccess) {
      setProducts([]);
      setProductsError(null);
      setProductsLoading(false);
      return;
    }

    async function loadProducts() {
      setProductsLoading(true);
      setProductsError(null);

      try {
        const result = await fetchJson<LessonProductsResponse>(
          `/api/public/experience/${experienceSlug}/lessons/${lessonId}/products`,
        );
        setProducts(result.items);
      } catch (error) {
        setProductsError(
          getErrorMessage(error, "Failed to load lesson products."),
        );
      } finally {
        setProductsLoading(false);
      }
    }

    void loadProducts();
  }, [data?.canAccess, experienceSlug, lessonId]);

  const sendProgress = useCallback(async (
    seconds: number,
    eventName: "lesson_started" | "lesson_progress" | "lesson_completed",
    isCompleted: boolean,
    duration?: number,
  ) => {
    if (submittingRef.current) {
      return;
    }

    submittingRef.current = true;

    try {
      const progressResult = await fetchJson<{
        sessionId: string;
        progress: {
          lessonId: string;
          lastPositionSeconds: number;
          isCompleted: boolean;
          updatedAt: string;
        };
      }>("/api/progress/lesson", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lessonId,
          lastPositionSeconds: Math.floor(seconds),
          isCompleted,
          eventName,
          progressPercent:
            duration && duration > 0
              ? Math.min(100, Math.round((seconds / duration) * 100))
              : null,
        }),
      });

      setProgress((previous) => ({
        lessonProgress: [
          {
            lessonId: progressResult.progress.lessonId,
            lastPositionSeconds: progressResult.progress.lastPositionSeconds,
            isCompleted: progressResult.progress.isCompleted,
            updatedAt: progressResult.progress.updatedAt,
          },
        ],
        courseProgress: previous?.courseProgress || [],
      }));
    } catch (error) {
      console.error("Failed to save lesson progress:", error);
    } finally {
      submittingRef.current = false;
    }
  }, [lessonId]);

  const maybeSendProgress = useCallback((
    seconds: number,
    duration: number,
    force = false,
  ) => {
    const now = Date.now();

    if (!force && now - lastProgressSentAtRef.current < 15000) {
      return;
    }

    lastProgressSentAtRef.current = now;

    const percent = duration > 0 ? seconds / duration : 0;
    const isCompleted = percent >= 0.95;

    void sendProgress(
      seconds,
      isCompleted ? "lesson_completed" : "lesson_progress",
      isCompleted,
      duration,
    );

    if (isCompleted) {
      completedSentRef.current = true;
    }
  }, [sendProgress]);

  function handleOpenProduct(product: LessonProductsResponse["items"][number]) {
    setClickingProductId(product.id);
    window.open(product.productUrl, "_blank", "noopener,noreferrer");

    fetch(
      `/api/public/experience/${experienceSlug}/lessons/${lessonId}/products`,
      {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productLinkId: product.id,
          productUrl: product.productUrl,
        }),
      },
    ).finally(() => {
      setClickingProductId((current) =>
        current === product.id ? null : current,
      );
    });
  }

  useEffect(() => {
    if (!data?.canAccess) {
      return;
    }

    if (data.lesson.videoSource !== "YOUTUBE" || !data.lesson.youtubeUrl) {
      return;
    }

    const videoId = extractYouTubeId(data.lesson.youtubeUrl);

    if (!videoId) {
      return;
    }

    let cancelled = false;

    void loadYouTubeApi().then((YT) => {
      if (cancelled) {
        return;
      }

      if (!YT?.Player) {
        return;
      }

      ytPlayerRef.current = new YT.Player(playerId, {
        videoId,
        playerVars: {
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: (event: { target: YouTubePlayer }) => {
            const resumeAt = currentLessonProgress?.lastPositionSeconds || 0;
            if (resumeAt > 0) {
              event.target.seekTo(resumeAt, true);
            }
          },
          onStateChange: (event: { target: YouTubePlayer; data: number }) => {
            const player = event.target;
            const playerState = window.YT?.PlayerState;

            if (event.data === playerState?.PLAYING) {
              if (!startedSentRef.current) {
                startedSentRef.current = true;
                void sendProgress(
                  player.getCurrentTime(),
                  "lesson_started",
                  false,
                  player.getDuration(),
                );
              }

              if (ytPollRef.current) {
                window.clearInterval(ytPollRef.current);
              }

              ytPollRef.current = window.setInterval(() => {
                const currentTime = player.getCurrentTime();
                const duration = player.getDuration();
                maybeSendProgress(currentTime, duration);
              }, 5000);
            }

            if (event.data === playerState?.PAUSED) {
              const currentTime = player.getCurrentTime();
              const duration = player.getDuration();
              maybeSendProgress(currentTime, duration, true);
            }

            if (event.data === playerState?.ENDED && !completedSentRef.current) {
              completedSentRef.current = true;
              void sendProgress(
                player.getDuration(),
                "lesson_completed",
                true,
                player.getDuration(),
              );
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (ytPollRef.current) {
        window.clearInterval(ytPollRef.current);
      }
      ytPlayerRef.current?.destroy?.();
      ytPlayerRef.current = null;
    };
  }, [currentLessonProgress, data, lessonId, maybeSendProgress, playerId, sendProgress]);

  if (loading) {
    return <LoadingView label="Loading lesson..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Lesson not found."} />;
  }

  return (
    <ExperienceShell
      experience={data.experience}
      activeTab="learn"
      actions={
        <div className="space-y-3">
          <Button
            asChild
            variant="outline"
            className="w-full rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            <Link href={`/x/${data.experience.slug}/courses/${data.course.id}`}>
              Back to Course
            </Link>
          </Button>
          {data.nextLesson && (
            <Button
              asChild
              className="w-full rounded-full border border-white bg-white text-black"
            >
              <Link href={`/x/${data.experience.slug}/lessons/${data.nextLesson.id}`}>
                Next Lesson
              </Link>
            </Button>
          )}
        </div>
      }
    >
      {!data.canAccess ? (
        <GatePanel
          experience={data.experience}
          title="This Lesson Is Locked"
          description="Private lesson playback opens after you log in and unlock the linked campaign."
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <PageCard className="overflow-hidden">
            <div className="space-y-6">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                  {data.course.title}
                </p>
                <h2 className="mt-2 text-3xl font-semibold">{data.lesson.title}</h2>
                {data.lesson.description && (
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-white/70">
                    {data.lesson.description}
                  </p>
                )}
              </div>

              {data.lesson.videoSource === "UPLOAD" && data.lesson.videoAssetUrl ? (
                <video
                  controls
                  className="aspect-video w-full rounded-3xl border border-white/10 bg-black"
                  src={data.lesson.videoAssetUrl}
                  onLoadedMetadata={(event) => {
                    const resumeAt =
                      currentLessonProgress?.lastPositionSeconds || 0;

                    if (
                      resumeAt > 0 &&
                      event.currentTarget.duration > resumeAt + 5
                    ) {
                      event.currentTarget.currentTime = resumeAt;
                    }
                  }}
                  onPlay={(event) => {
                    if (!startedSentRef.current) {
                      startedSentRef.current = true;
                      void sendProgress(
                        event.currentTarget.currentTime,
                        "lesson_started",
                        false,
                        event.currentTarget.duration,
                      );
                    }
                  }}
                  onTimeUpdate={(event) =>
                    maybeSendProgress(
                      event.currentTarget.currentTime,
                      event.currentTarget.duration,
                    )
                  }
                  onEnded={(event) => {
                    if (completedSentRef.current) {
                      return;
                    }

                    completedSentRef.current = true;
                    void sendProgress(
                      event.currentTarget.duration,
                      "lesson_completed",
                      true,
                      event.currentTarget.duration,
                    );
                  }}
                />
              ) : (
                <div
                  id={playerId}
                  className="aspect-video w-full overflow-hidden rounded-3xl border border-white/10 bg-black"
                />
              )}
            </div>
          </PageCard>

          <div className="space-y-6">
            <PageCard>
              <h3 className="text-xl font-semibold">Progress</h3>
              <p className="mt-3 text-sm text-white/65">
                {currentLessonProgress?.isCompleted
                  ? "Completed"
                  : currentLessonProgress?.lastPositionSeconds
                    ? `Resume from ${currentLessonProgress.lastPositionSeconds}s`
                    : "Not started yet"}
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                {data.previousLesson && (
                  <Button
                    asChild
                    variant="outline"
                    className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                  >
                    <Link
                      href={`/x/${data.experience.slug}/lessons/${data.previousLesson.id}`}
                    >
                      Previous
                    </Link>
                  </Button>
                )}
                {data.nextLesson && (
                  <Button
                    asChild
                    className="rounded-full border border-white bg-white text-black"
                  >
                    <Link
                      href={`/x/${data.experience.slug}/lessons/${data.nextLesson.id}`}
                    >
                      Next
                    </Link>
                  </Button>
                )}
              </div>
            </PageCard>

            <PageCard>
              <h3 className="text-xl font-semibold">Related Products</h3>
              <div className="mt-5 space-y-4">
                {productsLoading ? (
                  <p className="text-sm text-white/65">
                    Loading lesson products...
                  </p>
                ) : productsError ? (
                  <p className="text-sm text-red-300">{productsError}</p>
                ) : products.length === 0 ? (
                  <p className="text-sm text-white/65">
                    No products are linked to this lesson yet.
                  </p>
                ) : (
                  products.map((product) => (
                    <div
                      key={product.id}
                      className="rounded-3xl border border-white/10 bg-black/20 p-4"
                    >
                      <div className="flex items-center gap-4">
                        {product.imageUrl ? (
                          <Image
                            src={product.imageUrl}
                            alt={product.title || "Lesson product"}
                            width={64}
                            height={64}
                            className="h-16 w-16 rounded-2xl object-cover"
                          />
                        ) : (
                          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/8 text-xs text-white/45">
                            Link
                          </div>
                        )}
                        <div>
                          <p className="font-medium">
                            {product.title || "Shop product"}
                          </p>
                          {product.priceText && (
                            <p className="mt-1 text-sm text-white/55">
                              {product.priceText}
                            </p>
                          )}
                        </div>
                      </div>

                      <Button
                        type="button"
                        onClick={() => handleOpenProduct(product)}
                        disabled={clickingProductId === product.id}
                        className="mt-4 w-full rounded-full border border-white bg-white text-black"
                      >
                        {clickingProductId === product.id
                          ? "Opening..."
                          : "View on Shopify"}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </PageCard>
          </div>
        </div>
      )}
    </ExperienceShell>
  );
}
