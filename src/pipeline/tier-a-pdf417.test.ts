/**
 * TA-PDF417 tests (§4.1, §7, §11.3 #28/#29, §11.4 #50, §11.5).
 *
 * The headline test renders a *real* PDF417 symbol with `bwip-js` from a known AAMVA
 * payload and decodes it back with `zxing-wasm`. Mocking the decoder would prove only that
 * the parser can read a string we handed it; the round trip proves the tier actually works
 * end to end in Node, which is the claim being made about this path.
 *
 * Every fixture is built in code. Nothing is read from disk.
 */

import bwipjs from 'bwip-js/node';
import { describe, expect, it } from 'vitest';
import { parse as parseWithLibrary } from 'aamva-parser';

import { DETERMINISTIC_CONFIDENCE } from '@/types/contract';
import {
  decodePdf417,
  declaredDateOrder,
  extractFromAamvaPayload,
  extractPdf417,
  parseAamvaPayload,
  resolveAamvaDate,
} from '@/pipeline/tier-a-pdf417';

const LF = '\n';
const CR = '\r';
const RS = String.fromCharCode(30);

const TODAY = new Date(Date.UTC(2026, 7, 9)); // 2026-08-09

interface PayloadSpec {
  iin?: string;
  version?: number;
  jurisdictionVersion?: number;
  subfileType?: string;
  elements: Array<[string, string]>;
}

/**
 * Build an AAMVA payload with a structurally correct header: compliance indicator, file
 * type, IIN, versions, entry count, and a subfile designator whose offset and length are
 * computed rather than hand-written (§4.1).
 */
function buildAamvaPayload(spec: PayloadSpec): string {
  const iin = spec.iin ?? '636014';
  const version = spec.version ?? 10;
  const subfileType = spec.subfileType ?? 'DL';

  const body =
    subfileType + spec.elements.map(([id, value]) => `${id}${value}`).join(LF) + CR;
  const headerWithoutDesignators =
    `@${LF}${RS}${CR}ANSI ` +
    iin +
    String(version).padStart(2, '0') +
    (version >= 2 ? String(spec.jurisdictionVersion ?? 0).padStart(2, '0') : '') +
    '01';

  const offset = headerWithoutDesignators.length + 10;
  const designator =
    subfileType + String(offset).padStart(4, '0') + String(body.length).padStart(4, '0');
  return headerWithoutDesignators + designator + body;
}

const CALIFORNIA_DL = buildAamvaPayload({
  iin: '636014',
  version: 10,
  elements: [
    ['DAQ', 'I1234562'],
    ['DCS', 'DOE'],
    ['DAC', 'JOHN'],
    ['DAD', 'QUINCY'],
    ['DBD', '05202021'],
    ['DBB', '01151985'],
    ['DBA', '05202028'],
    ['DBC', '1'],
    ['DAU', '070 IN'],
    ['DAJ', 'CA'],
    ['DCG', 'USA'],
  ],
});

/** bwip-js needs a quiet zone and a white backdrop, or the symbol will not locate. */
async function renderPdf417(payload: string, scale = 4): Promise<Uint8Array> {
  const png = await bwipjs.toBuffer({
    bcid: 'pdf417',
    text: payload,
    scale,
    paddingwidth: 10,
    paddingheight: 10,
    backgroundcolor: 'FFFFFF',
  });
  return new Uint8Array(png);
}

/** A 1×1 white PNG — the degenerate "nothing to decode here" input. */
const BLANK_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const expiryOf = (result: { candidates: Array<{ role: string; iso: string | null }> }) =>
  result.candidates.find((candidate) => candidate.role === 'EXPIRY');

// ---------------------------------------------------------------------------

