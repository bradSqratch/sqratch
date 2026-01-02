"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  backgroundSrc: string; // /assets/homepage/sqratch_qr_bg.png
  filmSrc: string; // /assets/homepage/scratchable_film.png
  videoSrc: string; // /assets/homepage/skii_video.mp4
  className?: string;

  // behavior
  revealAtPercent?: number; // default 40
  brushRadius?: number; // default 28

  filmInset?: number; // px, default 44
  filmRadius?: number; // px, default 18
};

export default function ScratchRevealVideo({
  backgroundSrc,
  filmSrc,
  videoSrc,
  className,
  revealAtPercent = 40,
  brushRadius = 28,
  filmInset = 60,
  filmRadius = 0,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const filmImgRef = useRef<HTMLImageElement | null>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const filmWrapRef = useRef<HTMLDivElement | null>(null);

  const [isRevealed, setIsRevealed] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);

  const threshold = useMemo(
    () => Math.max(0, Math.min(100, revealAtPercent)),
    [revealAtPercent]
  );

  // --- helpers
  function getLocalPoint(e: PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }

  function drawScratchLine(
    from: { x: number; y: number },
    to: { x: number; y: number }
  ) {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.lineWidth = brushRadius * 2;

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // also punch a circle at the end to avoid gaps
    ctx.beginPath();
    ctx.arc(to.x, to.y, brushRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function estimateScratchedPercent() {
    // Don’t do this every pointermove (it’s expensive). We’ll throttle it.
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const { width, height } = canvas;

    // Sample a downscaled version for speed:
    const sampleW = 180;
    const sampleH = Math.round((height / width) * sampleW);

    const tmp = document.createElement("canvas");
    tmp.width = sampleW;
    tmp.height = sampleH;
    const tctx = tmp.getContext("2d")!;
    tctx.drawImage(canvas, 0, 0, sampleW, sampleH);

    const img = tctx.getImageData(0, 0, sampleW, sampleH).data;

    // film is drawn with alpha 1 initially; scratched areas become alpha 0
    let transparent = 0;
    const total = sampleW * sampleH;

    for (let i = 0; i < img.length; i += 4) {
      const a = img[i + 3];
      if (a === 0) transparent++;
    }

    return (transparent / total) * 100;
  }

  function pixelDissolve(blockSize = 10, iterations = 16, totalMs = 350) {
    return new Promise<void>((resolve) => {
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      const w = canvas.width;
      const h = canvas.height;

      let i = 0;
      const stepMs = totalMs / iterations;

      const tick = () => {
        // erase a batch of random blocks per iteration
        const blocksPerTick = 240; // increase for faster “crumble”
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(0,0,0,1)";

        for (let b = 0; b < blocksPerTick; b++) {
          const x = Math.floor(Math.random() * (w / blockSize)) * blockSize;
          const y = Math.floor(Math.random() * (h / blockSize)) * blockSize;
          ctx.fillRect(x, y, blockSize, blockSize);
        }
        ctx.restore();

        i++;
        if (i >= iterations) {
          resolve();
          return;
        }
        window.setTimeout(tick, stepMs);
      };

      tick();
    });
  }

  async function revealNow() {
    if (isRevealed || isFinishing) return;

    setIsFinishing(true);

    const vid = videoRef.current;
    if (vid) {
      vid.currentTime = 0;
      const attempt = vid.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch(() => {
          vid.muted = true;
          vid.play().catch(() => {});
        });
      }
    }

    // nice dissolve (fake pixelation) for ~350ms
    await pixelDissolve(10, 18, 350);

    // then mark revealed + play
    setIsRevealed(true);

    // fully clear after fade
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function resetAll() {
    setIsRevealed(false);
    setShowReplay(false);
    setIsFinishing(false);

    const vid = videoRef.current!;
    vid.pause();
    vid.currentTime = 0;

    // redraw film
    drawFilmToCanvas();
  }

  function drawFilmToCanvas() {
    const canvas = canvasRef.current;
    const wrap = filmWrapRef.current;
    const film = filmImgRef.current;
    if (!canvas || !wrap || !film) return;

    const rect = wrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      requestAnimationFrame(drawFilmToCanvas);
      return;
    }
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // draw the film image to cover the whole canvas
    // (object-cover behavior)
    const cw = canvas.width;
    const ch = canvas.height;
    const iw = film.naturalWidth;
    const ih = film.naturalHeight;

    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    ctx.drawImage(film, dx, dy, dw, dh);
  }

  // Load film image once
  useEffect(() => {
    const img = new Image();
    img.src = filmSrc;
    img.onload = () => {
      filmImgRef.current = img;
      drawFilmToCanvas();
    };
  }, [filmSrc]);

  // Resize observer to keep canvas aligned
  useEffect(() => {
    if (!filmWrapRef.current) return;
    const ro = new ResizeObserver(() => {
      if (!isRevealed) drawFilmToCanvas();
    });
    ro.observe(filmWrapRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRevealed]);

  // Pointer events on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // throttle % checks
    let lastCheck = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (isRevealed) return;
      e.preventDefault();
      isDrawingRef.current = true;
      canvas.setPointerCapture(e.pointerId);
      lastPointRef.current = getLocalPoint(e);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDrawingRef.current || isRevealed) return;
      e.preventDefault();
      const last = lastPointRef.current;
      if (!last) return;

      const next = getLocalPoint(e);
      drawScratchLine(last, next);
      lastPointRef.current = next;

      const now = performance.now();
      if (now - lastCheck > 160) {
        lastCheck = now;
        const pct = estimateScratchedPercent();
        if (pct >= threshold) revealNow();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      isDrawingRef.current = false;
      lastPointRef.current = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [isRevealed, threshold, brushRadius]);

  // Video ended -> show replay
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const onEnded = () => setShowReplay(true);
    vid.addEventListener("ended", onEnded);
    return () => vid.removeEventListener("ended", onEnded);
  }, []);

  return (
    <div
      ref={wrapRef}
      className={[
        "relative block overflow-hidden rounded-[20px] w-full",
        className ?? "",
      ].join(" ")}
      style={{
        aspectRatio: "1 / 1",
        backgroundImage: `url('${backgroundSrc}')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Inner film area (video + scratch canvas live here) */}
      <div
        ref={filmWrapRef}
        className="absolute"
        style={{
          left: filmInset,
          right: filmInset,
          top: filmInset - 30,
          bottom: filmInset + 30,
          borderRadius: filmRadius,
          overflow: "hidden",
        }}
      >
        {/* Video layer only inside film area */}
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          src={videoSrc}
          playsInline
          preload="metadata"
          muted={true}
          controls={false}
        />

        {/* Scratch film canvas ONLY inside film area */}
        <canvas
          ref={canvasRef}
          className={[
            "absolute inset-0 h-full w-full touch-none",
            isRevealed
              ? "pointer-events-none opacity-0"
              : "cursor-grab active:cursor-grabbing",
            isFinishing
              ? "transition-opacity duration-400 ease-out opacity-0"
              : "",
          ].join(" ")}
        />
      </div>

      {/* Replay button (centered) */}
      {showReplay && (
        <button
          onClick={resetAll}
          className="absolute left-1/2 top-2/3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30 bg-black/40 px-6 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-black/55"
        >
          Replay
        </button>
      )}
    </div>
  );
}
