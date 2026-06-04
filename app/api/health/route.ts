import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "super-minutes",
    gateway: process.env.WHISPER_GATEWAY_URL ?? "(default)",
    ollama: process.env.OLLAMA_URL ?? "(default)",
    model: process.env.OLLAMA_MODEL ?? "gemma3:e4b",
  });
}
