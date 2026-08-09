/**
 * Cross-source agreement and temporal integrity (§7 "When both are available", §11.5).
 *
 * Two independent jobs live here because they answer the same question — "do the dates on
 * this document hang together?" — from two directions:
 *
 *  1. **Cross-source.** A passport photographed with the data page visible carries its
 *     expiry twice: in the MRZ and in the printed VIZ. A DL with both sides carries it in
 *     the PDF417 and in print. When both readings exist we compare them. Agreement raises
 *     confidence because two independent channels concur. Disagreement is a tamper signal
 *     (§11.4 #59-60): the naive forgery is to edit the printed field and leave the
 *     machine-readable one alone. We never break the tie — picking the MRZ "because it has
 *     a checksum" would launder exactly the alteration we were asked to catch.
 *
 *  2. **Temporal plausibility.** Within a single source, some date combinations cannot
 *     occur on a genuine document: expiry before issue, a validity span no issuer grants,
 *     a holder born after their document expires, an issue date in the future
 *     (§11.5 #62-65). These are cheap, deterministic, and catch both forgery and a
 *     misread that happened to survive its check digit.
 *
 * Both return findings; neither returns a decision. Anomalies force REVIEW downstream
 * (contract: `INTEGRITY_ANOMALIES`), which keeps the routing policy in one place.
 */

import {
  DETERMINISTIC_CONFIDENCE,
  type DateRole,
  type IntegrityAnomaly,
  type ReasonCode,
} from '@/types/contract';
import { daysInMonth, daysBetween, toIso, yearsBetween } from '@/engine/dates';

/**
 * No identity document is issued with a validity span longer than this. Passports top out
 * at 10 years, US DLs at 8, and the longest real outlier (some lifetime-style national IDs)
 * still sits well inside 20 (§11.5 #63).
 */
export const MAX_PLAUSIBLE_VALIDITY_YEARS = 20;

/**
 * Confidence added when an independent second source agrees. Deliberately small: the
 * deterministic tiers already sit at 0.99, and agreement is corroboration, not proof.
 */
export const CROSS_SOURCE_AGREEMENT_BONUS = 0.005;

/** The three dates every identity document carries, in ISO 8601 or null when absent. */
export interface DateTriple {
  expiry?: string | null;
  issue?: string | null;
  dob?: string | null;
}

/** Same month and day, `years` later, clamped for 29 February. */
function addYears(iso: string, years: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const target = year + years;
  return toIso(target, month, Math.min(day, daysInMonth(target, month)));
}

export interface PlausibilityResult {
  anomalies: IntegrityAnomaly[];
  reason_codes: ReasonCode[];
  /** Human-readable statements of each finding, for `integrity.checksum_detail`. */
  notes: string[];
}

/**
 * Run the single-source integrity constraints (§11.5 #62-65).
 *
 * `sourceLabel` is folded into the notes so a reviewer reading a merged response can tell
 * whether the contradiction was inside the MRZ, inside the barcode, or across the two.
 */
export function checkTemporalPlausibility(
  dates: DateTriple,
  today: Date,
  sourceLabel = 'document',
): PlausibilityResult {
  const anomalies: IntegrityAnomaly[] = [];
  const notes: string[] = [];
  const { expiry = null, issue = null, dob = null } = dates;

  const record = (anomaly: IntegrityAnomaly, note: string) => {
    if (!anomalies.includes(anomaly)) anomalies.push(anomaly);
    notes.push(`${sourceLabel}: ${note}`);
  };

  if (expiry && issue && daysBetween(issue, expiry) < 0) {
    record('EXPIRY_BEFORE_ISSUE', `expiry ${expiry} precedes issue ${issue}`);
  }

  if (expiry && issue) {
    const span = yearsBetween(issue, expiry);
    // Compared against the calendar anniversary rather than span > 20 in average years: a
    // document issued and expiring on the same day 20 years apart spans 7305 days, which is
    // 20.0004 average years, and flagging a legitimate 20-year card on rounding noise is a
    // false positive a reviewer has to clear by hand.
    if (expiry > addYears(issue, MAX_PLAUSIBLE_VALIDITY_YEARS)) {
      record(
        'IMPLAUSIBLE_VALIDITY_PERIOD',
        `validity span of ${span.toFixed(1)} years (${issue} → ${expiry}) exceeds the ` +
          `${MAX_PLAUSIBLE_VALIDITY_YEARS}-year plausibility ceiling`,
      );
    }
  }

  if (expiry && dob && daysBetween(dob, expiry) < 0) {
    record('DOB_AFTER_EXPIRY', `date of birth ${dob} falls after expiry ${expiry}`);
  }

  if (issue) {
    const todayIso = today.toISOString().slice(0, 10);
    if (daysBetween(todayIso, issue) > 0) {
      record('FUTURE_DATED_ISSUE', `issue date ${issue} is in the future (today is ${todayIso})`);
    }
  }

  return {
    anomalies,
    // Every anomaly is also a reason code of the same name, and every REVIEW must carry one.
    reason_codes: [...anomalies],
    notes,
  };
}

