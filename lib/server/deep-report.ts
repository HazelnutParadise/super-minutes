/**
 * Multi-pass report pipeline for long meetings.
 *
 * The single-pass prompt in /api/report is fine up to roughly half an hour.
 * Past that it degrades, and measurement shows why: the model emits a roughly
 * fixed amount of output per call — about 12 points regardless of input — so a
 * longer meeting gets the same report spread thinner. Measured on a real
 * 68-minute diarized meeting scored against 30 specific facts (single pass,
 * gemma4:e4b: 13/30; single pass, gemma4:12b: 11/30 — a bigger model does not
 * fix it). Feeding e4b only the last 20 minutes recovered 8 of the 11 facts it
 * had dropped from that stretch, which identified the output budget rather
 * than comprehension as the binding constraint.
 *
 * The pipeline spends more calls instead of a bigger model:
 *
 *   1. notes    — sweep the transcript in slices, extracting dense notes.
 *   2. cut      — mark subject transitions over the notes. Numbers only.
 *   3. group    — group + name the stretches into sections. A meeting that
 *                 doubles back shows up as non-adjacent stretches in one group,
 *                 so a revisited subject still appears once.
 *   4. write    — one call per section; oversized sections get subtopics via
 *                 the same cut mechanism at section scale.
 *   5. closing  — summary, conclusions, open questions, actions.
 *   6. critic   — audit the report against the notes; dropped notes are routed
 *                 back to their section in code and patched in.
 *
 * Mechanism-over-model rules, each one paid for by a measured failure:
 *   - Every quantity the model must respect is computed from input size and
 *     injected into the prompt. Fixed numbers calibrate to one recording;
 *     relative wording ("err on the side of cutting") has no calibration at
 *     all and once produced 129 cuts for 134 notes.
 *   - The model only ever emits small outputs. The one time cutting also named
 *     its stretches it ignored a 9-22 budget and returned 133 segments; asking
 *     the outline to assign all 134 notes to headings needed a catch-all
 *     heading that swallowed 84 of them.
 *   - Code enforces what prompts request. A cut that exceeds its budget falls
 *     back to even mechanical segmentation and the grouping step does the
 *     semantic work from digests — a failed cut degrades instead of exploding.
 *   - Merging, routing and patch placement are pure code over data the model
 *     already returned. Unusable groups are dropped BEFORE their stretches are
 *     claimed; stretches the model forgot join their nearest neighbour;
 *     nothing is silently discarded.
 *
 * Rejected with evidence, do not retry: skipping the notes pass (16/30 vs
 * 27/30 — the dense sweep is what stops content vanishing); embedding
 * clustering for grouping (embeddinggemma:300m over same-domain zh-TW
 * stretches has a flat similarity landscape: at 0.75 nothing merges, at 0.70
 * everything collapses into one blob); heading-reuse or index-based "resumes"
 * markers in a single outline call (either never used, used wrongly, or
 * over-used until 134 notes became 4 sections).
 */

/** Calls the model and returns the parsed JSON object, or null if unparseable. */
export type JsonCall = (args: {
  system: string;
  user: string;
}) => Promise<Record<string, unknown> | null>;

export interface DeepReportProgress {
  stage: string;
  /** Human-readable label for the UI, already in Chinese. */
  label: string;
  step: number;
  total: number;
}

export interface DeepReportResult {
  title: string;
  summary: string;
  conclusions: string[];
  topics: {
    heading: string;
    points: string[];
    subtopics: { heading: string; points: string[] }[];
  }[];
  open_questions: string[];
  actions: { task: string; owner?: string | null; due?: string | null }[];
}

/**
 * Transcripts shorter than this keep the single-pass prompt: it is several
 * times faster and, below this length, just as complete. 8000 characters of
 * timestamped zh-TW transcript is about half an hour of meeting.
 */
export const DEEP_THRESHOLD_CHARS = 8000;

/** Target size of each note-taking slice, in characters. */
const SLICE_CHARS = 4500;
/** Segments repeated at each slice boundary so a point split across the join
 *  isn't halved. */
const SLICE_OVERLAP = 2;
/** One writing call covers this many notes well. It doubles as the subtopic
 *  threshold: a section that doesn't fit one call gets subtopics instead of
 *  one long flat list — "too big for a call" and "too big to read flat"
 *  coincide. */
const MAX_NOTES_PER_CALL = 24;
const SUBTOPIC_THRESHOLD = MAX_NOTES_PER_CALL;

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

