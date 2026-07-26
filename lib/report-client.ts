"use client";

import type { MinutesReport, TranscriptSegment, SpeakerProfile } from "./types";

/** Names handed to the LLM as the literal output language. Whisper codes
 *  don't map cleanly to readable language names so we maintain this list. */
export const LANGUAGE_NAMES: Record<string, string> = {
  auto: "Traditional Chinese (zh-TW)",
  "zh-Hant": "Traditional Chinese (zh-TW)",
  "zh-Hans": "Simplified Chinese (zh-CN)",
  zh: "Traditional Chinese (zh-TW)",
  en: "English",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  es: "Spanish (Español)",
  fr: "French (Français)",
  de: "German (Deutsch)",
  ru: "Russian (Русский)",
};

export function languageName(code: string | undefined | null): string {
  if (!code) return LANGUAGE_NAMES.auto;
  return LANGUAGE_NAMES[code] ?? code;
}

export function buildTranscriptForLLM(
  segments: TranscriptSegment[],
  speakers: SpeakerProfile[]
): string {
  const byId = new Map(speakers.map((s) => [s.id, s.name]));
  const lines: string[] = [];
  for (const seg of segments) {
    const t = formatMMSS(seg.start);
    const who =
      seg.speakerId == null
        ? "Unknown"
        : (byId.get(seg.speakerId) ?? seg.speakerId);
    lines.push(`[${t}] ${who}: ${seg.text}`);
  }
  return lines.join("\n");
}

function formatMMSS(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface GenerateReportOptions {
  transcript: string;
  languageName: string;
  model?: string;
  onPing?: () => void;
  onStarted?: (model: string) => void;
  /** Fired whenever the server reports we're still queued behind other
   *  generations. `ahead` is the number of jobs that will run before ours.
   *  When the slot is ours `onProcessing` fires and no further queued
   *  events arrive. */
  onQueueStatus?: (status: { ahead: number }) => void;
  /** Fired exactly once when the BFF acquires the Ollama slot. */
  onProcessing?: () => void;
  /** Fired for each step of the multi-pass pipeline that long meetings use.
   *  Short meetings are a single call and never emit this. */
  onStage?: (s: { label: string; step: number; total: number }) => void;
}

export async function generateReport(
  opts: GenerateReportOptions
): Promise<{ report: MinutesReport; language: string }> {
  const r = await fetch("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transcript: opts.transcript,
      languageName: opts.languageName,
      model: opts.model,
    }),
  });
  if (r.status === 503) {
    // Queue at the BFF was full — surface a friendly message rather than
    // the raw `{error, queue}` JSON.
    throw new Error("AI 整稿目前忙線中，請稍等一下再試一次。");
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Report API failed: ${r.status} ${text}`);
  }
  if (!r.body) throw new Error("Report API returned empty body");

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let envelope: { status: number; body: string } | null = null;

  outer: while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: {
        type?: string;
        status?: number;
        body?: string;
        model?: string;
        ahead?: number;
        label?: string;
        step?: number;
        total?: number;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "ping") opts.onPing?.();
      else if (msg.type === "started")
        opts.onStarted?.(msg.model ?? "(unknown)");
      else if (msg.type === "queued")
        opts.onQueueStatus?.({ ahead: msg.ahead ?? 0 });
      else if (msg.type === "processing") opts.onProcessing?.();
      else if (msg.type === "stage")
        opts.onStage?.({
          label: msg.label ?? "",
          step: msg.step ?? 0,
          total: msg.total ?? 0,
        });
      else if (msg.type === "result") {
        envelope = { status: msg.status ?? 0, body: msg.body ?? "" };
        break outer;
      }
    }
    if (done) break;
  }

  if (!envelope) throw new Error("與 Ollama 連線中斷");
  if (envelope.status < 200 || envelope.status >= 300) {
    let detail = envelope.body;
    try {
      const j = JSON.parse(envelope.body);
      if (j?.error) detail = j.error;
    } catch {}
    throw new Error(`生成報告失敗：${envelope.status} ${detail}`);
  }

  const parsed = JSON.parse(envelope.body);
  const report = parsed.report as MinutesReport & {
    /** The prompt asks for snake_case, which is the JSON convention and what
     *  the model was tested against. Normalised to camelCase here. */
    open_questions?: unknown;
  };
  if (
    !report ||
    typeof report.summary !== "string" ||
    !Array.isArray(report.topics)
  ) {
    throw new Error("Ollama 回傳的結構不符預期");
  }
  // Defensive defaults so the UI never crashes on a partial schema.
  report.title = report.title ?? "會議報告";
  report.conclusions = Array.isArray(report.conclusions)
    ? report.conclusions
    : [];
  report.openQuestions = Array.isArray(report.open_questions)
    ? (report.open_questions as string[])
    : Array.isArray(report.openQuestions)
      ? report.openQuestions
      : [];
  delete report.open_questions;
  report.actions = Array.isArray(report.actions) ? report.actions : [];
  report.topics = report.topics.map((t) => ({
    heading: t?.heading ?? "",
    points: Array.isArray(t?.points) ? t.points : [],
    subtopics: Array.isArray(t?.subtopics)
      ? t.subtopics
          .filter((st) => st && typeof st.heading === "string")
          .map((st) => ({
            heading: st.heading,
            points: Array.isArray(st.points) ? st.points : [],
          }))
      : undefined,
  }));

  return { report, language: parsed.language ?? opts.languageName };
}
