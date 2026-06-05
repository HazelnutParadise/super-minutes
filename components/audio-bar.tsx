"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProject } from "@/store/project-store";
import { formatTimeFull } from "@/lib/utils";

/**
 * Sticky audio player. The transcript timeline is "global" — t=0 at the
 * start of file 1, advancing through the entire concatenated playback —
 * so this component is the one place that knows about the per-leg
 * `MediaSegment[]` and translates between (segment index, local time)
 * and global time.
 *
 * On seek to global t we pick the segment whose [offset, offset+duration)
 * contains t, swap the audio src if needed, and seek into the local time.
 * On `ended` we auto-advance to the next leg.
 *
 * The seek handle is exposed on `window.__superMinutesSeek` so transcript
 * rows can scrub without prop drilling.
 */
export function AudioBar() {
  const mediaSegments = useProject((s) => s.mediaSegments);
  const duration = useProject((s) => s.duration);
  const segments = useProject((s) => s.segments);
  const setActiveSegment = useProject((s) => s.setActiveSegment);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Index of the leg currently loaded in <audio>. Refs (not state) so
   *  callbacks see the latest value without re-binding listeners. */
  const currentIdxRef = useRef<number>(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [globalTime, setGlobalTime] = useState(0);
  const [muted, setMuted] = useState(false);

  // Whenever the leg list changes (new upload, reset, etc.) load the first
  // leg into the audio element so playback starts cleanly.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (mediaSegments.length === 0) {
      el.removeAttribute("src");
      el.load();
      setCurrentIdx(0);
      currentIdxRef.current = 0;
      setGlobalTime(0);
      return;
    }
    if (el.src !== mediaSegments[0].url) {
      el.src = mediaSegments[0].url;
      el.load();
      setCurrentIdx(0);
      currentIdxRef.current = 0;
      setGlobalTime(0);
    }
  }, [mediaSegments]);

  // Wire up timeupdate / play / pause / ended once on mount.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      const idx = currentIdxRef.current;
      const offset = mediaSegments[idx]?.offset ?? 0;
      const t = offset + el.currentTime;
      setGlobalTime(t);
      const active = segments.find((s) => t >= s.start && t < s.end);
      if (active) setActiveSegment(active.id);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      // Auto-advance to the next leg if there is one.
      const nextIdx = currentIdxRef.current + 1;
      if (nextIdx < mediaSegments.length) {
        loadAndPlay(nextIdx, 0);
      } else {
        setPlaying(false);
      }
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [mediaSegments, segments, setActiveSegment]);

  function loadAndPlay(idx: number, localTime: number, shouldPlay = true) {
    const el = audioRef.current;
    if (!el) return;
    const target = mediaSegments[idx];
    if (!target) return;
    const sameSrc = el.src === target.url;
    currentIdxRef.current = idx;
    setCurrentIdx(idx);
    if (!sameSrc) {
      el.src = target.url;
      el.load();
      const onLoaded = () => {
        el.currentTime = Math.max(0, Math.min(target.duration, localTime));
        if (shouldPlay) el.play().catch(() => {});
        el.removeEventListener("loadedmetadata", onLoaded);
      };
      el.addEventListener("loadedmetadata", onLoaded);
    } else {
      el.currentTime = Math.max(0, Math.min(target.duration, localTime));
      if (shouldPlay) el.play().catch(() => {});
    }
  }

  function seekGlobal(globalT: number, shouldPlay = true) {
    if (mediaSegments.length === 0) return;
    // Find the leg covering this global time.
    let idx = -1;
    for (let i = 0; i < mediaSegments.length; i++) {
      const seg = mediaSegments[i];
      if (globalT >= seg.offset && globalT < seg.offset + seg.duration) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      // Past the very end — clamp to last leg's end.
      idx = mediaSegments.length - 1;
    }
    const local = globalT - mediaSegments[idx].offset;
    loadAndPlay(idx, local, shouldPlay);
  }

  // Expose a global seeker so the transcript can call into us without a ref.
  useEffect(() => {
    const seek = (sec: number) => seekGlobal(sec, true);
    (
      window as unknown as { __superMinutesSeek?: (s: number) => void }
    ).__superMinutesSeek = seek;
    return () => {
      delete (window as unknown as { __superMinutesSeek?: (s: number) => void })
        .__superMinutesSeek;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaSegments]);

  const pct = duration > 0 ? (globalTime / duration) * 100 : 0;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      if (!el.src && mediaSegments[0]) {
        loadAndPlay(0, 0);
      } else {
        el.play();
      }
    } else {
      el.pause();
    }
  };
  const restart = () => seekGlobal(0, true);
  const toggleMute = () => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekGlobal(Math.max(0, Math.min(duration, ratio * duration)), true);
  };

  return (
    <div className="sticky top-0 z-30 border-b border-cream-100/15 bg-background/85 backdrop-blur-md">
      <audio ref={audioRef} className="hidden" preload="metadata" />
      <div className="container mx-auto flex items-center gap-4 px-6 py-3">
        <div className="flex items-center gap-1.5">
          <Button
            size="icon"
            variant="ghost"
            onClick={restart}
            className="h-8 w-8"
            title="從頭播放"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="vermillion"
            onClick={toggle}
            className="h-9 w-9 rounded-full"
            disabled={mediaSegments.length === 0}
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={toggleMute}
            className="h-8 w-8"
          >
            {muted ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        <div className="font-mono text-[11px] tabular-nums text-cream-300 w-[12rem]">
          {formatTimeFull(globalTime)}{" "}
          <span className="text-cream-500"> / </span>
          {formatTimeFull(duration)}
        </div>

        <div
          className="group relative h-2 flex-1 cursor-pointer overflow-hidden rounded-sm bg-cream-100/[0.06]"
          onClick={onScrub}
        >
          {/* Leg boundary marks — vertical hairlines where one file hands
           *  off to the next. Helps the user feel the multi-file seam. */}
          {duration > 0 &&
            mediaSegments.slice(1).map((seg, i) => (
              <div
                key={i}
                className="absolute top-0 h-full w-px bg-vermillion/60"
                style={{ left: `${(seg.offset * 100) / duration}%` }}
              />
            ))}
          {/* 30s ticks within. */}
          <div className="absolute inset-0">
            {duration > 0 &&
              Array.from(
                { length: Math.max(1, Math.floor(duration / 30)) },
                (_, i) => (
                  <div
                    key={i}
                    className="absolute top-0 h-full w-px bg-cream-100/15"
                    style={{ left: `${((i + 1) * 30 * 100) / duration}%` }}
                  />
                )
              )}
          </div>
          <div className="h-full bg-vermillion" style={{ width: `${pct}%` }} />
          <div
            className="absolute top-0 h-full w-px bg-cream-100"
            style={{ left: `${pct}%` }}
          />
        </div>

        {/* Current leg badge when there are multiple */}
        {mediaSegments.length > 1 && (
          <div
            className="hidden md:block font-mono text-[10px] tracking-[0.2em] text-cream-500"
            title={mediaSegments[currentIdx]?.fileName}
          >
            FILE {currentIdx + 1} / {mediaSegments.length}
          </div>
        )}
      </div>
    </div>
  );
}
