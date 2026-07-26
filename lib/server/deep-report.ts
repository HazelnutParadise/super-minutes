/**
 * Multi-pass report pipeline for long meetings.
 *
 * The single-pass prompt in /api/report is fine up to roughly half an hour.
 * Past that it degrades, and measurement shows why: the model emits a roughly
 * fixed amount of output per call — about 12 points regardless of input — so a
 * longer meeting gets the same report spread thinner. Measured on a real
 * 68-minute diarized meeting scored against 30 specific facts:
 *
 *   single pass, gemma4:e4b   13/30   59s
 *   single pass, gemma4:12b   11/30  111s   (a bigger model does not fix it)
 *   this pipeline, gemma4:e4b 27/30  ~390s
 *
 * Feeding e4b only the last 20 minutes of that meeting recovered 8 of the 11
 * facts it had dropped from that stretch, which is what identified the output
 * budget rather than comprehension as the binding constraint.
 *
 * The pipeline therefore spends more calls rather than a bigger model:
 *
 *   1. notes    — sweep the transcript in slices, extracting dense notes. Each
 *                 slice gets a full output budget, so nothing is compressed away.
 *   2. outline  — group the notes into sections and assign every note to one.
 *   3. sections — write one section per call from its own notes.
 *   4. closing  — summary, conclusions, open questions and actions from all notes.
 *
 * Two cheaper variants measured worse and are recorded here so they are not
 * retried: dropping the notes pass and letting each section read the raw
 * transcript scored 16/30, and having the outline emit headings only (letting
 * each section pick its own notes) scored 20/30 at 416s.
 */

/** Calls the model and returns the parsed JSON object, or null if unparseable. */
export type JsonCall = (args: {
  system: string;
  user: string;
}) => Promise<Record<string, unknown> | null>;

export interface DeepReportProgress {
  /** Machine-readable stage: "notes" | "outline" | "section" | "closing". */
  stage: string;
  /** Human-readable label for the UI, already in Chinese. */
  label: string;
  /** 1-based step and total, for a progress readout. */
  step: number;
  total: number;
}

export interface DeepReportResult {
  title: string;
  summary: string;
  conclusions: string[];
  topics: { heading: string; points: string[] }[];
  open_questions: string[];
  actions: { task: string; owner?: string | null; due?: string | null }[];
}

/**
 * Transcripts shorter than this keep the single-pass prompt: it is roughly six
 * times faster and, below this length, just as complete. 8000 characters of
 * timestamped zh-TW transcript is about half an hour of meeting.
 */
export const DEEP_THRESHOLD_CHARS = 8000;

/** Target size of each note-taking slice, in characters. */
const SLICE_CHARS = 4500;
/** Segments repeated at each slice boundary so a point split across the join
 *  isn't halved. */
const SLICE_OVERLAP = 2;
/** A section with more notes than this is written in several calls and the
 *  points concatenated — one call would hit the same output ceiling the whole
 *  pipeline exists to work around. */
const MAX_NOTES_PER_SECTION_CALL = 24;

/** Split on segment boundaries so a slice never starts mid-utterance. */
export function sliceTranscript(
  transcript: string,
  targetChars = SLICE_CHARS,
  overlap = SLICE_OVERLAP
): string[] {
  const lines = transcript.split("\n").filter((l) => l.trim());
  const out: string[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const line of lines) {
    cur.push(line);
    size += line.length;
    if (size >= targetChars) {
      out.push(cur.join("\n"));
      cur = cur.slice(-overlap);
      size = cur.reduce((a, l) => a + l.length, 0);
    }
  }
  if (cur.length > overlap || out.length === 0) out.push(cur.join("\n"));
  return out;
}

