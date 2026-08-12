'use client';

import { useId, useState } from 'react';
import type { AdmissionDecision, ExtractionResponse } from '@/types/contract';
import {
  DEFAULT_LOADED_COST_PER_HOUR_USD,
  DEFAULT_REVIEWER_ASSUMPTION,
  minutesToDollars,
  reviewerMinutesAvoided,
} from '@/lib/reviewer-economics';
import styles from './RoiPanel.module.css';

type Tone = 'ok' | 'warn' | 'neutral';

const ADMISSION_TEXT: Record<AdmissionDecision, { tone: Tone; label: string; detail: string }> = {
  ADMIT_FULL: {
    tone: 'ok',
    label: 'Admitted in full',
    detail: 'A positive domain signal was found — nothing was held back from this document.',
  },
  ADMIT_LIMITED: {
    tone: 'warn',
    label: 'Admitted for free tiers only',
    detail: 'No positive domain signal was found, so the paid VLM tier was hard-blocked regardless of budget.',
  },
  // Mirrors ResultPanel's own choice for the REJECTED decision (tone_neutral, not bad):
  // the gate declining to treat this as a candidate document is a correct outcome, not a
  // failure on the document's part.
  REJECT: {
    tone: 'neutral',
    label: 'Rejected at the gate',
    detail: 'Confident negative evidence — no extraction tier ran at all.',
  },
};

/** Static reference numbers from the last real `npm run eval` run against the 35-document
 *  synthetic corpus, pinned at commit b7d8b62 (eval/results.md, docs/DECISIONS.md §8). Not
 *  computed live: this app holds only the single most recent ExtractionResponse in state,
 *  never a corpus to aggregate over (see docs/DECISIONS.md's ROI panel entry). Regenerate
 *  via `npm run eval` and update these by hand if the corpus or pipeline changes again. */
const CORPUS_REFERENCE = {
  adversarialTotal: 7,
  containedCount: 7,
  rejectedCount: 4,
  nonAdversarialTotal: 28,
  falseRejectCount: 0,
  spendAvoidedUsd: 0.88,
  sourceCommit: 'b7d8b62',
};

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtUsdRange(low: number, high: number): string {
  return `${fmtUsd(low)}–${fmtUsd(high)}`;
}

function fmtMinutesRange(low: number, high: number): string {
  return `${Math.round(low)}–${Math.round(high)} min`;
}

/** Parses a controlled numeric input, ignoring anything that would break downstream
 *  arithmetic (empty string mid-edit, a stray minus sign) rather than propagating NaN
 *  into every figure on the panel. */