describe('AAMVA payload parsing (§4.1)', () => {
  it('reads the header IIN, version and subfile designator', () => {
    const payload = parseAamvaPayload(CALIFORNIA_DL);

    expect(payload).not.toBeNull();
    expect(payload!.iin).toBe('636014');
    expect(payload!.version).toBe(10);
    expect(payload!.subfiles).toEqual([
      { type: 'DL', offset: expect.any(Number), length: expect.any(Number) },
    ]);
    expect(payload!.elements.DBA).toBe('05202028');
    expect(payload!.elements.DAQ).toBe('I1234562');
    expect(payload!.elements.DCG).toBe('USA');
  });

  it('rejects anything that is not an AAMVA payload', () => {
    expect(parseAamvaPayload('https://example.com/not-a-licence')).toBeNull();
  });

  it('tolerates version drift and missing optional fields (§4.1)', () => {
    // A version-1 card: no jurisdiction version, no DCG, a sparse field set.
    const old = buildAamvaPayload({
      version: 1,
      elements: [
        ['DAQ', 'A9876543'],
        ['DBA', '20291231'],
        ['DBB', '19700704'],
      ],
    });
    const payload = parseAamvaPayload(old);

    expect(payload!.version).toBe(1);
    expect(payload!.jurisdictionVersion).toBeNull();
    expect(payload!.elements.DBA).toBe('20291231');
    expect(payload!.elements.DCG).toBeUndefined();
  });
});

describe('the date-order branch — the silent-wrong-answer trap (§4.1)', () => {
  it('reads the same eight digits differently for a US and a Canadian card', () => {
    const digits = '05202028';
    expect(resolveAamvaDate(digits, 'MMDDCCYY').iso).toBe('2028-05-20');
    expect(resolveAamvaDate(digits, 'CCYYMMDD').iso).toBeNull();

    const canadianDigits = '20280520';
    expect(resolveAamvaDate(canadianDigits, 'CCYYMMDD').iso).toBe('2028-05-20');
    expect(resolveAamvaDate(canadianDigits, 'MMDDCCYY').iso).toBeNull();
  });

  it('branches on DCG end to end, so identical digits yield different tier results', () => {
    const usa = extractFromAamvaPayload(
      buildAamvaPayload({ elements: [['DBA', '05202028'], ['DCG', 'USA']] }),
      { today: TODAY },
    );
    const canadaSameDigits = extractFromAamvaPayload(
      buildAamvaPayload({ elements: [['DBA', '05202028'], ['DCG', 'CAN']] }),
      { today: TODAY },
    );
    const canada = extractFromAamvaPayload(
      buildAamvaPayload({ elements: [['DBA', '20280520'], ['DCG', 'CAN'], ['DAJ', 'ON']] }),
      { today: TODAY },
    );

    expect(expiryOf(usa)?.iso).toBe('2028-05-20');
    expect(expiryOf(canada)?.iso).toBe('2028-05-20');
    expect(canada.issuer).toBe('ON');

    // Same digits, Canadian jurisdiction: the declared order does not parse. We refuse the
    // date rather than quietly re-reading it the other way round.
    expect(canadaSameDigits.abstained).toBe(true);
    expect(canadaSameDigits.reason_codes).toContain('AMBIGUOUS_DATE_FORMAT');
    expect(canadaSameDigits.checksum_detail).toContain('CCYYMMDD');
  });

  it('resolves the order arithmetically when the card does not declare one', () => {
    // A valid CCYY always begins 19-22 and a valid MM never exceeds 12, so the two
    // orderings cannot both produce a real date — reading it is arithmetic, not a guess.
    expect(declaredDateOrder(undefined, 10)).toBeNull();
    expect(declaredDateOrder(undefined, 1)).toBeNull();
    expect(declaredDateOrder('USA', 1)).toBeNull(); // v1 predates DCG; order varies.
    expect(declaredDateOrder('CAN', 10)).toBe('CCYYMMDD');

    const undeclared = extractFromAamvaPayload(
      buildAamvaPayload({ version: 1, elements: [['DAQ', 'A1'], ['DBA', '20291231']] }),
      { today: TODAY },
    );
    expect(expiryOf(undeclared)?.iso).toBe('2029-12-31');
    expect(undeclared.checksum_detail).toContain('DCG absent');
  });

  it('REGRESSION: a DCGCAN card with DBA 20290228 resolves to 2029-02-28', () => {
    // Do not "simplify" this back to aamva-parser's own date output. The library applies
    // MMDDCCYY unconditionally, so it reads 20290228 as month 20, day 29, year 0228 and
    // lets JavaScript roll the overflowing month over: at the time of writing it returns
    // Sat Aug 29 **0229**, and its isExpired() consequently calls this 2029 licence
    // expired. A plausible-looking wrong answer, not a visible failure — which is the worst
    // outcome for this system. Hence the raw DBA string goes through parseAamvaDate, and
    // neither the library's date fields nor its isExpired() helper are consumed anywhere.
    const ontario = buildAamvaPayload({
      iin: '636012',
      elements: [
        ['DAQ', 'O1234567'],
        ['DCS', 'TREMBLAY'],
        ['DAC', 'MARIE'],
        ['DBB', '19850115'],
        ['DBD', '20210228'],
        ['DBA', '20290228'],
        ['DAJ', 'ON'],
        ['DCG', 'CAN'],
      ],
    });

    const result = extractFromAamvaPayload(ontario, { today: TODAY });

    expect(expiryOf(result)?.iso).toBe('2029-02-28');
    expect(result.candidates.find((c) => c.role === 'EXPIRY')?.raw).toBe('20290228');
    expect(result.candidates.find((c) => c.role === 'ISSUE')?.iso).toBe('2021-02-28');
    expect(result.candidates.find((c) => c.role === 'DATE_OF_BIRTH')?.iso).toBe('1985-01-15');
    expect(result.checksum_detail).toContain('CCYYMMDD');
    expect(result.checksum_detail).toContain('DCG=CAN');
    // Unexpired as of TODAY (2026-08-09). The library's reading would say the opposite.
    expect(expiryOf(result)!.iso! > '2026-08-09').toBe(true);

    // Deliberately loose, and deliberately kept: if a future aamva-parser fixes the branch,
    // this single assertion fails and the divergence gets re-reviewed rather than quietly
    // becoming untrue.
    expect(parseWithLibrary(ontario).expirationDate?.getFullYear()).not.toBe(2029);
  });

  it('documents why the dates do not come from aamva-parser', () => {
    // The library reads every date as MMDDCCYY regardless of DCG, so on a Canadian card it
    // returns a valid-looking wrong date. We keep the library for header/demographics only.
    const canadian = buildAamvaPayload({
      elements: [['DAQ', 'A1'], ['DBA', '20280520'], ['DCG', 'CAN']],
    });
    const libraryExpiry = parseWithLibrary(canadian).expirationDate;
    const libraryIso = libraryExpiry
      ? `${libraryExpiry.getFullYear()}-${String(libraryExpiry.getMonth() + 1).padStart(2, '0')}-${String(
          libraryExpiry.getDate(),
        ).padStart(2, '0')}`
      : null;

    expect(libraryIso).not.toBe('2028-05-20');
    expect(expiryOf(extractFromAamvaPayload(canadian, { today: TODAY }))?.iso).toBe('2028-05-20');
  });
});

