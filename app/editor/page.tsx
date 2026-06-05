"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { AudioBar } from "@/components/audio-bar";
import { TranscriptPane } from "@/components/transcript-pane";
import { ReportPane } from "@/components/report-pane";
import { ScriptToggle } from "@/components/script-toggle";
import { useProject } from "@/store/project-store";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import {
  DEMO_REPORT,
  DEMO_SEGMENTS,
  DEMO_SPEAKERS,
} from "@/lib/demo-fixture";

function EditorPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const segments = useProject((s) => s.segments);
  const sourceFiles = useProject((s) => s.sourceFiles);
  const setSegments = useProject((s) => s.setSegments);
  const setSegmentsOriginal = useProject((s) => s.setSegmentsOriginal);
  const replaceSpeakers = useProject((s) => s.replaceSpeakers);
  const setReport = useProject((s) => s.setReport);
  const setDuration = useProject((s) => s.setDuration);

  // ?demo=1 seeds example data so the editor is browsable without an upload.
  useEffect(() => {
    if (
      params.get("demo") === "1" &&
      segments.length === 0
    ) {
      replaceSpeakers(
        DEMO_SPEAKERS.map((s) => ({ id: s.id, name: s.name }))
      );
      setSegmentsOriginal(DEMO_SEGMENTS);
      setSegments(DEMO_SEGMENTS);
      setReport(DEMO_REPORT, "Traditional Chinese (zh-TW)");
      setDuration(60);
    }
  }, [
    params,
    segments.length,
    replaceSpeakers,
    setSegmentsOriginal,
    setSegments,
    setReport,
    setDuration,
  ]);

  // No transcript and no demo? Bounce back home.
  useEffect(() => {
    if (
      segments.length === 0 &&
      sourceFiles.length === 0 &&
      params.get("demo") !== "1"
    ) {
      const t = setTimeout(() => router.replace("/"), 200);
      return () => clearTimeout(t);
    }
  }, [segments.length, sourceFiles.length, router, params]);

  const sourceLabel =
    sourceFiles.length === 0
      ? "—"
      : sourceFiles.length === 1
        ? sourceFiles[0].name
        : `${sourceFiles[0].name} + ${sourceFiles.length - 1} 個檔案`;

  return (
    <main className="relative min-h-screen pb-24">
      <AudioBar />

      <div className="container mx-auto px-6 pt-6">
        {/* Sub-header — page title + script toggle. */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-cream-100/15 pb-4">
          <div>
            <div className="flex items-center gap-3">
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="-ml-2 gap-1.5 text-cream-400"
              >
                <Link href="/">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回
                </Link>
              </Button>
              <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
                DOSSIER · OPEN FOLIO
              </div>
            </div>
            <h1 className="mt-1 font-display italic text-[clamp(2rem,4vw,3.25rem)] leading-none text-cream-50">
              編輯室
            </h1>
            <p
              className="mt-1 font-mono text-[10px] tracking-[0.25em] text-cream-500 max-w-[70ch] truncate"
              title={sourceFiles.map((f) => f.name).join(" · ")}
            >
              {sourceLabel}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
              SCRIPT
            </span>
            <ScriptToggle />
          </div>
        </div>

        {/* Two-pane editor. */}
        <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] xl:gap-12">
          <TranscriptPane />
          <ReportPane />
        </div>
      </div>
    </main>
  );
}

export default function EditorPage() {
  return (
    <Suspense fallback={null}>
      <EditorPageInner />
    </Suspense>
  );
}
