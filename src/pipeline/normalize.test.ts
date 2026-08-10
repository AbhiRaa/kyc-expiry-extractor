/**
 * T0 normalization tests.
 *
 * Every fixture is generated programmatically with `sharp` or `pdfkit` inside this
 * file. Nothing is read from disk: an eval fixture that drifts out of sync with the
 * assertion it supports is worse than no test, and a normalization suite that cannot
 * run from a clean clone fails §16's "reproduces the published numbers" bar.
 */

import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  BLUR_LAPLACIAN_FLOOR,
  DOWNSCALE_LONG_EDGE,
  MIN_FILE_BYTES,
  SUPPORTED_MIME_TYPES,
  detectDocumentQuad,
  estimateEffectiveDpi,
  estimateSkewAngle,
  isNormalized,
  laplacianVariance,
  luminanceStats,
  normalizeAll,
  normalizeDocument,
  rejectionToTierResult,
  solveInverseHomography,
  sniffMime,
  tryAllOrientations,
  warpPerspective,
  type NormalizedDocument,
  type NormalizedPage,
  type NormalizeRejection,
} from './normalize';

const TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** High-frequency detail, so the Laplacian focus measure has something to measure. */
function checkerboardRaw(width: number, height: number, cell = 8): Buffer {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const value = on ? 240 : 15;
      const i = (y * width + x) * 3;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
  }
  return data;
}

function fromRaw(data: Buffer, width: number, height: number) {
  return sharp(data, { raw: { width, height, channels: 3 } });
}

async function checkerboardPng(width = 1200, height = 800, cell = 8): Promise<Buffer> {
  return fromRaw(checkerboardRaw(width, height, cell), width, height).png().toBuffer();
}

/** Dark horizontal bands — the structure a projection-profile skew estimator locks onto. */
function stripesRaw(width: number, height: number, period = 24, thickness = 8): Buffer {
  const data = Buffer.alloc(width * height * 3, 250);
  for (let y = 0; y < height; y++) {
    if (y % period >= thickness) continue;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = 20;
      data[i + 1] = 20;
      data[i + 2] = 20;
    }
  }
  return data;
}

async function grayPlane(png: Buffer, longEdge = 1000) {
  const { data, info } = await sharp(png)
    .greyscale()
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { gray: new Uint8Array(data), width: info.width, height: info.height };
}

async function makePdf(build: (doc: PDFKit.PDFDocument) => void, options: PDFKit.PDFDocumentOptions = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: [220, 320], margin: 20, ...options });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  build(doc);
  doc.end();
  return done;
}

function expectRejected(outcome: Awaited<ReturnType<typeof normalizeDocument>>): NormalizeRejection {
  expect(isNormalized(outcome)).toBe(false);
  return outcome as NormalizeRejection;
}

