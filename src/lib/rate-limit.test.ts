import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit, getClientIp } from './rate-limit';

// Each test uses its own unique key — the bucket map is module-level state, shared across
// tests in this file, so reusing a key would leak window state between cases.
let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `test-key-${keyCounter}`;
}

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first request in a fresh window', () => {
    expect(checkRateLimit(freshKey(), 3, 1000)).toEqual({ allowed: true, retryAfterSeconds: null });
  });

  it('allows up to the limit, then blocks the next one', () => {
    const key = freshKey();
    expect(checkRateLimit(key, 2, 1000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 1000).allowed).toBe(true);
    const third = checkRateLimit(key, 2, 1000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets once the window elapses', () => {
    const key = freshKey();
    checkRateLimit(key, 1, 1000);
    expect(checkRateLimit(key, 1, 1000).allowed).toBe(false);

    vi.setSystemTime(1001);
    expect(checkRateLimit(key, 1, 1000).allowed).toBe(true);
  });

  it('tracks separate keys independently', () => {
    const a = freshKey();
    const b = freshKey();
    checkRateLimit(a, 1, 1000);
    expect(checkRateLimit(a, 1, 1000).allowed).toBe(false);
    // b has never been touched — must not inherit a's exhausted bucket.
    expect(checkRateLimit(b, 1, 1000).allowed).toBe(true);
  });

  it('retryAfterSeconds counts down toward the window boundary, not a fixed value', () => {
    const key = freshKey();
    checkRateLimit(key, 1, 10_000);
    vi.setSystemTime(7000);
    const blocked = checkRateLimit(key, 1, 10_000);
    expect(blocked.retryAfterSeconds).toBe(3);
  });
});

describe('getClientIp', () => {
  it('reads the first address from x-forwarded-for', () => {
    const request = new Request('https://example.test', {
      headers: { 'x-forwarded-for': '203.0.113.5, 70.41.3.18' },
    });
    expect(getClientIp(request)).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const request = new Request('https://example.test', {
      headers: { 'x-real-ip': '203.0.113.9' },
    });
    expect(getClientIp(request)).toBe('203.0.113.9');
  });

  it('falls back to a fixed key when neither header is present', () => {
    const request = new Request('https://example.test');
    expect(getClientIp(request)).toBe('unknown');
  });
});
