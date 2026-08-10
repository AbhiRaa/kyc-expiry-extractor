/**
 * TA-MRZ — deterministic extraction from the ICAO 9303 Machine Readable Zone (§4.2, §7).
 *
 * Why this tier exists at all: a passport, a national ID card and a residence permit all
 * carry their expiry date twice — once printed for a human, once in a fixed-offset,
 * check-digited band designed for a 1980s optical reader. The band is the same in every
 * ICAO-compliant country on earth (§11.3 #34), so there is no per-issuer template to
 * maintain and no model to call. Reading it costs nothing and the check digits tell us
 * whether we read it correctly, which is the property no OCR or VLM confidence score has
 * (§4.4). Everything downstream of this tier is a fallback.
 *
 * Three decisions in here are worth reading the reasoning for:
 *
 *  1. A failing check digit is a *finding*, not a parse error (§7, §11.5 #61). We abstain
 *     with CHECKSUM_FAILED and name the digit rather than returning the value at lower
 *     confidence, because the same failure is produced both by a clumsy alteration of a
 *     printed field and by a bad read — and we are not entitled to decide which.
 *  2. We do NOT let the `mrz` package auto-correct O→0 / I→1 on the authoritative parse.
 *     Silent correction is how wrong KYC decisions get made (§8.6). We do run a second,
 *     throwaway autocorrect pass purely to *describe* the failure: if one OCR-confusable
 *     substitution repairs every check digit, that is far more likely a misread than
 *     tampering, and saying so in `checksum_detail` is what makes the REVIEW actionable.
 *  3. `ParseResult.valid` from the `mrz` package is not a checksum verdict. It also goes
 *     false for things like an unrecognised issuing-state code (the ICAO specimen code
 *     `UTO` fails it). We look only at the `*CheckDigit` details.
 */

import { parse as parseMrz } from 'mrz';
import type { Details, ParseResult } from 'mrz';

import {
  DETERMINISTIC_CONFIDENCE,
  abstain,
  type BBox,
  type DateRole,
  type IntegrityAnomaly,
  type ReasonCode,
  type TierCandidate,
  type TierResult,
} from '@/types/contract';
import { parseMrzDate } from '@/engine/dates';
import { checkTemporalPlausibility } from '@/pipeline/cross-check';

// ---------------------------------------------------------------------------
// Character set and check digits (§4.2)
// ---------------------------------------------------------------------------

/**
 * The only characters an MRZ may contain. The band is printed in OCR-B, and a general OCR
 * engine at default settings confuses `0`/`O`, `1`/`I` and the filler `<` with `c` (§4.2).
 * Constraining the alphabet removes the third confusion outright; the check digits catch
 * what is left.
 */
export const MRZ_CHARACTER_SET = /^[A-Z0-9<]+$/;

/** ICAO 9303 weights, applied cyclically from the first character. */
const CHECK_DIGIT_WEIGHTS = [7, 3, 1] as const;

/**
 * Value of a single MRZ character for check-digit purposes: `<` = 0, digits are
 * themselves, A–Z = 10–35 (§4.2). Anything else has no defined value; we return NaN so a
 * corrupt band fails loudly instead of silently scoring 0.
 */
export function mrzCharacterValue(character: string): number {
  if (character === '<') return 0;
  if (character >= '0' && character <= '9') return character.charCodeAt(0) - 48;
  if (character >= 'A' && character <= 'Z') return character.charCodeAt(0) - 55;
  return Number.NaN;
}

/** ICAO 9303 check digit: sum of value × 7-3-1 cycling weight, mod 10. */
export function computeCheckDigit(value: string): string {
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    sum += mrzCharacterValue(value[i]) * CHECK_DIGIT_WEIGHTS[i % 3];
  }
  return Number.isNaN(sum) ? '' : String(sum % 10);
}

// ---------------------------------------------------------------------------
// Band detection (§7)
// ---------------------------------------------------------------------------

/** A line of text as produced by whatever read the page, with an optional normalized box. */
export interface OcrLine {
  text: string;
  bbox?: BBox | null;
}

export type MrzFormat = 'TD1' | 'TD2' | 'TD3';

/** Line length → layout. Line *count* disambiguates nothing here; the lengths are unique. */
const LAYOUTS: ReadonlyArray<{ format: MrzFormat; lineLength: number; lineCount: number }> = [
  { format: 'TD1', lineLength: 30, lineCount: 3 },
  { format: 'TD2', lineLength: 36, lineCount: 2 },
  { format: 'TD3', lineLength: 44, lineCount: 2 },
];

