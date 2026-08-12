/**
 * Stage -1 — the admission gate (v2 client rework, docs/DECISIONS.md §8).
 *
 * Runs before any extraction tier, on pixel statistics and (at most) one cheap OCR
 * presurvey — never the full pipeline. The client's own framing: a chatbot with no input
 * gating burns tokens answering off-topic prompts; this system had the same shape of gap
 * — a CRM screenshot or a wallpaper flowed through normalization, MRZ, PDF417 and OCR
 * before landing in REVIEW, paying tier cost on noise that was never going to resolve.
 *
 * Three-way, not binary — the gate authorizes budget, not just entry:
 *
 *   REJECT        confidently out of domain. No tier runs. Terminal (Decision.REJECTED).
 *   ADMIT_LIMITED uncertain. Free tiers only — hard-blocked from ever reaching TC,
 *                 regardless of what TA/TB return.
 *   ADMIT_FULL    positive domain signal found. Full pipeline eligible.
 *
 * A2 — the asymmetry rule, the one design decision everything else here serves:
 * false-rejecting a valid document is worse than wasting an OCR pass, or even a VLM
 * call. So REJECT can ONLY be reached through confident NEGATIVE evidence (signals 1
 * and 2 below). It can never be reached merely through absence of positive evidence —
 * that caps admission at ADMIT_LIMITED, never lower. A signal that found nothing is not
 * a signal that found something wrong.
 *
 * A3 — three signals, cheapest first, stopping at the first confident rejection:
 *
 *   1. Document-likeness   — pixel statistics only, no OCR.
 *   2. Screen-capture       — metadata + edge-band statistics, still no OCR.
 *   3. Positive domain signal — the only one that costs anything: a coarse barcode
 *      check, then (only if needed) a single cheap low-resolution OCR pass.
 */

