/**
 * T0 — normalization (§7 "T0 — Normalize and classify", §11.1, §11.2).
 *
 * This is the front of the pipeline, and it is load-bearing for everything after it:
 * TA-PDF417 and TA-MRZ both need real pixels in the right orientation, and §9 weights
 * document quality as a *medium* confidence signal precisely because §4.4's finding is
 * that extraction errors are document-caused, not model-caused. If T0 lies about
 * quality, the confidence fusion downstream is calibrated against a fiction.
 *
 * Decisions recorded here for the README decision log:
 *
 *   T0-A — §7's [DECIDE] asks whether to gate the pipeline on a quality pre-check.
 *          We take the recommended path: attempt everything, and surface the metrics
 *          plus advisory `reason_codes` on the *success* result. Blur, glare, skew and
 *          low DPI never reject an upload here; they travel with it so the confidence
 *          fusion can price them. Only the six hard failures in `NormalizeFailureKind`
 *          reject, and each of them is a fact about the bytes, not a judgement call.
 *
 *   T0-B — the originally-frozen `ReasonCode` enum had no member for "corrupt file",
 *          "unsupported file type" or "password-protected PDF". Rather than widen a
 *          contract the whole repo is built against mid-build, every hard rejection
 *          carried `CLASS_UNRECOGNIZED` as its `ReasonCode` plus a separate
 *          machine-readable `kind` discriminant that said which of the six it actually
 *          was (docs/DECISIONS.md G10). The three named gaps — `UNSUPPORTED_TYPE`,
 *          `CORRUPT_FILE`, `ENCRYPTED_PDF` — have since been added to the enum as a
 *          follow-up and are used directly below; `EMPTY_FILE` and `RENDER_FAILED`
 *          still fall back to `CLASS_UNRECOGNIZED`, since G10 never named those two as
 *          gaps and the `kind` discriminant already disambiguates them for a caller
 *          that needs to. `message` is written to be shown to a user — §11.1 #2
 *          requires no stack trace reaches the client, so no library error text is
 *          ever propagated into it.
 *
 *   T0-C — §11.1 #12 says a file under 50 KB is "likely too low-res", while §11.2 #26
 *          says a screenshot of a document is the *easiest* case — and a screenshot of
 *          a bank statement compresses well under 50 KB at 2000 px. Rejecting purely on
 *          byte count would throw away the easiest wins in the eval set. We therefore
 *          treat the byte count as a trigger for a resolution check, not as the check:
 *          under 50 KB we decode and reject only if the *estimated effective DPI* also
 *          falls below `MIN_EFFECTIVE_DPI`. A 40x40 thumbnail is still rejected; a
 *          crisp 2000 px screenshot is not.
 *
 *   T0-D — a text-native PDF (§11.1 #6) is not rasterized at 300 DPI. We extract its
 *          text layer and rasterize page 1 only, at `TEXT_LAYER_RASTER_DPI`, because the
 *          contract still requires an evidence crop and the TC path still needs pixels
 *          if TB abstains. `text_layer_used` tells TB it can skip OCR entirely.
 *
 * No module-level mutable state lives in this file. Every export is either pure or
 * takes all of its inputs as arguments, so handlers are safe under concurrent
 * invocation (§11.6 #75).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import {
  abstain,
  type BBox,
  type QualityMetrics,
  type ReasonCode,
  type TierResult,
} from '@/types/contract';

// ---------------------------------------------------------------------------
// Tunables. Exported so the eval harness can sweep them rather than guess them.
// ---------------------------------------------------------------------------

/** §11.1 #12. A trigger for the resolution check, not a rejection on its own (T0-C). */
export const MIN_FILE_BYTES = 50 * 1024;

/** §7.4 — the VLM path gets the long edge capped here; the full-res copy is kept intact. */
export const DOWNSCALE_LONG_EDGE = 2000;

/** §7.3 / §11.1 #7. */
export const PDF_RASTER_DPI = 300;

/**
 * T0-D's original assumption — "a text-native PDF only needs pixels for the evidence
 * crop, so a lower DPI is fine" — does not hold for the case that actually exercises this
 * path most: a phone-scanning app (Adobe Scan and similar) that OCRs a photographed page
 * and embeds its OWN hidden text layer under the image. `TEXT_LAYER_MIN_CHARS` cannot tell
 * that embedded layer apart from a genuinely digital, position-exact one — and a scanned
 * identity document's MRZ needs MORE resolution than a normal page, not less, so silently
 * halving DPI on exactly the documents where TA/TB most need to succeed is backwards. Equal
 * to `PDF_RASTER_DPI` until there is a reliable way to tell the two cases apart.
 */
export const TEXT_LAYER_RASTER_DPI = PDF_RASTER_DPI;

/** §11.1 #9 — a 40-page bank statement must not cost 40 pages of work. */
export const PDF_MAX_PAGES = 3;

/** Alphanumeric characters across the capped pages before we call a PDF text-native. */
export const TEXT_LAYER_MIN_CHARS = 40;

/**
 * Hard ceiling on the full-resolution raster. A 108 MP phone panorama would otherwise
 * turn into a ~300 MB RGBA buffer inside a serverless function with a 1 GB limit.
 */
export const MAX_FULL_RES_PIXELS = 30_000_000;

/** Quality metrics are computed at a canonical size so the numbers compare across inputs. */
export const QUALITY_WORK_LONG_EDGE = 1000;

/** OpenCV's conventional blur floor, measured at `QUALITY_WORK_LONG_EDGE` (§11.2 #16). */
export const BLUR_LAPLACIAN_FLOOR = 100;

/** Fraction of blown-out pixels that suggests laminate flash glare (§11.2 #17). */
export const GLARE_HIGHLIGHT_RATIO = 0.08;

/** Below this mean luminance or contrast the page is a shadow problem (§11.2 #23). */
export const DARK_MEAN_LUMINANCE = 60;
export const LOW_CONTRAST_STDDEV = 25;

