/**
 * Tests for the injectable VLM transport.
 *
 * Every test here runs against a stubbed SDK object. Nothing touches the network and
 * nothing reads ANTHROPIC_API_KEY — that is the whole reason `VlmClient` is an interface
 * and `AnthropicVlmClient` takes its SDK instance by injection.
 */

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';

import {
  AnthropicVlmClient,
  PRICE_PER_MTOK,
  VLM_MAX_TOKENS,
  VLM_MODEL,
  classifyVlmError,
  computeCostUsd,
  normalizeUsage,
  type VlmImage,
} from '@/pipeline/vlm-client';
import { HUNTER_JSON_SCHEMA, HUNTER_PROMPT } from '@/types/vlm-schemas';

const IMAGE: VlmImage = { mediaType: 'image/jpeg', base64: 'AAAA' };

interface StubMessage {
  model?: string;
  content?: unknown[];
  stop_reason?: string | null;
  usage?: Record<string, number | null>;
}

function stubSdk(message: StubMessage | Error) {
  // Params are typed loosely on purpose: the tests assert on the recorded call, and pinning
  // the SDK's full `MessageCreateParams` here would fight the deliberately partial stub.
  const create = vi.fn(async (_params: Record<string, unknown>, _options?: Record<string, unknown>) => {
    void _params;
    void _options;
    if (message instanceof Error) throw message;
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: message.model ?? VLM_MODEL,
      content: message.content ?? [],
      stop_reason: message.stop_reason ?? 'end_turn',
      stop_sequence: null,
      usage: message.usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  });
  const sdk = { messages: { create } } as unknown as Anthropic;
  return { sdk, create };
}

// ---------------------------------------------------------------------------
// Cost — this is what the eval harness reports, so it has to be real arithmetic
// ---------------------------------------------------------------------------