import {
  type AdmissionDecision,
  type AdmissionInfo,
  type DocumentClass,
  type GateSignalOutcome,
} from '@/types/contract';
import { CLASS_KEYWORDS, shapeClass } from './classify';
import { type DocumentQuad, grayscaleWorkRaster, luminanceStats } from './normalize';
import { type BarcodeImage, decodePdf417 } from './tier-a-pdf417';
import {
  type OcrRunner,
  estimateMachineReadableZone,
  presurveyOcrRunner,
  reconstructLines,
} from './tier-b-ocr';
import { ESTIMATED_DUAL_CALL_COST_USD } from './tier-c-vlm';

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface GateInput {
  fullResolution: Buffer;
  fullWidth: number;
  fullHeight: number;
  /** Same buffer TC would receive — reused here for the barcode presurvey and as the
   *  presurvey-OCR source, so the gate does not pay for a resize the pipeline already did. */
  downscaled: Buffer;
  /** From `NormalizedPage.quad` (normalize.ts) — the quad detection T0 already ran once
   *  per page, reused rather than recomputed. */
  quad: DocumentQuad | null;
  perspectiveCorrected: boolean;
  exifBytesLength: number | null;
  textLayer: string | null;
  /** Injectable for tests; defaults to the real low-resolution presurvey runner. */
  ocr?: OcrRunner;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runAdmissionGate(input: GateInput): Promise<AdmissionInfo> {
  const work = await grayscaleWorkRaster(input.fullResolution);

  const s1 = evaluateDocumentLikeness(work, input.quad, input.perspectiveCorrected);
  if (s1.outcome === 'CONFIDENT_NEGATIVE') return buildResult('REJECT', [s1]);

  const s2 = evaluateScreenCapture(work, input.fullWidth, input.fullHeight, input.exifBytesLength);
  if (s2.outcome === 'CONFIDENT_NEGATIVE') return buildResult('REJECT', [s1, s2]);

  const s3 = await evaluatePositiveDomainSignal(input);
  if (s3.outcome === 'CONFIDENT_POSITIVE') return buildResult('ADMIT_FULL', [s1, s2, s3]);
  return buildResult('ADMIT_LIMITED', [s1, s2, s3]);
}

function buildResult(decision: AdmissionDecision, signals: GateSignalOutcome[]): AdmissionInfo {
  return {
    decision,
    signals,
    // REJECT: nothing ran, so this is necessarily a flat upper-bound estimate, not a
    // measurement. ADMIT_LIMITED: zero by default — the router (router.ts) overwrites
    // this only if it actually reaches the point it would have escalated to TC; only it
    // knows that, and reporting the flat cost on every ADMIT_LIMITED doc — including ones
    // TA/TB resolve deterministically, where nothing was ever going to cost money — would
    // overstate savings (the same overclaiming G4 already warns against). ADMIT_FULL:
    // nothing was avoided.
    spend_avoided_usd:
      decision === 'REJECT' ? ESTIMATED_DUAL_CALL_COST_USD : decision === 'ADMIT_LIMITED' ? 0 : null,
  };
}

// ---------------------------------------------------------------------------
// Signal 1 — document-likeness. Pixel statistics only, no OCR.
//
// Confident reject only if ALL of: no document-shaped quad, no structured text-row
// bands, AND the frame is flat or tonally extreme. Any one weak signal alone is not
// enough — a real document at a bad angle should fall through uncertain, not get
// rejected.
// ---------------------------------------------------------------------------

/** Below this stddev the frame has essentially no tonal variation at all — the same
 *  "featureless" idea `estimateSkewAngle` already uses (its own floor is stricter, 2,
 *  because it only needs to bail out of a doomed alignment search; this one gates a
 *  REJECT, so it stays looser on purpose). */
export const FLAT_STDDEV_FLOOR = 10;
export const INK_FRACTION_MIN = 0.02;
export const INK_FRACTION_MAX = 0.98;
/** A real document's printed fields — even a single ID card front — produce several
 *  distinct text-like row bands (name, DOB, address...). Below this, there is no
 *  structure to speak of. */
export const MIN_TEXT_BAND_COUNT = 2;
export const ROW_BAND_DENSITY_LOW = 0.03;
export const ROW_BAND_DENSITY_HIGH = 0.6;

/** Fraction of "ink" pixels (darker than mean − 0.5·stddev) in each row. At row-wise
 *  resolution this is literally the degree-0 slice of `estimateSkewAngle`'s own internal
 *  binning (normalize.ts) — pulled out here as a standalone, reusable measurement rather
 *  than staying buried in that function's private closure. */
export function rowInkHistogram(gray: Uint8Array, width: number, height: number): Float64Array {
  const { mean, stddev } = luminanceStats(gray);
  const threshold = mean - 0.5 * stddev;
  const rows = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let ink = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (gray[rowStart + x] < threshold) ink++;
    }
    rows[y] = width === 0 ? 0 : ink / width;
  }
  return rows;
}

/** Counts contiguous runs of rows whose ink density sits in the "text line" band — not
 *  blank (too low) and not a solid block/photo (too high). A wallpaper or a photo of a
 *  blank wall has zero or one such run; any real printed document has several. */
export function countTextBands(rows: Float64Array): number {
  let bands = 0;
  let inBand = false;
  for (const density of rows) {
    const isBand = density > ROW_BAND_DENSITY_LOW && density < ROW_BAND_DENSITY_HIGH;
    if (isBand && !inBand) bands++;
    inBand = isBand;
  }
  return bands;
}

