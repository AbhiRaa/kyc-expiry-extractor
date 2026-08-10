'use client';

import type { SourceTier } from '@/types/contract';
import styles from './PipelineRail.module.css';

/**
 * How a step ended up.
 *
 *   resolved   this is the tier the verdict was read from
 *   ran        always runs (normalization, the constraint engine, routing)
 *   abstained  ran, found nothing it was confident enough to return
 *   skipped    never invoked, because a cheaper tier had already resolved
 */
type StepState = 'resolved' | 'ran' | 'abstained' | 'skipped';

const STATE_LABEL: Record<StepState, string> = {
  resolved: 'resolved here',
  ran: 'ran',
  abstained: 'abstained',
  skipped: 'not needed',
};

/** Escalation order. `T0` and the two post-tier steps sit outside it — they always run. */
const TIER_ORDER = ['TA', 'TB', 'TC'] as const;
type TierCode = (typeof TIER_ORDER)[number];

const STEPS: readonly { code: string; label: string }[] = [
  { code: 'T0', label: 'Normalize + classify' },
  { code: 'TA', label: 'MRZ · PDF417' },
  { code: 'TB', label: 'Layout OCR' },
  { code: 'TC', label: 'Dual-call VLM' },
  { code: 'CE', label: 'Constraint engine' },
  { code: 'RT', label: 'Fusion + routing' },
];

/** Which rung of the ladder produced the answer. `null` when every tier abstained. */
function resolvedTier(tier: SourceTier): TierCode | null {
  switch (tier) {
    case 'TA_MRZ':
    case 'TA_PDF417':
      return 'TA';
    case 'TB_OCR':
      return 'TB';
    case 'TC_VLM':
      return 'TC';
    case 'NONE':
    default:
      return null;
  }
}

function stateOf(code: string, resolved: TierCode | null): StepState {
  // T0 normalizes and classifies on every request, and CE/RT run on whatever the
  // tiers produced even when that is nothing. None of the three can abstain.
  if (code === 'T0' || code === 'CE' || code === 'RT') return 'ran';

  const index = TIER_ORDER.indexOf(code as TierCode);

  // `source_tier: NONE` — every tier was tried and every tier abstained. This is
  // the employment-letter path, and it is a correct outcome rather than a failure,
  // so all three read as "abstained" instead of collapsing to "not needed".
  if (resolved === null) return 'abstained';

  const resolvedAt = TIER_ORDER.indexOf(resolved);
  if (index < resolvedAt) return 'abstained';
  if (index === resolvedAt) return 'resolved';
  return 'skipped';
}

export interface PipelineRailProps {
  tier: SourceTier;
  /** Total wall-clock for the request, from `timing_ms.total`. */
  totalMs: number;
  costUsd: number;
}

/**
 * The route through the tiers.
 *
 * This is the one panel in v2 that has no equivalent in v1, and it is the panel
 * that makes the architecture legible in a single glance: the tiers are ordered
 * cheapest-first, and where the highlight lands tells you what the document cost
 * to read. A licence that resolves at `TA` shows two steps greyed out to its right
 * — *the model was never called* — next to a latency of 19 ms and $0.00. No prose
 * makes that point as quickly.
 *
 * The state of each step is derived from `evidence.source_tier` rather than
 * measured, because `timing_ms` carries `{ total, normalize, tier }` and not a key
 * per tier. That is a real limit and it is why the labels say "abstained" and "not
 * needed" rather than quoting per-tier durations they cannot support: the routing
 * is known exactly, the per-tier timings are not.
 */
export default function PipelineRail({ tier, totalMs, costUsd }: PipelineRailProps) {
  const resolved = resolvedTier(tier);

  return (
    <section className={styles.card} aria-label="Route through the tiers">
      <div className={styles.head}>
        <h3 className={styles.eyebrow}>Route through the tiers</h3>
        <div className={styles.pills}>
          <span className={styles.pill}>{Math.round(totalMs).toLocaleString()} ms</span>
          <span className={styles.pill}>
            {costUsd === 0 ? '$0.00' : `$${costUsd.toFixed(4)}`}
          </span>
        </div>
      </div>
      <ol className={styles.steps}>
        {STEPS.map((step) => {
          const state = stateOf(step.code, resolved);
          return (
            <li key={step.code} className={`${styles.step} ${styles[`step_${state}`]}`}>
              <span className={styles.code}>{step.code}</span>
              <span className={styles.label}>{step.label}</span>
              <span className={styles.state}>{STATE_LABEL[state]}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
