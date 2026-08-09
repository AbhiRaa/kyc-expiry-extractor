/**
 * Tests for the evaluation corpus generator (§12).
 *
 * The thing under test is not really "does the script run" — it is "can the published
 * eval numbers be trusted". Three failure modes would silently invalidate them, so each
 * gets an explicit assertion rather than a manual glance:
 *
 *   1. CORPUS/LABEL DRIFT. A renamed or dropped document leaves ground_truth.csv
 *      describing files that no longer exist, and the harness then scores against
 *      phantom rows. Asserted by an exact set comparison, both directions.
 *   2. NON-DETERMINISM. If two runs differ, the numbers are not reproducible from a
 *      clean clone (§16) and the README's headline claim is unverifiable. Asserted by
 *      hashing every artefact across two full generations.
 *   3. FAKE MACHINE-READABLE REGIONS. Plausible-looking MRZ text with wrong check digits,
 *      or a barcode-shaped rectangle that decodes to nothing, would make the deterministic
 *      tiers look broken when it is the corpus that is broken. Asserted by round-tripping
 *      through independent third-party decoders (`mrz`, `zxing-wasm`, `aamva-parser`) —
 *      never through this repo's own parsing code, which would just confirm its own bugs.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { parse as parseMrz } from 'mrz';
import { parse as parseAamva } from 'aamva-parser';
import { readBarcodes } from 'zxing-wasm/reader';

import {
  ANCHOR_TODAY,
  CORPUS_DIR,
  GROUND_TRUTH_PATH,
  buildTD1,
  buildTD3,
  generateCorpus,
  mrzCheckDigit,
  type GroundTruthRow,
} from './generate-corpus';
import { DOCUMENT_CLASSES, VALIDITY_BASES } from '@/types/contract';

/** Generation renders 25 documents including a 40-page PDF; well over vitest's default. */
const GENERATE_TIMEOUT_MS = 180_000;

const VERDICTS = ['VALID', 'EXPIRED', 'NOT_APPLICABLE', 'INDETERMINATE'];

let produced: GroundTruthRow[];
let corpusFiles: string[];

/** Minimal RFC 4180 reader. Deliberately not a dependency: the harness will need to parse
 *  this file too, and if the quoting only survives one specific parser it is not a
 *  portable contract. */
function parseCsv(source: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      out.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out;
}

async function hashCorpus(): Promise<string> {
  const entries = (await readdir(CORPUS_DIR)).filter((f) => f !== '.gitignore').sort();
  const h = createHash('sha256');
  for (const f of entries) {
    h.update(f);
    h.update(await readFile(path.join(CORPUS_DIR, f)));
  }
  h.update(await readFile(GROUND_TRUTH_PATH));
  return h.digest('hex');
}

beforeAll(async () => {
  produced = await generateCorpus();
  corpusFiles = (await readdir(CORPUS_DIR)).filter((f) => f !== '.gitignore').sort();
}, GENERATE_TIMEOUT_MS);

describe('corpus generation', () => {
  it('generates every document named in the §12 target composition', () => {
    // §12's itemized composition (6 DL + 4 passports + 3 insurance + 3 bank + 2 utility +
    // 3 employment + 2 degraded + 1 injection + 1 not-a-document) sums to 25, inside the
    // brief's stated 20-25 range. Covering every named case is what matters, so the count
    // follows the itemization.
    expect(corpusFiles).toHaveLength(25);
    expect(produced).toHaveLength(25);
  });

  it('matches ground_truth.csv row count to the generated file count', async () => {
    const csv = parseCsv(await readFile(GROUND_TRUTH_PATH, 'utf8'));
    const [header, ...dataRows] = csv;
    expect(header).toEqual([
      'filename',
      'expected_class',
      'expected_basis',
      'expected_date',
      'expected_verdict',
      'notes',
    ]);
    expect(dataRows).toHaveLength(corpusFiles.length);
    expect(dataRows.every((r) => r.length === 6)).toBe(true);
  });

  it('has no drift between the label set and the file set, in either direction', () => {
    expect([...produced.map((r) => r.filename)].sort()).toEqual(corpusFiles);
  });
});

