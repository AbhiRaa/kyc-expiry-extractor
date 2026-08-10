/**
 * TB tests (§7 TB, §11.4 #52/#54/#55/#56/#57, §11.5 #66).
 *
 * Two kinds of test here, and the distinction is deliberate:
 *
 *  1. **OCR-verified.** Fixtures are rendered programmatically with `sharp` (an SVG
 *     composited to PNG), put through the real in-process Tesseract worker, and asserted
 *     end to end. Ground truth is exact because we chose the strings and the pixel
 *     positions. These prove the tier actually works on pixels — the label lexicon, the
 *     bbox spatial rule and the cross-line reassembly are all exercised against real,
 *     noisy word geometry rather than against numbers we made up.
 *
 *  2. **Logic-verified.** Cases that cannot be produced honestly by rendering Latin text
 *     through an `eng` model — a non-Latin script, a handwriting-grade confidence score,
 *     an OCR engine crash — inject a fixed `OcrPage` instead. Faking the *pixels* would be
 *     faking the test; injecting the OCR layer is just testing the decision logic at its
 *     real seam, which is exactly the seam `extractFromOcrPage` exists to expose.
 *
 * One worker serves every OCR test (initialisation dominates its cost) and is torn down in
 * `afterAll`.
 */

import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

import {
  BELOW_MAX_DY_RATIO,
  LOW_WORD_CONFIDENCE,
  RIGHT_MAX_DX_RATIO,
  TB_MAX_CONFIDENCE,
  dateShapeStrength,
  estimateMachineReadableZone,
  extractFromOcrPage,
  extractTierBOcr,
  findDateTokens,
  findLabelMatches,
  isLineContinuation,
  isRangeShaped,
  joinTokenTexts,
  placeValue,
  profileScript,
  reconstructLines,
  terminateOcrWorker,
  type OcrBox,
  type OcrPage,
  type OcrToken,
} from '@/pipeline/tier-b-ocr';
import { detectMrzBand } from '@/pipeline/tier-a-mrz';
import type { TierCandidate, TierResult } from '@/types/contract';
import type { FreeTextOptions } from '@/engine/dates';

const TODAY = new Date(Date.UTC(2026, 7, 9)); // 2026-08-09, pinned: century resolution moves.
const OCR_TIMEOUT = { timeout: 60_000 };

// ---------------------------------------------------------------------------
// Fixture rendering — SVG → PNG via sharp, so ground truth is exact by construction
// ---------------------------------------------------------------------------

interface RenderedLine {
  text: string;
  /** Baseline position in page pixels. */
  x: number;
  y: number;
  fontSize?: number;
}

/**
 * Renders crisp black text on white at known positions. Nothing is read from disk and no
 * corpus is involved: the test owns both the pixels and the expected answer.
 */
async function renderPage(
  lines: RenderedLine[],
  width = 1100,
  height = 400,
): Promise<Buffer> {
  const text = lines
    .map(
      (line) =>
        `<text x="${line.x}" y="${line.y}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" ` +
        `font-size="${line.fontSize ?? 40}" fill="black">${line.text}</text>`,
    )
    .join('');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${width}" height="${height}" fill="white"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function expiryOf(result: TierResult): TierCandidate | undefined {
  return result.candidates.find((candidate) => candidate.role === 'EXPIRY');
}

afterAll(async () => {
  await terminateOcrWorker();
});

// ---------------------------------------------------------------------------
// OCR-VERIFIED — real Tesseract over rendered pixels
// ---------------------------------------------------------------------------

