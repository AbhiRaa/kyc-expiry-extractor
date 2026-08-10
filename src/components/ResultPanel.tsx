'use client';

import type {
  Decision,
  ExtractionResponse,
  ReasonCode,
  SourceTier,
  Verdict,
} from '@/types/contract';
import DateInventory, { findSelectedIndex, humanizeEnum } from './DateInventory';
import PipelineRail from './PipelineRail';
import WhyPanel from './WhyPanel';
import styles from './ResultPanel.module.css';

/** Colour tone. Always rendered alongside a word and a glyph — never alone (WCAG 1.4.1). */
type Tone = 'ok' | 'bad' | 'warn' | 'neutral';

/**
 * Human text for every reason code (§6). The raw code stays on screen next to it:
 * the string in the chip is for the reviewer, the code underneath is the contract
 * an integrator switches on.
 */
const REASON_TEXT: Record<ReasonCode, string> = {
  IMAGE_TOO_BLURRY: 'The image is too blurry to read the field reliably',
  RESOLUTION_TOO_LOW: 'Resolution is below what the field needs',
  GLARE_OBSCURES_FIELD: 'Glare covers the field the verdict depends on',
  DOCUMENT_CROPPED: 'Part of the document is outside the frame',
  EXTREME_SKEW: 'The document is at too steep an angle',
  POOR_CONTRAST: 'Contrast is too low to separate text from background',
  OBSTRUCTED_BY_HAND: 'A hand or object covers part of the document',
  PHOTOCOPY_DEGRADED: 'Photocopy degradation has destroyed detail',
  CLASS_UNRECOGNIZED: 'The document type could not be identified',
  UNSUPPORTED_SCRIPT: 'The script or language is not supported',
  WRONG_SIDE_CAPTURED: 'The side captured does not carry the field',
  MULTIPLE_DOCUMENTS_IN_FRAME: 'More than one document is in the frame',
  TEMPORARY_DOCUMENT: 'This is a temporary or interim document',
  NO_MACHINE_READABLE_REGION: 'No barcode or MRZ was present to decode',
  UNSUPPORTED_TYPE: 'That file type is not supported — upload an image or a PDF',
  CORRUPT_FILE: 'The file could not be read — it may be corrupt or only partially uploaded',
  ENCRYPTED_PDF: 'The PDF is password-protected',
  NO_DATES_FOUND: 'No dates were found on the document',
  NO_EXPIRY_SEMANTICS: 'Dates were found, but none of them means an expiry',
  AMBIGUOUS_DATE_FORMAT: 'The date could be read more than one way',
  MULTIPLE_EXPIRY_CANDIDATES: 'More than one date could be the expiry',
  HUNTER_MAPPER_DISAGREE: 'The two extraction passes disagreed',
  VALUE_NOT_GROUNDED_IN_OCR: 'The value does not appear in the raw text on the page',
  LOW_TIER_CONFIDENCE: 'The tier that read this was not confident enough',
  CHECKSUM_FAILED: 'A machine-readable checksum failed',
  MRZ_VIZ_MISMATCH: 'The MRZ and the printed date disagree',
  BARCODE_PRINT_MISMATCH: 'The barcode and the printed date disagree',
  EXPIRY_BEFORE_ISSUE: 'The expiry date precedes the issue date',
  IMPLAUSIBLE_VALIDITY_PERIOD: 'The validity period is implausibly long',
  FUTURE_DATED_ISSUE: 'The issue date is in the future',
  DOB_AFTER_EXPIRY: 'The date of birth falls after the expiry date',
  PROMPT_INJECTION_SUSPECTED: 'Text on the document tried to instruct the model',
  SCREEN_RECAPTURE_SUSPECTED: 'This looks like a photo of a screen',
  MODEL_UNAVAILABLE: 'A model in the pipeline was unavailable',
  TIMEOUT: 'The pipeline hit its time budget',
  RATE_LIMITED: 'The request was rate limited',
  COST_CAP_REACHED: 'The per-request cost cap was reached',
};

const TIER_TEXT: Record<SourceTier, string> = {
  TA_MRZ: 'MRZ read with ICAO 9303 check digits — deterministic, no model call',
  TA_PDF417: 'AAMVA PDF417 barcode with Reed-Solomon ECC — deterministic, no model call',
  TB_OCR: 'Layout OCR with label matching',
  TC_VLM: 'Vision model, cross-checked against the raw OCR tokens',
  NONE: 'No tier produced a value',
};