describe('ground truth', () => {
  it('uses only enum values from the frozen contract', () => {
    for (const row of produced) {
      expect(DOCUMENT_CLASSES).toContain(row.expected_class);
      expect(VALIDITY_BASES).toContain(row.expected_basis);
      expect(VERDICTS).toContain(row.expected_verdict);
      if (row.expected_date !== null) expect(row.expected_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.notes.length).toBeGreaterThan(30);
    }
  });

  it('labels genuine no-expiry documents as null / NO_EXPIRY / NOT_APPLICABLE', () => {
    // §12: "use null for genuine no-expiry documents - those are test cases, not gaps".
    const noExpiry = produced.filter((r) => r.expected_basis === 'NO_EXPIRY');
    expect(noExpiry.map((r) => r.filename)).toEqual([
      '13_insurance_no_expiry.png',
      '19_employment_letter_many_dates.pdf',
      '20_employment_letter_non_expiring.pdf',
      '21_employment_letter_plain.pdf',
    ]);
    for (const row of noExpiry) {
      expect(row.expected_date).toBeNull();
      expect(row.expected_verdict).toBe('NOT_APPLICABLE');
    }
    // And the inverse: a null date must never be paired with a date-bearing basis.
    for (const row of produced) {
      if (row.expected_date === null) {
        expect(['NO_EXPIRY', 'UNDETERMINED']).toContain(row.expected_basis);
      }
    }
  });

  it('gives bank statements and utility bills RECENCY_WINDOW, not EXPIRY_DATE', () => {
    const recency = produced.filter(
      (r) => r.expected_class === 'BANK_STATEMENT' || r.expected_class === 'UTILITY_BILL',
    );
    expect(recency).toHaveLength(5);
    for (const row of recency) expect(row.expected_basis).toBe('RECENCY_WINDOW');
    // Both windows must have a pass case and a fail case, or the eval cannot tell whether
    // the recency rule is applied at all.
    expect(recency.filter((r) => r.expected_verdict === 'EXPIRED')).toHaveLength(2);
  });

  it('places the expired passport in the past relative to the pinned anchor', () => {
    const expired = produced.find((r) => r.filename === '10_passport_usa_expired.png');
    expect(expired?.expected_verdict).toBe('EXPIRED');
    expect(expired?.expected_date).not.toBeNull();
    expect(Date.parse(expired!.expected_date!)).toBeLessThan(Date.parse(ANCHOR_TODAY));
    // Every other dated document must be unexpired or explicitly a recency failure, so
    // "EXPIRED" in the results is never ambiguous about which rule produced it.
    const unexpectedPast = produced.filter(
      (r) =>
        r.expected_basis === 'EXPIRY_DATE' &&
        r.expected_date !== null &&
        Date.parse(r.expected_date) < Date.parse(ANCHOR_TODAY) &&
        r.filename !== '10_passport_usa_expired.png',
    );
    expect(unexpectedPast).toEqual([]);
  });

  it('quotes the notes column so commas cannot shift the columns', async () => {
    const raw = await readFile(GROUND_TRUTH_PATH, 'utf8');
    const line = raw.split('\n').find((l) => l.startsWith('19_employment_letter_many_dates'));
    expect(line).toBeDefined();
    expect(line).toContain('"');
    const parsed = parseCsv(raw).find((r) => r[0] === '19_employment_letter_many_dates.pdf');
    expect(parsed?.[3]).toBe('null');
    expect(parsed?.[5]).toContain('SHOWCASE ABSTENTION');
  });
});

describe('determinism', () => {
  it(
    'produces byte-identical artefacts across two full runs',
    async () => {
      const first = await hashCorpus();
      await generateCorpus();
      const second = await hashCorpus();
      expect(second).toBe(first);
    },
    GENERATE_TIMEOUT_MS,
  );
});

