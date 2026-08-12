/**
 * TB — layout OCR with label matching (§7 TB).
 *
 * Fires when TA found no machine-readable region: no MRZ, no PDF417. That is most of the
 * corpus — insurance cards, residence permits, utility bills, and every DL photographed
 * front-side-only — so this tier carries real weight even though it is the cheap one.
 *
 * This is where the label/regex approach *legitimately* lives. The difference between it
 * and the naive version is not the lexicon, it is what happens around the lexicon:
 *
 *  - a label match is a hypothesis, not an answer: the value has to be a date token that
 *    is spatially where a value belongs (§7 TB's right-of / directly-below rule), within
 *    a bound expressed in multiples of the label's own text height so it survives any
 *    capture resolution;
 *  - two labels pointing at two different dates is an abstention, not a coin flip;
 *  - date parsing is delegated wholesale to `@/engine/dates` — century resolution,
 *    MM/DD-vs-DD/MM ambiguity, month-year and ranges are all decided there, once (§8);
 *  - nothing here ever throws. Abstention is a return value (§5).
 *
 * Three deviations from the brief are deliberate and load-bearing:
 *
 *  **G5 — the grounding token stream.** `grounding_tokens` is populated on *every* return
 *  path, including every abstention. The brief runs OCR only inside TB and fires TC when
 *  TB abstains, which means the flagship anti-injection case (§11.5 #66 — cross-check the
 *  VLM's answer against the raw OCR tokens) would, in the brief as written, have no token
 *  stream to check against precisely when it is needed: TB abstained, so TB produced
 *  nothing. A VLM that returns `2099-01-01` because a sticker on the card told it to is
 *  only catchable if we can show that string never appeared in the page's OCR. So TB's
 *  contract is: it may fail to find an expiry date, but it always reports what it read.
 *
 *  **Low OCR confidence is a finding, not an abstention (§11.4 #56).** A handwritten date
 *  comes back with word confidence in the 30s–50s. Abstaining would hand it to TC, whose
 *  confidence is self-reported and therefore worthless as a stop signal (§4.4); the brief
 *  wants handwriting to land in REVIEW. We return the candidate with its confidence scaled
 *  down and `LOW_TIER_CONFIDENCE` attached, which is what routes it to REVIEW while
 *  keeping the evidence. This is not a "low-confidence guess to keep the pipeline moving"
 *  — the value is grounded in a real label, a real bbox and a real token; what is low is
 *  our certainty about the glyphs, and we say so in machine-readable form.
 *
 *  **The tier is capped below `AUTO_THRESHOLD`.** There is no checksum here. A clean label
 *  match on crisp print is good evidence, not self-validating evidence like a PDF417
 *  decode, so TB alone never clears the auto-pass bar; corroboration from the constraint
 *  engine or a second source has to do that.
 */

import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';

import {
  abstain,
  type BBox,
  type DateRole,
  type ReasonCode,
  type TierCandidate,
  type TierResult,
} from '@/types/contract';
import {
  normalizeFreeTextDate,
  parseDateRange,
  type FreeTextOptions,
  type NormalizedDate,
} from '@/engine/dates';
// TB owes TA-MRZ a line shape it can consume directly (see `reconstructLines`), and reuses
// its MRZ-density heuristic and exact line widths for TC's crop-toward-the-document logic
// below.
import { mrzAlphabetRatio, MRZ_LINE_LENGTHS, type OcrLine } from '@/pipeline/tier-a-mrz';
import {
  FORWARD_LOOKING_QUALIFIERS,
  MAX_LABEL_WORDS,
  hasAamvaFieldCodeLayout,
  isNoExpirySentinel,
  matchLabelPhrase,
  normalizeLabelText,
  type LabelEntry,
} from '@/pipeline/label-lexicon';

// ---------------------------------------------------------------------------
// OCR surface
// ---------------------------------------------------------------------------

/** Axis-aligned box in page pixels, matching Tesseract's own word geometry. */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrToken {
  /** Exactly as the engine read it. Never cleaned — this is the grounding stream (G5). */
  text: string;
  box: OcrBox;
  /** Tesseract's per-word confidence, 0–100. */
  confidence: number;
  /** Global line index in reading order; the spatial rules are line-relative. */
  line: number;
}

export interface OcrPage {
  tokens: OcrToken[];
  width: number;
  height: number;
  /** Mean per-word confidence, 0–100. Null when nothing was read. */
  meanConfidence: number | null;
}

/**
 * Injectable OCR. The default runs Tesseract in-process; tests substitute a fixed page so
 * the spatial and lexicon logic can be exercised without paying for (or depending on the
 * exact glyph output of) a real recognition pass.
 */
export type OcrRunner = (image: Buffer) => Promise<OcrPage>;

// ---------------------------------------------------------------------------
// Tunables — every spatial bound is a multiple of the matched label's text height, so
// the tier behaves identically on a 600 px phone crop and a 4000 px scan (§7 T0.4).
// ---------------------------------------------------------------------------

/** How far right of a label a value may sit. Generous: form layouts pad to a column. */
export const RIGHT_MAX_DX_RATIO = 12;
/** How far below a label a value may sit. Tight: two text lines, no more. */
export const BELOW_MAX_DY_RATIO = 2.5;
/** Lateral slack for a "directly below" value whose box does not overlap the label's. */
export const BELOW_MAX_DX_RATIO = 2;
/** Minimum vertical overlap (as a fraction of the shorter box) to count as "same line". */
const SAME_LINE_MIN_OVERLAP = 0.35;
/**
 * Widest run of OCR words a single date token may span. A numeric range ("01/2026 -
 * 01/2028") needs 5; a spelled-month range ("July 1, 2026 to July 31, 2026") tokenizes as
 * 7 ("July" "1," "2026" "to" "July" "31," "2026") — below that, the range is invisible as a
 * whole and its start alone gets mistaken for a plain date.
 */
const MAX_DATE_WINDOW = 7;
/** Vertical gap, in label heights, still counted as the next line of the same value. */
const LINE_CONTINUATION_MAX_GAP_RATIO = 2;

