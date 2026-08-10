/**
 * TB label lexicon (§7 TB) — the vocabulary half of layout OCR.
 *
 * This is the regex/label approach the interviewer's verbal answer reached for, kept
 * deliberately in the one place where it is actually defensible: a *first* tier that
 * either finds a printed label it knows or says nothing. Everything that makes the naive
 * version wrong — treating a matched label as proof, guessing when two labels disagree,
 * assuming every document even has a label — is handled in `tier-b-ocr.ts`, not here.
 * This module answers exactly one question: "is this run of OCR words a date label, and
 * if so, what does it mean?"
 *
 * Two properties are worth reading the reasoning for:
 *
 *  1. **Fuzzy matching is length-gated.** The spec asks for a ≥ 0.85 ratio so OCR noise
 *     ("EXPIRAT10N") still matches. But a ratio threshold on a short string is a licence
 *     to hallucinate: at three characters, one substitution already scores 0.67, so the
 *     only way "EXP" ever fuzzy-matches is via a two-character string, and every such
 *     match would be noise. We therefore require exact (normalized) equality below
 *     `MIN_FUZZY_LENGTH` and only allow the ratio to do work on the long labels where it
 *     is genuinely earning its keep ("EXPIRATION DATE" survives two OCR errors).
 *
 *  2. **AAMVA field codes are never fuzzy-matched.** `4a`/`4b`/`3` are worth more than the
 *     English labels because they are jurisdiction-independent — every US DL front prints
 *     them, whatever the state's layout (§4.1, §7 TB). That value evaporates if we let a
 *     two-character token match approximately: "4b" against "Ab", "48", "4h" would all
 *     clear any sane ratio. They match exactly or not at all, and the bare numeric ones
 *     additionally require layout corroboration (see `requiresCorroboration`).
 */

import type { DateRole } from '@/types/contract';

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type LabelKind = 'TEXT' | 'AAMVA_FIELD_CODE';

export interface LabelEntry {
  /** Normalized form (see `normalizeLabelText`) — this is what matching compares against. */
  canonical: string;
  /** As written in the spec's lexicon, for documentation and debugging. */
  display: string;
  role: DateRole;
  kind: LabelKind;
  language: 'en' | 'fr' | 'es' | 'any';
  /** Whitespace-separated word count of `canonical`; drives the match window width. */
  wordCount: number;
  /**
   * True for codes that are indistinguishable from ordinary page noise on their own —
   * currently the bare `3`. The caller must corroborate before trusting the match; see
   * `hasAamvaFieldCodeLayout`.
   */
  requiresCorroboration: boolean;
}

/** The lexicon verbatim from §7 TB. `EXP.` normalizes onto `EXP`, so it is not repeated. */
const TEXT_LABELS: ReadonlyArray<{ display: string; language: LabelEntry['language'] }> = [
  { display: 'EXP', language: 'en' },
  { display: 'EXP.', language: 'en' },
  { display: 'EXPIRES', language: 'en' },
  { display: 'EXPIRATION', language: 'en' },
  { display: 'EXPIRATION DATE', language: 'en' },
  { display: 'EXPIRY', language: 'en' },
  { display: 'EXPIRY DATE', language: 'en' },
  { display: 'DATE OF EXPIRY', language: 'en' },
  { display: 'DATE OF EXPIRATION', language: 'en' },
  { display: 'VALID THRU', language: 'en' },
  { display: 'VALID THROUGH', language: 'en' },
  { display: 'VALID UNTIL', language: 'en' },
  { display: 'VALID TO', language: 'en' },
  { display: 'ENDS ON', language: 'en' },
  { display: 'END DATE', language: 'en' },
  // Insurance cards print a benefit/coverage period as a range rather than a labelled
  // single date; the range parser already takes the end and infers day precision from a
  // bare month-year, so recognizing the label is the only piece that was missing.
  { display: 'BENEFIT PERIOD', language: 'en' },
  { display: 'COVERAGE PERIOD', language: 'en' },
  { display: 'GOOD THRU', language: 'en' },
  { display: 'GOOD THROUGH', language: 'en' },
  { display: 'NOT VALID AFTER', language: 'en' },
  { display: 'EXPIRE LE', language: 'fr' },
  { display: 'FECHA DE VENCIMIENTO', language: 'es' },
];

