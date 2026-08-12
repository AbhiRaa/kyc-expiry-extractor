/**
 * Stage -1 admission gate tests.
 *
 * Every raster here is a hand-built `Uint8Array` grayscale plane, not a round-tripped
 * PNG — the signals operate directly on that shape (`grayscaleWorkRaster`'s output), so
 * constructing it directly is both faster and gives exact control over the pixel values
 * the calibration constants are actually being tested against.
 *
 * The single most important test in this file is `describe('signal 2 — the DL accent-
 * band guardrail')`: a single uniform edge band — exactly what every driving licence's
 * solid-colour header row looks like (see generate-corpus.ts) — must never be enough
 * alone to reject. Getting this wrong is a corpus-wide false-reject regression on the
 * most common in-domain class, not a cosmetic bug.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OcrPage } from './tier-b-ocr';
import {
  GATE_KEYWORD_EXCLUSIONS,
  GATE_KEYWORDS,
  countTextBands,
  evaluateDocumentLikeness,
  evaluateScreenCapture,
  evaluatePositiveDomainSignal,
  findGateKeywordHit,
  rowInkHistogram,
} from './gate';
import { CLASS_KEYWORDS } from './classify';

function solidRaster(width: number, height: number, value: number): Uint8Array {
  return new Uint8Array(width * height).fill(value);
}

/** A raster with `count` horizontal dark stripes of `stripeHeight` rows, each separated
 *  by a light gap, against a light background — a cheap stand-in for "printed text
 *  lines," which is all `rowInkHistogram`/`countTextBands` actually look at. */
function stripedRaster(
  width: number,
  height: number,
  stripes: Array<{ start: number; height: number; darkFraction: number }>,
): Uint8Array {
  const gray = new Uint8Array(width * height).fill(230);
  for (const stripe of stripes) {
    const darkWidth = Math.round(width * stripe.darkFraction);
    for (let y = stripe.start; y < stripe.start + stripe.height && y < height; y++) {
      const rowStart = y * width;
      for (let x = 0; x < darkWidth; x++) gray[rowStart + x] = 40;
    }
  }
  return gray;
}

/** A single solid-colour band across the top of an otherwise varied/textured frame —
 *  exactly the shape of a driving licence's accent-coloured header row over its content
 *  area (see generate-corpus.ts's `rect(0, 0, w, 96, s.accent)` and similar). */
function singleTopBandRaster(width: number, height: number, bandHeight: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (y < bandHeight) {
        gray[rowStart + x] = 60; // solid accent colour
      } else {
        // Varied, non-uniform "content" — deterministic pseudo-texture, not flat.
        gray[rowStart + x] = 150 + ((x * 37 + y * 53) % 80);
      }
    }
  }
  return gray;
}

/** Two stacked bands of clearly different shades directly below each other at the top,
 *  each sized to comfortably fill gate.ts's fixed comparison zones (0-18%, 18-36% of the
 *  frame) — the CRM-screenshot shape (a menu bar directly above a toolbar of a different
 *  colour). Real content only starts well past both zones, at 40%. */
function stackedTopBandsRaster(width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  // Matches gate.ts's own CHROME_ZONE_A_FRACTION/CHROME_ZONE_B_FRACTION exactly, so each
  // band fills its comparison zone cleanly rather than bleeding across the boundary.
  const zoneAEnd = Math.round(height * 0.18);
  const zoneBEnd = Math.round(height * 0.36);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      // High-contrast on purpose against the (also high-variance) textured content below
      // — a band whose brightness happens to land near the frame's own overall average
      // is a real, narrow failure mode of a mean-contrast check; real UI chrome (a dark
      // status bar, a light toolbar) is usually deliberately high-contrast, not blended.
      if (y < zoneAEnd) gray[rowStart + x] = 30;
      else if (y < zoneBEnd) gray[rowStart + x] = 225;
      else gray[rowStart + x] = 100 + ((x * 37 + y * 53) % 80);
    }
  }
  return gray;
}

