/**
 * CRM emission (v2 client rework) — docs/DECISIONS.md §9.
 *
 * Two functions, deliberately kept separate: `buildCrmPayload` is pure (no I/O, no env
 * read beyond naming defaults) so it can be unit-tested without a network; `deliverCrmPayload`
 * is the one function in this file allowed to do I/O, and it never throws — every outcome,
 * including "no URL configured" and "the request failed," resolves to a `CrmDeliveryInfo`
 * rather than an exception, because CRM reachability must never turn into an extraction
 * failure (router.ts already runs the deterministic and OCR tiers with no external
 * dependency at all; this preserves that same posture one layer out).
 */

import type { CrmAssociation, CrmDeliveryInfo, CrmPayload, ExtractionResponse } from '@/types/contract';

/**
 * Object/property naming, modeled on HubSpot's properties-plus-associations object shape
 * (the client's primary CRM platform) but centralized here rather than hardcoded at each
 * call site — swapping to a different CRM's field-naming convention means editing this one
 * map, the same reasoning `GATE_KEYWORDS` (gate.ts) already applies to keyword lists: one
 * source of truth instead of a promise to keep two lists in sync.
 */
export const CRM_PROPERTY_KEYS = {
  requestId: 'kyc_request_id',
  decision: 'kyc_decision',
  confidence: 'kyc_confidence',
  documentClass: 'kyc_document_class',
  documentIssuer: 'kyc_document_issuer',
  validityBasis: 'kyc_validity_basis',
  expiryDate: 'kyc_expiry_date',
  verdict: 'kyc_verdict',
  daysRemaining: 'kyc_days_remaining',
  sourceTier: 'kyc_source_tier',
  reasonCodes: 'kyc_reason_codes',
  costUsd: 'kyc_cost_usd',
  evaluatedAt: 'kyc_evaluated_at',
} as const;

const DEFAULT_OBJECT_TYPE = 'kyc_check';
const DEFAULT_ASSOCIATION_OBJECT_TYPE = 'contact';
const DEFAULT_ASSOCIATION_TYPE = 'kyc_check_to_contact';

/** Bounded so a slow or unreachable CRM can never hang the extraction response — see the
 *  "never blocks or fails the response" framing in docs/DECISIONS.md §9 C4. */
const CRM_WEBHOOK_TIMEOUT_MS = 3000;

/**
 * Maps an already-decided `ExtractionResponse` to a CRM object payload. Never reads
 * anything from the response that could carry document pixels — G1's "no document pixels
 * ever leave the server" guarantee holds here too, since every field below is a decision,
 * a date, or a code, never a crop or a snippet's raw image data.
 *
 * `contentHash` (already computed in normalize.ts for the free-repeat-upload dedup hook,
 * §11.1 #14) becomes the idempotency key, not a newly minted hash — a retried upload of
 * identical bytes must produce the same key, so the CRM dedupes rather than opening a
 * second task for one physical document.
 *
 * `applicantRef`, when the caller supplies one, becomes the payload's one association.
 * Nothing in this system tracks an applicant/contact identity today (the pipeline is
 * document-in, verdict-out), so associations is an empty array whenever it's omitted —
 * a known limitation, not a gap in the payload shape itself (docs/DECISIONS.md §9 C6).
 */
export function buildCrmPayload(
  response: ExtractionResponse,
  contentHash: string,
  applicantRef?: string,
): CrmPayload {
  const k = CRM_PROPERTY_KEYS;
  const associations: CrmAssociation[] = applicantRef
    ? [
        {
          toObjectType: process.env.CRM_ASSOCIATION_OBJECT_TYPE ?? DEFAULT_ASSOCIATION_OBJECT_TYPE,
          toObjectId: applicantRef,
          associationType: process.env.CRM_ASSOCIATION_TYPE ?? DEFAULT_ASSOCIATION_TYPE,
        },
      ]
    : [];

  return {
    objectType: process.env.CRM_OBJECT_TYPE ?? DEFAULT_OBJECT_TYPE,
    idempotencyKey: `kyc-${contentHash}`,
    properties: {
      [k.requestId]: response.request_id,
      [k.decision]: response.decision,
      [k.confidence]: response.confidence,
      [k.documentClass]: response.document.class,
      [k.documentIssuer]: response.document.issuer,
      [k.validityBasis]: response.validity.basis,
      [k.expiryDate]: response.validity.date,
      [k.verdict]: response.validity.verdict,
      [k.daysRemaining]: response.validity.days_remaining,
      [k.sourceTier]: response.evidence.source_tier,
      // HubSpot's own convention for a multi-value/checkbox property: semicolon-delimited,
      // not a JSON array — kept authentic to the target shape rather than convenient here.
      [k.reasonCodes]: response.reason_codes.join(';'),
      [k.costUsd]: response.cost_usd,
      [k.evaluatedAt]: response.validity.evaluated_at,
    },
    associations,
  };
}

/**
 * Attempts delivery and always resolves — never rejects. `not_configured` when no webhook
 * URL is set (the payload is still returned in the response body for inspection); `sent`
 * on any 2xx; `failed` with a reason otherwise, including timeout and network errors.
 */
export async function deliverCrmPayload(payload: CrmPayload): Promise<CrmDeliveryInfo> {
  const url = process.env.CRM_WEBHOOK_URL;
  if (!url) {
    return { status: 'not_configured', reason: 'CRM_WEBHOOK_URL is not set', attempted_at: null };
  }

  const attemptedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CRM_WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { status: 'failed', reason: `CRM webhook responded ${res.status}`, attempted_at: attemptedAt };
    }
    return { status: 'sent', reason: null, attempted_at: attemptedAt };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `CRM webhook did not respond within ${CRM_WEBHOOK_TIMEOUT_MS}ms`
          : error.message
        : 'unknown error';
    return { status: 'failed', reason, attempted_at: attemptedAt };
  } finally {
    clearTimeout(timeout);
  }
}