/**
 * Recency anchors (§4.3, §11.3 #37, #38).
 *
 * §7 TB's lexicon is expiry-only, which is correct for identity documents but leaves
 * proof-of-address documents with no deterministic path at all: a bank statement or a
 * utility bill carries no expiry label, so an expiry-only tier abstains on every one of
 * them and pushes them to the VLM. But §4.3 does not validate those on an expiry — it
 * validates them on a RECENCY_WINDOW anchored to the statement or billing date, and
 * §11.3 #37 says outright to "find the statement period end, apply the recency rule".
 *
 * Those labels are as fixed and as jurisdiction-independent as the expiry ones, so they
 * belong in the same deterministic tier. Finding them here keeps a whole document class
 * off the expensive path.
 *
 * The role is `STATEMENT_PERIOD_END` rather than `EXPIRY` on purpose: these dates are not
 * expiries, and mislabelling them would let the constraint engine apply expiry-shaped
 * reasoning (`expiry > issue`, typical-term boosts) to a date that means something else.
 */
const RECENCY_LABELS: ReadonlyArray<{ display: string; language: LabelEntry['language'] }> = [
  { display: 'STATEMENT PERIOD', language: 'en' },
  { display: 'STATEMENT DATE', language: 'en' },
  { display: 'PERIOD ENDING', language: 'en' },
  { display: 'PERIOD END', language: 'en' },
  { display: 'CLOSING DATE', language: 'en' },
  { display: 'BILLING PERIOD', language: 'en' },
  { display: 'BILL DATE', language: 'en' },
  { display: 'INVOICE DATE', language: 'en' },
  { display: 'ISSUED ON', language: 'en' },
  { display: 'DATE OF ISSUE', language: 'en' },
];

/**
 * AAMVA printed field codes on the front of a US DL (§4.1, §7 TB).
 *
 * Every expiry-bearing label here maps to `EXPIRY`; `4a` and `3` are carried because the
 * constraint engine needs the issue date and DOB to run its hard constraints
 * (`EXPIRY_BEFORE_ISSUE`, `DOB_AFTER_EXPIRY`) — a tier that returns only the expiry
 * throws away the evidence that would have caught a bad one.
 */
const FIELD_CODES: ReadonlyArray<{ display: string; role: DateRole }> = [
  { display: '4a', role: 'ISSUE' },
  { display: '4b', role: 'EXPIRY' },
  { display: '3', role: 'DATE_OF_BIRTH' },
];

function entry(
  display: string,
  role: DateRole,
  kind: LabelKind,
  language: LabelEntry['language'],
): LabelEntry {
  const canonical = normalizeLabelText(display);
  return {
    canonical,
    display,
    role,
    kind,
    language,
    wordCount: canonical.split(' ').length,
    // A code made only of digits cannot be told apart from a form number, a street
    // number or a stray speck without corroboration; `4a`/`4b` carry a letter and can.
    requiresCorroboration: kind === 'AAMVA_FIELD_CODE' && /^[0-9]+$/.test(canonical),
  };
}

/** Every entry, de-duplicated by canonical form (`EXP` and `EXP.` collapse to one). */
export const LABEL_LEXICON: ReadonlyArray<LabelEntry> = (() => {
  const byCanonical = new Map<string, LabelEntry>();
  for (const label of TEXT_LABELS) {
    const built = entry(label.display, 'EXPIRY', 'TEXT', label.language);
    if (!byCanonical.has(built.canonical)) byCanonical.set(built.canonical, built);
  }
  for (const label of RECENCY_LABELS) {
    const built = entry(label.display, 'STATEMENT_PERIOD_END', 'TEXT', label.language);
    if (!byCanonical.has(built.canonical)) byCanonical.set(built.canonical, built);
  }
  for (const code of FIELD_CODES) {
    const built = entry(code.display, code.role, 'AAMVA_FIELD_CODE', 'any');
    byCanonical.set(built.canonical, built);
  }
  return [...byCanonical.values()];
})();

/** Widest window of consecutive OCR words a label can span ("FECHA DE VENCIMIENTO"). */
export const MAX_LABEL_WORDS = LABEL_LEXICON.reduce((max, l) => Math.max(max, l.wordCount), 1);

/**
 * Codes distinctive enough to prove the page uses the AAMVA printed-field-code layout.
 * `4d` (customer id) is included because it is printed on essentially every US DL front
 * and, like `4a`/`4b`, cannot be produced by a stray digit.
 */
export const AAMVA_LAYOUT_MARKER_CODES: ReadonlySet<string> = new Set(['4A', '4B', '4D']);

/**
 * Values that appear where a date would and explicitly mean "there is no expiry"
 * (§11.4 #48). TB does not turn these into a verdict — that is the constraint engine's
 * call — it only refuses to walk past them and grab the next date on the card.
 */
