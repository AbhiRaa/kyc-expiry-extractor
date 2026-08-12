/**
 * The tiered router (§5). This is where the four tiers become one system.
 *
 * Cheap deterministic paths first; the expensive path fires only when the cheap ones
 * abstain. Every tier may abstain, and abstention is a first-class return value — no tier
 * is allowed to return a low-confidence guess to keep the pipeline moving.
 *
 * Order and cost:
 *   T0  normalize + classify                          ~$0
 *   TA  MRZ / PDF417   (parallel, self-validating)    ~$0
 *   TB  layout OCR + label lexicon                    ~$0.001
 *   TC  Hunter ∥ Mapper dual VLM call                 2 calls
 *   -> constraint engine -> validity rule -> fusion -> routing
 *
 * G5 (deviation from the brief): TB always runs before TC and always publishes its OCR
 * token stream, EVEN WHEN IT ABSTAINS on label matching. In the brief as written, OCR only
 * happens inside TB and TC fires precisely when TB abstains — so the prompt-injection
 * defence in §11.5 #66, which cross-checks VLM output against the raw OCR stream, would
 * have nothing to check against. One extra OCR pass buys a defence that actually fires.
 */

import { randomUUID } from 'node:crypto';

import {
  type AdmissionInfo,
  type Decision,
  type DocumentClass,
  type ExtractionResponse,
  type FoundDate,
  type IntegrityAnomaly,
  PIPELINE_BUDGET_MS,
  type QualityMetrics,
  type ReasonCode,
  type SourceTier,
  type TierResult,
  TIMEZONE_POLICY,
} from '@/types/contract';
import { fuseConfidence, route } from '@/engine/confidence';
import { type DateCandidate, makeCandidate, runConstraintEngine } from '@/engine/constraints';
import {
  BASIS_BY_CLASS,
  evaluateValidity,
  hasExplicitNonExpiringLabel,
} from '@/engine/validity';
import { type GateInput, runAdmissionGate } from './gate';
import {
  cropAndDownscale,
  DOWNSCALE_LONG_EDGE,
  isNormalized,
  type NormalizedPage,
  type NormalizeOutcome,
  rejectionToTierResult,
} from './normalize';
import { classifyDocument } from './classify';
import { extractMrz } from './tier-a-mrz';
import { extractFromAamvaPayload, extractPdf417 } from './tier-a-pdf417';
import { crossCheck, type DateTriple } from './cross-check';
import {
  defaultOcrRunner,
  estimateMachineReadableZone,
  extractTierBOcr,
  type OcrPage,
  type OcrRunner,
  reconstructLines,
} from './tier-b-ocr';
import { ESTIMATED_DUAL_CALL_COST_USD, runTierCVlm } from './tier-c-vlm';
import type { VlmClient } from './vlm-client';

/**
 * A tier threw instead of resolving or abstaining cleanly. Log the fact and the error's
 * shape only — never document content, never extracted values (§15) — so a genuine bug is
 * at least visible in the platform logs instead of silently degrading to an abstention
 * indistinguishable from "nothing was found".
 */
function logTierFailure(tier: string, error: unknown): null {
  console.error(`[router] ${tier} threw`, {
    name: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : String(error),
  });
  return null;
}

/**
 * Confidence assigned when TC's own document-type read settles a classification the cheap
 * pass called `inconclusive` (§7.6). Below classify.ts's confident-match range (~0.6-0.97)
 * since it is a single, uncross-checked VLM read of the class itself — but well above the
 * 0.25 "gave up" floor `classifyDocument` reports for `OTHER_DOCUMENT`, since a real read
 * of the actual pixels is real evidence, not a guess.
 */
const TC_CLASSIFICATION_CONFIDENCE = 0.7;

/** Document classes that are identity documents, for the DOB-earliest constraint. */
const IDENTITY_CLASSES: ReadonlySet<DocumentClass> = new Set<DocumentClass>([
  'US_DRIVERS_LICENSE',
  'US_STATE_ID',
  'PASSPORT',
  'NATIONAL_ID_CARD',
  'RESIDENCE_PERMIT',
]);