/** §11.2 #19-#20 — beyond this we stop calling it skew and call it a rotation problem. */
export const EXTREME_SKEW_DEG = 15;

/** Below this, PDF417 will not decode and the printed text is marginal (§11.2 #18). */
export const MIN_EFFECTIVE_DPI = 150;

/** Corner-angle deviation from 90° that justifies paying for a perspective warp. */
export const PERSPECTIVE_CORRECTION_MIN_DEG = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Everything we will decode. Anything else is rejected at the magic-byte gate (§11.1 #1). */
export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;
export type SupportedMime = (typeof SUPPORTED_MIME_TYPES)[number];

export type NormalizeFailureKind =
  | 'EMPTY_FILE'
  | 'UNSUPPORTED_TYPE'
  | 'CORRUPT_FILE'
  | 'ENCRYPTED_PDF'
  | 'RESOLUTION_TOO_LOW'
  | 'RENDER_FAILED';

export interface NormalizeOptions {
  /** Client-declared filename. Recorded for the audit trail, never trusted (§7.1). */
  declaredName?: string;
  /** Client-declared content type. Same: recorded, never trusted. */
  declaredMime?: string;
  maxPdfPages?: number;
  rasterDpi?: number;
  downscaleLongEdge?: number;
  minBytes?: number;
  /** Default true. Set false to skip the quad detection + warp entirely (§11.2 #19). */
  correctPerspective?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * An estimate of where the document sits inside the frame, in the coordinate space of
 * the quality working raster (not the full-resolution one).
 */
export interface DocumentQuad {
  /** Top-left, top-right, bottom-right, bottom-left. */
  corners: [Point, Point, Point, Point];
  /** Fraction of the frame the document mask occupies. */
  coverage: number;
  /** Fraction of the frame's border pixels the mask touches — high means edges are cut off. */
  borderContact: number;
  /** Number of the four frame edges the mask contacts heavily. */
  edgesContacted: number;
  /** Worst corner-angle deviation from 90°. Zero for a head-on rectangle. */
  maxCornerDeviationDeg: number;
}

export interface NormalizedPage {
  /** 0-based index into the source document. */
  index: number;
  /**
   * Lossless PNG at full resolution. PNG and not JPEG on purpose: PDF417 and OCR-B are
   * exactly the high-frequency content JPEG's chroma subsampling destroys, and §4.1
   * already warns that barcode decoding is resolution- and focus-sensitive.
   */
  fullResolution: Buffer;
  fullWidth: number;
  fullHeight: number;
  /** §7.4 — long edge `DOWNSCALE_LONG_EDGE`, JPEG, for the TC VLM path. */
  downscaled: Buffer;
  downscaledWidth: number;
  downscaledHeight: number;
  /** EXIF orientation and/or the PDF `/Rotate` flag, in degrees, already applied. */
  rotationAppliedDeg: number;
  perspectiveCorrected: boolean;
  /** Text layer for a text-native PDF page (§11.1 #6). Null for images and scans. */
  textLayer: string | null;
  quality: QualityMetrics;
  /** Advisory quality findings for this page (T0-A). */
  reasonCodes: ReasonCode[];
}

export interface NormalizedDocument {
  ok: true;
  /** Sniffed from magic bytes (§7.1). */
  detectedMime: SupportedMime;
  declaredMime: string | null;
  declaredName: string | null;
  sourceFormat: 'IMAGE' | 'PDF';
  /** Total pages in the source — feeds `document.pages` in the response contract. */
  pageCount: number;
  /** Capped at `PDF_MAX_PAGES` (§11.1 #9). Always at least one entry. */
  pages: NormalizedPage[];
  /** True when `pageCount > pages.length`; §11.1 #9 requires we say so in the response. */
  pagesTruncated: boolean;
  /** True when the PDF carried a usable text layer, so TB can skip OCR (§11.1 #6). */
  textLayerUsed: boolean;
  /** Convenience alias for `pages[0]`; the tiers that only look at one page use this. */
  primary: NormalizedPage;
  /** Alias for `primary.quality`, which is what the response's `quality` block carries. */
  quality: QualityMetrics;
  /** Union of every page's advisory findings. Never a rejection (T0-A). */
  reasonCodes: ReasonCode[];
  /** Human-readable notes for the response, e.g. the page cap actually biting. */
  notes: string[];
  /** SHA-256 of the input bytes. Lets a caller make repeat uploads free (§11.1 #14). */
  contentHash: string;
  durationMs: number;
}

export interface NormalizeRejection {
  ok: false;
  kind: NormalizeFailureKind;
  /** Always non-empty; see T0-B for why this is usually `CLASS_UNRECOGNIZED`. */
  reasonCodes: ReasonCode[];
  /** Safe to render to a user verbatim: no stack, no library internals (§11.1 #2). */
  message: string;
  detectedMime: string | null;
  declaredMime: string | null;
  declaredName: string | null;
  contentHash: string;
  durationMs: number;
}

export type NormalizeOutcome = NormalizedDocument | NormalizeRejection;

export function isNormalized(outcome: NormalizeOutcome): outcome is NormalizedDocument {
  return outcome.ok;
}

/** All-null metrics, for the paths where we never got as far as decoding pixels. */
export const EMPTY_QUALITY: QualityMetrics = {
  laplacian_variance: null,
  mean_luminance: null,
  clipping_ratio: null,
  skew_angle_deg: null,
  effective_dpi: null,
};

/**
 * Lets a T0 rejection be spliced into the tier-result stream the router already
 * understands, instead of forcing every caller to special-case the front of the
 * pipeline. Abstention is a first-class return value (§5), and a document we could not
 * even decode is the purest possible abstention: tier `NONE`, no candidates, a reason.
 */
export function rejectionToTierResult(rejection: NormalizeRejection): TierResult {
  return abstain('NONE', rejection.reasonCodes, { duration_ms: rejection.durationMs });
}

// ---------------------------------------------------------------------------
// Magic-byte sniffing (§7.1, §11.1 #1)
// ---------------------------------------------------------------------------

export interface SniffResult {
  mime: string | null;
  ext: string | null;
  supported: boolean;
}

/**
 * Reads the real type out of the leading bytes. The filename and the client-declared
 * content type are both attacker-controlled and both routinely wrong even when they are
 * not — iOS shares HEIC as `image/jpeg` often enough that trusting the header would
 * silently break the single most common mobile upload (§11.1 #3).
 *
 * A `null` mime means `file-type` recognised nothing, which covers both a zero-byte file
 * and a `.txt`: neither has a magic signature, and neither is a document.
 */
export async function sniffMime(bytes: Uint8Array): Promise<SniffResult> {
  if (bytes.byteLength === 0) return { mime: null, ext: null, supported: false };
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected) return { mime: null, ext: null, supported: false };
  const supported = (SUPPORTED_MIME_TYPES as readonly string[]).includes(detected.mime);
  return { mime: detected.mime, ext: detected.ext, supported };
}

// ---------------------------------------------------------------------------
// Quality metrics (§7.5)
// ---------------------------------------------------------------------------

/**
 * Variance of the 4-neighbour Laplacian over an 8-bit grayscale plane — the standard
 * focus measure (§11.2 #16). Sensitive to scale, which is why every caller here feeds
 * it a raster normalized to `QUALITY_WORK_LONG_EDGE`: a 200-px thumbnail and a 4000-px
 * photo of the same card would otherwise produce numbers an order of magnitude apart
 * and the threshold would mean nothing.
 */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

export interface LuminanceStats {
  /** 0-255, the native 8-bit scale rather than a normalized fraction. */
  mean: number;
  stddev: number;
  /** Fraction of pixels blown out to near-white — the glare signal (§11.2 #17). */
  highlightClipping: number;
  /** Fraction crushed to near-black — the shadow signal (§11.2 #23). */
  shadowClipping: number;
}

export function luminanceStats(gray: Uint8Array): LuminanceStats {
  const n = gray.length;
  if (n === 0) return { mean: 0, stddev: 0, highlightClipping: 0, shadowClipping: 0 };
  let sum = 0;
  let sumSq = 0;
  let high = 0;
  let low = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    sum += v;
    sumSq += v * v;
    if (v >= 250) high++;
    else if (v <= 5) low++;
  }
  const mean = sum / n;
  return {
    mean,
    stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    highlightClipping: high / n,
    shadowClipping: low / n,
  };
}