const DECISION_TEXT: Record<Decision, string> = {
  AUTO_PASS: 'Clears automatically',
  AUTO_FAIL: 'Fails automatically',
  REVIEW: 'Routed to a human',
};

/**
 * Headline + tone.
 *
 * The brief is explicit: `decision` is the primary signal and `validity.verdict`
 * is the detail (§10). They are not the same axis — an EXPIRED passport read from
 * an MRZ is a confident AUTO_FAIL, while the same verdict off a blurry photo is a
 * REVIEW, and a reviewer glancing at a phone needs the *routing* first because
 * that is what determines whether anyone has to do anything.
 *
 * The one override: NOT_APPLICABLE is rendered neutral whatever the routing says.
 * A document with no expiry concept (an employment letter) is not a pass and not a
 * failure, and painting it green would claim a validation that never happened.
 */
function headline(decision: Decision, verdict: Verdict): {
  tone: Tone;
  glyph: string;
  text: string;
} {
  if (verdict === 'NOT_APPLICABLE') {
    return { tone: 'neutral', glyph: '–', text: 'Not applicable' };
  }
  switch (decision) {
    case 'AUTO_PASS':
      return { tone: 'ok', glyph: '✔', text: verdict === 'VALID' ? 'Valid' : 'Pass' };
    case 'AUTO_FAIL':
      return { tone: 'bad', glyph: '✕', text: verdict === 'EXPIRED' ? 'Expired' : 'Fail' };
    case 'REVIEW':
    default:
      return { tone: 'warn', glyph: '!', text: 'Needs review' };
  }
}

function formatDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDaysRemaining(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'expires today';
  if (days > 0) return `${days.toLocaleString()} day${days === 1 ? '' : 's'} remaining`;
  const past = Math.abs(days);
  return `${past.toLocaleString()} day${past === 1 ? '' : 's'} ago`;
}

/** Highlight the extracted value inside its surrounding snippet, so the reviewer can
 *  see the value *in context* rather than trusting that it came from somewhere. */
function highlightSnippet(snippet: string, needle: string | null) {
  if (!needle) return snippet;
  const at = snippet.indexOf(needle);
  if (at < 0) return snippet;
  return (
    <>
      {snippet.slice(0, at)}
      <mark className={styles.mark}>{needle}</mark>
      {snippet.slice(at + needle.length)}
    </>
  );
}

/** Serialize for the raw-JSON view, verbatim — the point of the panel is that the UI is
 * not editing the contract. */
function prettyJson(result: ExtractionResponse): string {
  return JSON.stringify(result, null, 2);
}