/** Base confidence for a value found via an English-language printed label. */
export const TEXT_LABEL_BASE_CONFIDENCE = 0.82;
/**
 * Base confidence for an AAMVA printed field code. Higher than the English labels because
 * `4b` means "expiry" on a Texas licence, an Ohio licence and a Quebec licence alike — it
 * is a standard, not a layout choice (§4.1).
 */
export const FIELD_CODE_BASE_CONFIDENCE = 0.88;
/** Ceiling for the whole tier: no checksum, so never deterministic-tier certainty. */
export const TB_MAX_CONFIDENCE = 0.9;
/** Added once when two independent labels agree on the same ISO date. */
export const CORROBORATION_BONUS = 0.04;
/** Below this per-word OCR confidence we treat the read as handwriting-grade (§11.4 #56). */
export const LOW_WORD_CONFIDENCE = 65;
/** Share of letters that must be non-Latin before we declare the script unsupported. */
export const NON_LATIN_SCRIPT_RATIO = 0.3;
/**
 * Too few letters to judge a script from; a stray glyph must not trigger
 * UNSUPPORTED_SCRIPT. Kept deliberately low: CJK writes a whole field in three or four
 * ideographs, so a Latin-sized floor would exempt exactly the scripts we most need to
 * refuse, and the ratio test already stops one stray glyph on a Latin page.
 */
const MIN_LETTERS_FOR_SCRIPT_CALL = 3;

// ---------------------------------------------------------------------------
// Script detection (§7 TB requirement 8 — detect, do not attempt)
// ---------------------------------------------------------------------------

/**
 * Non-Latin letter ranges we can recognise well enough to refuse. Deliberately coded as
 * explicit code-point ranges rather than `\p{Script=...}` escapes: the build targets
 * ES2017, where Unicode property escapes are not available, and an explicit table is
 * testable without guessing what the engine's property data contains.
 */
const NON_LATIN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x052f], // Cyrillic + supplement
  [0x0530, 0x058f], // Armenian
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic supplement
  [0x0900, 0x097f], // Devanagari
  [0x0980, 0x0dff], // Bengali … Sinhala
  [0x0e00, 0x0e7f], // Thai
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // Hangul syllables
];

function isLatinLetter(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x00c0 && code <= 0x024f) // Latin-1 supplement + extended A/B
  );
}

