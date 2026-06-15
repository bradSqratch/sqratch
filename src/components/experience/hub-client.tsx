"use client";

import Link from "next/link";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import {
  ExperienceShell,
  GatePanel,
  LoadingView,
  ErrorView,
  PageCard,
} from "@/components/experience/experience-shell";
import { postBeacon } from "@/components/experience/client-utils";
import type { PublicExperienceData } from "@/components/experience/types";
import { useExperience } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type HubYouTubePlayer = {
  playVideo?: () => void;
  pauseVideo?: () => void;
  getPlayerState?: () => number;
  getCurrentTime?: () => number;
  getDuration?: () => number;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  destroy?: () => void;
};

type HubYouTubePlayerState = {
  PLAYING: number;
  PAUSED: number;
  ENDED: number;
};

type MeasuredDescriptionPreview = {
  source: string;
  text: string;
  isTruncated: boolean;
};

type HubYouTubePlayerFactory = new (
  elementId: string,
  options: {
    videoId: string;
    playerVars?: Record<string, string | number>;
    events?: {
      onReady?: (event: { target: HubYouTubePlayer }) => void;
      onStateChange?: (event: {
        target: HubYouTubePlayer;
        data: number;
      }) => void;
    };
  },
) => HubYouTubePlayer;

type HubYouTubeNamespace = {
  Player: HubYouTubePlayerFactory;
  PlayerState?: HubYouTubePlayerState;
};

type HubWindow = Window &
  typeof globalThis & {
    YT?: HubYouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  };

async function loadYouTubeApi() {
  const hubWindow = window as HubWindow;

  if (hubWindow.YT?.Player) {
    return hubWindow.YT;
  }

  await new Promise<void>((resolve) => {
    const existingScript = document.getElementById("youtube-iframe-api");

    if (!existingScript) {
      const script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(script);
    }

    const previousReady = hubWindow.onYouTubeIframeAPIReady;
    hubWindow.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };

    if (hubWindow.YT?.Player) {
      resolve();
    }
  });

  return (window as HubWindow).YT;
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

