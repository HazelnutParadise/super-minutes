import { NextRequest, NextResponse } from "next/server";
import { Mutex } from "@/lib/server/mutex";
import {
  DEEP_THRESHOLD_CHARS,
  generateDeepReport,
} from "@/lib/server/deep-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OLLAMA = process.env.OLLAMA_URL ?? "http://ollama:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e4b";

/**
 * Single shared lock — Ollama generates one response per GPU at a time,
 * and even when it doesn't queue internally it'll thrash VRAM swapping
 * model state. Serialising at the BFF gives the client a queue-position
 * signal and bounds Ollama-side memory pressure.
 *
 * Depth is much lower than transcribe's (50) because a report is no longer a
 * single call: a short meeting is ~45s, but anything past half an hour runs the
 * multi-pass pipeline and takes several minutes. At depth 8 the last waiter is
 * looking at roughly half an hour, which is already the most we should let
 * someone queue for without telling them to come back later.
 */
const ollamaLock = new Mutex();
const MAX_QUEUE_DEPTH = 8;

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
 * System prompt — the rules, then one inline example. Small models (8B-class)
 * follow JSON schemas more reliably when shown the shape they should emit
 * than when given a schema declaration alone.
 *
 * The "what makes this good" and "coverage floors" sections exist because an
 * earlier version of this prompt capped lengths (`short declarative
 * sentences`, `heading ≤ 16 chars`) and set no floors at all. Measured against
 * a 14-minute test transcript, that version carried 3 of 9 substantive items
 * and averaged 32 characters per point — it kept *what* was discussed and
 * dropped every number, reason, objection and condition behind it. Replacing
 * the ceilings with floors took the same model to 7 of 9 at 69 chars/point,
 * and did not cost generation time. The only remaining ceiling is on `title`,
 * which is a layout constraint (it renders at up to 3.5rem) and has nothing to
 * do with depth.
 */
const SYSTEM = (languageName: string) =>
  `You are a senior meeting minutes writer. Convert the diarized transcript into a structured meeting report that a person who missed the meeting could act on without listening to the recording.

# Rules

1. **Language**: write every string value in ${languageName}. Keep keys in English.
2. **Output**: emit ONE JSON object and NOTHING ELSE. No prose, no markdown fences, no \`\`\`json blocks, no leading commentary. Your reply MUST start with { and end with }.
3. **Fidelity**: only use facts present in the transcript. Never invent attendees, numbers, decisions, or commitments. Copy names exactly as they appear.
4. **Layout**: \`title\` ≤ 20 chars — it is rendered as a large headline. Nothing else has a length cap.

# What makes this report good

A shallow report lists what was talked about. A good one carries the reasoning. For every claim you write down, check that you kept these four things:

- **Numbers**: every figure, percentage, date, deadline, sample size and headcount that was actually spoken. Write \`4.1% 掉到 2.9%\`, never \`轉換率下降\`.
- **Reasons**: why the group landed where it did. A decision without its reason is half a decision.
- **Disagreement**: who pushed back, on what, and how it was resolved — or that it wasn't. Do not smooth the meeting into a consensus it didn't have.
- **Conditions**: anything decided as "only if", "not before", "unless", or with a stop date attached. These are the parts people forget and then violate.

# Coverage floors

- \`summary\`: 3-5 sentences. Say what was at stake, what was settled, and what was deliberately left open.
- \`conclusions\`: one entry per thing that was actually settled. Each entry states the conclusion AND the reason behind it in the same sentence.
- \`topics\`: one per agenda item that got real discussion. Each topic needs **at least 4 points**. Points carry the evidence — the numbers, the objection, the tradeoff. A topic with 2 vague points means you compressed too hard; go back to the transcript and pull the specifics.
- \`open_questions\`: anything explicitly left undecided, deferred, or waiting on data. If someone said "先擱著", "再看", "還沒決定", "等資料出來", it belongs here. Use an empty array only if the meeting truly closed everything.
- \`actions\`: every commitment anyone made, including ones buried mid-discussion. Use the speaker's own deadline wording. If no deadline was given, \`due\` is null — never the string "N/A".

Do not compress to look tidy. Length is not a virtue, but neither is brevity — the test is whether a reader can reconstruct the decision without the recording.

# Example output

{
  "title": "Q3 轉換下滑歸因",
  "summary": "團隊確認免費轉付費連三個月下滑，且 Android 跌幅是 iOS 的三倍。工程指出七月換了付款 SDK，設計的使用者測試也看到確認頁上的資訊斷層，因此把 SDK 流程列為主要嫌疑。行銷提出同期停掉首購折扣也可能有影響，會後由數據拆解驗證。中介畫面先做以止血，付費牆改綁行為順延，避免兩個變因同時進場。",
  "conclusions": [
    "把 Android 轉換下滑的主因暫定為付款流程資訊斷層，因為折扣是 iOS、Android 同步停止，解釋不了 Android 獨自跌三倍。",
    "付費牆觸發條件從天數改為行為，因為有建專案的人轉換 11.3%、沒建的只有 0.8%，差 14 倍，天數跟付費意願無關。"
  ],
  "topics": [
    {
      "heading": "轉換下滑歸因",
      "points": [
        "免費轉付費六月 4.1%、七月 3.2%、八月 2.9%，連三個月下滑。",
        "拆裝置後 iOS 由 5.6% 掉到 4.8%，Android 由 3.4% 掉到 2.1%，Android 跌幅超過三倍。",
        "付款失敗率換 SDK 前後為 2.3% 與 2.5%，沒有惡化，排除硬失敗。",
        "點訂閱後未完成的比例由六月 31% 升到八月 47%，多流失 16 個百分點。",
        "行銷提出七月同時停掉首購七折，主張折扣影響不應算成零；數據認為折扣兩平台同步停，無法解釋 Android 獨跌，改以六月為對照組拆解驗證。"
      ]
    }
  ],
  "open_questions": [
    "A/B 一週後若方向往下，是直接停還是先調文案再觀察，會後另開十五分鐘依實際跌幅決定。"
  ],
  "actions": [
    { "task": "以六月為對照組，拆解折扣與 SDK 對 iOS、Android 轉換的各自影響", "owner": "王政雄", "due": "本週四" },
    { "task": "補上離線徽章元件", "owner": "Naomi", "due": null }
  ]
}

If a field genuinely has no content, use an empty string, empty array, or null — do NOT omit the key.`;