describe('TB end to end over real OCR', () => {
  it(
    'reads the value to the right of an EXP label',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([{ text: 'EXP  03/14/2029', x: 60, y: 120 }]);
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(result.tier).toBe('TB_OCR');
      expect(result.abstained).toBe(false);
      const expiry = expiryOf(result);
      expect(expiry?.iso).toBe('2029-03-14');
      expect(expiry?.raw).toBe('03/14/2029');
      expect(expiry?.label_verbatim).toBe('EXP');
      expect(expiry?.bbox).not.toBeNull();
      expect(expiry!.confidence).toBeGreaterThan(0.7);
      // No checksum exists at this tier, so it must not claim deterministic certainty.
      expect(expiry!.confidence).toBeLessThanOrEqual(TB_MAX_CONFIDENCE);
      expect(result.grounding_tokens).toContain('EXP');
      expect(result.grounding_tokens).toContain('03/14/2029');
      expect(result.cost_usd).toBe(0);
    },
  );

  it(
    'reads AAMVA printed field codes, which work on any jurisdiction (§4.1)',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([
        { text: '4a  01/02/2024', x: 60, y: 110 },
        { text: '4b  03/14/2029', x: 60, y: 220 },
        { text: '3   07/09/1985', x: 60, y: 330 },
      ]);
      // The field codes themselves establish this is a US DL front, so MM/DD applies.
      const result = await extractTierBOcr({ image, today: TODAY, issuerConvention: 'US' });

      expect(result.abstained).toBe(false);
      const expiry = expiryOf(result);
      expect(expiry?.iso).toBe('2029-03-14');
      expect(expiry?.label_verbatim).toBe('4b');

      // The whole inventory comes back: the constraint engine needs issue and DOB to run
      // EXPIRY_BEFORE_ISSUE and DOB_AFTER_EXPIRY.
      const byRole = new Map(result.candidates.map((c) => [c.role, c]));
      expect(byRole.get('ISSUE')?.iso).toBe('2024-01-02');
      expect(byRole.get('DATE_OF_BIRTH')?.iso).toBe('1985-07-09');
    },
  );

  it(
    'reads the value printed directly below its label',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([
        { text: 'EXPIRES', x: 60, y: 110 },
        { text: '03/14/2029', x: 60, y: 190 },
      ]);
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(result.abstained).toBe(false);
      expect(expiryOf(result)?.iso).toBe('2029-03-14');
      expect(result.checksum_detail).toContain('directly below');
    },
  );

  it(
    'reassembles a date split across two lines by layout (§11.4 #57)',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([
        { text: 'VALID THRU', x: 60, y: 100 },
        { text: '03/14/', x: 60, y: 170 },
        { text: '2029', x: 60, y: 240 },
      ]);
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(result.abstained).toBe(false);
      const expiry = expiryOf(result);
      expect(expiry?.iso).toBe('2029-03-14');
      expect(expiry?.raw).toBe('03/14/2029');
      expect(result.checksum_detail).toContain('reassembled across two lines');
    },
  );

  it(
    'takes the END of a printed date range (§11.4 #55)',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([{ text: 'VALID THRU 01/2026 - 01/2028', x: 60, y: 120 }]);
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(result.abstained).toBe(false);
      const expiry = expiryOf(result);
      // Month-year end, resolved to the last day of the month (§11.4 #54).
      expect(expiry?.iso).toBe('2028-01-31');
      expect(result.checksum_detail).toContain('end taken as the expiry');
    },
  );

  it(
    'resolves a month-year-only value to the last day of the month (§11.4 #54)',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([{ text: 'EXP  04/2028', x: 60, y: 120 }], 900, 250);
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(expiryOf(result)?.iso).toBe('2028-04-30');
    },
  );

  it(
    'abstains when two labels give competing values (§7 TB)',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([
        { text: 'EXP 03/14/2029', x: 60, y: 110 },
        { text: 'VALID THRU 08/22/2030', x: 60, y: 240 },
      ]);
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(result.abstained).toBe(true);
      expect(result.reason_codes).toContain('MULTIPLE_EXPIRY_CANDIDATES');
      expect(result.candidates).toEqual([]);
      expect(result.checksum_detail).toContain('2029-03-14');
      expect(result.checksum_detail).toContain('2030-08-22');
      expect(result.grounding_tokens!.length).toBeGreaterThan(0);
    },
  );

  it(
    'abstains with no label — but still returns the grounding token stream (G5, §11.5 #66)',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage([{ text: 'JOHN Q SMITH 03/14/2029', x: 60, y: 120 }]);
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(result.abstained).toBe(true);
      expect(result.reason_codes).toContain('NO_EXPIRY_SEMANTICS');
      expect(result.candidates).toEqual([]);

      // This is the G5 requirement in one assertion. TC only fires because TB abstained,
      // and TC's injection cross-check has nothing to check against unless the abstaining
      // tier still reports what it read.
      expect(result.grounding_tokens).toBeDefined();
      expect(result.grounding_tokens).toContain('SMITH');
      expect(result.grounding_tokens).toContain('03/14/2029');
    },
  );

  it(
    'abstains when the only date sits beyond the spatial bound (§7 TB)',
    OCR_TIMEOUT,
    async () => {
      const image = await renderPage(
        [
          { text: 'EXP', x: 60, y: 120 },
          { text: '03/14/2029', x: 1150, y: 120 },
        ],
        1600,
        300,
      );
      const result = await extractTierBOcr({ image, today: TODAY });

      expect(result.abstained).toBe(true);
      expect(result.reason_codes).toContain('NO_EXPIRY_SEMANTICS');
      expect(result.checksum_detail).toContain('spatial bound');
      expect(result.grounding_tokens).toContain('03/14/2029');
    },
  );
});