/** Plausible subject-transition count for n notes: ~1/15 floor, ~1/6 ceiling. */
export function cutBudget(n: number): { lo: number; hi: number } {
  const lo = Math.max(3, Math.round(n / 15));
  const hi = Math.min(60, Math.max(lo + 3, Math.round(n / 6)));
  return { lo, hi };
}

const notesBlock = (notes: string[]) =>
  notes.map((n, i) => `${i + 1}. ${n}`).join("\n");

// ------------------------------------------------------------------- prompts

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

const CUT_SYSTEM = (lo: number, hi: number, typical: number) =>
  `You are marking where a meeting moves from one subject to the next. The notes below are in the order the meeting happened. You are NOT naming the subjects and NOT writing anything — you only mark the transitions.

Emit ONE JSON object and nothing else: {"boundaries": [1, 12, 27, ...]}

Each number is the note where a new stretch begins. Ascending. The first is always 1.

Rules:
- **Emit between ${lo} and ${hi} numbers, and never more than ${hi}.** This range is computed from the size of this recording. Not one per note — most consecutive notes continue the same subject. If you are about to exceed ${hi}, you are cutting at turns of speech instead of changes of subject; keep only the real transitions.
- A stretch is typically around ${typical} notes long. A stretch of 1 note is almost always a wrong cut.
- A follow-up question, a clarification or a worked example belongs to the subject it is about.
- Enumeration inside one answer ("第一個…第二個…第三個" while explaining a single thing) is one stretch, not several.
- If the meeting returns to an earlier subject, that is a transition too — a later step will group same-subject stretches.
- Read to the very end. The closing stretch is a transition too, and it is what a hurried pass drops.`;

const CUT_USER = (notes: string[]) =>
  `# Notes, in meeting order

${notesBlock(notes)}

There are ${notes.length} notes. Emit {"boundaries": [...]} now. Begin with { right away.`;

const GROUP_SYSTEM = (languageName: string, target: number, lumpCap: number) =>
  `You are deciding the sections of a meeting report. The meeting has been cut into stretches, in order, and you see a sample of each. Group the stretches by subject and name each group.

Emit ONE JSON object and nothing else:
{"title": "...", "sections": [{"heading": "...", "stretches": [1, 2]}, {"heading": "...", "stretches": [3, 7]}]}

- \`title\`: <= 20 characters, in ${languageName}. Name the meeting, not the genre.
- \`heading\`: names the subject of the group, in ${languageName}. Name the subject, not the activity: "第三季預算調整", not "討論預算".
- \`stretches\`: the stretch numbers in that group.

Rules:
- Every stretch number appears in exactly one group. None may be left out.
- The cutting step cuts often, so neighbouring stretches frequently continue one subject. Merging neighbours is expected.
- **A meeting that returned to an earlier subject shows up as non-adjacent stretches in one group** — for example [2, 8]. Put them together so the subject appears once in the report with all its material. This is the main thing to look for after merging neighbours.
- Do not lump distinct subjects to shorten the list. If a group's heading would have to be vague to cover its stretches ("其他事項", "綜合討論"), it is two or three groups — split it and name each precisely.
- Aim for about ${target} groups. A group holding more than ${lumpCap} stretches is almost certainly lumping.`;

const GROUP_USER = (digests: string) =>
  `# Stretches, in meeting order

${digests}

Emit the JSON now. Begin with { right away.`;

const TOPIC_SYSTEM = (languageName: string) =>
  `You are writing ONE section of a meeting report from the notes belonging to it.

Emit ONE JSON object and nothing else: {"points": ["...", "..."]}

Write in ${languageName}. Each point is a complete, self-contained statement a reader can act on without the recording.

- Carry the specifics: every number, price, percentage, date, threshold and duration in these notes must survive into a point.
- Carry the reasoning: when the notes give a reason, a condition, or a "this doesn't apply when…", keep it attached to the claim rather than dropping it.
- Keep the concrete examples and analogies. They are what makes advice usable, and they are the first thing a careless summary throws away.
- Merge notes that say the same thing. Do NOT merge notes that say different things just to shorten the list.
- Do not restate the heading. Do not write filler like "團隊討論了這個議題".

Length is set by the notes, not by tidiness: a section with 20 notes behind it needs far more than 4 points. Cover them all.`;

