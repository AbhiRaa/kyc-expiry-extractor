/**
 * TA-PDF417 — deterministic extraction from the AAMVA barcode on the back of a North
 * American driver's licence or state ID (§4.1, §7).
 *
 * This is the highest-confidence path in the system (§11.3 #28). The per-state variation
 * everyone worries about is on the *printed front*; the barcode is standardised, so one
 * parser covers every DMV and every province. And PDF417 carries Reed–Solomon error
 * correction: if the symbol decodes at all, the bytes are the bytes the issuer encoded.
 * There is no "the model was fairly sure" here, which is exactly why this tier exists.
 *
 * Two things in here are load-bearing:
 *
 *  1. **Dates are parsed by us, not by `aamva-parser`.** The library is consulted only for
 *     a second opinion on the header version; its `parseDate` unconditionally reads
 *     MMDDCCYY and builds a local-time `Date`. On a Canadian card, where the standard
 *     mandates CCYYMMDD, that silently produces a valid-looking wrong date — the precise
 *     failure §4.1 warns about. Measured rather than assumed: an Ontario card carrying
 *     `DCGCAN` and `DBA20290228` comes back from the library as `Sat Aug 29 0229` (month
 *     20 overflows into the year), and its `isExpired()` therefore reports a 2029 licence
 *     as expired. Neither its date fields nor its `isExpired()`/`isAcceptable()` helpers
 *     are consumed anywhere here, and element extraction is our own scan of the record
 *     stream. Dates go through `parseAamvaDate(value, country)` with the order chosen from
 *     `DCG` and the AAMVA version; `tier-a-pdf417.test.ts` pins that payload as a
 *     regression test.
 *
 *  2. **A barcode that will not decode is a clean miss, not an error** (§4.1). Blur,
 *     distance and glare all end here, and the right answer is to abstain with
 *     NO_MACHINE_READABLE_REGION / RESOLUTION_TOO_LOW and let TB have the page. This
 *     module never throws.
 */

import { getVersion } from 'aamva-parser';

import {
  DETERMINISTIC_CONFIDENCE,
  abstain,
  type DateRole,
  type ReasonCode,
  type TierCandidate,
  type TierResult,
} from '@/types/contract';
import { parseAamvaDate, type NormalizedDate } from '@/engine/dates';
import { checkTemporalPlausibility } from '@/pipeline/cross-check';

// ---------------------------------------------------------------------------
// AAMVA payload structure (§4.1)
// ---------------------------------------------------------------------------

/** Record separators used inside an AAMVA payload: LF, CR and ASCII RS (0x1E). */
const AAMVA_SEPARATORS = /[\n\r\u001e]+/;

/** Start of the first subfile: a 2-character subfile type then a 3-character element ID. */
const FIRST_SUBFILE_RECORD = /(?:DL|ID|EN)[A-Z]{3}/;

/** The compliance header, e.g. `@\n\x1e\rANSI 636014100002DL00410279`. */
const HEADER = /(ANSI |AAMVA)(\d{6})(\d{2})/;

/** Element IDs we care about (§4.1). Everything else is carried through untouched. */
export const AAMVA_ELEMENTS = {
  expiry: 'DBA',
  issue: 'DBD',
  dob: 'DBB',
  familyName: 'DCS',
  firstName: 'DAC',
  licenceNumber: 'DAQ',
  country: 'DCG',
  jurisdiction: 'DAJ',
} as const;

export interface AamvaSubfileDesignator {
  type: string;
  offset: number;
  length: number;
}

export interface AamvaPayload {
  iin: string | null;
  /** 1–12; older cards use earlier field sets, so this drives tolerance, not rejection. */
  version: number | null;
  jurisdictionVersion: number | null;
  subfiles: AamvaSubfileDesignator[];
  /** Three-letter element ID → raw value, exactly as encoded. */
  elements: Record<string, string>;
  raw: string;
}