export interface RouterDependencies {
  /** Injected so the whole pipeline is testable without a network or an API key. */
  vlmClient?: VlmClient;
  /** Substitute OCR, for tests that pin a page without a recognition pass. */
  ocr?: OcrRunner;
  /** Anchor date. Injected rather than read from the clock so eval results are stable. */
  today?: Date;
  /** Remaining spend for this document (§11.6 #74). */
  budgetUsd?: number;
  /** Hard ceiling on the whole pipeline. */
  budgetMs?: number;
}

export interface RouterInput extends RouterDependencies {
  outcome: NormalizeOutcome;
  /**
   * A PDF417/MRZ payload the CLIENT decoded at full resolution before downscaling (G2).
   * Treated as UNTRUSTED INPUT: re-parsed and re-checksummed server-side, never accepted
   * as a verdict on the client's say-so.
   */
  clientDecodedBarcode?: string;
}

/**
 * Run the full pipeline and produce the response contract.
 *
 * Never throws for document reasons — every failure path resolves to a REVIEW decision
 * carrying at least one machine-readable reason code. A reviewer who cannot see why a
 * document reached them cannot triage it.
 */
export async function runPipeline(input: RouterInput): Promise<ExtractionResponse> {
  const started = Date.now();
  const today = input.today ?? new Date();
  const budgetMs = input.budgetMs ?? PIPELINE_BUDGET_MS;
  const requestId = randomUUID();

  // --- T0 -----------------------------------------------------------------
  if (!isNormalized(input.outcome)) {
    return rejectionResponse(requestId, input.outcome, today, Date.now() - started);
  }

  const doc = input.outcome;
  const page = doc.pages[0];
  const normalizeMs = Date.now() - started;

  // --- Stage -1: admission gate ---------------------------------------------
  // Runs before any extraction tier, on pixel statistics and (at most) one cheap OCR
  // presurvey — see gate.ts for the full design record (docs/DECISIONS.md §8). A gate
  // exception is not confident negative evidence, so it fails OPEN to ADMIT_FULL, never
  // closed to REJECT — the asymmetry rule applies to failure modes too, not just to the
  // signals themselves.
  const gateStarted = Date.now();
  let admission: AdmissionInfo = await runAdmissionGate(gateInputFor(page, input.ocr)).catch((error) => {
    logTierFailure('GATE', error);
    return { decision: 'ADMIT_FULL', signals: [], spend_avoided_usd: null };
  });
  const gateMs = Date.now() - gateStarted;

  if (admission.decision === 'REJECT') {
    return gateRejectedResponse(requestId, admission, page, today, Date.now() - started, normalizeMs, gateMs);
  }
  const admitLimited = admission.decision === 'ADMIT_LIMITED';

  const tierStarted = Date.now();

  const reasonCodes: ReasonCode[] = [...page.reasonCodes];
  const anomalies: IntegrityAnomaly[] = [];
  let costUsd = 0;

  // --- TA-PDF417 first: pixels only, no OCR, genuinely free ----------------
  // Ordering matters for the cost table. The barcode path needs no text extraction at
  // all, so trying it first means a clean DL back never pays for an OCR pass.
  const pdf417Result = input.clientDecodedBarcode
    ? // G2: the client decoded at full resolution before downscaling. Treated as
      // UNTRUSTED INPUT — re-parsed and re-checksummed here, never taken on trust.
      extractFromAamvaPayload(input.clientDecodedBarcode, { today })
    : await extractPdf417({
        image: toUint8(page.fullResolution),
        today,
        quality: { effectiveDpi: page.quality.effective_dpi },
      }).catch((error) => logTierFailure('TA_PDF417', error));

  const barcodeOk = Boolean(pdf417Result && !pdf417Result.abstained);

  // --- One OCR pass, serving three consumers -------------------------------
  // MRZ band detection, TB label matching, and the TC grounding stream (G5) all read the
  // same recognition result. Running OCR once and fanning it out keeps the tier cost
  // table honest; running it per-consumer would triple the TB line for no benefit.
  let ocrPage: OcrPage | null = null;
  let tbResult: TierResult | null = null;

  const needsText = !barcodeOk;
  if (needsText && withinBudget(started, budgetMs, 4000)) {
    const runner: OcrRunner = input.ocr ?? defaultOcrRunner;
    const capturing: OcrRunner = async (image) => {
      const result = await runner(image);
      ocrPage = result;
      return result;
    };
    tbResult = await extractTierBOcr({
      image: page.fullResolution,
      ocr: capturing,
      today,
      issuerConvention: inferIssuerConvention(page.textLayer),
    }).catch((error) => logTierFailure('TB_OCR', error));
    if (tbResult) costUsd += tbResult.cost_usd;
  }

  // --- TA-MRZ, off the same OCR result -------------------------------------
  const ocrLines = ocrPage ? reconstructLines(ocrPage) : null;
  const mrzSource = ocrLines ?? (page.textLayer ? page.textLayer.split('\n') : null);
  const mrzResult = mrzSource ? safely(() => extractMrz({ source: mrzSource, today })) : null;
  const mrzOk = Boolean(mrzResult && !mrzResult.abstained);

  // --- Classification, now that machine-readable presence is known ---------
  // §7 T0.6: cheap first pass on aspect ratio PLUS detected barcode/MRZ presence. Those
  // signals only exist after TA has run, which is why classification sits here.
  const classification = classifyDocument({
    width: page.fullWidth,
    height: page.fullHeight,
    sourceFormat: doc.sourceFormat === 'PDF' ? 'PDF' : 'IMAGE',
    pageCount: doc.pages.length,
    hasPdf417: barcodeOk,
    hasMrz: mrzOk,
    // The classifier's MRZ shortcut needs the layout, not just its presence: TD3 is a
    // passport, TD1 is a card-format ID or residence permit. Without it a decoded MRZ
    // falls through to keyword and shape guessing, which is exactly what it should
    // short-circuit.
    mrzFormat: mrzOk ? mrzFormatOf(mrzResult) : null,
    mrzIssuer: mrzResult?.issuer ?? null,
    // `classifyDocument`'s DCA/DCG element parsing (T0-F, G11) expects the raw AAMVA
    // element stream, one `<id><value>` per line — exactly the shape `grounding_tokens`
    // is already built in (tier-a-pdf417.ts). `checksum_detail` is human-readable prose
    // and never contains a literal "DCA"/"DCG" element, so feeding it here silently
    // defeated every DCA/DCG check below: a decoded DL always fell through to
    // "no vehicle class" and was misclassified as US_STATE_ID.
    barcodeSample: barcodeOk ? (pdf417Result?.grounding_tokens?.join('\n') ?? null) : null,
    // A PDF's embedded text layer is exact; OCR output is a recognition guess. The
    // classifier weighs a keyword hit differently depending on which it got.
    textSample: page.textLayer ?? ((tbResult?.grounding_tokens ?? []).join(' ') || null),
    textProvenance: page.textLayer ? 'EXACT' : 'OCR',
    quality: page.quality,
  });
  // Reconsidered below, once TC has run, if classification could not name a class at all.
  let documentClass = classification.class;
  let classConfidence = classification.confidence;
  reasonCodes.push(...classification.reasonCodes);

  // --- Cross-check machine-readable against printed (§7) -------------------
  // Agreement raises confidence; disagreement is a tamper signal, never a tie to break.
  let crossSourceAgreement: boolean | null = null;
  let crossSourceDetail: string | null = null;
  if (mrzOk && barcodeOk) {
    const cc = crossCheck({
      machine: { source: 'MRZ', dates: dateTripleOf(mrzResult!) },
      printed: { dates: dateTripleOf(pdf417Result!) },
      today,
    });
    crossSourceAgreement = !cc.force_review;
    crossSourceDetail = cc.cross_source_agreement;
    for (const a of cc.anomalies) if (!anomalies.includes(a)) anomalies.push(a);
    reasonCodes.push(...cc.reason_codes);
  }

  const deterministicWon = (mrzOk || barcodeOk) && anomalies.length === 0;
  const groundingTokens = tbResult?.grounding_tokens ?? [];

  // --- TC: only when TA and TB both abstained, AND the gate admits it -------
  let tcResult: TierResult | null = null;
  const needVlm = !deterministicWon && (!tbResult || tbResult.abstained);
  if (needVlm && admitLimited) {
    // The gate found no positive domain signal (NO_DOMAIN_SIGNAL) and capped this
    // document at ADMIT_LIMITED — the paid tier is hard-blocked regardless of what TA/TB
    // returned. This does NOT touch TA/TB themselves, which already ran unconditionally
    // above: a document that actually decoded a barcode or MRZ cleanly already set
    // `deterministicWon = true` and never reaches this branch at all, so a genuinely
    // strong deterministic result is never suppressed by gate uncertainty.
    admission = { ...admission, spend_avoided_usd: ESTIMATED_DUAL_CALL_COST_USD };
    reasonCodes.push('NO_DOMAIN_SIGNAL');
  } else if (needVlm && input.vlmClient && withinBudget(started, budgetMs, 9000)) {
    // A phone-scanned "book spread" of an open passport routinely captures a second,
    // unrelated page above the bio-data page in the same shot — TC attending to the whole
    // cluttered composite reads worse than TC attending to a focused crop of the document
    // itself. Crop toward the machine-readable band when OCR found a hint of one; every
    // non-identity document class has no such hint, so this is a no-op for the rest of the
    // corpus. Cropping from the full-resolution buffer (not the already-downscaled one)
    // means more effective pixels on the part that matters, not just a smaller field of view.
    const zone = ocrLines ? estimateMachineReadableZone(ocrLines) : null;
    const vlmImageBuffer = zone
      ? await cropAndDownscale(page.fullResolution, zone, DOWNSCALE_LONG_EDGE).catch(() => page.downscaled)
      : page.downscaled;
    tcResult = await runTierCVlm(input.vlmClient, {
      image: { base64: vlmImageBuffer.toString('base64'), mediaType: 'image/jpeg' },
      documentClass,
      issuerConvention: inferIssuerConvention(classification.issuer),
      today,
      budgetUsd: input.budgetUsd,
      timeBudgetMs: Math.max(0, budgetMs - (Date.now() - started)),
    }).catch((error) => logTierFailure('TC_VLM', error));
    if (tcResult) costUsd += tcResult.cost_usd;
  } else if (needVlm && !input.vlmClient) {
    reasonCodes.push('MODEL_UNAVAILABLE');
  } else if (needVlm) {
    reasonCodes.push('TIMEOUT');
  }

  // --- Reconsider classification with TC's own read, if the cheap pass gave up --------
  // §7.6's own design already intended this: classify cheaply and honestly first, escalate
  // to the VLM only when `inconclusive`, and let its own read settle it once it has
  // actually looked at the page. Gated on `inconclusive` specifically, not a confidence
  // threshold, so a classification that succeeded with merely moderate confidence is never
  // silently overridden by a single, uncross-checked VLM read of the class itself.
  if (classification.inconclusive && tcResult?.mapper_document_class) {
    documentClass = tcResult.mapper_document_class;
    classConfidence = TC_CLASSIFICATION_CONFIDENCE;
  }

  // --- Tier results, ordered by SOURCE AUTHORITY, not execution order ------
  // This ordering is load-bearing. `collectCandidates` de-duplicates by (iso, role) and
  // keeps the first occurrence, and `sourceTierOf` attributes the winner to the first
  // tier that reported it. Execution order runs OCR before MRZ (one OCR pass feeds both),
  // so pushing results as they complete meant an identical date read by both tiers was
  // credited to TB at 0.80 instead of TA-MRZ at 0.99 — right answer, wrong provenance,
  // and a passport that should auto-clear landed in the review queue instead.
  const tierResults: TierResult[] = [];
  for (const r of [pdf417Result, mrzResult, tbResult, tcResult]) if (r) tierResults.push(r);

  // --- Constraint engine over the UNION of every tier's candidates ---------
  const candidates = collectCandidates(tierResults);
  const hunterMapperRaw = extractCrossCallValues(tcResult);

  const outcome = runConstraintEngine({
    candidates,
    today,
    isIdentityDocument: IDENTITY_CLASSES.has(documentClass),
    recencyValidated: BASIS_BY_CLASS[documentClass] === 'RECENCY_WINDOW',
    groundingTokens: groundingTokens.length > 0 ? groundingTokens : undefined,
    hunterRawValues: hunterMapperRaw?.hunter,
    mapperRawValues: hunterMapperRaw?.mapper,
  });

  for (const a of outcome.anomalies) if (!anomalies.includes(a)) anomalies.push(a);
  reasonCodes.push(...outcome.reasonCodes);
  for (const r of tierResults) {
    reasonCodes.push(...r.reason_codes);
    for (const a of r.anomalies) if (!anomalies.includes(a)) anomalies.push(a);
  }

  // --- Validity rule -------------------------------------------------------
  const winner = outcome.survivors[0] ?? null;
  const winningTier = sourceTierOf(winner, tierResults);

  // An explicit "NON-EXPIRING" label overrides the class default (§11.4 #48). Checked
  // against every bound candidate's own label/value text, which is enough when the
  // declaration sits right where a date would.
  //
  // Insurance cards get a second, wider check: "coverage continuous while employed" is
  // prose elsewhere on the card, not attached to any label-value pair, so it never shows
  // up in a candidate's snippet — there is no candidate at all once the card's only date
  // (an effective/start date) is correctly excluded as non-expiry evidence. Scoped to
  // MEDICAL_INSURANCE_CARD with no winner so it can never override a real coverage-end
  // date found elsewhere on a busier card, and never touches other classes.
  const explicitNonExpiring =
    tierResults.some((r) => r.candidates.some((c) => hasExplicitNonExpiringLabel(c.label_verbatim ?? c.snippet))) ||
    (documentClass === 'MEDICAL_INSURANCE_CARD' &&
      !winner &&
      hasExplicitNonExpiringLabel(groundingTokens.join(' ')));

  const validity = evaluateValidity({
    documentClass,
    dateIso: explicitNonExpiring ? null : (winner?.iso ?? null),
    dateRaw: explicitNonExpiring ? null : (winner?.raw ?? null),
    today,
    basisOverride: explicitNonExpiring ? 'NO_EXPIRY' : undefined,
  });

  // --- Confidence fusion ---------------------------------------------------
  const winningTierResult = tierResults.find((r) => r.tier === winningTier) ?? null;
  const fused = fuseConfidence({
    tier: winningTier,
    checksumValidated: winningTierResult?.checksum_validated ?? null,
    crossSourceAgreement,
    crossCallAgreement: hunterMapperRaw ? hunterMapperAgreed(winner, hunterMapperRaw) : null,
    ocrGrounded: groundingTokens.length > 0 && winner ? isWinnerGrounded(winner, outcome) : null,
    quality: page.quality,
    hardConstraintsChecked: outcome.hardConstraintsChecked,
    survivingCandidates: outcome.survivors.length,
    softScore: winner?.score ?? 0,
    anomalies,
  });
  reasonCodes.push(...fused.reasonCodes);

  // A correct abstention on a NO_EXPIRY class is a confident right answer, not a low
  // one — the class genuinely has no expiry, so there is nothing to be unsure about.
  const confidence =
    BASIS_BY_CLASS[documentClass] === 'NO_EXPIRY' && validity.verdict === 'NOT_APPLICABLE'
      ? Math.max(fused.confidence, 0.92)
      : fused.confidence;

  const routed = route({
    confidence,
    verdict: validity.verdict,
    anomalies,
    hardConstraintFailed: outcome.eliminated.length > 0 && outcome.survivors.length === 0,
    reasonCodes,
  });

  const totalMs = Date.now() - started;

  return {
    request_id: requestId,
    document: {
      class: documentClass,
      class_confidence: classConfidence,
      issuer: classification.issuer ?? winningTierResult?.issuer ?? null,
      pages: doc.pages.length,
      side: classification.side,
    },
    validity,
    decision: routed.decision,
    confidence,
    reason_codes: routed.decision === 'REVIEW' ? dedupe(routed.reasonCodes) : dedupe(reasonCodes),
    evidence: {
      source_tier: winningTier,
      label_text: winner?.label_verbatim ?? null,
      snippet: winner?.snippet ?? null,
      bbox: winner?.bbox ?? null,
    },
    integrity: {
      checksum_validated: winningTierResult?.checksum_validated ?? null,
      checksum_detail: winningTierResult?.checksum_detail ?? null,
      cross_source_agreement: crossSourceDetail,
      anomalies,
    },
    all_dates_found: buildInventory(outcome.survivors, outcome.eliminated, winner),
    quality: page.quality,
    timing_ms: {
      total: totalMs,
      normalize: normalizeMs,
      tier: Date.now() - tierStarted,
      gate: gateMs,
    },
    cost_usd: Number(costUsd.toFixed(6)),
    admission,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withinBudget(started: number, budgetMs: number, need: number): boolean {
  return Date.now() - started + need < budgetMs;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Runs a synchronous tier without letting an unexpected throw take down the request. */
function safely(fn: () => TierResult): TierResult | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** zxing-wasm wants a plain view; Buffer's ArrayBufferLike does not satisfy it directly. */
function toUint8(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
}

function gateInputFor(page: NormalizedPage, ocr?: OcrRunner): GateInput {
  return {
    fullResolution: page.fullResolution,
    fullWidth: page.fullWidth,
    fullHeight: page.fullHeight,
    downscaled: page.downscaled,
    quad: page.quad,
    perspectiveCorrected: page.perspectiveCorrected,
    exifBytesLength: page.exifBytesLength,
    textLayer: page.textLayer,
    ocr,
  };
}

/**
 * Recovers the MRZ layout from the tier's own detail string. TA-MRZ records which of
 * TD1/TD2/TD3 it matched there rather than on a dedicated field, and the layout is the
 * signal that distinguishes a passport (TD3) from a residence permit or card ID (TD1).
 */
function mrzFormatOf(result: TierResult | null): 'TD1' | 'TD2' | 'TD3' | null {
  const detail = result?.checksum_detail ?? '';
  for (const format of ['TD1', 'TD2', 'TD3'] as const) {
    if (detail.includes(format)) return format;
  }
  return null;
}

/** Pulls the three dates the cross-check compares out of a tier's candidate list. */
function dateTripleOf(result: TierResult): DateTriple {
  const byRole = (role: string) => result.candidates.find((c) => c.role === role)?.iso ?? null;
  return { expiry: byRole('EXPIRY'), issue: byRole('ISSUE'), dob: byRole('DATE_OF_BIRTH') };
}

/**
 * US-issued documents read MM/DD; everything else genuinely identified reads DD/MM, which
 * is the convention nearly every other passport- and ID-issuing country uses.
 *
 * The type signature always promised `'DMY'` as a possible result, but no code path here
 * ever produced it — every non-US issuer fell through to `null` ("unresolved"), identical
 * to a genuinely unknown one. Found on a real Indian passport where TC correctly read all
 * five dates and their roles; every single one was then discarded as `AMBIGUOUS_DATE_FORMAT`
 * because this function could not tell "identified as India" apart from "issuer unknown".
 * A short, structured issuer string (a classified document's own issuer field) naming a
 * non-US place now resolves to DMY. A long blob (e.g. a whole page's text layer, passed at
 * the TB call site below) is not a clean issuer signal, so it still falls through to null
 * rather than guessing a convention from incidental words in unrelated body text.
 */
function inferIssuerConvention(issuer: string | null): 'US' | 'DMY' | null {
  if (!issuer) return null;
  const upper = issuer.toUpperCase();
  if (upper === 'USA' || /^[A-Z]{2}$/.test(issuer) || /\bUNITED STATES\b/.test(upper)) return 'US';
  if (upper.length <= 60 && /[A-Z]/.test(upper)) return 'DMY';
  return null;
}

function collectCandidates(results: TierResult[]): DateCandidate[] {
  const out: DateCandidate[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const c of result.candidates) {
      // Two tiers reading the same date is corroboration, not a duplicate candidate.
      const key = `${c.iso ?? c.raw}|${c.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(makeCandidate(c));
    }
  }
  return out;
}

function sourceTierOf(winner: DateCandidate | null, results: TierResult[]): SourceTier {
  if (!winner) {
    const firstNonAbstained = results.find((r) => !r.abstained);
    return firstNonAbstained?.tier ?? 'NONE';
  }
  for (const result of results) {
    if (result.candidates.some((c) => c.iso === winner.iso && c.role === winner.role)) {
      return result.tier;
    }
  }
  return 'NONE';
}

function extractCrossCallValues(
  tc: TierResult | null,
): { hunter: string[]; mapper: string[] } | undefined {
  if (!tc) return undefined;
  // TC records which call produced each candidate in its snippet metadata; when the tier
  // did not run there is nothing to compare and the signal stays null rather than false.
  const hunter = tc.candidates.filter((c) => c.snippet?.includes('hunter')).map((c) => c.raw);
  const mapper = tc.candidates.filter((c) => c.snippet?.includes('mapper')).map((c) => c.raw);
  if (hunter.length === 0 && mapper.length === 0) return undefined;
  return { hunter, mapper };
}

function hunterMapperAgreed(
  winner: DateCandidate | null,
  raw: { hunter: string[]; mapper: string[] },
): boolean | null {
  if (!winner) return null;
  const norm = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const target = norm(winner.raw);
  const inHunter = raw.hunter.some((v) => norm(v) === target);
  const inMapper = raw.mapper.some((v) => norm(v) === target);
  if (inHunter && inMapper) return true;
  if (inHunter && !inMapper) return false; // the fabrication signature
  return null;
}

function isWinnerGrounded(
  winner: DateCandidate,
  outcome: ReturnType<typeof runConstraintEngine>,
): boolean {
  const found = outcome.survivors.find((c) => c === winner);
  return !found?.signals.some((s) => s.includes('NOT grounded'));
}

/**
 * The full date inventory, always returned. This is the demo's proof of work, and the
 * eliminated entries are what the UI's "why?" panel renders.
 */
function buildInventory(
  survivors: DateCandidate[],
  eliminated: DateCandidate[],
  winner: DateCandidate | null,
): FoundDate[] {
  const toFound = (c: DateCandidate): FoundDate => ({
    raw: c.raw,
    iso: c.iso,
    label_verbatim: c.label_verbatim,
    inferred_role: c.role,
    confidence: c.confidence,
    bbox: c.bbox,
    eliminated_by: c.eliminatedBy ?? null,
  });
  // Winner first, then remaining survivors, then eliminated candidates with their reasons.
  const ordered = [
    ...(winner ? [winner] : []),
    ...survivors.filter((c) => c !== winner),
    ...eliminated,
  ];
  return ordered.map(toFound);
}

function rejectionResponse(
  requestId: string,
  outcome: NormalizeOutcome,
  today: Date,
  totalMs: number,
): ExtractionResponse {
  const tier = rejectionToTierResult(outcome as never);
  return {
    request_id: requestId,
    document: {
      class: 'NOT_A_DOCUMENT',
      class_confidence: 0,
      issuer: null,
      pages: 0,
      side: 'N/A',
    },
    validity: {
      basis: 'UNDETERMINED',
      date: null,
      date_raw: null,
      rule_applied: 'Input was rejected before any validity rule could be applied',
      verdict: 'INDETERMINATE',
      days_remaining: null,
      evaluated_at: today.toISOString(),
      timezone_policy: TIMEZONE_POLICY,
    },
    decision: 'REVIEW' satisfies Decision,
    confidence: 0,
    reason_codes: tier.reason_codes.length > 0 ? tier.reason_codes : ['CLASS_UNRECOGNIZED'],
    evidence: {
      source_tier: 'NONE',
      label_text: null,
      snippet: null,
      bbox: null,
    },
    integrity: {
      checksum_validated: null,
      checksum_detail: null,
      cross_source_agreement: null,
      anomalies: [],
    },
    all_dates_found: [],
    quality: emptyQuality(),
    timing_ms: { total: totalMs, normalize: totalMs, tier: 0 },
    cost_usd: 0,
  };
}

/**
 * Terminal response for a gate REJECT — deliberately NOT built on top of
 * `rejectionResponse()` above, even though the shapes look similar. That one serves
 * T0-level "the bytes are unreadable" failures and correctly stays `REVIEW`: a broken
 * upload deserves a human's attention. A confidently out-of-domain image is a different
 * fact — the gate is SURE this was never a candidate — and must be `REJECTED` instead,
 * so it never occupies a review queue slot.
 */
function gateRejectedResponse(
  requestId: string,
  admission: AdmissionInfo,
  page: NormalizedPage,
  today: Date,
  totalMs: number,
  normalizeMs: number,
  gateMs: number,
): ExtractionResponse {
  return {
    request_id: requestId,
    document: { class: 'NOT_A_DOCUMENT', class_confidence: 0, issuer: null, pages: 1, side: 'N/A' },
    validity: {
      basis: 'UNDETERMINED',
      date: null,
      date_raw: null,
      rule_applied: 'Rejected at the admission gate before any extraction tier ran',
      verdict: 'NOT_APPLICABLE',
      days_remaining: null,
      evaluated_at: today.toISOString(),
      timezone_policy: TIMEZONE_POLICY,
    },
    decision: 'REJECTED',
    // The gate's own certainty in a confident-negative finding, not a fused score — no
    // tier ran, so there is nothing to fuse.
    confidence: 0.9,
    reason_codes: dedupe(['OUT_OF_DOMAIN', ...gateReasonCodes(admission)]),
    evidence: { source_tier: 'NONE', label_text: null, snippet: null, bbox: null },
    integrity: { checksum_validated: null, checksum_detail: null, cross_source_agreement: null, anomalies: [] },
    all_dates_found: [],
    // T0 DID run successfully here, unlike rejectionResponse()'s path — real metrics
    // exist, so report them rather than an empty stand-in.
    quality: page.quality,
    timing_ms: { total: totalMs, normalize: normalizeMs, tier: 0, gate: gateMs },
    cost_usd: 0,
    admission,
  };
}

function gateReasonCodes(admission: AdmissionInfo): ReasonCode[] {
  const codes: ReasonCode[] = [];
  for (const signal of admission.signals) {
    if (signal.outcome !== 'CONFIDENT_NEGATIVE') continue;
    if (signal.signal === 'DOCUMENT_LIKENESS') codes.push('NOT_A_DOCUMENT_IMAGE');
    if (signal.signal === 'SCREEN_CAPTURE') codes.push('SCREEN_CAPTURE_NOT_DOCUMENT');
  }
  return codes;
}

function emptyQuality(): QualityMetrics {
  return {
    laplacian_variance: null,
    mean_luminance: null,
    clipping_ratio: null,
    skew_angle_deg: null,
    effective_dpi: null,
  };
}
