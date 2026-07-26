"use client";

import type { MinutesReport, SpeakerProfile, TranscriptSegment } from "./types";
import { formatTimeFull, nowStamp } from "./utils";

/** ----------------- Markdown ----------------- */

export function reportToMarkdown(
  report: MinutesReport,
  segments: TranscriptSegment[],
  speakers: SpeakerProfile[]
): string {
  const speakerById = new Map(speakers.map((s) => [s.id, s]));
  const out: string[] = [];

  out.push(`# ${report.title || "會議報告"}`);
  out.push("");
  if (report.summary) {
    out.push("## 會議紀要");
    out.push("");
    out.push(report.summary);
    out.push("");
  }
  if (report.conclusions.length) {
    out.push("## 主要結論");
    out.push("");
    for (const c of report.conclusions) out.push(`- ${c}`);
    out.push("");
  }
  if (report.topics.length) {
    out.push("## 議題與要點");
    out.push("");
    for (const t of report.topics) {
      out.push(`### ${t.heading}`);
      out.push("");
      if (t.subtopics?.length) {
        for (const st of t.subtopics) {
          out.push(`#### ${st.heading}`);
          out.push("");
          for (const p of st.points) out.push(`- ${p}`);
          out.push("");
        }
      } else {
        for (const p of t.points) out.push(`- ${p}`);
        out.push("");
      }
    }
  }
  if (report.openQuestions.length) {
    out.push("## 待決事項");
    out.push("");
    for (const q of report.openQuestions) out.push(`- ${q}`);
    out.push("");
  }
  if (report.actions.length) {
    out.push("## 待辦行動項");
    out.push("");
    for (const a of report.actions) {
      const owner = a.owner ? ` · 負責：${a.owner}` : "";
      const due = a.due ? ` · 期限：${a.due}` : "";
      out.push(`- [ ] ${a.task}${owner}${due}`);
    }
    out.push("");
  }
  out.push("---");
  out.push("");
  out.push("## 逐字稿");
  out.push("");
  for (const seg of segments) {
    const who = seg.speakerId
      ? (speakerById.get(seg.speakerId)?.name ?? seg.speakerId)
      : "—";
    out.push(`**[${formatTimeFull(seg.start)}] ${who}**`);
    out.push("");
    out.push(seg.text);
    out.push("");
  }
  return out.join("\n");
}

export function downloadFile(
  contents: BlobPart,
  filename: string,
  mime: string
) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function exportMarkdown(
  report: MinutesReport,
  segments: TranscriptSegment[],
  speakers: SpeakerProfile[]
) {
  const md = reportToMarkdown(report, segments, speakers);
  const name = `minutes_${slugify(report.title)}_${nowStamp()}.md`;
  downloadFile(md, name, "text/markdown;charset=utf-8");
}

/** ----------------- DOCX ----------------- */