// ---------------------------------------------------------------------------
// Cross-source comparison
// ---------------------------------------------------------------------------

/** Which machine-readable channel produced the values — it selects the mismatch code. */
export type MachineReadableSource = 'MRZ' | 'PDF417';

export interface CrossCheckInput {
  /** Values read deterministically (TA-MRZ or TA-PDF417). */
  machine: { source: MachineReadableSource; dates: DateTriple } | null;
  /** Values read from the printed face — the VIZ of a passport, the front of a DL. */
  printed: { dates: DateTriple } | null;
  today: Date;
  /** Confidence to adjust. Defaults to the deterministic tier's 0.99. */
  baseConfidence?: number;
}

export interface FieldComparison {
  role: DateRole;
  machine: string | null;
  printed: string | null;
  agrees: boolean;
}

export interface CrossCheckResult {
  anomalies: IntegrityAnomaly[];
  reason_codes: ReasonCode[];
  /** Maps onto `integrity.cross_source_agreement`; null when only one source existed. */
  cross_source_agreement: string | null;
  confidence: number;
  /** True when any finding must override an otherwise clean AUTO_PASS. */
  force_review: boolean;
  comparisons: FieldComparison[];
  notes: string[];
}

const ROLE_BY_KEY: Record<keyof DateTriple, DateRole> = {
  expiry: 'EXPIRY',
  issue: 'ISSUE',
  dob: 'DATE_OF_BIRTH',
};

const MISMATCH_CODE: Record<MachineReadableSource, IntegrityAnomaly> = {
  MRZ: 'MRZ_VIZ_MISMATCH',
  PDF417: 'BARCODE_PRINT_MISMATCH',
};

/**
 * Compare a machine-readable reading against a printed one and sweep both for temporal
 * contradictions.
 *
 * Only fields present on *both* sides are compared. A printed expiry with no MRZ expiry is
 * not a mismatch, it is a single-source read — treating absence as disagreement would send
 * every one-sided capture to review.
 */
export function crossCheck(input: CrossCheckInput): CrossCheckResult {
  const { machine, printed, today } = input;
  const baseConfidence = input.baseConfidence ?? DETERMINISTIC_CONFIDENCE;

  const anomalies: IntegrityAnomaly[] = [];
  const notes: string[] = [];
  const comparisons: FieldComparison[] = [];

  const addAnomaly = (anomaly: IntegrityAnomaly) => {
    if (!anomalies.includes(anomaly)) anomalies.push(anomaly);
  };

  // Each source is checked against the calendar on its own terms first, so a contradiction
  // inside one source is not blamed on the other.
  if (machine) {
    const result = checkTemporalPlausibility(machine.dates, today, machine.source);
    result.anomalies.forEach(addAnomaly);
    notes.push(...result.notes);
  }
  if (printed) {
    const result = checkTemporalPlausibility(printed.dates, today, 'printed');
    result.anomalies.forEach(addAnomaly);
    notes.push(...result.notes);
  }

  let agreedFields = 0;
  let mismatchedFields = 0;

  if (machine && printed) {
    for (const key of ['expiry', 'issue', 'dob'] as const) {
      const machineValue = machine.dates[key] ?? null;
      const printedValue = printed.dates[key] ?? null;
      if (!machineValue || !printedValue) continue;

      const agrees = machineValue === printedValue;
      comparisons.push({ role: ROLE_BY_KEY[key], machine: machineValue, printed: printedValue, agrees });

      if (agrees) {
        agreedFields++;
        continue;
      }
      mismatchedFields++;
      addAnomaly(MISMATCH_CODE[machine.source]);
      notes.push(
        `${ROLE_BY_KEY[key]}: ${machine.source} reads ${machineValue}, printed reads ${printedValue} ` +
          '— both retained, neither preferred; a machine-readable/printed divergence is a tamper ' +
          'signal, not a tie to break',
      );
    }
  }

  const forceReview = anomalies.length > 0;

  let confidence = baseConfidence;
  if (mismatchedFields > 0) {
    // Corroboration failed. The reading itself may still be correct, but we no longer have
    // grounds to auto-pass it, so we drop below the AUTO_THRESHOLD rather than nudge.
    confidence = Math.min(baseConfidence, 0.5);
  } else if (agreedFields > 0) {
    confidence = Math.min(1, baseConfidence + CROSS_SOURCE_AGREEMENT_BONUS);
  }

  let agreement: string | null = null;
  if (machine && printed && comparisons.length > 0) {
    agreement =
      mismatchedFields === 0
        ? `${machine.source} agrees with the printed values on ${comparisons
            .map((comparison) => comparison.role)
            .join(', ')}`
        : `${machine.source} disagrees with the printed values on ${comparisons
            .filter((comparison) => !comparison.agrees)
            .map((comparison) => comparison.role)
            .join(', ')}`;
  }

  return {
    anomalies,
    reason_codes: [...anomalies],
    cross_source_agreement: agreement,
    confidence,
    force_review: forceReview,
    comparisons,
    notes,
  };
}