describe('signal 1 — document-likeness', () => {
  it('confidently rejects a flat, featureless frame (a wall or a wallpaper)', () => {
    const width = 100;
    const height = 100;
    const gray = solidRaster(width, height, 200);
    const result = evaluateDocumentLikeness({ gray, width, height }, null, false);
    expect(result.outcome).toBe('CONFIDENT_NEGATIVE');
  });

  it('does not reject a frame with structured text-row bands', () => {
    const width = 400;
    const height = 500;
    const gray = stripedRaster(width, height, [
      { start: 40, height: 20, darkFraction: 0.4 },
      { start: 120, height: 20, darkFraction: 0.35 },
      { start: 200, height: 20, darkFraction: 0.3 },
    ]);
    const result = evaluateDocumentLikeness({ gray, width, height }, null, false);
    expect(result.outcome).toBe('UNCERTAIN');
  });

  it('does not reject when a document-shaped quad was already found, even if the row structure is weak', () => {
    const width = 100;
    const height = 100;
    const gray = solidRaster(width, height, 200);
    const quad = {
      corners: [
        { x: 0, y: 0 },
        { x: 99, y: 0 },
        { x: 99, y: 99 },
        { x: 0, y: 99 },
      ] as [
        { x: number; y: number },
        { x: number; y: number },
        { x: number; y: number },
        { x: number; y: number },
      ],
      coverage: 0.9,
      borderContact: 0.1,
      edgesContacted: 0,
      maxCornerDeviationDeg: 0,
    };
    const result = evaluateDocumentLikeness({ gray, width, height }, quad, false);
    expect(result.outcome).toBe('UNCERTAIN');
  });

  it('countTextBands counts contiguous text-density runs, not raw row count', () => {
    const width = 200;
    const height = 300;
    const gray = stripedRaster(width, height, [
      { start: 10, height: 15, darkFraction: 0.4 },
      { start: 60, height: 15, darkFraction: 0.4 },
    ]);
    const rows = rowInkHistogram(gray, width, height);
    expect(countTextBands(rows)).toBe(2);
  });
});

describe('signal 2 — the DL accent-band guardrail (docs/DECISIONS.md A3)', () => {
  it('never confidently rejects a single uniform edge band, even under worst-case screen-native conditions', () => {
    const width = 800;
    const height = 500;
    const gray = singleTopBandRaster(width, height, 80);
    // exifBytesLength: null forces `screenNative = true` via the EXIF-absent path — the
    // most adversarial case for this guardrail, since the only thing standing between a
    // real driving licence photo and a false reject is the appChromePresent conjunction.
    const result = evaluateScreenCapture({ gray, width, height }, width, height, null);
    expect(result.outcome).toBe('UNCERTAIN');
  });

  it('confidently rejects two stacked bands of different shades plus screen-native evidence', () => {
    const width = 1920;
    const height = 1080; // a real display resolution — resolutionMatches=true
    const gray = stackedTopBandsRaster(width, height);
    const result = evaluateScreenCapture({ gray, width, height }, width, height, null);
    expect(result.outcome).toBe('CONFIDENT_NEGATIVE');
  });

  it('does not reject genuine application chrome when the dimensions look like an ordinary camera photo', () => {
    // Same chrome structure as the case above, but at a camera sensor resolution with a
    // real EXIF block present — screenNative is false either way, so appChromePresent
    // alone must not be enough.
    const width = 3024;
    const height = 4032;
    const gray = stackedTopBandsRaster(width, height);
    const result = evaluateScreenCapture({ gray, width, height }, width, height, 4000);
    expect(result.outcome).toBe('UNCERTAIN');
  });
});

