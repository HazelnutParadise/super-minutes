# Super Minutes

A privacy-respecting web app that turns a meeting recording into a structured minutes report:

1. The user picks an audio or video file locally.
2. If it's a video, audio is extracted **in the browser** with `ffmpeg.wasm` — the video itself never leaves the device.
3. The audio is sent to 榛果繽紛樂's OpenAI-compatible Whisper Gateway (e.g. `whisper-gateway:5000`) with speaker diarization on.
4. The diarized transcript is fed to a local Ollama instance (default model `gemma4:e4b`) to draft a structured minutes report: 會議紀要 (summary) · 主要結論 (conclusions) · 議題與要點 (topics & points) · 待辦行動項 (action items).
5. The user can edit the transcript inline, regenerate the report, switch between Traditional / Simplified Chinese (in-browser via OpenCC), then export the package as Markdown, DOCX, or PDF.

Built with **Next.js 15 (App Router)**, **TypeScript**, **Tailwind**, **shadcn/ui**, **zustand**, **ffmpeg.wasm**, **opencc-js**, **docx**, and **jspdf**.

## Architecture notes

- `/api/transcribe` proxies the multipart upload to `${WHISPER_GATEWAY_URL}/v1/audio/transcriptions` with `advanced=true` and `diarize=true`, streaming NDJSON keepalives so Cloudflare doesn't 524 mid-job.
- `/api/report` POSTs the transcript to `${OLLAMA_URL}/api/chat` with `${OLLAMA_MODEL}` (default `gemma4:e4b`). The prompt explicitly names the target language so the report is written in the right script.
- `lib/ffmpeg-client.ts` loads `@ffmpeg/core` from a CDN and converts the user's video to a 16 kHz mono MP3 entirely on the client.
- `lib/chinese-convert.ts` runs every Chinese segment through OpenCC after transcription, so the user can pick Traditional or Simplified consistently — Whisper itself has no zh-Hant/zh-Hans distinction.

## Local development

```bash
npm install
npm run dev
```

Set `WHISPER_GATEWAY_URL` and `OLLAMA_URL` to reachable services — see `.env.example`.

## Docker

```bash
docker compose up -d --build
```

Joins the existing `infra-net` and resolves `whisper-gateway:5000` and `ollama:11434` inside the network.
