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

- The cut step in `lib/server/deep-report.ts` overshoots its upper budget on
  every run measured (26-27 boundaries against a cap of 22, 5 of 5 runs on the
  68-minute recording), so its semantic segmentation is always discarded and
  replaced by mechanical even segmentation — about 40 seconds of model time
  currently buying nothing. The cap is `Math.round(n / 6)`, a guess that was
  never measured; the model consistently wants roughly one stretch per 5 notes.
  Either widen the cap, or merge the smallest stretches down to the cap instead
  of discarding the model's boundaries wholesale. Neither has been measured
  against report quality, which is 25-28/30 today with the fallback firing every
  time — so this may be no better in practice, and needs measuring rather than
  assuming.

- `RETRY_USER_TEMPLATE` in `app/api/report/route.ts` resends the entire
  transcript when the single-pass path retries after unparseable JSON, doubling
  that request's cost. Consider retrying with the parse error + a trimmed
  reminder instead. (Single-pass path only; the multi-pass pipeline has no such
  retry.)