export function evaluateDocumentLikeness(
  work: { gray: Uint8Array; width: number; height: number },
  quad: DocumentQuad | null,
  perspectiveCorrected: boolean,
): GateSignalOutcome {
  // perspectiveCorrected implies a quad WAS found and consumed by correction — stronger
  // evidence than a merely-detected one, not weaker.
  const hasQuad = quad !== null || perspectiveCorrected;
  const rows = rowInkHistogram(work.gray, work.width, work.height);
  const bandCount = countTextBands(rows);
  const { stddev } = luminanceStats(work.gray);
  const inkFraction = rows.length === 0 ? 0 : rows.reduce((s, v) => s + v, 0) / rows.length;

  const noStructure = bandCount < MIN_TEXT_BAND_COUNT;
  const flatOrExtreme =
    stddev < FLAT_STDDEV_FLOOR || inkFraction < INK_FRACTION_MIN || inkFraction > INK_FRACTION_MAX;

  const evidence = [
    `quad=${hasQuad ? 'present' : 'null'}`,
    `bandCount=${bandCount}`,
    `stddev=${stddev.toFixed(1)}`,
    `inkFraction=${inkFraction.toFixed(3)}`,
    `shape=${shapeClass(work.width, work.height)}`,
  ];

  if (!hasQuad && noStructure && flatOrExtreme) {
    return {
      signal: 'DOCUMENT_LIKENESS',
      outcome: 'CONFIDENT_NEGATIVE',
      detail:
        'No document-shaped quad, no structured text-row bands, and the frame is flat or tonally extreme',
      evidence,
    };
  }
  return {
    signal: 'DOCUMENT_LIKENESS',
    outcome: 'UNCERTAIN',
    detail: 'At least one document-likeness indicator is present',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Signal 2 — screen-capture detection. Still no OCR.
//
// The nuance: a CRM screenshot PASSES signal 1 — it is genuinely text-dense in
// structured rows. The tell is the CONJUNCTION of screen-native evidence (resolution
// match, or absent camera EXIF) AND genuine application-chrome structure — never
// "is this a screenshot" alone, because a legitimate screenshot of a real document (a
// bank statement PDF, say) is an existing, celebrated first-class input path in this
// codebase (G9) and must never be rejected.
// ---------------------------------------------------------------------------

/** Coarse proxy for "does this look like a real camera capture." Full EXIF Make/Model
 *  parsing needs a tag-reading dependency this codebase does not have; a real camera/
 *  phone photo's EXIF TIFF block is reliably hundreds to thousands of bytes, while a
 *  screenshot or synthetic image typically carries none or a trivial one. Documented
 *  simplification, not a claim of real tag parsing — see docs/DECISIONS.md Known Limits. */
export const EXIF_PRESENT_MIN_BYTES = 100;
const SCREEN_RESOLUTION_TOLERANCE = 2;

/** Display panel sizes only — deliberately excludes camera sensor output resolutions
 *  (e.g. 3024×4032, 4000×3000), which would otherwise make an ordinary camera-phone
 *  document photo — the single most common real input — false-trip as "screen-native." */
const COMMON_SCREEN_RESOLUTIONS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080], [2560, 1440], [3840, 2160], [1366, 768], [1536, 864],
  [1440, 900], [1280, 720], [1600, 900], [1280, 800],
  [1170, 2532], [1179, 2556], [1284, 2778], [1290, 2796],
  [1080, 1920], [1080, 2340], [1080, 2400], [1080, 2280],
  [828, 1792], [750, 1334], [640, 1136],
  [1440, 3040], [1440, 3200],
];

function matchesScreenResolution(width: number, height: number): boolean {
  for (const [w, h] of COMMON_SCREEN_RESOLUTIONS) {
    const straight =
      Math.abs(width - w) <= SCREEN_RESOLUTION_TOLERANCE && Math.abs(height - h) <= SCREEN_RESOLUTION_TOLERANCE;
    const swapped =
      Math.abs(width - h) <= SCREEN_RESOLUTION_TOLERANCE && Math.abs(height - w) <= SCREEN_RESOLUTION_TOLERANCE;
    if (straight || swapped) return true;
  }
  return false;
}

/**
 * v1 of this signal scanned in thin strips looking for individual uniform-colour "bands"
 * and counted stacked pairs. It shipped broken: a driving licence's single accent-
 * coloured header contains a title or a state name, and at strip-level resolution that
 * text reliably fragments one visual band into several small ones with different local
 * means — which a naive stacked-band count then misread as real UI chrome, rejecting
 * every card-shaped document in the corpus. A gap-based merge pass papered over some of
 * it but not all, because this scan's own boundary imprecision produces small gaps in
 * both the "real second band" case and the "text-interrupted single band" case — gap
 * size alone cannot tell them apart.
 *
 * v2, below, sidesteps the problem instead of chasing it further: it never measures
 * anything at strip resolution. It compares two large, FIXED-size zones per edge — each
 * spanning enough of the frame that a modest amount of text or an icon is a small
 * minority of that zone's pixels and gets averaged away, the same reason a printed
 * page's overall mean is not thrown off by its own body text. A header with a title on
 * it stays "one uniform zone" this way; genuinely distinct stacked bars (a menu bar and
 * a toolbar of a different shade) still show up as two zones with clearly different
 * means, because that difference is not a measurement artefact, it is the actual point
 * of the two bars existing.
 */
