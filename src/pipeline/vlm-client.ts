/**
 * A deliberately thin, injectable wrapper around the Anthropic Messages API (§7 TC).
 *
 * Why this file exists separately from `tier-c-vlm.ts`: the interesting logic in TC is the
 * Hunter/Mapper merge and the degradation ladder (§11.6 #71–78), and none of that should
 * need a network, an API key, or a billing account to test. So the transport is reduced to
 * one method — `complete(req) -> VlmResponse` — behind an interface. `tier-c-vlm.ts` takes
 * a `VlmClient` as a parameter, and every test in this repo runs against a fake.
 *
 * The wrapper is deliberately *not* smart. It does not parse JSON, does not retry, and does
 * not decide what a failure means. It does exactly four things the tier should not have to
 * know about:
 *
 *   1. builds the request in the shape the current API actually accepts,
 *   2. checks `stop_reason` BEFORE touching `content` (this model can return
 *      `stop_reason: 'refusal'` with an empty content array — indexing `content[0]`
 *      unconditionally is a crash, not an error path),
 *   3. computes a real dollar cost from `usage`, because the eval harness reports actual
 *      per-document cost and an estimate would make that table a lie,
 *   4. translates SDK exceptions into a small, transport-agnostic `VlmError` taxonomy so
 *      the tier's retry/degrade logic can be written — and tested — without importing the
 *      SDK at all.
 *
 * G3 — the brief's §7 "Call settings" says `temperature: 0`. That is written against a
 * stale API: `temperature`, `top_p` and `top_k` are REJECTED WITH A 400 on this model, so
 * sending them would fail every request. Determinism comes from two other places instead:
 * the enforced `output_config.format` JSON schema (the shape cannot vary) and
 * `output_config.effort: 'low'` (minimal reasoning depth, minimal room to wander). This is
 * recorded as gap G3 in the README decision log.
 */

import Anthropic, {
  APIConnectionTimeoutError,
  APIConnectionError,
  APIError,
  APIUserAbortError,
  RateLimitError,
} from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Call settings (§7)
// ---------------------------------------------------------------------------

/** Exact model id — no date suffix. */
export const VLM_MODEL = 'claude-opus-5';

/**
 * Both schemas are small (Hunter is four scalar fields; Mapper is a short array of them),
 * so 4000 is generous headroom rather than a real ceiling. It matters that it is generous:
 * thinking tokens and response tokens share this budget, and a `stop_reason: 'max_tokens'`
 * truncation produces exactly the malformed-JSON case we refuse to salvage (§11.6 #78).
 */
export const VLM_MAX_TOKENS = 4000;

/** See G3 above — this is the determinism lever, in place of the brief's `temperature: 0`. */
export const VLM_EFFORT = 'low' as const;

// ---------------------------------------------------------------------------
// Pricing (§ tier cost profile). claude-opus-5, USD per million tokens.
// ---------------------------------------------------------------------------

export const PRICE_PER_MTOK = {
  /** Uncached input. */
  input: 5.0,
  output: 25.0,
  /** Cache writes bill at 1.25x input. */
  cacheWrite: 6.25,
  /** Cache reads bill at 0.1x input. */
  cacheRead: 0.5,
} as const;

const PER_TOKEN = 1_000_000;

// ---------------------------------------------------------------------------
// Transport-agnostic request / response types
// ---------------------------------------------------------------------------

export type VlmImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface VlmImage {
  mediaType: VlmImageMediaType;
  /** Raw base64, no data-URI prefix. */
  base64: string;
}

export interface VlmRequest {
  /** The system-level instruction. Hunter and Mapper differ only here and in `schema`. */
  prompt: string;
  /** JSON Schema enforced by the API, not merely requested in prose. */
  schema: Record<string, unknown>;
  image: VlmImage;
  maxTokens?: number;
  /** Per-call wall-clock cap. The tier also enforces an overall budget on top of this. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Normalized usage. The SDK reports the cache fields as nullable; we coalesce to 0. */
export interface VlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface VlmResponse {
  /**
   * Concatenated text blocks, or null when the model returned no text at all — which is
   * what a refusal looks like. Callers must handle null; they must never assume `content[0]`.
   */
  text: string | null;
  stopReason: string | null;
  usage: VlmUsage;
  /** Real dollars, computed from `usage`. Never an estimate. */
  costUsd: number;
  model: string;
}

export interface VlmClient {
  complete(req: VlmRequest): Promise<VlmResponse>;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * The only distinctions TC's degradation ladder actually needs (§11.6 #71–73):
 *
 *   rate_limit  — 429. Back off once, then degrade (RATE_LIMITED).
 *   unavailable — 5xx / connection reset / anything else server-side (MODEL_UNAVAILABLE).
 *   timeout     — we ran out of clock (TIMEOUT).
 *   aborted     — our own deadline cancelled the request; treated as a timeout.
 *   unknown     — nothing matched; degrade conservatively rather than crash.
 */
export type VlmFailureKind = 'rate_limit' | 'unavailable' | 'timeout' | 'aborted' | 'unknown';

export class VlmError extends Error {
  readonly kind: VlmFailureKind;
  readonly status?: number;
  /** From the `retry-after` header when the server supplied one. */
  readonly retryAfterMs?: number;

