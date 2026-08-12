/**
 * CRM emission tests (docs/DECISIONS.md §9).
 *
 * `buildCrmPayload` is pure — every case here is a direct input/output check, no mocking.
 * `deliverCrmPayload` is the one impure function in crm.ts; its `fetch` is stubbed so these
 * tests run in milliseconds rather than actually waiting out CRM_WEBHOOK_TIMEOUT_MS.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionResponse } from '@/types/contract';
import { buildCrmPayload, CRM_PROPERTY_KEYS, deliverCrmPayload } from './crm';

const baseResponse: ExtractionResponse = {
  request_id: 'req-123',
  document: { class: 'US_DRIVERS_LICENSE', class_confidence: 0.98, issuer: 'CA', pages: 1, side: 'FRONT' },
  validity: {
    basis: 'EXPIRY_DATE',
    date: '2029-11-14',
    date_raw: '11/14/2029',
    rule_applied: 'Must be unexpired at submission',
    verdict: 'VALID',
    days_remaining: 1200,
    evaluated_at: '2026-08-09T00:00:00.000Z',
    timezone_policy: 'UTC',
  },
  decision: 'AUTO_PASS',
  confidence: 1,
  reason_codes: [],
  evidence: { source_tier: 'TB_OCR', label_text: 'EXP', snippet: '11/14/2029', bbox: null },
  integrity: { checksum_validated: null, checksum_detail: null, cross_source_agreement: null, anomalies: [] },
  all_dates_found: [],
  quality: {
    laplacian_variance: null,
    mean_luminance: null,
    clipping_ratio: null,
    skew_angle_deg: null,
    effective_dpi: null,
  },
  timing_ms: { total: 100, normalize: 10, tier: 90 },
  cost_usd: 0,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('buildCrmPayload', () => {
  it('maps every response field to its CRM_PROPERTY_KEYS name', () => {
    const payload = buildCrmPayload(baseResponse, 'abc123');
    expect(payload.properties[CRM_PROPERTY_KEYS.requestId]).toBe('req-123');
    expect(payload.properties[CRM_PROPERTY_KEYS.decision]).toBe('AUTO_PASS');
    expect(payload.properties[CRM_PROPERTY_KEYS.confidence]).toBe(1);
    expect(payload.properties[CRM_PROPERTY_KEYS.documentClass]).toBe('US_DRIVERS_LICENSE');
    expect(payload.properties[CRM_PROPERTY_KEYS.documentIssuer]).toBe('CA');
    expect(payload.properties[CRM_PROPERTY_KEYS.validityBasis]).toBe('EXPIRY_DATE');
    expect(payload.properties[CRM_PROPERTY_KEYS.expiryDate]).toBe('2029-11-14');
    expect(payload.properties[CRM_PROPERTY_KEYS.verdict]).toBe('VALID');
    expect(payload.properties[CRM_PROPERTY_KEYS.daysRemaining]).toBe(1200);
    expect(payload.properties[CRM_PROPERTY_KEYS.sourceTier]).toBe('TB_OCR');
    expect(payload.properties[CRM_PROPERTY_KEYS.costUsd]).toBe(0);
    expect(payload.properties[CRM_PROPERTY_KEYS.evaluatedAt]).toBe('2026-08-09T00:00:00.000Z');
  });

  it('joins reason codes with a semicolon, HubSpot\'s own multi-value property convention', () => {
    const withReasons: ExtractionResponse = {
      ...baseResponse,
      reason_codes: ['GLARE_OBSCURES_FIELD', 'EXTREME_SKEW'],
    };
    const payload = buildCrmPayload(withReasons, 'abc123');
    expect(payload.properties[CRM_PROPERTY_KEYS.reasonCodes]).toBe('GLARE_OBSCURES_FIELD;EXTREME_SKEW');
  });

  it('derives idempotencyKey from the content hash, not a fresh random value', () => {
    const first = buildCrmPayload(baseResponse, 'abc123');
    const second = buildCrmPayload(baseResponse, 'abc123');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).toBe('kyc-abc123');

    const differentDoc = buildCrmPayload(baseResponse, 'def456');
    expect(differentDoc.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('defaults objectType to kyc_check and leaves associations empty with no applicantRef', () => {
    const payload = buildCrmPayload(baseResponse, 'abc123');
    expect(payload.objectType).toBe('kyc_check');
    expect(payload.associations).toEqual([]);
  });

  it('adds one association when applicantRef is supplied, using default naming', () => {
    const payload = buildCrmPayload(baseResponse, 'abc123', 'contact-789');
    expect(payload.associations).toEqual([
      { toObjectType: 'contact', toObjectId: 'contact-789', associationType: 'kyc_check_to_contact' },
    ]);
  });

  it('respects CRM_OBJECT_TYPE / CRM_ASSOCIATION_OBJECT_TYPE / CRM_ASSOCIATION_TYPE overrides', () => {
    vi.stubEnv('CRM_OBJECT_TYPE', 'kyc_verification');
    vi.stubEnv('CRM_ASSOCIATION_OBJECT_TYPE', 'deal');
    vi.stubEnv('CRM_ASSOCIATION_TYPE', 'verification_to_deal');

    const payload = buildCrmPayload(baseResponse, 'abc123', 'deal-42');
    expect(payload.objectType).toBe('kyc_verification');
    expect(payload.associations).toEqual([
      { toObjectType: 'deal', toObjectId: 'deal-42', associationType: 'verification_to_deal' },
    ]);
  });
});

describe('deliverCrmPayload', () => {
  const payload = buildCrmPayload(baseResponse, 'abc123');

  it('returns not_configured and never calls fetch when CRM_WEBHOOK_URL is unset', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await deliverCrmPayload(payload);
    expect(result).toEqual({
      status: 'not_configured',
      reason: 'CRM_WEBHOOK_URL is not set',
      attempted_at: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns sent on a 2xx response', async () => {
    vi.stubEnv('CRM_WEBHOOK_URL', 'https://example.test/crm-webhook');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const result = await deliverCrmPayload(payload);
    expect(result.status).toBe('sent');
    expect(result.reason).toBeNull();
    expect(result.attempted_at).not.toBeNull();
  });

  it('returns failed with the status code when the CRM responds non-2xx', async () => {
    vi.stubEnv('CRM_WEBHOOK_URL', 'https://example.test/crm-webhook');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const result = await deliverCrmPayload(payload);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('CRM webhook responded 500');
  });

  it('returns failed, never throws, on a network error', async () => {
    vi.stubEnv('CRM_WEBHOOK_URL', 'https://example.test/crm-webhook');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await deliverCrmPayload(payload);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('ECONNREFUSED');
  });

  it('reports a timeout distinctly when the request is aborted', async () => {
    vi.stubEnv('CRM_WEBHOOK_URL', 'https://example.test/crm-webhook');
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const result = await deliverCrmPayload(payload);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/did not respond within/);
  });
});
