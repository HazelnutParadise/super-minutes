import type { TranscriptSegment } from "./types";
import { convertChinese, type ChineseScript } from "./chinese-convert";

interface AdvancedResponse {
  text?: string;
  language?: string;
  segments?: SegmentTimestamp[];
  diarization?: DiarizationSegment[];
  speakers?: string[];
}

interface SegmentTimestamp {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  speaker?: string | null;
}

interface DiarizationSegment {
  speaker: string;
  start: number;
  end: number;
}

interface SimpleResponse {
  text?: string;
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
  diarize?: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  convertTo?: ChineseScript;
  onQueueStatus?: (status: { ahead: number }) => void;
  onProcessing?: () => void;
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    reason: string;
  }) => void;
}

class StreamDroppedBeforeResultError extends Error {
  constructor(public readonly buffer: string) {
    super("與後端連線在排隊期間中斷");
    this.name = "StreamDroppedBeforeResultError";
  }
}

const MAX_ATTEMPTS = 3;

export async function transcribeAudio(
  audioFile: File,
  options: TranscribeOptions = {}
): Promise<{
  segments: TranscriptSegment[];
  raw: AdvancedResponse | SimpleResponse;
  speakerLabels: string[];
  language?: string;
}> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runOnce(audioFile, options);
    } catch (e) {
      if (
        e instanceof StreamDroppedBeforeResultError &&
        attempt < MAX_ATTEMPTS
      ) {
        const backoffMs = 800 * Math.pow(2, attempt - 1);
        options.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: MAX_ATTEMPTS,
          reason: e.message,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      if (e instanceof StreamDroppedBeforeResultError) {
        throw new Error(
          `與後端連線在排隊期間中斷，已自動重試 ${MAX_ATTEMPTS} 次仍失敗，請稍後再試。`
        );
      }
      throw e;
    }
  }
  throw new Error("轉錄失敗，已用盡所有重試。");
}

async function runOnce(
  audioFile: File,
  options: TranscribeOptions
): Promise<{
  segments: TranscriptSegment[];
  raw: AdvancedResponse | SimpleResponse;
  speakerLabels: string[];
  language?: string;
}> {
  const form = new FormData();
  form.append("file", audioFile);
  form.append("model", options.model ?? "whisper-1");
  form.append("advanced", "true");
  if (options.language) form.append("language", options.language);
  form.append("diarize", options.diarize === false ? "false" : "true");
  if (options.minSpeakers)
    form.append("min_speakers", String(options.minSpeakers));
  if (options.maxSpeakers)
    form.append("max_speakers", String(options.maxSpeakers));

  const r = await fetch("/api/transcribe", { method: "POST", body: form });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Transcription failed: ${r.status} ${text}`);
  }
  if (!r.body) throw new Error("Transcription failed: empty response body");

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let envelope: { type: "result"; status: number; body: string } | null = null;
  let processingSeen = false;

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
        ahead?: number;
        status?: number;
        body?: string;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      switch (msg.type) {
        case "queued":
          options.onQueueStatus?.({ ahead: msg.ahead ?? 0 });
          break;
        case "processing":
          processingSeen = true;
          options.onProcessing?.();
          break;
        case "result":
          envelope = {
            type: "result",
            status: msg.status ?? 0,
            body: msg.body ?? "",
          };
          break outer;
      }
    }
    if (done) break;
  }

  if (!envelope) {
    if (!processingSeen) {
      throw new StreamDroppedBeforeResultError(buffer);
    }
    throw new Error(
      "與後端的連線在轉錄途中斷掉了，請稍後再試一次。" +
        (buffer ? ` (tail=${buffer.slice(-200)})` : "")
    );
  }
  if (envelope.status < 200 || envelope.status >= 300) {
    throw new Error(
      `Transcription failed: ${envelope.status} ${envelope.body.slice(0, 500)}`
    );
  }

  const bodyText = envelope.body;
  let data: AdvancedResponse | SimpleResponse;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = { text: bodyText };
  }

  const advanced = data as AdvancedResponse;
  const speakerLabels: string[] = Array.isArray(advanced.speakers)
    ? advanced.speakers.slice()
    : [];

  let segments: TranscriptSegment[] = [];

  if (Array.isArray(advanced.segments) && advanced.segments.length > 0) {
    segments = advanced.segments
      .map((s, i) => {
        const start = typeof s.start === "number" ? s.start : 0;
        const end =
          typeof s.end === "number" ? s.end : start + Math.max(0.5, 2);
        const speaker = s.speaker ?? null;
        if (speaker && !speakerLabels.includes(speaker))
          speakerLabels.push(speaker);
        return {
          id: `seg-${i}-${Math.round(start * 1000)}`,
          start,
          end: Math.max(end, start + 0.05),
          text: (s.text ?? "").trim(),
          speakerId: speaker,
        };
      })
      .filter((s) => s.text.length > 0);
  }

  if (segments.length === 0 && data.text && data.text.trim()) {
    segments = splitByPunctuation(data.text.trim());
  }

  if (options.convertTo && segments.length > 0) {
    const target = options.convertTo;
    segments = await Promise.all(
      segments.map(async (s) => ({
        ...s,
        text: await convertChinese(s.text, target),
      }))
    );
  }

  return { segments, raw: data, speakerLabels, language: advanced.language };
}

function splitByPunctuation(text: string): TranscriptSegment[] {
  const parts = text
    .split(/(?<=[。！？.!?…?！])\s*|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const total = parts.length * 3;
  const totalLen = parts.reduce((n, p) => n + p.length, 0);
  const out: TranscriptSegment[] = [];
  let t = 0;
  for (let i = 0; i < parts.length; i++) {
    const fraction = parts[i].length / Math.max(1, totalLen);
    const len = Math.max(0.6, total * fraction);
    const start = t;
    const end = start + len;
    out.push({
      id: `seg-t-${i}`,
      start,
      end,
      text: parts[i],
      speakerId: null,
    });
    t = end;
  }
  return out;
}
