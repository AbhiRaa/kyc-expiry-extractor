/**
 * Date normalization (§8). Pure functions, no I/O.
 *
 * The governing rule for this whole module: never guess. Where a value is genuinely
 * ambiguous we return an ambiguity marker and let the router send the document to
 * REVIEW. Silent correction is how wrong KYC decisions get made.
 *
 * G8 — the brief's §4.2 century rule says "for expiry, always resolve to the future".
 * That is the brief's own known trap, reintroduced. An expired document's expiry date
 * IS in the past — that is the exact case the system exists to detect (§11.4 #50), and
 * forcing it forward would turn a 2019 passport into a 2119 one and pass it. We resolve
 * a two-digit year to whichever century places the date closest to today within a
 * plausible document window instead, which yields past expiry dates for expired
 * documents and future ones for valid documents.
 */

import type { DateRole } from '@/types/contract';

/** No real identity or financial document has an 80-year validity span. */
const PLAUSIBLE_YEAR_RADIUS = 20;

export interface NormalizedDate {
  /** ISO 8601 YYYY-MM-DD, or null when the value could not be resolved unambiguously. */
  iso: string | null;
  /** Exactly as supplied, always retained so a policy change stays auditable. */
  raw: string;
  /** True when two readings are both defensible (e.g. 03/04/2028 with an unknown issuer). */
  ambiguous: boolean;
  /** Populated when `ambiguous` — the competing interpretations, for the REVIEW payload. */
  alternatives?: string[];
  /** Human-readable statement of the rule used, surfaced in `validity.rule_applied`. */
  rule?: string;
}

// ---------------------------------------------------------------------------
// Month names — a table, not a model call (§8.3)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {};
function registerMonth(n: number, ...names: string[]) {
  for (const name of names) MONTHS[name.toUpperCase()] = n;
}
registerMonth(1, 'JAN', 'JANUARY', 'ENE', 'ENERO', 'JANVIER', 'JANUAR', 'GEN');
registerMonth(2, 'FEB', 'FEBRUARY', 'FEBRERO', 'FEVRIER', 'FÉVRIER', 'FEBRUAR');
registerMonth(3, 'MAR', 'MARCH', 'MARZO', 'MARS', 'MARZ', 'MÄRZ');
registerMonth(4, 'APR', 'APRIL', 'ABR', 'ABRIL', 'AVR', 'AVRIL');
registerMonth(5, 'MAY', 'MAI', 'MAYO', 'MAGGIO');
registerMonth(6, 'JUN', 'JUNE', 'JUNIO', 'JUIN', 'JUNI', 'GIUGNO');
registerMonth(7, 'JUL', 'JULY', 'JULIO', 'JUIL', 'JUILLET', 'JULI', 'LUGLIO');
registerMonth(8, 'AUG', 'AUGUST', 'AGO', 'AGOSTO', 'AOU', 'AOUT', 'AOÛT');
registerMonth(9, 'SEP', 'SEPT', 'SEPTEMBER', 'SEPTIEMBRE', 'SEPTEMBRE');
registerMonth(10, 'OCT', 'OCTOBER', 'OCTUBRE', 'OCTOBRE', 'OKT', 'OKTOBER');
registerMonth(11, 'NOV', 'NOVEMBER', 'NOVIEMBRE', 'NOVEMBRE');
registerMonth(12, 'DEC', 'DECEMBER', 'DIC', 'DICIEMBRE', 'DEC', 'DECEMBRE', 'DEZ', 'DEZEMBER');

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (y < 1900 || y > 2200) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}

export function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parses an ISO date as UTC midnight. Never uses local time — the policy is UTC. */
export function isoToUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function daysBetween(fromIso: string, toIsoStr: string): number {
  const ms = isoToUtc(toIsoStr).getTime() - isoToUtc(fromIso).getTime();
  return Math.round(ms / 86_400_000);
}

export function yearsBetween(fromIso: string, toIsoStr: string): number {
  return daysBetween(fromIso, toIsoStr) / 365.2425;
}

/**
 * Add whole calendar years, clamping to the last valid day of the target month so that
 * 29 Feb + 1 year lands on 28 Feb rather than rolling into March.
 */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const targetYear = y + years;
  return toIso(targetYear, m, Math.min(d, daysInMonth(targetYear, m)));
}

