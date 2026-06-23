"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UploadCloud,
  Loader2,
  ArrowRight,
  Languages,
  Users,
  X,
  ArrowUp,
  ArrowDown,
  FileVideo,
  FileAudio,
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
import { useProject, type MediaSegment } from "@/store/project-store";
import { LANGUAGES, type TranscriptSegment } from "@/lib/types";
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
  idle: "WAITING FOR FILES",
  "loading-ffmpeg": "PREPARING AUDIO ENGINE",
  extracting: "EXTRACTING AUDIO",
  queued: "QUEUED",
  retrying: "RETRYING",
  transcribing: "TRANSCRIBING",
  done: "COMPLETE",
};

/** A file the user has staged but not yet processed. We track an internal id
 *  so React can key the list during reorder without re-keying on file name
 *  (two files might share a name). */
interface StagedFile {
  id: string;
  file: File;
}

let _nextId = 0;
const nextStageId = () => `f${++_nextId}-${Date.now().toString(36)}`;

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
  const [staged, setStaged] = useState<StagedFile[]>([]);
  /** Index of the file currently being processed inside the start() loop. */
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [diarize, setDiarize] = useState(true);

  const setSourceFiles = useProject((s) => s.setSourceFiles);
  const setMediaSegments = useProject((s) => s.setMediaSegments);
  const setSegments = useProject((s) => s.setSegments);
  const setSegmentsOriginal = useProject((s) => s.setSegmentsOriginal);
  const setDuration = useProject((s) => s.setDuration);
  const setLanguage = useProject((s) => s.setLanguage);
  const replaceSpeakers = useProject((s) => s.replaceSpeakers);
  const uiLanguage = useProject((s) => s.uiLanguage);
  const setUILanguage = useProject((s) => s.setUILanguage);
  const setScript = useProject((s) => s.setScript);

  const totalBytes = useMemo(
    () => staged.reduce((n, s) => n + s.file.size, 0),
    [staged]
  );

  const probeMeta = useCallback(
    (f: File) =>
      new Promise<{ duration: number }>((resolve) => {
        const isAudio = f.type.startsWith("audio/");
        const el = document.createElement(isAudio ? "audio" : "video");
        el.preload = "metadata";
        const url = URL.createObjectURL(f);
        let settled = false;
        // Some containers (notably mkv and some webm/mov variants) cause the
        // <video>/<audio> element to fire neither loadedmetadata nor error in
        // some browsers — that would hang the upload pipeline forever.
        // 10s is generous for metadata; on timeout we fall back to duration 0
        // (the file still gets transcribed; only the multi-file offset stitch
        // becomes inexact for an un-probed file).
        const finish = (duration: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          el.onloadedmetadata = null;
          el.onerror = null;
          URL.revokeObjectURL(url);
          el.removeAttribute("src");
          resolve({ duration });
        };
        const timer = setTimeout(() => {
          console.warn(
            `[upload-card] probeMeta timed out for ${f.name}; falling back to duration 0`
          );
          finish(0);
        }, 10_000);
        el.onloadedmetadata = () => finish(el.duration || 0);
        el.onerror = () => finish(0);
        el.src = url;
      }),
    []
  );

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const arr = Array.from(incoming).filter(
      (f) => f.type.startsWith("video/") || f.type.startsWith("audio/")
    );
    if (arr.length === 0) {
      toast.error("請選擇音訊或影片檔案");
      return;
    }
    setStaged((prev) => {
      // Sort all (existing + new) by lastModified ascending. This is the
      // chronological order most users expect — recording files almost
      // always carry the recording-end time as mtime.
      const combined = [
        ...prev,
        ...arr.map((file) => ({ id: nextStageId(), file })),
      ];
      combined.sort((a, b) => a.file.lastModified - b.file.lastModified);
      return combined;
    });
  }, []);

  const onPickClick = () => inputRef.current?.click();
  const onPickChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  };
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setHovered(false);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const removeStaged = (id: string) =>
    setStaged((prev) => prev.filter((s) => s.id !== id));

  const moveStaged = (id: string, dir: -1 | 1) =>
    setStaged((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });

  function humaniseSpeakerLabel(letter: number) {
    return `講者 ${String.fromCharCode(65 + (letter % 26))}`;
  }

  const start = async () => {
    if (staged.length === 0) {
      toast.error("先選擇至少一份檔案");
      return;
    }
    try {
      const ordered = staged.map((s) => s.file);
      setProgress(0);
      setStage("loading-ffmpeg");

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

      // Accumulators. Speaker letters increment across files so each speaker
      // gets a unique 講者 label by default; users rename in the editor.
      const mediaSegments: MediaSegment[] = [];
      const allSegments: TranscriptSegment[] = [];
      const allSpeakers: { id: string; name: string }[] = [];
      let cumOffset = 0;
      let speakerLetter = 0;
      let detectedLanguage = "";

      for (let i = 0; i < ordered.length; i++) {
        const file = ordered[i];
        setActiveIdx(i);

        // 1) Probe duration up front so we know the offset for this file
        //    even if extraction/transcription fail later.
        const meta = await probeMeta(file);

        // 2) Audio extraction (skip for audio inputs).
        let audio: File;
        if (file.type.startsWith("audio/")) {
          audio = file;
          setStage("extracting");
          setProgress(100);
        } else {
          setStage("extracting");
          setProgress(0);
          audio = await extractAudio(file, (r) => setProgress(r * 100));
        }
        const audioUrl = URL.createObjectURL(audio);
        const fileDuration = meta.duration || 0;
        mediaSegments.push({
          fileName: file.name,
          url: audioUrl,
          duration: fileDuration,
          offset: cumOffset,
        });

        // 3) Transcribe.
        setStage("transcribing");
        setProgress(0);
        const {
          segments,
          speakerLabels,
          language,
        } = await transcribeAudio(audio, {
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
        });
        if (language && !detectedLanguage) detectedLanguage = language;

        // 4) Speakers — give each one a unique id scoped to this file, and a
        //    human letter that's monotonically increasing across all files.
        const fileSpeakerLetters: { id: string; name: string }[] = [];
        if (speakerLabels.length > 0) {
          for (const raw of speakerLabels) {
            const id = `f${i}-${raw}`;
            const name = humaniseSpeakerLabel(speakerLetter++);
            fileSpeakerLetters.push({ id, name });
          }
        } else {
          // No diarization or single speaker — give the whole file one slot.
          const id = `f${i}-default`;
          const name = humaniseSpeakerLabel(speakerLetter++);
          fileSpeakerLetters.push({ id, name });
        }
        allSpeakers.push(...fileSpeakerLetters);

        const labelToId = new Map(
          speakerLabels.map((raw) => [raw, `f${i}-${raw}`])
        );
        const defaultSpeakerForFile = `f${i}-default`;
        const offsetSegments: TranscriptSegment[] = segments.map((s) => ({
          id: `f${i}-${s.id}`,
          start: s.start + cumOffset,
          end: s.end + cumOffset,
          text: s.text,
          speakerId:
            s.speakerId && labelToId.has(s.speakerId)
              ? labelToId.get(s.speakerId)!
              : defaultSpeakerForFile,
        }));
        allSegments.push(...offsetSegments);

        cumOffset += fileDuration;
      }

      setSourceFiles(ordered);
      setMediaSegments(mediaSegments);
      setDuration(cumOffset);
      setLanguage(detectedLanguage || gatewayLang || "");
      replaceSpeakers(allSpeakers);
      setSegmentsOriginal(allSegments);
      setSegments(allSegments);
      setStage("done");
      setActiveIdx(-1);
      toast.success(
        ordered.length > 1
          ? `串接 ${ordered.length} 個檔案 · 共 ${allSegments.length} 段逐字稿`
          : `產生 ${allSegments.length} 段逐字稿`
      );
      router.push("/editor");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`處理失敗：${msg}`);
      setStage("idle");
      setProgress(0);
      setQueueAhead(0);
      setRetry(null);
      setActiveIdx(-1);
    }
  };

  const busy = stage !== "idle" && stage !== "done";
  const empty = staged.length === 0;

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
            if (busy) return;
            e.preventDefault();
            setHovered(true);
          }}
          onDragLeave={() => setHovered(false)}
          onDrop={(e) => {
            if (busy) {
              e.preventDefault();
              return;
            }
            onDrop(e);
          }}
          onClick={busy ? undefined : onPickClick}
          aria-disabled={busy}
          className={cn(
            "group relative flex flex-col items-center justify-center rounded-sm border border-dashed border-cream-100/25 bg-ink-800/40 px-6 text-center transition-all",
            empty ? "py-12" : "py-6",
            busy
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer",
            !busy && hovered &&
              "border-vermillion/70 bg-vermillion/[0.04] shadow-inner",
            !empty && "border-cream-100/35 bg-ink-800/60"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*"
            multiple
            disabled={busy}
            className="hidden"
            onChange={onPickChange}
          />
          <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full border border-cream-100/15 bg-ink-700/60">
            <UploadCloud className="h-5 w-5 text-cream-200" />
          </div>
          <div className="font-display italic text-xl leading-tight text-cream-100">
            {empty
              ? "拖曳檔案至此 · 或點擊選擇"
              : `再加入更多檔案 · 已選 ${staged.length}`}
          </div>
          <div className="mt-2 font-mono text-[10px] tracking-[0.2em] text-cream-500">
            MP3 · WAV · M4A · MP4 · MOV · WEBM · MKV
          </div>
          {empty && (
            <div className="mt-3 max-w-[32ch] text-pretty text-xs leading-relaxed text-muted-foreground">
              一次可選多個檔案。會依「修改時間」排序，自動串接成同一份會議報告。
            </div>
          )}
        </div>

        {/* Staged file list */}
        {!empty && (
          <div className="space-y-1.5">
            <div className="flex items-end justify-between gap-3 pb-1">
              <Label className="!small-caps !tracking-[0.22em]">
                <span className="inline-flex items-center gap-1.5">
                  <FileAudio className="h-3 w-3" /> 檔案順序 ·{" "}
                  {staged.length} ITEM{staged.length === 1 ? "" : "S"}
                </span>
              </Label>
              <span className="font-mono text-[10px] tracking-[0.2em] text-cream-500">
                {formatBytes(totalBytes)}
              </span>
            </div>
            <ul className="space-y-1 rounded-sm border border-cream-100/15 bg-ink-800/30 p-1.5 max-h-[12.5rem] overflow-y-auto scrollbar-thin">
              {staged.map((s, i) => {
                const isAudio = s.file.type.startsWith("audio/");
                const isActive = busy && activeIdx === i;
                const isDone = busy && activeIdx > i;
                return (
                  <li
                    key={s.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors",
                      isActive
                        ? "bg-vermillion/[0.07]"
                        : isDone
                          ? "opacity-50"
                          : "hover:bg-cream-100/[0.04]"
                    )}
                  >
                    <span className="w-6 font-mono text-[10px] tabular-nums text-cream-500">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {isAudio ? (
                      <FileAudio className="h-3.5 w-3.5 shrink-0 text-cream-400" />
                    ) : (
                      <FileVideo className="h-3.5 w-3.5 shrink-0 text-cream-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-sans text-sm text-cream-100">
                        {s.file.name}
                      </div>
                      <div className="font-mono text-[10px] tabular-nums tracking-[0.1em] text-cream-500">
                        {formatBytes(s.file.size)} ·{" "}
                        {new Date(s.file.lastModified)
                          .toISOString()
                          .replace("T", " ")
                          .slice(0, 16)}
                      </div>
                    </div>
                    {isActive && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-vermillion" />
                    )}
                    {!busy && (
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          aria-label="上移"
                          disabled={i === 0}
                          onClick={() => moveStaged(s.id, -1)}
                          className="rounded-sm p-1 text-cream-400 hover:bg-cream-100/10 disabled:opacity-30"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          aria-label="下移"
                          disabled={i === staged.length - 1}
                          onClick={() => moveStaged(s.id, 1)}
                          className="rounded-sm p-1 text-cream-400 hover:bg-cream-100/10 disabled:opacity-30"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                        <button
                          aria-label="移除"
                          onClick={() => removeStaged(s.id)}
                          className="rounded-sm p-1 text-cream-400 hover:bg-vermillion/15 hover:text-vermillion"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Controls — always stacked */}
        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Languages className="h-3 w-3" /> 來源語言
            </Label>
            <Select
              value={uiLanguage}
              onValueChange={setUILanguage}
              disabled={busy}
            >
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
              <Switch
                checked={diarize}
                onCheckedChange={setDiarize}
                disabled={busy}
              />
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
                {staged.length > 1 && activeIdx >= 0 && (
                  <>
                    FILE {activeIdx + 1} / {staged.length} ·{" "}
                  </>
                )}
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
            {!empty ? (
              <>
                預估處理 ≈ {formatShort((totalBytes / 1024 / 1024) * 0.6)}
              </>
            ) : (
              <>只上傳音訊　影片不外流</>
            )}
          </div>
          <Button
            variant="vermillion"
            size="lg"
            disabled={empty || busy}
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
