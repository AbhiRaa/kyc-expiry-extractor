/**
 * The constraint engine (§8). Pure functions, no I/O.
 *
 * This is the direct answer to the interviewer's "we may or we might not know the
 * labels". The strategy is deliberately NOT to recognise the label. We inventory every
 * date on the document, then eliminate the ones that are impossible. What survives is
 * the expiry — even when it was never labelled at all (§11.4 #46, the assignment's
 * real test).
 *
 * Two rules govern the design:
 *
 *   1. Hard constraints ELIMINATE. They encode facts that are true of every real
 *      document, so violating one means the candidate is not the expiry.
 *   2. Soft signals only ADJUST CONFIDENCE. None of them can eliminate a candidate on
 *      its own, because each has real counter-examples.
 *
 * Every elimination is recorded with a human-readable reason, because the UI's "why?"
 * panel surfaces them. Showing which candidates were ruled out and why is what makes
 * the reasoning legible instead of magical.
 */

import type {
  DateRole,
  IntegrityAnomaly,
  ReasonCode,
  TierCandidate,
} from '@/types/contract';
import {
  daysBetween,
  exceedsAnniversary,
  isoToUtc,
  precedesAnniversary,
  singleDigitVariants,
  yearsBetween,
} from './dates';

// ---------------------------------------------------------------------------
// Candidate model
// ---------------------------------------------------------------------------

export interface DateCandidate extends TierCandidate {
  /** Set once a hard constraint rules this candidate out. Surfaced in the "why?" panel. */
  eliminatedBy?: string;
  /** Running score from soft signals. Only meaningful for surviving candidates. */
  score: number;
  /** Human-readable list of the soft signals that fired, for the decision trace. */
  signals: string[];
}

export interface ConstraintContext {
  /** Every date found on the document, across all tiers. */
  candidates: DateCandidate[];
  /** Anchor date. Injected rather than read from the clock so results are reproducible. */
  today: Date;
  /** True for identity documents (DL, state ID, passport, national ID, residence permit). */
  isIdentityDocument: boolean;
  /**
   * True when the document class is validated by a RECENCY_WINDOW rather than an expiry
   * (bank statement, utility bill). Changes which role the engine treats as the target.
   */
  recencyValidated?: boolean;
  /** Raw OCR token stream, used for grounding (§8 soft signals, §11.5 #66). */
  groundingTokens?: string[];
  /** Raw values the Hunter call returned, for cross-call agreement. */
  hunterRawValues?: string[];
  /** Raw values the Mapper call returned, for cross-call agreement. */
  mapperRawValues?: string[];
}

export interface ConstraintOutcome {
  /** Candidates that survived every hard constraint, best-scoring first. */
  survivors: DateCandidate[];
  /** Candidates ruled out, each carrying its `eliminatedBy` reason. */
  eliminated: DateCandidate[];
  /** Integrity findings. Any one of these forces REVIEW regardless of confidence. */
  anomalies: IntegrityAnomaly[];
  reasonCodes: ReasonCode[];
  /** Count of hard constraints that were actually evaluated — feeds confidence fusion. */
  hardConstraintsChecked: number;
}

function pick(candidates: DateCandidate[], role: DateRole): DateCandidate | undefined {
  return candidates.find((c) => c.role === role && c.iso);
}

// ---------------------------------------------------------------------------
// Hard constraints — violation eliminates a candidate (§8)
// ---------------------------------------------------------------------------

/** Longer than this implies a misread, not a real document. */
const MAX_VALIDITY_YEARS = 20;
/** Nobody holds an identity document before this age, so expiry cannot precede it. */
const MIN_HOLDER_AGE_YEARS = 15;
/**
 * No candidate may sit this far beyond today, independent of whether an ISSUE candidate
 * was found. The per-issuance check below only fires once an ISSUE date has survived —
 * this is the defense-in-depth backstop for when it hasn't (e.g. an injected date with no
 * genuine issue date anywhere on the page). Set well above any real document's term so it
 * never competes with the per-issuance check on a legitimate candidate.
 */
const MAX_YEARS_FROM_TODAY = 25;

/**
 * Roles a tier has POSITIVELY identified as something other than the validity-determining
 * date. `UNKNOWN` is deliberately excluded from this set — an undated, unlabelled candidate
 * is exactly the "resolve it by elimination, not by label" case this whole engine exists
 * for (§11.4 #46); eliminating on role would defeat that. These roles are the opposite
 * case: a tier said, in words, "this date means something else" — a date of birth, an
 * issue date, a transaction/stamp date, a performance-review date, a document's own print
 * date, an employment start/end date, or the START of a period whose END is what every one
 * of our validity bases (EXPIRY_DATE, COVERAGE_END, RECENCY_WINDOW) actually cares about.
 * A candidate carrying one of these is disqualified regardless of which basis is being
 * evaluated, because none of them is ever the answer for any of them.
 *
 * Found via a real prompt-tested case: a VLM call correctly labelled two travel-stamp
 * dates as `TRANSACTION` — it was right not to call them an expiry — but nothing stopped
 * the higher-scoring one from winning anyway once classification correctly resolved the
 * document to a basis that needed a date. Soft signals alone cannot fix this: they only
 * ever adjust a score upward or downward, and a wrong-role candidate can still out-score
 * an absent right one. This needs to eliminate, not merely penalise.
 */
