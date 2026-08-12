import { describe, expect, it } from 'vitest';
import type { ReasonCode } from '@/types/contract';
import { isUnexplainedOcrConfidenceCollapse } from './router';

/**
 * router.ts otherwise has no unit tests of its own — `runPipeline` is verified through the
 * eval harness against real generated documents (docs/DECISIONS.md §9's "Verification
 * note"), not mocked here. `isUnexplainedOcrConfidenceCollapse` is the one exception: it's a
 * small, pure judgment call (docs/DECISIONS.md §11) worth pinning directly, without needing
 * a real OCR pass or document image.
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
