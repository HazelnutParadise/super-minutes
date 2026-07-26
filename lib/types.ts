export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Raw label from the diarization backend (e.g. "SPEAKER_00"). */
  speakerId: string | null;
}

export interface SpeakerProfile {
  /** Stable id used by segments. */
  id: string;
  /** Human-editable display name shown in the UI. */
  name: string;
  /** Accent color — one of the SPEAKER_COLORS palette. */
  color: string;
}

/** Languages selectable in the upload step. Mirrors super-captions plus a
 *  few extras useful for meetings. `auto` defers to Whisper's detector. */
export const LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "自動偵測" },
  { value: "zh-Hant", label: "中文（繁體）" },
  { value: "zh-Hans", label: "中文（簡體）" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "ru", label: "Русский" },
];

/** Editorial palette — muted, paper-friendly. Avoids the neon look. */
export const SPEAKER_COLORS = [
  "#D43F3F", // vermillion
  "#6FA688", // jade
  "#C49B6A", // ochre
  "#7E91B7", // ink-blue
  "#B6739D", // muted plum
  "#8C8378", // graphite warm
  "#4F8FA0", // lake teal
  "#C57D45", // burnt sienna
];

export function makeSpeaker(
  id: string,
  index: number,
  name?: string
): SpeakerProfile {
  return {
    id,
    name: name ?? `講者 ${String.fromCharCode(65 + (index % 26))}`,
    color: SPEAKER_COLORS[index % SPEAKER_COLORS.length],
  };
}

/** Structured minutes report shape. The LLM is asked to emit this exact
 *  schema as JSON; the API route validates before sending it to the UI. */
export interface MinutesReport {
  title: string;
  summary: string;
  conclusions: string[];
  topics: { heading: string; points: string[] }[];
  /** Things the meeting explicitly left undecided or parked pending data.
   *  Kept separate from `actions` because nobody owns them yet — they're the
   *  items that quietly vanish when minutes only record what was settled. */
  openQuestions: string[];
  actions: {
    task: string;
    owner?: string | null;
    due?: string | null;
  }[];
}

export function emptyReport(): MinutesReport {
  return {
    title: "會議報告",
    summary: "",
    conclusions: [],
    topics: [],
    openQuestions: [],
    actions: [],
  };
}