// ---------------------------------------------------------------------------
// LOGIC-VERIFIED — injected OCR page, no recognition pass
// ---------------------------------------------------------------------------

const CHAR_WIDTH = 20;
const WORD_HEIGHT = 30;
const WORD_GAP = 20;
const FIRST_X = 60;
const FIRST_Y = 60;
const LINE_PITCH = 80;

type FakeWord = string | { text: string; confidence: number };

/** Lays words out on a regular grid so the spatial rules see realistic geometry. */
function fakeOcrPage(lines: FakeWord[][]): OcrPage {
  const tokens: OcrToken[] = [];
  lines.forEach((words, lineIndex) => {
    let x = FIRST_X;
    const y0 = FIRST_Y + lineIndex * LINE_PITCH;
    for (const word of words) {
      const text = typeof word === 'string' ? word : word.text;
      const confidence = typeof word === 'string' ? 95 : word.confidence;
      const width = Math.max(text.length * CHAR_WIDTH, CHAR_WIDTH);
      tokens.push({
        text,
        box: { x0: x, y0, x1: x + width, y1: y0 + WORD_HEIGHT },
        confidence,
        line: lineIndex,
      });
      x += width + WORD_GAP;
    }
  });
  return {
    tokens,
    width: 1600,
    height: FIRST_Y + lines.length * LINE_PITCH + 60,
    meanConfidence:
      tokens.length === 0
        ? null
        : tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length,
  };
}

const DATE_OPTIONS: FreeTextOptions = {
  issuerConvention: null,
  role: 'EXPIRY',
  today: TODAY,
};

describe('abstention paths', () => {
  it('returns an empty but present grounding stream when OCR read nothing (§11.4 #45)', () => {
    const result = extractFromOcrPage(fakeOcrPage([]), { today: TODAY });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['NO_DATES_FOUND']);
    expect(result.grounding_tokens).toEqual([]);
  });

  it('detects non-Latin script and refuses to attempt it (§7 TB)', () => {
    const page = fakeOcrPage([['СРОК', 'ДЕЙСТВИЯ', '14.03.2029']]);
    const result = extractFromOcrPage(page, { today: TODAY });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['UNSUPPORTED_SCRIPT']);
    // G5 holds here too: TC still needs to see what was on the page.
    expect(result.grounding_tokens).toEqual(['СРОК', 'ДЕЙСТВИЯ', '14.03.2029']);
  });

  it('never guesses between DD/MM and MM/DD (§11.4 #52)', () => {
    const result = extractFromOcrPage(fakeOcrPage([['EXP', '03/04/2028']]), { today: TODAY });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['AMBIGUOUS_DATE_FORMAT']);
    expect(result.checksum_detail).toContain('2028-03-04');
    expect(result.checksum_detail).toContain('2028-04-03');
    expect(result.grounding_tokens).toContain('03/04/2028');
  });

  it('resolves the same ambiguous value once the issuer convention is known', () => {
    const result = extractFromOcrPage(fakeOcrPage([['EXP', '03/04/2028']]), {
      today: TODAY,
      issuerConvention: 'US',
    });

    expect(result.abstained).toBe(false);
    expect(expiryOf(result)?.iso).toBe('2028-03-04');
  });

  it('does not substitute another date for an explicit "NONE" (§11.4 #48)', () => {
    const result = extractFromOcrPage(
      fakeOcrPage([
        ['EXP', 'NONE'],
        ['DOB', '03/14/2029'],
      ]),
      { today: TODAY },
    );

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['NO_EXPIRY_SEMANTICS']);
    expect(result.checksum_detail).toContain('no-expiry');
  });

  it('never throws when the OCR engine fails (§5, §11.6 #71)', async () => {
    const result = await extractTierBOcr({
      image: Buffer.alloc(0),
      ocr: async () => {
        throw new Error('wasm module failed to instantiate');
      },
    });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['MODEL_UNAVAILABLE']);
    expect(result.grounding_tokens).toEqual([]);
    expect(result.checksum_detail).toContain('no grounding token stream');
  });
});

