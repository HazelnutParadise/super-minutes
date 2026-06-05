import { NextRequest, NextResponse } from "next/server";
import { Mutex } from "@/lib/server/mutex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const OLLAMA = process.env.OLLAMA_URL ?? "http://ollama:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e4b";

/**
 * Single shared lock — Ollama generates one response per GPU at a time,
 * and even when it doesn't queue internally it'll thrash VRAM swapping
 * model state. Serialising at the BFF gives the client a queue-position
 * signal and bounds Ollama-side memory pressure.
 *
 * Depth is lower than transcribe's (50) because each report is ~30-60s and
 * we'd rather 503 a 21st waiter than make them sit through 10+ minutes.
 */
const ollamaLock = new Mutex();
const MAX_QUEUE_DEPTH = 20;

interface ReportRequest {
  /** Concatenated transcript with speaker tags + timestamps. */
  transcript: string;
  /** Plain-English name of the target language so the LLM writes in it. */
  languageName: string;
  /** Optional model override. */
  model?: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

/**
 * System prompt — short, with an inline example. Small models (8B-class)
 * follow JSON schemas more reliably when shown the shape they should emit
 * than when given a schema declaration alone.
 */
const SYSTEM = (languageName: string) =>
  `You are a senior meeting minutes writer. Convert the diarized transcript into a structured meeting report.

# Rules

1. **Language**: write every string value (title, summary, conclusions, headings, points, tasks, owners, due) in ${languageName}. Keep keys in English.
2. **Output**: emit ONE JSON object and NOTHING ELSE. No prose, no markdown fences, no \`\`\`json blocks, no leading commentary. Your reply MUST start with { and end with }.
3. **Fidelity**: only use facts present in the transcript. Don't invent attendees, decisions, numbers, or commitments.
4. **Style**: short declarative sentences. No filler like "在這次會議中". \`title\` ≤ 18 chars. Each \`heading\` ≤ 16 chars.

# Example output

{
  "title": "Sprint 22 範圍確認",
  "summary": "團隊敲定下個 Sprint 只做離線快取的目錄與詳情頁，個人化推延。",
  "conclusions": [
    "Sprint 22 範圍鎖定為離線快取 v1。",
    "個人化頁面延至 Sprint 23 再評估。"
  ],
  "topics": [
    {
      "heading": "Sprint 範圍",
      "points": [
        "離線快取只做目錄與詳情兩條路由。",
        "個人化頁面因隱私風險暫不納入。"
      ]
    },
    {
      "heading": "技術分工",
      "points": [
        "志遠負責 service worker。",
        "Naomi 補上離線徽章元件。"
      ]
    }
  ],
  "actions": [
    { "task": "提交離線快取 v1 PR", "owner": "志遠", "due": "本週五" },
    { "task": "設計離線徽章元件", "owner": "Naomi", "due": null }
  ]
}

If a field has no content, use an empty string, empty array, or null — do NOT omit the key.`;

const USER_TEMPLATE = (transcript: string) =>
  `# Transcript\n\n${transcript}\n\nNow emit the JSON object. Begin with { right away.`;

/** Forceful retry — used after the first attempt fails to parse. Makes the
 *  rule absolutely explicit and gives the model permission to output empty
 *  arrays so it stops adding apologies. */
const RETRY_USER_TEMPLATE = (transcript: string) =>
  `Your previous reply was not valid JSON.

You MUST reply with ONE JSON object, nothing else. The very first character of your reply must be \`{\` and the very last must be \`}\`. Do not include \`\`\`json\`\`\`, do not include any explanation, do not apologise.

# Transcript

${transcript}

Emit the JSON now.`;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let payload: ReportRequest;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!payload.transcript?.trim()) {
    return NextResponse.json(
      { error: "transcript is required" },
      { status: 400 }
    );
  }
  if (ollamaLock.pending >= MAX_QUEUE_DEPTH) {
    console.warn(
      `[report] queue full (${ollamaLock.pending}/${MAX_QUEUE_DEPTH}); rejecting with 503`
    );
    return NextResponse.json(
      { error: "Report queue full, please retry later", queue: ollamaLock.pending },
      { status: 503, headers: { "retry-after": "30" } }
    );
  }
  const languageName =
    payload.languageName?.trim() || "Traditional Chinese (zh-TW)";
  const model = payload.model?.trim() || MODEL;

  let clientDisconnected = false;
  req.signal.addEventListener("abort", () => {
    clientDisconnected = true;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (obj: Record<string, unknown>) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {}
      };

      // Snapshot queue state at enqueue. Combined with the live `completed`
      // counter this lets us compute "how many finished since I joined"
      // without tracking positions inside Mutex.
      const initialAhead = ollamaLock.pending;
      const completedAtEnqueue = ollamaLock.completed;
      let acquired = false;
      const computeAhead = () => {
        if (acquired) return 0;
        const finished = ollamaLock.completed - completedAtEnqueue;
        return Math.max(0, initialAhead - finished);
      };

      const heartbeat = setInterval(() => {
        if (clientDisconnected) return;
        if (acquired) emit({ type: "ping", t: Date.now() - t0 });
        else emit({ type: "queued", t: Date.now() - t0, ahead: computeAhead() });
      }, 5_000);

      const abort = new AbortController();
      req.signal.addEventListener("abort", () => abort.abort());

      const callOllama = async (userMessage: string): Promise<{
        ok: boolean;
        rawContent: string;
        upstreamStatus: number;
        upstreamBody: string;
      }> => {
        const upstreamBody = {
          model,
          stream: false,
          format: "json",
          options: {
            // Lower temp than before — we want deterministic JSON. The model
            // has all the freedom it needs in the field values; structure is
            // not a place for sampling diversity.
            temperature: 0.1,
            top_p: 0.9,
            num_ctx: 16384,
          },
          keep_alive: "10m",
          messages: [
            { role: "system", content: SYSTEM(languageName) },
            { role: "user", content: userMessage },
          ],
        };
        const r = await fetch(`${OLLAMA}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(upstreamBody),
          signal: abort.signal,
        });
        const text = await r.text();
        if (!r.ok) {
          return {
            ok: false,
            rawContent: "",
            upstreamStatus: r.status,
            upstreamBody: text,
          };
        }
        let parsed: OllamaChatResponse;
        try {
          parsed = JSON.parse(text);
        } catch {
          return {
            ok: false,
            rawContent: text,
            upstreamStatus: 502,
            upstreamBody: text,
          };
        }
        return {
          ok: true,
          rawContent: parsed.message?.content ?? "",
          upstreamStatus: 200,
          upstreamBody: "",
        };
      };

      let release: (() => void) | null = null;
      try {
        emit({ type: "started", model });
        if (initialAhead > 0) {
          emit({ type: "queued", t: 0, ahead: initialAhead });
          console.log(
            `[report] queued behind ${initialAhead} request(s); waiting for Ollama slot`
          );
        }

        // Acquire the Ollama slot. If the client disconnects while queued,
        // Mutex.acquire pulls our resolver out and rejects — no dead slot.
        try {
          release = await ollamaLock.acquire(req.signal);
        } catch (e) {
          if (clientDisconnected) {
            console.log("[report] client disconnected while queued");
            return;
          }
          throw e;
        }
        if (clientDisconnected) {
          release();
          release = null;
          return;
        }

        acquired = true;
        const waitedMs = Date.now() - t0;
        emit({ type: "processing", t: waitedMs });
        if (initialAhead > 0) {
          console.log(
            `[report] acquired Ollama slot after ${waitedMs}ms in queue`
          );
        }

        let attempt: {
          ok: boolean;
          rawContent: string;
          upstreamStatus: number;
          upstreamBody: string;
        };
        let extracted: { ok: true; report: unknown } | { ok: false; raw: string } = {
          ok: false,
          raw: "",
        };

        // Attempt 1 — standard prompt.
        attempt = await callOllama(USER_TEMPLATE(payload.transcript));
        if (!attempt.ok) {
          emit({
            type: "result",
            status: attempt.upstreamStatus,
            body: attempt.upstreamBody || JSON.stringify({ error: "Ollama upstream failed" }),
          });
          return;
        }
        extracted = extractJsonReport(attempt.rawContent);

        // Attempt 2 — forceful retry only if attempt 1 was unparseable.
        if (!extracted.ok) {
          console.warn(
            "[report] attempt 1 unparseable, raw tail:",
            attempt.rawContent.slice(-300)
          );
          attempt = await callOllama(RETRY_USER_TEMPLATE(payload.transcript));
          if (!attempt.ok) {
            emit({
              type: "result",
              status: attempt.upstreamStatus,
              body: attempt.upstreamBody || JSON.stringify({ error: "Ollama upstream failed" }),
            });
            return;
          }
          extracted = extractJsonReport(attempt.rawContent);
        }

        if (!extracted.ok) {
          console.error(
            "[report] both attempts unparseable, raw:",
            extracted.raw.slice(0, 1500)
          );
          emit({
            type: "result",
            status: 502,
            body: JSON.stringify({
              error: "Model output was not valid JSON",
              raw: extracted.raw.slice(0, 1500),
            }),
          });
          return;
        }

        emit({
          type: "result",
          status: 200,
          body: JSON.stringify({ report: extracted.report, language: languageName }),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!clientDisconnected) {
          console.error("[report] upstream error:", msg);
          emit({
            type: "result",
            status: 502,
            body: JSON.stringify({ error: msg }),
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (release) release();
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * Multi-stage extractor — turns a possibly-chatty LLM reply into a valid
 * report object, or surfaces the raw text for diagnosis. Stages:
 *
 *   1. Strip BOM and leading whitespace.
 *   2. Strip markdown fences (```json ... ```) if present.
 *   3. Strip any preamble before the first `{` and any trailing text after
 *      the matching close `}` (balanced-brace scan, string-aware).
 *   4. JSON.parse on the cleaned blob.
 *   5. If parse fails, try a small set of common repairs (trailing comma,
 *      single-quoted strings, JS-style comments) and re-parse.
 *
 * Returns a discriminated union so the caller can decide whether to retry.
 */
function extractJsonReport(
  content: string
):
  | { ok: true; report: Record<string, unknown> }
  | { ok: false; raw: string } {
  if (!content) return { ok: false, raw: "" };
  let s = content.replace(/^﻿/, "").trim();

  // Strip ```json ... ``` (or ``` ... ```). Some Ollama models still emit
  // fences even with format=json.
  const fenceMatch = s.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  } else {
    // Also handle the case where the model wraps in a fence but adds chatter
    // around it: find the first fenced block.
    const innerFence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (innerFence && innerFence[1].trim().startsWith("{")) {
      s = innerFence[1].trim();
    }
  }

  // Slice down to a balanced top-level JSON object. The model sometimes
  // prefaces with "Here is the JSON:" or appends "Hope this helps!".
  const sliced = sliceBalancedObject(s);
  if (sliced) s = sliced;

  // Stage 4 — direct parse.
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return { ok: true, report: obj as Record<string, unknown> };
    }
  } catch {
    /* fall through to repairs */
  }

  // Stage 5 — common repairs.
  const repaired = repairCommonJsonMistakes(s);
  if (repaired !== s) {
    try {
      const obj = JSON.parse(repaired);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return { ok: true, report: obj as Record<string, unknown> };
      }
    } catch {
      /* surface raw */
    }
  }

  return { ok: false, raw: content };
}

/**
 * Find the first `{` and the matching `}` that closes it, ignoring braces
 * inside string literals (including escaped quotes). Returns null if no
 * balanced object is found.
 */
function sliceBalancedObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Best-effort repairs for JSON mistakes small models commonly make. */
function repairCommonJsonMistakes(s: string): string {
  let out = s;
  // Strip JS-style line/block comments (rare but happens).
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // Remove trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  // Smart quotes → straight quotes (for string contents — naive but useful).
  out = out
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  return out;
}
