# Super Minutes — agent notes

Read this before doing project work. `README.md` covers architecture; this file
holds working agreements and open follow-ups.

## Working notes

- Report generation has two paths: transcripts under `DEEP_THRESHOLD_CHARS`
  (8000 chars ≈ 30 min) run the single-pass prompt in
  `app/api/report/route.ts`; longer ones run the multi-pass pipeline in
  `lib/server/deep-report.ts`. The pipeline's header comment records the
  measured failures behind each design rule — read it before changing prompts
  or thresholds, several "obvious improvements" are already measured as worse.
- Pure plumbing in `deep-report.ts` is tested:
  `node --experimental-strip-types scripts/deep-report.test.mjs`.
- A 68-minute meeting takes ~18 minutes end to end on gemma4:e4b; the user
  accepted ~13 minutes on 2026-07-27 and the commitments split added to that.
- Recurring lesson with this model class: it is reliable on a small, focused
  judgement and unreliable on a restrictive predicate applied across a long
  list. Prefer many small calls with computed budgets over one clever prompt,
  and have code discard a step's output when it blows its budget.
- `open_questions` is the field that invents content. It has three gates:
  quoted evidence checked against the notes, a per-candidate "was this
  answered?" call, and dedup against action items. Empty is a normal result.

## Follow-ups

- Rerun one full end-to-end multi-pass report (68-minute recording) to close
  out the top-level-cut removal. The change is behavior-equivalent by
  construction and a live run exercised the new flow through 14 of 15 steps,
  but both verification runs died mid-pipeline when the Ollama host went down
  (ping 100% loss) — in code the change does not touch. Needs the host back.
- A 17-minute pipeline dies wholesale on one transient upstream failure: two
  runs were lost to a single dropped socket ("terminated", "fetch failed") in
  `callOllama`. One retry on network-level errors (not on parse failures)
  would have saved both. Worth adding when touching `app/api/report/route.ts`.

- `RETRY_USER_TEMPLATE` in `app/api/report/route.ts` resends the entire
  transcript when the single-pass path retries after unparseable JSON, doubling
  that request's cost. Consider retrying with the parse error + a trimmed
  reminder instead. (Single-pass path only; the multi-pass pipeline has no such
  retry.)