/**
 * Parse an AAMVA payload into its header and elements.
 *
 * Element extraction scans the record stream rather than trusting the header's subfile
 * offsets. Real cards get those offsets wrong often enough that a strict reader rejects
 * genuine documents — and since every record is self-describing (a 3-character ID followed
 * by its value, terminated by a separator), the offsets buy us nothing we cannot recover.
 * They are still parsed and returned, because a wildly wrong offset table is itself worth
 * showing to a reviewer.
 */
export function parseAamvaPayload(raw: string): AamvaPayload | null {
  const header = raw.match(HEADER);
  if (!header) return null;

  const version = Number(header[3]);
  let cursor = (header.index ?? 0) + header[0].length;

  // The jurisdiction version was added in version 2; version 1 goes straight to the count.
  let jurisdictionVersion: number | null = null;
  if (version >= 2) {
    jurisdictionVersion = Number(raw.slice(cursor, cursor + 2));
    cursor += 2;
  }
  const entryCount = Number(raw.slice(cursor, cursor + 2));
  cursor += 2;

  const subfiles: AamvaSubfileDesignator[] = [];
  if (Number.isFinite(entryCount)) {
    for (let entry = 0; entry < entryCount; entry++) {
      const designator = raw.slice(cursor + entry * 10, cursor + entry * 10 + 10);
      const match = designator.match(/^([A-Z]{2})(\d{4})(\d{4})$/);
      if (!match) break;
      subfiles.push({ type: match[1], offset: Number(match[2]), length: Number(match[3]) });
    }
  }

  const subfileTypes = subfiles.length > 0 ? subfiles.map((s) => s.type) : ['DL', 'ID'];
  const elements: Record<string, string> = {};

  // Where the header stops and the records start. No separator sits between the last
  // designator and the first record, so scanning the whole payload would read the header
  // itself as an element. We locate the boundary from the designator count we just parsed,
  // and fall back to the first subfile-type marker when that count was unusable.
  const designatorEnd = cursor + subfiles.length * 10;
  const markerOffset = raw.slice(cursor).search(FIRST_SUBFILE_RECORD);
  const bodyStart =
    subfiles.length > 0 ? designatorEnd : markerOffset >= 0 ? cursor + markerOffset : cursor;

  for (const segment of raw.slice(bodyStart).split(AAMVA_SEPARATORS)) {
    // The first record of a subfile is prefixed with the subfile type: "DL" + "DAQ" + value.
    const prefix = subfileTypes.find(
      (type) => segment.startsWith(type) && /^[A-Z]{3}/.test(segment.slice(2, 5)),
    );
    const record = prefix ? segment.slice(prefix.length) : segment;
    const match = record.match(/^([A-Z]{3})([\s\S]*)$/);
    if (!match) continue;
    const value = match[2].trim();
    // First occurrence wins: a duplicated ID across subfiles is the issuer's copy, and
    // overwriting would silently prefer whichever came last.
    if (value.length > 0 && !(match[1] in elements)) elements[match[1]] = value;
  }

  return {
    iin: header[2],
    version: Number.isFinite(version) ? version : null,
    jurisdictionVersion: Number.isFinite(jurisdictionVersion as number) ? jurisdictionVersion : null,
    subfiles,
    elements,
    raw,
  };
}

// ---------------------------------------------------------------------------
// The date-order branch — the one that silently produces wrong answers (§4.1)
// ---------------------------------------------------------------------------

export type AamvaDateOrder = 'MMDDCCYY' | 'CCYYMMDD';

export interface ResolvedAamvaDate extends NormalizedDate {
  order: AamvaDateOrder | null;
  /** True when the declared jurisdiction's order does not parse but the other one does. */
  order_conflict: boolean;
}

const ORDER_COUNTRY: Record<AamvaDateOrder, 'USA' | 'CAN'> = {
  MMDDCCYY: 'USA',
  CCYYMMDD: 'CAN',
};

/**
 * Which byte order the card's date fields use.
 *
 * `null` means "undeclared — decide from the value itself". That is safe rather than lazy:
 * a valid `CCYY` is 1900–2200, so it always begins 19/20/21/22, while a valid `MM` never
 * exceeds 12. The two orderings therefore cannot both yield a real calendar date for the
 * same eight digits, and reading a date whose order is fixed by arithmetic is not a guess.
 *
 * Version 1 (the DL/ID-2000 standard) predates `DCG` and its date order varies by
 * jurisdiction, so it is deliberately routed through that same resolution instead of being
 * assumed either way.
 */
