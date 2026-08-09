/**
 * Confidence fusion and routing (§9). Pure functions, no I/O.
 *
 * With no human in the loop, the hard problem is not extraction accuracy but knowing
 * when the extraction is wrong. A system that is 95% accurate with no abstention path
 * is unusable in KYC; one that is 90% accurate with a calibrated review route is
 * shippable. This module is that route.
 *
 * The weighting follows the empirical finding in arXiv:2606.24420 ("ExtractConf"):
 * extraction errors are DOCUMENT-caused, not model-caused. A frontier model transcribing
 * OCR noise produces high log-probabilities for a wrong answer, because log-probs measure
 * a consequence while document quality measures the cause. In their ablation,
 * OCR-grounding features alone (0.896 AUC) beat log-prob features alone (0.880); the
 * fused multi-signal classifier reached 0.928 against 0.705 for mean token log-prob.
 *
 * So: source authority dominates, grounding and cross-call agreement are high, and model
 * internals are weighted lowest. We do NOT lean on log-probs.
 *
 * These weights are HAND-TUNED. A trained fusion (CatBoost in the paper) is the
 * productionization path and is named as such in the README — you cannot train it in a
 * weekend, and saying so is worth as much as building it.
 */

import {
  AUTO_THRESHOLD,
  type Decision,
  DETERMINISTIC_CONFIDENCE,
  type IntegrityAnomaly,
  type QualityMetrics,
  type ReasonCode,
  REVIEW_FLOOR,
  type SourceTier,
  type Verdict,
} from '@/types/contract';

export interface ConfidenceInput {
  tier: SourceTier;
  /** True when MRZ check digits or barcode ECC validated cleanly. */
  checksumValidated: boolean | null;
  /** True when a machine-readable value agreed with the printed value. */
  crossSourceAgreement: boolean | null;
  /** True when Hunter and Mapper independently reported the winning value. */
  crossCallAgreement: boolean | null;
  /** True when the value appears verbatim in the raw OCR token stream. */
  ocrGrounded: boolean | null;
  quality: QualityMetrics;
  /** Number of hard constraints evaluated, and how many candidates survived them. */
  hardConstraintsChecked: number;
  survivingCandidates: number;
  /** The winning candidate's accumulated soft-signal score. */
  softScore: number;
  anomalies: IntegrityAnomaly[];
}

/** Blur below this Laplacian variance is unusable for reliable field reading. */
const BLUR_FLOOR = 60;
/** Below this effective DPI, PDF417 will not decode and OCR degrades badly. */
const DPI_FLOOR = 150;

export interface ConfidenceResult {
  confidence: number;
  /** Per-group contributions, surfaced in the decision trace so the score is auditable. */
  breakdown: Record<string, number>;
  reasonCodes: ReasonCode[];
}

export function fuseConfidence(input: ConfidenceInput): ConfidenceResult {
  const breakdown: Record<string, number> = {};
  const reasonCodes: ReasonCode[] = [];

  // --- Source authority (dominant) ---------------------------------------
  // A clean deterministic decode is self-validating: PDF417 carries Reed-Solomon ECC,
  // and MRZ carries check digits that we recompute. Nothing else comes close.
  let base: number;
  switch (input.tier) {
    case 'TA_MRZ':
    case 'TA_PDF417':
      base = input.checksumValidated ? DETERMINISTIC_CONFIDENCE : 0.45;
      break;
    case 'TB_OCR':
      base = 0.72;
      break;
    case 'TC_VLM':
      base = 0.55;
      break;
    default:
      base = 0.2;
  }
  breakdown.source_authority = base;
  let score = base;

  // --- Cross-source agreement (high) -------------------------------------
  // Machine-readable vs printed. Agreement raises confidence; disagreement is handled
  // as an anomaly below, not as a tie to break.
  if (input.crossSourceAgreement === true) {
    breakdown.cross_source_agreement = 0.06;
    score += 0.06;
  }

  // --- Cross-call agreement (high) ---------------------------------------
  // Hunter and Mapper fail differently, so their agreement carries real information.
  // Hunter returning a value while Mapper returns nothing is the fabrication signature.
  if (input.crossCallAgreement === true) {
    breakdown.cross_call_agreement = 0.12;
    score += 0.12;
  } else if (input.crossCallAgreement === false) {
    breakdown.cross_call_agreement = -0.18;
    score -= 0.18;
    reasonCodes.push('HUNTER_MAPPER_DISAGREE');
  }

  // --- OCR grounding (high) ----------------------------------------------
  // Measures the cause rather than the consequence. An injected date will not appear in
  // the raw token stream, so this is also the prompt-injection defence (§11.5 #66).
  if (input.ocrGrounded === true) {
    breakdown.ocr_grounding = 0.1;
    score += 0.1;
  } else if (input.ocrGrounded === false) {
    breakdown.ocr_grounding = -0.25;
    score -= 0.25;
    reasonCodes.push('VALUE_NOT_GROUNDED_IN_OCR');
  }

  // --- Document quality (medium) -----------------------------------------
  // The cause of most extraction errors. Penalise rather than reject: a degraded scan
  // that still decodes cleanly at TA deserves its high confidence.
  let qualityPenalty = 0;
  const { laplacian_variance: blur, effective_dpi: dpi, clipping_ratio: clip } = input.quality;

  if (blur !== null && blur < BLUR_FLOOR) {
    qualityPenalty += 0.15;
    reasonCodes.push('IMAGE_TOO_BLURRY');
  }
  if (dpi !== null && dpi < DPI_FLOOR) {
    qualityPenalty += 0.1;
    reasonCodes.push('RESOLUTION_TOO_LOW');
  }
  if (clip !== null && clip > 0.12) {
    qualityPenalty += 0.1;
    reasonCodes.push('GLARE_OBSCURES_FIELD');
  }
  if (qualityPenalty > 0) {
    // Deterministic tiers already proved they read the bytes correctly, so quality
    // matters far less to them than to the OCR and VLM paths.
    const scaled = isDeterministic(input.tier) ? qualityPenalty * 0.25 : qualityPenalty;
    breakdown.document_quality = -scaled;
    score -= scaled;
  }

  // --- Constraint satisfaction (medium) ----------------------------------
  if (input.hardConstraintsChecked > 0) {
    const bonus = Math.min(0.08, input.hardConstraintsChecked * 0.02);
    breakdown.constraint_satisfaction = bonus;
    score += bonus;
  }
  if (input.survivingCandidates > 1) {
    // More than one plausible answer is itself a reason to be less sure.
    const penalty = Math.min(0.15, (input.survivingCandidates - 1) * 0.07);
    breakdown.candidate_ambiguity = -penalty;
    score -= penalty;
  }
  if (input.survivingCandidates === 0) {
    breakdown.candidate_ambiguity = -0.4;
    score -= 0.4;
  }

  // --- Soft signals from the constraint engine ---------------------------
  const softContribution = Math.max(-0.2, Math.min(0.15, input.softScore * 0.2));
  breakdown.soft_signals = softContribution;
  score += softContribution;

  return { confidence: clamp01(score), breakdown, reasonCodes };
}