function expectNormalized(outcome: Awaited<ReturnType<typeof normalizeDocument>>): NormalizedDocument {
  if (!isNormalized(outcome)) {
    throw new Error(`expected success, got ${outcome.kind}: ${outcome.message}`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// §7.1 / §11.1 #1 — the declared type is evidence, never authority
// ---------------------------------------------------------------------------

describe('magic-byte sniffing (§7.1)', () => {
  it('accepts a PNG that claims to be a .docx, because the bytes say PNG', async () => {
    const png = await checkerboardPng();
    const outcome = await normalizeDocument(png, {
      declaredName: 'proof-of-address.docx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const document = expectNormalized(outcome);
    expect(document.detectedMime).toBe('image/png');
    // The lie is preserved for the audit trail, it just has no authority.
    expect(document.declaredName).toBe('proof-of-address.docx');
    expect(document.declaredMime).toContain('wordprocessingml');
  }, TIMEOUT);

  it('rejects a zip that claims to be a .jpg, for the same reason', async () => {
    // Minimal local-file-header signature — enough for a magic-byte sniff, which is the
    // point: an attacker renaming a payload cannot get it past the gate.
    const zip = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(2048, 0x41)]);
    const rejection = expectRejected(
      await normalizeDocument(zip, { declaredName: 'licence.jpg', declaredMime: 'image/jpeg' }),
    );
    expect(rejection.kind).toBe('UNSUPPORTED_TYPE');
    expect(rejection.detectedMime).toBe('application/zip');
    // G10 — a dedicated code, not the CLASS_UNRECOGNIZED catch-all: the file was never
    // classifiable as a document at all, which is a different fact than "unreadable".
    expect(rejection.reasonCodes).toContain('UNSUPPORTED_TYPE');
  }, TIMEOUT);

  it('rejects plain text, which has no magic signature at all', async () => {
    const text = Buffer.from('EXPIRY DATE: 2030-04-23\n'.repeat(400), 'utf8');
    const rejection = expectRejected(await normalizeDocument(text, { declaredName: 'notes.txt' }));
    expect(rejection.kind).toBe('UNSUPPORTED_TYPE');
    expect(rejection.detectedMime).toBeNull();
  }, TIMEOUT);

  it('reports HEIC and the other mobile formats as supported (§11.1 #3-#5)', () => {
    for (const mime of ['image/heic', 'image/heif', 'image/webp', 'image/tiff', 'image/gif']) {
      expect(SUPPORTED_MIME_TYPES).toContain(mime);
    }
  });

  it('sniffs an empty buffer as nothing rather than throwing', async () => {
    expect(await sniffMime(new Uint8Array(0))).toEqual({ mime: null, ext: null, supported: false });
  });
});

// ---------------------------------------------------------------------------
// §7.2 / §11.1 #15 — the highest-value single fix in the pipeline
// ---------------------------------------------------------------------------

describe('EXIF orientation (§7.2, §11.1 #15)', () => {
  it('actually rotates the pixels, not just the metadata', async () => {
    const width = 1200;
    const height = 750;
    const landscape = await fromRaw(checkerboardRaw(width, height), width, height)
      .withMetadata({ orientation: 6 }) // "rotate 90° CW to display"
      .jpeg({ quality: 92 })
      .toBuffer();

    // Untreated, this is what breaks TA silently: the stored raster is still landscape.
    const stored = await sharp(landscape).metadata();
    expect([stored.width, stored.height]).toEqual([width, height]);

    const document = expectNormalized(
      await normalizeDocument(landscape, { minBytes: 0, correctPerspective: false }),
    );
    expect([document.primary.fullWidth, document.primary.fullHeight]).toEqual([height, width]);
    expect(document.primary.rotationAppliedDeg).toBe(90);

    // And the orientation tag is consumed, so nothing downstream double-applies it.
    expect((await sharp(document.primary.fullResolution).metadata()).orientation).toBeUndefined();
  }, TIMEOUT);

  it('leaves an already-upright image alone', async () => {
    const png = await checkerboardPng(1200, 750);
    const document = expectNormalized(
      await normalizeDocument(png, { minBytes: 0, correctPerspective: false }),
    );
    expect([document.primary.fullWidth, document.primary.fullHeight]).toEqual([1200, 750]);
    expect(document.primary.rotationAppliedDeg).toBe(0);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// §7.4 — two outputs from every input
// ---------------------------------------------------------------------------

describe('dual output (§7.4)', () => {
  it('keeps full resolution for TA and caps the VLM copy at 2000 px', async () => {
    const png = await checkerboardPng(2600, 1600, 10);
    const document = expectNormalized(
      await normalizeDocument(png, { minBytes: 0, correctPerspective: false }),
    );
    expect(document.primary.fullWidth).toBe(2600);
    expect(Math.max(document.primary.downscaledWidth, document.primary.downscaledHeight)).toBe(
      DOWNSCALE_LONG_EDGE,
    );
    // Lossless for the barcode/MRZ path, lossy for the VLM path.
    expect((await sharp(document.primary.fullResolution).metadata()).format).toBe('png');
    expect((await sharp(document.primary.downscaled).metadata()).format).toBe('jpeg');
  }, TIMEOUT);

  it('never upscales a small source into the VLM copy', async () => {
    const png = await checkerboardPng(900, 600);
    const document = expectNormalized(
      await normalizeDocument(png, { minBytes: 0, correctPerspective: false }),
    );
    expect(document.primary.downscaledWidth).toBe(900);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// §7.5 / §11.2 — quality metrics
// ---------------------------------------------------------------------------

describe('quality metrics (§7.5, §11.2)', () => {
  it('fires IMAGE_TOO_BLURRY on a blurred page and not on a sharp one', async () => {
    const sharpPage = await checkerboardPng(1200, 800, 10);
    const blurredPage = await fromRaw(checkerboardRaw(1200, 800, 10), 1200, 800)
      .blur(9)
      .png()
      .toBuffer();

    const clean = expectNormalized(
      await normalizeDocument(sharpPage, { minBytes: 0, correctPerspective: false }),
    );
    const blurred = expectNormalized(
      await normalizeDocument(blurredPage, { minBytes: 0, correctPerspective: false }),
    );

    expect(clean.quality.laplacian_variance).toBeGreaterThan(BLUR_LAPLACIAN_FLOOR);
    expect(clean.reasonCodes).not.toContain('IMAGE_TOO_BLURRY');

    expect(blurred.quality.laplacian_variance).toBeLessThan(BLUR_LAPLACIAN_FLOOR);
    expect(blurred.reasonCodes).toContain('IMAGE_TOO_BLURRY');

    // T0-A: blur is surfaced, never a rejection. The confidence fusion prices it.
    expect(blurred.ok).toBe(true);
  }, TIMEOUT);

  it('reports luminance on the 8-bit scale and flags glare as clipping', async () => {
    const width = 1200;
    const height = 750;
    const glared = checkerboardRaw(width, height, 10);
    // Blow out the middle third, the way a laminate flash reflection does (§11.2 #17).
    for (let y = Math.floor(height / 3); y < Math.floor((2 * height) / 3); y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        glared[i] = 255;
        glared[i + 1] = 255;
        glared[i + 2] = 255;
      }
    }
    const document = expectNormalized(
      await normalizeDocument(await fromRaw(glared, width, height).png().toBuffer(), {
        minBytes: 0,
        correctPerspective: false,
      }),
    );
    expect(document.quality.mean_luminance).toBeGreaterThan(100);
    expect(document.quality.mean_luminance).toBeLessThanOrEqual(255);
    expect(document.quality.clipping_ratio).toBeGreaterThan(0.3);
    expect(document.reasonCodes).toContain('GLARE_OBSCURES_FIELD');
  }, TIMEOUT);

  it('measures skew against a known rotation (§11.2 #19)', async () => {
    const level = await fromRaw(stripesRaw(900, 900), 900, 900).png().toBuffer();
    const tilted = await fromRaw(stripesRaw(900, 900), 900, 900)
      .rotate(6, { background: '#ffffff' })
      .png()
      .toBuffer();

    const levelPlane = await grayPlane(level);
    const tiltedPlane = await grayPlane(tilted);

    expect(
      Math.abs(estimateSkewAngle(levelPlane.gray, levelPlane.width, levelPlane.height)),
    ).toBeLessThan(1);
    // Sign convention, pinned here because it is the kind of thing that silently
    // inverts during a refactor: `sharp.rotate(+6)` turns the content clockwise, the
    // estimator reports +6, and levelling the page means rotating by -6.
    expect(
      Math.abs(estimateSkewAngle(tiltedPlane.gray, tiltedPlane.width, tiltedPlane.height) - 6),
    ).toBeLessThan(1.5);
  }, TIMEOUT);

  it('is scale-invariant enough for the DPI estimate to mean something', () => {
    // ID-1 card at 600 px on the long edge is roughly 178 DPI.
    expect(estimateEffectiveDpi(600, 378)).toBeGreaterThan(150);
    expect(estimateEffectiveDpi(600, 378)).toBeLessThan(200);
    // The same card photographed at 300 px is under the PDF417 floor (§11.2 #18).
    expect(estimateEffectiveDpi(300, 189)).toBeLessThan(150);
    // A Letter-shaped page is measured against the paper long edge, not the card one.
    expect(estimateEffectiveDpi(2550, 3300)).toBeGreaterThan(250);
  });

  it('computes a Laplacian variance of zero on a featureless plane', () => {
    expect(laplacianVariance(new Uint8Array(100 * 100).fill(128), 100, 100)).toBe(0);
    expect(luminanceStats(new Uint8Array(100).fill(255))).toMatchObject({
      mean: 255,
      highlightClipping: 1,
      shadowClipping: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// §11.1 #2 / #12 — clean rejection paths
// ---------------------------------------------------------------------------

describe('rejection paths (§11.1)', () => {
  it('rejects a zero-byte file without a stack trace', async () => {
    const rejection = expectRejected(await normalizeDocument(new Uint8Array(0)));
    expect(rejection.kind).toBe('EMPTY_FILE');
    expect(rejection.message).toBe('The uploaded file is empty.');
    expect(rejection.message).not.toMatch(/Error|at \w+ \(/);
  }, TIMEOUT);

  it('rejects a file that sniffs as JPEG but cannot be decoded', async () => {
    // A valid JFIF header followed by garbage — the shape of a truncated upload.
    const corrupt = Buffer.concat([
      Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'),
      Buffer.alloc(4096, 0x41),
    ]);
    expect((await sniffMime(corrupt)).mime).toBe('image/jpeg');

    const rejection = expectRejected(await normalizeDocument(corrupt));
    expect(rejection.kind).toBe('CORRUPT_FILE');
    expect(rejection.detectedMime).toBe('image/jpeg');
    expect(rejection.reasonCodes).toContain('CORRUPT_FILE'); // G10
    // §11.1 #2 — nothing from libvips reaches the client.
    expect(rejection.message).not.toMatch(/vips|VipsJpeg|premature/i);
  }, TIMEOUT);

  it('rejects a sub-50 KB file whose pixels confirm it is too low-res (§11.1 #12)', async () => {
    const tiny = await fromRaw(checkerboardRaw(220, 140, 4), 220, 140).jpeg().toBuffer();
    expect(tiny.byteLength).toBeLessThan(MIN_FILE_BYTES);

    const rejection = expectRejected(await normalizeDocument(tiny));
    expect(rejection.kind).toBe('RESOLUTION_TOO_LOW');
    expect(rejection.reasonCodes).toEqual(['RESOLUTION_TOO_LOW']);
  }, TIMEOUT);

  it('admits a sub-50 KB file that is nonetheless high resolution (T0-C, §11.2 #26)', async () => {
    // A screenshot of a document compresses to almost nothing and is the *easiest*
    // case in the whole catalogue. Rejecting it on byte count alone would be a
    // self-inflicted coverage loss.
    const screenshot = await sharp({
      create: { width: 2400, height: 1512, channels: 3, background: '#f4f4f4' },
    })
      .png()
      .toBuffer();
    expect(screenshot.byteLength).toBeLessThan(MIN_FILE_BYTES);

    const document = expectNormalized(await normalizeDocument(screenshot));
    expect(document.quality.effective_dpi).toBeGreaterThan(150);
  }, TIMEOUT);

  it('converts a rejection into the abstention the router already understands (§5)', async () => {
    const rejection = expectRejected(await normalizeDocument(new Uint8Array(0)));
    const tier = rejectionToTierResult(rejection);
    expect(tier).toMatchObject({ tier: 'NONE', abstained: true, candidates: [], cost_usd: 0 });
    expect(tier.reason_codes).toContain('CLASS_UNRECOGNIZED');
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// §11.1 #4 / #5 — format conversion
// ---------------------------------------------------------------------------

describe('format conversion (§11.1 #4-#5)', () => {
  it('takes frame 0 of an animated GIF', async () => {
    const width = 600;
    const height = 400;
    const frames = Buffer.alloc(width * height * 2 * 3);
    frames.fill(220, 0, width * height * 3); // frame 0: light
    frames.fill(30, width * height * 3); // frame 1: dark
    const gif = await sharp(frames, {
      raw: { width, height: height * 2, channels: 3, pageHeight: height },
    })
      .gif()
      .toBuffer();
    expect((await sharp(gif, { pages: -1 }).metadata()).pages).toBe(2);

    const document = expectNormalized(await normalizeDocument(gif, { correctPerspective: false }));
    expect([document.primary.fullWidth, document.primary.fullHeight]).toEqual([width, height]);
    // Frame 0 was the light one; a montage of both frames would average far darker.
    expect(document.quality.mean_luminance).toBeGreaterThan(200);
  }, TIMEOUT);

  it('converts WebP and TIFF to a lossless working raster', async () => {
    for (const encode of ['webp', 'tiff'] as const) {
      const encoded = await fromRaw(checkerboardRaw(1200, 800, 10), 1200, 800)[encode]().toBuffer();
      const document = expectNormalized(
        await normalizeDocument(encoded, { minBytes: 0, correctPerspective: false }),
      );
      expect([document.primary.fullWidth, document.primary.fullHeight]).toEqual([1200, 800]);
      expect((await sharp(document.primary.fullResolution).metadata()).format).toBe('png');
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// §11.1 #6 - #9 — PDF handling
// ---------------------------------------------------------------------------

describe('PDF handling (§11.1 #6-#10)', () => {
  it('caps a long document at the first three pages and says so', async () => {
    const pdf = await makePdf((doc) => {
      for (let i = 0; i < 12; i++) {
        if (i > 0) doc.addPage();
        doc.fontSize(11).text(`Statement page ${i + 1} of 12 — closing balance carried forward`, 20, 40);
      }
    });

    const document = expectNormalized(await normalizeDocument(pdf));
    expect(document.pageCount).toBe(12);
    expect(document.pages).toHaveLength(3);
    expect(document.pagesTruncated).toBe(true);
    expect(document.notes.join(' ')).toMatch(/first 3 of 12 pages/);
  }, TIMEOUT);

  it('respects a caller-supplied page cap', async () => {
    const pdf = await makePdf((doc) => {
      for (let i = 0; i < 4; i++) {
        if (i > 0) doc.addPage();
        doc.fontSize(11).text(`page ${i + 1} statement period opening balance`, 20, 40);
      }
    });
    const document = expectNormalized(await normalizeDocument(pdf, { maxPdfPages: 1 }));
    expect(document.pages).toHaveLength(1);
    expect(document.pagesTruncated).toBe(true);
  }, TIMEOUT);

  it('extracts the text layer of a text-native PDF instead of OCR-ing it (§11.1 #6)', async () => {
    const pdf = await makePdf((doc) => {
      doc.fontSize(11).text('ACME UTILITIES — billing period ends 04/23/2030, amount due $61.20', 20, 40);
    });
    const document = expectNormalized(await normalizeDocument(pdf));
    expect(document.textLayerUsed).toBe(true);
    expect(document.primary.textLayer).toContain('04/23/2030');
    expect(document.notes.join(' ')).toMatch(/text layer/);
    // Still produces both buffers — the contract needs an evidence crop either way.
    expect(document.primary.fullResolution.byteLength).toBeGreaterThan(0);
    expect(document.primary.downscaled.byteLength).toBeGreaterThan(0);
  }, TIMEOUT);

  it('rasterizes a scanned (text-free) PDF at 300 DPI (§11.1 #7)', async () => {
    const pdf = await makePdf((doc) => {
      doc.rect(20, 20, 180, 120).fill('#333333');
      doc.rect(20, 160, 180, 60).fill('#888888');
    });
    const document = expectNormalized(await normalizeDocument(pdf));
    expect(document.textLayerUsed).toBe(false);
    expect(document.quality.effective_dpi).toBe(300);
    // 220 pt wide at 300 DPI ≈ 917 px.
    expect(document.primary.fullWidth).toBeGreaterThan(900);
  }, TIMEOUT);

  it('detects a password-protected PDF without attempting to crack it (§11.1 #8)', async () => {
    const pdf = await makePdf((doc) => doc.text('confidential'), { userPassword: 'hunter2' });
    const rejection = expectRejected(await normalizeDocument(pdf));
    expect(rejection.kind).toBe('ENCRYPTED_PDF');
    expect(rejection.reasonCodes).toContain('ENCRYPTED_PDF'); // G10
    expect(rejection.message).toMatch(/password-protected/);
  }, TIMEOUT);

  it('never flags a PDF page as cropped — a page is complete by definition', async () => {
    const pdf = await makePdf((doc) => {
      doc.rect(0, 0, 220, 320).fill('#111111');
    });
    const document = expectNormalized(await normalizeDocument(pdf));
    expect(document.reasonCodes).not.toContain('DOCUMENT_CROPPED');
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// §11.1 #13 / #14 — several files, and the same file twice
// ---------------------------------------------------------------------------

describe('multi-file and idempotency (§11.1 #13-#14)', () => {
  it('normalizes a front/back pair and charges for a duplicate exactly once', async () => {
    const front = await checkerboardPng(1200, 750, 10);
    const back = await checkerboardPng(1200, 750, 14);

    const results = await normalizeAll([front, back, front], {
      minBytes: 0,
      correctPerspective: false,
    });
    expect(results).toHaveLength(3);
    // Same bytes ⇒ the same result object, not a second decode.
    expect(results[2]).toBe(results[0]);
    expect(results[1]).not.toBe(results[0]);

    const a = expectNormalized(results[0]);
    const b = expectNormalized(results[1]);
    expect(a.contentHash).toHaveLength(64);
    expect(a.contentHash).not.toBe(b.contentHash);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// §11.2 #19 / #20 — geometry
// ---------------------------------------------------------------------------

describe('geometry (§11.2 #19-#20)', () => {
  it('finds a document sitting on a contrasting background', async () => {
    const width = 800;
    const height = 600;
    const scene = Buffer.alloc(width * height * 3, 245);
    for (let y = 100; y < 500; y++) {
      for (let x = 150; x < 650; x++) {
        const i = (y * width + x) * 3;
        scene[i] = 40;
        scene[i + 1] = 40;
        scene[i + 2] = 40;
      }
    }
    const plane = await grayPlane(await fromRaw(scene, width, height).png().toBuffer(), 400);
    const quad = detectDocumentQuad(plane.gray, plane.width, plane.height);
    expect(quad).not.toBeNull();
    expect(quad!.coverage).toBeGreaterThan(0.3);
    expect(quad!.coverage).toBeLessThan(0.6);
    // A head-on rectangle has no corner deviation, so nothing should be warped.
    expect(quad!.maxCornerDeviationDeg).toBeLessThan(3);
    expect(quad!.edgesContacted).toBe(0);
  }, TIMEOUT);

  it('leaves a head-on capture unwarped', async () => {
    const width = 900;
    const height = 700;
    const scene = Buffer.alloc(width * height * 3, 250);
    const card = checkerboardRaw(600, 380, 8);
    for (let y = 0; y < 380; y++) {
      for (let x = 0; x < 600; x++) {
        const dst = ((y + 160) * width + (x + 150)) * 3;
        const src = (y * 600 + x) * 3;
        scene[dst] = card[src];
        scene[dst + 1] = card[src + 1];
        scene[dst + 2] = card[src + 2];
      }
    }
    const document = expectNormalized(
      await normalizeDocument(await fromRaw(scene, width, height).png().toBuffer(), {
        minBytes: 0,
      }),
    );
    expect(document.primary.perspectiveCorrected).toBe(false);
    expect([document.primary.fullWidth, document.primary.fullHeight]).toEqual([width, height]);
  }, TIMEOUT);

  it('solves an identity homography exactly', () => {
    const square: [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const h = solveInverseHomography(square, square);
    expect(h).not.toBeNull();
    expect(h![0]).toBeCloseTo(1, 6);
    expect(h![4]).toBeCloseTo(1, 6);
    expect(h![6]).toBeCloseTo(0, 6);
    expect(h![7]).toBeCloseTo(0, 6);
  });

  it('rectifies a trapezoid back to a rectangle', () => {
    const width = 200;
    const height = 200;
    const rgb = new Uint8Array(width * height * 3).fill(255);
    // A dark band across the middle of the source.
    for (let y = 90; y < 110; y++) {
      for (let x = 0; x < width; x++) rgb[(y * width + x) * 3 + 1] = 0;
    }
    const warped = warpPerspective(rgb, width, height, 3, [
      { x: 40, y: 20 },
      { x: 160, y: 40 },
      { x: 170, y: 170 },
      { x: 30, y: 150 },
    ]);
    expect(warped).not.toBeNull();
    expect(warped!.width).toBeGreaterThan(100);
    expect(warped!.height).toBeGreaterThan(100);
    expect(warped!.data).toHaveLength(warped!.width * warped!.height * 3);
  });

  it('walks the four quarter turns and stops at the first that decodes (§11.2 #20)', async () => {
    const png = await checkerboardPng(800, 500, 10);
    const document = expectNormalized(
      await normalizeDocument(png, { minBytes: 0, correctPerspective: false }),
    );

    const attempted: number[] = [];
    const found = await tryAllOrientations(document.primary, async (variant) => {
      attempted.push(variant.rotationDeg);
      // Stand-in for TA: "the barcode only decodes upside down."
      return variant.rotationDeg === 180 ? 'DBA04232030' : null;
    });

    expect(found).toEqual({ rotationDeg: 180, result: 'DBA04232030' });
    expect(attempted).toEqual([0, 90, 180]); // 270 was never rendered — rotation is lazy
  }, TIMEOUT);

  it('returns null when no orientation yields a machine-readable region', async () => {
    const png = await checkerboardPng(600, 400, 10);
    const document = expectNormalized(
      await normalizeDocument(png, { minBytes: 0, correctPerspective: false }),
    );
    const attempted: number[] = [];
    const found = await tryAllOrientations(document.primary, async (variant) => {
      attempted.push(variant.rotationDeg);
      return null;
    });
    expect(found).toBeNull();
    expect(attempted).toEqual([0, 90, 180, 270]);
  }, TIMEOUT);

  it('rotates the full-resolution and downscaled copies together', async () => {
    const png = await checkerboardPng(2600, 1500, 10);
    const document = expectNormalized(
      await normalizeDocument(png, { minBytes: 0, correctPerspective: false }),
    );
    let quarter: NormalizedPage | null = null;
    await tryAllOrientations(document.primary, async (variant) => {
      if (variant.rotationDeg !== 90) return null;
      const full = await sharp(variant.fullResolution).metadata();
      const small = await sharp(variant.downscaled).metadata();
      expect([full.width, full.height]).toEqual([1500, 2600]);
      expect(Math.max(small.width ?? 0, small.height ?? 0)).toBe(DOWNSCALE_LONG_EDGE);
      quarter = document.primary;
      return 'ok';
    });
    expect(quarter).not.toBeNull();
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// §11.6 #75 — concurrency
// ---------------------------------------------------------------------------

describe('concurrency (§11.6 #75)', () => {
  it('produces identical results for the same bytes under concurrent invocation', async () => {
    const png = await checkerboardPng(1000, 640, 10);
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        normalizeDocument(png, { minBytes: 0, correctPerspective: false }),
      ),
    );
    const documents = outcomes.map(expectNormalized);
    const reference = documents[0];
    for (const document of documents) {
      expect(document.contentHash).toBe(reference.contentHash);
      expect(document.quality).toEqual(reference.quality);
      expect(document.primary.fullWidth).toBe(reference.primary.fullWidth);
    }
  }, TIMEOUT);
});