export function declaredDateOrder(
  country: string | undefined,
  version: number | null,
): AamvaDateOrder | null {
  if (version !== null && version <= 1) return null;
  if (country === 'CAN') return 'CCYYMMDD';
  if (country === 'USA') return 'MMDDCCYY';
  return null;
}

/** Apply the branch, and refuse to output a date when the declared order contradicts it. */
export function resolveAamvaDate(
  value: string,
  declared: AamvaDateOrder | null,
): ResolvedAamvaDate {
  const asUs = parseAamvaDate(value, 'USA');
  const asCan = parseAamvaDate(value, 'CAN');

  if (declared) {
    const primary = declared === 'CCYYMMDD' ? asCan : asUs;
    if (primary.iso) return { ...primary, order: declared, order_conflict: false };

    const alternative = declared === 'CCYYMMDD' ? asUs : asCan;
    if (alternative.iso) {
      // The card says one thing and the digits say another. Emitting the alternative would
      // be exactly the silent correction §8.6 forbids, so we surface the contradiction.
      return {
        iso: null,
        raw: value,
        ambiguous: true,
        alternatives: [alternative.iso],
        rule:
          `card declares ${ORDER_COUNTRY[declared]} (${declared}) but "${value}" is only a valid ` +
          `date read as ${declared === 'CCYYMMDD' ? 'MMDDCCYY' : 'CCYYMMDD'}`,
        order: declared,
        order_conflict: true,
      };
    }
    return { ...primary, order: declared, order_conflict: false };
  }

  if (asUs.iso && !asCan.iso) {
    return { ...asUs, order: 'MMDDCCYY', order_conflict: false, rule: `${asUs.rule} (order resolved by calendar validity; jurisdiction undeclared)` };
  }
  if (asCan.iso && !asUs.iso) {
    return { ...asCan, order: 'CCYYMMDD', order_conflict: false, rule: `${asCan.rule} (order resolved by calendar validity; jurisdiction undeclared)` };
  }
  return {
    iso: null,
    raw: value,
    ambiguous: Boolean(asUs.iso && asCan.iso),
    rule: `"${value}" is not a valid AAMVA date under either MMDDCCYY or CCYYMMDD`,
    order: null,
    order_conflict: false,
  };
}

// ---------------------------------------------------------------------------
// Payload → TierResult
// ---------------------------------------------------------------------------

const DATE_ELEMENTS: ReadonlyArray<{ id: string; role: DateRole; label: string }> = [
  { id: AAMVA_ELEMENTS.expiry, role: 'EXPIRY', label: 'DBA (document expiration date)' },
  { id: AAMVA_ELEMENTS.issue, role: 'ISSUE', label: 'DBD (document issue date)' },
  { id: AAMVA_ELEMENTS.dob, role: 'DATE_OF_BIRTH', label: 'DBB (date of birth)' },
];

export interface AamvaExtractionOptions {
  today?: Date;
  /** Echoed into the evidence snippet when the payload came off a real image. */
  decodeNote?: string;
}

/**
 * Turn a decoded AAMVA payload into a tier result. Split out from the decode so the
 * parsing rules are testable without a barcode image, and so a payload obtained any other
 * way (a second barcode library, a fixture) runs through identical logic.
 */