/**
 * True when `laterIso` falls strictly after the Nth calendar anniversary of `earlierIso`.
 *
 * Constraint thresholds must be compared against calendar anniversaries, not against
 * average-length years. Exactly 20 calendar years is 7305 days, which is 20.0004 average
 * years — so a naive `yearsBetween(...) > 20` eliminates every legitimate 20-year
 * document by a rounding artefact. Same trap at the 15-year holder-age floor.
 */
export function exceedsAnniversary(earlierIso: string, laterIso: string, years: number): boolean {
  return daysBetween(addYears(earlierIso, years), laterIso) > 0;
}

/** True when `laterIso` falls before the Nth calendar anniversary of `earlierIso`. */
export function precedesAnniversary(earlierIso: string, laterIso: string, years: number): boolean {
  return daysBetween(addYears(earlierIso, years), laterIso) < 0;
}

// ---------------------------------------------------------------------------
// Two-digit year resolution (§8.2, with the G8 correction)
// ---------------------------------------------------------------------------

/**
 * Resolve a two-digit year to a full year.
 *
 * DOB is anchored differently from every other role: a person born in '95 was born in
 * 1995, and a two-digit DOB year can never be in the future. Everything else (issue,
 * expiry, coverage) resolves to whichever century puts the date nearest today.
 */
export function resolveTwoDigitYear(yy: number, role: DateRole, today: Date): number {
  const currentYear = today.getUTCFullYear();
  const currentCentury = Math.floor(currentYear / 100) * 100;

  if (role === 'DATE_OF_BIRTH') {
    const asCurrent = currentCentury + yy;
    // A DOB cannot be in the future.
    return asCurrent > currentYear ? asCurrent - 100 : asCurrent;
  }

  const candidates = [currentCentury - 100 + yy, currentCentury + yy, currentCentury + 100 + yy];
  let best = candidates[0];
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - currentYear);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Outside the plausible window we have no defensible reading.
  return bestDistance > PLAUSIBLE_YEAR_RADIUS + 60 ? best : best;
}

// ---------------------------------------------------------------------------
// OCR digit confusion (§8.6)
// ---------------------------------------------------------------------------

/** Pairs a general OCR engine routinely confuses. */
export const OCR_CONFUSABLE_DIGITS: Record<string, string[]> = {
  '0': ['8'],
  '8': ['0'],
  '1': ['7'],
  '7': ['1'],
  '5': ['6'],
  '6': ['5'],
  '3': ['9'],
  '9': ['3'],
};

/**
 * Enumerate single-digit substitutions of a numeric string. Used to test whether a
 * candidate that fails a hard constraint would satisfy it under one plausible misread.
 *
 * We deliberately do NOT apply the correction — we flag it and route to review.
 * Silent correction is how wrong KYC decisions get made (§8.6).
 */
