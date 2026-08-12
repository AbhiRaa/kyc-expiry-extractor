/**
 * Effective-resolution estimation — pure, framework-agnostic, zero Node-specific imports
 * on purpose. `src/pipeline/normalize.ts` (the T0-C low-resolution guard, server-side)
 * and `src/components/UploadZone.tsx` (the client-side upload-prep warning) both need the
 * exact same formula and the exact same thresholds; splitting it out here means the
 * client can warn *before* upload using the identical math the server will actually judge
 * it by, instead of a second, hand-guessed floor that could silently drift from the real
 * one (the same reasoning `src/lib/reviewer-economics.ts` already applies elsewhere).
 */

/** §11.1 #12. A trigger for the resolution check, not a rejection on its own (T0-C). */
export const MIN_FILE_BYTES = 50 * 1024;

/** Below this, PDF417 will not decode and the printed text is marginal (§11.2 #18). */
export const MIN_EFFECTIVE_DPI = 150;

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

/** Mirrors T0-C's own combined trigger (`normalize.ts`): a small file is only actually a
 *  resolution problem once the pixels agree it's too few for the physical page it's
 *  claiming to be. Either signal alone is too weak — a large, low-quality JPEG can be
 *  under MIN_FILE_BYTES at a perfectly adequate DPI, and vice versa. */
export function looksTooLowResolution(widthPx: number, heightPx: number, bytes: number): boolean {
  return bytes < MIN_FILE_BYTES && estimateEffectiveDpi(widthPx, heightPx) < MIN_EFFECTIVE_DPI;
}
