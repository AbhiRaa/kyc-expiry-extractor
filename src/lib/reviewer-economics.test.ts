import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOADED_COST_PER_HOUR_USD,
  minutesPerDocument,
  minutesToDollars,
  reviewerMinutesAvoided,
} from './reviewer-economics';

describe('minutesToDollars', () => {
  it('converts a known minutes range to dollars at the default loaded cost', () => {
    // $35/hour = $0.5833.../minute. 60 minutes -> exactly $35.
    const result = minutesToDollars({ low: 60, high: 120 }, DEFAULT_LOADED_COST_PER_HOUR_USD);
    expect(result.low).toBeCloseTo(35, 5);
    expect(result.high).toBeCloseTo(70, 5);
  });

  it('returns zero dollars for a zero-minute range regardless of rate', () => {
    expect(minutesToDollars({ low: 0, high: 0 }, 100)).toEqual({ low: 0, high: 0 });
  });

  it('scales linearly with a custom loaded-cost rate', () => {
    const result = minutesToDollars({ low: 30, high: 30 }, 60);
    expect(result.low).toBeCloseTo(30, 5);
    expect(result.high).toBeCloseTo(30, 5);
  });

  it('composes with reviewerMinutesAvoided end to end, matching the eval harness figures', () => {
    // The client's own 20-30/day throughput, 4 touches avoided — the exact numbers
    // eval/results.md reports for the admission gate (docs/DECISIONS.md §8).
    const minutes = reviewerMinutesAvoided(4);
    const perDoc = minutesPerDocument({ throughputPerDayLow: 20, throughputPerDayHigh: 30, workdayMinutes: 480 });
    expect(minutes).toEqual({ low: 4 * perDoc.low, high: 4 * perDoc.high });

    const dollars = minutesToDollars(minutes, DEFAULT_LOADED_COST_PER_HOUR_USD);
    expect(dollars.low).toBeGreaterThan(0);
    expect(dollars.high).toBeGreaterThan(dollars.low);
  });
});