describe('MRZ fidelity (ICAO 9303)', () => {
  it('computes the 7-3-1 check digit correctly against the published worked example', () => {
    // ICAO 9303 Part 3, Appendix A worked example.
    expect(mrzCheckDigit('D23145890734')).toBe('9');
    // Fields from the published ICAO "UTOPIA" specimen passport
    // (L898902C36UTO7408122F1204159...): document number, DOB and expiry.
    expect(mrzCheckDigit('L898902C3')).toBe('6');
    expect(mrzCheckDigit('740812')).toBe('2');
    expect(mrzCheckDigit('120415')).toBe('9');
    // `<` is zero-valued filler, so trailing filler cannot change the digit.
    expect(mrzCheckDigit('AB2134<<<')).toBe(mrzCheckDigit('AB2134'));
  });

  it('emits TD3 lines an independent parser validates, including the expired passport', () => {
    const valid = buildTD3({
      surname: 'WHITTAKER',
      givenNames: 'CLAIRE ADEBAYO',
      documentNumber: 'X12345678',
      nationality: 'USA',
      issuingState: 'USA',
      dateOfBirth: '1988-09-23',
      expiry: '2031-04-17',
      sex: 'F',
    });
    expect(valid[0]).toHaveLength(44);
    expect(valid[1]).toHaveLength(44);
    const parsed = parseMrz(valid);
    expect(parsed.valid).toBe(true);
    expect(parsed.format).toBe('TD3');
    expect(parsed.fields.expirationDate).toBe('310417');

    // An expired document is not a malformed one: its check digits must still validate,
    // or the pipeline would report CHECKSUM_FAILED instead of EXPIRED (§11.4 #50).
    const expired = parseMrz(
      buildTD3({
        surname: 'DELACROIX',
        givenNames: 'MARCUS TOBIAS',
        documentNumber: '486201973',
        nationality: 'USA',
        issuingState: 'USA',
        dateOfBirth: '1979-02-14',
        expiry: '2023-06-30',
        sex: 'M',
      }),
    );
    expect(expired.valid).toBe(true);
    expect(expired.fields.expirationDate).toBe('230630');
  });

  it('emits a TD1 3x30 zone with a valid composite check digit', () => {
    const lines = buildTD1({
      surname: 'KOVALENKO',
      givenNames: 'ANASTASIIA',
      documentNumber: 'LJ8R41K29',
      nationality: 'UKR',
      issuingState: 'DEU',
      dateOfBirth: '1994-07-08',
      expiry: '2029-10-31',
      sex: 'F',
    });
    expect(lines.map((l) => l.length)).toEqual([30, 30, 30]);
    const parsed = parseMrz(lines);
    expect(parsed.valid).toBe(true);
    expect(parsed.format).toBe('TD1');
    expect(parsed.fields.expirationDate).toBe('291031');
  });

  it('detects a corrupted check digit — proving the validation is not vacuous', () => {
    const [l1, l2] = buildTD3({
      surname: 'WHITTAKER',
      givenNames: 'CLAIRE',
      documentNumber: 'X12345678',
      nationality: 'USA',
      issuingState: 'USA',
      dateOfBirth: '1988-09-23',
      expiry: '2031-04-17',
      sex: 'F',
    });
    const digit = l2[27];
    const tampered = `${l2.slice(0, 27)}${(Number(digit) + 1) % 10}${l2.slice(28)}`;
    expect(parseMrz([l1, tampered]).valid).toBe(false);
  });
});

