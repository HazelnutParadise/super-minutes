import { NextRequest, NextResponse } from "next/server";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink, stat, readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Mutex } from "@/lib/server/mutex";

const TMP_PREFIX = "minutes-transcribe-";
const TMP_SUFFIX = ".bin";

let _sweepStarted = false;
function sweepStaleTmpFiles() {
  if (_sweepStarted) return;
  _sweepStarted = true;
  void (async () => {
    try {
      const dir = tmpdir();
      const names = await readdir(dir);
      const now = Date.now();
      let cleaned = 0;
      for (const name of names) {
        if (!name.startsWith(TMP_PREFIX) || !name.endsWith(TMP_SUFFIX))
          continue;
        const path = join(dir, name);
        try {
          const s = await stat(path);
          if (now - s.mtimeMs > 60 * 60 * 1000) {
            await unlink(path);
            cleaned++;
          }
        } catch {
          /* file vanished concurrently */
        }
      }
      if (cleaned > 0) {
        console.log(
          `[transcribe] startup sweep removed ${cleaned} stale tmp file(s)`
        );
      }
    } catch (e) {
      console.warn("[transcribe] startup sweep failed:", e);
    }
  })();
}
sweepStaleTmpFiles();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GATEWAY =
  process.env.WHISPER_GATEWAY_URL ?? "http://whisper-gateway:5000";

const MAX_QUEUE_DEPTH = 50;

/** Single shared lock — the Whisper Gateway runs one transcription at a time
 *  per box, so everything pending in this BFF process queues here. */
const gatewayLock = new Mutex();

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const contentType = req.headers.get("content-type") ?? "";
  const contentLength = req.headers.get("content-length");
  const pendingBefore = gatewayLock.pending;
  console.log(
    `[transcribe] POST ct=${contentType} cl=${contentLength ?? "n/a"} queue=${pendingBefore}`
  );

  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }
  if (!req.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }
  if (gatewayLock.pending >= MAX_QUEUE_DEPTH) {
    return NextResponse.json(
      {
        error: "Gateway busy, please retry later",
        queue: gatewayLock.pending,
      },
      { status: 503, headers: { "retry-after": "30" } }
    );
  }

  const upstreamHeaders: Record<string, string> = {
    "content-type": contentType,
  };
  if (contentLength) upstreamHeaders["content-length"] = contentLength;

  const tmpPath = join(tmpdir(), `${TMP_PREFIX}${randomUUID()}${TMP_SUFFIX}`);
  let tmpCleanedUp = false;
  const cleanupTmp = async () => {
    if (tmpCleanedUp) return;
    tmpCleanedUp = true;
    try {
      await unlink(tmpPath);
    } catch {}
  };

  const upstreamAbort = new AbortController();
  let clientDisconnected = false;
  req.signal.addEventListener("abort", () => {
    clientDisconnected = true;
    upstreamAbort.abort();
    void cleanupTmp();
  });

  try {
    const bufferStart = Date.now();
    await pipeline(
      Readable.fromWeb(req.body as never),
      createWriteStream(tmpPath)
    );
    let bufferedBytes: number | null = null;
    try {
      bufferedBytes = (await stat(tmpPath)).size;
    } catch {}
    console.log(
      `[transcribe] body buffered (${bufferedBytes ?? "?"}B) in ${Date.now() - bufferStart}ms`
    );
  } catch (e) {
    await cleanupTmp();
    if (clientDisconnected) {
      return new NextResponse(null, { status: 499 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "Upload buffering failed", detail: msg },
      { status: 400 }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (obj: Record<string, unknown>) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {}
      };

      const initialAhead = gatewayLock.pending;
      const completedAtEnqueue = gatewayLock.completed;
      let acquired = false;
      const computeAhead = () => {
        if (acquired) return 0;
        const finished = gatewayLock.completed - completedAtEnqueue;
        return Math.max(0, initialAhead - finished);
      };

      const heartbeat = setInterval(() => {
        if (clientDisconnected) return;
        if (acquired) emit({ type: "ping", t: Date.now() - t0 });
        else emit({ type: "queued", t: Date.now() - t0, ahead: computeAhead() });
      }, 5_000);

      let release: (() => void) | null = null;
      try {
        if (initialAhead > 0) {
          emit({ type: "queued", t: 0, ahead: initialAhead });
        }
        try {
          release = await gatewayLock.acquire(req.signal);
        } catch (e) {
          if (clientDisconnected) return;
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
        console.log(
          `[transcribe] forwarding to ${GATEWAY}/v1/audio/transcriptions (waited ${waitedMs}ms)`
        );

        const upstream = await fetch(
          `${GATEWAY}/v1/audio/transcriptions`,
          {
            method: "POST",
            headers: upstreamHeaders,
            body: Readable.toWeb(
              createReadStream(tmpPath)
            ) as ReadableStream<Uint8Array>,
            signal: upstreamAbort.signal,
            // @ts-expect-error duplex isn't in the dom types yet
            duplex: "half",
          }
        );
        const body = await upstream.text();
        console.log(
          `[transcribe] upstream status=${upstream.status} bytes=${body.length} after ${Date.now() - t0}ms`
        );
        emit({ type: "result", status: upstream.status, body });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!clientDisconnected) {
          console.error("[transcribe] upstream error:", msg);
          emit({
            type: "result",
            status: 502,
            body: JSON.stringify({ error: msg }),
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (release) release();
        await cleanupTmp();
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      void cleanupTmp();
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
