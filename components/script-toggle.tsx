"use client";

import { useEffect, useTransition } from "react";
import { useProject, type Script } from "@/store/project-store";
import { convertChinese } from "@/lib/chinese-convert";
import { Loader2 } from "lucide-react";

const OPTIONS: { value: Script; label: string }[] = [
  { value: "original", label: "原文" },
  { value: "traditional", label: "繁體" },
  { value: "simplified", label: "簡體" },
];

/** Front-end T/S conversion — only mutates the displayed transcript; the
 *  segmentsOriginal store entry stays as the canonical source. */
export function ScriptToggle() {
  const script = useProject((s) => s.script);
  const setScript = useProject((s) => s.setScript);
  const segments = useProject((s) => s.segments);
  const setSegments = useProject((s) => s.setSegments);
  const original = useProject((s) => s.segmentsOriginal);
  const [pending, startTransition] = useTransition();

  const apply = async (next: Script) => {
    setScript(next);
    if (next === "original") {
      // Restore original verbatim.
      startTransition(() => setSegments(original));
      return;
    }
    const target = next === "traditional" ? "traditional" : "simplified";
    const converted = await Promise.all(
      original.map(async (s) => ({
        ...s,
        text: await convertChinese(s.text, target),
      }))
    );
    startTransition(() => setSegments(converted));
  };

  // If segments arrive after the toggle was set (mount race), apply once.
  useEffect(() => {
    if (script !== "original" && original.length && segments === original) {
      void apply(script);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original.length]);

  return (
    <div className="inline-flex items-center gap-0 rounded-sm border border-cream-100/20 bg-ink-800/40 p-0.5">
      {OPTIONS.map((opt) => {
        const active = script === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => apply(opt.value)}
            className={
              "relative inline-flex items-center gap-1.5 px-2.5 py-1 font-mono text-[10px] tracking-[0.2em] transition-colors " +
              (active
                ? "bg-cream-100 text-ink-900"
                : "text-cream-400 hover:text-cream-100")
            }
          >
            {pending && active ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : null}
            {opt.label.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