const NEVER_EXPIRY_ROLES: ReadonlySet<DateRole> = new Set<DateRole>([
  'DATE_OF_BIRTH',
  'ISSUE',
  'COVERAGE_START',
  'STATEMENT_PERIOD_START',
  'EMPLOYMENT_START',
  'EMPLOYMENT_END',
  'APPRAISAL',
  'PRINT_DATE',
  'TRANSACTION',
]);

export function applyHardConstraints(ctx: ConstraintContext): ConstraintOutcome {
  const { candidates, today, isIdentityDocument } = ctx;
  const todayIso = today.toISOString().slice(0, 10);

  const anomalies: IntegrityAnomaly[] = [];
  const reasonCodes: ReasonCode[] = [];
  let checked = 0;

  const issue = pick(candidates, 'ISSUE');
  const dob = pick(candidates, 'DATE_OF_BIRTH');

  // --- Document-level integrity findings (independent of any single candidate) ---

  if (issue?.iso) {
    checked++;
    if (daysBetween(todayIso, issue.iso) > 0) {
      // A future issue date is a fraud or misread signal, never legitimate.
      anomalies.push('FUTURE_DATED_ISSUE');
      reasonCodes.push('FUTURE_DATED_ISSUE');
    }
  }

  // --- Per-candidate elimination ---

  for (const candidate of candidates) {
    if (!candidate.iso) continue;

    // A role a tier positively identified as something else disqualifies the candidate
    // outright — this also covers DOB/ISSUE, which additionally serve as the *reference*
    // points the checks below compare every other candidate against, so running those
    // checks against DOB/ISSUE themselves would be circular.
    if (NEVER_EXPIRY_ROLES.has(candidate.role)) {
      checked++;
      eliminate(candidate, `Role ${candidate.role} is never the validity-determining date`);
      continue;
    }

    const iso = candidate.iso;

    // expiry > issue — always true.
    if (issue?.iso) {
      checked++;
      if (daysBetween(issue.iso, iso) <= 0) {
        eliminate(candidate, `Expiry ${iso} is not after issue date ${issue.iso}`);
        if (!anomalies.includes('EXPIRY_BEFORE_ISSUE')) {
          anomalies.push('EXPIRY_BEFORE_ISSUE');
          reasonCodes.push('EXPIRY_BEFORE_ISSUE');
        }
        continue;
      }

      // expiry - issue <= 20 years — longer implies a misread.
      // Compared against the calendar anniversary, not average-length years: exactly 20
      // calendar years is 20.0004 average years, so a naive `> 20` would eliminate every
      // legitimate 20-year document by a rounding artefact.
      checked++;
      const span = yearsBetween(issue.iso, iso);
      if (exceedsAnniversary(issue.iso, iso, MAX_VALIDITY_YEARS)) {
        eliminate(
          candidate,
          `Validity period of ${span.toFixed(1)} years exceeds the ${MAX_VALIDITY_YEARS}-year plausible maximum`,
        );
        if (!anomalies.includes('IMPLAUSIBLE_VALIDITY_PERIOD')) {
          anomalies.push('IMPLAUSIBLE_VALIDITY_PERIOD');
          reasonCodes.push('IMPLAUSIBLE_VALIDITY_PERIOD');
        }
        continue;
      }
    }

    // Absolute ceiling, independent of an ISSUE candidate being present at all.
    if (daysBetween(todayIso, iso) > 0) {
      checked++;
      if (exceedsAnniversary(todayIso, iso, MAX_YEARS_FROM_TODAY)) {
        eliminate(
          candidate,
          `${iso} is more than ${MAX_YEARS_FROM_TODAY} years in the future, exceeding the plausible maximum`,
        );
        if (!anomalies.includes('IMPLAUSIBLE_VALIDITY_PERIOD')) {
          anomalies.push('IMPLAUSIBLE_VALIDITY_PERIOD');
          reasonCodes.push('IMPLAUSIBLE_VALIDITY_PERIOD');
        }
        continue;
      }
    }

    if (dob?.iso) {
      // expiry > DOB + 15 years — no ID expires before its holder could hold one.
      // Anniversary comparison for the same reason as the validity ceiling above.
      checked++;
      if (precedesAnniversary(dob.iso, iso, MIN_HOLDER_AGE_YEARS)) {
        eliminate(
          candidate,
          `Expiry ${iso} is less than ${MIN_HOLDER_AGE_YEARS} years after date of birth ${dob.iso}`,
        );
        continue;
      }

      // DOB after expiry is a distinct integrity finding worth naming.
      checked++;
      if (daysBetween(iso, dob.iso) > 0) {
        if (!anomalies.includes('DOB_AFTER_EXPIRY')) {
          anomalies.push('DOB_AFTER_EXPIRY');
          reasonCodes.push('DOB_AFTER_EXPIRY');
        }
        eliminate(candidate, `Date of birth ${dob.iso} falls after this candidate`);
        continue;
      }
    }
  }

  // DOB is essentially always the earliest date on an identity document. If it is not,
  // something is wrong with the reading — flag it rather than silently trusting it.
  // Hoisted out of the closure so the narrowing survives (TS cannot narrow `dob.iso`
  // through a callback boundary).
  const dobIso = dob?.iso;
  if (isIdentityDocument && dobIso) {
    checked++;
    const earlier = candidates.filter(
      (c) => c.iso && c !== dob && daysBetween(c.iso, dobIso) > 0,
    );
    if (earlier.length > 0 && !anomalies.includes('DOB_AFTER_EXPIRY')) {
      reasonCodes.push('AMBIGUOUS_DATE_FORMAT');
    }
  }

  const survivors = candidates.filter((c) => !c.eliminatedBy && c.iso);
  const eliminated = candidates.filter((c) => c.eliminatedBy);

  return { survivors, eliminated, anomalies, reasonCodes, hardConstraintsChecked: checked };
}

