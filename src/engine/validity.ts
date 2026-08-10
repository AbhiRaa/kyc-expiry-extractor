/**
 * Class-specific validity rules (§4.3). Pure functions, no I/O.
 *
 * This is the part most candidates miss. "Expiration date" is not a universal concept —
 * in KYC, different document classes are validated by different rules. A bank statement
 * has no expiry date at all, yet it is on the interviewer's own list of KYC documents.
 *
 * Therefore the system's output is NOT a date. It is a verdict plus the basis it was
 * reached on, and the basis is named in the response so a reviewer can audit it.
 *
 * Two traps this module exists to avoid (§1 "Known trap"):
 *   1. An expired document's expiry date IS in the past. Discarding past dates would
 *      discard the exact case the system exists to detect.
 *   2. "No date found" is NOT "expired". For a NO_EXPIRY class it is the correct answer.
 */

import {
  type DocumentClass,
  RECENCY_WINDOW_DAYS,
  TIMEZONE_POLICY,
  type ValidityBasis,
  type ValidityInfo,
  type Verdict,
} from '@/types/contract';
import { daysBetween } from './dates';

/** Which rule family applies to each document class (§4.3). */
export const BASIS_BY_CLASS: Record<DocumentClass, ValidityBasis> = {
  US_DRIVERS_LICENSE: 'EXPIRY_DATE',
  US_STATE_ID: 'EXPIRY_DATE',
  PASSPORT: 'EXPIRY_DATE',
  NATIONAL_ID_CARD: 'EXPIRY_DATE',
  RESIDENCE_PERMIT: 'EXPIRY_DATE',
  MEDICAL_INSURANCE_CARD: 'COVERAGE_END',
  BANK_STATEMENT: 'RECENCY_WINDOW',
  UTILITY_BILL: 'RECENCY_WINDOW',
  EMPLOYMENT_LETTER: 'NO_EXPIRY',
  OTHER_DOCUMENT: 'UNDETERMINED',
  NOT_A_DOCUMENT: 'UNDETERMINED',
};

const RULE_TEXT: Record<ValidityBasis, string> = {
  EXPIRY_DATE:
    'CIP (31 CFR 1020.220): identity document must be unexpired at submission',
  RECENCY_WINDOW:
    'Proof-of-address recency (FATF Rec. 10; UK JMLSG / EU AMLD): document must be dated within the accepted window',
  COVERAGE_END: 'Insurance coverage period end date must not have passed',
  NO_EXPIRY: 'Document class carries no expiry semantics; no date is applicable',
  UNDETERMINED: 'Could not establish which validity rule applies to this document',
};

export interface ValidityInput {
  documentClass: DocumentClass;
  /** The surviving best candidate's ISO date, or null when the engine abstained. */
  dateIso: string | null;
  /** Exactly as read from the source. */
  dateRaw: string | null;
  today: Date;
  /** Appended to `rule_applied` when a normalization rule shaped the date. */
  normalizationRule?: string;
  /** Overrides the class default — e.g. an insurance card that turned out to be NO_EXPIRY. */
  basisOverride?: ValidityBasis;
}

/**
 * Decide the verdict.
 *
 * Boundary policy (§11.4 #51): end-of-day inclusive, UTC. A document expiring today is
 * still VALID. The policy is stated in the response so it is auditable rather than
 * implied.
 */
export function evaluateValidity(input: ValidityInput): ValidityInfo {
  const { documentClass, dateIso, dateRaw, today } = input;
  const basis = input.basisOverride ?? BASIS_BY_CLASS[documentClass];
  const todayIso = today.toISOString().slice(0, 10);

  let verdict: Verdict;
  let daysRemaining: number | null = null;
  let rule = RULE_TEXT[basis];
  // Overridden to null for NO_EXPIRY below — a class with no expiry semantics has nothing
  // to report even when some tier turned up a candidate on the page.
  let returnedDate = dateIso;
  let returnedDateRaw = dateRaw;

  switch (basis) {
    case 'NO_EXPIRY':
      // The showcase abstention case. An employment letter with 8+ dates and no expiry
      // semantics must NOT have a termination or appraisal date selected for it. Any date
      // a tier found is irrelevant here, so it must not leak into the response either —
      // a non-null `date` next to a NOT_APPLICABLE verdict reads as a found expiry.
      verdict = 'NOT_APPLICABLE';
      returnedDate = null;
      returnedDateRaw = null;
      break;

    case 'EXPIRY_DATE':
    case 'COVERAGE_END': {
      if (!dateIso) {
        // No date found is NOT expired — we simply could not determine validity.
        verdict = 'INDETERMINATE';
        break;
      }
      daysRemaining = daysBetween(todayIso, dateIso);
      // >= 0 keeps an expiry of today VALID (end-of-day inclusive).
      verdict = daysRemaining >= 0 ? 'VALID' : 'EXPIRED';
      break;
    }

    case 'RECENCY_WINDOW': {
      if (!dateIso) {
        verdict = 'INDETERMINATE';
        break;
      }
      const windowDays = RECENCY_WINDOW_DAYS[documentClass] ?? 90;
      // For a recency rule the date is a STATEMENT DATE, not an expiry. The document is
      // acceptable while it is younger than the window.
      const ageDays = daysBetween(dateIso, todayIso);
      daysRemaining = windowDays - ageDays;
      verdict = ageDays <= windowDays ? 'VALID' : 'EXPIRED';
      rule = `${RULE_TEXT.RECENCY_WINDOW} (${windowDays}-day window; document is ${ageDays} days old)`;
      break;
    }

    case 'UNDETERMINED':
    default:
      verdict = 'INDETERMINATE';
      break;
  }

  if (input.normalizationRule) rule = `${rule}. ${input.normalizationRule}`;

  return {
    basis,
    date: returnedDate,
    date_raw: returnedDateRaw,
    rule_applied: rule,
    verdict,
    days_remaining: daysRemaining,
    evaluated_at: today.toISOString(),
    timezone_policy: TIMEZONE_POLICY,
  };
}

/**
 * True for classes where a missing date is a legitimate answer rather than a failure.
 * Used by the router to decide whether `NO_DATES_FOUND` should route to REVIEW or is
 * simply the correct outcome.
 */
export function missingDateIsExpected(documentClass: DocumentClass): boolean {
  return BASIS_BY_CLASS[documentClass] === 'NO_EXPIRY';
}

/**
 * Explicit non-expiry labels (§11.4 #48). A document that says so in words should be
 * believed, whatever its class default is.
 */
const NON_EXPIRING_LABELS = [
  'NON-EXPIRING',
  'NON EXPIRING',
  'NONEXPIRING',
  'INDEFINITE',
  'DOES NOT EXPIRE',
  'NO EXPIRATION',
  'NO EXPIRY',
  'PERMANENT',
  // Insurance-specific phrasing: coverage that runs indefinitely rather than to a printed
  // end date, and the direct statement that no such date is printed at all.
  'COVERAGE CONTINUOUS',
  'CONTINUOUS COVERAGE',
  'NO TERMINATION DATE',
];

export function hasExplicitNonExpiringLabel(text: string | null | undefined): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();
  return NON_EXPIRING_LABELS.some((label) => upper.includes(label));
}