/**
 * Estimates the in-plane rotation of the page content by projection profile.
 *
 * For each candidate angle we shear the ink mask so that a line at that angle collapses
 * into a single accumulator bin, then score the profile by sum-of-squares: a profile
 * with a few tall spikes (text lines, card edges, MRZ bands all aligned) scores far
 * higher than a smeared one. The argmax is the angle the content is rotated *by*, so
 * levelling the page means rotating by `-skew`.
 *
 * A Hough transform would be more accurate and roughly an order of magnitude more
 * expensive; §9 only uses skew as a medium-weight quality signal and §11.2 #20 hands
 * gross 90° rotation to `tryAllOrientations` instead, so the cheap estimator is the
 * right trade here.
 */
export function estimateSkewAngle(
  gray: Uint8Array,
  width: number,
  height: number,
  maxDeg = 20,
): number {
  if (width < 8 || height < 8) return 0;
  const stats = luminanceStats(gray);
  // "Ink" is anything meaningfully darker than the page. On an inverted (dark) document
  // this picks the light strokes instead, which shears identically.
  const threshold = stats.mean - 0.5 * stats.stddev;
  if (stats.stddev < 2) return 0; // featureless: nothing to align.

  const score = (deg: number): number => {
    const tan = Math.tan((deg * Math.PI) / 180);
    const bins = new Float64Array(height + Math.ceil(Math.abs(tan) * width) + 2);
    const offset = tan > 0 ? Math.ceil(tan * width) : 0;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (gray[row + x] >= threshold) continue;
        const bin = Math.round(y - x * tan) + offset;
        if (bin >= 0 && bin < bins.length) bins[bin] += 1;
      }
    }
    let total = 0;
    for (let i = 0; i < bins.length; i++) total += bins[i] * bins[i];
    // Normalize by bin count so wider shears are not rewarded for having more bins.
    return total / bins.length;
  };

  let best = 0;
  let bestScore = -Infinity;
  for (let deg = -maxDeg; deg <= maxDeg; deg += 0.5) {
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  for (let deg = best - 0.5; deg <= best + 0.5; deg += 0.1) {
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  return Math.round(best * 10) / 10;
}

/**
 * Effective DPI without knowing the physical document — the aspect ratio is the only
 * free signal, so we map it onto the standard physical sizes and divide.
 *
 * ID-1 (ISO 7810, every DL/state ID/most national ID cards) is 85.6 x 54 mm = 1.586:1.
 * A passport data page (TD3 booklet) is 125 x 88 mm = 1.42:1. Everything else is
 * assumed to be paper on the US Letter / A4 long edge. Deliberately coarse: §9 weights
 * effective DPI as a medium signal, and the failure mode we care about is "far too few
 * pixels for PDF417" (§11.2 #18), which survives a 20% error in the assumed size.
 */
export function estimateEffectiveDpi(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.max(1, Math.min(width, height));
  const aspect = longEdge / shortEdge;
  let physicalLongEdgeInches: number;
  if (aspect >= 1.45 && aspect <= 1.75) physicalLongEdgeInches = 3.37; // ID-1 card
  else if (aspect >= 1.3 && aspect < 1.45) physicalLongEdgeInches = 4.92; // passport data page
  else physicalLongEdgeInches = 11; // paper
  return Math.round(longEdge / physicalLongEdgeInches);
}

/**
 * Locates the document inside the frame by contrast against the border background.
 *
 * The border band is sampled for a background level, everything far enough from it is
 * document, and the quad corners are the extremes of `x+y` / `x-y` over that mask —
 * the classic four-corner heuristic, which is exact for a convex quadrilateral and
 * degrades gracefully into a bounding box when the mask is noisy.
 *
 * Returns null when the mask is too small or too large to be a document sitting in a
 * frame, which is the common and correct answer for a full-bleed scan or a screenshot.
 */
export function detectDocumentQuad(
  gray: Uint8Array,
  width: number,
  height: number,
): DocumentQuad | null {
  if (width < 16 || height < 16) return null;

  const bandX = Math.max(1, Math.round(width * 0.04));
  const bandY = Math.max(1, Math.round(height * 0.04));
  const borderSamples: number[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const inVerticalBand = y < bandY || y >= height - bandY;
    for (let x = 0; x < width; x++) {
      if (inVerticalBand || x < bandX || x >= width - bandX) borderSamples.push(gray[row + x]);
    }
  }
  borderSamples.sort((a, b) => a - b);
  const background = borderSamples[Math.floor(borderSamples.length / 2)];

  const delta = 28;
  let count = 0;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;
  let tl: Point = { x: 0, y: 0 };
  let tr: Point = { x: width - 1, y: 0 };
  let br: Point = { x: width - 1, y: height - 1 };
  let bl: Point = { x: 0, y: height - 1 };

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (Math.abs(gray[row + x] - background) <= delta) continue;
      count++;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        tl = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        br = { x, y };
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        tr = { x, y };
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl = { x, y };
      }
    }
  }

  const coverage = count / (width * height);
  if (coverage < 0.05) return null;

  // Border contact, measured per edge so "three sides run off the frame" is expressible.
  let contactPixels = 0;
  let borderPixels = 0;
  const edgeHits = [0, 0, 0, 0];
  const edgeLens = [width, width, height, height];
  for (let x = 0; x < width; x++) {
    if (Math.abs(gray[x] - background) > delta) edgeHits[0]++;
    if (Math.abs(gray[(height - 1) * width + x] - background) > delta) edgeHits[1]++;
  }
  for (let y = 0; y < height; y++) {
    if (Math.abs(gray[y * width] - background) > delta) edgeHits[2]++;
    if (Math.abs(gray[y * width + width - 1] - background) > delta) edgeHits[3]++;
  }
  for (let i = 0; i < 4; i++) {
    contactPixels += edgeHits[i];
    borderPixels += edgeLens[i];
  }
  const edgesContacted = edgeHits.filter((hits, i) => hits / edgeLens[i] > 0.6).length;

  const corners: [Point, Point, Point, Point] = [tl, tr, br, bl];
  return {
    corners,
    coverage,
    borderContact: contactPixels / borderPixels,
    edgesContacted,
    maxCornerDeviationDeg: maxCornerDeviation(corners),
  };
}

