import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  normalizeFreeTextDate,
  parseAamvaDate,
  parseDateRange,
  parseMrzDate,
  resolveTwoDigitYear,
  singleDigitVariants,
} from './dates';

const TODAY = new Date(Date.UTC(2026, 7, 9)); // 2026-08-09

describe('two-digit year resolution (G8 — the brief reintroduces its own trap)', () => {
  it('resolves an EXPIRED passport expiry into the PAST, not the future', () => {
    // §4.2 says "for expiry, always resolve to the future". That is the exact trap
    // §11.4 #50 exists to catch: an expired document's expiry IS in the past.
    // Forcing it forward turns a 2019 passport into a 2119 one and passes it.
    const parsed = parseMrzDate('190315', 'EXPIRY', TODAY);
    expect(parsed.iso).toBe('2019-03-15');
  });

  it('still resolves a valid future expiry forward', () => {
    expect(parseMrzDate('310420', 'EXPIRY', TODAY).iso).toBe('2031-04-20');
  });

  it('never places a date of birth in the future', () => {
    // '95 must be 1995, not 2095.
    expect(resolveTwoDigitYear(95, 'DATE_OF_BIRTH', TODAY)).toBe(1995);
    // '10 is in the past relative to 2026, so the current century is correct.
    expect(resolveTwoDigitYear(10, 'DATE_OF_BIRTH', TODAY)).toBe(2010);
    // '27 would be next year — impossible for a DOB, so it must be 1927.
    expect(resolveTwoDigitYear(27, 'DATE_OF_BIRTH', TODAY)).toBe(1927);
  });

  it('resolves an issue date backwards rather than a century forward', () => {
    expect(parseMrzDate('210101', 'ISSUE', TODAY).iso).toBe('2021-01-01');
  });
});

describe('AAMVA date fields branch on country (§4.1 Canadian caveat)', () => {
  it('reads a US field as MMDDCCYY', () => {
    expect(parseAamvaDate('04232030', 'USA').iso).toBe('2030-04-23');
  });

  it('reads a Canadian field as CCYYMMDD', () => {
    expect(parseAamvaDate('20300423', 'CAN').iso).toBe('2030-04-23');
  });

  it('getting the branch wrong produces a valid-looking wrong date, which is why we test it', () => {
    // The same bytes read under the wrong convention silently yield a different date.
    const asUs = parseAamvaDate('01022030', 'USA').iso; // Jan 2 2030
    const asCan = parseAamvaDate('20300102', 'CAN').iso; // Jan 2 2030
    expect(asUs).toBe('2030-01-02');
    expect(asCan).toBe('2030-01-02');
    // ...but a Canadian card read as US is nonsense rather than a plausible wrong date:
    expect(parseAamvaDate('20300102', 'USA').iso).toBeNull();
  });

  it('rejects a malformed field rather than coercing it', () => {
    expect(parseAamvaDate('0423203', 'USA').iso).toBeNull();
  });
});

describe('MM/DD vs DD/MM (§8.1) — never guess', () => {
  const base = { role: 'EXPIRY' as const, today: TODAY };

  it('self-disambiguates when the day exceeds 12', () => {
    const r = normalizeFreeTextDate('03/25/2028', { ...base, issuerConvention: null });
    expect(r.iso).toBe('2028-03-25');
    expect(r.ambiguous).toBe(false);
  });

  it('self-disambiguates the other way', () => {
    const r = normalizeFreeTextDate('25/03/2028', { ...base, issuerConvention: null });
    expect(r.iso).toBe('2028-03-25');
  });

  it('flags a genuinely ambiguous date with an unknown issuer instead of picking', () => {
    const r = normalizeFreeTextDate('03/04/2028', { ...base, issuerConvention: null });
    expect(r.ambiguous).toBe(true);
    expect(r.iso).toBeNull();
    expect(r.alternatives).toEqual(['2028-03-04', '2028-04-03']);
  });

  it('resolves the same value once the issuer convention is known', () => {
    expect(normalizeFreeTextDate('03/04/2028', { ...base, issuerConvention: 'US' }).iso).toBe(
      '2028-03-04',
    );
    expect(normalizeFreeTextDate('03/04/2028', { ...base, issuerConvention: 'DMY' }).iso).toBe(
      '2028-04-03',
    );
  });
});

describe('month-year only resolves to end of month (§8.5)', () => {
  const opts = { role: 'EXPIRY' as const, today: TODAY, issuerConvention: 'US' as const };

  it('handles a 31-day month', () => {
    const r = normalizeFreeTextDate('01/2028', opts);
    expect(r.iso).toBe('2028-01-31');
    expect(r.rule).toContain('last day of month');
  });

  it('handles February in a leap year', () => {
    expect(normalizeFreeTextDate('02/2028', opts).iso).toBe('2028-02-29');
  });

  it('handles February in a non-leap year', () => {
    expect(normalizeFreeTextDate('02/2027', opts).iso).toBe('2027-02-28');
  });
});

describe('month names map via a table, not a model call (§8.3)', () => {
  const opts = { role: 'EXPIRY' as const, today: TODAY, issuerConvention: null };

  it('parses an English abbreviation', () => {
    expect(normalizeFreeTextDate('15 MAR 2028', opts).iso).toBe('2028-03-15');
  });

  it('parses a full English month in US order', () => {
    expect(normalizeFreeTextDate('MARCH 15 2028', opts).iso).toBe('2028-03-15');
  });

  it('parses a Spanish month', () => {
    expect(normalizeFreeTextDate('15 ENERO 2028', opts).iso).toBe('2028-01-15');
  });

  it('parses a French month', () => {
    expect(normalizeFreeTextDate('15 AVRIL 2028', opts).iso).toBe('2028-04-15');
  });
});

describe('date ranges — the second element is the end (§8.4)', () => {
  const opts = { role: 'COVERAGE_END' as const, today: TODAY, issuerConvention: 'US' as const };

  it('splits an en-dash range and takes end-of-month for each side', () => {
    const r = parseDateRange('01/2026 – 01/2028', opts);
    expect(r?.start?.iso).toBe('2026-01-31');
    expect(r?.end?.iso).toBe('2028-01-31');
  });

  it('splits a "TO" range', () => {
    const r = parseDateRange('03/01/2026 TO 03/01/2028', opts);
    expect(r?.end?.iso).toBe('2028-03-01');
  });

  it('returns null for a non-range so the caller falls through to single-date parsing', () => {
    expect(parseDateRange('03/01/2026', opts)).toBeNull();
  });
});

describe('OCR digit confusion is flagged, never auto-corrected (§8.6)', () => {
  it('enumerates single-digit substitutions for the known confusable pairs', () => {
    const variants = singleDigitVariants('10');
    expect(variants).toContain('70'); // 1→7
    expect(variants).toContain('18'); // 0→8
  });

  it('does not include multi-digit substitutions', () => {
    expect(singleDigitVariants('10')).not.toContain('78');
  });
});

describe('day arithmetic is UTC and end-of-day inclusive', () => {
  it('counts a same-day expiry as zero days remaining, not negative', () => {
    expect(daysBetween('2026-08-09', '2026-08-09')).toBe(0);
  });

  it('counts across a leap day correctly', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});
