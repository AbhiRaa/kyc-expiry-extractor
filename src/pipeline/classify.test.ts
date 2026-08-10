/**
 * T0 classification tests.
 *
 * `classifyDocument` is pure and synchronous, so these are plain table tests over a
 * signal bag — no fixtures, no images, no clock. The one integration test at the bottom
 * generates its raster with `sharp` to prove the `NormalizedPage` adaptor lines up with
 * what `normalize` actually emits.
 *
 * The assertions worth reading are the negative ones. A classifier that names a class
 * for every input scores well on a happy-path suite and badly in production, because
 * §7.6 spends a VLM call precisely on the cases this pass should have declined.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_CLASSES } from '@/types/contract';
import {
  CLASSIFY_CONCLUSIVE,
  classifyDocument,
  classifyNormalizedPage,
  isNonLatinDominant,
  shapeClass,
  type ClassificationSignals,
} from './classify';
import { isNormalized, normalizeDocument } from './normalize';

/** ID-1 at a realistic capture size, and a Letter page at 300 DPI. */
const CARD = { width: 1600, height: 1009 };
const PAGE = { width: 2550, height: 3300 };

const GOOD_QUALITY = {
  laplacian_variance: 900,
  mean_luminance: 150,
  clipping_ratio: 0.01,
  skew_angle_deg: 0.4,
  effective_dpi: 470,
};

const BLURRY_QUALITY = { ...GOOD_QUALITY, laplacian_variance: 20 };

function signals(overrides: Partial<ClassificationSignals> = {}): ClassificationSignals {
  return { ...CARD, quality: GOOD_QUALITY, ...overrides };
}