function maxCornerDeviation(corners: [Point, Point, Point, Point]): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const prev = corners[(i + 3) % 4];
    const here = corners[i];
    const next = corners[(i + 1) % 4];
    const a = { x: prev.x - here.x, y: prev.y - here.y };
    const b = { x: next.x - here.x, y: next.y - here.y };
    const magA = Math.hypot(a.x, a.y);
    const magB = Math.hypot(b.x, b.y);
    if (magA < 1 || magB < 1) return 90; // degenerate quad — treat as maximally distorted
    const cos = Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y) / (magA * magB)));
    worst = Math.max(worst, Math.abs((Math.acos(cos) * 180) / Math.PI - 90));
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Perspective correction (§11.2 #19)
// ---------------------------------------------------------------------------

/**
 * Solves the 8 free parameters of the homography mapping destination pixels back to
 * source pixels, so the warp can be done by inverse sampling (every output pixel gets a
 * value, with no holes — the forward mapping cannot promise that).
 *
 * Straightforward Gaussian elimination with partial pivoting on the 8x8 system; four
 * point correspondences give exactly eight equations, so there is nothing to fit.
 * Returns null if the system is singular, which happens when the detected quad has
 * collapsed and is exactly when we should leave the image alone.
 */
export function solveInverseHomography(
  dst: [Point, Point, Point, Point],
  src: [Point, Point, Point, Point],
): number[] | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dst[i];
    const { x, y } = src[i];
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      if (factor === 0) continue;
      for (let c = col; c < 8; c++) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }
  return b.map((value, i) => value / a[i][i]);
}

/**
 * Rectifies a photographed-at-an-angle document by warping the detected quad onto a
 * head-on rectangle, with bilinear sampling so the OCR-B and PDF417 edges do not get
 * the staircase artefacts nearest-neighbour would introduce.
 *
 * Pure: RGB bytes in, RGB bytes out. The caller decides whether the distortion was
 * worth paying for; this function does not second-guess it.
 */