/**
 * The three valid ICAO line widths, exported so a caller that only needs "is this length
 * MRZ-shaped" (the crop-toward-the-document heuristic in tier-b-ocr.ts) can check against
 * exactly what `detectMrzBand` itself requires, rather than a looser standalone bound that
 * can drift from it.
 */
export const MRZ_LINE_LENGTHS: ReadonlySet<number> = new Set(LAYOUTS.map((l) => l.lineLength));

export interface MrzBand {
  format: MrzFormat;
  /** Sanitized, fixed-width lines, ready for fixed-offset parsing. */
  lines: string[];
  /** Indices into the input lines, so callers can map a field back to a crop. */
  sourceIndexes: number[];
  bboxes: (BBox | null)[];
}

export type MrzSource = string | ReadonlyArray<string | OcrLine>;

export interface MrzInput {
  /** Page text, or its lines. Pass bboxes when you have them — they localize the evidence. */
  source: MrzSource;
  /**
   * Fraction of page height above which a line is *unlikely* to be MRZ (§7 — the band sits
   * in the bottom ~20%). Used only to rank competing candidates, never to reject one: a
   * tightly cropped photo of just the band has no page context to be at the bottom of.
   */
  bandTop?: number;
  /** Injectable clock. Century resolution depends on "now" (§8.2), so tests must pin it. */
  today?: Date;
}

function toOcrLines(source: MrzSource): OcrLine[] {
  if (typeof source === 'string') return source.split(/\r?\n/).map((text) => ({ text }));
  return source.map((line) => (typeof line === 'string' ? { text: line } : line));
}

/**
 * Force a line into the MRZ alphabet.
 *
 * Lowercase is meaningful: an MRZ contains no lowercase characters at all, so a lowercase
 * `c` in a band is a misread of the filler `<` rather than a letter (§4.2). Any remaining
 * lowercase is a misread of its own uppercase form. Whitespace is dropped because OCR
 * frequently splits the fixed-width run into words, and `«`/`‹` are the usual renderings
 * of a doubled/single filler.
 */
export function sanitizeMrzLine(raw: string): string {
  return raw
    .replace(/«/g, '<<')
    .replace(/[‹‌]/g, '<')
    .replace(/c/g, '<')
    .toUpperCase()
    .replace(/[^A-Z0-9<]/g, '');
}

/**
 * Share of characters already in the MRZ alphabet — a cheap "is this a band?" score.
 * Exported so TC's image-cropping heuristic (tier-b-ocr.ts) can reuse the same density
 * bar rather than inventing a second one that could silently drift from this one.
 */
export function mrzAlphabetRatio(raw: string): number {
  const compact = raw.replace(/\s/g, '');
  if (compact.length === 0) return 0;
  let inSet = 0;
  for (const character of compact.toUpperCase()) if (/[A-Z0-9<]/.test(character)) inSet++;
  return inSet / compact.length;
}

/**
 * Find the MRZ band.
 *
 * We look for a run of consecutive lines that are all exactly one of the three ICAO widths
 * after sanitization. Near-miss lengths are deliberately *not* padded up: right-padding a
 * 42-character read to 44 with fillers would change the composite check digit's input and
 * manufacture either a false pass or a false tamper signal. A band we cannot read at its
 * exact width is a clean miss that falls through to TB.
 */
export function detectMrzBand(input: MrzInput): MrzBand | null {
  const lines = toOcrLines(input.source);
  const bandTop = input.bandTop ?? 0.7;

  const sanitized = lines.map((line) => ({
    text: sanitizeMrzLine(line.text),
    bbox: line.bbox ?? null,
    ratio: mrzAlphabetRatio(line.text),
  }));

  let best: { band: MrzBand; score: number } | null = null;

  for (const layout of LAYOUTS) {
    for (let start = 0; start + layout.lineCount <= sanitized.length; start++) {
      const window = sanitized.slice(start, start + layout.lineCount);
      const widthsMatch = window.every((line) => line.text.length === layout.lineLength);
      // A real MRZ is mostly its own alphabet before we clean it, and always contains
      // filler. Requiring both keeps a 44-character sentence out of the candidate set.
      const looksLikeMrz =
        widthsMatch &&
        window.every((line) => line.ratio >= 0.8) &&
        window.some((line) => line.text.includes('<'));
      if (!looksLikeMrz) continue;

      // Prefer the lowest band on the page (§7). Absent boxes, later lines win.
      const verticalPosition =
        window[0].bbox?.[1] ?? (sanitized.length > 1 ? start / (sanitized.length - 1) : 1);
      const score = verticalPosition + (verticalPosition >= bandTop ? 1 : 0);

      if (!best || score > best.score) {
        best = {
          score,
          band: {
            format: layout.format,
            lines: window.map((line) => line.text),
            sourceIndexes: window.map((_, offset) => start + offset),
            bboxes: window.map((line) => line.bbox),
          },
        };
      }
    }
  }

  return best?.band ?? null;
}