describe('low-confidence reads (§11.4 #56)', () => {
  it('returns a handwriting-grade read with LOW_TIER_CONFIDENCE rather than abstaining', () => {
    const page = fakeOcrPage([['EXP', { text: '03/14/2029', confidence: 42 }]]);
    const result = extractFromOcrPage(page, { today: TODAY });

    expect(result.abstained).toBe(false);
    expect(result.reason_codes).toContain('LOW_TIER_CONFIDENCE');
    const expiry = expiryOf(result);
    expect(expiry?.iso).toBe('2029-03-14');
    // Confidence has to actually fall, or the reason code is decoration.
    expect(expiry!.confidence).toBeLessThan(0.5);
  });

  it('does not flag a clean read', () => {
    const page = fakeOcrPage([['EXP', { text: '03/14/2029', confidence: LOW_WORD_CONFIDENCE + 5 }]]);
    const result = extractFromOcrPage(page, { today: TODAY });

    expect(result.reason_codes).toEqual([]);
  });
});

describe('AAMVA bare field-code corroboration (§7 TB)', () => {
  it('ignores a bare "3" on a page with no field-code layout', () => {
    const hits = findLabelMatches(fakeOcrPage([['3', '07/09/1985']]).tokens);
    expect(hits).toEqual([]);
  });

  it('accepts a bare "3" once 4a/4b prove the layout', () => {
    const hits = findLabelMatches(
      fakeOcrPage([
        ['4b', '03/14/2029'],
        ['3', '07/09/1985'],
      ]).tokens,
    );
    expect(hits.map((hit) => hit.entry.canonical)).toEqual(['4B', '3']);
  });

  it('rejects a corroborated "3" whose value is only a month-year, not a full date', () => {
    const page = fakeOcrPage([
      ['4b', '03/14/2029'],
      ['3', '07/1985'],
    ]);
    const result = extractFromOcrPage(page, { today: TODAY, issuerConvention: 'US' });

    expect(result.candidates.map((candidate) => candidate.role)).toEqual(['EXPIRY']);
  });
});

describe('date token detection', () => {
  it('joins words the way they were printed', () => {
    expect(joinTokenTexts(['03/14/', '2029'])).toBe('03/14/2029');
    expect(joinTokenTexts(['03', '/', '14', '/', '2029'])).toBe('03/14/2029');
    expect(joinTokenTexts(['15', 'MAR', '2028'])).toBe('15 MAR 2028');
  });

  it('grades date shapes and refuses whitespace-only numeric runs', () => {
    expect(dateShapeStrength('03/14/2029')).toBe(3);
    expect(dateShapeStrength('04/2028')).toBe(2);
    expect(dateShapeStrength('15 MAR 2028')).toBe(3);
    expect(dateShapeStrength('07 09')).toBe(0); // two adjacent numbers are not a date
    expect(dateShapeStrength('SMITH')).toBe(0);
  });

  it('recognises a range only when both sides are date-shaped', () => {
    expect(isRangeShaped('01/2026-01/2028')).toBe(true);
    expect(isRangeShaped('01/2026 TO 01/2028')).toBe(true);
    expect(isRangeShaped('03-14-2029')).toBe(false); // a hyphenated date, not a range
    expect(isRangeShaped('01/2026 - SMITH')).toBe(false);
  });

  it('prefers the cross-line reading over a shorter same-line one (§11.4 #57)', () => {
    // "03/14" alone is a valid month-year (March 2014). Taking it would silently rewrite
    // a 2029 expiry, so the richer cross-line reading has to win.
    const page = fakeOcrPage([['03/14'], ['2029']]);
    const tokens = findDateTokens(page.tokens, DATE_OPTIONS);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('03/14 2029');
    expect(tokens[0].crossesLine).toBe(true);
    expect(tokens[0].strength).toBe(3);
  });

  it('does not merge across a line break when the boxes are not adjacent', () => {
    const far: OcrBox = { x0: 900, y0: 400, x1: 1000, y1: 430 };
    const anchor: OcrBox = { x0: 60, y0: 60, x1: 160, y1: 90 };
    expect(isLineContinuation(anchor, far)).toBe(false);
    expect(isLineContinuation(anchor, { x0: 60, y0: 120, x1: 160, y1: 150 })).toBe(true);
  });
});