export function warpPerspective(
  rgb: Uint8Array,
  width: number,
  height: number,
  channels: number,
  quad: [Point, Point, Point, Point],
): { data: Uint8Array; width: number; height: number } | null {
  const [tl, tr, br, bl] = quad;
  const outWidth = Math.round((Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2);
  const outHeight = Math.round((Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2);
  if (outWidth < 16 || outHeight < 16) return null;

  const h = solveInverseHomography(
    [
      { x: 0, y: 0 },
      { x: outWidth - 1, y: 0 },
      { x: outWidth - 1, y: outHeight - 1 },
      { x: 0, y: outHeight - 1 },
    ],
    quad,
  );
  if (!h) return null;

  const out = new Uint8Array(outWidth * outHeight * channels);
  for (let v = 0; v < outHeight; v++) {
    for (let u = 0; u < outWidth; u++) {
      const denom = h[6] * u + h[7] * v + 1;
      const sx = (h[0] * u + h[1] * v + h[2]) / denom;
      const sy = (h[3] * u + h[4] * v + h[5]) / denom;
      const outIndex = (v * outWidth + u) * channels;
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
        for (let c = 0; c < channels; c++) out[outIndex + c] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < channels; c++) {
        const p00 = rgb[(y0 * width + x0) * channels + c];
        const p10 = rgb[(y0 * width + x1) * channels + c];
        const p01 = rgb[(y1 * width + x0) * channels + c];
        const p11 = rgb[(y1 * width + x1) * channels + c];
        out[outIndex + c] =
          (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

// ---------------------------------------------------------------------------
// Orientation search (§11.2 #20)
// ---------------------------------------------------------------------------

export type QuarterTurn = 0 | 90 | 180 | 270;
export const QUARTER_TURNS: readonly QuarterTurn[] = [0, 90, 180, 270];

export interface OrientationVariant {
  rotationDeg: QuarterTurn;
  fullResolution: Buffer;
  downscaled: Buffer;
}

/**
 * Tries the page as-is, then each remaining quarter turn, stopping at the first probe
 * that finds something. §11.2 #20's insight is that you do not need to *guess* the
 * orientation — MRZ and PDF417 detection tell you which one was right — so the probe is
 * injected rather than imported. That keeps T0 free of any dependency on the TA tier
 * (which is a separate module owned elsewhere), keeps this function pure with respect
 * to the pipeline, and makes it trivially testable with a fake probe.
 *
 * Rotation is only paid for lazily, one turn at a time: the overwhelmingly common case
 * is that 0° succeeds and the other three renders never happen.
 */
export async function tryAllOrientations<T>(
  page: NormalizedPage,
  probe: (variant: OrientationVariant) => Promise<T | null>,
  options: { downscaleLongEdge?: number } = {},
): Promise<{ rotationDeg: QuarterTurn; result: T } | null> {
  const longEdge = options.downscaleLongEdge ?? DOWNSCALE_LONG_EDGE;
  for (const rotationDeg of QUARTER_TURNS) {
    const variant: OrientationVariant =
      rotationDeg === 0
        ? { rotationDeg, fullResolution: page.fullResolution, downscaled: page.downscaled }
        : await rotateVariant(page, rotationDeg, longEdge);
    const result = await probe(variant);
    if (result !== null && result !== undefined) return { rotationDeg, result };
  }
  return null;
}

async function rotateVariant(
  page: NormalizedPage,
  rotationDeg: QuarterTurn,
  longEdge: number,
): Promise<OrientationVariant> {
  const fullResolution = await sharp(page.fullResolution).rotate(rotationDeg).png().toBuffer();
  const downscaled = await sharp(fullResolution)
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { rotationDeg, fullResolution, downscaled };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Turns arbitrary uploaded bytes into a clean, correctly-oriented raster plus honest
 * quality metrics, or into a machine-readable rejection. Never throws for input
 * reasons: every failure path in §11.1 is a returned value with a `ReasonCode` and a
 * message safe to show a user.
 *
 * Order matters and is not negotiable. Sniff before decode (the declared type may be a
 * lie), EXIF-orient before anything reads pixels (§11.1 #15 — untreated, a sideways
 * card breaks TA silently, which is the single highest-value fix in the whole
 * pipeline), and only then measure quality, because measuring skew on an image that is
 * about to be rotated 90° produces a number that means nothing.
 */
export async function normalizeDocument(
  input: Uint8Array | ArrayBuffer,
  options: NormalizeOptions = {},
): Promise<NormalizeOutcome> {
  const startedAt = Date.now();
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const declaredMime = options.declaredMime ?? null;
  const declaredName = options.declaredName ?? null;
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  const reject = (
    kind: NormalizeFailureKind,
    message: string,
    detectedMime: string | null,
    reasonCodes: ReasonCode[] = ['CLASS_UNRECOGNIZED'],
  ): NormalizeRejection => ({
    ok: false,
    kind,
    reasonCodes,
    message,
    detectedMime,
    declaredMime,
    declaredName,
    contentHash,
    durationMs: Date.now() - startedAt,
  });

  if (bytes.byteLength === 0) {
    return reject('EMPTY_FILE', 'The uploaded file is empty.', null);
  }

  const sniffed = await sniffMime(bytes);
  if (!sniffed.mime) {
    return reject(
      'UNSUPPORTED_TYPE',
      'That file is not an image or a PDF. Upload a photo, a scan, or a PDF of the document.',
      null,
      ['UNSUPPORTED_TYPE'],
    );
  }
  if (!sniffed.supported) {
    return reject(
      'UNSUPPORTED_TYPE',
      `Files of type ${sniffed.ext ?? sniffed.mime} are not supported. Upload an image or a PDF.`,
      sniffed.mime,
      ['UNSUPPORTED_TYPE'],
    );
  }
  const detectedMime = sniffed.mime as SupportedMime;

  const minBytes = options.minBytes ?? MIN_FILE_BYTES;
  const downscaleLongEdge = options.downscaleLongEdge ?? DOWNSCALE_LONG_EDGE;
  const correctPerspective = options.correctPerspective ?? true;

  try {
    const rendered =
      detectedMime === 'application/pdf'
        ? await renderPdf(bytes, options)
        : await renderImage(bytes, detectedMime);

    const pages: NormalizedPage[] = [];
    for (const raster of rendered.rasters) {
      pages.push(
        await finishPage(raster, {
          downscaleLongEdge,
          correctPerspective: correctPerspective && rendered.sourceFormat === 'IMAGE',
          allowCroppedDetection: rendered.sourceFormat === 'IMAGE',
          knownDpi: rendered.knownDpi,
        }),
      );
    }

    if (pages.length === 0) {
      return reject('RENDER_FAILED', 'The document could not be read.', detectedMime);
    }

    // T0-C: the byte-count trigger only bites when the pixels agree that it is too small.
    if (bytes.byteLength < minBytes) {
      const dpi = pages[0].quality.effective_dpi ?? 0;
      if (dpi < MIN_EFFECTIVE_DPI) {
        return reject(
          'RESOLUTION_TOO_LOW',
          'That image is too small to read reliably. Retake it closer, or upload the original rather than a messaging-app copy.',
          detectedMime,
          ['RESOLUTION_TOO_LOW'],
        );
      }
    }

    const notes: string[] = [];
    if (rendered.pagesTruncated) {
      notes.push(
        `Processed the first ${pages.length} of ${rendered.pageCount} pages (§11.1 #9 work cap).`,
      );
    }
    if (rendered.textLayerUsed) {
      notes.push('Used the PDF text layer directly rather than rasterizing for OCR.');
    }

    const reasonCodes = [...new Set(pages.flatMap((page) => page.reasonCodes))];
    return {
      ok: true,
      detectedMime,
      declaredMime,
      declaredName,
      sourceFormat: rendered.sourceFormat,
      pageCount: rendered.pageCount,
      pages,
      pagesTruncated: rendered.pagesTruncated,
      textLayerUsed: rendered.textLayerUsed,
      primary: pages[0],
      quality: pages[0].quality,
      reasonCodes,
      notes,
      contentHash,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (isPasswordError(error)) {
      return reject(
        'ENCRYPTED_PDF',
        'That PDF is password-protected. Remove the password and upload it again.',
        detectedMime,
        ['ENCRYPTED_PDF'],
      );
    }
    // Deliberately swallows the library message from the CLIENT response: §11.1 #2
    // requires no stack trace and no internals reach the client. It is still logged
    // server-side — error name/message only, never document content (§15) — because a
    // genuine bug hiding behind an honest-looking CORRUPT_FILE rejection is worse than one
    // that is at least visible in the platform logs.
    console.error('[normalize] render threw, reporting as CORRUPT_FILE', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });
    return reject(
      'CORRUPT_FILE',
      'That file could not be read — it may be corrupt or only partially uploaded.',
      detectedMime,
      ['CORRUPT_FILE'],
    );
  }
}

/**
 * Convenience wrapper for the two-file DL front+back case (§11.1 #13) that also gives
 * §11.1 #14 for free: identical bytes are normalized once and the result shared, so a
 * duplicate upload costs nothing. Sequential on purpose — sharp already uses a thread
 * pool internally, and running several full-resolution decodes concurrently inside a
 * serverless function is how you find the memory limit.
 */
export async function normalizeAll(
  inputs: Array<Uint8Array | ArrayBuffer>,
  options: NormalizeOptions = {},
): Promise<NormalizeOutcome[]> {
  const seen = new Map<string, NormalizeOutcome>();
  const results: NormalizeOutcome[] = [];
  for (const input of inputs) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cached = seen.get(hash);
    if (cached) {
      results.push(cached);
      continue;
    }
    const outcome = await normalizeDocument(bytes, options);
    seen.set(hash, outcome);
    results.push(outcome);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Decode paths
// ---------------------------------------------------------------------------

interface RasterPage {
  index: number;
  /** Always PNG. Already EXIF-oriented / page-rotated. */
  png: Buffer;
  width: number;
  height: number;
  rotationAppliedDeg: number;
  textLayer: string | null;
}

interface RenderResult {
  sourceFormat: 'IMAGE' | 'PDF';
  rasters: RasterPage[];
  pageCount: number;
  pagesTruncated: boolean;
  textLayerUsed: boolean;
  /** Set when we rasterized at a DPI we chose, so quality does not have to guess it. */
  knownDpi: number | null;
}

/**
 * HEIC/HEIF go through `heic-convert` first because that is the reference decoder for
 * the format and the one §11.1 #3 names. sharp is compiled with libheif here and can
 * usually do it too, so it is the fallback rather than a hard dependency — silently
 * failing on the most common mobile upload is the outcome this two-step avoids.
 *
 * Everything else goes straight to sharp with `page: 0`, which is what §11.1 #4/#5 ask
 * for: frame 0 of an animated GIF or a multi-frame TIFF, not a montage of all of them.
 */
async function renderImage(bytes: Uint8Array, mime: SupportedMime): Promise<RenderResult> {
  let decodable: Uint8Array = bytes;
  if (mime === 'image/heic' || mime === 'image/heif') {
    decodable = await decodeHeic(bytes);
  }

  const pipeline = sharp(decodable, { failOn: 'error', page: 0, pages: 1 });
  const metadata = await pipeline.metadata();
  const orientation = metadata.orientation ?? 1;

  // §11.1 #15 / §7.2 — before anything else touches the pixels.
  let oriented = sharp(decodable, { failOn: 'error', page: 0, pages: 1 }).autoOrient();

  const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
  if (pixels > MAX_FULL_RES_PIXELS) {
    const scale = Math.sqrt(MAX_FULL_RES_PIXELS / pixels);
    oriented = oriented.resize({
      width: Math.max(1, Math.round((metadata.width ?? 1) * scale)),
      height: Math.max(1, Math.round((metadata.height ?? 1) * scale)),
      fit: 'fill',
    });
  }

  const { data, info } = await oriented.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
  return {
    sourceFormat: 'IMAGE',
    rasters: [
      {
        index: 0,
        png: data,
        width: info.width,
        height: info.height,
        rotationAppliedDeg: EXIF_ORIENTATION_DEGREES[orientation] ?? 0,
        textLayer: null,
      },
    ],
    pageCount: 1,
    pagesTruncated: false,
    textLayerUsed: false,
    knownDpi: null,
  };
}

/** EXIF orientation tag → the rotation sharp's `autoOrient()` applied, for the audit trail. */
const EXIF_ORIENTATION_DEGREES: Record<number, number> = {
  1: 0,
  2: 0,
  3: 180,
  4: 180,
  5: 90,
  6: 90,
  7: 270,
  8: 270,
};

async function decodeHeic(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const heicModule = await import('heic-convert');
    const convert = (heicModule as unknown as { default: typeof import('heic-convert') }).default;
    return await convert({ buffer: bytes, format: 'JPEG', quality: 0.95 });
  } catch {
    // sharp is built against libheif here; if it also cannot decode, the outer catch
    // turns it into a clean CORRUPT_FILE rejection rather than a 500.
    return await sharp(bytes, { failOn: 'error' }).jpeg({ quality: 95 }).toBuffer();
  }
}

/**
 * PDF handling for §11.1 #6-#10.
 *
 * pdf.js is loaded from the `legacy` build and lazily: the main build touches
 * `DOMMatrix` at module scope and throws on import under Node 25, and even the legacy
 * build is a several-megabyte parse that an image upload should not pay for.
 *
 * §11.5 #70 (malicious PDF with embedded JS) is satisfied structurally rather than by a
 * flag: pdf.js only executes document scripting when a `PDFScriptingManager` is wired
 * up, and we never construct one. We also never pass `password`, so a protected file
 * surfaces as a `PasswordException` instead of a decryption attempt (§11.1 #8).
 * `maxImageSize` caps the work an adversarial page can demand of the rasterizer.
 */
/**
 * `useSystemFonts: true` renders correctly on a dev machine with a normal font
 * installation, but a serverless container typically has none — text silently renders as
 * nothing rather than throwing, so a text-native PDF rasterizes to a blank page and OCR
 * then (correctly, given what it was handed) finds zero text. pdf.js ships its own
 * standard-font substitutes precisely so rendering does not depend on the host having
 * fonts installed; point at the copy inside `pdfjs-dist` rather than the OS.
 *
 * Resolving this is trickier than it looks, and `require.resolve` is a dead end either
 * way: a literal specifier (`require.resolve('pdfjs-dist/package.json')`) gets rewritten
 * by Turbopack's production bundler into its own numeric module-id lookup instead of a
 * real path (`TypeError: The "path" argument must be of type string. Received type
 * number`); a specifier assembled at runtime to dodge that — the trick that works for
 * zxing-wasm in tier-a-pdf417.ts — instead trips the dev bundler's static analysis
 * (`Cannot find module as expression is too dynamic`). Sidestepping `require` entirely is
 * the reliable option: Next server functions always run with `process.cwd()` at the
 * project/function root (confirmed against Vercel's own `/var/task/node_modules/...`
 * traces), so this is a plain path join with no module resolution involved at all.
 */
function resolveStandardFontDataUrl(): string {
  return `${path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts')}/`;
}

async function renderPdf(bytes: Uint8Array, options: NormalizeOptions): Promise<RenderResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const maxPages = options.maxPdfPages ?? PDF_MAX_PAGES;

  // pdf.js takes ownership of the buffer it is given, so hand it a copy — the caller's
  // bytes are still needed for the content hash and for any retry.
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: resolveStandardFontDataUrl(),
    maxImageSize: MAX_FULL_RES_PIXELS,
  });

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }

  try {
    const pageCount = pdf.numPages;
    const pagesToProcess = Math.min(pageCount, maxPages);

    const pages = [];
    let textCharacters = 0;
    for (let i = 1; i <= pagesToProcess; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      textCharacters += text.replace(/[^A-Za-z0-9]/g, '').length;
      pages.push({ page, text });
    }

    const textLayerUsed = textCharacters >= TEXT_LAYER_MIN_CHARS;
    const dpi = options.rasterDpi ?? (textLayerUsed ? TEXT_LAYER_RASTER_DPI : PDF_RASTER_DPI);
    // T0-D: a text-native PDF only needs pixels for the evidence crop, so page 1 only.
    const rasterCount = textLayerUsed ? 1 : pages.length;

    const canvasFactory = (pdf as unknown as { canvasFactory: CanvasFactoryLike }).canvasFactory;
    const rasters: RasterPage[] = [];
    for (let i = 0; i < pages.length; i++) {
      const { page, text } = pages[i];
      if (i < rasterCount) {
        // §11.1 #10 — `page.rotate` is the /Rotate flag; baking it into the viewport is
        // what applies it before anything downstream sees the pixels.
        const viewport = page.getViewport({ scale: dpi / 72, rotation: page.rotate });
        const canvasAndContext = canvasFactory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvas: canvasAndContext.canvas,
          canvasContext: canvasAndContext.context,
          viewport,
          background: '#ffffff',
        } as unknown as Parameters<typeof page.render>[0]).promise;
        const png = Buffer.from(canvasAndContext.canvas.toBuffer('image/png'));
        canvasFactory.destroy(canvasAndContext);
        rasters.push({
          index: i,
          png,
          width: Math.ceil(viewport.width),
          height: Math.ceil(viewport.height),
          rotationAppliedDeg: page.rotate,
          textLayer: text || null,
        });
      } else {
        // Text-only page: its text still reaches TB, it just has no raster of its own.
        rasters.push({
          index: i,
          png: rasters[0].png,
          width: rasters[0].width,
          height: rasters[0].height,
          rotationAppliedDeg: page.rotate,
          textLayer: text || null,
        });
      }
      page.cleanup();
    }

    return {
      sourceFormat: 'PDF',
      rasters,
      pageCount,
      pagesTruncated: pageCount > pagesToProcess,
      textLayerUsed,
      knownDpi: dpi,
    };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

interface CanvasFactoryLike {
  create(
    width: number,
    height: number,
  ): { canvas: { toBuffer(mime: string): Uint8Array }; context: unknown };
  destroy(canvasAndContext: unknown): void;
}

function isPasswordError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'PasswordException'
  );
}

// ---------------------------------------------------------------------------
// Per-page finishing: perspective, metrics, the two output buffers
// ---------------------------------------------------------------------------

async function finishPage(
  raster: RasterPage,
  options: {
    downscaleLongEdge: number;
    correctPerspective: boolean;
    allowCroppedDetection: boolean;
    knownDpi: number | null;
  },
): Promise<NormalizedPage> {
  let png = raster.png;
  let width = raster.width;
  let height = raster.height;
  let perspectiveCorrected = false;

  const work = await grayscaleWorkRaster(png);
  let quad = detectDocumentQuad(work.gray, work.width, work.height);

  if (
    options.correctPerspective &&
    quad &&
    quad.maxCornerDeviationDeg > PERSPECTIVE_CORRECTION_MIN_DEG &&
    quad.coverage > 0.2 &&
    quad.coverage < 0.95 &&
    quad.edgesContacted < 2
  ) {
    const corrected = await applyPerspectiveCorrection(png, quad, work.scale);
    if (corrected) {
      png = corrected.png;
      width = corrected.width;
      height = corrected.height;
      perspectiveCorrected = true;
      quad = null; // the corrected page is rectangular by construction
    }
  }

  const metricSource = perspectiveCorrected ? await grayscaleWorkRaster(png) : work;
  const luminance = luminanceStats(metricSource.gray);
  const blur = laplacianVariance(metricSource.gray, metricSource.width, metricSource.height);
  const skew = perspectiveCorrected
    ? 0
    : estimateSkewAngle(metricSource.gray, metricSource.width, metricSource.height);
  const effectiveDpi = options.knownDpi ?? estimateEffectiveDpi(width, height);

  const quality: QualityMetrics = {
    laplacian_variance: Math.round(blur * 100) / 100,
    mean_luminance: Math.round(luminance.mean * 100) / 100,
    clipping_ratio: Math.round((luminance.highlightClipping + luminance.shadowClipping) * 10000) / 10000,
    skew_angle_deg: skew,
    effective_dpi: effectiveDpi,
  };

  const reasonCodes: ReasonCode[] = [];
  if (blur < BLUR_LAPLACIAN_FLOOR) reasonCodes.push('IMAGE_TOO_BLURRY');
  if (luminance.highlightClipping > GLARE_HIGHLIGHT_RATIO) reasonCodes.push('GLARE_OBSCURES_FIELD');
  if (luminance.mean < DARK_MEAN_LUMINANCE || luminance.stddev < LOW_CONTRAST_STDDEV) {
    reasonCodes.push('POOR_CONTRAST');
  }
  if (Math.abs(skew) > EXTREME_SKEW_DEG) reasonCodes.push('EXTREME_SKEW');
  if (effectiveDpi < MIN_EFFECTIVE_DPI) reasonCodes.push('RESOLUTION_TOO_LOW');
  // §11.2 #21. Only for camera input: a PDF page is complete by definition, and a
  // full-bleed scan or screenshot legitimately runs to every edge, which is why this
  // needs three heavily-contacted edges rather than one.
  if (options.allowCroppedDetection && quad && quad.edgesContacted >= 3 && quad.coverage > 0.85) {
    reasonCodes.push('DOCUMENT_CROPPED');
  }

  const downscaledImage = sharp(png).resize({
    width: options.downscaleLongEdge,
    height: options.downscaleLongEdge,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const downscaled = await downscaledImage.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });

  return {
    index: raster.index,
    fullResolution: png,
    fullWidth: width,
    fullHeight: height,
    downscaled: downscaled.data,
    downscaledWidth: downscaled.info.width,
    downscaledHeight: downscaled.info.height,
    rotationAppliedDeg: raster.rotationAppliedDeg,
    perspectiveCorrected,
    textLayer: raster.textLayer,
    quality,
    reasonCodes,
  };
}

/**
 * Crop the full-resolution page to a normalized region, then downscale that crop the same
 * way `finishPage` downscales the whole page. Used to give TC a focused view of the actual
 * document instead of a large, cluttered scan (see `estimateMachineReadableZone` in
 * tier-b-ocr.ts) — cropping BEFORE downscaling matters, not after: the point is more
 * effective pixels on the part that matters, not just a smaller field of view at the same
 * detail the full-page downscale already had.
 */
export async function cropAndDownscale(
  fullResolution: Buffer,
  box: BBox,
  longEdge: number,
): Promise<Buffer> {
  const { width, height } = await sharp(fullResolution).metadata();
  if (!width || !height) return fullResolution;

  const [x0, y0, x1, y1] = box;
  const left = Math.max(0, Math.round(x0 * width));
  const top = Math.max(0, Math.round(y0 * height));
  const cropWidth = Math.min(width - left, Math.round((x1 - x0) * width));
  const cropHeight = Math.min(height - top, Math.round((y1 - y0) * height));
  if (cropWidth <= 0 || cropHeight <= 0) return fullResolution;

  const cropped = sharp(fullResolution).extract({ left, top, width: cropWidth, height: cropHeight });
  const resized = cropped.resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true });
  return resized.jpeg({ quality: 85 }).toBuffer();
}

