/**
 * T0 — classification (§7 T0.6).
 *
 * A cheap, deterministic first pass. Nothing in this file calls a model: §7.6 says the
 * VLM classification pass fires *only if this is inconclusive*, and the whole point of
 * the tiered router (§5) is that the expensive path is the exception. So this module's
 * job is not to be clever, it is to be honest about which of three situations it is in:
 *
 *   1. A machine-readable region decoded, and it names the class outright. An MRZ in
 *      TD3 layout is a passport; a PDF417 carrying AAMVA vehicle-class elements is a
 *      driver's license. These are near-certain and cost nothing.
 *   2. There is enough deterministic text or shape evidence to name a class with
 *      moderate confidence.
 *   3. There is not. Say so — `inconclusive: true` with a short `hypotheses` list —
 *      rather than returning a guess that the confidence fusion will then have to
 *      un-believe. §5's design rule applies to classification exactly as it applies to
 *      extraction: a low-confidence guess emitted to keep the pipeline moving is worse
 *      than an abstention, because it silently narrows what the VLM is asked.
 *
 * Decisions recorded here for the README decision log:
 *
 *   T0-E — an ID-1-shaped card with no decoded barcode and no text is *not* classified
 *          as `US_DRIVERS_LICENSE` on aspect ratio alone. An insurance card, a national
 *          ID, a state ID and a DL front are all 1.586:1, so the shape carries roughly
 *          two bits of information. It returns `OTHER_DOCUMENT` + `inconclusive`, with
 *          the four candidates in `hypotheses` for the VLM pass to choose between.
 *
 *   T0-F — DL vs state ID is decided by AAMVA element presence, not by shape. `DCA`
 *          (jurisdiction-specific vehicle class) is populated on a licence and blank or
 *          `NONE` on a non-driver identification card. That is a real, cheap
 *          discriminator; the aspect ratio is not.
 *
 *   T0-G — `NOT_A_DOCUMENT` is only asserted on *positive* evidence of absence: a text
 *          source actually ran and came back with essentially no characters, and the
 *          image is not merely blurry. Otherwise a soft-focus passport photo would be
 *          classified as a meme, which is the worst possible failure here because §11.3
 *          #43 uses that class to suppress all further spend.
 *
 * Pure and synchronous. No I/O, no global state (§5, §11.6 #75).
 */

import type {
  DocumentClass,
  DocumentSide,
  QualityMetrics,
  ReasonCode,
} from '@/types/contract';
import { BLUR_LAPLACIAN_FLOOR, MIN_EFFECTIVE_DPI } from './normalize';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type MrzFormat = 'TD1' | 'TD2' | 'TD3';

/**
 * Everything the classifier is allowed to look at.
 *
 * The machine-readable fields are supplied by the caller rather than detected here, for
 * two reasons: TA is a separate module owned by a separate track, and §5's ordering
 * means the router already knows whether TA decoded anything by the time classification
 * matters. `null` and `undefined` are deliberately different — `false` means "we probed
 * and there is no barcode", `null`/absent means "nobody looked yet". The first justifies
 * `NO_MACHINE_READABLE_REGION`; the second does not.
 */
export interface ClassificationSignals {
  /** Full-resolution page dimensions, after EXIF orientation (§7.2). */
  width: number;
  height: number;
  sourceFormat?: 'IMAGE' | 'PDF';
  pageCount?: number;
  hasPdf417?: boolean | null;
  hasMrz?: boolean | null;
  mrzFormat?: MrzFormat | null;
  /** MRZ issuing-state field (ISO 3166-1 alpha-3), when TA-MRZ read one. */
  mrzIssuer?: string | null;
  /** Decoded AAMVA payload, or a prefix of it. Used only for element *presence*. */
  barcodeSample?: string | null;
  /** PDF text layer or an OCR sample. `null` means no text source ran at all. */
  textSample?: string | null;
  /**
   * Where `textSample` came from, which decides how much a single keyword hit is worth.
   *
   * `EXACT` is a PDF's embedded text layer: the characters are what the author wrote, so
   * a matched term is certainly on the page. `OCR` is a recognition result, where a
   * matched term might be a misread — "statement period" can fall out of noise in a way
   * it cannot fall out of an embedded font. Defaults to `OCR`, the conservative reading.
   */
  textProvenance?: 'EXACT' | 'OCR';
  quality?: QualityMetrics | null;
  /** Authoritative issuer from TA (AAMVA IIN lookup), when available. */
  issuerHint?: string | null;
}