  constructor(
    kind: VlmFailureKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'VlmError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/**
 * Map anything thrown by the SDK onto the taxonomy above.
 *
 * Ordered most-specific-first, per the SDK's own guidance: `APIConnectionTimeoutError`
 * extends `APIConnectionError`, which extends `APIError`, so a single broad catch would
 * collapse a retryable timeout and a permanent 400 into the same bucket.
 */
export function classifyVlmError(err: unknown): VlmError {
  if (err instanceof VlmError) return err;

  if (err instanceof APIUserAbortError) {
    return new VlmError('aborted', 'VLM request aborted by caller', { cause: err });
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new VlmError('timeout', 'VLM request timed out', { cause: err });
  }
  if (err instanceof APIConnectionError) {
    return new VlmError('unavailable', 'VLM connection failed', { cause: err });
  }
  if (err instanceof RateLimitError) {
    return new VlmError('rate_limit', 'VLM rate limited (429)', {
      status: 429,
      retryAfterMs: retryAfterFromHeaders(err.headers),
      cause: err,
    });
  }
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    if (status === 429) {
      return new VlmError('rate_limit', 'VLM rate limited (429)', { status, cause: err });
    }
    if (status !== undefined && status >= 500) {
      return new VlmError('unavailable', `VLM server error (${status})`, { status, cause: err });
    }
    return new VlmError('unknown', `VLM API error (${status ?? 'no status'})`, { status, cause: err });
  }

  // AbortSignal rejections surface as a DOMException named 'AbortError' in Node too.
  if (err instanceof Error && err.name === 'AbortError') {
    return new VlmError('aborted', 'VLM request aborted', { cause: err });
  }
  return new VlmError('unknown', err instanceof Error ? err.message : String(err), { cause: err });
}

function retryAfterFromHeaders(headers: unknown): number | undefined {
  const get = (headers as { get?: (name: string) => string | null } | undefined)?.get;
  if (typeof get !== 'function') return undefined;
  const raw = get.call(headers, 'retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Real cost for one call. The eval harness reports actual per-document spend, so this has
 * to come from `usage` rather than a per-call constant — a document that trips the
 * high-resolution image path costs several times one that doesn't, and averaging that away
 * would hide the single biggest cost lever TC has.
 */
export function computeCostUsd(usage: VlmUsage): number {
  return (
    (usage.inputTokens * PRICE_PER_MTOK.input +
      usage.outputTokens * PRICE_PER_MTOK.output +
      usage.cacheCreationInputTokens * PRICE_PER_MTOK.cacheWrite +
      usage.cacheReadInputTokens * PRICE_PER_MTOK.cacheRead) /
    PER_TOKEN
  );
}

/** Nullable SDK usage -> the normalized shape, with the cache fields coalesced to 0. */
export function normalizeUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): VlmUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The real implementation
// ---------------------------------------------------------------------------

export interface AnthropicVlmClientOptions {
  /** Pre-built SDK client. Omit and one is constructed from the ambient credentials. */
  anthropic?: Anthropic;
  model?: string;
  maxTokens?: number;
  effort?: typeof VLM_EFFORT;
}

export class AnthropicVlmClient implements VlmClient {
  private readonly anthropic: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: typeof VLM_EFFORT;

  constructor(opts: AnthropicVlmClientOptions = {}) {
    // Constructed lazily by the caller, never at module scope: `new Anthropic()` throws
    // without credentials, and the test suite must import this file with no key set.
    this.anthropic = opts.anthropic ?? new Anthropic();
    this.model = opts.model ?? VLM_MODEL;
    this.maxTokens = opts.maxTokens ?? VLM_MAX_TOKENS;
    this.effort = opts.effort ?? VLM_EFFORT;
  }

  async complete(req: VlmRequest): Promise<VlmResponse> {
    let response;
    try {
      response = await this.anthropic.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? this.maxTokens,
          // NO temperature / top_p / top_k — see G3 at the top of this file.
          output_config: {
            effort: this.effort,
            format: { type: 'json_schema', schema: req.schema },
          },
          messages: [
            {
              role: 'user',
              content: [
                // Image FIRST. Vision quality is measurably better when the image
                // precedes the instruction that refers to it.
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: req.image.mediaType,
                    data: req.image.base64,
                  },
                },
                { type: 'text', text: req.prompt },
              ],
            },
          ],
        },
        { timeout: req.timeoutMs, signal: req.signal },
      );
    } catch (err) {
      throw classifyVlmError(err);
    }

    const usage = normalizeUsage(response.usage ?? {});
    const base: Omit<VlmResponse, 'text'> = {
      stopReason: response.stop_reason ?? null,
      usage,
      costUsd: computeCostUsd(usage),
      model: response.model ?? this.model,
    };

    // stop_reason BEFORE content. A refusal is HTTP 200 with an empty content array;
    // `response.content[0].text` on that is a TypeError, i.e. a 500 to our user.
    if (response.stop_reason === 'refusal') {
      return { ...base, text: null };
    }

    const text = (response.content ?? [])
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return { ...base, text: text.length > 0 ? text : null };
  }
}

/** Convenience factory so callers don't have to import the SDK type. */
export function createVlmClient(opts: AnthropicVlmClientOptions = {}): VlmClient {
  return new AnthropicVlmClient(opts);
}
