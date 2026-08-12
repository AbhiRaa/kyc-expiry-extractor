/**
 * In-memory, per-IP, fixed-window rate limiting.
 *
 * Deliberately simple and honestly limited: state lives in a module-level `Map`, so it is
 * per-instance and best-effort — it resets on a cold start and does not coordinate across
 * multiple concurrent serverless instances. This is the exact same limitation this
 * codebase's own Roadmap already accepts for the (also in-memory) per-document cost cap:
 * "currently per-instance and best-effort because serverless functions share no state"
 * (G4, README.md). A real production deployment would back this with something durable
 * (Redis/Upstash); this is proportionate for a demo, not a claim of production-grade
 * protection — and it is still real protection against casual, single-instance abuse,
 * which is the actual threat model here.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets, only when `allowed` is false. */
  retryAfterSeconds: number | null;
}

/**
 * `key` is typically an IP address, but is deliberately just a string — a caller can
 * namespace it (e.g. `` `eval-gate:${ip}` ``) so two different endpoints never share the
 * same bucket for the same client.
 */
export function checkRateLimit(key: string, maxRequests: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: null };
  }

  if (bucket.count >= maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.windowStart + windowMs - now) / 1000) };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: null };
}

/** Standard proxy header first (Vercel, and most reverse proxies, set this); a request
 *  object has no other reliable way to learn the client's address in a serverless
 *  function. Falls back to a fixed key so a local dev server (no proxy, no header) still
 *  rate-limits sanely rather than skipping the check entirely. */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}
