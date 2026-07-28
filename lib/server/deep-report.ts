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
 *   5. overview — summary and conclusions.
 *   6. commitments — action items and open questions, in their own call so a
 *                 meeting handing out thirty tasks doesn't lose the tail of the
 *                 list to the summary's tokens.
 *   7. critic   — audit the sections against the notes; dropped notes are
 *                 routed back to their section in code and patched in.
 *   8. commitments critic — the same audit for the two lists, which have no
 *                 other safety net, plus a per-candidate check that each open
 *                 question really is unresolved.
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
 *   - A restrictive predicate applied across the whole note list collapses:
 *     asked which notes held an uncovered commitment, the model returned 98 of
 *     134 — ordinary explanation, which the patch step then wrote up as
 *     invented open questions. The same model answers a single yes/no about a
 *     single candidate correctly. So audits get a computed cap and are thrown
 *     away wholesale when they blow it, and per-item judgements are asked one
 *     item at a time.
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

const GROUP_USER = (digests: string, feedback?: string) =>
  `# Stretches, in meeting order

${digests}
${feedback ? `\n# What went wrong last time\n\n${feedback}\n` : ""}
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

/**
 * Overview and commitments are two calls, not one.
 *
 * They used to share a single closing call, which put the summary, the
 * conclusions, the open questions and every action item in competition for the
 * same fixed output budget — the exact failure the rest of this pipeline exists
 * to avoid. A meeting that hands out thirty tasks would have lost the tail of
 * the list with nothing to catch it. Splitting gives each its own budget.
 */
const OVERVIEW_SYSTEM = (languageName: string) =>
  `You are writing the opening of a meeting report from notes taken across the whole meeting. Someone else records the action items and open questions — you do not.

Emit ONE JSON object and nothing else:
{"summary": "...", "conclusions": ["..."]}

Write in ${languageName}.

- \`summary\`: 4-6 sentences. What the meeting was for, what was actually covered, and what came out of it.
- \`conclusions\`: the substantive points the meeting landed on. Each entry states the point AND the reason or evidence behind it in the same sentence.

If this was a briefing, Q&A or advisory session rather than a decision meeting, it may have settled little. That is normal — record the substantive guidance actually given rather than manufacturing decisions.`;

const OVERVIEW_USER = (notes: string[], headings: string[]) =>
  `# Sections already written for this report

${headings.map((h) => `- ${h}`).join("\n")}

# All notes from the meeting, in order

${notesBlock(notes)}

Emit the JSON object now. Begin with { right away.`;

const COMMITMENTS_SYSTEM = (languageName: string) =>
  `You are extracting the action items and open questions from a meeting's notes. You are NOT writing the summary or the discussion — only these two lists.

Emit ONE JSON object and nothing else:
{"open_questions": [{"question": "...", "evidence": "..."}], "actions": [{"task": "...", "owner": "...", "due": "..."}]}

Write in ${languageName}.

- \`actions\`: every commitment anyone made, including ones buried mid-discussion and ones agreed in passing. One entry per commitment — do not merge two people's tasks into one line, and do not stop early. \`owner\` is who committed, or null if nobody was named. \`due\` uses the speaker's own wording, or null when no deadline was given — never the string "N/A".
- \`open_questions\`: ONLY what the meeting explicitly parked, and each one must be evidenced.
  - \`evidence\`: copy the words from the notes that park it, character for character — "先擱著", "還沒決定", "等資料出來再說", "下次再談", "之後再看". This is checked against the notes; an entry whose evidence is not found there is thrown away.
  - If you cannot copy such words out of the notes, there is no open question to write. A question someone asked and someone answered is not one, however interesting the answer was. A limitation the speaker explained is not one either — that is a fact, and it belongs in the body of the report.
  - If a person is going to do it, it is an action item, not an open question.
  - Never add your own suggestions or "things worth considering". An empty array is the normal answer for most meetings.

Go through the notes in order and take every commitment as you reach it. A long meeting can produce a long list; length is set by what was actually promised, not by tidiness.

If this was a briefing, Q&A or advisory session, it may have produced almost no tasks. That is normal — do NOT manufacture action items to fill the field.`;

