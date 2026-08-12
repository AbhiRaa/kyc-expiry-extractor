/**
 * The pinned "today" the entire eval corpus is built against (`eval/generate-corpus.ts`).
 * Every time-relative document in the corpus (recency windows, the expired passport, the
 * stale utility bill) is expressed as an offset from this, so verdicts stay stable forever
 * regardless of the wall clock.
 *
 * Lives here, not in `eval/generate-corpus.ts`, specifically so `src/app/api/eval-gate`
 * (which cannot import from `eval/` at runtime — that tree isn't part of the deployed
 * server bundle) can evaluate the live corpus check against the same anchor the corpus was
 * generated against, rather than the real clock. `eval/generate-corpus.ts` re-exports this
 * so no existing import site there needs to change.
 */
export const ANCHOR_TODAY = '2026-08-09';