/**
 * The five-point scan is deliberately a partial repeat of the system prompt's
 * four bullets. Measured on the same transcript, dropping it cost one
 * substantive item (the A/B sample-size reasoning) for a saving of ~90 prompt
 * tokens — so it stays. Restating the ask *after* the transcript also puts it
 * adjacent to generation, where long inputs otherwise bury it.
 */
const USER_TEMPLATE = (transcript: string) =>
  `# Transcript

${transcript}

Before writing, scan the transcript once for these five things and make sure each one lands somewhere in the JSON:
1. every number, percentage, date and deadline that was spoken
2. every reason given for a decision
3. every objection or disagreement, and whether it was resolved
4. every conditional constraint ("only after", "not before", "unless", stop dates)
5. every question the meeting explicitly left open

Now emit the JSON object. Begin with { right away.`;

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

      const callOllama = async (
        userMessage: string,
        systemMessage: string = SYSTEM(languageName)
      ): Promise<{
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
            // Ollama silently truncates the *oldest* tokens once input+output
            // exceeds num_ctx, so an over-long meeting loses its opening —
            // agenda, attendees, framing — without any error surfacing.
            // Measured: a 14-minute diarized zh-TW transcript is ~3.4k tokens,
            // and this prompt adds ~750. At 16384 that capped us around a
            // 55-minute meeting. 32768 covers ~2 hours and still fits in VRAM
            // on the 12B model.
            num_ctx: 32768,
          },
          keep_alive: "10m",
          messages: [
            { role: "system", content: systemMessage },
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

        // Long meetings go through the multi-pass pipeline. One call emits a
        // roughly fixed amount of output whatever the input length, so past
        // about half an hour a single pass just spreads the same report over
        // more meeting. See lib/server/deep-report.ts for the measurements.
        if (payload.transcript.length >= DEEP_THRESHOLD_CHARS) {
          console.log(
            `[report] transcript is ${payload.transcript.length} chars; using the multi-pass pipeline`
          );
          const deep = await generateDeepReport({
            transcript: payload.transcript,
            languageName,
            onProgress: (p) => emit({ type: "stage", ...p }),
            call: async ({ system, user }) => {
              const r = await callOllama(user, system);
              if (!r.ok) throw new Error(r.upstreamBody || "Ollama upstream failed");
              const parsed = extractJsonReport(r.rawContent);
              return parsed.ok ? parsed.report : null;
            },
          });
          emit({
            type: "result",
            status: 200,
            body: JSON.stringify({ report: deep, language: languageName }),
          });
          return;
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
