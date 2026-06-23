"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

const WORKERFS = "WORKERFS" as never;

let _ffmpeg: FFmpeg | null = null;
let _loadPromise: Promise<FFmpeg> | null = null;

const CORE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

export async function getFFmpeg(
  onProgress?: (ratio: number) => void
): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onProgress) {
      ffmpeg.on("progress", ({ progress }) =>
        onProgress(Math.max(0, Math.min(1, progress)))
      );
    }
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(
        `${CORE}/ffmpeg-core.wasm`,
        "application/wasm"
      ),
    });
    _ffmpeg = ffmpeg;
    return ffmpeg;
  })();

  return _loadPromise;
}

/**
 * Extract a mono 16k MP3 from a video file, entirely in-browser. Uses WORKERFS
 * so multi-GB videos don't have to fit in a single ArrayBuffer.
 *
 * If the source is already audio, this still re-encodes to 16k mono MP3 so
 * the gateway sees a consistent input.
 */
export async function extractAudio(
  videoFile: File,
  onProgress?: (ratio: number) => void
): Promise<File> {
  const ffmpeg = await getFFmpeg();
  // The ffmpeg instance is a singleton, so we MUST remove this listener in the
  // finally block — otherwise every extractAudio call accumulates another one
  // and later files end up with multiple stale handlers firing setProgress on
  // a closure from a previous file.
  const progressHandler = onProgress
    ? ({ progress }: { progress: number }) =>
        onProgress(Math.max(0, Math.min(1, progress)))
    : null;
  if (progressHandler) ffmpeg.on("progress", progressHandler);

  const ext = pickExtension(videoFile);
  const mountPoint = "/mnt";
  const inputBlobName = `input.${ext}`;
  const outputName = "audio.mp3";

  let inputPath = inputBlobName;
  let mounted = false;
  let dirCreated = false;

  try {
    await ffmpeg.createDir(mountPoint);
    dirCreated = true;
    await ffmpeg.mount(
      WORKERFS,
      { blobs: [{ name: inputBlobName, data: videoFile }] },
      mountPoint
    );
    mounted = true;
    inputPath = `${mountPoint}/${inputBlobName}`;
  } catch (e) {
    console.warn(
      "[ffmpeg-client] WORKERFS unavailable, loading file into memory:",
      e
    );
    if (mounted) {
      try {
        await ffmpeg.unmount(mountPoint);
      } catch {}
      mounted = false;
    }
    if (dirCreated) {
      try {
        await ffmpeg.deleteDir(mountPoint);
      } catch {}
      dirCreated = false;
    }
    const bytes = await readFileBytes(videoFile);
    await ffmpeg.writeFile(inputBlobName, bytes);
    inputPath = inputBlobName;
  }

  try {
    await ffmpeg.exec([
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    const bytes = data as Uint8Array;
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return new File([arrayBuffer], "audio.mp3", { type: "audio/mpeg" });
  } finally {
    if (progressHandler) {
      try {
        ffmpeg.off("progress", progressHandler);
      } catch {}
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {}
    if (mounted) {
      try {
        await ffmpeg.unmount(mountPoint);
      } catch {}
    } else {
      try {
        await ffmpeg.deleteFile(inputBlobName);
      } catch {}
    }
    if (dirCreated) {
      try {
        await ffmpeg.deleteDir(mountPoint);
      } catch {}
    }
  }
}

const MIME_TO_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/x-m4v": "m4v",
  "video/avi": "avi",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/webm": "weba",
};
const KNOWN_EXTS = new Set([
  "mp4",
  "mov",
  "webm",
  "mkv",
  "m4v",
  "avi",
  "wmv",
  "flv",
  "3gp",
  "ogv",
  "ts",
  "mp3",
  "m4a",
  "wav",
  "ogg",
  "flac",
  "opus",
  "aac",
  "weba",
]);

function pickExtension(file: File): string {
  const fromName = (file.name.split(".").pop() ?? "").toLowerCase();
  if (KNOWN_EXTS.has(fromName)) return fromName;
  if (file.type && MIME_TO_EXT[file.type]) return MIME_TO_EXT[file.type];
  return "mp4";
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  try {
    if (typeof file.arrayBuffer === "function") {
      const ab = await file.arrayBuffer();
      return new Uint8Array(ab);
    }
  } catch (e) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    console.error(
      `[ffmpeg-client] arrayBuffer() failed for ${file.name} (${sizeMb} MB):`,
      e
    );
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`讀取檔案失敗（${sizeMb} MB）：${detail}`);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error("FileReader returned unexpected result"));
    };
    reader.onerror = () => {
      const sizeMb = (file.size / 1024 / 1024).toFixed(1);
      reject(
        new Error(
          `讀取檔案失敗（${sizeMb} MB）。FileReader code=${reader.error?.code ?? -1}`
        )
      );
    };
    reader.readAsArrayBuffer(file);
  });
}
