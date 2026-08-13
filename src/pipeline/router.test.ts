import { describe, expect, it } from 'vitest';
import type { ReasonCode } from '@/types/contract';
import { isNormalized, normalizeDocument, type NormalizeRejection } from './normalize';
import { isTerminalT0Rejection, isUnexplainedOcrConfidenceCollapse, runPipeline } from './router';

/**
 * router.ts's `runPipeline` is mostly verified through the eval harness against real
 * generated documents (docs/DECISIONS.md §9's "Verification note"), not mocked here.
 * `isUnexplainedOcrConfidenceCollapse` and `isTerminalT0Rejection` are pure judgment calls
 * (docs/DECISIONS.md §11 and its "T0 asymmetry rule extension" entry) worth pinning
 * directly. The T0-rejection describe block below is the one place this file calls
 * `runPipeline` itself — real, ungenerated-mock
 * fixtures (same "no mocking" rule normalize.test.ts follows), because the REJECTED-vs-
 * REVIEW split and the CRM-payload presence/absence it controls are safety-relevant enough
 * to verify directly rather than wait for the eval corpus to happen to exercise them — none
 * of the 35 corpus documents are an empty file or an unsupported type.
 */
describe('isUnexplainedOcrConfidenceCollapse', () => {
  it('flags a low-confidence OCR pass with no other quality explanation', () => {
    expect(isUnexplainedOcrConfidenceCollapse(28.6, [])).toBe(true);
  });

  it('does not flag when confidence is null (OCR never ran / found nothing at all)', () => {
    expect(isUnexplainedOcrConfidenceCollapse(null, [])).toBe(false);
  });

  it('does not flag confidence at or above the floor', () => {
    expect(isUnexplainedOcrConfidenceCollapse(40, [])).toBe(false);
    expect(isUnexplainedOcrConfidenceCollapse(85, [])).toBe(false);
  });

  it('does not flag when a known quality code already explains the collapse', () => {
    const explained: ReasonCode[] = ['IMAGE_TOO_BLURRY'];
    expect(isUnexplainedOcrConfidenceCollapse(20, explained)).toBe(false);
  });

  it('is not fooled by an unrelated reason code that does not explain OCR quality', () => {
    // NO_DATES_FOUND is an extraction outcome, not an input-quality finding — it must not
    // suppress the anomaly the way IMAGE_TOO_BLURRY etc. correctly do.
    const unrelated: ReasonCode[] = ['NO_DATES_FOUND'];
    expect(isUnexplainedOcrConfidenceCollapse(20, unrelated)).toBe(true);
  });
});

describe('isTerminalT0Rejection ("T0 asymmetry rule extension", docs/DECISIONS.md)', () => {
  const kinds: NormalizeRejection['kind'][] = [
    'EMPTY_FILE',
    'UNSUPPORTED_TYPE',
    'CORRUPT_FILE',
    'ENCRYPTED_PDF',
    'RESOLUTION_TOO_LOW',
    'RENDER_FAILED',
  ];
  const rejection = (kind: NormalizeRejection['kind']): NormalizeRejection => ({
    ok: false,
    kind,
    reasonCodes: [],
    message: 'test fixture',
    detectedMime: null,
    declaredMime: null,
    declaredName: null,
    contentHash: 'test',
    durationMs: 0,
  });

  it('is terminal only for the two impossibilities, not the technical failures', () => {
    const terminal = kinds.filter((kind) => isTerminalT0Rejection(rejection(kind)));
    expect(terminal.sort()).toEqual(['EMPTY_FILE', 'UNSUPPORTED_TYPE']);
  });
});

describe('T0 rejection routing: REJECTED vs REVIEW ("T0 asymmetry rule extension", docs/DECISIONS.md)', () => {
  it('a zero-byte file is REJECTED with no CRM payload — an empty upload is not a candidate document', async () => {
    const outcome = await normalizeDocument(new Uint8Array(0));
    expect(isNormalized(outcome)).toBe(false);
    const response = await runPipeline({ outcome });
    expect(response.decision).toBe('REJECTED');
    expect(response.crm_payload).toBeUndefined();
    expect(response.admission).toBeUndefined();
    expect(response.cost_usd).toBe(0);
    expect(response.reason_codes).toContain('CLASS_UNRECOGNIZED');
  });

  it('a file with no recognizable magic bytes is REJECTED with no CRM payload', async () => {
    // Same fixture normalize.test.ts uses for its own UNSUPPORTED_TYPE coverage — plain
    // text has no magic signature at all.
    const text = Buffer.from('EXPIRY DATE: 2030-04-23\n'.repeat(400), 'utf8');
    const outcome = await normalizeDocument(text, { declaredName: 'notes.txt' });
    expect(isNormalized(outcome)).toBe(false);
    const response = await runPipeline({ outcome });
    expect(response.decision).toBe('REJECTED');
    expect(response.crm_payload).toBeUndefined();
    expect(response.reason_codes).toContain('UNSUPPORTED_TYPE');
  });

  it('a file that sniffs as a real type but fails to decode stays REVIEW, with a CRM payload — it could be a genuine document with a technical problem', async () => {
    // Same fixture normalize.test.ts uses for CORRUPT_FILE — a valid JFIF header
    // followed by garbage, the shape of a truncated upload.
    const corrupt = Buffer.concat([
      Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'),
      Buffer.alloc(4096, 0x41),
    ]);
    const outcome = await normalizeDocument(corrupt);
    expect(isNormalized(outcome)).toBe(false);
    const response = await runPipeline({ outcome });
    expect(response.decision).toBe('REVIEW');
    expect(response.crm_payload).toBeDefined();
    expect(response.reason_codes).toContain('CORRUPT_FILE');
  });
});