export function extractFromAamvaPayload(
  raw: string,
  options: AamvaExtractionOptions = {},
): TierResult {
  const startedAt = Date.now();
  const today = options.today ?? new Date();

  const payload = parseAamvaPayload(raw);
  if (!payload) {
    return abstain('TA_PDF417', ['NO_MACHINE_READABLE_REGION'], {
      duration_ms: Date.now() - startedAt,
      checksum_detail: 'Decoded symbol is not an AAMVA payload (no ANSI/AAMVA compliance header)',
    });
  }

  const country = payload.elements[AAMVA_ELEMENTS.country];
  // The library's own version read is kept as a second opinion on the header parse.
  const libraryVersion = getVersion(raw);
  const order = declaredDateOrder(country, payload.version);

  const candidates: TierCandidate[] = [];
  const reasonCodes: ReasonCode[] = [];
  const notes: string[] = [];

  for (const { id, role, label } of DATE_ELEMENTS) {
    const value = payload.elements[id];
    if (!value) continue; // Version drift: older field sets simply lack some of these.
    const resolved = resolveAamvaDate(value, order);
    if (!resolved.iso) {
      notes.push(`${id}: ${resolved.rule}`);
      if (resolved.order_conflict || resolved.ambiguous) {
        if (!reasonCodes.includes('AMBIGUOUS_DATE_FORMAT')) reasonCodes.push('AMBIGUOUS_DATE_FORMAT');
      }
      continue;
    }
    candidates.push({
      raw: value,
      iso: resolved.iso,
      role,
      label_verbatim: label,
      snippet: `${id}${value}`,
      bbox: null, // The symbol's position is known; the element's position inside it is not.
      confidence: DETERMINISTIC_CONFIDENCE,
    });
  }

  const expiry = candidates.find((candidate) => candidate.role === 'EXPIRY');
  if (!expiry) {
    return abstain('TA_PDF417', reasonCodes.length ? reasonCodes : ['NO_DATES_FOUND'], {
      duration_ms: Date.now() - startedAt,
      checksum_validated: true,
      checksum_detail:
        `AAMVA v${payload.version ?? '?'} payload decoded (IIN ${payload.iin ?? '?'}) but no usable ` +
        `DBA expiration date${notes.length ? `: ${notes.join('; ')}` : ' element was present'}`,
      issuer: payload.elements[AAMVA_ELEMENTS.jurisdiction] ?? country ?? null,
    });
  }

  const plausibility = checkTemporalPlausibility(
    {
      expiry: expiry.iso,
      issue: candidates.find((candidate) => candidate.role === 'ISSUE')?.iso ?? null,
      dob: candidates.find((candidate) => candidate.role === 'DATE_OF_BIRTH')?.iso ?? null,
    },
    today,
    `AAMVA ${payload.subfiles[0]?.type ?? 'DL'}`,
  );

  const detail = [
    `PDF417 Reed–Solomon ECC validated by the decoder; AAMVA v${payload.version ?? '?'}` +
      `${libraryVersion && Number(libraryVersion) !== payload.version ? ` (library read v${libraryVersion})` : ''}` +
      `, IIN ${payload.iin ?? '?'}, dates read as ${order ?? 'order resolved per field'}` +
      `${country ? ` (DCG=${country})` : ' (DCG absent)'}`,
    options.decodeNote,
    ...notes,
    ...plausibility.notes,
  ]
    .filter(Boolean)
    .join('. ');

  return {
    tier: 'TA_PDF417',
    abstained: false,
    candidates,
    reason_codes: [...reasonCodes, ...plausibility.reason_codes],
    anomalies: plausibility.anomalies,
    checksum_validated: true,
    checksum_detail: detail,
    issuer: payload.elements[AAMVA_ELEMENTS.jurisdiction] ?? country ?? null,
    grounding_tokens: Object.entries(payload.elements).map(([id, value]) => `${id}${value}`),
    cost_usd: 0,
    duration_ms: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Decoding (zxing-wasm)
// ---------------------------------------------------------------------------

export type BarcodeImage = Uint8Array | ArrayBuffer | Blob | ImageData;

/**
 * zxing-wasm ships the decoder as a WASM blob and, by default, fetches it from a CDN. In a
 * Node/serverless runtime that is both a network round-trip on the hot path and a hard
 * failure when egress is blocked, so we hand the module the bytes off disk instead. If
 * resolution fails we leave the default in place rather than crash — a network fetch that
 * works is better than a decoder that does not exist.
 */
let modulePrepared: Promise<void> | null = null;

async function prepareDecoder(): Promise<void> {
  const { prepareZXingModule } = await import('zxing-wasm/reader');
  try {
    const { createRequire } = await import('node:module');
    const { readFile } = await import('node:fs/promises');
    const require = createRequire(import.meta.url);
    // The specifier is assembled at runtime on purpose. Written as a literal, the bundler
    // statically resolves it, pulls the generated `.wasm` loader into the build graph, and
    // fails on that file's single-letter module references ("Can't resolve 'a'").
    // `serverExternalPackages` does not help, because the failure happens during static
    // analysis rather than at require time. Splitting the string defeats the analysis and
    // leaves Node to resolve it normally at runtime.
    const wasmSpecifier = ['zxing-wasm', 'reader', 'zxing_reader.wasm'].join('/');
    const wasmPath = require.resolve(wasmSpecifier);
    const bytes = await readFile(wasmPath);
    const wasmBinary = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    prepareZXingModule({ overrides: { wasmBinary } });
  } catch {
    prepareZXingModule({});
  }
}

/**
 * Decode the PDF417 symbol, returning its payload as text.
 *
 * `tryRotate` matters: the vertical "under-21" DL layout puts the barcode on its side
 * (§11.3 #29). We read `bytes` rather than `text` because AAMVA payloads are full of
 * control characters (LF, RS, CR) that a human-readable text mode would mangle into
 * `<LF>`-style placeholders and destroy the record structure.
 */
export async function decodePdf417(image: BarcodeImage): Promise<string | null> {
  const { readBarcodes } = await import('zxing-wasm/reader');
  modulePrepared ??= prepareDecoder();
  await modulePrepared;

  const results = await readBarcodes(image, {
    formats: ['PDF417'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    maxNumberOfSymbols: 1,
    textMode: 'Plain',
  });

  const decoded = results.find((result) => result.isValid);
  if (!decoded) return null;
  return decoded.bytes?.length ? latin1(decoded.bytes) : decoded.text;
}

/** AAMVA payloads are 8-bit ASCII; decoding as UTF-8 would corrupt any high byte. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

export interface Pdf417Input {
  /**
   * Full-resolution image bytes. Do not pass the downscaled VLM copy — PDF417 decoding is
   * resolution-bound and the whole point of keeping the original around (§7 T0.4).
   */
  image: BarcodeImage;
  today?: Date;
  /** Quality metrics from T0, used only to pick the more informative abstention reason. */
  quality?: { effectiveDpi?: number | null };
}

/** Below this, a PDF417's narrow bars fall under one pixel and no decoder will recover them. */
const MIN_DECODABLE_DPI = 150;

/**
 * The tier entry point: decode, then parse. Every failure path abstains; none throws
 * (§4.1, §11.6 #71).
 */
export async function extractPdf417(input: Pdf417Input): Promise<TierResult> {
  const startedAt = Date.now();

  let payload: string | null = null;
  try {
    payload = await decodePdf417(input.image);
  } catch (error) {
    return abstain('TA_PDF417', ['NO_MACHINE_READABLE_REGION'], {
      duration_ms: Date.now() - startedAt,
      checksum_detail: `PDF417 decoder error, falling through to the next tier: ${
        (error as Error).message
      }`,
    });
  }

  if (!payload) {
    const dpi = input.quality?.effectiveDpi ?? null;
    const lowResolution = dpi !== null && dpi < MIN_DECODABLE_DPI;
    return abstain(
      'TA_PDF417',
      [lowResolution ? 'RESOLUTION_TOO_LOW' : 'NO_MACHINE_READABLE_REGION'],
      {
        duration_ms: Date.now() - startedAt,
        checksum_detail: lowResolution
          ? `No PDF417 symbol decoded at ${dpi} effective DPI (below the ~${MIN_DECODABLE_DPI} DPI needed)`
          : 'No PDF417 symbol decoded — no barcode present, or it is too blurred, skewed or distant to read',
      },
    );
  }

  const result = extractFromAamvaPayload(payload, {
    today: input.today,
    decodeNote: 'Decoded from the full-resolution image',
  });
  return { ...result, duration_ms: Date.now() - startedAt };
}
