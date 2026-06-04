"use client";

import { create } from "zustand";
import {
  makeSpeaker,
  type MinutesReport,
  type SpeakerProfile,
  type TranscriptSegment,
} from "@/lib/types";

export type Script = "original" | "traditional" | "simplified";

interface ProjectState {
  sourceFile: File | null;
  /** Object URL for an <audio> element. We always preview as audio. */
  mediaUrl: string | null;
  /** Duration in seconds — set after the browser probes the audio. */
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

  setSource: (file: File | null, url: string | null) => void;
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

export const useProject = create<ProjectState>((set, get) => ({
  sourceFile: null,
  mediaUrl: null,
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

  setSource: (file, url) =>
    set((s) => {
      if (s.mediaUrl && s.mediaUrl !== url) URL.revokeObjectURL(s.mediaUrl);
      return { sourceFile: file, mediaUrl: url };
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
    set({
      sourceFile: null,
      mediaUrl: null,
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
    }),
}));