function parsePositiveNumber(raw: string, fallback: number): number {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface RoiPanelProps {
  result: ExtractionResponse;
}

/**
 * Surfaces the admission gate's cost story in the live UI (item 1 of the three deferred
 * after the gate + CRM emission shipped). Two sections, both honestly labeled rather than
 * conflated into one number:
 *
 *   1. **This document** — live, from `result.admission`. The only thing this app can
 *      actually compute per-request, since it holds no history to aggregate over.
 *   2. **Proven on the evaluation corpus** — the real containment/rejection/false-reject
 *      numbers from the last `npm run eval` run, which a single client request cannot
 *      reproduce on its own (no ground-truth "is this adversarial" label exists for a
 *      real upload, and there is no corpus on the client).
 *
 * Both run through the same editable throughput/loaded-cost assumptions, so a viewer sees
 * the dollar impact under their own numbers, not just the illustrative defaults.
 */
export default function RoiPanel({ result }: RoiPanelProps) {
  const idPrefix = useId();
  const [throughputLow, setThroughputLow] = useState(DEFAULT_REVIEWER_ASSUMPTION.throughputPerDayLow);
  const [throughputHigh, setThroughputHigh] = useState(DEFAULT_REVIEWER_ASSUMPTION.throughputPerDayHigh);
  const [loadedCostPerHour, setLoadedCostPerHour] = useState(DEFAULT_LOADED_COST_PER_HOUR_USD);

  // Absent only on the pre-gate T0 rejection path (corrupt/unsupported file) — that path
  // never reaches the gate at all, so there is nothing honest to show here.
  if (!result.admission) return null;

  const assumption = {
    throughputPerDayLow: throughputLow,
    throughputPerDayHigh: throughputHigh,
    workdayMinutes: DEFAULT_REVIEWER_ASSUMPTION.workdayMinutes,
  };

  const admission = ADMISSION_TEXT[result.admission.decision];
  const spendAvoided = result.admission.spend_avoided_usd;

  const thisDocMinutes =
    result.decision === 'REJECTED' ? reviewerMinutesAvoided(1, assumption) : null;
  const thisDocDollars = thisDocMinutes ? minutesToDollars(thisDocMinutes, loadedCostPerHour) : null;

  const corpusMinutes = reviewerMinutesAvoided(CORPUS_REFERENCE.rejectedCount, assumption);
  const corpusDollars = minutesToDollars(corpusMinutes, loadedCostPerHour);
  const corpusContainmentPct = (
    (CORPUS_REFERENCE.containedCount / CORPUS_REFERENCE.adversarialTotal) *
    100
  ).toFixed(1);
  const corpusRejectionPct = (
    (CORPUS_REFERENCE.rejectedCount / CORPUS_REFERENCE.adversarialTotal) *
    100
  ).toFixed(1);

  return (
    <div className={`${styles.card} ${styles[`tone_${admission.tone}`]}`}>
      <h3 className={styles.eyebrow}>Cost &amp; reviewer-time impact</h3>

      <div className={styles.thisDoc}>
        <span className={styles.admissionPill}>{admission.label}</span>
        <p className={styles.admissionDetail}>{admission.detail}</p>
        <dl className={styles.facts}>
          <div>
            <dt>Spend avoided on this document</dt>
            <dd className={styles.mono}>
              {spendAvoided === null
                ? // Only ADMIT_FULL leaves this null — nothing was ever blocked.
                  '$0.00 — nothing to avoid, fully admitted'
                : spendAvoided === 0
                  ? // REJECT/ADMIT_LIMITED, but escalation was never actually going to
                    // fire — not the same claim as "fully admitted" above.
                    '$0.00 — blocked, though it would not have cost anything anyway'
                  : fmtUsd(spendAvoided)}
            </dd>
          </div>
          {thisDocMinutes && thisDocDollars ? (
            <div>
              <dt>Reviewer touches avoided</dt>
              <dd className={styles.mono}>
                1 · {fmtMinutesRange(thisDocMinutes.low, thisDocMinutes.high)} ·{' '}
                {fmtUsdRange(thisDocDollars.low, thisDocDollars.high)}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className={styles.assumptions}>
        <h4 className={styles.assumptionsTitle}>
          Editable assumptions — not measured facts, drives every figure below
        </h4>
        <div className={styles.inputRow}>
          <label htmlFor={`${idPrefix}-tlow`}>
            Reviewer throughput, low
            <input
              id={`${idPrefix}-tlow`}
              className={styles.input}
              type="number"
              min={1}
              inputMode="decimal"
              value={throughputLow}
              onChange={(e) => setThroughputLow(parsePositiveNumber(e.target.value, throughputLow))}
            />
            <span className={styles.inputUnit}>docs/reviewer/day</span>
          </label>
          <label htmlFor={`${idPrefix}-thigh`}>
            Reviewer throughput, high
            <input
              id={`${idPrefix}-thigh`}
              className={styles.input}
              type="number"
              min={1}
              inputMode="decimal"
              value={throughputHigh}
              onChange={(e) => setThroughputHigh(parsePositiveNumber(e.target.value, throughputHigh))}
            />
            <span className={styles.inputUnit}>docs/reviewer/day</span>
          </label>
          <label htmlFor={`${idPrefix}-cost`}>
            Loaded reviewer cost
            <input
              id={`${idPrefix}-cost`}
              className={styles.input}
              type="number"
              min={0}
              inputMode="decimal"
              value={loadedCostPerHour}
              onChange={(e) => setLoadedCostPerHour(parsePositiveNumber(e.target.value, loadedCostPerHour))}
            />
            <span className={styles.inputUnit}>$/reviewer-hour</span>
          </label>
        </div>
      </div>

      <div className={styles.corpusRef}>
        <h4 className={styles.assumptionsTitle}>Proven on the evaluation corpus</h4>
        <dl className={styles.facts}>
          <div>
            <dt>Containment (never reached the paid tier)</dt>
            <dd className={styles.mono}>
              {CORPUS_REFERENCE.containedCount}/{CORPUS_REFERENCE.adversarialTotal} ({corpusContainmentPct}%)
            </dd>
          </div>
          <div>
            <dt>Out-of-domain rejection rate</dt>
            <dd className={styles.mono}>
              {CORPUS_REFERENCE.rejectedCount}/{CORPUS_REFERENCE.adversarialTotal} ({corpusRejectionPct}%)
            </dd>
          </div>
          <div>
            <dt>False rejections on valid documents</dt>
            <dd className={styles.mono}>
              {CORPUS_REFERENCE.falseRejectCount}/{CORPUS_REFERENCE.nonAdversarialTotal} — must be zero
            </dd>
          </div>
          <div>
            <dt>Spend avoided across the corpus</dt>
            <dd className={styles.mono}>{fmtUsd(CORPUS_REFERENCE.spendAvoidedUsd)}</dd>
          </div>
          <div>
            <dt>Reviewer time avoided, at your assumptions above</dt>
            <dd className={styles.mono}>
              {fmtMinutesRange(corpusMinutes.low, corpusMinutes.high)} ·{' '}
              {fmtUsdRange(corpusDollars.low, corpusDollars.high)}
            </dd>
          </div>
        </dl>
        <p className={styles.sourceNote}>
          35-document synthetic corpus, commit <code>{CORPUS_REFERENCE.sourceCommit}</code> —
          regenerate via <code>npm run eval</code>.
        </p>
      </div>
    </div>
  );
}