const TOPIC_USER = (heading: string, mine: string[], others: string[]) =>
  `# Section to write

${heading}

# Other sections of this report (their material is NOT yours to write)

${others.length ? others.map((h) => `- ${h}`).join("\n") : "(none)"}

# Notes belonging to your section

${notesBlock(mine)}

Emit {"points": [...]} now. Begin with { right away.`;

const SUBNAME_SYSTEM = (languageName: string) =>
  `You are naming the parts of ONE section of a meeting report. The section's notes have been cut into stretches, in order. Give each stretch a short sub-heading.

Emit ONE JSON object and nothing else: {"headings": ["...", "..."]} — one per stretch, in order, in ${languageName}.

A sub-heading names the facet of the section that stretch covers ("成本試算", "供應商比較"), not the activity. Keep each under 14 characters.`;

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

${notesBlock(notes)}

Emit the JSON object now. Begin with { right away.`;

const CRITIC_SYSTEM = `You are auditing a finished meeting report against the notes it was written from. Your only job is to find notes whose substantive content made it into NO point of the report.

Emit ONE JSON object and nothing else: {"missing": [12, 47]}

A note is missing when a number, a decision, a commitment, a reason, or a concrete example it carries appears nowhere in the points. A note is NOT missing when its content appears in different words, merged into a broader point, or split across points.

Do not report notes that are pure greetings, scheduling chatter, or technical-glitch talk — leaving those out was correct.

If nothing substantive is missing, emit {"missing": []}.`;

const CRITIC_USER = (notes: string[], points: string[]) =>
  `# Notes, numbered

${notesBlock(notes)}

# Every point in the report

${points.map((p) => `- ${p}`).join("\n")}

Emit {"missing": [...]} now. Begin with { right away.`;

const SUPPLEMENT_USER = (heading: string, mine: string[], existing: string[]) =>
  `# Section being extended

${heading}

# Points this section already has

${existing.map((p) => `- ${p}`).join("\n")}

# Notes whose content is missing from the report

${notesBlock(mine)}

Write ONLY the additional points needed to cover these notes. Do not repeat existing points. Emit {"points": [...]} now. Begin with { right away.`;

// ------------------------------------------------------------- pure plumbing

export type Range = [number, number];

export interface Section {
  heading: string;
  ranges: Range[];
  indices: number[];
}

/** Boundary numbers → contiguous ranges. Sorted, deduped, clamped, first
 *  forced to 1. Empty input → the whole recording as one range. */
export function boundariesToRanges(raw: unknown, noteCount: number): Range[] {
  const bs = [
    ...new Set(
      (Array.isArray(raw) ? raw : [])
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= noteCount)
    ),
  ].sort((a, b) => a - b);
  if (!bs.length) return [[1, noteCount]];
  if (bs[0] !== 1) bs[0] = 1;
  const uniq = [...new Set(bs)].sort((a, b) => a - b);
  return uniq.map((s, i) => [
    s,
    i + 1 < uniq.length ? uniq[i + 1] - 1 : noteCount,
  ]);
}

/** Mechanical fallback: even segmentation into ~targetCount stretches. Used
 *  when the model ignores its cut budget, so the grouping step still receives
 *  a bounded digest and can do the semantic work. */
export function evenRanges(noteCount: number, targetCount: number): Range[] {
  const k = Math.max(1, Math.min(targetCount, noteCount));
  const size = Math.ceil(noteCount / k);
  const out: Range[] = [];
  for (let from = 1; from <= noteCount; from += size) {
    out.push([from, Math.min(from + size - 1, noteCount)]);
  }
  return out;
}

/**
 * Groups of stretch numbers → sections. Code repairs every model mistake that
 * would lose material: unusable groups are dropped BEFORE their stretches are
 * claimed, invalid members are dropped, duplicates keep their first group,
 * stretches never mentioned join the group of their nearest neighbour.
 */
export function groupsToSections(rawSections: unknown, ranges: Range[]): Section[] {
  const seen = new Set<number>();
  const sections = (Array.isArray(rawSections) ? rawSections : [])
    .map((s: { heading?: unknown; stretches?: unknown }) => ({
      heading: typeof s?.heading === "string" ? s.heading.trim() : "",
      stretches: (Array.isArray(s?.stretches) ? s.stretches : [])
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= ranges.length),
    }))
    .filter((s) => s.heading && s.stretches.length)
    .map((s) => ({
      heading: s.heading,
      stretches: s.stretches.filter((n) =>
        seen.has(n) ? false : (seen.add(n), true)
      ),
    }))
    .filter((s) => s.stretches.length);
  if (!sections.length) return [];

  for (let i = 1; i <= ranges.length; i++) {
    if (seen.has(i)) continue;
    let best = sections[0];
    let bestDist = Infinity;
    for (const s of sections) {
      const d = Math.min(...s.stretches.map((n) => Math.abs(n - i)));
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    best.stretches.push(i);
  }

  return sections
    .map((s) => {
      const rs = s.stretches
        .slice()
        .sort((a, b) => a - b)
        .map((n) => ranges[n - 1]);
      return {
        heading: s.heading,
        ranges: rs,
        indices: rs.flatMap(([f, t]) =>
          Array.from({ length: t - f + 1 }, (_, k) => f + k)
        ),
      };
    })
    .sort((a, b) => a.ranges[0][0] - b.ranges[0][0]);
}

/** Which section owns note i. Pure lookup, -1 when none. */
export function routeNote(i: number, sections: Section[]): number {
  for (let s = 0; s < sections.length; s++) {
    if (sections[s].indices.includes(i)) return s;
  }
  return -1;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Compact each stretch to a few verbatim notes — the model's own wording
 *  beats a generated gist and costs no extra call. */
function digest(notes: string[], ranges: Range[]): string {
  return ranges
    .map(([from, to], i) => {
      const own = notes.slice(from - 1, to);
      const sample =
        own.length <= 3
          ? own
          : [own[0], own[Math.floor(own.length / 2)], own[own.length - 1]];
      return `## 段落 ${i + 1}（第 ${from}-${to} 則，共 ${own.length} 則）\n${sample
        .map((s) => `- ${s}`)
        .join("\n")}`;
    })
    .join("\n\n");
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];

// ------------------------------------------------------------------ pipeline

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

  // Step total is provisional until the outline exists; it only grows, so the
  // progress readout never jumps backwards.
  let total = slices.length + 4 + 7;
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

  // 2 — cut. Numbers only; code enforces the budget the prompt requests.
  report("cut", "標記主題分界");
  const { lo, hi } = cutBudget(notes.length);
  const typical = Math.max(2, Math.round(notes.length / ((lo + hi) / 2)));
  const cutRes = await call({
    system: CUT_SYSTEM(lo, hi, typical),
    user: CUT_USER(notes),
  });
  let ranges = boundariesToRanges(cutRes?.boundaries, notes.length);
  if (ranges.length > hi) {
    console.log(
      `[deep-report] cut returned ${ranges.length} stretches against a budget of ${hi}; using even segmentation`
    );
    ranges = evenRanges(notes.length, Math.round((lo + hi) / 2));
  }

  // 3 — group + name.
  report("group", "歸納議題分組");
  const target = Math.max(3, Math.round(ranges.length * 0.5));
  const lumpCap = Math.max(3, Math.round(ranges.length / 3));
  const groupRes = await call({
    system: GROUP_SYSTEM(languageName, target, lumpCap),
    user: GROUP_USER(digest(notes, ranges)),
  });
  const sections = groupsToSections(groupRes?.sections, ranges);
  if (!sections.length)
    throw new Error("歸納議題失敗：模型沒有給出任何分組");

  const headings = sections.map((s) => s.heading);
  total = slices.length + 4 + sections.length;

  const writePoints = async (heading: string, mine: string[], others: string[]) => {
    const points: string[] = [];
    for (const batch of chunkArray(mine, MAX_NOTES_PER_CALL)) {
      const r = await call({
        system: TOPIC_SYSTEM(languageName),
        user: TOPIC_USER(heading, batch, others),
      });
      points.push(...strings(r?.points));
    }
    return points;
  };

  // 4 — write each section; oversized ones get subtopics.
  type BuiltTopic = {
    heading: string;
    points: string[];
    subtopics: { heading: string; points: string[]; _from: number; _to: number }[];
  };
  const topics: BuiltTopic[] = [];
  for (const s of sections) {
    report("section", `撰寫「${s.heading}」`);
    const mine = s.indices.map((i) => notes[i - 1]).filter(Boolean);
    const others = headings.filter((h) => h !== s.heading);

    if (mine.length <= SUBTOPIC_THRESHOLD) {
      topics.push({
        heading: s.heading,
        points: await writePoints(s.heading, mine, others),
        subtopics: [],
      });
      continue;
    }

    const subBudget = cutBudget(mine.length);
    const subTypical = Math.max(
      2,
      Math.round(mine.length / ((subBudget.lo + subBudget.hi) / 2))
    );
    const subCut = await call({
      system: CUT_SYSTEM(subBudget.lo, Math.min(8, subBudget.hi), subTypical),
      user: CUT_USER(mine),
    });
    let subRanges = boundariesToRanges(subCut?.boundaries, mine.length);
    if (subRanges.length > 8) subRanges = evenRanges(mine.length, 5);
    const nameRes = await call({
      system: SUBNAME_SYSTEM(languageName),
      user: `# Section\n\n${s.heading}\n\n${digest(mine, subRanges)}\n\nEmit {"headings": [...]} now. Begin with { right away.`,
    });
    const subNames = Array.isArray(nameRes?.headings) ? nameRes.headings : [];
    const subtopics: BuiltTopic["subtopics"] = [];
    for (let k = 0; k < subRanges.length; k++) {
      const [f, t] = subRanges[k];
      const subHeading =
        typeof subNames[k] === "string" && (subNames[k] as string).trim()
          ? (subNames[k] as string).trim()
          : `第 ${k + 1} 部分`;
      subtopics.push({
        heading: subHeading,
        points: await writePoints(
          `${s.heading} — ${subHeading}`,
          mine.slice(f - 1, t),
          others
        ),
        _from: f,
        _to: t,
      });
    }
    topics.push({ heading: s.heading, points: [], subtopics });
  }

  // 5 — closing.
  report("closing", "整理紀要與待辦");
  const closing = await call({
    system: CLOSING_SYSTEM(languageName),
    user: CLOSING_USER(notes, headings),
  });

  // 6 — critic. Model finds dropped notes; code routes and patches them.
  report("critic", "檢查遺漏並補寫");
  const allPoints = topics.flatMap((t) =>
    t.subtopics.length ? t.subtopics.flatMap((st) => st.points) : t.points
  );
  const criticRes = await call({
    system: CRITIC_SYSTEM,
    user: CRITIC_USER(notes, allPoints),
  });
  const missing = [
    ...new Set(
      (Array.isArray(criticRes?.missing) ? criticRes.missing : [])
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= notes.length)
    ),
  ];

  if (missing.length) {
    const bySection = new Map<number, number[]>();
    for (const i of missing) {
      const sIdx = routeNote(i, sections);
      if (sIdx === -1) continue;
      if (!bySection.has(sIdx)) bySection.set(sIdx, []);
      bySection.get(sIdx)!.push(i);
    }
    for (const [sIdx, idxs] of bySection) {
      const t = topics[sIdx];
      const existing = t.subtopics.length
        ? t.subtopics.flatMap((st) => st.points)
        : t.points;
      const r = await call({
        system: TOPIC_SYSTEM(languageName),
        user: SUPPLEMENT_USER(
          t.heading,
          idxs.map((i) => notes[i - 1]),
          existing
        ),
      });
      const extra = strings(r?.points);
      if (!extra.length) continue;
      if (t.subtopics.length) {
        const local = sections[sIdx].indices.indexOf(idxs[0]) + 1;
        const st =
          t.subtopics.find((x) => local >= x._from && local <= x._to) ??
          t.subtopics[t.subtopics.length - 1];
        st.points.push(...extra);
      } else {
        t.points.push(...extra);
      }
    }
  }

  const c = closing ?? {};
  const actions = Array.isArray(c.actions)
    ? (c.actions as Record<string, unknown>[])
        .filter((a) => a && typeof a.task === "string" && (a.task as string).trim())
        .map((a) => ({
          task: a.task as string,
          owner: typeof a.owner === "string" ? a.owner : null,
          due: typeof a.due === "string" && a.due !== "N/A" ? a.due : null,
        }))
    : [];

  return {
    title:
      typeof groupRes?.title === "string" && (groupRes.title as string).trim()
        ? (groupRes.title as string)
        : "會議報告",
    summary: typeof c.summary === "string" ? c.summary : "",
    conclusions: strings(c.conclusions),
    topics: topics.map(({ heading, points, subtopics }) => ({
      heading,
      points,
      subtopics: subtopics.map(({ heading: h, points: p }) => ({
        heading: h,
        points: p,
      })),
    })),
    open_questions: strings(c.open_questions),
    actions,
  };
}