describe('spatial placement (§7 TB requirement 4)', () => {
  const label: OcrBox = { x0: 100, y0: 100, x1: 200, y1: 130 };

  it('accepts a value to the right on the same line', () => {
    const placement = placeValue(label, { x0: 230, y0: 100, x1: 400, y1: 130 });
    expect(placement?.relation).toBe('RIGHT');
    expect(placement!.distance).toBeCloseTo(1, 5);
    expect(placement!.bound).toBe(RIGHT_MAX_DX_RATIO);
  });

  it('accepts a value directly below', () => {
    const placement = placeValue(label, { x0: 100, y0: 175, x1: 280, y1: 205 });
    expect(placement?.relation).toBe('BELOW');
    expect(placement!.bound).toBe(BELOW_MAX_DY_RATIO);
  });

  it('rejects a value that is below but in a different column', () => {
    expect(placeValue(label, { x0: 800, y0: 175, x1: 980, y1: 205 })).toBeNull();
  });

  it('rejects a value beyond the right-hand bound', () => {
    expect(placeValue(label, { x0: 700, y0: 100, x1: 880, y1: 130 })).toBeNull();
  });

  it('rejects a value above the label', () => {
    expect(placeValue(label, { x0: 100, y0: 20, x1: 280, y1: 50 })).toBeNull();
  });

  it('prefers the nearer of a right-hand and a below candidate', () => {
    const right = placeValue(label, { x0: 500, y0: 100, x1: 660, y1: 130 });
    const below = placeValue(label, { x0: 100, y0: 140, x1: 260, y1: 170 });
    expect(right!.distance / right!.bound).toBeGreaterThan(below!.distance / below!.bound);
  });
});

describe('line reconstruction for TA-MRZ (single OCR pass)', () => {
  /** ICAO 9303 TD3: two lines of exactly 44 characters. */
  const TD3_LINE_1 = 'P<UTOERIKSSON<<ANNA<MARIA'.padEnd(44, '<');
  const TD3_LINE_2 = 'L898902C36UTO7408122F1204159ZE184226B'.padEnd(44, '<');

  /**
   * The band sits in the bottom fifth of the page and OCR splits the fixed-width run into
   * several words, which is exactly what the real engine does to an MRZ.
   */
  function bandPage(): OcrPage {
    const width = 1400;
    const height = 900;
    const chunkTokens = (line: string, y0: number, lineIndex: number): OcrToken[] => {
      const chunks = [line.slice(0, 20), line.slice(20, 33), line.slice(33)];
      let x = 80;
      return chunks.map((text) => {
        const box = { x0: x, y0, x1: x + text.length * 22, y1: y0 + 34 };
        x = box.x1 + 18;
        return { text, box, confidence: 88, line: lineIndex };
      });
    };
    return {
      tokens: [
        { text: 'PASSPORT', box: { x0: 80, y0: 60, x1: 300, y1: 100 }, confidence: 94, line: 0 },
        ...chunkTokens(TD3_LINE_1, 740, 1),
        ...chunkTokens(TD3_LINE_2, 800, 2),
      ],
      width,
      height,
      meanConfidence: 90,
    };
  }

  it('rebuilds a 2×44 TD3 band from split tokens', () => {
    const lines = reconstructLines(bandPage());

    expect(lines).toHaveLength(3);
    expect(lines[0].text).toBe('PASSPORT');
    // Whitespace is the only thing the split introduced; the MRZ payload is intact at its
    // exact ICAO width, which is what band detection keys on.
    expect(lines[1].text.replace(/\s/g, '')).toBe(TD3_LINE_1);
    expect(lines[2].text.replace(/\s/g, '')).toBe(TD3_LINE_2);
    expect(lines[1].text.replace(/\s/g, '')).toHaveLength(44);
    expect(lines[2].text.replace(/\s/g, '')).toHaveLength(44);
  });

  it('produces normalized bboxes ordered top to bottom', () => {
    const lines = reconstructLines(bandPage());

    for (const line of lines) {
      expect(line.bbox).not.toBeNull();
      for (const coordinate of line.bbox!) {
        expect(coordinate).toBeGreaterThanOrEqual(0);
        expect(coordinate).toBeLessThanOrEqual(1);
      }
    }
    // The band must read as the bottom of the page, which is how TA-MRZ ranks candidates.
    expect(lines[1].bbox![1]).toBeGreaterThan(0.7);
    expect(lines[2].bbox![1]).toBeGreaterThan(lines[1].bbox![1]);
  });

  it('drops straight into TA-MRZ band detection', () => {
    const band = detectMrzBand({ source: reconstructLines(bandPage()) });

    expect(band?.format).toBe('TD3');
    expect(band?.lines).toEqual([TD3_LINE_1, TD3_LINE_2]);
  });

  it('orders words left to right regardless of token order', () => {
    const page: OcrPage = {
      tokens: [
        { text: 'THRU', box: { x0: 300, y0: 100, x1: 420, y1: 130 }, confidence: 90, line: 0 },
        { text: 'VALID', box: { x0: 100, y0: 102, x1: 280, y1: 132 }, confidence: 90, line: 0 },
        { text: '03/14/2029', box: { x0: 100, y0: 200, x1: 400, y1: 230 }, confidence: 90, line: 1 },
      ],
      width: 800,
      height: 400,
      meanConfidence: 90,
    };

    expect(reconstructLines(page).map((line) => line.text)).toEqual([
      'VALID THRU',
      '03/14/2029',
    ]);
  });

  it('estimateMachineReadableZone anchors on the band and extends upward, not downward', () => {
    const lines = reconstructLines(bandPage());
    const zone = estimateMachineReadableZone(lines);

    expect(zone).not.toBeNull();
    const [x0, y0, x1, y1] = zone!;
    // The band's own tokens run most of the page's width (this fixture's chunked layout
    // starts at x=80 of 1400px and does not quite reach the right edge).
    expect(x0).toBeLessThan(0.1);
    expect(x1).toBeGreaterThan(0.75);
    // The whole point: extend well above the band (a book-spread's other page sits above
    // the real one), but not meaningfully past the band's own bottom edge.
    expect(y0).toBeLessThan(0.3);
    expect(y1).toBeGreaterThan(0.9);
    expect(y1).toBeLessThanOrEqual(1);
    for (const coordinate of zone!) {
      expect(coordinate).toBeGreaterThanOrEqual(0);
      expect(coordinate).toBeLessThanOrEqual(1);
    }
  });
});