export interface ClassificationResult {
  class: DocumentClass;
  /** Feeds `document.class_confidence` in the response contract. */
  confidence: number;
  side: DocumentSide;
  issuer: string | null;
  /** True when §7.6's VLM classification pass should run. */
  inconclusive: boolean;
  reasonCodes: ReasonCode[];
  /** The classes still in play when `inconclusive`. Narrows what the VLM is asked. */
  hypotheses: DocumentClass[];
  /** Which signals actually fired, so the "why?" panel can show the reasoning (§10). */
  signalsUsed: string[];
  rationale: string;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** At or above this we do not pay for the VLM classification pass (§7.6). */
export const CLASSIFY_CONCLUSIVE = 0.85;

/** ISO 7810 ID-1 is 85.6 x 54 mm = 1.586:1 — every DL, state ID and most ID cards. */
export const ID1_ASPECT = 85.6 / 54;
export const ID1_ASPECT_TOLERANCE = 0.14;

/**
 * TD3 passport data page, 125 x 88 mm = 1.4205:1.
 *
 * There is no `PASSPORT_PAGE` shape class, and that is deliberate: ISO A4 is 1.4142:1,
 * which is **0.4% away**. No aspect-ratio test can separate a photographed passport
 * data page from a sheet of A4, and pretending otherwise would produce a confidently
 * wrong class on one of the two commonest document families in the eval set. The
 * passport hypothesis is instead carried into `hypotheses` for paper-shaped *single
 * image* uploads, where it is plausible, and dropped for multi-page PDFs, where it is
 * not. An MRZ resolves it for free the moment TA runs (§4.2).
 */
export const PASSPORT_PAGE_ASPECT = 125 / 88;

/** US Letter 1.294:1 through ISO A4 1.414:1 and the passport page just past it. */
export const PAPER_ASPECT_MIN = 1.25;
export const PAPER_ASPECT_MAX = 1.47;

/** The sub-band of `PAPER` where a passport data page is also a live possibility. */
export const PASSPORT_PAGE_BAND: readonly [number, number] = [1.38, 1.47];

/** Below this many alphanumeric characters, a text source that ran found nothing. */
export const BLANK_TEXT_MAX_CHARS = 5;

export type ShapeClass = 'ID1_CARD' | 'PAPER' | 'SQUARE' | 'UNUSUAL';

/**
 * Shape is orientation-free on purpose. §11.3 #29's vertical under-21 licence is the
 * same card rotated 90°, and after §7.2's EXIF pass a portrait card is a genuine
 * portrait capture — either way the ratio of long edge to short edge is what identifies
 * the physical object.
 */
export function shapeClass(width: number, height: number): ShapeClass {
  if (width <= 0 || height <= 0) return 'UNUSUAL';
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (Math.abs(aspect - ID1_ASPECT) <= ID1_ASPECT_TOLERANCE) return 'ID1_CARD';
  if (aspect >= PAPER_ASPECT_MIN && aspect <= PAPER_ASPECT_MAX) return 'PAPER';
  if (aspect < 1.1) return 'SQUARE';
  return 'UNUSUAL';
}

function aspectRatio(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.max(width, height) / Math.min(width, height);
}

// ---------------------------------------------------------------------------
// Keyword lexicons — a table, not a model call
// ---------------------------------------------------------------------------

/**
 * Deliberately biased towards *structural* vocabulary (the words a template forces to
 * appear) over topical vocabulary. "Closing balance" is on every bank statement and
 * almost nothing else; "bank" is on half the documents in the eval set.
 */
const CLASS_KEYWORDS: Array<{ cls: DocumentClass; weight: number; terms: string[] }> = [
  {
    cls: 'BANK_STATEMENT',
    weight: 1,
    terms: [
      'statement period',
      'account statement',
      'account holder',
      'account number',
      'transaction history',
      'statement of account',
      'opening balance',
      'closing balance',
      'available balance',
      'account summary',
      'sort code',
      'routing number',
      'iban',
      'withdrawals',
      'deposits',
    ],
  },
  {
    cls: 'UTILITY_BILL',
    weight: 1,
    terms: [
      'meter reading',
      'utility',
      'bill date',
      'total due',
      'supply address',
      'kwh',
      'tariff',
      'amount due',
      'billing period',
      'council tax',
      'electricity supply',
      'gas supply',
      'water services',
      'service address',
    ],
  },
  {
    cls: 'EMPLOYMENT_LETTER',
    weight: 1,
    terms: [
      'to whom it may concern',
      'confirmation of employment',
      'employment history',
      'letter confirms',
      'employment status',
      'employment verification',
      'is employed',
      'date of joining',
      'annual salary',
      'per annum',
      'human resources',
      'hereby certify',
      'job title',
      'designation',
    ],
  },
  {
    cls: 'MEDICAL_INSURANCE_CARD',
    weight: 1,
    terms: [
      'member id',
      'insurance',
      'coverage',
      'plan name',
      'benefits',
      'group number',
      'rx bin',
      'rx pcn',
      'copay',
      'subscriber',
      'health plan',
      'policy number',
      'coverage period',
      'effective date',
    ],
  },
  { cls: 'PASSPORT', weight: 1.5, terms: ['passport', 'passeport', 'pasaporte', 'reisepass'] },
  {
    // Phrases that are unambiguous on their own — nobody prints "driver license" or the
    // AAMVA DLN field code by accident. One hit here is real evidence, so this group sits
    // at the same weight as PASSPORT / RESIDENCE_PERMIT above.
    cls: 'US_DRIVERS_LICENSE',
    weight: 1.4,
    terms: [
      'driver license',
      "driver's license",
      'driving licence',
      'dl no',
      // AAMVA field code as actually printed ("4d DLN ..."); "dl no" above does not occur
      // on a real AAMVA layout, so without this a clean-OCR US DL never matches on its
      // own field codes at all.
      'dln',
      'department of licensing',
      'department of motor vehicles',
    ],
  },
  {
    // Generic enough to appear in unrelated prose ("the following restrictions apply...").
    // Worth something only in combination with another hit, never alone — kept as a
    // separate, lower-weight group so a single incidental match here can't reach the
    // single-term "strong" threshold the way a group-above term can.
    cls: 'US_DRIVERS_LICENSE',
    weight: 1.2,
    terms: ['endorsements', 'restrictions'],
  },
  {
    cls: 'US_STATE_ID',
    weight: 1.2,
    terms: ['identification card', 'state id', 'non-driver'],
  },
  {
    cls: 'RESIDENCE_PERMIT',
    weight: 1.4,
    terms: [
      'residence permit',
      'titre de sejour',
      'aufenthaltstitel',
      // The generic legal term for the TD1 permit TYPE field ("ART DES TITELS:
      // AUFENTHALTSERLAUBNIS") — distinct from "aufenthaltstitel" above, and printed as
      // the field's own value rather than a label.
      'aufenthaltserlaubnis',
      'permesso di soggiorno',
    ],
  },
  {
    cls: 'NATIONAL_ID_CARD',
    weight: 1.2,
    terms: ['identity card', 'national id', 'carte nationale', 'personalausweis'],
  },
];

/** Full state names only — two-letter codes collide with ordinary words far too often. */
const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The cheap first pass (§7.6). Returns a class, a calibrated-ish confidence, and — the
 * part that matters — whether it believes itself.
 *
 * Ordering is by evidence strength, not by convenience: a decoded machine-readable
 * region beats printed text, printed text beats shape, and shape alone is treated as
 * almost no evidence at all (T0-E). Anything resting on the softer signals is damped by
 * the quality metrics, because §4.4's central finding is that extraction errors are
 * document-caused — a confident class read off a blurry page is exactly the kind of
 * confidently-wrong output the routing layer cannot detect later.
 */
export function classifyDocument(signals: ClassificationSignals): ClassificationResult {
  const signalsUsed: string[] = [];
  const reasonCodes: ReasonCode[] = [];
  const shape = shapeClass(signals.width, signals.height);
  const text = (signals.textSample ?? '').toLowerCase();
  const textRan = signals.textSample !== null && signals.textSample !== undefined;
  const alphanumerics = text.replace(/[^a-z0-9]/g, '').length;

  if (textRan && alphanumerics > 0 && isNonLatinDominant(signals.textSample ?? '')) {
    // §11.3 #40 — detect, do not attempt. Advisory here; the router decides.
    reasonCodes.push('UNSUPPORTED_SCRIPT');
    signalsUsed.push('script:non-latin');
  }

  // -- 1. Machine-readable region: the only near-certain evidence available for free.
  if (signals.hasMrz === true && signals.mrzFormat) {
    signalsUsed.push(`mrz:${signals.mrzFormat}`);
    return fromMrz(signals, signalsUsed, reasonCodes);
  }
  if (signals.hasPdf417 === true) {
    signalsUsed.push('pdf417');
    return fromPdf417(signals, text, signalsUsed, reasonCodes);
  }

  // -- 2. Printed text. Deterministic keyword scoring, never a model call.
  const damping = qualityDamping(signals.quality);
  if (textRan && alphanumerics >= BLANK_TEXT_MAX_CHARS) {
    const scored = scoreKeywords(text);
    if (scored.length > 0) {
      const [best, runnerUp] = scored;
      const margin = best.score - (runnerUp?.score ?? 0);
      signalsUsed.push(`keywords:${best.cls}(${best.score.toFixed(1)})`);
      // A single incidental keyword hit is not a classification. Two matched terms, or
      // one clear winner over the field, is.
      //
      // Exact text earns a lower bar. In an embedded PDF text layer a matched term is
      // certainly present, so one unambiguous term with no competing class is real
      // evidence — "statement period" does not appear by accident in a document that is
      // not a statement. Applying the OCR-grade threshold to exact text made every
      // text-native PDF in the corpus fall through to OTHER_DOCUMENT, which collapsed the
      // basis to UNDETERMINED and sent correctly-extracted dates to review.
      const exact = signals.textProvenance === 'EXACT';
      const strong = exact
        ? best.score >= 2 || (best.score >= 1 && margin >= 1)
        : best.score >= 2 || (best.score >= 1.4 && margin >= 1);
      const confidence = clamp(0.55 + Math.min(0.4, best.score * 0.08) + Math.min(0.1, margin * 0.05)) * damping;
      if (strong && confidence >= 0.6) {
        return {
          class: best.cls,
          confidence: round(confidence),
          side: sideForClass(best.cls, signals),
          issuer: resolveIssuer(signals, text),
          inconclusive: confidence < CLASSIFY_CONCLUSIVE,
          reasonCodes,
          hypotheses: confidence < CLASSIFY_CONCLUSIVE ? scored.slice(0, 3).map((s) => s.cls) : [],
          signalsUsed,
          rationale: `Matched ${best.cls} template vocabulary in the document text.`,
        };
      }
    }
  }

  // -- 3. Positive evidence of absence (T0-G).
  if (
    textRan &&
    alphanumerics < BLANK_TEXT_MAX_CHARS &&
    signals.hasMrz === false &&
    signals.hasPdf417 === false &&
    !isProbablyJustBlurry(signals.quality)
  ) {
    signalsUsed.push('text:empty');
    return {
      class: 'NOT_A_DOCUMENT',
      confidence: round(0.6 * damping),
      side: 'N/A',
      issuer: null,
      inconclusive: true,
      reasonCodes: [...reasonCodes, 'CLASS_UNRECOGNIZED'],
      hypotheses: ['NOT_A_DOCUMENT', 'OTHER_DOCUMENT'],
      signalsUsed,
      rationale: 'A text pass ran and found essentially no characters, and the page is in focus.',
    };
  }

  // -- 4. Shape only. Two bits of information; report it as such (T0-E).
  signalsUsed.push(`shape:${shape}`);
  const probedAndEmpty = signals.hasMrz === false && signals.hasPdf417 === false;
  if (shape === 'ID1_CARD' && probedAndEmpty) {
    // We expected a barcode or an MRZ on a card-shaped document and found neither.
    // That is informative (§11.2 #18, §11.3 #27) even though it is not a class.
    reasonCodes.push('NO_MACHINE_READABLE_REGION');
  }

  const hypotheses = shapeHypotheses(shape, signals);
  return {
    class: 'OTHER_DOCUMENT',
    confidence: round(0.25 * damping),
    side: 'UNKNOWN',
    issuer: resolveIssuer(signals, text),
    inconclusive: true,
    reasonCodes,
    hypotheses,
    signalsUsed,
    rationale:
      shape === 'UNUSUAL' || shape === 'SQUARE'
        ? 'No machine-readable region, no template vocabulary, and no standard document shape.'
        : `Shape is consistent with ${hypotheses.join(', ')}, which aspect ratio alone cannot separate.`,
  };
}

/**
 * Convenience adaptor so the router does not have to unpack a `NormalizedDocument` by
 * hand. Kept separate from `classifyDocument` so the core stays a pure function over a
 * plain signal bag and the tests do not need image fixtures.
 */
export function classifyNormalizedPage(
  page: {
    fullWidth: number;
    fullHeight: number;
    textLayer: string | null;
    quality: QualityMetrics;
  },
  document: { sourceFormat: 'IMAGE' | 'PDF'; pageCount: number },
  detection: Pick<
    ClassificationSignals,
    'hasPdf417' | 'hasMrz' | 'mrzFormat' | 'mrzIssuer' | 'barcodeSample' | 'textSample' | 'issuerHint'
  > = {},
): ClassificationResult {
  return classifyDocument({
    width: page.fullWidth,
    height: page.fullHeight,
    sourceFormat: document.sourceFormat,
    pageCount: document.pageCount,
    quality: page.quality,
    // An explicit `textSample` from OCR wins; otherwise the PDF text layer is the
    // cheapest text source we have (§11.1 #6).
    textSample: detection.textSample ?? page.textLayer,
    ...detection,
  });
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

function fromMrz(
  signals: ClassificationSignals,
  signalsUsed: string[],
  reasonCodes: ReasonCode[],
): ClassificationResult {
  const issuer = signals.mrzIssuer ?? signals.issuerHint ?? null;
  if (signals.mrzFormat === 'TD3') {
    // TD3 is the passport booklet layout and nothing else uses it (§4.2).
    return {
      class: 'PASSPORT',
      confidence: 0.97,
      side: 'FRONT',
      issuer,
      inconclusive: false,
      reasonCodes,
      hypotheses: [],
      signalsUsed,
      rationale: 'A 2x44 TD3 machine-readable zone is the ICAO 9303 passport booklet layout.',
    };
  }
  if (signals.mrzFormat === 'TD1') {
    // TD1 covers both credit-card-sized national IDs and residence permits (§11.3 #35).
    // The layout cannot separate them; the printed side can, so hand it to the VLM.
    return {
      class: 'NATIONAL_ID_CARD',
      confidence: 0.62,
      side: 'FRONT',
      issuer,
      inconclusive: true,
      reasonCodes,
      hypotheses: ['NATIONAL_ID_CARD', 'RESIDENCE_PERMIT'],
      signalsUsed,
      rationale: 'A 3x30 TD1 zone identifies an ICAO-compliant ID card, but not which kind.',
    };
  }
  return {
    class: 'NATIONAL_ID_CARD',
    confidence: 0.6,
    side: 'FRONT',
    issuer,
    inconclusive: true,
    reasonCodes,
    hypotheses: ['NATIONAL_ID_CARD', 'PASSPORT', 'RESIDENCE_PERMIT'],
    signalsUsed,
    rationale: 'A 2x36 TD2 zone is used by a handful of national IDs and older passports.',
  };
}

function fromPdf417(
  signals: ClassificationSignals,
  text: string,
  signalsUsed: string[],
  reasonCodes: ReasonCode[],
): ClassificationResult {
  const issuer = signals.issuerHint ?? resolveIssuer(signals, text);
  const sample = signals.barcodeSample ?? null;

  if (sample) {
    // T0-F. DCA is the jurisdiction-specific vehicle classification: populated on a
    // licence, blank or NONE on a non-driver identification card.
    const dca = /DCA([^\r\n]*)/.exec(sample)?.[1]?.trim() ?? null;
    signalsUsed.push(`aamva:DCA=${dca === null ? 'absent' : dca || 'empty'}`);
    if (dca && dca.toUpperCase() !== 'NONE') {
      return {
        class: 'US_DRIVERS_LICENSE',
        confidence: 0.96,
        side: 'BACK',
        issuer,
        inconclusive: false,
        reasonCodes,
        hypotheses: [],
        signalsUsed,
        rationale: 'AAMVA PDF417 carrying a populated DCA vehicle class — a driver licence.',
      };
    }
    return {
      class: 'US_STATE_ID',
      confidence: 0.9,
      side: 'BACK',
      issuer,
      inconclusive: false,
      reasonCodes,
      hypotheses: [],
      signalsUsed,
      rationale: 'AAMVA PDF417 with no vehicle class — a non-driver identification card.',
    };
  }

  return {
    class: 'US_DRIVERS_LICENSE',
    confidence: 0.75,
    side: 'BACK',
    issuer,
    inconclusive: true,
    reasonCodes,
    hypotheses: ['US_DRIVERS_LICENSE', 'US_STATE_ID'],
    signalsUsed,
    rationale:
      'A PDF417 barcode on a card is an AAMVA DL/ID, but without the decoded payload the two cannot be separated.',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreKeywords(text: string): Array<{ cls: DocumentClass; score: number }> {
  const scores = new Map<DocumentClass, number>();
  // A class may contribute more than one weighted term-group (§ US_DRIVERS_LICENSE above),
  // so scores accumulate rather than overwrite.
  for (const { cls, weight, terms } of CLASS_KEYWORDS) {
    let hits = 0;
    for (const term of terms) if (text.includes(term)) hits++;
    if (hits > 0) scores.set(cls, (scores.get(cls) ?? 0) + hits * weight);
  }
  return [...scores.entries()]
    .map(([cls, score]) => ({ cls, score }))
    .sort((a, b) => b.score - a.score);
}

function shapeHypotheses(shape: ShapeClass, signals: ClassificationSignals): DocumentClass[] {
  switch (shape) {
    case 'ID1_CARD':
      return ['US_DRIVERS_LICENSE', 'US_STATE_ID', 'NATIONAL_ID_CARD', 'MEDICAL_INSURANCE_CARD'];
    case 'PAPER': {
      const multiPage = (signals.pageCount ?? 1) > 1 || signals.sourceFormat === 'PDF';
      if (multiPage) return ['BANK_STATEMENT', 'EMPLOYMENT_LETTER', 'UTILITY_BILL'];
      const aspect = aspectRatio(signals.width, signals.height);
      // A single photograph in the A4/passport overlap band could be either; a PDF of
      // the same ratio is paper, because nobody submits a passport as a text PDF.
      return aspect >= PASSPORT_PAGE_BAND[0] && aspect <= PASSPORT_PAGE_BAND[1]
        ? ['PASSPORT', 'RESIDENCE_PERMIT', 'UTILITY_BILL', 'EMPLOYMENT_LETTER']
        : ['UTILITY_BILL', 'EMPLOYMENT_LETTER', 'BANK_STATEMENT'];
    }
    default:
      return ['OTHER_DOCUMENT', 'NOT_A_DOCUMENT'];
  }
}

function sideForClass(cls: DocumentClass, signals: ClassificationSignals): DocumentSide {
  if (cls === 'BANK_STATEMENT' || cls === 'UTILITY_BILL' || cls === 'EMPLOYMENT_LETTER') return 'N/A';
  if (signals.hasPdf417 === true) return 'BACK';
  if (signals.hasMrz === true) return 'FRONT';
  return 'UNKNOWN';
}

function resolveIssuer(signals: ClassificationSignals, text: string): string | null {
  if (signals.issuerHint) return signals.issuerHint;
  if (signals.mrzIssuer) return signals.mrzIssuer;
  for (const [name, code] of Object.entries(US_STATES)) {
    if (text.includes(name)) return code;
  }
  return null;
}

/**
 * Damps any confidence that rests on reading the page rather than decoding it. §9 puts
 * document quality in the medium weight class; the multiplier is bounded at 0.6 so a
 * poor scan degrades a classification rather than erasing it.
 */
function qualityDamping(quality: QualityMetrics | null | undefined): number {
  if (!quality) return 1;
  let factor = 1;
  if (quality.laplacian_variance !== null && quality.laplacian_variance < BLUR_LAPLACIAN_FLOOR) {
    factor *= 0.8;
  }
  if (quality.effective_dpi !== null && quality.effective_dpi < MIN_EFFECTIVE_DPI) factor *= 0.85;
  if (quality.clipping_ratio !== null && quality.clipping_ratio > 0.15) factor *= 0.9;
  return Math.max(0.6, factor);
}

/** T0-G — an out-of-focus document reads as empty text; that is not evidence of a meme. */
function isProbablyJustBlurry(quality: QualityMetrics | null | undefined): boolean {
  if (!quality || quality.laplacian_variance === null) return true; // unknown ⇒ assume the charitable case
  return quality.laplacian_variance < BLUR_LAPLACIAN_FLOOR;
}

/**
 * §11.3 #40. Counts letters outside Basic Latin / Latin-1 / Latin Extended against
 * those inside it. Cheap and script-agnostic — it fires on Arabic, Cyrillic, CJK,
 * Devanagari and Thai alike without needing a table for any of them.
 */
export function isNonLatinDominant(text: string, threshold = 0.3): boolean {
  let latin = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x0030) continue; // punctuation and whitespace are script-neutral
    if (code <= 0x024f) latin++;
    else if (code >= 0x0370) other++;
  }
  const total = latin + other;
  return total > 0 && other / total >= threshold;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