/** An AAMVA payload fragment; only element *presence* is ever inspected (T0-F). */
function aamva(elements: Record<string, string>): string {
  return `@\n\rANSI 636014090002DL00410288ZC03290015DL${Object.entries(elements)
    .map(([id, value]) => `${id}${value}`)
    .join('\n')}\n\r`;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('shape (§7.6)', () => {
  it('recognises ID-1 in both orientations, including the vertical under-21 layout', () => {
    expect(shapeClass(1600, 1009)).toBe('ID1_CARD');
    // §11.3 #29 — the same physical card, captured portrait.
    expect(shapeClass(1009, 1600)).toBe('ID1_CARD');
  });

  it('separates a card from paper, a square and a banner', () => {
    expect(shapeClass(2550, 3300)).toBe('PAPER'); // US Letter
    expect(shapeClass(2480, 3508)).toBe('PAPER'); // A4
    expect(shapeClass(1000, 1000)).toBe('SQUARE');
    expect(shapeClass(3000, 500)).toBe('UNUSUAL');
  });

  it('refuses to separate a passport data page from A4, because it cannot', () => {
    // 125x88 mm is 1.4205:1; A4 is 1.4142:1. Any threshold that calls one of these a
    // passport calls the other one a passport too. Both land in PAPER, and the
    // passport survives as a hypothesis rather than as a claim.
    expect(shapeClass(1750, 1232)).toBe('PAPER'); // passport data page
    expect(shapeClass(2480, 3508)).toBe('PAPER'); // A4

    const photo = classifyDocument(
      signals({ width: 1750, height: 1232, sourceFormat: 'IMAGE', hasMrz: false, hasPdf417: false }),
    );
    expect(photo.hypotheses).toContain('PASSPORT');

    // ...but a 4-page A4 PDF is paper, and offering PASSPORT there would be noise.
    const pdf = classifyDocument(
      signals({ ...PAGE, sourceFormat: 'PDF', pageCount: 3, hasMrz: false, hasPdf417: false }),
    );
    expect(pdf.hypotheses).not.toContain('PASSPORT');
  });
});

// ---------------------------------------------------------------------------
// Machine-readable evidence
// ---------------------------------------------------------------------------

describe('machine-readable evidence', () => {
  it('calls a TD3 zone a passport and does not spend a VLM call on it (§4.2)', () => {
    const result = classifyDocument(
      signals({ width: 1750, height: 1232, hasMrz: true, mrzFormat: 'TD3', mrzIssuer: 'DEU' }),
    );
    expect(result.class).toBe('PASSPORT');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFY_CONCLUSIVE);
    expect(result.inconclusive).toBe(false);
    expect(result.issuer).toBe('DEU');
    expect(result.signalsUsed).toContain('mrz:TD3');
  });

  it('admits that a TD1 zone does not say which kind of card it is (§11.3 #35)', () => {
    const result = classifyDocument(signals({ hasMrz: true, mrzFormat: 'TD1' }));
    expect(result.class).toBe('NATIONAL_ID_CARD');
    expect(result.inconclusive).toBe(true);
    expect(result.hypotheses).toEqual(['NATIONAL_ID_CARD', 'RESIDENCE_PERMIT']);
    expect(result.confidence).toBeLessThan(CLASSIFY_CONCLUSIVE);
  });

  it('separates a licence from a state ID by AAMVA vehicle class, not by shape (T0-F)', () => {
    const licence = classifyDocument(
      signals({ hasPdf417: true, barcodeSample: aamva({ DCA: 'C', DBA: '04232030' }) }),
    );
    expect(licence.class).toBe('US_DRIVERS_LICENSE');
    expect(licence.inconclusive).toBe(false);
    expect(licence.side).toBe('BACK');

    const stateId = classifyDocument(
      signals({ hasPdf417: true, barcodeSample: aamva({ DCA: 'NONE', DBA: '04232030' }) }),
    );
    expect(stateId.class).toBe('US_STATE_ID');
    expect(stateId.inconclusive).toBe(false);
    expect(stateId.side).toBe('BACK');
  });

  it('classes a decoded AAMVA licence issued outside the US as NON_US_DRIVERS_LICENSE, not US_DRIVERS_LICENSE (G11)', () => {
    const canadian = classifyDocument(
      signals({
        hasPdf417: true,
        barcodeSample: aamva({ DCG: 'CAN', DCA: 'C', DBA: '20290228' }),
      }),
    );
    expect(canadian.class).toBe('NON_US_DRIVERS_LICENSE');
    expect(canadian.inconclusive).toBe(false);
    expect(canadian.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('treats an absent DCG as the historical US default, same as an explicit USA (G11)', () => {
    const absent = classifyDocument(
      signals({ hasPdf417: true, barcodeSample: aamva({ DCA: 'C', DBA: '04232030' }) }),
    );
    expect(absent.class).toBe('US_DRIVERS_LICENSE');

    const explicit = classifyDocument(
      signals({
        hasPdf417: true,
        barcodeSample: aamva({ DCG: 'USA', DCA: 'C', DBA: '04232030' }),
      }),
    );
    expect(explicit.class).toBe('US_DRIVERS_LICENSE');
  });

  it('declines to pick between DL, state ID and non-US DL when the payload was not decoded', () => {
    const result = classifyDocument(signals({ hasPdf417: true, barcodeSample: null }));
    expect(result.inconclusive).toBe(true);
    expect(result.hypotheses).toEqual([
      'US_DRIVERS_LICENSE',
      'US_STATE_ID',
      'NON_US_DRIVERS_LICENSE',
    ]);
  });

  it('prefers the machine-readable region over misleading printed text', () => {
    // A passport data page will contain the word "passport" and an MRZ. A DL back with
    // a barcode may sit next to anything. The decoded region wins, always.
    const result = classifyDocument(
      signals({
        hasPdf417: true,
        barcodeSample: aamva({ DCA: 'C' }),
        textSample: 'to whom it may concern this is an employment verification letter human resources',
      }),
    );
    expect(result.class).toBe('US_DRIVERS_LICENSE');
  });
});

// ---------------------------------------------------------------------------
// Printed text
// ---------------------------------------------------------------------------

describe('printed text (deterministic, no model call)', () => {
  const cases: Array<[string, string]> = [
    [
      'BANK_STATEMENT',
      'ACME BANK statement period 01 Jan to 31 Jan. Opening balance 1,204.55. Closing balance 998.10. Sort code 12-34-56.',
    ],
    [
      'UTILITY_BILL',
      'Your electricity supply. Billing period 01/03 to 31/03. Meter reading 44821 kwh. Amount due £61.20. Service address 4 Elm Row.',
    ],
    [
      'EMPLOYMENT_LETTER',
      'To whom it may concern. This is an employment verification for the below. Date of joining 12 May 2019. Annual salary as per annum stated. Human resources.',
    ],
    [
      'MEDICAL_INSURANCE_CARD',
      'Member id 883-221. Group number 4410. Rx bin 610502. Copay $25. Subscriber J DOE. Coverage period ends 2027-01-31.',
    ],
  ];

  for (const [expected, text] of cases) {
    it(`classifies a ${expected} from template vocabulary`, () => {
      const result = classifyDocument(
        signals({ ...PAGE, sourceFormat: 'PDF', textSample: text, hasMrz: false, hasPdf417: false }),
      );
      expect(result.class).toBe(expected);
      expect(result.confidence).toBeGreaterThan(0.6);
      expect(result.signalsUsed.join(' ')).toContain('keywords:');
    });
  }

  it('marks a paper document as N/A for side — there is no front or back', () => {
    const result = classifyDocument(
      signals({
        ...PAGE,
        textSample: 'statement period opening balance closing balance available balance',
      }),
    );
    expect(result.side).toBe('N/A');
  });

  it('does not classify off a single incidental keyword', () => {
    // "restrictions" alone appears in plenty of prose; one hit is not a licence.
    const result = classifyDocument(
      signals({ textSample: 'The following restrictions apply to the use of this facility.' }),
    );
    expect(result.class).toBe('OTHER_DOCUMENT');
    expect(result.inconclusive).toBe(true);
  });

  it('picks a US state out of the printed text when TA never ran (§11.3 #27)', () => {
    const result = classifyDocument(
      signals({
        textSample: 'california driver license class c endorsements none restrictions none dl no A1234567',
      }),
    );
    expect(result.class).toBe('US_DRIVERS_LICENSE');
    expect(result.issuer).toBe('CA');
  });

  it("lets TA's issuer override anything read off the page", () => {
    const result = classifyDocument(
      signals({
        hasPdf417: true,
        barcodeSample: aamva({ DCA: 'C' }),
        issuerHint: 'TX',
        textSample: 'california driver license',
      }),
    );
    expect(result.issuer).toBe('TX');
  });
});

// ---------------------------------------------------------------------------
// Abstention — the assertions that matter
// ---------------------------------------------------------------------------

describe('abstention (§5, T0-E, T0-G)', () => {
  it('will not name a class from aspect ratio alone', () => {
    const result = classifyDocument(signals({ hasMrz: false, hasPdf417: false }));
    expect(result.class).toBe('OTHER_DOCUMENT');
    expect(result.inconclusive).toBe(true);
    expect(result.confidence).toBeLessThan(0.4);
    // But it does hand the VLM a shortlist rather than the whole enum.
    expect(result.hypotheses).toEqual([
      'US_DRIVERS_LICENSE',
      'US_STATE_ID',
      'NATIONAL_ID_CARD',
      'MEDICAL_INSURANCE_CARD',
    ]);
  });

  it('reports NO_MACHINE_READABLE_REGION only once something has actually looked', () => {
    const probed = classifyDocument(signals({ hasMrz: false, hasPdf417: false }));
    expect(probed.reasonCodes).toContain('NO_MACHINE_READABLE_REGION');

    // Nobody has run TA yet — absence of evidence is not evidence of absence.
    const unprobed = classifyDocument(signals({}));
    expect(unprobed.reasonCodes).not.toContain('NO_MACHINE_READABLE_REGION');
  });

  it('does not claim a missing barcode on a sheet of paper is a finding', () => {
    const result = classifyDocument(
      signals({ ...PAGE, hasMrz: false, hasPdf417: false, textSample: null }),
    );
    expect(result.reasonCodes).not.toContain('NO_MACHINE_READABLE_REGION');
    expect(result.hypotheses).toContain('BANK_STATEMENT');
  });

  it('calls a blank page NOT_A_DOCUMENT when a text pass genuinely found nothing (§11.3 #43)', () => {
    const result = classifyDocument(
      signals({ textSample: '   ', hasMrz: false, hasPdf417: false }),
    );
    expect(result.class).toBe('NOT_A_DOCUMENT');
    expect(result.reasonCodes).toContain('CLASS_UNRECOGNIZED');
  });

  it('does NOT call an out-of-focus document a meme (T0-G)', () => {
    // Same empty text, but the page is blurry — the text pass failing is explained.
    // Getting this wrong is the worst failure in the module, because NOT_A_DOCUMENT
    // is what suppresses all downstream spend.
    const result = classifyDocument(
      signals({
        textSample: '',
        hasMrz: false,
        hasPdf417: false,
        quality: BLURRY_QUALITY,
      }),
    );
    expect(result.class).not.toBe('NOT_A_DOCUMENT');
    expect(result.inconclusive).toBe(true);
  });

  it('does not assert NOT_A_DOCUMENT when no text pass ran at all', () => {
    const result = classifyDocument(signals({ textSample: null, hasMrz: false, hasPdf417: false }));
    expect(result.class).toBe('OTHER_DOCUMENT');
  });

  it('damps confidence on a poor-quality page but never erases it (§9)', () => {
    const text = 'statement period opening balance closing balance available balance sort code';
    const clean = classifyDocument(signals({ ...PAGE, textSample: text }));
    const degraded = classifyDocument(
      signals({
        ...PAGE,
        textSample: text,
        quality: { ...BLURRY_QUALITY, effective_dpi: 90, clipping_ratio: 0.3 },
      }),
    );
    expect(degraded.confidence).toBeLessThan(clean.confidence);
    expect(degraded.confidence).toBeGreaterThan(clean.confidence * 0.55);
  });

  it('never invents a class outside the frozen enum', () => {
    const inputs: ClassificationSignals[] = [
      signals({}),
      signals({ hasMrz: true, mrzFormat: 'TD2' }),
      signals({ hasPdf417: true, barcodeSample: aamva({ DCA: 'C' }) }),
      signals({ ...PAGE, textSample: 'closing balance statement period' }),
      signals({ width: 40, height: 900 }),
      signals({ width: 0, height: 0 }),
    ];
    for (const input of inputs) {
      const result = classifyDocument(input);
      expect(DOCUMENT_CLASSES).toContain(result.class);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.rationale.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §11.3 #40 — script detection
// ---------------------------------------------------------------------------

describe('script detection (§11.3 #40)', () => {
  it('flags a non-Latin document instead of attempting it', () => {
    const result = classifyDocument(
      signals({ ...PAGE, textSample: 'Паспорт Российской Федерации выдан 12.04.2019' }),
    );
    expect(result.reasonCodes).toContain('UNSUPPORTED_SCRIPT');
  });

  it('does not flag accented Latin as unsupported', () => {
    expect(isNonLatinDominant('Fecha de vencimiento — expire le 04/2030 · Ausweis gültig')).toBe(false);
    expect(isNonLatinDominant('身分證明文件 有效期限')).toBe(true);
    expect(isNonLatinDominant('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration with the normalizer's own output shape
// ---------------------------------------------------------------------------

describe('adaptor over a real NormalizedDocument', () => {
  it('classifies straight off a normalized page without reshaping anything by hand', async () => {
    const width = 1600;
    const height = 1009;
    const raster = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const on = (Math.floor((i % width) / 8) + Math.floor(i / width / 8)) % 2 === 0;
      raster.fill(on ? 235 : 20, i * 3, i * 3 + 3);
    }
    const png = await sharp(raster, { raw: { width, height, channels: 3 } }).png().toBuffer();

    const outcome = await normalizeDocument(png, { minBytes: 0, correctPerspective: false });
    expect(isNormalized(outcome)).toBe(true);
    if (!isNormalized(outcome)) return;

    const result = classifyNormalizedPage(outcome.primary, outcome, {
      hasMrz: false,
      hasPdf417: false,
    });
    // A card-shaped image with no decoded region and no text is exactly the case §7.6
    // hands to the VLM. Anything more confident than this would be a fabrication.
    expect(result.class).toBe('OTHER_DOCUMENT');
    expect(result.inconclusive).toBe(true);
    expect(result.reasonCodes).toContain('NO_MACHINE_READABLE_REGION');
  }, 30_000);

  it('uses the PDF text layer as its text source when OCR has not run', () => {
    const result = classifyNormalizedPage(
      {
        fullWidth: PAGE.width,
        fullHeight: PAGE.height,
        textLayer: 'ACME BANK — statement period 01/01 to 31/01, closing balance 998.10, sort code 12-34-56',
        quality: GOOD_QUALITY,
      },
      { sourceFormat: 'PDF', pageCount: 4 },
      { hasMrz: false, hasPdf417: false },
    );
    expect(result.class).toBe('BANK_STATEMENT');
  });
});
