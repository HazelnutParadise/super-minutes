"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UploadCloud,
  Loader2,
  ArrowRight,
  FileAudio,
  Languages,
  Users,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { extractAudio } from "@/lib/ffmpeg-client";
import { transcribeAudio } from "@/lib/transcribe";
import { useProject } from "@/store/project-store";
import { LANGUAGES, makeSpeaker } from "@/lib/types";
import { cn, formatBytes, formatShort } from "@/lib/utils";

type Stage =
  | "idle"
  | "loading-ffmpeg"
  | "extracting"
  | "queued"
  | "retrying"
  | "transcribing"
  | "done";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "WAITING FOR FILE",
  "loading-ffmpeg": "PREPARING AUDIO ENGINE",
  extracting: "EXTRACTING AUDIO",
  queued: "QUEUED",
  retrying: "RETRYING",
  transcribing: "TRANSCRIBING",
  done: "COMPLETE",
};

export function UploadCard() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [queueAhead, setQueueAhead] = useState(0);
  const [retry, setRetry] = useState<{ attempt: number; max: number } | null>(
    null
  );
  const [hovered, setHovered] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [diarize, setDiarize] = useState(true);

  const setSource = useProject((s) => s.setSource);
  const setSegments = useProject((s) => s.setSegments);
  const setSegmentsOriginal = useProject((s) => s.setSegmentsOriginal);
  const setDuration = useProject((s) => s.setDuration);
  const setLanguage = useProject((s) => s.setLanguage);
  const replaceSpeakers = useProject((s) => s.replaceSpeakers);
  const uiLanguage = useProject((s) => s.uiLanguage);
  const setUILanguage = useProject((s) => s.setUILanguage);
  const setScript = useProject((s) => s.setScript);

  const probeMeta = useCallback(
    (f: File) =>
      new Promise<{ duration: number }>((resolve) => {
        const isAudio = f.type.startsWith("audio/");
        const el = document.createElement(isAudio ? "audio" : "video");
        el.preload = "metadata";
        const url = URL.createObjectURL(f);
        el.src = url;
        el.onloadedmetadata = () => {
          const meta = { duration: el.duration || 0 };
          URL.revokeObjectURL(url);
          resolve(meta);
        };
        el.onerror = () => {
          URL.revokeObjectURL(url);
          resolve({ duration: 0 });
        };
      }),
    []
  );

  const handleFile = useCallback(async (f: File) => {
    if (!f.type.startsWith("video/") && !f.type.startsWith("audio/")) {
      toast.error("請選擇音訊或影片檔案");
      return;
    }
    setFile(f);
  }, []);

  const onPickClick = () => inputRef.current?.click();
  const onPickChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setHovered(false);
      const f = e.dataTransfer.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  function humaniseSpeakerLabel(label: string, idx: number) {
    const m = label.match(/(\d+)/);
    if (m) return `講者 ${String.fromCharCode(65 + parseInt(m[1], 10))}`;
    return `講者 ${String.fromCharCode(65 + idx)}`;
  }

  const start = async () => {
    if (!file) {
      toast.error("先選擇一份檔案");
      return;
    }
    try {
      setProgress(0);
      setStage("loading-ffmpeg");
      const meta = await probeMeta(file);
      setDuration(meta.duration);

      let audio: File;
      if (file.type.startsWith("audio/")) {
        // Use the file as-is. Skip ffmpeg entirely.
        audio = file;
        setStage("extracting");
        setProgress(100);
      } else {
        setStage("extracting");
        audio = await extractAudio(file, (r) => setProgress(r * 100));
      }
      // Use the extracted/source audio as the preview media so the editor
      // can scrub even when the original was a giant video.
      const audioUrl = URL.createObjectURL(audio);
      setSource(file, audioUrl);

      setStage("transcribing");
      setProgress(0);

      const gatewayLang =
        uiLanguage === "auto"
          ? undefined
          : uiLanguage === "zh-Hant" || uiLanguage === "zh-Hans"
            ? "zh"
            : uiLanguage;
      const convertTo: "traditional" | "simplified" | undefined =
        uiLanguage === "zh-Hant"
          ? "traditional"
          : uiLanguage === "zh-Hans"
            ? "simplified"
            : undefined;
      const initialScript =
        uiLanguage === "zh-Hant"
          ? "traditional"
          : uiLanguage === "zh-Hans"
            ? "simplified"
            : "original";
      setScript(initialScript);

      const { segments, speakerLabels, language } = await transcribeAudio(
        audio,
        {
          model: "whisper-1",
          language: gatewayLang,
          diarize,
          convertTo,
          onQueueStatus: ({ ahead }) => {
            setQueueAhead(ahead);
            if (ahead > 0) setStage("queued");
          },
          onProcessing: () => {
            setQueueAhead(0);
            setRetry(null);
            setStage("transcribing");
          },
          onRetry: ({ attempt, maxAttempts }) => {
            setRetry({ attempt, max: maxAttempts });
            setStage("retrying");
          },
        }
      );

      let finalSegments = segments;
      if (speakerLabels.length >= 1) {
        const speakerHints = speakerLabels.map((label, i) => ({
          id: `spk-${label}`,
          name: humaniseSpeakerLabel(label, i),
        }));
        replaceSpeakers(speakerHints);
        const labelToId = new Map(
          speakerLabels.map((label) => [label, `spk-${label}`])
        );
        finalSegments = segments.map((s) =>
          s.speakerId && labelToId.has(s.speakerId)
            ? { ...s, speakerId: labelToId.get(s.speakerId)! }
            : s
        );
      } else {
        replaceSpeakers([{ id: makeSpeaker("spk-default", 0).id, name: "講者 A" }]);
        finalSegments = segments.map((s) => ({ ...s, speakerId: "spk-default" }));
      }

      setLanguage(language ?? gatewayLang ?? "");
      setSegmentsOriginal(finalSegments);
      setSegments(finalSegments);
      setStage("done");
      toast.success(
        `產生 ${finalSegments.length} 段逐字稿${
          speakerLabels.length > 1
            ? ` · 偵測到 ${speakerLabels.length} 位講者`
            : ""
        }`
      );
      router.push("/editor");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`處理失敗：${msg}`);
      setStage("idle");
      setProgress(0);
      setQueueAhead(0);
      setRetry(null);
    }
  };

  const busy = stage !== "idle" && stage !== "done";

  return (
    <Card className="relative overflow-hidden p-8 backdrop-blur-md animate-ledger-rise">
      {/* Corner ordinal — feels like a numbered file. */}
      <div className="absolute right-5 top-4 font-display italic text-[clamp(2.5rem,4vw,3.25rem)] leading-none text-cream-100/[0.07] select-none">
        Nº 01
      </div>

      <div className="space-y-6 relative">
        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setHovered(true);
          }}
          onDragLeave={() => setHovered(false)}
          onDrop={onDrop}
          onClick={onPickClick}
          className={cn(
            "group relative flex cursor-pointer flex-col items-center justify-center rounded-sm border border-dashed border-cream-100/25 bg-ink-800/40 px-6 py-12 text-center transition-all",
            hovered &&
              "border-vermillion/70 bg-vermillion/[0.04] shadow-inner",
            file && "border-cream-100/35 bg-ink-800/60"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={onPickChange}
          />
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full border border-cream-100/15 bg-ink-700/60">
            {file ? (
              <FileAudio className="h-5 w-5 text-vermillion" />
            ) : (
              <UploadCloud className="h-5 w-5 text-cream-200" />
            )}
          </div>
          <div className="font-display italic text-xl leading-tight text-cream-100">
            {file ? file.name : "拖曳檔案至此 · 或點擊選擇"}
          </div>
          <div className="mt-2 font-mono text-[10px] tracking-[0.2em] text-cream-500">
            {file
              ? `${formatBytes(file.size)} · ${
                  file.type.startsWith("audio/") ? "AUDIO" : "VIDEO"
                } · LOCAL`
              : "MP3 · WAV · M4A · MP4 · MOV · WEBM · MKV"}
          </div>
          {!file && (
            <div className="mt-3 max-w-[28ch] text-pretty text-xs leading-relaxed text-muted-foreground">
              影片只會在瀏覽器內處理。我們只把抽出來的音訊送到語音閘道。
            </div>
          )}
        </div>

        {/* Controls — always stacked: the card is narrow when the hero
         *  splits into two columns, so a horizontal split squeezes both
         *  fields. Vertical stacking reads cleaner at every width. */}
        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Languages className="h-3 w-3" /> 來源語言
            </Label>
            <Select value={uiLanguage} onValueChange={setUILanguage}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Users className="h-3 w-3" /> 語者分離
            </Label>
            <div className="flex h-9 items-center justify-between gap-3 rounded-sm border border-cream-100/20 bg-ink-800/40 px-3">
              <span className="min-w-0 truncate font-sans text-sm text-cream-200">
                {diarize ? "多人自動分離" : "視為單一講者"}
              </span>
              <Switch checked={diarize} onCheckedChange={setDiarize} />
            </div>
          </div>
        </div>

        {/* Status / progress */}
        {busy && (
          <div className="space-y-2 rounded-sm border border-cream-100/15 bg-ink-800/40 p-4">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.25em] text-cream-300">
              <span className="inline-flex items-center gap-2">
                <Loader2
                  className={cn(
                    "h-3 w-3 animate-spin",
                    stage === "retrying"
                      ? "text-amber-400"
                      : "text-vermillion"
                  )}
                />
                {stage === "queued"
                  ? queueAhead > 0
                    ? `QUEUED · ${queueAhead} AHEAD`
                    : "QUEUED"
                  : stage === "retrying" && retry
                    ? `RETRY ${retry.attempt} / ${retry.max}`
                    : STAGE_LABEL[stage]}
              </span>
              <span className="text-cream-500">
                {stage === "queued" || stage === "retrying"
                  ? "WAITING"
                  : `${Math.round(progress)}%`}
              </span>
            </div>
            <Progress
              value={
                stage === "queued" || stage === "retrying"
                  ? 100
                  : stage === "transcribing"
                    ? 100
                    : progress
              }
            />
          </div>
        )}

        {/* Footer / start */}
        <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="font-mono text-[10px] leading-relaxed tracking-[0.18em] text-cream-500 max-w-[20ch]">
            {file ? (
              <>
                預估處理 ≈ {formatShort((file.size / 1024 / 1024) * 0.6)}
              </>
            ) : (
              <>只上傳音訊　影片不外流</>
            )}
          </div>
          <Button
            variant="vermillion"
            size="lg"
            disabled={!file || busy}
            onClick={start}
            className="min-w-[200px] gap-3"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                處理中
              </>
            ) : (
              <>
                生成逐字稿
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
}
