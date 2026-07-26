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
- A 68-minute meeting takes ~13 minutes end to end on gemma4:e4b; the user has
  accepted this (2026-07-27).

## Follow-ups

- `RETRY_USER_TEMPLATE` in `app/api/report/route.ts` resends the entire
  transcript when the single-pass path retries after unparseable JSON, doubling
  that request's cost. Consider retrying with the parse error + a trimmed
  reminder instead. (Single-pass path only; the multi-pass pipeline has no such
  retry.)
