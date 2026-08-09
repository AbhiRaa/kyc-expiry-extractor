/**
 * Sample documents offered as one-tap buttons on the landing page (§10:
 * "Sample-document buttons that load 5–6 of the eval documents … Do not skip
 * this. Assume he will open the link on his phone between meetings.").
 *
 * Why this file exists separately from the page: the *files* are populated by
 * another track (they are copies of `eval/corpus/*`), but the *curation* is a
 * product decision and belongs with the UI. The six below are chosen to walk a
 * reviewer through the whole argument in six taps, in this order:
 *
 *   1. the machine-readable-first thesis   (barcode, no model call, $0)
 *   2. the same thesis producing a FAIL    (MRZ checksum on an expired passport)
 *   3. abstention as a correct answer      (15 dates, none of them an expiry)
 *   4. class-specific validity rules       (recency window, not "expiry")
 *   5. date semantics                      (a range, month-year precision)
 *   6. adversarial robustness              (prompt injection in the pixels)
 *
 * CONTRACT WITH THE OTHER TRACK: drop the files listed in `SAMPLE_DOCS[].path`
 * into `public/samples/` using exactly these filenames (they match
 * `eval/corpus/`, so `cp eval/corpus/<name> public/samples/` is the whole job).
 * The UI degrades gracefully — a missing file renders an inline "sample not
 * available" message, never a broken image or a crash (§10).
 */

/** A curated eval document, addressable as a static asset under `public/`. */
export interface SampleDoc {
  /** Stable id, used as a React key and in the button's `data-` hooks. */
  id: string;
  /** Public URL of the asset. Must resolve to a real file under `public/samples/`. */
  path: string;
  /** MIME type to attach to the synthesized `File` before POSTing to /api/extract. */
  mime: 'image/png' | 'image/jpeg' | 'application/pdf';
  /** Short button label — what the document *is*. Kept under ~28 chars for 375px. */
  label: string;
  /** What this sample proves. This is the reason the button is on the page. */
  demonstrates: string;
  /**
   * The answer a correct run gives, shown as a muted hint so the reviewer can
   * tell "the system was right" from "the system said something".
   * Sourced from `eval/ground_truth.csv`.
   */
  expected: string;
}

/** Directory the samples live in, exported so the fetch path stays in one place. */
export const SAMPLES_DIR = '/samples';

export const SAMPLE_DOCS: readonly SampleDoc[] = [
  {
    id: 'dl-back-pdf417',
    path: `${SAMPLES_DIR}/02_dl_tx_back_pdf417.png`,
    mime: 'image/png',
    label: "Driver's licence (back)",
    demonstrates: 'PDF417 barcode path — deterministic, no LLM, $0',
    expected: 'VALID · expires 2030-03-22 · 0.99 via TA_PDF417',
  },
  {
    id: 'passport-expired',
    path: `${SAMPLES_DIR}/10_passport_usa_expired.png`,
    mime: 'image/png',
    label: 'Expired passport',
    demonstrates: 'MRZ check digits → a confident AUTO_FAIL',
    expected: 'EXPIRED · 2023-06-30 · 0.99 via TA_MRZ',
  },
  {
    id: 'employment-letter',
    path: `${SAMPLES_DIR}/19_employment_letter_many_dates.pdf`,
    mime: 'application/pdf',
    label: 'Employment letter',
    demonstrates: 'Abstains: 15 dates, none with expiry semantics',
    expected: 'NOT APPLICABLE · null date · NO_EXPIRY_SEMANTICS',
  },
  {
    id: 'utility-bill',
    path: `${SAMPLES_DIR}/17_utility_bill_recent.pdf`,
    mime: 'application/pdf',
    label: 'Utility bill',
    demonstrates: '90-day recency window — not the payment due date',
    expected: 'VALID · statement 2026-07-15 · RECENCY_WINDOW',
  },
  {
    id: 'insurance-range',
    path: `${SAMPLES_DIR}/12_insurance_date_range.png`,
    mime: 'image/png',
    label: 'Insurance card',
    demonstrates: 'Date range → takes the end; month-year → last day',
    expected: 'VALID · 2028-01-31 · COVERAGE_END',
  },
  {
    id: 'prompt-injection',
    path: `${SAMPLES_DIR}/24_prompt_injection_sticker.png`,
    mime: 'image/png',
    label: 'Injection sticker',
    demonstrates: 'Text on the document is data, never instruction',
    expected: 'VALID · 2030-08-01 · PROMPT_INJECTION_SUSPECTED',
  },
];

/** Filename shown to the user and attached to the multipart part. */
export function sampleFileName(doc: SampleDoc): string {
  return doc.path.slice(doc.path.lastIndexOf('/') + 1);
}