function formatPlaybackTime(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function ExperienceHubClient({
  experienceSlug,
  initialData = null,
}: {
  experienceSlug: string;
  initialData?: PublicExperienceData | null;
}) {
  const { data, loading, error } = useExperience(experienceSlug, initialData);
  const [activeTab, setActiveTab] = useState("learn");
  const trackedViewSlugRef = useRef<string | null>(null);

  useEffect(() => {
    if (!data) {
      return;
    }

    if (trackedViewSlugRef.current === experienceSlug) {
      return;
    }

    trackedViewSlugRef.current = experienceSlug;
    postBeacon(`/api/public/experience/${experienceSlug}`);
  }, [data, experienceSlug]);

  if (loading) {
    return <LoadingView label="Loading experience..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Experience not found."} />;
  }

  return (
    <ExperienceShell
      experience={data}
      activeTab="hub"
      hero={<ExperienceWhyHero data={data} />}
    >
      <div className="grid gap-4 md:grid-cols-3 xl:hidden">
        <PageCard>
          <p className="text-sm text-white/55">Visible courses</p>
          <p className="mt-2 text-4xl font-semibold">
            {data.courseSummary.visibleCourseCount}
          </p>
        </PageCard>
        <PageCard>
          <p className="text-sm text-white/55">Posts</p>
          <p className="mt-2 text-4xl font-semibold">{data.counts.posts}</p>
        </PageCard>
        <PageCard>
          <p className="text-sm text-white/55">Q&amp;A threads</p>
          <p className="mt-2 text-4xl font-semibold">{data.counts.questions}</p>
        </PageCard>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mt-2 space-y-6 lg:mt-20"
      >
        <TabsList className="rounded-full border border-white/10 bg-white/6 p-1">
          <TabsTrigger
            value="learn"
            className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
          >
            Learn
          </TabsTrigger>
          <TabsTrigger
            value="posts"
            className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
          >
            Posts
          </TabsTrigger>
          <TabsTrigger
            value="qa"
            className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
          >
            Q&amp;A
          </TabsTrigger>
        </TabsList>

        <TabsContent value="learn">
          <PageCard>
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-[#988dbf]">Learn</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                  Public courses are available immediately. Private courses open
                  after login and campaign unlock.
                </p>
              </div>
              <Button
                asChild
                className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
              >
                <Link href={`/x/${data.slug}/learn`}>View All Courses</Link>
              </Button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {data.courses.slice(0, 4).map((course) => (
                <div
                  key={course.id}
                  className="rounded-3xl border border-white/10 bg-black/20 p-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-[#988dbf]">{course.title}</h3>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                      {course.access}
                    </span>
                  </div>
                  {course.description && (
                    <p className="mt-3 text-sm leading-6 text-white/70">
                      {course.description}
                    </p>
                  )}
                  <p className="mt-4 text-xs uppercase tracking-[0.24em] text-white/45">
                    {course.lessonCount} lessons
                  </p>
                </div>
              ))}
            </div>
          </PageCard>
        </TabsContent>

        <TabsContent value="posts">
          {data.canInteract ? (
            <PageCard>
              <h2 className="text-2xl font-semibold text-[#988dbf]">Creator Posts</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                Discussions, drops, and creator updates live here. Commenting is
                available once you have access.
              </p>
              <div className="mt-6 flex items-center justify-between rounded-3xl border border-white/10 bg-black/20 p-5">
                <div>
                  <p className="text-sm text-white/55">Current feed size</p>
                  <p className="mt-2 text-3xl font-semibold">
                    {data.counts.posts}
                  </p>
                </div>
                <Button
                  asChild
                  className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
                >
                  <Link href={`/x/${data.slug}/posts`}>Open Posts</Link>
                </Button>
              </div>
            </PageCard>
          ) : (
            <GatePanel
              experience={data}
              title="Posts Are Locked"
              description="Log in and unlock the linked campaign to join the creator feed and comment on posts."
            />
          )}
        </TabsContent>

        <TabsContent value="qa">
          {data.canInteract ? (
            <PageCard>
              <h2 className="text-2xl font-semibold text-[#988dbf]">Q&amp;A</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                Ask the creator questions directly. Your daily limit for this
                experience is {data.qaDailyQuestionLimit}.
              </p>
              <div className="mt-6 flex items-center justify-between rounded-3xl border border-white/10 bg-black/20 p-5">
                <div>
                  <p className="text-sm text-white/55">Questions so far</p>
                  <p className="mt-2 text-3xl font-semibold">
                    {data.counts.questions}
                  </p>
                </div>
                <Button
                  asChild
                  className="rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
                >
                  <Link href={`/x/${data.slug}/qa`}>Open Q&amp;A</Link>
                </Button>
              </div>
            </PageCard>
          ) : (
            <GatePanel
              experience={data}
              title="Q&A Is Locked"
              description="Log in and unlock the linked campaign to ask questions and follow creator answers."
            />
          )}
        </TabsContent>
      </Tabs>
    </ExperienceShell>
  );
}

function ExperienceWhyHero({
  data,
}: {
  data: ReturnType<typeof useExperience>["data"];
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ytPlayerRef = useRef<HubYouTubePlayer | null>(null);
  const centerControlTimeoutRef = useRef<number | null>(null);
  const descriptionCardRef = useRef<HTMLDivElement | null>(null);
  const descriptionMeasureRef = useRef<HTMLParagraphElement | null>(null);
  const descriptionMeasureTextRef = useRef<HTMLSpanElement | null>(null);
  const descriptionMeasureSuffixRef = useRef<HTMLSpanElement | null>(null);
  const descriptionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const playerId = useId();
  const [isPlaying, setIsPlaying] = useState(false);
  const [showCenterControl, setShowCenterControl] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [descriptionPreview, setDescriptionPreview] =
    useState<MeasuredDescriptionPreview | null>(null);
  const [useRightSheet, setUseRightSheet] = useState(false);

  const featuredStory = data?.featuredStory || null;
  const primaryCampaign = data?.campaigns[0] || null;
  const campaignName = primaryCampaign?.name || "Campaign";
  const brandName = primaryCampaign?.brand?.name || "Brand";
  const description =
    data?.description || "This experience is waiting for its story.";

  useEffect(() => {
    setIsPlaying(false);
    setShowCenterControl(true);
    setCurrentTime(0);
    setDuration(0);
    setDescriptionOpen(false);
  }, [featuredStory?.id]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const syncSheetSide = () => setUseRightSheet(mediaQuery.matches);

    syncSheetSide();
    mediaQuery.addEventListener("change", syncSheetSide);
    window.addEventListener("resize", syncSheetSide);

    return () => {
      mediaQuery.removeEventListener("change", syncSheetSide);
      window.removeEventListener("resize", syncSheetSide);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const card = descriptionCardRef.current;
    const measurement = descriptionMeasureRef.current;
    const measurementText = descriptionMeasureTextRef.current;
    const measurementSuffix = descriptionMeasureSuffixRef.current;

    if (!card || !measurement || !measurementText || !measurementSuffix) {
      return;
    }

    let lastWidth = card.getBoundingClientRect().width;

    const updatePreview = () => {
      if (cancelled) return;

      const rect = card.getBoundingClientRect();
      const width = rect.width;

      const lineHeight = Number.parseFloat(
        window.getComputedStyle(measurement).lineHeight,
      );

      if (!Number.isFinite(lineHeight) || width <= 0) {
        return;
      }

      const maxHeight = lineHeight * 3 + 1;
      const fits = (text: string, includeSuffix: boolean) => {
        measurementText.textContent = text;
        measurementSuffix.style.display = includeSuffix ? "inline" : "none";
        return measurement.scrollHeight <= maxHeight;
      };

      let nextPreview: MeasuredDescriptionPreview;

      if (fits(description, false)) {
        nextPreview = {
          source: description,
          text: description,
          isTruncated: false,
        };
      } else {
        const words = description.trim().split(/\s+/);
        let low = 0;
        let high = words.length;

        while (low < high) {
          const midpoint = Math.ceil((low + high) / 2);
          const candidate = words.slice(0, midpoint).join(" ");

          if (fits(candidate, true)) {
            low = midpoint;
          } else {
            high = midpoint - 1;
          }
        }

        let text = words.slice(0, low).join(" ");
        // Trim trailing punctuation (.,;:!? etc.) to avoid duplicate punctuation before the ellipsis
        text = text.replace(/[,.;:!?\s\-_]+$/, "");
        nextPreview = {
          source: description,
          text,
          isTruncated: true,
        };
      }

      setDescriptionPreview((current) =>
        current?.source === nextPreview.source &&
        current.text === nextPreview.text &&
        current.isTruncated === nextPreview.isTruncated
          ? current
          : nextPreview,
      );
    };

    const resizeObserver = new ResizeObserver((entries) => {
      if (cancelled) return;
      const entry = entries[0];
      if (entry) {
        const width = entry.contentRect.width;
        if (width !== lastWidth) {
          lastWidth = width;
          updatePreview();
        }
      }
    });

    updatePreview();
    resizeObserver.observe(card);

    void document.fonts?.ready.then(() => {
      if (!cancelled) {
        updatePreview();
      }
    });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
    };
  }, [description, isPlaying]);

  useEffect(() => {
    return () => {
      if (centerControlTimeoutRef.current) {
        window.clearTimeout(centerControlTimeoutRef.current);
      }
    };
  }, []);

  function updateCenterControlVisibility(shouldStayVisible: boolean) {
    if (centerControlTimeoutRef.current) {
      window.clearTimeout(centerControlTimeoutRef.current);
    }

    setShowCenterControl(true);

    if (shouldStayVisible) {
      return;
    }

    centerControlTimeoutRef.current = window.setTimeout(() => {
      setShowCenterControl(false);
    }, 950);
  }

  useEffect(() => {
    if (
      !featuredStory ||
      featuredStory.videoSource !== "YOUTUBE" ||
      !featuredStory.youtubeUrl
    ) {
      return;
    }

    const videoId = extractYouTubeId(featuredStory.youtubeUrl);

    if (!videoId) {
      return;
    }

    let cancelled = false;

    void loadYouTubeApi().then((YT) => {
      if (cancelled || !YT?.Player) {
        return;
      }

      ytPlayerRef.current = new YT.Player(playerId, {
        videoId,
        playerVars: {
          rel: 0,
          modestbranding: 1,
          controls: 0,
          playsinline: 1,
        },
        events: {
          onReady: (event) => {
            setDuration(event.target.getDuration?.() || 0);
          },
          onStateChange: (event) => {
            const playerState = (window as HubWindow).YT?.PlayerState;
            if (event.data === playerState?.PLAYING) {
              setIsPlaying(true);
              updateCenterControlVisibility(false);
              return;
            }

            if (
              event.data === playerState?.PAUSED ||
              event.data === playerState?.ENDED
            ) {
              setIsPlaying(false);
              updateCenterControlVisibility(true);
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      ytPlayerRef.current?.destroy?.();
      ytPlayerRef.current = null;
    };
  }, [featuredStory, playerId]);

  useEffect(() => {
    if (featuredStory?.videoSource !== "YOUTUBE") {
      return;
    }

    const player = ytPlayerRef.current;

    if (!player) {
      return;
    }

    const syncProgress = () => {
      setCurrentTime(player.getCurrentTime?.() || 0);
      setDuration((currentDuration) => {
        const nextDuration = player.getDuration?.() || 0;
        return nextDuration || currentDuration;
      });
    };

    syncProgress();

    const intervalId = window.setInterval(syncProgress, isPlaying ? 250 : 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [featuredStory?.videoSource, featuredStory?.id, isPlaying]);

  function togglePlayback() {
    if (!featuredStory) {
      return;
    }

    if (featuredStory.videoSource === "UPLOAD") {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      if (video.paused) {
        updateCenterControlVisibility(false);
        void video.play();
      } else {
        updateCenterControlVisibility(true);
        video.pause();
      }

      return;
    }

    const player = ytPlayerRef.current;
    const playerState = (window as HubWindow).YT?.PlayerState;
    const currentState = player?.getPlayerState?.();

    if (currentState === playerState?.PLAYING) {
      updateCenterControlVisibility(true);
      player?.pauseVideo?.();
    } else {
      updateCenterControlVisibility(false);
      player?.playVideo?.();
    }
  }

  function handleCenterControlClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    togglePlayback();
  }

  function handleSeek(nextTime: number) {
    if (!featuredStory) {
      return;
    }

    setCurrentTime(nextTime);

    if (featuredStory.videoSource === "UPLOAD") {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      video.currentTime = nextTime;
      return;
    }

    ytPlayerRef.current?.seekTo?.(nextTime, true);
  }

  const progressPercent =
    duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;

  return (
    <div className="-mx-6 -mt-1 md:mx-0 md:mt-0">
      <div className="min-w-0 xl:mt-4 xl:grid xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)] xl:gap-6">
        <div className="relative min-w-0 overflow-hidden bg-black lg:rounded-[36px] lg:border lg:border-white/10">
          <div className="relative h-[calc(100svh-52px)] min-h-[calc(100svh-52px)] sm:h-[calc(100svh-60px)] sm:min-h-[calc(100svh-60px)] lg:h-[min(calc(100svh-10rem),920px)] lg:min-h-[890px]">
            {featuredStory ? (
              <>
                {data?.coverImageUrl ? (
                  <img
                    src={data.coverImageUrl}
                    alt={data.title}
                    className="absolute inset-0 h-full w-full scale-105 object-cover opacity-30 blur-2xl"
                  />
                ) : (
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(120,48,24,0.45),rgba(2,0,21,0.92)_72%)]" />
                )}

                <div className="absolute inset-0">
                  {featuredStory.videoSource === "UPLOAD" &&
                  featuredStory.videoAssetUrl ? (
                    <video
                      ref={videoRef}
                      className="absolute inset-0 h-full w-full bg-transparent object-cover object-center lg:object-contain lg:object-center"
                      src={featuredStory.videoAssetUrl}
                      playsInline
                      preload="auto"
                      onPlay={() => {
                        setIsPlaying(true);
                        updateCenterControlVisibility(false);
                      }}
                      onPause={() => {
                        setIsPlaying(false);
                        updateCenterControlVisibility(true);
                      }}
                      onEnded={() => {
                        setIsPlaying(false);
                        updateCenterControlVisibility(true);
                      }}
                      onLoadedMetadata={(event) => {
                        setDuration(event.currentTarget.duration || 0);
                      }}
                      onTimeUpdate={(event) => {
                        setCurrentTime(event.currentTarget.currentTime || 0);
                      }}
                    />
                  ) : (
                    <div className="relative mx-auto aspect-[9/16] h-full max-w-full overflow-hidden">
                      <div
                        id={playerId}
                        className="absolute inset-0 h-full w-full [&>iframe]:h-full [&>iframe]:w-full"
                      />
                    </div>
                  )}
                </div>
              </>
            ) : data?.coverImageUrl ? (
              <img
                src={data.coverImageUrl}
                alt={data.title}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(40,12,20,0.7),rgba(2,0,21,0.35),rgba(2,0,21,0.92))]" />
            )}

            {featuredStory ? (
              <button
                type="button"
                onClick={togglePlayback}
                className="absolute inset-x-0 top-0 bottom-[calc(env(safe-area-inset-bottom)+8.5rem)] z-10 sm:bottom-24 lg:bottom-28"
                aria-label={
                  isPlaying
                    ? "Pause featured story video"
                    : "Play featured story video"
                }
              />
            ) : null}

            {featuredStory ? (
              <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center px-6">
                <button
                  type="button"
                  onClick={handleCenterControlClick}
                  className={cn(
                    "pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/25 bg-black/35 text-white shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md transition-all duration-200 sm:h-20 sm:w-20",
                    showCenterControl
                      ? "scale-100 opacity-100"
                      : "scale-95 opacity-0",
                  )}
                  aria-label={
                    isPlaying
                      ? "Pause featured story video"
                      : "Play featured story video"
                  }
                >
                  {isPlaying ? (
                    <Pause className="h-7 w-7 sm:h-9 sm:w-9" strokeWidth={2.4} />
                  ) : (
                    <Play
                      className="ml-1 h-7 w-7 sm:h-9 sm:w-9"
                      fill="currentColor"
                      strokeWidth={2.2}
                    />
                  )}
                </button>
              </div>
            ) : null}

            <div className="pointer-events-none absolute inset-0 z-20 px-5 pt-4 sm:px-8 sm:pt-6 lg:px-10 lg:pt-8">
              <div className="flex items-start justify-between gap-5">
                <div className="max-w-[48%] space-y-1">
                  <p className="text-[clamp(1.1rem,2vw,1.9rem)] font-black uppercase leading-none tracking-[-0.03em] text-white">
                    {data?.title || "Experience"}
                  </p>
                  <p className="text-sm font-semibold leading-none text-white/76 sm:text-lg">
                    powered by SQRATCH
                  </p>
                </div>

                <div className="max-w-[48%] text-right">
                  <p className="text-[clamp(0.95rem,1.7vw,1.6rem)] font-black uppercase leading-none tracking-[-0.03em] text-white">
                    {campaignName}
                  </p>
                  <p className="text-sm font-semibold leading-none text-white/76 sm:text-lg">
                    by {brandName}
                  </p>
                </div>
              </div>
            </div>

            {!isPlaying && description && description.trim() && (
              <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+10.625rem)] z-30 px-5 max-[319px]:bottom-[calc(50%+2.5rem)] sm:bottom-32 sm:px-8 lg:bottom-28 lg:px-10">
                <div
                  ref={descriptionCardRef}
                  className="pointer-events-auto relative w-full max-w-[34rem] rounded-2xl border border-white/15 bg-black/35 px-3 py-2 shadow-[0_12px_36px_rgba(0,0,0,0.24)] backdrop-blur-md sm:w-[78%] sm:p-4 xl:w-[68%]"
                >
                  <p
                    className={cn(
                      "text-[clamp(1rem,1.2vw,1.2rem)] font-semibold leading-[1.06] tracking-[-0.03em] text-white lg:leading-[1.22] lg:tracking-[-0.01em]",
                      descriptionPreview?.source === description
                        ? ""
                        : "line-clamp-3",
                    )}
                  >
                    {descriptionPreview?.source === description ? (
                      <>
                        {descriptionPreview.text}
                        {descriptionPreview.isTruncated ? (
                          <span className="whitespace-nowrap">
                            ...{" "}
                            <button
                              ref={descriptionTriggerRef}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDescriptionOpen(true);
                              }}
                              onPointerDown={(event) =>
                                event.stopPropagation()
                              }
                              className="pointer-events-auto inline rounded-sm text-sm font-semibold text-white/82 underline decoration-white/35 underline-offset-2 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black/50"
                              aria-haspopup="dialog"
                            >
                              Read more
                            </button>
                          </span>
                        ) : null}
                      </>
                    ) : (
                      description
                    )}
                  </p>

                  <p
                    ref={descriptionMeasureRef}
                    aria-hidden="true"
                    className="invisible pointer-events-none absolute inset-x-3 top-2 text-[clamp(1rem,1.2vw,1.2rem)] font-semibold leading-[1.06] tracking-[-0.03em] text-white sm:inset-x-4 sm:top-4 lg:leading-[1.22] lg:tracking-[-0.01em]"
                  >
                    <span ref={descriptionMeasureTextRef} />
                    <span
                      ref={descriptionMeasureSuffixRef}
                      className="whitespace-nowrap"
                    >
                      ...{" "}
                      <span className="text-sm font-semibold">Read more</span>
                    </span>
                  </p>
                </div>
              </div>
            )}

            <Sheet open={descriptionOpen} onOpenChange={setDescriptionOpen}>
              <SheetContent
                side={useRightSheet ? "right" : "bottom"}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  descriptionTriggerRef.current?.focus();
                }}
                className={cn(
                  "z-50 gap-0 border-white/15 bg-[#0b0a1d] p-0 text-white",
                  useRightSheet
                    ? "h-dvh w-[min(480px,100vw)] sm:max-w-none"
                    : "max-h-[78dvh] rounded-t-[28px] pb-[env(safe-area-inset-bottom)]",
                )}
              >
                <SheetHeader className="shrink-0 border-b border-white/10 px-6 pb-4 pt-6 text-left">
                  <SheetTitle className="pr-10 text-xl font-semibold tracking-[-0.02em] text-white">
                    About this experience
                  </SheetTitle>
                </SheetHeader>
                <SheetDescription className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-6 py-5 text-sm leading-7 text-white/78 sm:text-base">
                  {description}
                </SheetDescription>
              </SheetContent>
            </Sheet>

            {featuredStory ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+6.25rem)] z-30 px-5 sm:bottom-14 sm:px-8 lg:bottom-10 lg:px-10">
                <div className="pointer-events-auto space-y-2 pb-6">
                  <div className="flex items-center justify-between text-sm font-medium text-white/72">
                    <span>{formatPlaybackTime(currentTime)}</span>
                    <span>{formatPlaybackTime(duration)}</span>
                  </div>

                  <div className="relative">
                    <div className="h-1.5 rounded-full bg-white/16" />
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-white"
                      style={{ width: `${progressPercent}%` }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={duration || 0}
                      step={0.1}
                      value={Math.min(currentTime, duration || currentTime)}
                      onChange={(event) =>
                        handleSeek(Number(event.target.value))
                      }
                      className="absolute inset-0 h-1.5 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="hidden min-w-0 xl:flex xl:self-start xl:flex-col xl:gap-3">
          <HeroStatsCard
            label="Visible courses"
            value={data?.courseSummary.visibleCourseCount || 0}
          />
          <HeroStatsCard label="Posts" value={data?.counts.posts || 0} />
          <HeroStatsCard
            label="Q&A threads"
            value={data?.counts.questions || 0}
          />
        </div>
      </div>
    </div>
  );
}

function HeroStatsCard({ label, value }: { label: string; value: number }) {
  return (
    <PageCard className="border-white/12 bg-white/[0.045]">
      <div className="flex min-h-[100px] flex-col justify-between p-1">
        <p className="text-base text-white/58 lg:text-[1.2rem] lg:leading-[1.15]">
          {label}
        </p>
        <p className="text-4xl font-semibold leading-none tracking-[-0.04em] text-white lg:text-[4rem]">
          {value}
        </p>
      </div>
    </PageCard>
  );
}