export function singleDigitVariants(numeric: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < numeric.length; i++) {
    for (const sub of OCR_CONFUSABLE_DIGITS[numeric[i]] ?? []) {
      out.push(numeric.slice(0, i) + sub + numeric.slice(i + 1));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixed-width machine-readable formats
// ---------------------------------------------------------------------------

/** AAMVA US date field: MMDDCCYY. Canadian jurisdictions use CCYYMMDD — branch on DCG. */
export function parseAamvaDate(value: string, country: 'USA' | 'CAN'): NormalizedDate {
  const digits = value.trim();
  if (!/^\d{8}$/.test(digits)) {
    return { iso: null, raw: value, ambiguous: false, rule: 'AAMVA date field must be 8 digits' };
  }
  const [y, m, d] =
    country === 'CAN'
      ? [+digits.slice(0, 4), +digits.slice(4, 6), +digits.slice(6, 8)]
      : [+digits.slice(4, 8), +digits.slice(0, 2), +digits.slice(2, 4)];

  if (!isValidYmd(y, m, d)) {
    return { iso: null, raw: value, ambiguous: false, rule: 'AAMVA date field not a valid date' };
  }
  return {
    iso: toIso(y, m, d),
    raw: value,
    ambiguous: false,
    rule:
      country === 'CAN'
        ? 'AAMVA date parsed as CCYYMMDD (Canadian jurisdiction, per DCG)'
        : 'AAMVA date parsed as MMDDCCYY (US jurisdiction, per DCG)',
  };
}

/** MRZ date field: YYMMDD (ICAO 9303). */
export function parseMrzDate(value: string, role: DateRole, today: Date): NormalizedDate {
  const digits = value.trim();
  if (!/^\d{6}$/.test(digits)) {
    return { iso: null, raw: value, ambiguous: false, rule: 'MRZ date field must be 6 digits' };
  }
  const yy = +digits.slice(0, 2);
  const m = +digits.slice(2, 4);
  const d = +digits.slice(4, 6);
  const y = resolveTwoDigitYear(yy, role, today);

  if (!isValidYmd(y, m, d)) {
    return { iso: null, raw: value, ambiguous: false, rule: 'MRZ date field not a valid date' };
  }
  return {
    iso: toIso(y, m, d),
    raw: value,
    ambiguous: false,
    rule: `MRZ YYMMDD; century resolved to ${y} (nearest plausible, raw value retained)`,
  };
}

// ---------------------------------------------------------------------------
// Free-text dates (the TB / TC path)
// ---------------------------------------------------------------------------

export interface FreeTextOptions {
  /** 'US' biases MM/DD; 'DMY' biases DD/MM; null means unknown, so ambiguity is unresolvable. */
  issuerConvention: 'US' | 'DMY' | null;
  role: DateRole;
  today: Date;
}

const SEPARATOR = String.raw`[\/\-.\s]`;

/**
 * Normalize a free-text date. Returns `ambiguous: true` rather than picking a side when
 * both readings are defensible — the caller emits AMBIGUOUS_DATE_FORMAT and routes to
 * REVIEW (§8.1).
 */
export function normalizeFreeTextDate(input: string, opts: FreeTextOptions): NormalizedDate {
  const raw = input.trim();
  const text = raw.toUpperCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  // ---- Month-name forms: "15 MAR 2028", "MAR 15 2028", "MARCH 2028" ----
  const named = parseMonthNameForm(text, raw, opts);
  if (named) return named;

  // ---- Numeric YYYY-MM-DD (unambiguous by construction) ----
  const isoMatch = text.match(new RegExp(`^(\\d{4})${SEPARATOR}(\\d{1,2})${SEPARATOR}(\\d{1,2})$`));
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number) as unknown as number[];
    return isValidYmd(y, m, d)
      ? { iso: toIso(y, m, d), raw, ambiguous: false, rule: 'ISO-ordered numeric date (YYYY-MM-DD)' }
      : { iso: null, raw, ambiguous: false, rule: 'Numeric date is not a valid calendar date' };
  }

  // ---- Month-year only: "04/2028", "04-28" (§8.5) ----
  const monthYear = text.match(new RegExp(`^(\\d{1,2})${SEPARATOR}(\\d{2}|\\d{4})$`));
  if (monthYear) {
    const m = +monthYear[1];
    const yToken = monthYear[2];
    const y = yToken.length === 4 ? +yToken : resolveTwoDigitYear(+yToken, opts.role, opts.today);
    if (m >= 1 && m <= 12) {
      const d = daysInMonth(y, m);
      return {
        iso: toIso(y, m, d),
        raw,
        ambiguous: false,
        rule: `Month-year only; resolved to last day of month (${toIso(y, m, d)})`,
      };
    }
  }

  // ---- Three-part numeric: the MM/DD vs DD/MM problem (§8.1) ----
  const triple = text.match(
    new RegExp(`^(\\d{1,2})${SEPARATOR}(\\d{1,2})${SEPARATOR}(\\d{2}|\\d{4})$`),
  );
  if (triple) return resolveNumericTriple(triple, raw, opts);

  // ---- Compact 8-digit, no separators ----
  const compact = text.match(/^(\d{8})$/);
  if (compact) {
    const s = compact[1];
    const asYmd = [+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8)] as const;
    if (isValidYmd(...asYmd)) {
      return {
        iso: toIso(...asYmd),
        raw,
        ambiguous: false,
        rule: 'Compact 8-digit date read as YYYYMMDD',
      };
    }
    return resolveNumericTriple(
      ['', s.slice(0, 2), s.slice(2, 4), s.slice(4, 8)] as unknown as RegExpMatchArray,
      raw,
      opts,
    );
  }

  return { iso: null, raw, ambiguous: false, rule: 'Unrecognized date format' };
}