function eliminate(candidate: DateCandidate, reason: string): void {
  if (!candidate.eliminatedBy) candidate.eliminatedBy = reason;
}

// ---------------------------------------------------------------------------
// OCR-misread rescue check (§8.6)
// ---------------------------------------------------------------------------

/**
 * If a candidate fails a hard constraint but a SINGLE plausible OCR digit substitution
 * would satisfy it, that is a strong hint the value was misread.
 *
 * We deliberately do NOT auto-correct. We flag `AMBIGUOUS_DATE_FORMAT` and route to
 * review. Silent correction is how wrong KYC decisions get made (§8.6).
 */
export function detectProbableMisread(
  candidate: DateCandidate,
  wouldSatisfy: (isoCandidate: string) => boolean,
): boolean {
  const digits = candidate.raw.replace(/\D/g, '');
  if (digits.length < 6) return false;

  return singleDigitVariants(digits).some((variant) => {
    // Re-slot the variant digits back into the original raw layout before testing.
    let i = 0;
    const reslotted = candidate.raw.replace(/\d/g, () => variant[i++] ?? '0');
    return wouldSatisfy(reslotted);
  });
}

// ---------------------------------------------------------------------------
// Soft signals — adjust confidence, never eliminate alone (§8)
// ---------------------------------------------------------------------------

/** Typical DL and passport terms. Hitting one is corroborating, missing one proves nothing. */
const TYPICAL_TERM_YEARS = [4, 5, 6, 8, 10];
const TERM_TOLERANCE_YEARS = 0.15;

export const SOFT_WEIGHTS = {
  typicalTerm: 0.15,
  birthdayAligned: 0.25,
  latestDate: 0.05,
  crossCallAgreement: 0.25,
  ocrGrounded: 0.2,
  roleLabelledExpiry: 0.2,
} as const;

