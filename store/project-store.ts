"use client";

import { create } from "zustand";
import {
  makeSpeaker,
  type MinutesReport,
  type SpeakerProfile,
  type TranscriptSegment,
} from "@/lib/types";

export type Script = "original" | "traditional" | "simplified";

/**
 * One audio leg of the project. A multi-file upload becomes a list of these,
 * each with the (cumulative) global time `offset` at which it starts. The
 * AudioBar uses `offset + currentTime(within file)` as the global timeline,
 * so transcript segments only ever need to know about global time.
 */
export interface MediaSegment {
  fileName: string;
  url: string;
  duration: number;
  /** Global seconds where this leg starts. First leg is 0. */
  offset: number;
}

interface ProjectState {
  /** Files the user picked, in chronological (playback) order. */
  sourceFiles: File[];
  /** Audio legs the editor can play; mirrors sourceFiles in order. */
  mediaSegments: MediaSegment[];
  /** Total duration in seconds across all legs. */
  duration: number;
  /** Detected ASR language code, e.g. "zh" or "en". */
  language: string;
  /** User-selected upload language (or "auto"). */
  uiLanguage: string;
  /** Display script — affects Chinese segments only. */
  script: Script;

  segments: TranscriptSegment[];
  /** Frozen copy of the original transcript text, used when toggling script. */
  segmentsOriginal: TranscriptSegment[];
  speakers: SpeakerProfile[];
  activeSegmentId: string | null;

  report: MinutesReport | null;
  reportLanguage: string | null;
  reportPending: boolean;

  setSourceFiles: (files: File[]) => void;
  setMediaSegments: (segs: MediaSegment[]) => void;
  setDuration: (d: number) => void;
  setLanguage: (l: string) => void;
  setUILanguage: (l: string) => void;
  setScript: (s: Script) => void;
  setSegments: (segments: TranscriptSegment[]) => void;
  setSegmentsOriginal: (segments: TranscriptSegment[]) => void;
  updateSegment: (id: string, patch: Partial<TranscriptSegment>) => void;
  setActiveSegment: (id: string | null) => void;

  replaceSpeakers: (next: { id: string; name: string }[]) => void;
  updateSpeaker: (id: string, patch: Partial<SpeakerProfile>) => void;

  setReport: (r: MinutesReport | null, language?: string | null) => void;
  setReportPending: (b: boolean) => void;

  reset: () => void;
}

function revokeAll(segs: MediaSegment[]) {
  for (const s of segs) {
    try {
      URL.revokeObjectURL(s.url);
    } catch {
      /* already revoked */
    }
  }
}

export const useProject = create<ProjectState>((set, get) => ({
  sourceFiles: [],
  mediaSegments: [],
  duration: 0,
  language: "",
  uiLanguage: "auto",
  script: "original",

  segments: [],
  segmentsOriginal: [],
  speakers: [],
  activeSegmentId: null,

  report: null,
  reportLanguage: null,
  reportPending: false,

  setSourceFiles: (files) => set({ sourceFiles: files }),
  setMediaSegments: (segs) =>
    set((s) => {
      // Revoke any URLs we're about to replace so memory doesn't leak across
      // re-uploads in the same session.
      const incomingUrls = new Set(segs.map((x) => x.url));
      revokeAll(s.mediaSegments.filter((x) => !incomingUrls.has(x.url)));
      return { mediaSegments: segs };
    }),
  setDuration: (d) => set({ duration: d }),
  setLanguage: (l) => set({ language: l }),
  setUILanguage: (l) => set({ uiLanguage: l }),
  setScript: (s) => set({ script: s }),

  setSegments: (segments) => set({ segments }),
  setSegmentsOriginal: (segments) => set({ segmentsOriginal: segments }),
  updateSegment: (id, patch) =>
    set((s) => ({
      segments: s.segments.map((seg) =>
        seg.id === id ? { ...seg, ...patch } : seg
      ),
    })),
  setActiveSegment: (id) => set({ activeSegmentId: id }),

  replaceSpeakers: (next) =>
    set((s) => {
      const byId = new Map(s.speakers.map((sp) => [sp.id, sp]));
      const speakers: SpeakerProfile[] = next.map((hint, i) => {
        const existing = byId.get(hint.id);
        if (existing) return { ...existing, name: hint.name };
        return makeSpeaker(hint.id, i, hint.name);
      });
      return { speakers };
    }),
  updateSpeaker: (id, patch) =>
    set((s) => ({
      speakers: s.speakers.map((sp) =>
        sp.id === id ? { ...sp, ...patch } : sp
      ),
    })),

  setReport: (r, language) =>
    set({ report: r, reportLanguage: language ?? get().reportLanguage }),
  setReportPending: (b) => set({ reportPending: b }),

  reset: () =>
    set((s) => {
      revokeAll(s.mediaSegments);
      return {
        sourceFiles: [],
        mediaSegments: [],
        duration: 0,
        language: "",
        uiLanguage: "auto",
        script: "original",
        segments: [],
        segmentsOriginal: [],
        speakers: [],
        activeSegmentId: null,
        report: null,
        reportLanguage: null,
        reportPending: false,
      };
    }),
}));