describe('computeCostUsd', () => {
  it('prices exactly one million input tokens at the published input rate', () => {
    const cost = computeCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBeCloseTo(PRICE_PER_MTOK.input, 10);
    expect(cost).toBeCloseTo(5.0, 10);
  });

  it('prices exactly one million output tokens at the published output rate', () => {
    const cost = computeCostUsd({
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBeCloseTo(25.0, 10);
  });

  it('is arithmetically correct for a realistic mixed token count', () => {
    // 12,000 uncached input + 800 output, hand-computed:
    //   12_000 / 1e6 * $5.00  = $0.06
    //      800 / 1e6 * $25.00 = $0.02
    const cost = computeCostUsd({
      inputTokens: 12_000,
      outputTokens: 800,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.08, 10);
  });

  it('bills cache writes at 1.25x input and cache reads at 0.1x input', () => {
    // 1M cache-write tokens = $6.25; 1M cache-read tokens = $0.50.
    const cost = computeCostUsd({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6.75, 10);
  });

  it('is zero for a call that produced no tokens at all', () => {
    expect(
      computeCostUsd({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBe(0);
  });

  it('prices a different model at its own published rate, not the default', () => {
    // Sonnet 5: $3.00 input / $15.00 output per MTok -- cheaper than Opus 5 on both.
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const opusCost = computeCostUsd(usage, 'claude-opus-5');
    const sonnetCost = computeCostUsd(usage, 'claude-sonnet-5');
    expect(opusCost).toBeCloseTo(30.0, 10); // 5 + 25
    expect(sonnetCost).toBeCloseTo(18.0, 10); // 3 + 15
    expect(sonnetCost).toBeLessThan(opusCost);
  });

  it('refuses to silently mis-price a model with no published rate', () => {
    expect(() =>
      computeCostUsd(
        { inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        'claude-nonexistent-model',
      ),
    ).toThrow(/No published pricing/);
  });
});

describe('normalizeUsage', () => {
  it('coalesces the nullable cache fields to zero rather than propagating null into arithmetic', () => {
    expect(
      normalizeUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('AnthropicVlmClient request shape', () => {
  it('sends the exact model id, structured-output schema and low effort', async () => {
    const { sdk, create } = stubSdk({ content: [{ type: 'text', text: '{}' }] });
    await new AnthropicVlmClient({ anthropic: sdk }).complete({
      prompt: HUNTER_PROMPT,
      schema: HUNTER_JSON_SCHEMA,
      image: IMAGE,
    });

    const params = create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(VLM_MAX_TOKENS);
    expect(params.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: HUNTER_JSON_SCHEMA },
    });
    // The deprecated top-level parameter must not be used.
    expect(params).not.toHaveProperty('output_format');
  });

  it('never sends sampling parameters — they are rejected with a 400 on this model (G3)', async () => {
    const { sdk, create } = stubSdk({ content: [{ type: 'text', text: '{}' }] });
    await new AnthropicVlmClient({ anthropic: sdk }).complete({
      prompt: HUNTER_PROMPT,
      schema: HUNTER_JSON_SCHEMA,
      image: IMAGE,
    });

    const params = create.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
  });

  it('places the base64 image block before the text block', async () => {
    const { sdk, create } = stubSdk({ content: [{ type: 'text', text: '{}' }] });
    await new AnthropicVlmClient({ anthropic: sdk }).complete({
      prompt: HUNTER_PROMPT,
      schema: HUNTER_JSON_SCHEMA,
      image: IMAGE,
    });

    const params = create.mock.calls[0][0] as {
      messages: { role: string; content: { type: string; source?: unknown }[] }[];
    };
    const blocks = params.messages[0].content;
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AAAA' });
    expect(blocks[1].type).toBe('text');
  });

  it('forwards the per-call timeout as a request option', async () => {
    const { sdk, create } = stubSdk({ content: [{ type: 'text', text: '{}' }] });
    await new AnthropicVlmClient({ anthropic: sdk }).complete({
      prompt: HUNTER_PROMPT,
      schema: HUNTER_JSON_SCHEMA,
      image: IMAGE,
      timeoutMs: 1234,
    });
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 1234 });
  });
});

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

describe('AnthropicVlmClient response handling', () => {
  it('concatenates text blocks and computes cost from real usage', async () => {
    const { sdk } = stubSdk({
      content: [
        { type: 'text', text: '{"expiry_raw":' },
        { type: 'text', text: '"2028-03-15"}' },
      ],
      usage: {
        input_tokens: 12_000,
        output_tokens: 800,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    const res = await new AnthropicVlmClient({ anthropic: sdk }).complete({
      prompt: HUNTER_PROMPT,
      schema: HUNTER_JSON_SCHEMA,
      image: IMAGE,
    });

    expect(res.text).toBe('{"expiry_raw":"2028-03-15"}');
    expect(res.stopReason).toBe('end_turn');
    expect(res.costUsd).toBeCloseTo(0.08, 10);
  });

  it('handles stop_reason "refusal" with empty content without crashing', async () => {
    // The failure mode this guards: indexing content[0] unconditionally on a refusal is a
    // TypeError, which becomes a 500 for the user (§11.6 #71 — never a 500).
    const { sdk } = stubSdk({
      stop_reason: 'refusal',
      content: [],
      usage: {
        input_tokens: 500,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    const res = await new AnthropicVlmClient({ anthropic: sdk }).complete({
      prompt: HUNTER_PROMPT,
      schema: HUNTER_JSON_SCHEMA,
      image: IMAGE,
    });

    expect(res.text).toBeNull();
    expect(res.stopReason).toBe('refusal');
    // A refusal still consumed input tokens, and the harness must see that spend.
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('returns null text when the model produced no text blocks at all', async () => {
    const { sdk } = stubSdk({ content: [{ type: 'thinking', thinking: '' }] });
    const res = await new AnthropicVlmClient({ anthropic: sdk }).complete({
      prompt: HUNTER_PROMPT,
      schema: HUNTER_JSON_SCHEMA,
      image: IMAGE,
    });
    expect(res.text).toBeNull();
  });

  it('translates SDK exceptions into VlmError at the boundary', async () => {
    const { sdk } = stubSdk(new InternalServerError(503, undefined, 'boom', new Headers()));
    await expect(
      new AnthropicVlmClient({ anthropic: sdk }).complete({
        prompt: HUNTER_PROMPT,
        schema: HUNTER_JSON_SCHEMA,
        image: IMAGE,
      }),
    ).rejects.toMatchObject({ name: 'VlmError', kind: 'unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

describe('classifyVlmError', () => {
  it('maps a 429 to rate_limit and reads retry-after', () => {
    const err = classifyVlmError(
      new RateLimitError(429, undefined, 'slow down', new Headers({ 'retry-after': '2' })),
    );
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(2000);
  });

  it('maps 5xx to unavailable', () => {
    expect(classifyVlmError(new InternalServerError(500, undefined, 'x', new Headers())).kind).toBe(
      'unavailable',
    );
    expect(classifyVlmError(new InternalServerError(503, undefined, 'x', new Headers())).kind).toBe(
      'unavailable',
    );
  });

  it('distinguishes a connection timeout from a plain connection failure', () => {
    expect(classifyVlmError(new APIConnectionTimeoutError()).kind).toBe('timeout');
    expect(classifyVlmError(new APIConnectionError({ message: 'reset' })).kind).toBe('unavailable');
  });

  it('maps a caller abort to aborted', () => {
    expect(classifyVlmError(new APIUserAbortError()).kind).toBe('aborted');
  });

  it('does not report a 4xx as retryable', () => {
    expect(classifyVlmError(new BadRequestError(400, undefined, 'bad', new Headers())).kind).toBe(
      'unknown',
    );
  });

  it('never throws on a non-Error value', () => {
    expect(classifyVlmError('kaboom').kind).toBe('unknown');
    expect(classifyVlmError(undefined).kind).toBe('unknown');
  });

  it('passes a VlmError through unchanged', () => {
    const original = classifyVlmError(new APIConnectionTimeoutError());
    expect(classifyVlmError(original)).toBe(original);
  });
});