const COMMITMENTS_USER = (notes: string[]) =>
  `# All notes from the meeting, in order

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

/** The topic critic audits prose against notes; this one audits two lists that
 *  have no other safety net — a dropped commitment is the most expensive kind
 *  of omission a set of minutes can have. */
/**
 * Second gate on open questions, asked one candidate at a time.
 *
 * The evidence check catches invented quotes but not misapplied ones: the
 * model would paste a whole note as "evidence" and pass trivially, which is
 * how two settled facts ("亞馬遜沒有做到那麼精細") were filed as still open.
 * A keyword list for parking phrases would catch those, but the app writes
 * reports in ten languages and a Chinese lexicon only defends one of them.
 * Asking a single yes/no about a single candidate is language-neutral, and it
 * is the shape of question this model answers well — unlike a restrictive
 * predicate applied across a hundred notes at once.
 */
const OPEN_QUESTION_VERIFY_SYSTEM = `You are checking one claim about a meeting: that a particular matter was left unresolved.

Emit ONE JSON object and nothing else: {"answered": true} or {"answered": false}

Answer \`true\` if the notes show the meeting resolved it — someone gave an answer, stated the fact, made the decision, or explained how it works. An interesting explanation counts as an answer.

Answer \`false\` only if the notes show it genuinely hanging: deferred to later, waiting on data or on a person, or explicitly not decided.

When the notes contain an answer, say true even if the matter is complicated or the answer was partial.`;

const OPEN_QUESTION_VERIFY_USER = (question: string, notes: string[]) =>
  `# Notes from the meeting

${notesBlock(notes)}

# The matter claimed to be unresolved

${question}

Did the meeting resolve it? Emit the JSON now. Begin with { right away.`;

const COMMITMENTS_CRITIC_SYSTEM = (cap: number) =>
  `You are auditing the action items and open questions of a meeting report against the notes they were drawn from. You are looking for the rare note that records a promise or an explicitly unsettled matter which neither list covers.

Emit ONE JSON object and nothing else: {"missing": [12, 47]}

Report a note ONLY if it passes one of these two tests:
- Someone said they will do something: "我來…", "我負責…", "禮拜五前給你", "下週我去…". A named or implied person, and a thing they will do.
- The meeting explicitly parked something: "先擱著", "還沒決定", "等資料出來再說", "下次再談".

Everything else is NOT missing. In particular, a note is not missing merely because the lists do not mention it. Explanation, advice, opinion, background, worked examples, numbers, questions that got an answer, greetings and scheduling chatter all belong to the body of the report and are correctly absent from these two lists.

**Most notes are not missing.** In a normal meeting fewer than one note in ten is. Emit at most ${cap} numbers. If you find yourself listing more, you are reporting ordinary discussion — go back and keep only the notes that pass a test above.

If nothing is missing, emit {"missing": []}.`;

const COMMITMENTS_CRITIC_USER = (
  notes: string[],
  actions: { task: string; owner?: string | null; due?: string | null }[],
  openQuestions: string[]
) =>
  `# Notes, numbered

${notesBlock(notes)}

# Action items currently recorded

${actions.length ? actions.map((a) => `- ${a.task}${a.owner ? `（${a.owner}）` : ""}`).join("\n") : "(none)"}

# Open questions currently recorded

${openQuestions.length ? openQuestions.map((q) => `- ${q}`).join("\n") : "(none)"}

Emit {"missing": [...]} now. Begin with { right away.`;

const COMMITMENTS_SUPPLEMENT_USER = (
  mine: string[],
  actions: { task: string; owner?: string | null; due?: string | null }[],
  openQuestions: string[]
) =>
  `# Action items already recorded — do not repeat these

${actions.length ? actions.map((a) => `- ${a.task}`).join("\n") : "(none)"}

# Open questions already recorded — do not repeat these

${openQuestions.length ? openQuestions.map((q) => `- ${q}`).join("\n") : "(none)"}

# Notes whose commitments or unresolved matters are missing from those lists

${notesBlock(mine)}

Write ONLY the additional entries needed to cover these notes. Emit the JSON object now. Begin with { right away.`;

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

/**
 * How many stretches the biggest section holds — the same measure the group
 * prompt is handed as `lumpCap`, so code can check what the prompt asked for.
 * Counting sections instead would be the wrong test: a meeting that really did
 * stay on one subject for an hour should produce one section, and forcing a
 * split there would invent boundaries the recording does not have.
 */