const CHROME_ZONE_A_FRACTION = 0.18;
const CHROME_ZONE_B_FRACTION = 0.36;
/** A zone counts as "uniform" below this internal stddev — loose enough to tolerate a
 *  modest amount of text/icon content averaged over a large area, tight enough that real
 *  document content (a photo, a field grid) reliably fails it. */
const CHROME_ZONE_MAX_STDDEV = 32;
/** Two adjacent zones must differ by at least this much to count as genuinely different
 *  bars, not just measurement noise between two shades of the same background. */
const CHROME_ZONE_MEAN_DIFF_MIN = 28;
/** A zone's mean must differ from the whole frame's own mean by at least this much to
 *  count as a distinct element on its own — otherwise an ordinary paper document's blank
 *  margin, which sits close to the page's own overall brightness, would register as a
 *  plausible lone sidebar. */
const CHROME_ZONE_CONTRAST_MIN = 20;

interface ZoneStats {
  mean: number;
  stddev: number;
}

function zoneStats(gray: Uint8Array, width: number, x0: number, x1: number, y0: number, y1: number): ZoneStats {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    const rowStart = y * width;
    for (let x = x0; x < x1; x++) {
      const v = gray[rowStart + x];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return { mean: 0, stddev: 0 };
  const mean = sum / count;
  return { mean, stddev: Math.sqrt(Math.max(0, sumSq / count - mean * mean)) };
}

/** Two zones stacked from an edge inward, at CHROME_ZONE_A_FRACTION and the following
 *  CHROME_ZONE_B_FRACTION − CHROME_ZONE_A_FRACTION slice. `edge` picks which side of the
 *  frame "inward" means. */
function edgeZones(
  gray: Uint8Array,
  width: number,
  height: number,
  edge: 'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT',
): { zoneA: ZoneStats; zoneB: ZoneStats } {
  const perpendicular = edge === 'LEFT' || edge === 'RIGHT' ? width : height;
  const aDepth = Math.round(perpendicular * CHROME_ZONE_A_FRACTION);
  const bDepth = Math.round(perpendicular * CHROME_ZONE_B_FRACTION);
  switch (edge) {
    case 'TOP':
      return { zoneA: zoneStats(gray, width, 0, width, 0, aDepth), zoneB: zoneStats(gray, width, 0, width, aDepth, bDepth) };
    case 'BOTTOM':
      return {
        zoneA: zoneStats(gray, width, 0, width, height - aDepth, height),
        zoneB: zoneStats(gray, width, 0, width, height - bDepth, height - aDepth),
      };
    case 'LEFT':
      return { zoneA: zoneStats(gray, width, 0, aDepth, 0, height), zoneB: zoneStats(gray, width, aDepth, bDepth, 0, height) };
    case 'RIGHT':
      return {
        zoneA: zoneStats(gray, width, width - aDepth, width, 0, height),
        zoneB: zoneStats(gray, width, width - bDepth, width - aDepth, 0, height),
      };
  }
}

function isUniform(zone: ZoneStats): boolean {
  return zone.stddev <= CHROME_ZONE_MAX_STDDEV;
}

/** Two adjacent, individually-uniform zones with clearly different brightness — a status
 *  bar directly followed by a toolbar of a different shade, structurally. */
function isStackedPair(zoneA: ZoneStats, zoneB: ZoneStats): boolean {
  return isUniform(zoneA) && isUniform(zoneB) && Math.abs(zoneA.mean - zoneB.mean) >= CHROME_ZONE_MEAN_DIFF_MIN;
}

/** One uniform zone that stands out from the frame's own overall brightness — a
 *  plausible solid-colour sidebar, on its own (LEFT/RIGHT only; see evaluateScreenCapture
 *  for why TOP/BOTTOM never use this alone). */
function isSoloBand(zone: ZoneStats, overallMean: number): boolean {
  return isUniform(zone) && Math.abs(zone.mean - overallMean) >= CHROME_ZONE_CONTRAST_MIN;
}

export function evaluateScreenCapture(
  work: { gray: Uint8Array; width: number; height: number },
  fullWidth: number,
  fullHeight: number,
  exifBytesLength: number | null,
): GateSignalOutcome {
  const resolutionMatches = matchesScreenResolution(fullWidth, fullHeight);
  const exifAbsent = (exifBytesLength ?? 0) < EXIF_PRESENT_MIN_BYTES;
  const screenNative = resolutionMatches || exifAbsent;

  const { gray, width, height } = work;
  const overallMean = luminanceStats(gray).mean;
  const top = edgeZones(gray, width, height, 'TOP');
  const bottom = edgeZones(gray, width, height, 'BOTTOM');
  const left = edgeZones(gray, width, height, 'LEFT');
  const right = edgeZones(gray, width, height, 'RIGHT');

  const hasStackedTop = isStackedPair(top.zoneA, top.zoneB);
  const hasStackedBottom = isStackedPair(bottom.zoneA, bottom.zoneB);
  // The load-bearing guard (docs/DECISIONS.md A3): a single uniform zone on one edge —
  // exactly what every driving licence's solid-colour header row looks like — must never
  // be enough alone. A lone sidebar is the one exception, and only on LEFT/RIGHT: a real
  // nav sidebar is visually load-bearing UI furniture on its own, unlike a top/bottom
  // strip, which is indistinguishable at this resolution from an ordinary printed
  // document's own coloured banner. TOP/BOTTOM only ever count via a genuinely stacked
  // pair of different shades.
  const hasSidebar = isSoloBand(left.zoneA, overallMean) || isSoloBand(right.zoneA, overallMean);
  const appChromePresent = hasStackedTop || hasStackedBottom || hasSidebar;

  const evidence = [
    `resolutionMatches=${resolutionMatches}`,
    `exifAbsent=${exifAbsent}`,
    `top=[${top.zoneA.mean.toFixed(0)}±${top.zoneA.stddev.toFixed(0)},${top.zoneB.mean.toFixed(0)}±${top.zoneB.stddev.toFixed(0)}]`,
    `bottom=[${bottom.zoneA.mean.toFixed(0)}±${bottom.zoneA.stddev.toFixed(0)},${bottom.zoneB.mean.toFixed(0)}±${bottom.zoneB.stddev.toFixed(0)}]`,
    `left=[${left.zoneA.mean.toFixed(0)}±${left.zoneA.stddev.toFixed(0)}]`,
    `right=[${right.zoneA.mean.toFixed(0)}±${right.zoneA.stddev.toFixed(0)}]`,
    `appChromePresent=${appChromePresent}`,
  ];

  if (screenNative && appChromePresent) {
    return {
      signal: 'SCREEN_CAPTURE',
      outcome: 'CONFIDENT_NEGATIVE',
      detail:
        'Screen-native dimensions or absent camera metadata, combined with genuine application-chrome structure',
      evidence,
    };
  }
  return {
    signal: 'SCREEN_CAPTURE',
    outcome: 'UNCERTAIN',
    detail: 'No confident screen-capture-of-an-application finding',
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Signal 3 — positive domain signal. The only signal that costs anything.
//
// A hit here means ADMIT_FULL. No hit means NO_DOMAIN_SIGNAL, which caps at
// ADMIT_LIMITED — never REJECT. Absence of positive evidence is not evidence of
// absence.
// ---------------------------------------------------------------------------

/** Excluded from the gate's bare "≥1 hit → admit" trigger only. classify.ts's own
 *  margin-checked classification logic is untouched and keeps using the full list,
 *  including these terms — they are still real, useful classification signal there, just
 *  too weak or too generic for a trigger with no margin check behind it. Each exclusion
 *  is cited from what it collides with: */
export const GATE_KEYWORD_EXCLUSIONS = new Set<string>([
  'restrictions', 'endorsements', // classify.ts: "worth something only in combination, never alone"
  'bill date', 'total due', 'amount due', // exactly a restaurant receipt's or generic invoice's own phrasing
  'effective date', // too generic — appears on many unrelated document types
]);

interface GateKeywordGroup {
  cls: DocumentClass;
  terms: string[];
}

/**
 * Derived from CLASS_KEYWORDS by exclusion, not hand-duplicated. This is what makes the
 * hard constraint "EMPLOYMENT_LETTER and MEDICAL_INSURANCE_CARD keywords must survive"
 * structural rather than a maintenance promise: docs 13/19/20/21 in the eval corpus only
 * resolve via TC_VLM today, and excluding those classes' keywords here would return
 * NO_DOMAIN_SIGNAL on those exact documents, block TC, and regress them. Deriving by
 * exclusion means a future edit to classify.ts's own lexicon propagates automatically,
 * with none of the silent-divergence risk docs/DECISIONS.md's G11 finding already
 * documents once in this codebase (`checksum_detail` vs. the raw AAMVA stream).
 */
export const GATE_KEYWORDS: GateKeywordGroup[] = CLASS_KEYWORDS.map((group) => ({
  cls: group.cls,
  terms: group.terms.filter((term) => !GATE_KEYWORD_EXCLUSIONS.has(term)),
})).filter((group) => group.terms.length > 0);

export function findGateKeywordHit(text: string): { term: string; cls: DocumentClass } | null {
  const lower = text.toLowerCase();
  for (const group of GATE_KEYWORDS) {
    for (const term of group.terms) {
      if (lower.includes(term)) return { term, cls: group.cls };
    }
  }
  return null;
}

function positiveOutcome(detail: string, evidence: string[]): GateSignalOutcome {
  return { signal: 'POSITIVE_DOMAIN_SIGNAL', outcome: 'CONFIDENT_POSITIVE', detail, evidence };
}

export async function evaluatePositiveDomainSignal(input: GateInput): Promise<GateSignalOutcome> {
  // 1. Coarse barcode check on the already-downscaled buffer — zero extra resize.
  // Decode SUCCESS is strong positive evidence (self-validating via the barcode's own
  // Reed-Solomon ECC, same reasoning TA-PDF417 itself relies on). Decode FAILURE at this
  // resolution is ambiguous, not negative — decodePdf417's own doc comment notes narrow
  // bars fall under one pixel below ~150 DPI, so a miss here just falls through to the
  // next check, per the asymmetry rule.
  const barcodeText = await decodePdf417(input.downscaled as BarcodeImage).catch(() => null);
  if (barcodeText) {
    return positiveOutcome('PDF417-shaped region decoded at coarse resolution', ['pdf417=decoded']);
  }

  // 2. Free when present: a text-native PDF's embedded text layer (§11.1 #6) costs
  // nothing to check.
  if (input.textLayer) {
    const hit = findGateKeywordHit(input.textLayer);
    if (hit) {
      return positiveOutcome(
        `keyword "${hit.term}" matched in the embedded text layer (${hit.cls})`,
        [`textLayer:${hit.term}`],
      );
    }
  }

  // 3. The only paid step: a fast, low-resolution OCR presurvey — not TB's full pass,
  // which still runs unconditionally afterward for every admitted document.
  const ocr = input.ocr ?? presurveyOcrRunner;
  const page = await ocr(input.downscaled);
  const lines = reconstructLines(page);
  if (estimateMachineReadableZone(lines) !== null) {
    return positiveOutcome('MRZ-shaped band geometry detected at low resolution', ['mrzZone=present']);
  }
  const ocrText = page.tokens.map((t) => t.text).join(' ');
  const hit = findGateKeywordHit(ocrText);
  if (hit) {
    return positiveOutcome(`keyword "${hit.term}" matched in low-resolution OCR (${hit.cls})`, [`ocr:${hit.term}`]);
  }

  return {
    signal: 'POSITIVE_DOMAIN_SIGNAL',
    outcome: 'NOT_FOUND',
    detail: 'No MRZ geometry, barcode, or domain-specific keyword found',
    evidence: [],
  };
}