/**
 * Grayscale plane normalized to `QUALITY_WORK_LONG_EDGE`, plus the scale factor back to
 * full resolution. Every metric and the quad detector run on this, which is what makes
 * the thresholds above resolution-independent and therefore meaningful.
 */
async function grayscaleWorkRaster(
  png: Buffer,
): Promise<{ gray: Uint8Array; width: number; height: number; scale: number }> {
  const { data, info } = await sharp(png)
    .greyscale()
    .resize({
      width: QUALITY_WORK_LONG_EDGE,
      height: QUALITY_WORK_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const source = await sharp(png).metadata();
  const scale = (source.width ?? info.width) / info.width;
  return { gray: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, scale };
}

async function applyPerspectiveCorrection(
  png: Buffer,
  quad: DocumentQuad,
  scale: number,
): Promise<{ png: Buffer; width: number; height: number } | null> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scaled = quad.corners.map((corner) => ({
    x: Math.min(info.width - 1, Math.max(0, corner.x * scale)),
    y: Math.min(info.height - 1, Math.max(0, corner.y * scale)),
  })) as [Point, Point, Point, Point];

  const warped = warpPerspective(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
    info.channels,
    scaled,
  );
  if (!warped) return null;

  const out = await sharp(Buffer.from(warped.data), {
    raw: { width: warped.width, height: warped.height, channels: info.channels as 1 | 2 | 3 | 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { png: out, width: warped.width, height: warped.height };
}