export function maxStretchesPerSection(sections: Section[]): number {
  return sections.reduce((m, s) => Math.max(m, s.ranges.length), 0);
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

export interface ReportAction {
  task: string;
  owner?: string | null;
  due?: string | null;
}

/** Model output → action list. Drops entries with no task, and treats the
 *  string "N/A" as the absent deadline it actually means. */
export function normaliseActions(v: unknown): ReportAction[] {
  return Array.isArray(v)
    ? (v as Record<string, unknown>[])
        .filter(
          (a) => a && typeof a.task === "string" && (a.task as string).trim()
        )
        .map((a) => ({
          task: (a.task as string).trim(),
          owner:
            typeof a.owner === "string" && a.owner.trim() ? a.owner.trim() : null,
          due:
            typeof a.due === "string" && a.due.trim() && a.due !== "N/A"
              ? a.due.trim()
              : null,
        }))
    : [];
}

/** Comparison key for near-duplicate detection: the supplement pass is told
 *  not to repeat existing entries and mostly obeys, but re-words them just
 *  enough that exact matching would let the duplicate through. */
export function normaliseKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[。．.、,，:：;；!！?？（）()「」【】]/gu, "");
}

/**
 * Keep only the open questions whose evidence is really in the notes.
 *
 * Telling the model what does not count as an open question does not work: it
 * kept writing down facts the meeting had settled ("亞馬遜沒有做到那麼精細")
 * as things still open. Making it quote the words that parked the matter turns
 * the rule into something code can check — and an entry it cannot support gets
 * dropped. Failing closed is right here: an invented open question misleads,
 * while a missing one still has its content in the body of the report.
 */