describe('extraction from a decoded payload', () => {
  it('returns expiry, issue and DOB at 0.99 with the decode treated as self-validating', () => {
    const result = extractFromAamvaPayload(CALIFORNIA_DL, { today: TODAY });

    expect(result.abstained).toBe(false);
    expect(result.tier).toBe('TA_PDF417');
    expect(result.checksum_validated).toBe(true);
    expect(result.checksum_detail).toContain('Reed');
    expect(result.issuer).toBe('CA');
    expect(result.cost_usd).toBe(0);
    expect(expiryOf(result)).toMatchObject({ iso: '2028-05-20', raw: '05202028' });
    expect(result.candidates.find((c) => c.role === 'ISSUE')?.iso).toBe('2021-05-20');
    expect(result.candidates.find((c) => c.role === 'DATE_OF_BIRTH')?.iso).toBe('1985-01-15');
    expect(result.candidates.every((c) => c.confidence === DETERMINISTIC_CONFIDENCE)).toBe(true);
    expect(result.anomalies).toEqual([]);
  });

  it('reads an expired licence as expired, not as a future date (§11.4 #50)', () => {
    const expired = buildAamvaPayload({
      elements: [['DAQ', 'I1234562'], ['DBD', '03102015'], ['DBA', '03102019'], ['DCG', 'USA']],
    });
    const result = extractFromAamvaPayload(expired, { today: TODAY });

    expect(result.abstained).toBe(false);
    expect(expiryOf(result)?.iso).toBe('2019-03-10');
    expect(expiryOf(result)!.iso! < '2026-08-09').toBe(true);
  });

  it('surfaces a temporal anomaly without abstaining — the read is good, the document is not', () => {
    const futureIssue = buildAamvaPayload({
      elements: [['DBD', '01012027'], ['DBA', '01012035'], ['DCG', 'USA']],
    });
    const result = extractFromAamvaPayload(futureIssue, { today: TODAY });

    expect(result.abstained).toBe(false);
    expect(result.anomalies).toContain('FUTURE_DATED_ISSUE');
    expect(result.reason_codes).toContain('FUTURE_DATED_ISSUE');
    expect(expiryOf(result)?.iso).toBe('2035-01-01');
  });

  it('abstains when a decoded payload carries no expiry element', () => {
    const noExpiry = buildAamvaPayload({ elements: [['DAQ', 'I1234562'], ['DCG', 'USA']] });
    const result = extractFromAamvaPayload(noExpiry, { today: TODAY });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['NO_DATES_FOUND']);
    expect(result.candidates).toEqual([]);
  });

  it('abstains when the symbol decoded but is not an AAMVA payload', () => {
    const result = extractFromAamvaPayload('WIFI:S=guest;P=hunter2;;', { today: TODAY });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['NO_MACHINE_READABLE_REGION']);
  });
});

