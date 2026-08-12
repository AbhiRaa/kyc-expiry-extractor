/**
 * The response shape for `POST /api/eval-gate` — a live run of the admission gate against
 * the real 35-document eval corpus (docs/DECISIONS.md's live gate-check entry). Not part
 * of `ExtractionResponse`/`contract.ts`: this is a different contract entirely, a corpus
 * summary rather than a single document's verdict.
 *
 * Mirrors the exact math `eval/run.ts` already reports for the admission gate section of
 * `eval/results.md`, computed live instead of read from a pinned commit.
 */
export interface GateCorpusCheckResult {
  /** ISO timestamp of when this check actually ran. */
  computedAt: string;
  durationMs: number;
  documentsChecked: number;
  /** Out-of-domain documents on purpose (expected_class NOT_A_DOCUMENT/OTHER_DOCUMENT). */
  adversarialTotal: number;
  /** Adversarial documents that never reached the paid VLM tier (REJECT or ADMIT_LIMITED). */
  containedCount: number;
  /** Adversarial documents the gate confidently rejected outright. */
  rejectedCount: number;
  nonAdversarialTotal: number;
  /** Legitimate documents wrongly rejected — must be zero. */
  falseRejectCount: number;
  spendAvoidedUsd: number;
}