/** Disclosure chevron. Rotated by CSS off the parent `<details open>`. */
function Chevron() {
  return (
    <span className={styles.chevron} aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
        <path
          d="M8 10l4 4 4-4"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export interface ResultPanelProps {
  result: ExtractionResponse;
}

/**
 * The output panel — "the product" per §10 — rebuilt to the v2 design.
 *
 * v1 rendered the brief's a–g order as seven equal stacked blocks. Everything was
 * present and nothing was ranked, so the verdict, the date and the confidence each
 * occupied one card of identical weight and a reviewer on a phone had to read four
 * of them to learn whether anyone had to do anything.
 *
 * v2 keeps the same order and the same content but gives it a hierarchy:
 *
 *   1. **One hero.** Routing, verdict, date and confidence are the *same answer*,
 *      so they share one tone-washed card instead of four neutral ones. The
 *      confidence ring sits beside the date rather than under it, because "0.62"
 *      and "2 May 2026" only mean something read together.
 *   2. **The route, promoted.** The tier ladder becomes its own rail (see
 *      `PipelineRail`) directly under the hero. It is the architecture's whole
 *      thesis — cheapest tier first, model called only when it must be — and v1
 *      buried it as a caption under a progress bar.
 *   3. **Bento pairs for the argument.** Basis-and-rule sits beside the evidence
 *      it was applied to, and the stats beside the raw JSON, because each pair is
 *      read together and neither half deserves full width.
 *
 * The section order the brief specifies is unchanged: verdict → basis and rule →
 * date → confidence with its tier → evidence → why → inventory → raw JSON. The
 * rule that was applied still precedes the date it was applied to. Only the
 * *grouping* changed.
 *
 * Collapsibles stay native `<details>`/`<summary>` rather than the mockup's
 * button-plus-state pattern: keyboard operation and screen-reader announcement
 * come free, with no ARIA to get wrong. The chevron rotation is CSS off `[open]`,
 * so it looks identical.
 */
export default function ResultPanel({ result }: ResultPanelProps) {
  const { validity, evidence, integrity, decision } = result;
  const head = headline(decision, validity.verdict);
  const days = formatDaysRemaining(validity.days_remaining);
  const selectedIndex = findSelectedIndex(
    result.all_dates_found,
    validity.date,
    validity.date_raw,
  );
  const isReview = decision === 'REVIEW';

  const confidence = Math.max(0, Math.min(1, result.confidence));
  const confidenceText = result.confidence.toFixed(2);

  return (
    <section className={styles.panel} aria-label="Extraction result">
      {/* (a/c/d) The hero: routing, verdict, date and confidence as one answer. */}
      <div className={`${styles.hero} ${styles[`tone_${head.tone}`]}`}>
        <div className={styles.heroMain}>
          <div className={styles.heroBadges}>
            <span className={styles.headlinePill}>
              <span aria-hidden="true">{head.glyph}</span>
              {head.text}
            </span>
            <span className={styles.decisionCode}>{decision}</span>
            <span className={styles.decisionText}>{DECISION_TEXT[decision]}</span>
          </div>

          <div className={styles.heroDate}>
            {validity.date ? (
              <>
                <span className={styles.dateBig}>{formatDate(validity.date)}</span>
                <span className={styles.dateMeta}>
                  {validity.date}
                  {days ? ` · ${days}` : ''}
                </span>
              </>
            ) : (
              <>
                <span className={styles.dateBig}>No date</span>
                <span className={styles.dateMeta}>
                  null — abstained rather than pick a date that does not mean an expiry
                </span>
              </>
            )}
          </div>

          <div className={styles.heroChips}>
            <span className={styles.chip}>
              {humanizeEnum(result.document.class)}
              {result.document.issuer ? ` · ${result.document.issuer}` : ''}
              {result.document.side !== 'N/A' ? ` · ${humanizeEnum(result.document.side)}` : ''}
              {result.document.pages > 1 ? ` · ${result.document.pages} pages` : ''}
            </span>
            <span className={styles.chip}>
              {humanizeEnum(validity.basis)} · {validity.verdict}
            </span>
          </div>
        </div>

        {/* Confidence, with the tier that produced it — "0.99 via TA_PDF417" tells
            the whole story and the number alone tells none of it. The ring is a
            conic-gradient over `currentColor`, so it inherits the hero's tone. */}
        <div className={styles.heroConfidence}>
          <div
            className={styles.ring}
            style={{
              background: `conic-gradient(currentColor 0turn ${confidence}turn, var(--border) ${confidence}turn 1turn)`,
            }}
            role="meter"
            aria-valuenow={Number(confidenceText)}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-label="Extraction confidence"
          >
            <div className={styles.ringInner}>
              <span className={styles.ringValue}>{confidenceText}</span>
              <span className={styles.ringLabel}>confidence</span>
            </div>
          </div>
          <span className={styles.tierPill} title={TIER_TEXT[evidence.source_tier]}>
            {evidence.source_tier}
          </span>
        </div>
      </div>

      {/* The route through the tiers. */}
      <PipelineRail
        tier={evidence.source_tier}
        totalMs={result.timing_ms.total}
        costUsd={result.cost_usd}
      />

      {/* Reason codes (§10/§6). Every REVIEW carries at least one; this is what makes
          the abstention machine-readable rather than a shrug, so on REVIEW it is
          rendered immediately under the route rather than buried. A flag on a
          document that still cleared is real but not a call to action, so it keeps
          the quieter neutral treatment. */}
      {result.reason_codes.length > 0 ? (
        <div className={isReview ? styles.reasonsLoud : styles.reasonsQuiet}>
          <h3 className={styles.reasonsTitle}>
            {isReview
              ? `Why a human has to look (${result.reason_codes.length})`
              : `Flags raised (${result.reason_codes.length})`}
          </h3>
          <ul className={styles.reasonList}>
            {result.reason_codes.map((code) => (
              <li key={code} className={styles.reason}>
                <span className={styles.reasonText}>
                  {REASON_TEXT[code] ?? humanizeEnum(code)}
                </span>
                <code className={styles.reasonCode}>{code}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* (b) Basis and rule applied, beside (e) the evidence it was applied to. */}
      <div className={styles.bento}>
        <div className={styles.card}>
          <h3 className={styles.eyebrow}>Basis and rule applied</h3>
          <p className={styles.basis}>
            <span className={styles.basisName}>{humanizeEnum(validity.basis)}</span>
            <code className={styles.codeChip}>{validity.basis}</code>
          </p>
          <p className={styles.rule}>{validity.rule_applied}</p>
          <p className={styles.cardFoot}>
            read{' '}
            {validity.date_raw ? (
              <q className={styles.mono}>{validity.date_raw}</q>
            ) : (
              <span className={styles.faint}>nothing</span>
            )}
            {' · evaluated '}
            {validity.evaluated_at}
            {' · '}
            {validity.timezone_policy}
          </p>
        </div>

        <div className={styles.card}>
          <h3 className={styles.eyebrow}>Evidence</h3>
          {evidence.label_text ? (
            <p className={styles.evidenceLine}>
              Label read on the document:{' '}
              <span className={styles.labelChip}>{evidence.label_text}</span>
            </p>
          ) : (
            <p className={styles.evidenceLine}>
              This field is unlabelled on the document — the value was located by layout.
            </p>
          )}
          {evidence.snippet ? (
            <p className={styles.snippet}>
              {highlightSnippet(evidence.snippet, validity.date_raw)}
            </p>
          ) : null}
          {evidence.bbox ? (
            <p className={styles.regionNote}>
              [{evidence.bbox.map((n) => n.toFixed(3)).join(', ')}] normalized x0, y0,
              x1, y1
            </p>
          ) : (
            <p className={styles.regionNote}>
              no region — the value was not localizable to a specific area of the page
            </p>
          )}
        </div>
      </div>

      {/* The "why?" panel — the differentiator (§10). */}
      <WhyPanel result={result} />

      {/* (f) Collapsible full date inventory. Open by default: it is the proof of
          work, and the mockup opens it too. */}
      <details className={styles.details} open>
        <summary className={styles.summary}>
          <Chevron />
          Full date inventory
          <span className={styles.summaryCount}>{result.all_dates_found.length}</span>
        </summary>
        <div className={styles.detailsBody}>
          <DateInventory dates={result.all_dates_found} selectedIndex={selectedIndex} />
        </div>
      </details>

      {/* Integrity, quality and cost, beside (g) the raw contract. */}
      <div className={styles.bento}>
        <div className={styles.card}>
          <h3 className={styles.eyebrow}>Integrity, quality and cost</h3>
          <dl className={styles.facts}>
            <div>
              <dt>Checksum</dt>
              <dd>
                {integrity.checksum_validated === null
                  ? 'No machine-readable region'
                  : integrity.checksum_validated
                    ? '✔ Passed'
                    : '✕ Failed'}
                {integrity.checksum_detail ? ` — ${integrity.checksum_detail}` : ''}
              </dd>
            </div>
            <div>
              <dt>Cross-source</dt>
              <dd>{integrity.cross_source_agreement ?? 'Only one source was available'}</dd>
            </div>
            <div>
              <dt>Anomalies</dt>
              <dd className={integrity.anomalies.length > 0 ? styles.factAlert : undefined}>
                {integrity.anomalies.length === 0
                  ? 'None'
                  : integrity.anomalies.map((a) => humanizeEnum(a)).join(' · ')}
              </dd>
            </div>
            <div>
              <dt>Sharpness</dt>
              <dd className={styles.mono}>
                {result.quality.laplacian_variance === null
                  ? 'not measured'
                  : result.quality.laplacian_variance.toFixed(1)}
                {result.quality.effective_dpi !== null
                  ? ` · ~${Math.round(result.quality.effective_dpi)} DPI`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>Total time</dt>
              <dd className={styles.mono}>
                {Math.round(result.timing_ms.total).toLocaleString()} ms
              </dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd className={styles.mono}>
                {result.cost_usd === 0
                  ? '$0.00 — no model call'
                  : `$${result.cost_usd.toFixed(4)}`}
              </dd>
            </div>
          </dl>
          <p className={styles.timings}>
            {Object.entries(result.timing_ms)
              .filter(([stage]) => stage !== 'total')
              .map(([stage, ms]) => `${stage} ${Math.round(ms)}ms`)
              .join(' · ')}
          </p>
          <p className={styles.requestId}>
            Request <code>{result.request_id}</code>
          </p>
        </div>

        <details className={`${styles.details} ${styles.jsonCard}`}>
          <summary className={styles.summary}>
            <Chevron />
            Raw JSON response
          </summary>
          <div className={styles.detailsBody}>
            <pre className={styles.json}>{prettyJson(result)}</pre>
          </div>
        </details>
      </div>
    </section>
  );
}
