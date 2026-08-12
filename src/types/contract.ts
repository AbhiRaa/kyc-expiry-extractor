/**
 * The response contract. This is the interface: the UI, the eval harness, and every
 * tier are built against it. Freeze it early — changing it after Wave 1 means touching
 * every module.
 *
 * Mirrors §6 of docs/BRIEF.md with one deliberate deviation, recorded in the README
 * decision log:
 *
 *   G1 — the brief specifies `evidence.crop_url: "/api/crop/<id>"`, described as
 *   in-memory and expiring with the request. Vercel functions are stateless with no
 *   shared memory across invocations, so that URL 404s whenever the follow-up request
 *   lands on a different instance. We do not stand up a substitute endpoint or inline
 *   the pixels either — the server returns `evidence.bbox` (coordinates only) and
 *   nothing else, so no document pixels are ever serialized into a response at all.
 *   This makes the "no documents are stored" claim stronger than the brief's own
 *   design: not "expires with the request" but "never leaves the server as pixels in
 *   the first place." The client already holds the original image it uploaded, so it
 *   draws its own highlight from the bbox rather than round-tripping pixels back.
 */

// ---------------------------------------------------------------------------
// Document classification
// ---------------------------------------------------------------------------

export const DOCUMENT_CLASSES = [
  'US_DRIVERS_LICENSE',
  'US_STATE_ID',
  'NON_US_DRIVERS_LICENSE',
  'PASSPORT',
  'NATIONAL_ID_CARD',
  'RESIDENCE_PERMIT',
  'MEDICAL_INSURANCE_CARD',
  'BANK_STATEMENT',
  'UTILITY_BILL',
  'EMPLOYMENT_LETTER',
  'OTHER_DOCUMENT',
  'NOT_A_DOCUMENT',
] as const;
export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];

export type DocumentSide = 'FRONT' | 'BACK' | 'BOTH' | 'UNKNOWN' | 'N/A';

// ---------------------------------------------------------------------------
// Validity — the output is not a date, it is a verdict plus the basis it was
// reached on (§4.3). Different document classes are validated by different rules.
// ---------------------------------------------------------------------------

/**
 * EXPIRY_DATE     — DL / passport. Must be unexpired at submission (31 CFR 1020.220).
 * RECENCY_WINDOW  — utility bill (90d), bank statement (commonly 180d). FATF Rec. 10.
 * COVERAGE_END    — insurance coverage period end; frequently unlabelled.
 * NO_EXPIRY       — employment letter and friends. Abstain; do not pick a termination date.
 * UNDETERMINED    — we could not establish which rule applies.
 */
export const VALIDITY_BASES = [
  'EXPIRY_DATE',
  'RECENCY_WINDOW',
  'COVERAGE_END',
  'NO_EXPIRY',
  'UNDETERMINED',
] as const;
export type ValidityBasis = (typeof VALIDITY_BASES)[number];

export type Verdict = 'VALID' | 'EXPIRED' | 'NOT_APPLICABLE' | 'INDETERMINATE';

/**
 * `REJECTED` is a fourth, terminal decision, distinct from `REVIEW`: `REVIEW` means a
 * human should look at this; `REJECTED` means it never enters the queue at all — the
 * admission gate (Stage -1, see `src/pipeline/gate.ts`) found confident evidence the
 * input isn't a KYC-relevant document before any extraction tier ran.
 */
export type Decision = 'AUTO_PASS' | 'AUTO_FAIL' | 'REVIEW' | 'REJECTED';

export type SourceTier = 'TA_MRZ' | 'TA_PDF417' | 'TB_OCR' | 'TC_VLM' | 'NONE';

/**
 * What a date appears to signify. The Mapper returns these; the constraint engine
 * treats them as evidence, never as ground truth.
 */