describe('signal 3 — positive domain signal', () => {
  function emptyOcrPage(): OcrPage {
    return { tokens: [], width: 700, height: 700, meanConfidence: null };
  }

  it('finds a keyword match via the embedded text layer without ever calling OCR', async () => {
    const ocr = vi.fn(async () => emptyOcrPage());
    const result = await evaluatePositiveDomainSignal({
      fullResolution: Buffer.alloc(0),
      fullWidth: 100,
      fullHeight: 100,
      downscaled: Buffer.from([0, 1, 2, 3]),
      quad: null,
      perspectiveCorrected: false,
      exifBytesLength: null,
      textLayer: 'UNITED STATES OF AMERICA PASSPORT No. 123456789',
      ocr,
    });
    expect(result.outcome).toBe('CONFIDENT_POSITIVE');
    expect(ocr).not.toHaveBeenCalled();
  });

  it('finds a keyword match via the low-resolution OCR presurvey', async () => {
    const ocr = vi.fn(async (): Promise<OcrPage> => ({
      tokens: [
        { text: 'DRIVER', box: { x0: 0, y0: 0, x1: 10, y1: 10 }, confidence: 90, line: 0 },
        { text: 'LICENSE', box: { x0: 12, y0: 0, x1: 25, y1: 10 }, confidence: 90, line: 0 },
      ],
      width: 700,
      height: 700,
      meanConfidence: 90,
    }));
    const result = await evaluatePositiveDomainSignal({
      fullResolution: Buffer.alloc(0),
      fullWidth: 100,
      fullHeight: 100,
      downscaled: Buffer.from([0, 1, 2, 3]),
      quad: null,
      perspectiveCorrected: false,
      exifBytesLength: null,
      textLayer: null,
      ocr,
    });
    expect(result.outcome).toBe('CONFIDENT_POSITIVE');
    expect(ocr).toHaveBeenCalledOnce();
  });

  it('returns NOT_FOUND, never a negative outcome, when nothing is found', async () => {
    const ocr = vi.fn(async () => emptyOcrPage());
    const result = await evaluatePositiveDomainSignal({
      fullResolution: Buffer.alloc(0),
      fullWidth: 100,
      fullHeight: 100,
      downscaled: Buffer.from([0, 1, 2, 3]),
      quad: null,
      perspectiveCorrected: false,
      exifBytesLength: null,
      textLayer: 'a wall, or a wallpaper, or a selfie',
      ocr,
    });
    expect(result.outcome).toBe('NOT_FOUND');
  });
});

describe('gate keyword list — the exclusion set (client feedback: no generic terms)', () => {
  it('excludes exactly the terms that a receipt/invoice would trip, or that are combination-only', () => {
    for (const term of GATE_KEYWORD_EXCLUSIONS) {
      expect(findGateKeywordHit(term)).toBeNull();
    }
  });

  it('never drops a non-excluded EMPLOYMENT_LETTER or MEDICAL_INSURANCE_CARD term — docs 13/19/20/21 in the eval only resolve via TC_VLM and would regress to ADMIT_LIMITED if these classes lost all their keyword signal', () => {
    for (const group of CLASS_KEYWORDS) {
      if (group.cls !== 'EMPLOYMENT_LETTER' && group.cls !== 'MEDICAL_INSURANCE_CARD') continue;
      const gateGroup = GATE_KEYWORDS.find((g) => g.cls === group.cls);
      expect(gateGroup, `no GATE_KEYWORDS group for ${group.cls}`).toBeDefined();
      for (const term of group.terms) {
        if (GATE_KEYWORD_EXCLUSIONS.has(term)) continue; // deliberately excluded, not a regression
        expect(gateGroup?.terms, `${group.cls} term "${term}" was filtered out of the gate's keyword list`).toContain(
          term,
        );
      }
      // The real regression this test guards against: a class losing ALL of its signal.
      expect(gateGroup?.terms.length, `${group.cls} has no gate keywords left at all`).toBeGreaterThan(0);
    }
  });
});
