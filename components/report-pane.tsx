"use client";

import { useEffect, useState } from "react";
import { useProject } from "@/store/project-store";
import { toast } from "sonner";
import {
  Loader2,
  Sparkles,
  RotateCw,
  FileDown,
  FileType2,
  FileText,
  CheckSquare,
  Plus,
  Trash2,
  PencilLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGES } from "@/lib/types";
import {
  buildTranscriptForLLM,
  generateReport,
  languageName,
  LANGUAGE_NAMES,
} from "@/lib/report-client";
import { exportMarkdown, exportDocx, exportPdf } from "@/lib/export";
import { cn } from "@/lib/utils";

/** The right-hand pane — the report itself, plus controls to regenerate and
 *  export. Editable inline. */
export function ReportPane() {
  const segments = useProject((s) => s.segments);
  const speakers = useProject((s) => s.speakers);
  const report = useProject((s) => s.report);
  const setReport = useProject((s) => s.setReport);
  const reportPending = useProject((s) => s.reportPending);
  const setReportPending = useProject((s) => s.setReportPending);
  const uiLanguage = useProject((s) => s.uiLanguage);
  const detectedLanguage = useProject((s) => s.language);
  const reportLanguage = useProject((s) => s.reportLanguage);
  const [outputLang, setOutputLang] = useState<string>("auto");

  // Default output language follows the source.
  useEffect(() => {
    if (uiLanguage !== "auto") setOutputLang(uiLanguage);
    else if (detectedLanguage === "zh") setOutputLang("zh-Hant");
    else if (detectedLanguage) setOutputLang(detectedLanguage);
  }, [uiLanguage, detectedLanguage]);

  // Auto-generate once on first paint if there's a transcript and no report.
  useEffect(() => {
    if (!report && !reportPending && segments.length > 0) {
      void generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length]);

  async function generate() {
    if (!segments.length) return;
    setReportPending(true);
    try {
      const transcript = buildTranscriptForLLM(segments, speakers);
      const lang =
        outputLang === "auto"
          ? (LANGUAGE_NAMES[
              detectedLanguage === "zh" ? "zh-Hant" : detectedLanguage || "auto"
            ] ?? LANGUAGE_NAMES.auto)
          : languageName(outputLang);
      toast.message(`正在用 ${lang} 整理會議報告…`);
      const { report: r, language } = await generateReport({
        transcript,
        languageName: lang,
      });
      setReport(r, language);
      toast.success("報告生成完成");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
    } finally {
      setReportPending(false);
    }
  }

  if (segments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-sm border border-dashed border-cream-100/15 bg-ink-800/20 p-12 text-center">
        <div>
          <div className="ornament font-mono text-[10px] tracking-[0.3em] text-cream-500">
            BLANK FOLIO
          </div>
          <p className="mt-3 font-display italic text-2xl text-cream-300">
            等逐字稿就緒，這裡會自動長出會議報告。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Section heading. */}
      <header className="flex items-end justify-between border-b border-cream-100/15 pb-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
            SECTION B
          </div>
          <h2 className="font-display italic text-3xl leading-none text-cream-50">
            會議報告
          </h2>
        </div>
        {reportLanguage && (
          <Badge variant="vermillion">{reportLanguage}</Badge>
        )}
      </header>

      {/* Controls. */}
      <div className="grid grid-cols-1 gap-3 rounded-sm border border-cream-100/15 bg-ink-800/30 p-4 sm:grid-cols-[1fr_auto_auto]">
        <div className="space-y-1.5">
          <Label>輸出語言</Label>
          <Select value={outputLang} onValueChange={setOutputLang}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">跟隨來源</SelectItem>
              {LANGUAGES.filter((l) => l.value !== "auto").map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button
            variant="outline"
            onClick={generate}
            disabled={reportPending}
            className="gap-2"
          >
            {reportPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            {report ? "重新生成" : "生成報告"}
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              report && exportMarkdown(report, segments, speakers)
            }
            disabled={!report}
            className="gap-1.5"
          >
            <FileText className="h-3.5 w-3.5" /> .md
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => report && exportDocx(report, segments, speakers)}
            disabled={!report}
            className="gap-1.5"
          >
            <FileType2 className="h-3.5 w-3.5" /> .docx
          </Button>
          <Button
            variant="vermillion"
            size="sm"
            onClick={() => report && exportPdf(report, segments, speakers)}
            disabled={!report}
            className="gap-1.5"
          >
            <FileDown className="h-3.5 w-3.5" /> .pdf
          </Button>
        </div>
      </div>

      {/* The report itself. */}
      {reportPending && !report ? (
        <ReportSkeleton />
      ) : report ? (
        <ReportBody />
      ) : (
        <div className="p-10 text-center font-display italic text-cream-400">
          按「生成報告」開始。
        </div>
      )}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-10 w-2/3 animate-pulse rounded-sm bg-cream-100/[0.06]" />
        <div className="h-4 w-full animate-pulse rounded-sm bg-cream-100/[0.04]" />
        <div className="h-4 w-5/6 animate-pulse rounded-sm bg-cream-100/[0.04]" />
      </div>
      <div className="space-y-2">
        <div className="h-6 w-1/3 animate-pulse rounded-sm bg-cream-100/[0.06]" />
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="h-3 w-full animate-pulse rounded-sm bg-cream-100/[0.04]"
            style={{ width: `${90 - i * 10}%` }}
          />
        ))}
      </div>
      <div className="ornament font-mono text-[10px] tracking-[0.3em] text-vermillion">
        DRAFTING
      </div>
    </div>
  );
}