export async function exportDocx(
  report: MinutesReport,
  segments: TranscriptSegment[],
  speakers: SpeakerProfile[]
) {
  const docx = await import("docx");
  const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel,
    TextRun,
    AlignmentType,
  } = docx;
  const byId = new Map(speakers.map((s) => [s.id, s]));

  const p = (children: import("docx").IRunOptions[], opts: {
    heading?: keyof typeof HeadingLevel;
    spacingAfter?: number;
    alignment?: keyof typeof AlignmentType;
  } = {}) =>
    new Paragraph({
      heading: opts.heading ? HeadingLevel[opts.heading] : undefined,
      alignment: opts.alignment ? AlignmentType[opts.alignment] : undefined,
      spacing: { after: opts.spacingAfter ?? 120 },
      children: children.map((r) => new TextRun(r)),
    });

  const bullet = (text: string) =>
    new Paragraph({
      bullet: { level: 0 },
      children: [new TextRun({ text })],
      spacing: { after: 80 },
    });

  const body: import("docx").Paragraph[] = [];
  body.push(p([{ text: report.title || "會議報告", bold: true }], { heading: "HEADING_1", alignment: "CENTER", spacingAfter: 300 }));

  if (report.summary) {
    body.push(p([{ text: "會議紀要", bold: true }], { heading: "HEADING_2" }));
    body.push(p([{ text: report.summary }]));
  }
  if (report.conclusions.length) {
    body.push(p([{ text: "主要結論", bold: true }], { heading: "HEADING_2" }));
    for (const c of report.conclusions) body.push(bullet(c));
  }
  if (report.topics.length) {
    body.push(p([{ text: "議題與要點", bold: true }], { heading: "HEADING_2" }));
    for (const t of report.topics) {
      body.push(p([{ text: t.heading, bold: true }], { heading: "HEADING_3" }));
      if (t.subtopics?.length) {
        for (const st of t.subtopics) {
          body.push(
            p([{ text: st.heading, bold: true }], { heading: "HEADING_4" })
          );
          for (const pt of st.points) body.push(bullet(pt));
        }
      } else {
        for (const pt of t.points) body.push(bullet(pt));
      }
    }
  }
  if (report.openQuestions.length) {
    body.push(p([{ text: "待決事項", bold: true }], { heading: "HEADING_2" }));
    for (const q of report.openQuestions) body.push(bullet(q));
  }
  if (report.actions.length) {
    body.push(p([{ text: "待辦行動項", bold: true }], { heading: "HEADING_2" }));
    for (const a of report.actions) {
      const owner = a.owner ? ` · 負責：${a.owner}` : "";
      const due = a.due ? ` · 期限：${a.due}` : "";
      body.push(bullet(`☐  ${a.task}${owner}${due}`));
    }
  }

  // Separator line then transcript.
  body.push(p([{ text: "──────────────────────", color: "888888" }], { alignment: "CENTER", spacingAfter: 200 }));
  body.push(p([{ text: "逐字稿", bold: true }], { heading: "HEADING_2" }));
  for (const seg of segments) {
    const who = seg.speakerId
      ? (byId.get(seg.speakerId)?.name ?? seg.speakerId)
      : "—";
    body.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({
            text: `[${formatTimeFull(seg.start)}] ${who}: `,
            bold: true,
            color: byId.get(seg.speakerId ?? "")?.color?.replace("#", "") ?? "555555",
          }),
          new TextRun({ text: seg.text }),
        ],
      })
    );
  }

  const doc = new Document({
    creator: "Super Minutes",
    title: report.title,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { line: 320 } },
        },
      },
    },
    sections: [{ children: body }],
  });

  const blob = await Packer.toBlob(doc);
  const name = `minutes_${slugify(report.title)}_${nowStamp()}.docx`;
  downloadFile(blob, name, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

/** ----------------- PDF ----------------- */

export async function exportPdf(
  report: MinutesReport,
  segments: TranscriptSegment[],
  speakers: SpeakerProfile[]
) {
  // jsPDF default fonts don't include CJK. We render via a hidden DOM node
  // and use the browser's print pipeline so the user's installed Chinese
  // fonts work without us shipping a 5 MB woff. The browser's print dialog
  // → "Save as PDF" is fine for our use case and avoids the CJK-glyph mess.
  const html = pdfHtml(report, segments, speakers);
  const w = window.open("", "_blank");
  if (!w) {
    // Pop-up blocked — fall back to opening a Blob in this tab so the user
    // can still File → Save / Print.
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.location.href = url;
    return;
  }
  w.document.write(html);
  w.document.close();
  // Give the new window a tick to render, then trigger print.
  w.addEventListener("load", () => {
    setTimeout(() => {
      w.focus();
      w.print();
    }, 300);
  });
  // For browsers where window.open doesn't fire load (about:blank), try
  // immediately too.
  setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {}
  }, 800);
}

