/**
 * Cross-source and temporal-integrity tests (§7, §11.4 #59-60, §11.5 #62-65).
 *
 * The property being pinned down here is not "does it compare two strings" — it is that a
 * disagreement is never resolved. A KYC system that quietly prefers the checksummed source
 * over the printed one passes the single most common forgery it was built to catch.
 */

import { describe, expect, it } from 'vitest';

import { AUTO_THRESHOLD, DETERMINISTIC_CONFIDENCE } from '@/types/contract';
import {
  CROSS_SOURCE_AGREEMENT_BONUS,
  MAX_PLAUSIBLE_VALIDITY_YEARS,
  checkTemporalPlausibility,
  crossCheck,
} from '@/pipeline/cross-check';

const TODAY = new Date(Date.UTC(2026, 7, 9)); // 2026-08-09

describe('agreement between a machine-readable and a printed source (§7)', () => {
  it('raises confidence and records what agreed', () => {
    const result = crossCheck({
      machine: { source: 'MRZ', dates: { expiry: '2031-04-15', dob: '1974-08-12' } },
      printed: { dates: { expiry: '2031-04-15', dob: '1974-08-12' } },
      today: TODAY,
    });

    expect(result.anomalies).toEqual([]);
    expect(result.force_review).toBe(false);
    expect(result.confidence).toBeCloseTo(DETERMINISTIC_CONFIDENCE + CROSS_SOURCE_AGREEMENT_BONUS);
    expect(result.cross_source_agreement).toContain('MRZ agrees with the printed values');
    expect(result.cross_source_agreement).toContain('EXPIRY');
    expect(result.comparisons.every((comparison) => comparison.agrees)).toBe(true);
  });

  it('never lets corroboration push confidence past 1', () => {
    const result = crossCheck({
      machine: { source: 'MRZ', dates: { expiry: '2031-04-15' } },
      printed: { dates: { expiry: '2031-04-15' } },
      today: TODAY,
      baseConfidence: 0.999,
    });
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('reports no agreement at all when only one source exists', () => {
    const result = crossCheck({
      machine: { source: 'PDF417', dates: { expiry: '2028-05-20' } },
      printed: null,
      today: TODAY,
    });

    expect(result.cross_source_agreement).toBeNull();
    expect(result.confidence).toBe(DETERMINISTIC_CONFIDENCE);
    expect(result.force_review).toBe(false);
  });

  it('does not treat a field missing from one source as a disagreement', () => {
    const result = crossCheck({
      machine: { source: 'MRZ', dates: { expiry: '2031-04-15' } },
      printed: { dates: { dob: '1974-08-12' } },
      today: TODAY,
    });

    expect(result.comparisons).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(result.confidence).toBe(DETERMINISTIC_CONFIDENCE);
  });
});

describe('disagreement is a tamper signal, not a tie to break (§11.4 #59-60)', () => {
  it('flags MRZ_VIZ_MISMATCH and forces review', () => {
    const result = crossCheck({
      machine: { source: 'MRZ', dates: { expiry: '2019-03-15' } },
      printed: { dates: { expiry: '2031-03-15' } },
      today: TODAY,
    });

    expect(result.anomalies).toEqual(['MRZ_VIZ_MISMATCH']);
    expect(result.reason_codes).toContain('MRZ_VIZ_MISMATCH');
    expect(result.force_review).toBe(true);
    expect(result.confidence).toBeLessThan(AUTO_THRESHOLD);
  });

  it('flags BARCODE_PRINT_MISMATCH for the barcode channel', () => {
    const result = crossCheck({
      machine: { source: 'PDF417', dates: { expiry: '2028-05-20' } },
      printed: { dates: { expiry: '2026-05-20' } },
      today: TODAY,
    });

    expect(result.anomalies).toEqual(['BARCODE_PRINT_MISMATCH']);
    expect(result.force_review).toBe(true);
  });

  it('retains both readings and prefers neither', () => {
    const result = crossCheck({
      machine: { source: 'MRZ', dates: { expiry: '2019-03-15' } },
      printed: { dates: { expiry: '2031-03-15' } },
      today: TODAY,
    });

    const note = result.notes.join(' ');
    expect(note).toContain('2019-03-15');
    expect(note).toContain('2031-03-15');
    expect(note).toContain('neither preferred');
    expect(result.comparisons).toEqual([
      { role: 'EXPIRY', machine: '2019-03-15', printed: '2031-03-15', agrees: false },
    ]);
  });

  it('catches a mismatch on any field, not just the expiry', () => {
    const result = crossCheck({
      machine: { source: 'MRZ', dates: { expiry: '2031-04-15', dob: '1974-08-12' } },
      printed: { dates: { expiry: '2031-04-15', dob: '1984-08-12' } },
      today: TODAY,
    });

    expect(result.anomalies).toEqual(['MRZ_VIZ_MISMATCH']);
    expect(result.cross_source_agreement).toContain('disagrees');
    expect(result.cross_source_agreement).toContain('DATE_OF_BIRTH');
  });
});

describe('temporal plausibility (§11.5 #62-65)', () => {
  it('accepts an ordinary 10-year passport', () => {
    const result = checkTemporalPlausibility(
      { issue: '2021-05-20', expiry: '2031-05-20', dob: '1974-08-12' },
      TODAY,
    );
    expect(result.anomalies).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('#62 expiry before issue', () => {
    const result = checkTemporalPlausibility({ issue: '2028-05-20', expiry: '2021-05-20' }, TODAY);
    expect(result.anomalies).toContain('EXPIRY_BEFORE_ISSUE');
    expect(result.notes.join(' ')).toContain('precedes issue');
  });

  it('#63 validity period beyond the plausibility ceiling', () => {
    const justInside = checkTemporalPlausibility(
      { issue: '2006-05-20', expiry: '2026-05-20' }, // exactly 20 years
      TODAY,
    );
    expect(justInside.anomalies).not.toContain('IMPLAUSIBLE_VALIDITY_PERIOD');

    const justOutside = checkTemporalPlausibility(
      { issue: '2006-05-20', expiry: '2026-06-20' },
      TODAY,
    );
    expect(justOutside.anomalies).toContain('IMPLAUSIBLE_VALIDITY_PERIOD');
    expect(justOutside.notes.join(' ')).toContain(`${MAX_PLAUSIBLE_VALIDITY_YEARS}-year`);
  });

  it('#64 date of birth after expiry', () => {
    const result = checkTemporalPlausibility({ dob: '2030-01-01', expiry: '2026-01-01' }, TODAY);
    expect(result.anomalies).toContain('DOB_AFTER_EXPIRY');
  });

  it('#65 issue date in the future', () => {
    const result = checkTemporalPlausibility({ issue: '2027-01-01', expiry: '2035-01-01' }, TODAY);
    expect(result.anomalies).toContain('FUTURE_DATED_ISSUE');
    expect(result.notes.join(' ')).toContain('2026-08-09');
  });

  it('an issue date of today is not future-dated', () => {
    const result = checkTemporalPlausibility({ issue: '2026-08-09' }, TODAY);
    expect(result.anomalies).toEqual([]);
  });

  it('an expired document is not itself an anomaly — that is a verdict, not a contradiction', () => {
    const result = checkTemporalPlausibility(
      { issue: '2011-03-15', expiry: '2019-03-15', dob: '1974-08-12' },
      TODAY,
    );
    expect(result.anomalies).toEqual([]);
  });

  it('emits a reason code for every anomaly it raises', () => {
    const result = checkTemporalPlausibility(
      { issue: '2028-05-20', expiry: '2021-05-20', dob: '2025-01-01' },
      TODAY,
    );
    expect(result.reason_codes).toEqual(result.anomalies);
    expect(result.anomalies).toEqual(
      expect.arrayContaining(['EXPIRY_BEFORE_ISSUE', 'DOB_AFTER_EXPIRY']),
    );
  });

  it('attributes a contradiction to the source it came from', () => {
    const result = crossCheck({
      machine: { source: 'PDF417', dates: { issue: '2028-05-20', expiry: '2021-05-20' } },
      printed: { dates: { issue: '2018-05-20', expiry: '2021-05-20' } },
      today: TODAY,
    });

    expect(result.anomalies).toContain('EXPIRY_BEFORE_ISSUE');
    expect(result.notes.some((note) => note.startsWith('PDF417:'))).toBe(true);
    expect(result.notes.some((note) => note.startsWith('printed:'))).toBe(false);
    // The issue dates also disagree across sources, which is its own finding.
    expect(result.anomalies).toContain('BARCODE_PRINT_MISMATCH');
    expect(result.force_review).toBe(true);
  });
});