export function verifiedOpenQuestions(raw: unknown, notes: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const haystack = normaliseKey(notes.join(""));
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { question, evidence } = item as Record<string, unknown>;
    if (typeof question !== "string" || !question.trim()) continue;
    if (typeof evidence !== "string" || !evidence.trim()) continue;
    const key = normaliseKey(evidence);
    // Too short to be evidence of anything — "再看" matches half a transcript.
    if (key.length < 3) continue;
    if (!haystack.includes(key)) continue;
    out.push(question.trim());
  }
  return out;
}

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

  // Fixed stages: cut, group, overview, commitments, critic, commitments
  // critic. Step total is provisional until the outline exists; it only grows,
  // so the progress readout never jumps backwards.
  const FIXED_STAGES = 6;
  let total = slices.length + FIXED_STAGES + 7;
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
  const digests = digest(notes, ranges);
  const attemptGrouping = async (feedback?: string) => {
    const res = await call({
      system: GROUP_SYSTEM(languageName, target, lumpCap),
      user: GROUP_USER(digests, feedback),
    });
    return {
      sections: groupsToSections(res?.sections, ranges),
      title: typeof res?.title === "string" ? res.title : "",
    };
  };

  // The cut step's budget is enforced in code; grouping's was only asked for,
  // and one run put all 15 stretches under a single heading. Retry once with
  // what went wrong, then keep whichever attempt lumps less — a retry that
  // comes back worse is discarded, so this can only improve or tie.
  let grouped = await attemptGrouping();
  const worst = maxStretchesPerSection(grouped.sections);
  if (!grouped.sections.length || worst > lumpCap) {
    console.log(
      `[deep-report] grouping put ${worst} of ${ranges.length} stretches under one heading (cap ${lumpCap}); retrying once`
    );
    const retry = await attemptGrouping(
      grouped.sections.length
        ? `You put ${worst} of the ${ranges.length} stretches under a single heading. That is more than the ${lumpCap} a group may hold, and it produces a section too long to read. Look again at where the subject genuinely changes and split that material.`
        : `Your previous attempt returned no usable groups. Every stretch number must appear in exactly one group, and every group needs a heading.`
    );
    if (
      retry.sections.length &&
      (!grouped.sections.length ||
        maxStretchesPerSection(retry.sections) < worst)
    ) {
      grouped = retry;
    }
  }

  const sections = grouped.sections;
  const groupTitle = grouped.title;
  if (!sections.length)
    throw new Error("歸納議題失敗：模型沒有給出任何分組");

  const headings = sections.map((s) => s.heading);
  total = slices.length + FIXED_STAGES + sections.length;

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

  // 5 — overview, then commitments. Two calls so a meeting that hands out
  // thirty tasks doesn't lose the tail of the list to the summary's tokens.
  report("overview", "整理會議紀要");
  const overview = await call({
    system: OVERVIEW_SYSTEM(languageName),
    user: OVERVIEW_USER(notes, headings),
  });

  report("commitments", "整理待辦與待決");
  const commitments = await call({
    system: COMMITMENTS_SYSTEM(languageName),
    user: COMMITMENTS_USER(notes),
  });
  const actions = normaliseActions(commitments?.actions);
  const openQuestions = verifiedOpenQuestions(
    commitments?.open_questions,
    notes
  );

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

  // 7 — commitments critic. Actions and open questions have no other safety
  // net: unlike topic points they are not split across calls, so a dropped
  // commitment would simply be gone.
  report("commitments-critic", "檢查漏掉的待辦");
  const commitmentCap = Math.max(3, Math.round(notes.length / 10));
  const cCritic = await call({
    system: COMMITMENTS_CRITIC_SYSTEM(commitmentCap),
    user: COMMITMENTS_CRITIC_USER(notes, actions, openQuestions),
  });
  let missedCommitments = [
    ...new Set(
      (Array.isArray(cCritic?.missing) ? cCritic.missing : [])
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= notes.length)
    ),
  ];
  // Over-reporting means the audit collapsed into "notes not quoted in these
  // lists", which for a 134-note meeting once returned 98 — ordinary
  // explanation that the supplement then turned into invented open questions.
  // A blown budget makes the whole audit untrustworthy, so drop it rather than
  // patch from it: the lists stay as the commitments pass wrote them.
  if (missedCommitments.length > commitmentCap) {
    console.log(
      `[deep-report] commitments critic reported ${missedCommitments.length} of ${notes.length} notes against a cap of ${commitmentCap}; discarding the audit`
    );
    missedCommitments = [];
  }

  if (missedCommitments.length) {
    const patch = await call({
      system: COMMITMENTS_SYSTEM(languageName),
      user: COMMITMENTS_SUPPLEMENT_USER(
        missedCommitments.map((i) => notes[i - 1]),
        actions,
        openQuestions
      ),
    });
    // Dedupe in code — the prompt asks the model not to repeat itself, but a
    // near-duplicate task is exactly the kind of thing it slips on.
    const seenTasks = new Set(actions.map((a) => normaliseKey(a.task)));
    for (const a of normaliseActions(patch?.actions)) {
      const k = normaliseKey(a.task);
      if (seenTasks.has(k)) continue;
      seenTasks.add(k);
      actions.push(a);
    }
    const seenQs = new Set(openQuestions.map(normaliseKey));
    for (const q of verifiedOpenQuestions(patch?.open_questions, notes)) {
      const k = normaliseKey(q);
      if (seenQs.has(k)) continue;
      seenQs.add(k);
      openQuestions.push(q);
    }
  }

  // An open question restating an action item is the one overlap the two
  // fields can produce, and the model does it: it wrote "團隊必須先討論清楚…"
  // into both. Code settles it — a thing with an owner is a task, not an open
  // question.
  const actionKeys = new Set(actions.map((a) => normaliseKey(a.task)));
  const candidates = openQuestions.filter(
    (q) => !actionKeys.has(normaliseKey(q))
  );

  // Second gate: ask about each candidate on its own. Candidates are few, so
  // this costs little, and a settled matter filed as still-open is the most
  // misleading thing this section can contain.
  const finalOpenQuestions: string[] = [];
  for (const q of candidates) {
    const verdict = await call({
      system: OPEN_QUESTION_VERIFY_SYSTEM,
      user: OPEN_QUESTION_VERIFY_USER(q, notes),
    });
    if (verdict?.answered === true) continue;
    finalOpenQuestions.push(q);
  }

  const c = overview ?? {};

  return {
    title:
      groupTitle.trim()
        ? groupTitle
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
    open_questions: finalOpenQuestions,
    actions,
  };
}