function pdfHtml(
  report: MinutesReport,
  segments: TranscriptSegment[],
  speakers: SpeakerProfile[]
): string {
  const byId = new Map(speakers.map((s) => [s.id, s]));
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const conclusions = report.conclusions
    .map((c) => `<li>${esc(c)}</li>`)
    .join("");
  const topics = report.topics
    .map((t) => {
      const body = t.subtopics?.length
        ? t.subtopics
            .map(
              (st) =>
                `<h4>${esc(st.heading)}</h4><ul>${st.points
                  .map((p) => `<li>${esc(p)}</li>`)
                  .join("")}</ul>`
            )
            .join("")
        : `<ul>${t.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
      return `
        <section class="topic">
          <h3>${esc(t.heading)}</h3>
          ${body}
        </section>`;
    })
    .join("");
  const openQuestions = report.openQuestions
    .map((q) => `<li>${esc(q)}</li>`)
    .join("");
  const actions = report.actions
    .map((a) => {
      const owner = a.owner ? ` · 負責：${esc(a.owner)}` : "";
      const due = a.due ? ` · 期限：${esc(a.due)}` : "";
      return `<li>☐ ${esc(a.task)}${owner}${due}</li>`;
    })
    .join("");
  const rows = segments
    .map((s) => {
      const who = s.speakerId
        ? (byId.get(s.speakerId)?.name ?? s.speakerId)
        : "—";
      const color = byId.get(s.speakerId ?? "")?.color ?? "#555";
      return `
        <tr>
          <td class="t">${formatTimeFull(s.start)}</td>
          <td class="s" style="color:${color}">${esc(who)}</td>
          <td class="x">${esc(s.text)}</td>
        </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<title>${esc(report.title || "會議報告")}</title>
<style>
  @page { margin: 18mm 16mm; }
  :root {
    --ink: #16151A;
    --rule: #d6cbb4;
    --cream: #FAF6EC;
    --vermillion: #B83A3A;
  }
  body {
    font-family: "Noto Serif TC","Source Han Serif TC", Georgia, serif;
    color: var(--ink);
    background: var(--cream);
    line-height: 1.7;
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 {
    font-family: "Instrument Serif","Noto Serif TC", Georgia, serif;
    font-style: italic;
    font-weight: 500;
    margin: 0;
  }
  h1 { font-size: 36pt; line-height: 1.05; letter-spacing: -0.01em; }
  h2 { font-size: 20pt; margin: 18pt 0 6pt; border-bottom: 1px solid var(--rule); padding-bottom: 4pt; }
  h2::before { content: ""; display: inline-block; width: 14pt; height: 6pt; background: var(--vermillion); margin-right: 8pt; vertical-align: middle; }
  h3 { font-size: 14pt; margin: 12pt 0 4pt; }
  h4 { font-size: 11.5pt; margin: 8pt 0 2pt; color: #4a4640; }
  .masthead { display: flex; justify-content: space-between; align-items: end; border-bottom: 2px solid var(--ink); padding-bottom: 8pt; margin-bottom: 12pt; }
  .lab { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 8pt; letter-spacing: 0.3em; }
  .sub { font-family: ui-monospace, monospace; font-size: 9pt; letter-spacing: 0.18em; color: #6F664F; margin-top: 4pt; }
  ul { margin: 4pt 0 0 0; padding-left: 1.3em; }
  li { margin-bottom: 4pt; }
  .topic { margin-bottom: 10pt; }
  .summary { font-size: 13pt; line-height: 1.6; text-wrap: pretty; }
  table.transcript { width: 100%; border-collapse: collapse; margin-top: 8pt; font-size: 10pt; }
  table.transcript td { vertical-align: top; padding: 3pt 0; border-bottom: 1px solid rgba(0,0,0,0.06); }
  table.transcript td.t { font-family: ui-monospace, monospace; color: #6F664F; width: 70pt; }
  table.transcript td.s { width: 80pt; font-style: italic; }
  table.transcript td.x { padding-left: 6pt; }
  .colophon { margin-top: 18pt; padding-top: 8pt; border-top: 1px solid var(--rule); font-family: ui-monospace, monospace; font-size: 8pt; letter-spacing: 0.3em; color: #6F664F; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <div class="masthead">
    <div>
      <div class="lab">SUPER MINUTES · DOSSIER Nº 01</div>
      <h1>${esc(report.title || "會議報告")}</h1>
      <div class="sub">DRAFTED BY WHISPER · EDITED BY GEMMA · SIGNED BY YOU</div>
    </div>
    <div class="lab">${esc(new Date().toISOString().slice(0, 10))}</div>
  </div>

  ${report.summary ? `<h2>會議紀要</h2><p class="summary">${esc(report.summary)}</p>` : ""}
  ${conclusions ? `<h2>主要結論</h2><ul>${conclusions}</ul>` : ""}
  ${topics ? `<h2>議題與要點</h2>${topics}` : ""}
  ${openQuestions ? `<h2>待決事項</h2><ul>${openQuestions}</ul>` : ""}
  ${actions ? `<h2>待辦行動項</h2><ul>${actions}</ul>` : ""}

  <h2>逐字稿</h2>
  <table class="transcript">${rows}</table>

  <div class="colophon">
    <span>END OF DOSSIER</span>
    <span>POWERED BY HAZELNUTPARADISE</span>
  </div>
</body>
</html>`;
}

function slugify(s: string): string {
  return (
    (s || "report")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report"
  );
}