function ReportBody() {
  const report = useProject((s) => s.report);
  const setReport = useProject((s) => s.setReport);
  const reportLanguage = useProject((s) => s.reportLanguage);
  const [editingTitle, setEditingTitle] = useState(false);
  if (!report) return null;

  const update = (patch: Partial<typeof report>) =>
    setReport({ ...report, ...patch });

  return (
    <article className="space-y-8 rounded-sm border border-cream-100/15 bg-ink-800/15 p-6 sm:p-8">
      {/* Title block. */}
      <div>
        <div className="font-mono text-[10px] tracking-[0.3em] text-vermillion">
          MINUTES · STAMPED
        </div>
        {editingTitle ? (
          <Input
            autoFocus
            value={report.title}
            onChange={(e) => update({ title: e.target.value })}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="mt-2 h-auto !text-4xl font-display italic !text-cream-50 !bg-transparent !border-vermillion/60"
          />
        ) : (
          <h1
            onClick={() => setEditingTitle(true)}
            className="mt-2 cursor-text font-display italic text-balance text-[clamp(2rem,4.5vw,3.5rem)] leading-[0.95] text-cream-50"
          >
            {report.title || "（未命名）"}
          </h1>
        )}
      </div>

      {/* Summary. */}
      <Section ordinal="I" title="會議紀要">
        <Textarea
          value={report.summary}
          onChange={(e) => update({ summary: e.target.value })}
          rows={Math.max(2, Math.ceil(report.summary.length / 36))}
          className="font-han text-[15px] leading-[1.85] text-cream-100 border-cream-100/10 bg-transparent focus-visible:border-vermillion/40"
        />
      </Section>

      {/* Conclusions. */}
      <Section ordinal="II" title="主要結論">
        <EditableList
          items={report.conclusions}
          onChange={(next) => update({ conclusions: next })}
          placeholder="新增結論…"
        />
      </Section>

      {/* Topics. */}
      <Section ordinal="III" title="議題與要點">
        <div className="space-y-5">
          {report.topics.map((topic, ti) => (
            <div
              key={ti}
              className="rounded-sm border border-cream-100/10 bg-cream-100/[0.02] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <Input
                  value={topic.heading}
                  onChange={(e) => {
                    const next = report.topics.slice();
                    next[ti] = { ...topic, heading: e.target.value };
                    update({ topics: next });
                  }}
                  className="h-auto !text-xl font-display italic !text-cream-50 border-none bg-transparent p-0 focus-visible:!border-none focus-visible:ring-0"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    const next = report.topics.slice();
                    next.splice(ti, 1);
                    update({ topics: next });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="mt-3">
                <EditableList
                  items={topic.points}
                  onChange={(pts) => {
                    const next = report.topics.slice();
                    next[ti] = { ...topic, points: pts };
                    update({ topics: next });
                  }}
                  placeholder="新增要點…"
                />
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() =>
              update({
                topics: [
                  ...report.topics,
                  { heading: "新議題", points: [] },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> 新增議題
          </Button>
        </div>
      </Section>

      {/* Actions. */}
      <Section ordinal="IV" title="待辦行動項">
        <div className="space-y-2">
          {report.actions.map((a, i) => (
            <ActionRow
              key={i}
              value={a}
              onChange={(patch) => {
                const next = report.actions.slice();
                next[i] = { ...a, ...patch };
                update({ actions: next });
              }}
              onRemove={() => {
                const next = report.actions.slice();
                next.splice(i, 1);
                update({ actions: next });
              }}
            />
          ))}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() =>
              update({
                actions: [
                  ...report.actions,
                  { task: "", owner: null, due: null },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> 新增待辦
          </Button>
        </div>
      </Section>

      <div className="flex items-center justify-between border-t border-cream-100/10 pt-4 font-mono text-[10px] tracking-[0.3em] text-cream-500">
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-3 w-3 text-vermillion" />
          {reportLanguage ?? "DRAFT"}
        </span>
        <span className="inline-flex items-center gap-2">
          <PencilLine className="h-3 w-3" />
          CLICK ANY FIELD TO EDIT
        </span>
      </div>
    </article>
  );
}

function Section({
  ordinal,
  title,
  children,
}: {
  ordinal: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="relative">
      {/* Big italic ordinal in the margin. */}
      <div className="absolute -left-4 top-0 hidden font-display italic text-3xl text-cream-100/15 sm:block">
        {ordinal}.
      </div>
      <header className="mb-3 flex items-baseline gap-3">
        <span className="ordinal font-display italic text-3xl sm:hidden">
          {ordinal}.
        </span>
        <h3 className="font-display italic text-2xl text-cream-50">{title}</h3>
        <span className="h-px flex-1 bg-cream-100/10" />
      </header>
      {children}
    </section>
  );
}

function EditableList({
  items,
  onChange,
  placeholder,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li
          key={i}
          className={cn(
            "group flex items-start gap-3 rounded-sm border border-transparent px-2 py-1.5 hover:border-cream-100/10"
          )}
        >
          <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-vermillion" />
          <textarea
            value={item}
            onChange={(e) => {
              const next = items.slice();
              next[i] = e.target.value;
              onChange(next);
            }}
            rows={Math.max(1, Math.ceil(item.length / 40))}
            className="w-full resize-none bg-transparent font-han text-[15px] leading-[1.8] text-cream-100 outline-none"
            placeholder={placeholder}
          />
          <button
            onClick={() => {
              const next = items.slice();
              next.splice(i, 1);
              onChange(next);
            }}
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5 text-cream-400 hover:text-vermillion" />
          </button>
        </li>
      ))}
      <li>
        <button
          onClick={() => onChange([...items, ""])}
          className="inline-flex items-center gap-2 px-2 py-1 font-mono text-[10px] tracking-[0.25em] text-cream-500 hover:text-cream-200"
        >
          <Plus className="h-3 w-3" /> ADD
        </button>
      </li>
    </ul>
  );
}

function ActionRow({
  value,
  onChange,
  onRemove,
}: {
  value: { task: string; owner?: string | null; due?: string | null };
  onChange: (
    patch: Partial<{ task: string; owner: string | null; due: string | null }>
  ) => void;
  onRemove: () => void;
}) {
  const [done, setDone] = useState(false);
  return (
    <div
      className={cn(
        "group grid grid-cols-1 items-start gap-2 rounded-sm border border-cream-100/10 bg-cream-100/[0.02] px-3 py-2 sm:grid-cols-[auto_1fr_auto_auto_auto]"
      )}
    >
      <button
        onClick={() => setDone(!done)}
        className={cn(
          "mt-1 inline-flex h-5 w-5 items-center justify-center rounded-sm border border-cream-100/30 transition-colors",
          done && "border-vermillion bg-vermillion text-cream-50"
        )}
      >
        {done && <CheckSquare className="h-3 w-3" />}
      </button>
      <textarea
        value={value.task}
        onChange={(e) => onChange({ task: e.target.value })}
        rows={1}
        className={cn(
          "resize-none bg-transparent font-han text-[15px] leading-relaxed text-cream-100 outline-none",
          done && "line-through text-cream-400"
        )}
        placeholder="行動項…"
      />
      <Input
        value={value.owner ?? ""}
        onChange={(e) => onChange({ owner: e.target.value || null })}
        placeholder="負責人"
        className="!h-7 w-28 px-2 text-xs"
      />
      <Input
        value={value.due ?? ""}
        onChange={(e) => onChange({ due: e.target.value || null })}
        placeholder="期限"
        className="!h-7 w-24 px-2 text-xs"
      />
      <button
        onClick={onRemove}
        className="opacity-0 transition-opacity group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5 text-cream-400 hover:text-vermillion" />
      </button>
    </div>
  );
}