// ---------------------------------------------------------------------------
// Check-digit verification
// ---------------------------------------------------------------------------

export interface CheckDigitReport {
  field: string;
  label: string;
  /** 1-indexed, as ICAO 9303 numbers positions — so the detail matches the spec table. */
  line: number;
  position: number;
  found: string | null;
  expected: string | null;
  valid: boolean;
}

function coveredData(detail: Details, lines: readonly string[]): string {
  // ranges[0] is the check digit itself; the rest is the data it covers.
  return detail.ranges
    .slice(1)
    .map((range) => lines[range.line]?.slice(range.start, range.end) ?? '')
    .join('');
}

/**
 * Recompute every check digit in the band from the data it covers.
 *
 * We recompute rather than trust the library's boolean so that the failure message can
 * state what the digit *should* have been — "expected 4, found 7" is a claim a reviewer
 * can verify by hand against the document; "invalid" is not.
 */
export function verifyCheckDigits(result: ParseResult, lines: readonly string[]): CheckDigitReport[] {
  return result.details
    .filter((detail) => detail.field?.endsWith('CheckDigit'))
    .map((detail) => {
      const expected = computeCheckDigit(coveredData(detail, lines));
      const found = lines[detail.line]?.[detail.start] ?? null;
      return {
        field: detail.field as string,
        label: detail.label,
        line: detail.line + 1,
        position: detail.start + 1,
        found,
        expected: expected === '' ? null : expected,
        valid: found !== null && found === expected,
      };
    });
}

/**
 * Diagnostic-only second opinion (§8.6). The `mrz` package's autocorrect knows the ICAO
 * position table, so it only substitutes characters that are illegal where they appear —
 * `O` in a numeric field, `0` in an alphabetic one. If that makes every check digit pass,
 * the band was misread, not altered. We never adopt the corrected value; we only say so.
 */
