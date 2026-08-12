/**
 * Reviewer-throughput assumptions — editable inputs, not measured facts. The client's
 * own framing (v2 rework, docs/DECISIONS.md §8): a manual KYC process clears 20-30
 * documents per reviewer per 8-hour day. That's the only number in this file that isn't
 * derived; everything else is arithmetic on top of it.
 *
 * Shared between the eval harness (eval/run.ts, "reviewer-minutes avoided") and the ROI
 * panel UI (item 2) specifically so both report the same figure under the same stated
 * assumption — two independently hand-tuned constants would silently drift apart the
 * first time either one got tweaked.
 */

export interface ReviewerThroughputAssumption {
  /** Documents a single reviewer clears per working day, at the low and high end of the
   *  client's own stated range. Low throughput -> more minutes per document. */
  throughputPerDayLow: number;
  throughputPerDayHigh: number;
  workdayMinutes: number;
}

export const DEFAULT_REVIEWER_ASSUMPTION: ReviewerThroughputAssumption = {
  throughputPerDayLow: 20,
  throughputPerDayHigh: 30,
  workdayMinutes: 8 * 60,
};

export interface MinutesRange {
  low: number;
  high: number;
}

/** Minutes per document, derived from throughput. The *low* throughput bound (fewer
 *  documents/day) produces the *high* minutes-per-document bound, and vice versa. */
export function minutesPerDocument(assumption: ReviewerThroughputAssumption): MinutesRange {
  return {
    low: assumption.workdayMinutes / assumption.throughputPerDayHigh,
    high: assumption.workdayMinutes / assumption.throughputPerDayLow,
  };
}

/** Reviewer-minutes avoided for a given count of human touches avoided, under the stated
 *  throughput assumption. Always a range, never a single number — a point estimate would
 *  claim a precision the underlying assumption ("20-30 a day") does not have. */
export function reviewerMinutesAvoided(
  touchesAvoided: number,
  assumption: ReviewerThroughputAssumption = DEFAULT_REVIEWER_ASSUMPTION,
): MinutesRange {
  const perDoc = minutesPerDocument(assumption);
  return { low: touchesAvoided * perDoc.low, high: touchesAvoided * perDoc.high };
}

export interface DollarRange {
  low: number;
  high: number;
}

/**
 * Illustrative default only, not a client-stated figure the way `DEFAULT_REVIEWER_ASSUMPTION`
 * is — a KYC reviewer's fully-burdened hourly cost (salary + benefits + overhead) varies
 * enormously by market and organization. Always surfaced as an editable field in the ROI
 * panel UI, never presented as a measured fact.
 */
export const DEFAULT_LOADED_COST_PER_HOUR_USD = 35;

/** Converts a reviewer-minutes range into a dollar range at a given fully-burdened hourly
 *  rate. Kept as a separate step from `reviewerMinutesAvoided` rather than folded into it:
 *  minutes are backed by the client's own stated throughput figure, dollars are backed by
 *  whatever the viewer's own reviewer cost actually is — two independently editable
 *  assumptions, not one compound one. */
export function minutesToDollars(minutes: MinutesRange, loadedCostPerHourUsd: number): DollarRange {
  const perMinute = loadedCostPerHourUsd / 60;
  return { low: minutes.low * perMinute, high: minutes.high * perMinute };
}