const NOTES_SYSTEM = (languageName: string) =>
  `You are taking notes on one slice of a meeting recording. You are NOT writing the report — someone else will do that from your notes. Your only job is to make sure nothing substantive from this slice is lost.

Write every note in ${languageName}. Emit ONE JSON object: {"notes": ["...", "..."]} and nothing else.

Each note is one self-contained sentence or two. A note must stand on its own — the person writing the report will not see the transcript, only your notes, so "他建議這樣做" is useless; say who, what, and why.

Capture, at minimum:
- every number, percentage, price, date, deadline, duration and quantity, with what it refers to
- every claim, rule of thumb, framework or piece of advice, together with the reason given for it
- every concrete example, analogy or war story used to make a point — these are usually the most useful part and the first thing a careless summary drops
- every decision, commitment or deadline, and who owns it
- every objection, caveat or "this doesn't apply when…"
- every question asked and the answer actually given

Do not summarise across notes. Do not judge what is important — the report writer decides that. Err heavily toward more notes: 15-30 notes for a slice this size is normal. Short slices get fewer.

If the slice is small talk, scheduling chatter or a technical glitch with no content, return {"notes": []}.`;

const NOTES_USER = (slice: string, i: number, n: number) =>
  `# Transcript slice ${i + 1} of ${n}

${slice}

Emit {"notes": [...]} now. Begin with { right away.`;

const OUTLINE_SYSTEM = (languageName: string) =>
  `You are planning the structure of a meeting report from notes taken across the whole meeting. You are NOT writing the body yet — only deciding what sections it needs.

Emit ONE JSON object and nothing else:
{"title": "...", "topics": [{"heading": "...", "notes": [3, 4, 9]}, ...]}

- \`title\`: <= 20 characters, in ${languageName}.
- \`topics\`: one entry per distinct subject the notes cover. Headings in ${languageName}.
- \`notes\`: the 1-based numbers of every note that belongs under that heading.

Rules:
- Cover the whole meeting. Every note number must appear under exactly one heading. Do not drop notes because they seem minor — pure scheduling chatter can go under a "其他" heading, but it still gets assigned.
- Split by subject, not by time. If one subject was revisited later, its notes still group together.
- A meeting with 100+ notes normally needs 6-10 headings. Two or three headings for that many notes means you merged unrelated subjects; split them.
- Headings name the subject, not the activity: "廣告版位與競價" not "討論廣告".`;

const SECTION_SYSTEM = (languageName: string) =>
  `You are writing ONE section of a meeting report from the notes belonging to it.

Emit ONE JSON object and nothing else: {"points": ["...", "..."]}

Write in ${languageName}. Each point is a complete, self-contained statement a reader can act on without the recording.

- Carry the specifics: every number, price, percentage, date, threshold and duration in these notes must survive into a point.
- Carry the reasoning: when the notes give a reason, a condition, or a "this doesn't apply when…", keep it attached to the claim rather than dropping it.
- Keep the concrete examples and analogies. They are what makes advice usable, and they are the first thing a careless summary throws away.
- Merge notes that say the same thing. Do NOT merge notes that say different things just to shorten the list.
- Do not restate the heading. Do not write filler like "團隊討論了這個議題".

Length is set by the notes, not by tidiness: a section with 20 notes behind it needs far more than 4 points. Cover them all.`;

const SECTION_USER = (heading: string, mine: string[], others: string[]) =>
  `# Section to write

${heading}

# Other sections of this report (their material is NOT yours to write)

${others.length ? others.map((h) => `- ${h}`).join("\n") : "(none)"}

# Notes belonging to your section

${mine.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Emit {"points": [...]} now. Begin with { right away.`;

const CLOSING_SYSTEM = (languageName: string) =>
  `You are writing the opening and closing parts of a meeting report from notes taken across the whole meeting.

Emit ONE JSON object and nothing else:
{"summary": "...", "conclusions": ["..."], "open_questions": ["..."], "actions": [{"task": "...", "owner": "...", "due": "..."}]}

Write in ${languageName}.

- \`summary\`: 4-6 sentences. What the meeting was for, what was actually covered, and what came out of it.
- \`conclusions\`: the substantive points the meeting landed on. Each entry states the point AND the reason or evidence behind it in the same sentence.
- \`open_questions\`: ONLY what was explicitly left unresolved, deferred, or waiting on someone. If a question was asked and answered, it is not an open question. Never add your own suggestions or "things worth considering". Empty array if nothing was left hanging.
- \`actions\`: every commitment in the notes, with its owner. \`due\` is null when no deadline was given — never the string "N/A".

If this was a briefing, Q&A or advisory session rather than a decision meeting, it may have settled little and produced almost no tasks. That is normal — do not manufacture decisions or action items to fill the fields.`;