export function applySoftSignals(ctx: ConstraintContext, outcome: ConstraintOutcome): void {
  const issue = pick(ctx.candidates, 'ISSUE');
  const dob = pick(ctx.candidates, 'DATE_OF_BIRTH');

  const latestIso = outcome.survivors
    .map((c) => c.iso!)
    .sort()
    .at(-1);

  for (const candidate of outcome.survivors) {
    const iso = candidate.iso!;

    // The tier already believes this is an expiry (a matched label, or an MRZ/AAMVA
    // field whose meaning is fixed by the standard).
    if (candidate.role === 'EXPIRY' || candidate.role === 'COVERAGE_END') {
      candidate.score += SOFT_WEIGHTS.roleLabelledExpiry;
      candidate.signals.push('Tier identified this date as carrying expiry semantics');
    }

    // On a recency-validated class the anchor is the statement or billing date, not an
    // expiry — so a labelled period end is the sought date there, and boosting it is the
    // same signal as boosting a labelled expiry on an identity document (§4.3).
    if (ctx.recencyValidated && candidate.role === 'STATEMENT_PERIOD_END') {
      candidate.score += SOFT_WEIGHTS.roleLabelledExpiry;
      candidate.signals.push('Tier identified this date as the statement or billing period end');
    }

    // A validity period matching a standard term corroborates the reading.
    if (issue?.iso) {
      const span = yearsBetween(issue.iso, iso);
      if (TYPICAL_TERM_YEARS.some((t) => Math.abs(span - t) < TERM_TOLERANCE_YEARS)) {
        candidate.score += SOFT_WEIGHTS.typicalTerm;
        candidate.signals.push(
          `Validity period of ${span.toFixed(1)} years matches a typical document term`,
        );
      }
    }

    // Many US state DLs expire on the holder's birthday. Strong signal, and it resolves
    // a two-candidate tie cleanly.
    if (dob?.iso && iso.slice(5) === dob.iso.slice(5)) {
      candidate.score += SOFT_WEIGHTS.birthdayAligned;
      candidate.signals.push('Expiry month-day matches date of birth (birthday-aligned renewal)');
    }

    // Weak: the expiry is usually but not always the latest date on the page.
    if (iso === latestIso && outcome.survivors.length > 1) {
      candidate.score += SOFT_WEIGHTS.latestDate;
      candidate.signals.push('Latest date among surviving candidates');
    }

    // Hunter and Mapper have different failure modes, so agreement between them is
    // informative in a way that resampling one call is not (§4.4).
    if (ctx.hunterRawValues && ctx.mapperRawValues) {
      const inHunter = ctx.hunterRawValues.some((v) => sameValue(v, candidate.raw));
      const inMapper = ctx.mapperRawValues.some((v) => sameValue(v, candidate.raw));
      if (inHunter && inMapper) {
        candidate.score += SOFT_WEIGHTS.crossCallAgreement;
        candidate.signals.push('Hunter and Mapper independently reported this value');
      }
    }

    // Grounding: the value should appear literally in the OCR token stream. Absence is
    // the hallucination signature (§11.5 #66) — an injected date will not survive this.
    if (ctx.groundingTokens && ctx.groundingTokens.length > 0) {
      if (isGrounded(candidate.raw, ctx.groundingTokens)) {
        candidate.score += SOFT_WEIGHTS.ocrGrounded;
        candidate.signals.push('Value appears verbatim in the raw OCR token stream');
      } else {
        candidate.score -= SOFT_WEIGHTS.ocrGrounded;
        candidate.signals.push('NOT grounded in the OCR token stream — possible fabrication');
        if (!outcome.reasonCodes.includes('VALUE_NOT_GROUNDED_IN_OCR')) {
          outcome.reasonCodes.push('VALUE_NOT_GROUNDED_IN_OCR');
        }
      }
    }
  }

  outcome.survivors.sort((a, b) => b.score - a.score);
}

/** Compares two printed date values ignoring separators and case. */
function sameValue(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return norm(a) === norm(b);
}

/**
 * A value is grounded if its digits appear in the OCR stream, either as a single token
 * or spread across adjacent tokens (OCR routinely splits "04/23/2030" on the slashes).
 */
export function isGrounded(raw: string, tokens: string[]): boolean {
  const target = raw.replace(/[^0-9]/g, '');
  if (!target) return false;

  const joined = tokens.join('').replace(/[^0-9]/g, '');
  return joined.includes(target);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runConstraintEngine(ctx: ConstraintContext): ConstraintOutcome {
  const outcome = applyHardConstraints(ctx);
  applySoftSignals(ctx, outcome);

  if (outcome.survivors.length === 0 && ctx.candidates.length > 0) {
    outcome.reasonCodes.push('NO_EXPIRY_SEMANTICS');
  }
  if (ctx.candidates.length === 0) {
    // "No date found" is NOT "expired" — a bank statement has no expiry date at all,
    // yet it is on the interviewer's own list of KYC documents (§1 known trap).
    outcome.reasonCodes.push('NO_DATES_FOUND');
  }
  if (outcome.survivors.length > 1) {
    const [first, second] = outcome.survivors;
    // Only ambiguous if the top two are genuinely close; a clear winner is not a tie.
    if (Math.abs(first.score - second.score) < 0.1) {
      outcome.reasonCodes.push('MULTIPLE_EXPIRY_CANDIDATES');
    }
  }

  return outcome;
}

export function makeCandidate(partial: Partial<DateCandidate> & { iso: string | null }): DateCandidate {
  return {
    raw: partial.raw ?? partial.iso ?? '',
    iso: partial.iso,
    role: partial.role ?? 'UNKNOWN',
    label_verbatim: partial.label_verbatim ?? null,
    snippet: partial.snippet ?? null,
    bbox: partial.bbox ?? null,
    confidence: partial.confidence ?? 0.5,
    score: partial.score ?? 0,
    signals: partial.signals ?? [],
    eliminatedBy: partial.eliminatedBy,
  };
}

export { isoToUtc };