describe('PDF417 fidelity (AAMVA)', () => {
  /** Decode straight from the rendered pixels — a payload that only exists in memory
   *  proves nothing about what the pipeline will actually be handed. */
  async function decodeFromImage(filename: string): Promise<string> {
    const raw = await sharp(path.join(CORPUS_DIR, filename))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const results = await readBarcodes(
      {
        data: new Uint8ClampedArray(raw.data),
        width: raw.info.width,
        height: raw.info.height,
        colorSpace: 'srgb',
      },
      { formats: ['PDF417'], tryHarder: true, tryRotate: true },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].format).toBe('PDF417');
    // `.text` escapes control bytes for display; `.bytes` is the actual payload.
    return Buffer.from(results[0].bytes).toString('latin1');
  }

  it('renders a decodable AAMVA barcode with a well-formed header and offsets', async () => {
    const payload = await decodeFromImage('02_dl_tx_back_pdf417.png');
    expect(payload.startsWith('@\n\x1e\rANSI ')).toBe(true);
    // IIN 636015 (Texas), AAMVA version 10, jurisdiction version 01, 2 subfile entries.
    expect(payload.slice(9, 21)).toBe('636015100102');
    // First subfile designator: type + offset + length. Header is 21 + 2*10 bytes.
    const designator = payload.slice(21, 31);
    expect(designator.slice(0, 2)).toBe('DL');
    const offset = Number(designator.slice(2, 6));
    const length = Number(designator.slice(6, 10));
    expect(offset).toBe(41);
    expect(payload.slice(offset, offset + 2)).toBe('DL');
    expect(payload[offset + length - 1]).toBe('\r');

    const licence = parseAamva(payload);
    expect(licence.lastName).toBe('OKONKWO');
    expect(licence.firstName).toBe('DAVID');
    expect(licence.driversLicenseId).toBe('38104729');
    expect(payload).toContain('DBA03222030'); // expiry, MMDDCCYY
    expect(payload).toContain('DBD03222022'); // issue
    expect(payload).toContain('DBB03221985'); // DOB
    expect(payload).toContain('DCGUSA');
  }, 60_000);

  it('rotates the barcode on the vertical under-21 card and still decodes it', async () => {
    const payload = await decodeFromImage('04_dl_fl_vertical_under21.png');
    expect(payload).toContain('DBA05022028');
    expect(payload).toContain('DCSNAKAMURA');
  }, 60_000);

  it('serializes the Canadian licence in CCYYMMDD, not MMDDCCYY', async () => {
    const payload = await decodeFromImage('06_dl_on_canada_ccyymmdd.png');
    expect(payload).toContain('DCGCAN');
    expect(payload).toContain('DBA20290228');
    expect(payload).toContain('DBD20250228');
    // The trap made concrete: aamva-parser assumes the US order and returns a nonsense
    // year for this card. The pipeline must abstain here rather than coerce a date.
    const misparsed = parseAamva(payload);
    expect(misparsed.expirationDate?.getUTCFullYear()).not.toBe(2029);
  }, 60_000);
});

describe('rendered artefacts', () => {
  it('spot-checks the passport image dimensions and format', async () => {
    const meta = await sharp(path.join(CORPUS_DIR, '07_passport_usa.png')).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(1476);
    expect(meta.height).toBe(1040);
    // The MRZ occupies the bottom band; a blank strip there means the monospace font did
    // not resolve and the TA-MRZ tier would be evaluated against nothing.
    const mrzBand = await sharp(path.join(CORPUS_DIR, '07_passport_usa.png'))
      .extract({ left: 0, top: 860, width: 1476, height: 180 })
      .greyscale()
      .stats();
    expect(mrzBand.channels[0].stdev).toBeGreaterThan(10);
  });

  it('spot-checks the vertical licence: portrait orientation, real ink', async () => {
    const file = path.join(CORPUS_DIR, '04_dl_fl_vertical_under21.png');
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(638);
    expect(meta.height).toBe(1012);
    expect(meta.height!).toBeGreaterThan(meta.width!);
    const stats = await sharp(file).greyscale().stats();
    expect(stats.channels[0].stdev).toBeGreaterThan(10);
  });

  it('degrades the blurred licence measurably relative to a sharp one', async () => {
    // Proxy for Laplacian variance: a blurred card has far less local contrast. If this
    // ever collapses, §11.2 #16 is no longer being exercised.
    const sharpCard = await sharp(path.join(CORPUS_DIR, '01_dl_ca_front_only.png'))
      .greyscale()
      .stats();
    const blurred = await sharp(path.join(CORPUS_DIR, '22_degraded_blur_dl_az.png'))
      .greyscale()
      .stats();
    expect(blurred.channels[0].stdev).toBeLessThan(sharpCard.channels[0].stdev);
  });

  it('writes the PDF documents as real PDFs with pinned metadata', async () => {
    const pdfs = corpusFiles.filter((f) => f.endsWith('.pdf'));
    expect(pdfs).toHaveLength(8);
    for (const f of pdfs) {
      const buf = await readFile(path.join(CORPUS_DIR, f));
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // 2026-08-09 anchor, not the wall clock.
      expect(buf.toString('latin1')).toContain('D:20260809');
    }
  });
});
