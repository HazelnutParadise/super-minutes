import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const OLLAMA = process.env.OLLAMA_URL ?? "http://ollama:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma3:e4b";

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

const SYSTEM = (languageName: string) =>
  `You are a senior meeting minutes writer. The user will give you a diarized meeting transcript with speaker tags and timestamps. Write a structured meeting report.

CRITICAL CONSTRAINTS:
- Output language: ${languageName}. Every field, heading, and bullet must be written in ${languageName}.
- Output format: a single JSON object that matches the schema below exactly. No prose, no markdown fences, no commentary before or after the JSON.
- Be faithful to the transcript: do not invent attendees, decisions, numbers, or commitments that are not present.
- Prefer plain, declarative sentences. Avoid filler ("In this meeting...", "The participants discussed...").

JSON schema:
{
  "title": string,                         // ≤ 18 ${languageName} characters, factual
  "summary": string,                       // 1-3 sentence, single paragraph
  "conclusions": string[],                 // 2-6 items, each one decision or outcome
  "topics": [                              // 2-6 topics, in chronological order
    { "heading": string,                   // ≤ 16 characters
      "points": string[] }                 // 2-6 bullet points per topic
  ],
  "actions": [                             // empty array allowed if none stated
    { "task": string,                      // the action verb-first
      "owner": string | null,              // speaker name from transcript, or null
      "due": string | null }               // ISO-ish date or natural phrase, or null
  ]
}

Return ONLY the JSON. Begin your response with { and end with }.`;

const USER_TEMPLATE = (transcript: string) =>
  `Diarized transcript:\n\n${transcript}\n\nWrite the structured meeting report now.`;

export async function POST(req: NextRequest) {
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
  const languageName =
    payload.languageName?.trim() || "Traditional Chinese (zh-TW)";
  const model = payload.model?.trim() || MODEL;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {}
      };

      const heartbeat = setInterval(() => emit({ type: "ping" }), 5_000);
      const abort = new AbortController();
      req.signal.addEventListener("abort", () => abort.abort());

      try {
        emit({ type: "started", model });
        const upstreamBody = {
          model,
          stream: false,
          format: "json",
          options: { temperature: 0.2, num_ctx: 8192 },
          messages: [
            { role: "system", content: SYSTEM(languageName) },
            { role: "user", content: USER_TEMPLATE(payload.transcript) },
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
          emit({ type: "result", status: r.status, body: text });
          return;
        }

        let parsed: OllamaChatResponse;
        try {
          parsed = JSON.parse(text);
        } catch {
          emit({
            type: "result",
            status: 502,
            body: JSON.stringify({
              error: "Ollama returned non-JSON",
              raw: text.slice(0, 500),
            }),
          });
          return;
        }

        const content = parsed.message?.content ?? "";
        // Some models still wrap JSON in fences even with format=json. Strip.
        const cleaned = stripFences(content);
        let report: unknown;
        try {
          report = JSON.parse(cleaned);
        } catch {
          emit({
            type: "result",
            status: 502,
            body: JSON.stringify({
              error: "Model output was not valid JSON",
              raw: cleaned.slice(0, 1000),
            }),
          });
          return;
        }

        emit({
          type: "result",
          status: 200,
          body: JSON.stringify({ report, language: languageName }),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({
          type: "result",
          status: 502,
          body: JSON.stringify({ error: msg }),
        });
      } finally {
        clearInterval(heartbeat);
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

function stripFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return s.trim();
}