export const NO_EXPIRY_SENTINELS: ReadonlySet<string> = new Set([
  'NONE',
  'N A',
  'NA',
  'NIL',
  'INDEFINITE',
  'INDEFINITELY',
  'NON EXPIRING',
  'NONEXPIRING',
  'DOES NOT EXPIRE',
  'NO EXPIRATION',
  'NO EXPIRY',
  'PERMANENT',
  'UNLIMITED',
]);

/**
 * A word immediately before a label that flips its meaning from "this document's own
 * date" to "a future one" — "Next statement date" is a preview of the *next* statement,
 * not this one, but it contains "STATEMENT DATE" as a clean substring and would otherwise
 * match the recency lexicon and disagree with the statement's actual period-end date.
 */
export const FORWARD_LOOKING_QUALIFIERS: ReadonlySet<string> = new Set([
  'NEXT',
  'UPCOMING',
  'FOLLOWING',
]);

// ---------------------------------------------------------------------------
// Normalization and fuzzy matching
// ---------------------------------------------------------------------------

/**
 * Case-folds, strips diacritics and punctuation, and collapses whitespace (§7 TB:
 * "case-insensitive, whitespace-tolerant").
 *
 * Diacritics are stripped rather than preserved because Tesseract's `eng` model — the one
 * we run, since the lexicon's French and Spanish entries are pure ASCII anyway — drops
 * and invents accents freely, so comparing them would only add a failure mode.
 */
export function normalizeLabelText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Classic Levenshtein edit distance, two-row DP. Inputs here are always short. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** 1 − (edit distance / longer length). 1.0 is identical, 0.0 shares nothing. */
export function similarityRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/** §7 TB: "allow OCR noise via fuzzy match at ratio ≥ 0.85". */
export const FUZZY_MATCH_THRESHOLD = 0.85;

/** Below this canonical length a fuzzy match is noise, not tolerance — see the header. */
export const MIN_FUZZY_LENGTH = 5;

export interface LabelMatch {
  entry: LabelEntry;
  /** 1.0 for an exact normalized match, else the similarity ratio that cleared the bar. */
  score: number;
  exact: boolean;
}

/**
 * Match one run of OCR words (already joined with single spaces) against the lexicon.
 *
 * Returns the strongest match, or null. Exact matches always beat fuzzy ones, and among
 * fuzzy matches the higher ratio wins with the longer label breaking ties — so
 * "EXPIRATION DATE" is never reported as the weaker "EXPIRATION".
 */
export function matchLabelPhrase(phrase: string): LabelMatch | null {
  const normalized = normalizeLabelText(phrase);
  if (normalized.length === 0) return null;

  let best: LabelMatch | null = null;
  for (const candidate of LABEL_LEXICON) {
    if (candidate.canonical === normalized) {
      // Exact wins outright; the only competition would be another identical canonical,
      // and the lexicon is de-duplicated by canonical form.
      return { entry: candidate, score: 1, exact: true };
    }
    if (candidate.kind === 'AAMVA_FIELD_CODE') continue;
    if (candidate.canonical.length < MIN_FUZZY_LENGTH) continue;
    // A window that is wildly the wrong length is not OCR noise, it is a different phrase.
    if (Math.abs(candidate.canonical.length - normalized.length) > 3) continue;

    const score = similarityRatio(candidate.canonical, normalized);
    if (score < FUZZY_MATCH_THRESHOLD) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && candidate.canonical.length > best.entry.canonical.length)
    ) {
      best = { entry: candidate, score, exact: false };
    }
  }
  return best;
}

/**
 * True when the page carries at least one alphanumeric AAMVA field code, which is what
 * licenses trusting a bare numeric code such as `3` (§7 TB — "a bare 3 is a common OCR
 * artefact, so require corroboration"). One `4a`/`4b`/`4d` anywhere on the page is strong
 * evidence the document really is a field-code-labelled DL front rather than, say, a
 * utility bill that happens to contain the digit 3.
 */
export function hasAamvaFieldCodeLayout(words: readonly string[]): boolean {
  for (const word of words) {
    if (AAMVA_LAYOUT_MARKER_CODES.has(normalizeLabelText(word))) return true;
  }
  return false;
}

/** §11.4 #48 — the printed value explicitly denies the existence of an expiry date. */
export function isNoExpirySentinel(text: string): boolean {
  return NO_EXPIRY_SENTINELS.has(normalizeLabelText(text));
}