describe('estimateMachineReadableZone (crop-toward-the-document for TC)', () => {
  it('returns null for an ordinary document with no MRZ-like line', () => {
    const lines = reconstructLines({
      tokens: [
        { text: 'EXPIRES', box: { x0: 80, y0: 60, x1: 220, y1: 100 }, confidence: 94, line: 0 },
        { text: '04/23/2030', box: { x0: 240, y0: 60, x1: 420, y1: 100 }, confidence: 94, line: 0 },
      ],
      width: 800,
      height: 400,
      meanConfidence: 90,
    });

    expect(estimateMachineReadableZone(lines)).toBeNull();
  });

  it('is not fooled by a short, coincidentally alphabet-heavy label', () => {
    const lines = reconstructLines({
      tokens: [
        // Uppercase, digits and no lowercase — passes a naive alphabet check — but far
        // short of a real band's length, which is exactly the false-positive case
        // MIN_ZONE_LINE_CHARS exists to reject.
        { text: 'DL0A12X9', box: { x0: 80, y0: 60, x1: 220, y1: 100 }, confidence: 94, line: 0 },
      ],
      width: 800,
      height: 400,
      meanConfidence: 90,
    });

    expect(estimateMachineReadableZone(lines)).toBeNull();
  });
});

describe('script profiling', () => {
  it('scores a Latin page as supported', () => {
    expect(profileScript(['EXPIRES', '03/14/2029']).unsupported).toBe(false);
  });

  it('does not call the script from one stray glyph', () => {
    expect(profileScript(['EXPIRES', 'Ω']).unsupported).toBe(false);
  });

  it('flags Cyrillic, Arabic and Han', () => {
    expect(profileScript(['СРОК', 'ДЕЙСТВИЯ']).unsupported).toBe(true);
    expect(profileScript(['تاريخ', 'الانتهاء']).unsupported).toBe(true);
    expect(profileScript(['有效期限']).unsupported).toBe(true);
  });
});
