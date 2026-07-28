"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "@/store/project-store";
import { cn, formatTimeFull } from "@/lib/utils";
import { Pencil, Check, Type, ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAutoGrow } from "@/lib/use-auto-grow";

/** In-place editor for one segment. Split out of the row so the growing
 *  textarea can hold a hook — rows are rendered in a map. */
function SegmentEditor({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useAutoGrow(value);
  return (
    <textarea
      ref={ref}
      autoFocus
      value={value}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit();
        if (e.key === "Escape") onCancel();
      }}
      className="mt-1.5 w-full resize-none overflow-hidden rounded-sm border border-vermillion/40 bg-ink-800/60 px-2 py-1.5 font-han text-[15px] leading-relaxed text-cream-50 outline-none focus:border-vermillion"
    />
  );
}

/** Ledger-style transcript. Each segment is a row. Click row to seek; click
 *  pencil to edit text in-place. Speaker chip color from the project store. */
export function TranscriptPane() {
  const segments = useProject((s) => s.segments);
  const speakers = useProject((s) => s.speakers);
  const updateSegment = useProject((s) => s.updateSegment);
  const updateSpeaker = useProject((s) => s.updateSpeaker);
  const activeSegmentId = useProject((s) => s.activeSegmentId);
  const setActiveSegment = useProject((s) => s.setActiveSegment);

  const speakerById = useMemo(
    () => new Map(speakers.map((s) => [s.id, s])),
    [speakers]
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState("");

  const listRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll the active segment into view as audio progresses.
  useEffect(() => {
    if (!activeSegmentId) return;
    const node = listRef.current?.querySelector(
      `[data-seg-id="${activeSegmentId}"]`
    ) as HTMLElement | null;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeSegmentId]);

  const startEdit = (id: string, text: string) => {
    setEditingId(id);
    setDraft(text);
  };
  const commitEdit = () => {
    if (editingId) updateSegment(editingId, { text: draft });
    setEditingId(null);
  };

  const seekTo = (sec: number) => {
    const seek = (
      window as unknown as { __superMinutesSeek?: (s: number) => void }
    ).__superMinutesSeek;
    if (seek) seek(sec);
  };

  return (
    <div className="space-y-4 lg:sticky lg:top-[5.5rem] lg:max-h-[calc(100vh-6rem)] lg:overflow-hidden lg:flex lg:flex-col">
      {/* Section heading — periodical mast. */}
      <header className="flex items-end justify-between border-b border-cream-100/15 pb-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
            SECTION A
          </div>
          <h2 className="font-display italic text-3xl leading-none text-cream-50">
            逐字稿
          </h2>
        </div>
        <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
          {segments.length} ENTRIES
        </div>
      </header>

      {/* Speaker key */}
      {speakers.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-sm border border-cream-100/15 bg-ink-800/30 px-4 py-3">
          <span className="font-mono text-[10px] tracking-[0.25em] text-cream-500">
            DRAMATIS
          </span>
          {speakers.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <span
                className="speaker-chip"
                style={{ background: s.color }}
              />
              {editingSpeaker === s.id ? (
                <Input
                  autoFocus
                  value={speakerDraft}
                  onChange={(e) => setSpeakerDraft(e.target.value)}
                  onBlur={() => {
                    updateSpeaker(s.id, { name: speakerDraft || s.name });
                    setEditingSpeaker(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditingSpeaker(null);
                  }}
                  className="h-6 w-28 px-2 py-0 text-xs"
                />
              ) : (
                <button
                  onClick={() => {
                    setEditingSpeaker(s.id);
                    setSpeakerDraft(s.name);
                  }}
                  className="font-display italic text-base text-cream-100 hover:text-cream-50"
                  title="點擊重新命名"
                >
                  {s.name}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The ledger. */}
      <div
        ref={listRef}
        className="space-y-0 rounded-sm border border-cream-100/15 bg-ink-800/20 max-h-[calc(100vh-22rem)] lg:flex-1 lg:max-h-none overflow-y-auto scrollbar-thin"
      >
        {segments.length === 0 ? (
          <div className="p-10 text-center font-display italic text-cream-400">
            尚未產生逐字稿。
          </div>
        ) : (
          segments.map((seg, idx) => {
            const speaker = seg.speakerId
              ? speakerById.get(seg.speakerId)
              : null;
            const isActive = activeSegmentId === seg.id;
            const editing = editingId === seg.id;
            return (
              <div
                key={seg.id}
                data-seg-id={seg.id}
                onClick={() => {
                  setActiveSegment(seg.id);
                  seekTo(seg.start);
                }}
                className={cn(
                  "group relative grid cursor-pointer grid-cols-[3.25rem_1fr_auto] gap-4 border-b border-cream-100/8 px-4 py-3 transition-colors",
                  isActive
                    ? "bg-vermillion/[0.07]"
                    : "hover:bg-cream-100/[0.025]"
                )}
              >
                {/* Active row mark — vermillion bar on the left edge. */}
                {isActive && (
                  <span className="absolute left-0 top-0 h-full w-[2px] bg-vermillion" />
                )}
                {/* Row ordinal + timecode */}
                <div className="flex flex-col items-start gap-0.5 pt-0.5">
                  <span className="font-mono text-[10px] tracking-[0.1em] text-cream-500 tabular-nums">
                    {String(idx + 1).padStart(3, "0")}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-cream-300">
                    {formatTimeFull(seg.start)}
                  </span>
                </div>

                {/* Speaker + text */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {speaker && (
                      <>
                        <span
                          className="speaker-chip"
                          style={{ background: speaker.color }}
                        />
                        <span className="font-display italic text-sm leading-none text-cream-200">
                          {speaker.name}
                        </span>
                      </>
                    )}
                    <span className="font-mono text-[10px] tracking-[0.2em] text-cream-500">
                      · {formatTimeFull(seg.end)}
                    </span>
                  </div>
                  {editing ? (
                    <SegmentEditor
                      value={draft}
                      onChange={setDraft}
                      onCommit={commitEdit}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <p className="mt-1 font-han text-[15px] leading-[1.7] text-cream-100 text-pretty">
                      {seg.text || (
                        <span className="text-cream-500 italic">（空白）</span>
                      )}
                    </p>
                  )}
                </div>

                {/* Inline edit toggle. */}
                <div className="flex flex-col items-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {editing ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        commitEdit();
                      }}
                    >
                      <Check className="h-3.5 w-3.5 text-vermillion" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(seg.id, seg.text);
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.25em] text-cream-500">
        <span className="inline-flex items-center gap-2">
          <Type className="h-3 w-3" />
          POINT-AND-CLICK · ⌘+ENTER TO SAVE
        </span>
        <span className="inline-flex items-center gap-2">
          <ListPlus className="h-3 w-3" />
          ROW HOVER FOR EDIT
        </span>
      </div>
    </div>
  );
}