const CLOSING_USER = (notes: string[], headings: string[]) =>
  `# Sections already written for this report

${headings.map((h) => `- ${h}`).join("\n")}

# All notes from the meeting, in order

${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Emit the JSON object now. Begin with { right away.`;

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function generateDeepReport({
  transcript,
  languageName,
  call,
  onProgress,
}: {
  transcript: string;
  languageName: string;
  call: JsonCall;
  onProgress?: (p: DeepReportProgress) => void;
}): Promise<DeepReportResult> {
  const slices = sliceTranscript(transcript);

  // Total steps is only exact once the outline exists; before that we assume a
  // typical section count so the progress readout doesn't jump backwards.
  let total = slices.length + 2 + 7;
  let step = 0;
  const report = (stage: string, label: string) =>
    onProgress?.({ stage, label, step: ++step, total });

  // 1 — notes.
  const notes: string[] = [];
  for (let i = 0; i < slices.length; i++) {
    report("notes", `逐段擷取重點 ${i + 1}/${slices.length}`);
    const r = await call({
      system: NOTES_SYSTEM(languageName),
      user: NOTES_USER(slices[i], i, slices.length),
    });
    notes.push(...strings(r?.notes));
  }
  if (!notes.length) throw new Error("擷取重點失敗：模型沒有回傳任何內容");

  // 2 — outline.
  report("outline", "規劃報告架構");
  const outline = await call({
    system: OUTLINE_SYSTEM(languageName),
    user: `# Notes from the meeting, in order\n\n${notes
      .map((n, i) => `${i + 1}. ${n}`)
      .join("\n")}\n\nEmit the outline JSON now. Begin with { right away.`,
  });
  const planned = Array.isArray(outline?.topics)
    ? (outline.topics as { heading?: unknown; notes?: unknown }[])
    : [];
  const sections = planned
    .map((t) => ({
      heading: typeof t.heading === "string" ? t.heading.trim() : "",
      notes: (Array.isArray(t.notes) ? t.notes : [])
        .map((n) => notes[Number(n) - 1])
        .filter((n): n is string => typeof n === "string"),
    }))
    .filter((t) => t.heading && t.notes.length);
  if (!sections.length) throw new Error("規劃報告架構失敗：模型沒有給出任何段落");

  const headings = sections.map((s) => s.heading);
  total = slices.length + 2 + sections.length;

  // 3 — sections.
  const topics: { heading: string; points: string[] }[] = [];
  for (const s of sections) {
    report("section", `撰寫「${s.heading}」`);
    const others = headings.filter((h) => h !== s.heading);
    const points: string[] = [];
    for (const batch of chunkArray(s.notes, MAX_NOTES_PER_SECTION_CALL)) {
      const r = await call({
        system: SECTION_SYSTEM(languageName),
        user: SECTION_USER(s.heading, batch, others),
      });
      points.push(...strings(r?.points));
    }
    if (points.length) topics.push({ heading: s.heading, points });
  }

  // 4 — closing.
  report("closing", "整理紀要與待辦");
  const closing = await call({
    system: CLOSING_SYSTEM(languageName),
    user: CLOSING_USER(notes, headings),
  });

  const actions = Array.isArray(closing?.actions)
    ? (closing.actions as Record<string, unknown>[])
        .filter((a) => a && typeof a.task === "string" && a.task.trim())
        .map((a) => ({
          task: a.task as string,
          owner: typeof a.owner === "string" ? a.owner : null,
          due: typeof a.due === "string" && a.due !== "N/A" ? a.due : null,
        }))
    : [];

  return {
    title:
      typeof outline?.title === "string" && outline.title.trim()
        ? (outline.title as string)
        : "會議報告",
    summary: typeof closing?.summary === "string" ? closing.summary : "",
    conclusions: strings(closing?.conclusions),
    topics,
    open_questions: strings(closing?.open_questions),
    actions,
  };
}
