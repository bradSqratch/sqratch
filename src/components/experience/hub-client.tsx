"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  ExperienceShell,
  GatePanel,
  LoadingView,
  ErrorView,
  PageCard,
} from "@/components/experience/experience-shell";
import { useExperience } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
}: {
  experienceSlug: string;
}) {
  const { data, loading, error } = useExperience(experienceSlug);
  const [activeTab, setActiveTab] = useState("learn");

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
      <div className="grid gap-4 md:grid-cols-3 lg:hidden">
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
                <h2 className="text-2xl font-semibold">Learn</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                  Public courses are available immediately. Private courses open
                  after login and campaign unlock.
                </p>
              </div>
              <Button
                asChild
                className="rounded-full border border-white bg-white text-black"
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
                    <h3 className="text-lg font-semibold">{course.title}</h3>
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
              <h2 className="text-2xl font-semibold">Creator Posts</h2>
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
                  className="rounded-full border border-white bg-white text-black"
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
              <h2 className="text-2xl font-semibold">Q&amp;A</h2>
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
                  className="rounded-full border border-white bg-white text-black"
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
  const playerId = useId();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const featuredStory = data?.featuredStory || null;
  const primaryCampaign = data?.campaigns[0] || null;
  const campaignName = primaryCampaign?.name || "Campaign";
  const brandName = primaryCampaign?.brand?.name || "Brand";

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [featuredStory?.id]);

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
              return;
            }

            if (
              event.data === playerState?.PAUSED ||
              event.data === playerState?.ENDED
            ) {
              setIsPlaying(false);
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
        void video.play();
      } else {
        video.pause();
      }

      return;
    }

    const player = ytPlayerRef.current;
    const playerState = (window as HubWindow).YT?.PlayerState;
    const currentState = player?.getPlayerState?.();

    if (currentState === playerState?.PLAYING) {
      player?.pauseVideo?.();
    } else {
      player?.playVideo?.();
    }
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
    <div className="-mx-6 -mt-1 sm:-mx-8 sm:mt-0 lg:-mx-10">
      <div className="lg:mt-4 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(280px,1fr)] lg:gap-6">
        <div className="relative overflow-hidden bg-black lg:rounded-[36px] lg:border lg:border-white/10">
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
                      className="absolute inset-0 h-full w-full bg-transparent object-cover object-center lg:object-contain lg:object-bottom"
                      src={featuredStory.videoAssetUrl}
                      playsInline
                      preload="auto"
                      onPlay={() => {
                        setIsPlaying(true);
                      }}
                      onPause={() => setIsPlaying(false)}
                      onEnded={() => setIsPlaying(false)}
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

            <div className="pointer-events-none absolute inset-0 z-20 flex flex-col px-5 pb-[calc(env(safe-area-inset-bottom)+7rem)] pt-4 sm:px-8 sm:pb-10 sm:pt-6 lg:px-10 lg:pb-28 lg:pt-8">
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

              <div className="mt-auto max-w-3xl">
                {!isPlaying && (
                  <div className="space-y-3 pb-14 sm:space-y-4 lg:max-w-2xl lg:pb-0">
                    <p className="max-w-3xl text-[clamp(1rem,1.2vw,1.2rem)] font-semibold leading-[1.06] tracking-[-0.03em] text-white lg:max-w-[34rem] lg:leading-[1.22] lg:tracking-[-0.01em]">
                      {data?.description ||
                        "This experience is waiting for its story."}
                    </p>
                  </div>
                )}
              </div>
            </div>

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

        <div className="hidden lg:flex lg:self-start lg:flex-col lg:gap-3">
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