export const DATE_ROLES = [
  'DATE_OF_BIRTH',
  'ISSUE',
  'EXPIRY',
  'COVERAGE_START',
  'COVERAGE_END',
  'STATEMENT_PERIOD_START',
  'STATEMENT_PERIOD_END',
  'EMPLOYMENT_START',
  'EMPLOYMENT_END',
  'APPRAISAL',
  'PRINT_DATE',
  'TRANSACTION',
  'UNKNOWN',
] as const;
export type DateRole = (typeof DATE_ROLES)[number];

// ---------------------------------------------------------------------------
// Reason codes — every REVIEW must carry at least one. This is what makes the
// abstention path machine-readable rather than a shrug.
// ---------------------------------------------------------------------------

export const REASON_CODES = [
  // Input quality
  'IMAGE_TOO_BLURRY',
  'RESOLUTION_TOO_LOW',
  'GLARE_OBSCURES_FIELD',
  'DOCUMENT_CROPPED',
  'EXTREME_SKEW',
  'POOR_CONTRAST',
  'OBSTRUCTED_BY_HAND',
  'PHOTOCOPY_DEGRADED',

  // Document
  'CLASS_UNRECOGNIZED',
  'UNSUPPORTED_SCRIPT',
  'WRONG_SIDE_CAPTURED',
  'MULTIPLE_DOCUMENTS_IN_FRAME',
  'TEMPORARY_DOCUMENT',
  'NO_MACHINE_READABLE_REGION',

  // Input rejection (T0-B / G10) — hard failures on the bytes themselves, distinct from
  // the soft, advisory quality codes above and from CLASS_UNRECOGNIZED (unreadable file
  // vs. readable-but-unclassifiable document).
  'UNSUPPORTED_TYPE',
  'CORRUPT_FILE',
  'ENCRYPTED_PDF',

  // Admission gate (Stage -1 / A-series, v2 client rework) — fired before any extraction
  // tier runs. Distinct from CLASS_UNRECOGNIZED (a tier tried and couldn't classify what
  // it saw) and from NOT_A_DOCUMENT (classify.ts's post-hoc, evidence-of-absence finding):
  // these mean nothing was ever tried, because the gate was confident it shouldn't be.
  'OUT_OF_DOMAIN',
  'NOT_A_DOCUMENT_IMAGE',
  'SCREEN_CAPTURE_NOT_DOCUMENT',
  'NO_DOMAIN_SIGNAL',

  // Extraction
  'NO_DATES_FOUND',
  'NO_EXPIRY_SEMANTICS',
  'AMBIGUOUS_DATE_FORMAT',
  'MULTIPLE_EXPIRY_CANDIDATES',
  'HUNTER_MAPPER_DISAGREE',
  'VALUE_NOT_GROUNDED_IN_OCR',
  'LOW_TIER_CONFIDENCE',

  // Integrity
  'CHECKSUM_FAILED',
  'MRZ_VIZ_MISMATCH',
  'BARCODE_PRINT_MISMATCH',
  'EXPIRY_BEFORE_ISSUE',
  'IMPLAUSIBLE_VALIDITY_PERIOD',
  'FUTURE_DATED_ISSUE',
  'DOB_AFTER_EXPIRY',

  // Security / ops
  'PROMPT_INJECTION_SUSPECTED',
  'SCREEN_RECAPTURE_SUSPECTED',
  'MODEL_UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'COST_CAP_REACHED',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Anomalies are integrity findings; any one of them forces REVIEW regardless of confidence. */
export const INTEGRITY_ANOMALIES = [
  'EXPIRY_BEFORE_ISSUE',
  'IMPLAUSIBLE_VALIDITY_PERIOD',
  'FUTURE_DATED_ISSUE',
  'DOB_AFTER_EXPIRY',
  'MRZ_VIZ_MISMATCH',
  'BARCODE_PRINT_MISMATCH',
  'CHECKSUM_FAILED',
] as const;
export type IntegrityAnomaly = (typeof INTEGRITY_ANOMALIES)[number];

// ---------------------------------------------------------------------------
// Admission gate (Stage -1). Three-way, not binary: it authorizes budget, not just
// entry. See docs/DECISIONS.md §8 for the full design record and the asymmetry rule.
// ---------------------------------------------------------------------------

export type AdmissionDecision = 'REJECT' | 'ADMIT_LIMITED' | 'ADMIT_FULL';

export type GateSignalName = 'DOCUMENT_LIKENESS' | 'SCREEN_CAPTURE' | 'POSITIVE_DOMAIN_SIGNAL';

/**
 * Mirrors `FoundDate.eliminated_by` — the same "make the reasoning legible, not magical"
 * pattern applied one layer earlier. `outcome` is deliberately never a graded confidence:
 * the asymmetry rule (docs/DECISIONS.md A2) requires each signal to be either a confident
 * finding or nothing at all, with no smeared-out "sort of" that could be misread as
 * evidence strong enough to reject on.
 */
export interface GateSignalOutcome {
  signal: GateSignalName;
  outcome: 'CONFIDENT_NEGATIVE' | 'CONFIDENT_POSITIVE' | 'UNCERTAIN' | 'NOT_FOUND';
  detail: string;
  /** The individual measurements that fed the outcome, e.g. "periodicity=0.02". */
  evidence: string[];
}

export interface AdmissionInfo {
  decision: AdmissionDecision;
  /** Only the signals actually evaluated — cost-ordered, stops at the first confident
   *  finding. A REJECT via signal 1 alone has a 1-entry array; that brevity is itself
   *  informative (the cheapest possible path) for the "why?" panel. */
  signals: GateSignalOutcome[];
  /**
   * Estimated VLM spend this document was kept from costing, in USD. Populated for
   * REJECT (a flat upper-bound estimate — nothing ran, so this is necessarily
   * hypothetical) and for ADMIT_LIMITED (computed by the router once it reaches the
   * point it would have escalated to TC — zero when TA/TB would have resolved the
   * document anyway and the block was never consequential). Null for ADMIT_FULL, where
   * nothing was avoided.
   */
  spend_avoided_usd: number | null;
}

// ---------------------------------------------------------------------------
// CRM emission (v2 client rework, docs/DECISIONS.md §9) — a side effect of a
// verdict, not part of it. Modeled on HubSpot's properties-plus-associations
// object shape (the client's primary platform); the actual property/object
// names live in one exported map (src/pipeline/crm.ts), not hardcoded here or
// duplicated at each call site.
// ---------------------------------------------------------------------------

export interface CrmAssociation {
  toObjectType: string;
  toObjectId: string;
  associationType: string;
}

export interface CrmPayload {
  objectType: string;
  /** Derived from the document's content hash (§11.1 #14 already anticipated this for
   *  free repeat uploads) — a retried upload of identical bytes produces the same key,
   *  so the CRM can dedupe rather than open a second review task for one document. */
  idempotencyKey: string;
  properties: Record<string, string | number | boolean | null>;
  associations: CrmAssociation[];
}

export type CrmDeliveryStatus = 'not_configured' | 'sent' | 'failed';

export interface CrmDeliveryInfo {
  status: CrmDeliveryStatus;
  reason: string | null;
  attempted_at: string | null;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** Normalized [x0, y0, x1, y1], each in [0,1]. Null when the value is not localizable. */
export type BBox = [number, number, number, number];

export interface DocumentInfo {
  class: DocumentClass;
  class_confidence: number;
  /** US state code, ISO 3166-1 alpha-3, or null. */
  issuer: string | null;
  pages: number;
  side: DocumentSide;
}

export interface ValidityInfo {
  basis: ValidityBasis;
  /** ISO 8601 (YYYY-MM-DD), or null when no date underpins the verdict. */
  date: string | null;
  /** Exactly as read from the source, before normalization. Kept so a policy change stays auditable. */
  date_raw: string | null;
  /** Human-readable statement of the rule applied, e.g. the CIP unexpired-document requirement. */
  rule_applied: string;
  verdict: Verdict;
  days_remaining: number | null;
  evaluated_at: string;
  timezone_policy: string;
}

export interface EvidenceInfo {
  source_tier: SourceTier;
  /** Verbatim label found on the document, or the AAMVA/MRZ field id. Null when unlabelled. */
  label_text: string | null;
  /** The source text the value was read from. */
  snippet: string | null;
  /** G1: coordinates only. No document pixels are ever returned by the server. */
  bbox: BBox | null;
}

export interface IntegrityInfo {
  /** MRZ check digits / barcode ECC. Null when no machine-readable region was present. */
  checksum_validated: boolean | null;
  checksum_detail: string | null;
  /** e.g. "MRZ expiry matches printed VIZ expiry". Null when only one source was available. */
  cross_source_agreement: string | null;
  anomalies: IntegrityAnomaly[];
}

/** The full date inventory. Always returned — this is the demo's proof of work. */
export interface FoundDate {
  raw: string;
  iso: string | null;
  label_verbatim: string | null;
  inferred_role: DateRole;
  confidence: number;
  bbox?: BBox | null;
  /**
   * Populated by the constraint engine when a candidate was ruled out. The UI's "why?"
   * panel reads this — it is the single most persuasive thing in the demo, because it
   * makes the reasoning legible instead of magical.
   */
  eliminated_by?: string | null;
}

export interface QualityMetrics {
  /** Laplacian variance of the extraction-region crop where available, else the page. */
  laplacian_variance: number | null;
  mean_luminance: number | null;
  clipping_ratio: number | null;
  skew_angle_deg: number | null;
  effective_dpi: number | null;
}

export interface TimingMs {
  total: number;
  normalize: number;
  tier: number;
  [stage: string]: number;
}

export interface ExtractionResponse {
  request_id: string;
  document: DocumentInfo;
  validity: ValidityInfo;
  decision: Decision;
  confidence: number;
  /** Always populated on REVIEW. */
  reason_codes: ReasonCode[];
  evidence: EvidenceInfo;
  integrity: IntegrityInfo;
  all_dates_found: FoundDate[];
  quality: QualityMetrics;
  timing_ms: TimingMs;
  cost_usd: number;
  /** Absent only on the pre-existing T0-level rejection path (corrupt/unsupported file),
   *  which never reaches the gate at all — see rejectionResponse() in router.ts. Every
   *  other path, including a gate REJECT, populates this. */
  admission?: AdmissionInfo;
  /** Absent exactly when decision === 'REJECTED' — the gate's own asymmetry rule (§8 A2)
   *  extended one layer out: input that never entered the review queue must not create
   *  CRM noise either. Present on every other path regardless of whether CRM_WEBHOOK_URL
   *  is configured, so the payload is inspectable in the demo without any CRM set up. */
  crm_payload?: CrmPayload;
  /** Present exactly when crm_payload is. Delivery is attempted synchronously with a
   *  bounded timeout and never throws — a CRM outage affects this field, never the
   *  extraction verdict or the response status. See docs/DECISIONS.md §9. */
  crm_delivery?: CrmDeliveryInfo;
}

// ---------------------------------------------------------------------------
// Internal tier results. Every tier may abstain; abstention is a first-class
// return value, not an error. No tier is allowed to return a low-confidence
// guess to keep the pipeline moving (§5 design rule).
// ---------------------------------------------------------------------------

export interface TierCandidate {
  raw: string;
  iso: string | null;
  role: DateRole;
  label_verbatim: string | null;
  snippet: string | null;
  bbox: BBox | null;
  /** Tier-local confidence in this individual reading, before fusion. */
  confidence: number;
}

export interface TierResult {
  tier: SourceTier;
  abstained: boolean;
  candidates: TierCandidate[];
  reason_codes: ReasonCode[];
  anomalies: IntegrityAnomaly[];
  checksum_validated: boolean | null;
  checksum_detail: string | null;
  issuer: string | null;
  /**
   * TC's own document-type read (Mapper's `document_type`), independent of whatever
   * `documentClass` it was told going in. §7.6's design already intended this: classify
   * cheaply first, escalate to the VLM only when `inconclusive`, and let the VLM's own
   * read settle it — `ClassificationResult.hypotheses` exists specifically to narrow what
   * the VLM is asked. Exposed here so the router can act on it when the initial pass
   * could not name a class at all.
   */
  mapper_document_class?: DocumentClass | null;
  /** Raw OCR token stream, used to ground VLM output against what is actually on the page (G5). */
  grounding_tokens?: string[];
  cost_usd: number;
  duration_ms: number;
}

export function abstain(
  tier: SourceTier,
  reasons: ReasonCode[],
  partial: Partial<TierResult> = {},
): TierResult {
  return {
    tier,
    abstained: true,
    candidates: [],
    reason_codes: reasons,
    anomalies: [],
    checksum_validated: null,
    checksum_detail: null,
    issuer: null,
    cost_usd: 0,
    duration_ms: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timezone policy applied to every verdict, surfaced in the response so it is auditable. */
export const TIMEZONE_POLICY = 'UTC, end-of-day inclusive';

/** Recency windows in days, by document class (§4.3). */
export const RECENCY_WINDOW_DAYS: Partial<Record<DocumentClass, number>> = {
  UTILITY_BILL: 90,
  BANK_STATEMENT: 180,
};

/**
 * Routing thresholds, DERIVED from the measured accuracy-at-coverage curve rather than
 * chosen as round numbers (§9 [DECIDE]).
 *
 * The build shipped 0.90 / 0.70 as placeholders. Running the eval produced this curve:
 *
 *   threshold   coverage   accuracy   confidently wrong
 *   0.70        72.0%      77.8%      4
 *   0.80        68.0%      82.4%      3
 *   0.90        44.0%      90.9%      1
 *   0.95        28.0%     100.0%      0
 *
 * Confidently wrong is the only truly bad outcome in a system with no human in the loop —
 * a REVIEW costs a reviewer's minute, an AUTO_PASS on a bad document costs a bad KYC
 * decision with no recourse. The single confidently-wrong case sits at confidence 0.93,
 * so 0.90 admits it and 0.95 does not.
 *
 * Raising the bar to 0.95 costs 16 points of coverage and buys the elimination of every
 * confident error. It also lands somewhere principled rather than arbitrary: only
 * self-validating sources — MRZ with passing check digits, PDF417 with intact Reed-Solomon
 * ECC — clear 0.95. OCR and VLM readings, which have no checksum, never auto-clear on
 * their own. That is the architecture's own thesis falling out of the measurement.
 *
 * The review floor stays at 0.70: below it the reason codes are what matter, and nothing
 * in the curve distinguishes 0.5 from 0.7 in outcome.
 */
export const AUTO_THRESHOLD = 0.95;
export const REVIEW_FLOOR = 0.7;

/** Deterministic-tier confidence. PDF417 carries Reed-Solomon ECC and MRZ carries
 *  check digits, so a clean decode is self-validating. */
export const DETERMINISTIC_CONFIDENCE = 0.99;

/**
 * Hard ceiling on the whole pipeline, well inside the platform function limit
 * (`maxDuration = 60` in the extract route). Originally 25s, tuned against the synthetic
 * eval corpus's small, single-purpose images. Real-world scans are bigger and denser —
 * measured 22-27s end to end against real dense multi-page passport PDFs at full
 * rasterization DPI — so 25s left the tier that matters most on the hardest documents
 * (TC, the last resort once TA/TB have both abstained) with too little room. Raised to
 * leave real headroom under the platform ceiling rather than routinely brushing it.
 */
export const PIPELINE_BUDGET_MS = 45_000;