function isNonLatinLetter(code: number): boolean {
  for (const [low, high] of NON_LATIN_RANGES) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

export interface ScriptProfile {
  latin: number;
  nonLatin: number;
  /** Non-Latin share of all recognised letters; 0 when there are no letters at all. */
  ratio: number;
  unsupported: boolean;
}

/**
 * Classify the script of an OCR token stream. We detect and abstain rather than attempt:
 * running an `eng` model over Cyrillic or Han produces confident-looking Latin garbage,
 * and a garbage token stream is worse than none because TC would then be grounded against
 * nonsense (G5).
 */
export function profileScript(tokens: readonly string[]): ScriptProfile {
  let latin = 0;
  let nonLatin = 0;
  for (const token of tokens) {
    for (const character of token) {
      const code = character.codePointAt(0) ?? 0;
      if (isLatinLetter(code)) latin++;
      else if (isNonLatinLetter(code)) nonLatin++;
    }
  }
  const total = latin + nonLatin;
  const ratio = total === 0 ? 0 : nonLatin / total;
  return {
    latin,
    nonLatin,
    ratio,
    unsupported: total >= MIN_LETTERS_FOR_SCRIPT_CALL && ratio >= NON_LATIN_SCRIPT_RATIO,
  };
}

// ---------------------------------------------------------------------------
// Date token detection
// ---------------------------------------------------------------------------

/**
 * Shapes a run of words must take before we hand it to `@/engine/dates`. This is a gate,
 * not a parser: the actual reading — century, field order, last-day-of-month — is decided
 * once, in `dates.ts` (§8). The gate exists because `normalizeFreeTextDate` treats
 * whitespace as a separator, so an unguarded call turns the adjacent, unrelated numbers
 * "07 09" into 2009-07-31. Numeric shapes therefore additionally require a real separator
 * character; only month-name forms may be space-separated.
 */
const NUMERIC_SEPARATOR = String.raw`[/.\-\s]`;
const DATE_SHAPES: ReadonlyArray<{ pattern: RegExp; components: number; numeric: boolean }> = [
  // 03/14/2029, 14-03-29
  { pattern: new RegExp(`^\\d{1,2}${NUMERIC_SEPARATOR}\\d{1,2}${NUMERIC_SEPARATOR}\\d{2,4}$`), components: 3, numeric: true },
  // 2029-03-14
  { pattern: new RegExp(`^\\d{4}${NUMERIC_SEPARATOR}\\d{1,2}${NUMERIC_SEPARATOR}\\d{1,2}$`), components: 3, numeric: true },
  // 20290314 — separator-less, so it cannot be gated on one; `dates.ts` calendar-validates.
  { pattern: /^\d{8}$/, components: 3, numeric: true },
  // 04/2028, 04-28 (§11.4 #54)
  { pattern: new RegExp(`^\\d{1,2}${NUMERIC_SEPARATOR}(?:\\d{2}|\\d{4})$`), components: 2, numeric: true },
  // 15 MAR 2028
  { pattern: /^\d{1,2}[ .\-]+[A-Z]{3,12}[ .\-]+\d{2,4}$/, components: 3, numeric: false },
  // MAR 15 2028
  { pattern: /^[A-Z]{3,12}[ .\-]+\d{1,2}[ .\-]+\d{2,4}$/, components: 3, numeric: false },
  // MARCH 2028
  { pattern: /^[A-Z]{3,12}[ .\-]+\d{2,4}$/, components: 2, numeric: false },
];

/**
 * Range separators, mirrored from `dates.ts` purely to *shape-test* a window before
 * delegating. `parseDateRange` remains the only thing that actually splits and parses.
 */
const RANGE_SPLIT = /\s*(?:–|—|-{1,2}|\bTO\b|\bTHRU\b|\bTHROUGH\b)\s*/i;

/** 0 when the text is not date-shaped, else the number of date components it carries. */
export function dateShapeStrength(text: string): number {
  // Mirrors the comma handling `normalizeFreeTextDate` already does (dates.ts) — "JULY 15,
  // 2026" is the ordinary printed form of a month-name date, and without this the shape
  // gate never lets it reach the parser that already knows what to do with it.
  const upper = text.trim().toUpperCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (upper.length === 0) return 0;
  for (const shape of DATE_SHAPES) {
    if (!shape.pattern.test(upper)) continue;
    // "03 14 2029" (whitespace only) is three numbers on a card, not necessarily a date.
    if (shape.numeric && !/[/.\-]/.test(upper) && !/^\d{8}$/.test(upper)) continue;
    return shape.components;
  }
  return 0;
}

/**
 * True when the window looks like `<date> <separator> <date>` (§8.4, §11.4 #55).
 *
 * Empty split parts are counted, not discarded: "THRU 01/2026-01/2028" splits into
 * `['', '01/2026', '01/2028']`, and dropping the empty leading part would let the *label's
 * own last word* act as the range separator — turning a labelled range into an
 * unlabellable one and abstaining on a document we can read.
 */
export function isRangeShaped(text: string): boolean {
  const parts = text.split(RANGE_SPLIT).map((part) => part.trim());
  return parts.length === 2 && parts.every((part) => dateShapeStrength(part) > 0);
}

/** A range beats any single date when both readings are available — it carries an end. */
const RANGE_STRENGTH = 4;

export type DateTokenKind = 'DATE' | 'RANGE';

export interface DateToken {
  /** The joined OCR text, exactly as read. Feeds `TierCandidate.raw` (`date_raw`). */
  raw: string;
  box: OcrBox;
  /** Lowest per-word OCR confidence across the member words, 0–100. */
  confidence: number;
  kind: DateTokenKind;
  /** 2 for month-year, 3 for a full date, 4 for a range. Used to prefer richer readings. */
  strength: number;
  /** Index of the first member word in the flat token array. */
  startIndex: number;
  wordCount: number;
  line: number;
  /** True when layout split the value across two lines and we reassembled it (§11.4 #57). */
  crossesLine: boolean;
}

function boxHeight(box: OcrBox): number {
  return Math.max(box.y1 - box.y0, 1);
}

/** Shared vertical overlap as a fraction of the shorter box. Negative when disjoint. */
function verticalOverlapRatio(a: OcrBox, b: OcrBox): number {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return overlap / Math.min(boxHeight(a), boxHeight(b));
}

function unionBox(a: OcrBox, b: OcrBox): OcrBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * Join word texts the way they were printed: no space where either side already carries a
 * separator, so a value broken as `03/14/` + `2029` reassembles to `03/14/2029` rather
 * than to `03/14/ 2029`.
 */
export function joinTokenTexts(texts: readonly string[]): string {
  let out = '';
  for (const text of texts) {
    if (out.length === 0) {
      out = text;
      continue;
    }
    const glued = /[/.\-–—]$/.test(out) || /^[/.\-–—]/.test(text);
    out += (glued ? '' : ' ') + text;
  }
  return out;
}

/**
 * True when `next` can continue `current` across a line break: it is the first word of the
 * following line, sits within two text heights vertically, and lines up horizontally with
 * what it continues. This is the bbox-adjacency test behind §11.4 #57 — layout, not
 * language, is what tells us the two fragments are one value.
 */
export function isLineContinuation(current: OcrBox, next: OcrBox): boolean {
  const height = boxHeight(current);
  const verticalGap = next.y0 - current.y1;
  if (verticalGap < -0.5 * height) return false;
  if (verticalGap > LINE_CONTINUATION_MAX_GAP_RATIO * height) return false;
  const overlapsHorizontally = next.x0 <= current.x1 && next.x1 >= current.x0;
  return overlapsHorizontally || Math.abs(next.x0 - current.x0) <= BELOW_MAX_DX_RATIO * height;
}

function isAdjacent(tokens: readonly OcrToken[], index: number, nextIndex: number): boolean {
  const current = tokens[index];
  const next = tokens[nextIndex];
  if (next.line === current.line) return true;
  if (next.line !== current.line + 1) return false;
  // Only a *line-final* word can be continued, and only by a *line-initial* one.
  const currentIsLineFinal = index + 1 >= tokens.length || tokens[index + 1].line !== current.line;
  const nextIsLineInitial = nextIndex === 0 || tokens[nextIndex - 1].line !== next.line;
  return currentIsLineFinal && nextIsLineInitial && isLineContinuation(current.box, next.box);
}

/**
 * Scan the token stream for date-shaped runs, preferring the *richest* reading available
 * at each starting word.
 *
 * The preference matters more than it looks: a value broken as `03/14` + `2029` also
 * parses, on its own, as the month-year "March 2014". Taking the longest well-formed
 * window instead of the first one is what stops layout from silently rewriting a 2029
 * expiry into a 2014 one.
 */
export function findDateTokens(tokens: readonly OcrToken[], opts: FreeTextOptions): DateToken[] {
  const found: DateToken[] = [];
  let index = 0;

  while (index < tokens.length) {
    let best: DateToken | null = null;

    for (let width = 1; width <= MAX_DATE_WINDOW; width++) {
      const end = index + width - 1;
      if (end >= tokens.length) break;
      if (width > 1 && !isAdjacent(tokens, end - 1, end)) break;

      const members = tokens.slice(index, end + 1);
      const raw = joinTokenTexts(members.map((token) => token.text));
      const range = isRangeShaped(raw);
      const strength = range ? RANGE_STRENGTH : dateShapeStrength(raw);
      if (strength === 0) continue;
      // `<` not `<=` (mirrors findLabelMatches above): on an equal score the wider window
      // wins. Without this, a truncated range like "July 1, 2026 to July 31," ties the
      // well-formed 7-word reading at RANGE_STRENGTH and wins by going first, leaving "31,"
      // to be misread as a bare 2-digit year.
      if (best && strength < best.strength) continue;
      // The shape gate passed; `dates.ts` decides whether it is a real date.
      if (!readsAsDate(raw, range, opts)) continue;

      best = {
        raw,
        box: members.map((token) => token.box).reduce(unionBox),
        confidence: Math.min(...members.map((token) => token.confidence)),
        kind: range ? 'RANGE' : 'DATE',
        strength,
        startIndex: index,
        wordCount: width,
        line: members[0].line,
        crossesLine: members.some((token) => token.line !== members[0].line),
      };
    }

    if (best) {
      found.push(best);
      index += best.wordCount;
    } else {
      index += 1;
    }
  }
  return found;
}

function readsAsDate(raw: string, range: boolean, opts: FreeTextOptions): boolean {
  const normalized = normalizeDateToken(raw, range, opts);
  return normalized !== null && (normalized.iso !== null || normalized.ambiguous);
}

/**
 * Resolve a date token to an ISO date for a specific role. Deferred until the token has
 * been bound to a label because the role changes the answer: a two-digit year resolves
 * backwards for a DOB and towards today for an expiry (§8.2).
 *
 * Ranges delegate to `parseDateRange` and take the END — an insurance card's coverage
 * period expires at its end, not its start (§8.4, §11.4 #55).
 */
export function normalizeDateToken(
  raw: string,
  range: boolean,
  opts: FreeTextOptions,
): NormalizedDate | null {
  if (range) {
    const parsed = parseDateRange(raw, opts);
    return parsed?.end ?? null;
  }
  return normalizeFreeTextDate(raw, opts);
}

// ---------------------------------------------------------------------------
// Label detection
// ---------------------------------------------------------------------------

export interface LabelHit {
  entry: LabelEntry;
  /** The matched label exactly as OCR read it — §7 TB requires it recorded verbatim. */
  verbatim: string;
  box: OcrBox;
  /** 1.0 exact, else the fuzzy ratio that cleared `FUZZY_MATCH_THRESHOLD`. */
  score: number;
  confidence: number;
  line: number;
  startIndex: number;
  wordCount: number;
}

/**
 * Find every lexicon label in the token stream, longest-and-strongest first.
 *
 * Matches are non-overlapping: once "EXPIRATION DATE" is taken, "DATE" cannot also match,
 * which is what stops one printed label from being counted as two competing ones.
 */
export function findLabelMatches(tokens: readonly OcrToken[]): LabelHit[] {
  const hits: LabelHit[] = [];
  const hasFieldCodeLayout = hasAamvaFieldCodeLayout(tokens.map((token) => token.text));
  let index = 0;

  while (index < tokens.length) {
    // "Next statement date" contains "STATEMENT DATE" as a clean substring, but it names
    // the *next* statement, not this one — a match starting right after one of these
    // qualifiers is not a hit at all, the same way a label is never allowed to wrap a line.
    if (
      index > 0 &&
      tokens[index - 1].line === tokens[index].line &&
      FORWARD_LOOKING_QUALIFIERS.has(normalizeLabelText(tokens[index - 1].text))
    ) {
      index += 1;
      continue;
    }

    let best: LabelHit | null = null;

    for (let width = 1; width <= MAX_LABEL_WORDS; width++) {
      const end = index + width - 1;
      if (end >= tokens.length) break;
      // A label never wraps a line: a wrapped label is not what §7 TB's spatial rule
      // measures from, and allowing it manufactures matches out of unrelated columns.
      if (tokens[end].line !== tokens[index].line) break;

      const members = tokens.slice(index, end + 1);
      const match = matchLabelPhrase(members.map((token) => token.text).join(' '));
      if (!match) continue;
      // A bare numeric field code (`3`) is only trustworthy on a page that demonstrably
      // uses the AAMVA printed-code layout (§7 TB requirement 3).
      if (match.entry.requiresCorroboration && !hasFieldCodeLayout) continue;
      // `<` not `<=`: on an equal score the wider window wins, so a printed
      // "EXPIRATION DATE" is reported whole rather than as a bare "EXPIRATION".
      if (best && match.score < best.score) continue;

      best = {
        entry: match.entry,
        verbatim: members.map((token) => token.text).join(' '),
        box: members.map((token) => token.box).reduce(unionBox),
        score: match.score,
        confidence: Math.min(...members.map((token) => token.confidence)),
        line: tokens[index].line,
        startIndex: index,
        wordCount: width,
      };
    }

    if (best) {
      hits.push(best);
      index += best.wordCount;
    } else {
      index += 1;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Spatial binding (§7 TB requirement 4)
// ---------------------------------------------------------------------------

export type Relation = 'RIGHT' | 'BELOW';

export interface Placement {
  relation: Relation;
  /** Gap between label and value, in label text heights. */
  distance: number;
  /** The bound that gap had to stay inside, in the same units. */
  bound: number;
}

/**
 * Decide whether `value` sits where a value belongs relative to `label`, and how far away
 * it is. Returns null when it does not — which is an abstention input, not a failure.
 *
 * Both bounds are in label text heights rather than pixels. A pixel bound is a resolution
 * bug waiting to happen: the same card at 600 px and at 3000 px would get different
 * answers, and the 3000 px one — the better capture — would be the one that abstains.
 */
export function placeValue(label: OcrBox, value: OcrBox): Placement | null {
  const height = boxHeight(label);
  const options: Placement[] = [];

  if (
    verticalOverlapRatio(label, value) >= SAME_LINE_MIN_OVERLAP &&
    value.x0 >= label.x1 - 0.25 * height
  ) {
    const distance = Math.max(value.x0 - label.x1, 0) / height;
    if (distance <= RIGHT_MAX_DX_RATIO) {
      options.push({ relation: 'RIGHT', distance, bound: RIGHT_MAX_DX_RATIO });
    }
  }

  const overlapsHorizontally = value.x0 <= label.x1 && value.x1 >= label.x0;
  const alignedLeft = Math.abs(value.x0 - label.x0) <= BELOW_MAX_DX_RATIO * height;
  if (value.y0 >= label.y1 - 0.25 * height && (overlapsHorizontally || alignedLeft)) {
    const distance = Math.max(value.y0 - label.y1, 0) / height;
    if (distance <= BELOW_MAX_DY_RATIO) {
      options.push({ relation: 'BELOW', distance, bound: BELOW_MAX_DY_RATIO });
    }
  }

  if (options.length === 0) return null;
  // Nearest wins; a tie goes to RIGHT, which is the commoner form layout.
  return options.sort(
    (a, b) => a.distance - b.distance || (a.relation === 'RIGHT' ? -1 : 1),
  )[0];
}

interface Binding {
  label: LabelHit;
  token: DateToken;
  placement: Placement;
  normalized: NormalizedDate;
}

/**
 * Extra evidence a bare numeric field code must produce before we believe it (§7 TB
 * requirement 3). `3` is one glyph; it is produced by specks, form numbering and the tail
 * of a truncated word. On a genuine DL front it is printed immediately left of a full
 * date. We therefore demand both the position (to the right, same line) and the format (a
 * complete day-month-year, not a month-year) before letting it into the inventory.
 */
function fieldCodeCorroborated(binding: Binding): boolean {
  if (!binding.label.entry.requiresCorroboration) return true;
  return binding.placement.relation === 'RIGHT' && binding.token.strength >= 3;
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function toNormalizedBBox(box: OcrBox, width: number, height: number): BBox | null {
  if (width <= 0 || height <= 0) return null;
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
  return [clamp(box.x0 / width), clamp(box.y0 / height), clamp(box.x1 / width), clamp(box.y1 / height)];
}

/**
 * G5 — every return path carries the raw token stream, including abstentions. See the
 * module header: TC's injection cross-check (§11.5 #66) has nothing to check against
 * otherwise, and TC only runs when TB abstained.
 */
function groundedAbstention(
  reasons: ReasonCode[],
  tokens: readonly OcrToken[],
  detail: string,
  startedAt: number,
): TierResult {
  return abstain('TB_OCR', reasons, {
    grounding_tokens: tokens.map((token) => token.text),
    checksum_detail: detail,
    duration_ms: Date.now() - startedAt,
  });
}

function candidateConfidence(binding: Binding, corroborated: boolean): number {
  const base =
    binding.label.entry.kind === 'AAMVA_FIELD_CODE'
      ? FIELD_CODE_BASE_CONFIDENCE
      : TEXT_LABEL_BASE_CONFIDENCE;
  // A fuzzy label match is weaker evidence than an exact one, in proportion to how fuzzy.
  const lexicalFactor = binding.label.score;
  const ocrFactor =
    Math.min(binding.label.confidence, binding.token.confidence) / 100;
  // A value pressed up against its label is likelier to belong to it than one at the far
  // end of the admissible window.
  const proximityFactor = 1 - 0.15 * (binding.placement.distance / binding.placement.bound);

  const raw =
    base * lexicalFactor * ocrFactor * proximityFactor + (corroborated ? CORROBORATION_BONUS : 0);
  return Math.min(Math.max(raw, 0), TB_MAX_CONFIDENCE);
}

function toCandidate(
  binding: Binding,
  corroborated: boolean,
  width: number,
  height: number,
): TierCandidate {
  return {
    raw: binding.token.raw,
    iso: binding.normalized.iso,
    role: binding.label.entry.role,
    label_verbatim: binding.label.verbatim,
    snippet: `${binding.label.verbatim} ${binding.token.raw}`,
    // The evidence crop wants the label *and* the value: a bare date crop proves nothing
    // about why we called it an expiry date.
    bbox: toNormalizedBBox(unionBox(binding.label.box, binding.token.box), width, height),
    confidence: candidateConfidence(binding, corroborated),
  };
}

export interface TierBOptions {
  /** 'US' biases MM/DD, 'DMY' biases DD/MM, null leaves ambiguity unresolved (§8.1). */
  issuerConvention?: 'US' | 'DMY' | null;
  /** Injectable clock; century resolution depends on "now" (§8.2), so tests pin it. */
  today?: Date;
}

/**
 * The tier's decision logic, with OCR already done. Pure and synchronous, which is what
 * makes the spatial rules, the abstention rules and G5 testable without a recognition
 * pass — and what lets the same code serve a PDF text layer or a cached OCR result.
 */
/**
 * Roles this tier is allowed to bind a value to as *the sought date*.
 *
 * `EXPIRY` covers identity documents. `STATEMENT_PERIOD_END` covers proof-of-address
 * documents, which §4.3 validates on a RECENCY_WINDOW anchored to the statement or
 * billing date rather than on an expiry — a bank statement has no expiry label, so an
 * expiry-only filter abstains on the entire class and hands it to the VLM for a date
 * that is sitting in plain text next to a fixed label. The constraint engine keeps the
 * roles distinct so expiry-shaped reasoning is never applied to a statement date.
 */
const SOUGHT_DATE_ROLES: ReadonlySet<DateRole> = new Set<DateRole>([
  'EXPIRY',
  'STATEMENT_PERIOD_END',
]);

export function extractFromOcrPage(page: OcrPage, options: TierBOptions = {}): TierResult {
  const startedAt = Date.now();
  const tokens = page.tokens;
  const groundingTokens = tokens.map((token) => token.text);

  if (tokens.length === 0) {
    return groundedAbstention(
      ['NO_DATES_FOUND'],
      tokens,
      'OCR returned no words — the page carries no legible text',
      startedAt,
    );
  }

  const script = profileScript(groundingTokens);
  if (script.unsupported) {
    return groundedAbstention(
      ['UNSUPPORTED_SCRIPT'],
      tokens,
      `${Math.round(script.ratio * 100)}% of recognised letters are non-Latin; ` +
        'detected rather than attempted, since a Latin model over a non-Latin script ' +
        'produces confident nonsense',
      startedAt,
    );
  }

  const dateOptions: FreeTextOptions = {
    issuerConvention: options.issuerConvention ?? null,
    role: 'EXPIRY',
    today: options.today ?? new Date(),
  };

  const dateTokens = findDateTokens(tokens, dateOptions);
  const labels = findLabelMatches(tokens);
  const expiryLabels = labels.filter((label) => SOUGHT_DATE_ROLES.has(label.entry.role));

  if (labels.length === 0) {
    return groundedAbstention(
      dateTokens.length === 0 ? ['NO_DATES_FOUND'] : ['NO_EXPIRY_SEMANTICS'],
      tokens,
      dateTokens.length === 0
        ? 'No lexicon label and no date-shaped token on the page'
        : `${dateTokens.length} date token(s) read but none carries expiry semantics — ` +
          'no lexicon label or AAMVA field code matched',
      startedAt,
    );
  }

  // §11.4 #48 — a label whose value explicitly denies an expiry must not be walked past
  // in search of some other date on the card.
  const declaredNoExpiry = expiryLabels.filter((label) => followedBySentinel(tokens, label));

  const bindings: Binding[] = [];
  const unresolved: LabelHit[] = [];
  for (const label of labels) {
    if (declaredNoExpiry.includes(label)) continue;
    const binding = bindNearestValue(label, dateTokens, dateOptions);
    if (!binding) {
      unresolved.push(label);
      continue;
    }
    if (!fieldCodeCorroborated(binding)) continue;
    bindings.push(binding);
  }

  const expiryBindings = bindings.filter((binding) => SOUGHT_DATE_ROLES.has(binding.label.entry.role));

  // §11.4 #52 — never pick a side on DD/MM vs MM/DD.
  const ambiguous = expiryBindings.find((binding) => binding.normalized.ambiguous);
  if (ambiguous) {
    return groundedAbstention(
      ['AMBIGUOUS_DATE_FORMAT'],
      tokens,
      `"${ambiguous.label.verbatim} ${ambiguous.token.raw}" reads as either ` +
        `${(ambiguous.normalized.alternatives ?? []).join(' or ')} and the issuer ` +
        'convention is unknown',
      startedAt,
    );
  }

  const distinctIsos = [
    ...new Set(
      expiryBindings.map((binding) => binding.normalized.iso).filter((iso): iso is string => !!iso),
    ),
  ];

  if (distinctIsos.length > 1) {
    return groundedAbstention(
      ['MULTIPLE_EXPIRY_CANDIDATES'],
      tokens,
      `${expiryBindings.length} expiry labels disagree: ` +
        expiryBindings
          .map((binding) => `"${binding.label.verbatim}" → ${binding.normalized.iso}`)
          .join('; '),
      startedAt,
    );
  }

  if (distinctIsos.length === 0) {
    return groundedAbstention(
      ['NO_EXPIRY_SEMANTICS'],
      tokens,
      describeNoExpiry(declaredNoExpiry, unresolved, expiryLabels, dateTokens.length),
      startedAt,
    );
  }

  // Two labels naming the same date (e.g. `4b` beside a printed `EXP`) is corroboration,
  // not competition — keep the strongest single reading and record the agreement.
  const corroborated = expiryBindings.length > 1;
  const best = expiryBindings.slice().sort(byBindingQuality)[0];
  const others = bindings.filter((binding) => binding.label.entry.role !== 'EXPIRY');

  const candidates: TierCandidate[] = [
    toCandidate(best, corroborated, page.width, page.height),
    ...dedupeByRole(others).map((binding) =>
      toCandidate(binding, false, page.width, page.height),
    ),
  ];

  const reasonCodes: ReasonCode[] = [];
  // §11.4 #56 — handwriting reads low; keep the evidence, force REVIEW.
  if (Math.min(best.label.confidence, best.token.confidence) < LOW_WORD_CONFIDENCE) {
    reasonCodes.push('LOW_TIER_CONFIDENCE');
  }

  return {
    tier: 'TB_OCR',
    abstained: false,
    candidates,
    reason_codes: reasonCodes,
    anomalies: [],
    checksum_validated: null,
    checksum_detail: buildDetail(best, corroborated, expiryBindings),
    issuer: null,
    grounding_tokens: groundingTokens,
    cost_usd: 0,
    duration_ms: Date.now() - startedAt,
  };
}

/** Better = nearer to its label, then higher OCR confidence, then a stronger label match. */
function byBindingQuality(a: Binding, b: Binding): number {
  return (
    a.placement.distance / a.placement.bound - b.placement.distance / b.placement.bound ||
    b.token.confidence - a.token.confidence ||
    b.label.score - a.label.score
  );
}

/** One candidate per non-expiry role; the constraint engine wants an inventory, not dupes. */
function dedupeByRole(bindings: Binding[]): Binding[] {
  const bestByRole = new Map<DateRole, Binding>();
  for (const binding of bindings.slice().sort(byBindingQuality)) {
    if (!bestByRole.has(binding.label.entry.role)) {
      bestByRole.set(binding.label.entry.role, binding);
    }
  }
  return [...bestByRole.values()];
}

function bindNearestValue(
  label: LabelHit,
  dateTokens: readonly DateToken[],
  dateOptions: FreeTextOptions,
): Binding | null {
  let best: Binding | null = null;
  for (const token of dateTokens) {
    // A label cannot be its own value.
    if (token.startIndex === label.startIndex) continue;
    const placement = placeValue(label.box, token.box);
    if (!placement) continue;

    const normalized = normalizeDateToken(token.raw, token.kind === 'RANGE', {
      ...dateOptions,
      role: label.entry.role,
    });
    if (!normalized || (!normalized.iso && !normalized.ambiguous)) continue;

    const candidate: Binding = { label, token, placement, normalized };
    if (!best || byBindingQuality(candidate, best) < 0) best = candidate;
  }
  return best;
}

/** True when the words immediately after a label spell out "there is no expiry" (#48). */
function followedBySentinel(tokens: readonly OcrToken[], label: LabelHit): boolean {
  const start = label.startIndex + label.wordCount;
  for (let width = 1; width <= 3; width++) {
    const end = start + width;
    if (end > tokens.length) break;
    const window = tokens.slice(start, end);
    if (window.some((token) => token.line !== label.line)) break;
    if (isNoExpirySentinel(window.map((token) => token.text).join(' '))) return true;
  }
  return false;
}

function describeNoExpiry(
  declaredNoExpiry: readonly LabelHit[],
  unresolved: readonly LabelHit[],
  expiryLabels: readonly LabelHit[],
  dateTokenCount: number,
): string {
  if (declaredNoExpiry.length > 0) {
    return `Label "${declaredNoExpiry[0].verbatim}" is followed by an explicit no-expiry value; not substituting another date from the page`;
  }
  if (expiryLabels.length === 0) {
    return 'Labels matched but none of them carries expiry semantics';
  }
  if (unresolved.length > 0) {
    return `Matched ${unresolved.length} expiry label(s) (${unresolved
      .map((label) => `"${label.verbatim}"`)
      .join(', ')}) but no date token sits within the spatial bound (${RIGHT_MAX_DX_RATIO}× text height to the right, ${BELOW_MAX_DY_RATIO}× below); ${dateTokenCount} date token(s) elsewhere on the page`;
  }
  return 'No expiry value could be bound to a matched label';
}

function buildDetail(
  best: Binding,
  corroborated: boolean,
  expiryBindings: readonly Binding[],
): string {
  const where = best.placement.relation === 'RIGHT' ? 'to the right of' : 'directly below';
  const base =
    `Value "${best.token.raw}" read ${where} label "${best.label.verbatim}" ` +
    `(${best.placement.distance.toFixed(1)}× text height)` +
    (best.label.score < 1 ? `, fuzzy label match at ${best.label.score.toFixed(2)}` : '') +
    (best.token.crossesLine ? ', reassembled across two lines by bbox adjacency' : '') +
    (best.token.kind === 'RANGE' ? ', date range — end taken as the expiry' : '');
  return corroborated
    ? `${base}. Corroborated by ${expiryBindings.length} agreeing labels: ` +
        expiryBindings.map((binding) => `"${binding.label.verbatim}"`).join(', ')
    : base;
}

// ---------------------------------------------------------------------------
// In-process OCR (§7 TB requirement 1)
// ---------------------------------------------------------------------------

/**
 * Tesseract caches its ~5 MB language data to disk on first use, defaulting to the process
 * CWD — which on a serverless host is read-only, and in a repo is a stray 5 MB file. Pin it
 * to a temp directory, overridable for a warm-start cache.
 */
const TESSERACT_CACHE_PATH =
  process.env.TESSERACT_CACHE_PATH ?? path.join(os.tmpdir(), 'kyc-expiry-tesseract');

/**
 * One worker for the whole process. Initialisation dominates the cost of this tier
 * (hundreds of ms to load the LSTM model, seconds if the language data must be fetched),
 * while recognition itself is tens of ms — so a per-call worker would make the cheap tier
 * the slow one. Recognition is serialised through `ocrQueue` because a single Tesseract
 * worker processes one image at a time.
 */
let workerPromise: Promise<Worker> | null = null;
let ocrQueue: Promise<unknown> = Promise.resolve();

export async function getOcrWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', undefined, {
      cachePath: TESSERACT_CACHE_PATH,
    }).catch((error) => {
      // Do not cache a failed initialisation — a transient language-data fetch failure
      // would otherwise poison the tier for the life of the process.
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

/** Releases the worker. Call from test teardown and from any long-lived host shutdown. */
export async function terminateOcrWorker(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    await (await pending).terminate();
  } catch {
    // Terminating an already-dead worker is not an error worth propagating.
  }
}

/**
 * Recognise a page and flatten Tesseract's block → paragraph → line → word tree into a
 * reading-order token stream with a global line index, which is the only structure the
 * spatial rules need.
 */
export const runTesseractOcr: OcrRunner = async (image: Buffer): Promise<OcrPage> => {
  const worker = await getOcrWorker();
  const recognize = async () => worker.recognize(image, {}, { blocks: true });
  const run = ocrQueue.then(recognize, recognize);
  ocrQueue = run.then(
    () => undefined,
    () => undefined,
  );
  const result = await run;

  const tokens: OcrToken[] = [];
  let line = 0;
  for (const block of result.data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const textLine of paragraph.lines) {
        for (const word of textLine.words) {
          if (word.text.trim().length === 0) continue;
          tokens.push({
            text: word.text,
            box: { ...word.bbox },
            confidence: word.confidence,
            line,
          });
        }
        line++;
      }
    }
  }

  const metadata = await sharp(image)
    .metadata()
    .catch(() => null);
  const width = metadata?.width ?? tokens.reduce((max, t) => Math.max(max, t.box.x1), 0);
  const height = metadata?.height ?? tokens.reduce((max, t) => Math.max(max, t.box.y1), 0);

  return {
    tokens,
    width,
    height,
    meanConfidence:
      tokens.length === 0
        ? null
        : tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length,
  };
};

/**
 * The OCR pass the tier uses when the caller does not supply one.
 *
 * Exported so the router can run OCR *once* per document and hand the same page to
 * everything that needs it: TA-MRZ's band detection (via `reconstructLines`), TB's label
 * matching, and TC's grounding token stream (G5). Two recognition passes over the same
 * image would double the only meaningful compute cost in the non-VLM path, which is the
 * number the README's tier cost table reports.
 */
export const defaultOcrRunner: OcrRunner = runTesseractOcr;

/** Long edge for the admission gate's presurvey pass — small enough to be cheap, large
 *  enough that MRZ's fixed line-length/alphabet-ratio test and a handful of keyword
 *  characters still read reliably. Not tuned against a resolution floor the way TB's
 *  MIN_EFFECTIVE_DPI is: this pass only ever needs to find *something*, never to read a
 *  field value, so a missed read here just falls through to "no positive signal found"
 *  (§gate asymmetry rule), never to a wrong finding. */
export const PRESURVEY_OCR_LONG_EDGE = 700;

/**
 * A fast, low-resolution OCR pass for the admission gate's Signal 3 (gate.ts) — never a
 * substitute for TB's full-resolution pass, which still runs unconditionally afterward
 * for every document the gate admits. Cheap because it recognizes far fewer pixels, not
 * because it is a second engine: it goes through the same process-wide worker and the
 * same `ocrQueue` serialization as `runTesseractOcr`, just fed a smaller image.
 */
export const presurveyOcrRunner: OcrRunner = async (image: Buffer): Promise<OcrPage> => {
  const small = await sharp(image)
    .resize({
      width: PRESURVEY_OCR_LONG_EDGE,
      height: PRESURVEY_OCR_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toBuffer();
  return runTesseractOcr(small);
};

/**
 * Regroup a token stream into text lines: cluster by vertical overlap, order left to
 * right, and report each line's normalized bbox.
 *
 * TA-MRZ needs *line* structure, not tokens — it identifies the band by finding
 * consecutive lines at exactly 3×30 / 2×36 / 2×44 characters (§4.2). Clustering is done on
 * geometry rather than on the OCR engine's own line index so that any token source (a
 * cached page, a PDF text layer, another engine) can be fed through unchanged.
 *
 * Words are joined with a single space, which is correct for prose and harmless for an
 * MRZ: `sanitizeMrzLine` strips whitespace precisely because OCR splits the fixed-width
 * run into words.
 */
export function reconstructLines(page: OcrPage): OcrLine[] {
  const ordered = [...page.tokens].sort(
    (a, b) => (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2 || a.box.x0 - b.box.x0,
  );

  const rows: Array<{ tokens: OcrToken[]; box: OcrBox }> = [];
  for (const token of ordered) {
    const current = rows[rows.length - 1];
    if (current && verticalOverlapRatio(current.box, token.box) >= SAME_LINE_MIN_OVERLAP) {
      current.tokens.push(token);
      current.box = unionBox(current.box, token.box);
    } else {
      rows.push({ tokens: [token], box: { ...token.box } });
    }
  }

  return rows.map((row) => ({
    text: row.tokens
      .slice()
      .sort((a, b) => a.box.x0 - b.box.x0)
      .map((token) => token.text)
      .join(' '),
    bbox: toNormalizedBBox(row.box, page.width, page.height),
  }));
}

/**
 * A candidate line's length must be one of the three exact ICAO widths, not merely "long
 * enough" — measured directly against real scans: a `>= 20 chars, mostly alphanumeric`
 * bound is not a rare shape. A passport photo page's guilloche security pattern routinely
 * gets OCR'd as dense alphanumeric-looking garbage by an engine not built to ignore it, and
 * a loose length bound matched TEN such false positives spread across an entire real scan,
 * unioning into a crop that was the whole page — a silent no-op with none of the intended
 * effect. Exact-width matching is the same standard `detectMrzBand` itself requires; this
 * function only relaxes the *ratio* bar below, not the width.
 */
const MIN_ZONE_ALPHABET_RATIO = 0.93;
/** How far above the detected band to extend the crop, as a multiple of the page height —
 *  covers a phone-scanned "book spread" where the actual document is the bottom half of a
 *  taller composite image and the band sits at that document's own bottom edge. */
const ZONE_UPWARD_MARGIN_RATIO = 0.55;
/** Small padding below/beside the band itself, so its own text isn't cropped flush. */
const ZONE_PADDING_RATIO = 0.03;

/**
 * Estimate where an identity document's dense, monospace machine-readable band sits on the
 * page, from OCR line positions alone — independent of whether MRZ parsing itself succeeds
 * (`detectMrzBand` needs an exact-width, checksummable band; this only needs a hint).
 *
 * Exists to crop TC's input toward the actual document when the page contains a lot that
 * is not the document: a phone-scanned "book spread" of an open passport routinely photographs
 * a second, unrelated page (a blank visa page, stamps) above the bio-data page in the very
 * same shot, and TC attending to a huge, cluttered composite image reads worse than TC
 * attending to a focused crop of just the part that matters. Returns `null` whenever nothing
 * MRZ-shaped is present — which is every non-identity document class — so this is a no-op
 * everywhere except the one case it exists for.
 */
export function estimateMachineReadableZone(lines: readonly OcrLine[]): BBox | null {
  const candidates = lines.filter((line) => {
    const compact = line.text.replace(/\s/g, '');
    return (
      line.bbox != null &&
      MRZ_LINE_LENGTHS.has(compact.length) &&
      mrzAlphabetRatio(compact) >= MIN_ZONE_ALPHABET_RATIO
    );
  });
  if (candidates.length === 0) return null;

  let [x0, y0, x1, y1] = candidates[0].bbox as BBox;
  for (const line of candidates.slice(1)) {
    const [bx0, by0, bx1, by1] = line.bbox as BBox;
    x0 = Math.min(x0, bx0);
    y0 = Math.min(y0, by0);
    x1 = Math.max(x1, bx1);
    y1 = Math.max(y1, by1);
  }

  return [
    Math.max(0, x0 - ZONE_PADDING_RATIO),
    Math.max(0, y0 - ZONE_UPWARD_MARGIN_RATIO),
    Math.min(1, x1 + ZONE_PADDING_RATIO),
    Math.min(1, y1 + ZONE_PADDING_RATIO),
  ];
}

export interface TierBInput extends TierBOptions {
  /**
   * Page image bytes — `NormalizedPage.fullResolution` from T0. OCR wants the pixels; the
   * downscaled VLM copy loses exactly the small print this tier reads.
   */
  image: Buffer;
  /** Substitute OCR. Present so tests can pin a page without a recognition pass. */
  ocr?: OcrRunner;
}

/**
 * The tier entry point. Runs OCR, then applies §7 TB's label and spatial rules.
 *
 * Never throws (§5): an OCR engine failure abstains like any other dead end. It is the one
 * path that cannot honour G5 — a recognition that failed produced no tokens to ground
 * anything against — so it says so explicitly rather than returning a silent empty stream.
 */
export async function extractTierBOcr(input: TierBInput): Promise<TierResult> {
  const startedAt = Date.now();
  const runOcr = input.ocr ?? runTesseractOcr;

  let page: OcrPage;
  try {
    page = await runOcr(input.image);
  } catch (error) {
    return abstain('TB_OCR', ['MODEL_UNAVAILABLE'], {
      grounding_tokens: [],
      checksum_detail:
        `OCR engine failed, so no grounding token stream exists for this page: ` +
        `${(error as Error).message}`,
      duration_ms: Date.now() - startedAt,
    });
  }

  const result = extractFromOcrPage(page, input);
  return { ...result, duration_ms: Date.now() - startedAt };
}

/** Normalized-bbox helper, exported so the response assembler can reuse the same maths. */
export function normalizeBox(box: OcrBox, width: number, height: number): BBox | null {
  return toNormalizedBBox(box, width, height);
}