describe('real barcode round trip (bwip-js → zxing-wasm)', () => {
  it('decodes a rendered PDF417 back to the exact payload', { timeout: 60_000 }, async () => {
    const image = await renderPdf417(CALIFORNIA_DL);
    const decoded = await decodePdf417(image);

    expect(decoded).toBe(CALIFORNIA_DL);
  });

  it('runs the whole tier against a rendered barcode (§11.3 #28)', { timeout: 60_000 }, async () => {
    const image = await renderPdf417(CALIFORNIA_DL);
    const result = await extractPdf417({ image, today: TODAY });

    expect(result.abstained).toBe(false);
    expect(result.tier).toBe('TA_PDF417');
    expect(expiryOf(result)?.iso).toBe('2028-05-20');
    expect(result.checksum_validated).toBe(true);
    expect(result.checksum_detail).toContain('full-resolution');
    expect(result.cost_usd).toBe(0);
  });

  it('decodes a Canadian card and applies CCYYMMDD end to end', { timeout: 60_000 }, async () => {
    const ontario = buildAamvaPayload({
      iin: '636012',
      elements: [
        ['DAQ', 'O1234567'],
        ['DCS', 'TREMBLAY'],
        ['DAC', 'MARIE'],
        ['DBB', '19850115'],
        ['DBD', '20210520'],
        ['DBA', '20280520'],
        ['DAJ', 'ON'],
        ['DCG', 'CAN'],
      ],
    });
    const result = await extractPdf417({ image: await renderPdf417(ontario), today: TODAY });

    expect(expiryOf(result)?.iso).toBe('2028-05-20');
    expect(result.candidates.find((c) => c.role === 'DATE_OF_BIRTH')?.iso).toBe('1985-01-15');
    expect(result.checksum_detail).toContain('CCYYMMDD');
  });

  it('decodes a rotated symbol — the vertical under-21 layout (§11.3 #29)', { timeout: 60_000 }, async () => {
    const png = await bwipjs.toBuffer({
      bcid: 'pdf417',
      text: CALIFORNIA_DL,
      scale: 4,
      rotate: 'L',
      paddingwidth: 10,
      paddingheight: 10,
      backgroundcolor: 'FFFFFF',
    });
    const result = await extractPdf417({ image: new Uint8Array(png), today: TODAY });

    expect(result.abstained).toBe(false);
    expect(expiryOf(result)?.iso).toBe('2028-05-20');
  });
});

describe('undecodable input is a clean miss, not an error (§4.1)', () => {
  it('abstains with NO_MACHINE_READABLE_REGION on an image with no barcode', { timeout: 60_000 }, async () => {
    const result = await extractPdf417({ image: BLANK_PNG, today: TODAY });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['NO_MACHINE_READABLE_REGION']);
    expect(result.candidates).toEqual([]);
    expect(result.checksum_validated).toBeNull();
  });

  it('abstains with RESOLUTION_TOO_LOW when T0 measured a too-low DPI', { timeout: 60_000 }, async () => {
    const result = await extractPdf417({
      image: BLANK_PNG,
      today: TODAY,
      quality: { effectiveDpi: 72 },
    });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes).toEqual(['RESOLUTION_TOO_LOW']);
    expect(result.checksum_detail).toContain('72');
  });

  it('does not throw on junk bytes', { timeout: 60_000 }, async () => {
    const junk = new Uint8Array(512).fill(0x37);
    const result = await extractPdf417({ image: junk, today: TODAY });

    expect(result.abstained).toBe(true);
    expect(result.reason_codes.length).toBeGreaterThan(0);
  });
});
