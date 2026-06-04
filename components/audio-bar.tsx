"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProject } from "@/store/project-store";
import { formatTimeFull } from "@/lib/utils";

/** Sticky audio player at the top of the editor. Exposes a seek handle
 *  via window so transcript rows can scrub when clicked. */
export function AudioBar() {
  const mediaUrl = useProject((s) => s.mediaUrl);
  const duration = useProject((s) => s.duration);
  const segments = useProject((s) => s.segments);
  const setActiveSegment = useProject((s) => s.setActiveSegment);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      setTime(el.currentTime);
      // Update active segment by lookup.
      const active = segments.find(
        (s) => el.currentTime >= s.start && el.currentTime < s.end
      );
      if (active) setActiveSegment(active.id);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [segments, setActiveSegment]);

  // Expose a global seeker so the transcript can call into us without a ref.
  useEffect(() => {
    const seek = (sec: number) => {
      const el = audioRef.current;
      if (!el) return;
      el.currentTime = Math.max(0, sec);
      el.play().catch(() => {});
    };
    (window as unknown as { __superMinutesSeek?: (s: number) => void }).__superMinutesSeek =
      seek;
    return () => {
      delete (window as unknown as { __superMinutesSeek?: (s: number) => void })
        .__superMinutesSeek;
    };
  }, []);

  const pct = duration > 0 ? (time / duration) * 100 : 0;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  };
  const restart = () => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    el.play();
  };
  const toggleMute = () => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    el.currentTime = Math.max(0, Math.min(duration, ratio * duration));
  };

  return (
    <div className="sticky top-0 z-30 border-b border-cream-100/15 bg-background/85 backdrop-blur-md">
      <audio
        ref={audioRef}
        src={mediaUrl ?? undefined}
        className="hidden"
        preload="metadata"
      />
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
            disabled={!mediaUrl}
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
          {formatTimeFull(time)} <span className="text-cream-500"> / </span>
          {formatTimeFull(duration)}
        </div>

        <div
          className="group relative h-2 flex-1 cursor-pointer overflow-hidden rounded-sm bg-cream-100/[0.06]"
          onClick={onScrub}
        >
          {/* Ticks every 30s — like a film leader. */}
          <div className="absolute inset-0 flex">
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
          <div
            className="h-full bg-vermillion"
            style={{ width: `${pct}%` }}
          />
          <div
            className="absolute top-0 h-full w-px bg-cream-100"
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