function parseMonthNameForm(
  text: string,
  raw: string,
  opts: FreeTextOptions,
): NormalizedDate | null {
  const tokens = text.split(new RegExp(SEPARATOR));
  const monthIdx = tokens.findIndex((t) => t in MONTHS);
  if (monthIdx === -1) return null;

  const month = MONTHS[tokens[monthIdx]];
  const numbers = tokens.filter((t, i) => i !== monthIdx && /^\d{1,4}$/.test(t)).map(Number);
  if (numbers.length === 0) return null;

  // A 4-digit token is unambiguously the year; otherwise the larger value is the year.
  let year: number | undefined;
  let day: number | undefined;
  const fourDigit = numbers.find((n) => n >= 1000);
  if (fourDigit !== undefined) {
    year = fourDigit;
    day = numbers.find((n) => n !== fourDigit);
  } else if (numbers.length === 1) {
    // "MARCH 28" — a month-year, not a month-day. Treat as month-year (§8.5).
    year = resolveTwoDigitYear(numbers[0], opts.role, opts.today);
  } else {
    const [a, b] = numbers;
    day = Math.min(a, b);
    year = resolveTwoDigitYear(Math.max(a, b), opts.role, opts.today);
  }

  if (year === undefined) return null;
  if (day === undefined) {
    const d = daysInMonth(year, month);
    return {
      iso: toIso(year, month, d),
      raw,
      ambiguous: false,
      rule: `Month-year only; resolved to last day of month (${toIso(year, month, d)})`,
    };
  }
  if (!isValidYmd(year, month, day)) {
    return { iso: null, raw, ambiguous: false, rule: 'Month-name date is not a valid calendar date' };
  }
  return {
    iso: toIso(year, month, day),
    raw,
    ambiguous: false,
    rule: 'Month-name date; month resolved from name table',
  };
}

function resolveNumericTriple(
  match: RegExpMatchArray,
  raw: string,
  opts: FreeTextOptions,
): NormalizedDate {
  const a = +match[1];
  const b = +match[2];
  const yToken = match[3];
  const year = yToken.length === 4 ? +yToken : resolveTwoDigitYear(+yToken, opts.role, opts.today);

  const mdyValid = isValidYmd(year, a, b); // a=month, b=day
  const dmyValid = isValidYmd(year, b, a); // a=day,   b=month

  if (mdyValid && !dmyValid) {
    return {
      iso: toIso(year, a, b),
      raw,
      ambiguous: false,
      rule: `Self-disambiguating: ${b} > 12 so the format must be MM/DD/YYYY`,
    };
  }
  if (dmyValid && !mdyValid) {
    return {
      iso: toIso(year, b, a),
      raw,
      ambiguous: false,
      rule: `Self-disambiguating: ${a} > 12 so the format must be DD/MM/YYYY`,
    };
  }
  if (!mdyValid && !dmyValid) {
    return { iso: null, raw, ambiguous: false, rule: 'Numeric date is not a valid calendar date' };
  }

  // Both readings are valid calendar dates — genuinely ambiguous unless the issuer tells us.
  if (opts.issuerConvention === 'US') {
    return {
      iso: toIso(year, a, b),
      raw,
      ambiguous: false,
      rule: 'Ambiguous numeric date resolved as MM/DD/YYYY on a US-issuer document',
    };
  }
  if (opts.issuerConvention === 'DMY') {
    return {
      iso: toIso(year, b, a),
      raw,
      ambiguous: false,
      rule: 'Ambiguous numeric date resolved as DD/MM/YYYY on a non-US-issuer document',
    };
  }
  return {
    iso: null,
    raw,
    ambiguous: true,
    alternatives: [toIso(year, a, b), toIso(year, b, a)],
    rule: 'Ambiguous DD/MM vs MM/DD with unknown issuer — routed to review rather than guessed',
  };
}

// ---------------------------------------------------------------------------
// Date ranges (§8.4) — insurance cards use these constantly
// ---------------------------------------------------------------------------

const RANGE_SEPARATOR = /\s*(?:–|—|-{1,2}|\bTO\b|\bTHRU\b|\bTHROUGH\b)\s*/i;

export interface ParsedRange {
  start: NormalizedDate | null;
  end: NormalizedDate | null;
}

/**
 * Split "01/2026 – 01/2028" into its two endpoints. The second element is the end —
 * that is the one that carries expiry semantics.
 */
export function parseDateRange(input: string, opts: FreeTextOptions): ParsedRange | null {
  const parts = input.split(RANGE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;

  const start = normalizeFreeTextDate(parts[0], { ...opts, role: 'COVERAGE_START' });
  const end = normalizeFreeTextDate(parts[1], opts);
  if (!start.iso && !end.iso) return null;
  return { start, end };
}