function describeOcrRepair(lines: readonly string[]): string | null {
  try {
    const repaired = parseMrz(lines as string[], { autocorrect: true });
    // Validity is read off the corrected parse, not recomputed from the original lines —
    // recomputing would just reproduce the failure we are trying to explain.
    const stillFailing = repaired.details.some(
      (detail) => detail.field?.endsWith('CheckDigit') && !detail.valid,
    );
    if (stillFailing) return null;
    const corrections = repaired.details
      .flatMap((detail) => detail.autocorrect)
      .map((fix) => `${fix.original}→${fix.corrected} at line ${fix.line + 1} col ${fix.column + 1}`);
    if (corrections.length === 0) return null;
    return (
      `every check digit is satisfied by OCR-confusable substitution(s) ${corrections.join(', ')}, ` +
      'so a misread is more likely than an alteration — flagged, not corrected'
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const DATE_FIELDS: ReadonlyArray<{ field: 'expirationDate' | 'birthDate' | 'issueDate'; role: DateRole }> =
  [
    { field: 'expirationDate', role: 'EXPIRY' },
    { field: 'birthDate', role: 'DATE_OF_BIRTH' },
    // Not in TD1/TD2/TD3, but the same parser covers the French and Swiss layouts that do.
    { field: 'issueDate', role: 'ISSUE' },
  ];

function candidateFor(
  field: string,
  role: DateRole,
  raw: string,
  band: MrzBand,
  today: Date,
): TierCandidate | null {
  const normalized = parseMrzDate(raw, role, today);
  if (!normalized.iso) return null;
  // Line 2 carries every date field in all three layouts, so it is the right crop to show.
  const lineIndex = 1;
  return {
    raw,
    iso: normalized.iso,
    role,
    label_verbatim: `MRZ ${field}`,
    snippet: band.lines[lineIndex] ?? band.lines[0],
    bbox: band.bboxes[lineIndex] ?? null,
    confidence: DETERMINISTIC_CONFIDENCE,
  };
}

/**
 * Read the MRZ band and return the tier's verdict.
 *
 * Never throws: a malformed band is an abstention (NO_MACHINE_READABLE_REGION) so the
 * pipeline falls through to TB rather than 500ing (§5, §11.6 #71).
 */
export function extractMrz(input: MrzInput): TierResult {
  const startedAt = Date.now();
  const today = input.today ?? new Date();

  const band = detectMrzBand(input);
  if (!band) {
    return abstain('TA_MRZ', ['NO_MACHINE_READABLE_REGION'], {
      duration_ms: Date.now() - startedAt,
      checksum_detail: 'No ICAO 9303 band found: no run of lines at 3×30, 2×36 or 2×44 characters',
    });
  }

  let parsed: ParseResult;
  try {
    parsed = parseMrz(band.lines);
  } catch (error) {
    return abstain('TA_MRZ', ['NO_MACHINE_READABLE_REGION'], {
      duration_ms: Date.now() - startedAt,
      grounding_tokens: [...band.lines],
      checksum_detail: `${band.format} band rejected by the ICAO parser: ${(error as Error).message}`,
    });
  }

  const checkDigits = verifyCheckDigits(parsed, band.lines);
  const failed = checkDigits.filter((report) => !report.valid);

  if (failed.length > 0) {
    // §11.5 #61 — name the digit. A reviewer needs to know *which* field was altered.
    const detail = failed
      .map(
        (report) =>
          `${report.label} (${report.field}, line ${report.line} position ${report.position}): ` +
          `found "${report.found ?? '?'}", expected "${report.expected ?? '?'}"`,
      )
      .join('; ');
    const repair = describeOcrRepair(band.lines);
    return abstain('TA_MRZ', ['CHECKSUM_FAILED'], {
      duration_ms: Date.now() - startedAt,
      anomalies: ['CHECKSUM_FAILED'],
      checksum_validated: false,
      checksum_detail: repair ? `${detail} — ${repair}` : detail,
      issuer: parsed.fields.issuingState ?? null,
      grounding_tokens: [...band.lines],
    });
  }

  const candidates: TierCandidate[] = [];
  for (const { field, role } of DATE_FIELDS) {
    const raw = parsed.fields[field];
    if (!raw) continue;
    const candidate = candidateFor(field, role, raw, band, today);
    if (candidate) candidates.push(candidate);
  }

  const expiry = candidates.find((candidate) => candidate.role === 'EXPIRY');
  if (!expiry) {
    // Every check digit passed but the expiry is not a calendar date. That is a real
    // finding about the document, not a reason to invent a value.
    return abstain('TA_MRZ', ['NO_DATES_FOUND'], {
      duration_ms: Date.now() - startedAt,
      checksum_validated: true,
      checksum_detail: `${band.format} check digits all valid, but expiration date "${
        parsed.fields.expirationDate ?? ''
      }" is not a valid YYMMDD date`,
      issuer: parsed.fields.issuingState ?? null,
      grounding_tokens: [...band.lines],
    });
  }

  // A single-source integrity sweep (§11.5 #62-65). These do not invalidate the read —
  // the digits are exactly what the document says — they force REVIEW downstream.
  const plausibility = checkTemporalPlausibility(
    {
      expiry: expiry.iso,
      dob: candidates.find((candidate) => candidate.role === 'DATE_OF_BIRTH')?.iso ?? null,
      issue: candidates.find((candidate) => candidate.role === 'ISSUE')?.iso ?? null,
    },
    today,
    band.format,
  );

  const anomalies: IntegrityAnomaly[] = plausibility.anomalies;
  const reasonCodes: ReasonCode[] = plausibility.reason_codes;

  const digitSummary = `${band.format}: all ${checkDigits.length} check digits valid (${checkDigits
    .map((report) => report.field.replace(/CheckDigit$/, ''))
    .join(', ')})`;

  return {
    tier: 'TA_MRZ',
    abstained: false,
    candidates,
    reason_codes: reasonCodes,
    anomalies,
    checksum_validated: true,
    checksum_detail: plausibility.notes.length
      ? `${digitSummary}. ${plausibility.notes.join('; ')}`
      : digitSummary,
    issuer: parsed.fields.issuingState ?? null,
    grounding_tokens: [...band.lines],
    cost_usd: 0,
    duration_ms: Date.now() - startedAt,
  };
}
