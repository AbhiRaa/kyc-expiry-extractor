import { describe, expect, it } from 'vitest';
import { looksTooLowResolution, MIN_FILE_BYTES } from './resolution';

describe('looksTooLowResolution', () => {
  it('flags the exact case that prompted this: a 250x178 thumbnail under 50KB', () => {
    // British_passport_biographical_data.jpg — 250x178px, 16402 bytes. This is what
    // reaches T0-C server-side and returns RESOLUTION_TOO_LOW before any tier runs;
    // the client-side upload note should say so before the round trip, not after.
    expect(looksTooLowResolution(250, 178, 16402)).toBe(true);
  });

  it('does not flag a normal camera-resolution photo', () => {
    expect(looksTooLowResolution(2000, 1266, 900_000)).toBe(false);
  });

  it('requires both signals — low DPI alone, above the byte floor, is not flagged', () => {
    // Same 300x189 shape as the low-DPI case below, but padded past MIN_FILE_BYTES —
    // the byte trigger never fires, so DPI is never even checked (mirrors T0-C exactly).
    expect(looksTooLowResolution(300, 189, MIN_FILE_BYTES + 1)).toBe(false);
  });

  it('requires both signals — small bytes alone, at adequate DPI, is not flagged', () => {
    // A well-compressed but still sharp image can legitimately be small.
    expect(looksTooLowResolution(1200, 760, MIN_FILE_BYTES - 1)).toBe(false);
  });
});