function isDeterministic(tier: SourceTier): boolean {
  return tier === 'TA_MRZ' || tier === 'TA_PDF417';
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(4))));
}

// ---------------------------------------------------------------------------
// Routing (§9)
// ---------------------------------------------------------------------------

export interface RoutingInput {
  confidence: number;
  verdict: Verdict;
  anomalies: IntegrityAnomaly[];
  /** True when a hard constraint was violated anywhere in the document. */
  hardConstraintFailed: boolean;
  reasonCodes: ReasonCode[];
}

export interface RoutingResult {
  decision: Decision;
  reasonCodes: ReasonCode[];
}

/**
 * Route to AUTO_PASS, AUTO_FAIL, or REVIEW.
 *
 * The invariant that makes this KYC-safe: every REVIEW carries at least one machine-
 * readable reason code. A review queue that receives documents with no stated reason
 * cannot be triaged, and a reviewer cannot audit a decision they cannot see the basis of.
 */
export function route(input: RoutingInput): RoutingResult {
  const reasonCodes = [...new Set(input.reasonCodes)];

  // Any integrity anomaly forces REVIEW regardless of confidence. A checksum mismatch
  // or an MRZ/VIZ disagreement is a tamper signal — high confidence in a tampered
  // reading is exactly the wrong reason to auto-clear.
  if (input.anomalies.length > 0) {
    for (const anomaly of input.anomalies) {
      if (!reasonCodes.includes(anomaly)) reasonCodes.push(anomaly);
    }
    return { decision: 'REVIEW', reasonCodes };
  }

  if (input.verdict === 'INDETERMINATE') {
    if (reasonCodes.length === 0) reasonCodes.push('LOW_TIER_CONFIDENCE');
    return { decision: 'REVIEW', reasonCodes };
  }

  // NOT_APPLICABLE is a confident, correct answer for a NO_EXPIRY class — the employment
  // letter abstention case. It is not a failure and must not be routed to a human.
  if (input.verdict === 'NOT_APPLICABLE' && input.confidence >= REVIEW_FLOOR) {
    return { decision: 'AUTO_PASS', reasonCodes };
  }

  if (input.confidence >= AUTO_THRESHOLD && !input.hardConstraintFailed) {
    return {
      decision: input.verdict === 'EXPIRED' ? 'AUTO_FAIL' : 'AUTO_PASS',
      reasonCodes,
    };
  }

  if (reasonCodes.length === 0) reasonCodes.push('LOW_TIER_CONFIDENCE');
  return { decision: 'REVIEW', reasonCodes };
}

// ---------------------------------------------------------------------------
// Accuracy at coverage — the headline metric (§9, §12)
// ---------------------------------------------------------------------------

export interface CoveragePoint {
  threshold: number;
  coverage: number;
  accuracy: number;
  /** Confident AND wrong. The only truly bad outcome in a no-human-in-the-loop system. */
  confidentlyWrong: number;
}

/**
 * Sweep the confidence threshold to produce the accuracy-at-coverage curve.
 *
 * This is what the README's headline number comes from: "N% of documents clear with zero
 * human touch, at X% accuracy on those." Raw accuracy alone is not reportable for a
 * system with an abstention path — it hides whether the abstentions were the right ones.
 * The curve is also how the routing thresholds get justified rather than picked as round
 * numbers (§9 [DECIDE]).
 */
export function accuracyAtCoverage(
  results: Array<{ confidence: number; correct: boolean }>,
  thresholds: number[] = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99],
): CoveragePoint[] {
  const total = results.length;
  if (total === 0) return [];

  return thresholds.map((threshold) => {
    const covered = results.filter((r) => r.confidence >= threshold);
    const correct = covered.filter((r) => r.correct).length;
    return {
      threshold,
      coverage: covered.length / total,
      accuracy: covered.length === 0 ? 1 : correct / covered.length,
      confidentlyWrong: covered.length - correct,
    };
  });
}

/**
 * Find the highest threshold that still clears `targetCoverage` of the corpus. Used to
 * report "accuracy at 80% coverage", the number that maps to the interviewer's cost model.
 */
export function pointAtCoverage(
  curve: CoveragePoint[],
  targetCoverage = 0.8,
): CoveragePoint | null {
  const eligible = curve.filter((p) => p.coverage >= targetCoverage);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, p) => (p.threshold > best.threshold ? p : best));
}
