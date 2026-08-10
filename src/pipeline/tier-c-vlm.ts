/**
 * TC — the dual-call VLM tier (§7 TC). Fires only when TA and TB have both abstained.
 *
 * ---------------------------------------------------------------------------
 * Why two asymmetric calls and not one call sampled twice (§4.4)
 * ---------------------------------------------------------------------------
 *
 * The obvious confidence signals do not work. On the Perfios benchmark
 * (arXiv 2606.24420), mean token log-probability scored 0.705 AUC and verbalized
 * self-confidence 0.692 — both collapse to all-positive at threshold 0.5, i.e. they
 * approve everything. Five-way self-consistency reached only 0.744 at five times the cost.
 * The diagnosis is the part worth internalising: **extraction errors are document-caused,
 * not model-caused.** A frontier model transcribing OCR noise is confidently wrong, and
 * resampling the same prompt resamples the same wrongness. Log-probs measure a consequence;
 * they cannot see the cause.
 *
 * So instead of sampling one distribution repeatedly, we run two calls whose *failure modes
 * differ by construction*:
 *
 *   Hunter — field-guided ("extract field X"). Under schema-completion pressure it will
 *            produce *something* even when the field is absent. It FABRICATES on missing
 *            fields, and it fabricates confidently.
 *   Mapper — document-guided ("list what this document actually contains"). It reports only
 *            what is visually grounded, so it MISSES non-salient fields but rarely invents.
 *
 * Because the two err in opposite directions, their **disagreement is informative in a way
 * that resampling is not**. The specific signature we care about — Hunter returns a value,
 * Mapper's inventory contains nothing matching it (§11.6 #76) — is precisely the fabrication
 * pattern, and it is invisible to any single-call confidence score. It is emitted as
 * `HUNTER_MAPPER_DISAGREE` with the offending candidate's confidence floored, so the fusion
 * layer penalises it sharply rather than averaging it away.
 *
 * Cost is fixed at two calls per document regardless of how big the schema gets, which is
 * what makes this affordable as the last tier rather than the first.
 *
 * ---------------------------------------------------------------------------
 * What this module does NOT do
 * ---------------------------------------------------------------------------
 *
 *  - It does not parse dates itself. Everything raw goes through
 *    `normalizeFreeTextDate` / `parseDateRange` (§8), including the two-digit-century
 *    resolution, so TC and TB cannot drift apart on `03/04/28`.
 *  - It does not regex-scrape a broken model response into a date (§11.6 #78). A malformed
 *    body gets exactly one structured retry and is then abandoned. Salvaging a truncated
 *    JSON body by pattern-matching a date out of it is how you ship a value that no part of
 *    the system can explain.
 *  - It does not try to defend itself against prompt injection by reasoning about it
 *    (§11.5 #66). It surfaces `MapperOutput.contains_instruction_like_text` as
 *    `PROMPT_INJECTION_SUSPECTED` and leaves the actual defence — grounding the value
 *    against the OCR token stream — to the router, which has the token stream. Asking the
 *    model whether it was manipulated is asking the compromised component to self-report.
 */

import {
  abstain,
  type DateRole,
  type DocumentClass,
  type ReasonCode,
  type TierCandidate,
  type TierResult,
} from '@/types/contract';
import { normalizeFreeTextDate, parseDateRange, type FreeTextOptions } from '@/engine/dates';
import {
  HUNTER_JSON_SCHEMA,
  HUNTER_PROMPT,
  HunterOutput,
  MAPPER_JSON_SCHEMA,
  MAPPER_PROMPT,
  MapperOutput,
  type MapperDate,
} from '@/types/vlm-schemas';
import {
  classifyVlmError,
  type VlmClient,
  type VlmImage,
  type VlmRequest,
} from '@/pipeline/vlm-client';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Tier-local confidence for a value both calls independently produced. This is the good
 * case: the field-guided call found it *and* the document-guided inventory contains it, so
 * it is both salient and grounded. Still well short of the 0.99 the deterministic tiers
 * claim — those carry check digits, this carries agreement.
 */
export const CORROBORATED_CONFIDENCE = 0.85;

/** Mapper found it and labelled it as expiry-bearing, but Hunter did not corroborate. */
export const MAPPER_EXPIRY_CONFIDENCE = 0.6;

/** Mapper inventory entry with a non-expiry role. Useful to the constraint engine, not a verdict. */
export const MAPPER_OTHER_CONFIDENCE = 0.5;

/** A value whose day/month order is genuinely undecidable (§8.1). Routed, never guessed. */
export const AMBIGUOUS_CONFIDENCE = 0.3;

/**
 * §11.6 #76 — the fabrication signature. Deliberately below `REVIEW_FLOOR` so that this
 * candidate cannot carry a document on its own no matter how the fusion weights land.
 */
export const HUNTER_ONLY_CONFIDENCE = 0.15;

/** Hunter had a value and Mapper never ran. Not a disagreement — just uncorroborated. */
export const HUNTER_UNCORROBORATED_CONFIDENCE = 0.5;

/** Multiplier applied when the Mapper marked the value only partially legible. */
export const ILLEGIBLE_PENALTY = 0.5;

/**
 * Pre-flight cost estimate for the pair (§11.6 #74). We must refuse BEFORE spending, and
 * before spending we only know the shape of the call, not its usage — so this is a
 * deliberately pessimistic ceiling: ~5k input tokens (a high-resolution page image plus the
 * prompt) and ~500 output tokens per call. Actual spend is always recomputed from real usage.
 */
export const ESTIMATED_DUAL_CALL_COST_USD = 0.08;

/**
 * Wall-clock cap for the whole tier, inside the pipeline budget (§11.6 #72). The router
 * always overrides this with whatever remains of `PIPELINE_BUDGET_MS` in production; this
 * default only matters for direct/test callers. Raised alongside `PIPELINE_BUDGET_MS` —
 * 12s was sized for the synthetic corpus's small, single-purpose images, not a dense
 * real-world scan.
 */
export const DEFAULT_TIME_BUDGET_MS = 25_000;

/**
 * Per-call transport timeout. This one DOES bind in production (the router does not
 * override it) — a single Hunter or Mapper call generating a full structured response
 * over a large, dense image can genuinely need more than 10s, and hitting this ceiling
 * mid-generation is indistinguishable from the model actually failing.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;

/** First (and only) backoff step for a 429 (§11.6 #73). */
export const RATE_LIMIT_BACKOFF_BASE_MS = 500;

/** One retry means attempts 0 and 1. There is no third attempt on any path. */
const MAX_ATTEMPTS = 2;

/** Roles that can, by themselves, terminate a document's validity. */
const EXPIRY_BEARING_ROLES: ReadonlySet<DateRole> = new Set<DateRole>(['EXPIRY', 'COVERAGE_END']);

/**
 * Classes for which "no expiry date anywhere on the page" is a *finding* rather than a
 * failure (§4.3, §11.6 #77). An employment letter genuinely has no expiry semantics; a
 * passport that yielded no dates at all means we failed to read it, and saying
 * NO_EXPIRY_SEMANTICS there would launder a read failure into a clean answer.
 */
const NO_EXPIRY_SEMANTICS_CLASSES: ReadonlySet<DocumentClass> = new Set<DocumentClass>([
  'EMPLOYMENT_LETTER',
  'OTHER_DOCUMENT',
  'NOT_A_DOCUMENT',
]);

/**
 * Appended to the prompt on the single retry after a malformed body (§11.6 #78). It is a
 * *structured* retry — same schema, same image, one added instruction — not a repair pass
 * over the broken text.
 */
export const REPAIR_SUFFIX =
  '\n\nYour previous response could not be parsed. Return only a single JSON object ' +
  'matching the required schema, with no surrounding prose, markdown fences or commentary.';

// ---------------------------------------------------------------------------
// Input / internal types
// ---------------------------------------------------------------------------

export interface TierCInput {
  image: VlmImage;
  /** From T0. Decides whether "no dates" is a finding or a failure (§11.6 #77). */
  documentClass: DocumentClass;
  /** 'US' biases MM/DD, 'DMY' biases DD/MM, null leaves ambiguity unresolved (§8.1). */
  issuerConvention?: 'US' | 'DMY' | null;
  today?: Date;
  /** Remaining USD the caller is willing to spend on this document (§11.6 #74). */
  budgetUsd?: number;
  timeBudgetMs?: number;
  callTimeoutMs?: number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

type CallOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'failed'; reasons: ReasonCode[] }
  | { status: 'pending' };

interface Spend {
  usd: number;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the Hunter/Mapper pair and merge them into a `TierResult`.
 *
 * Never throws. Every failure mode in §11.6 #71–74 becomes an abstention carrying a reason
 * code, because the one thing this tier must not do is turn a model outage into a 500 for
 * a compliance analyst who just wanted to know if a passport was in date.
 */
export async function runTierCVlm(client: VlmClient, input: TierCInput): Promise<TierResult> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultSleep;
  const startedAt = now();
  const today = input.today ?? new Date();
  const timeBudgetMs = input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

  // ---- Cost cap: refuse BEFORE spending, not after (§11.6 #74) ----
  const budgetUsd = input.budgetUsd ?? Number.POSITIVE_INFINITY;
  if (budgetUsd < ESTIMATED_DUAL_CALL_COST_USD) {
    return abstain('TC_VLM', ['COST_CAP_REACHED'], { duration_ms: now() - startedAt });
  }

  const spend: Spend = { usd: 0 };
  const outcomes: { hunter: CallOutcome<HunterOutput>; mapper: CallOutcome<MapperOutput> } = {
    hunter: { status: 'pending' },
    mapper: { status: 'pending' },
  };

  const baseRequest = {
    image: input.image,
    timeoutMs: input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  };

  // ---- The two calls are independent, so they go out together, not in sequence.
  //      Sequential dispatch would double TC's latency for no informational gain. ----
  const hunterCall = runCall(
    client,
    { ...baseRequest, prompt: HUNTER_PROMPT, schema: HUNTER_JSON_SCHEMA },
    (text) => HunterOutput.safeParse(safeJsonParse(text)),
    spend,
    sleep,
  ).then((outcome) => {
    outcomes.hunter = outcome;
  });

  const mapperCall = runCall(
    client,
    { ...baseRequest, prompt: MAPPER_PROMPT, schema: MAPPER_JSON_SCHEMA },
    (text) => MapperOutput.safeParse(safeJsonParse(text)),
    spend,
    sleep,
  ).then((outcome) => {
    outcomes.mapper = outcome;
  });

  // `Promise.allSettled` semantics without the rejection plumbing: `runCall` never throws,
  // and the outcome slots are written as each call lands, so a deadline hit still leaves us
  // holding whatever completed (§11.6 #72 — "return partial with TIMEOUT").
  const completed = await raceDeadline(Promise.all([hunterCall, mapperCall]), timeBudgetMs);

  const timedOut = !completed;
  const duration = () => now() - startedAt;

  return merge({
    outcomes,
    timedOut,
    spend,
    documentClass: input.documentClass,
    dateOpts: { issuerConvention: input.issuerConvention ?? null, role: 'UNKNOWN', today },
    durationMs: duration(),
  });
}

// ---------------------------------------------------------------------------
// One call, with the whole retry/degrade ladder (§11.6 #71, #73, #78)
// ---------------------------------------------------------------------------

async function runCall<T>(
  client: VlmClient,
  request: Omit<VlmRequest, 'prompt' | 'schema'> & { prompt: string; schema: Record<string, unknown> },
  parse: (text: string) => { success: true; data: T } | { success: false },
  spend: Spend,
  sleep: (ms: number) => Promise<void>,
): Promise<CallOutcome<T>> {
  let repaired = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const last = attempt === MAX_ATTEMPTS - 1;
    const prompt = repaired ? request.prompt + REPAIR_SUFFIX : request.prompt;

    let response;
    try {
      response = await client.complete({ ...request, prompt });
    } catch (raw) {
      const err = classifyVlmError(raw);

      // 429 — exponential backoff, exactly one retry, then degrade.
      if (err.kind === 'rate_limit' && !last) {
        await sleep(err.retryAfterMs ?? backoffMs(attempt));
        continue;
      }
      if (err.kind === 'rate_limit') return { status: 'failed', reasons: ['RATE_LIMITED'] };
      if (err.kind === 'timeout' || err.kind === 'aborted') {
        return { status: 'failed', reasons: ['TIMEOUT'] };
      }
      // 5xx, connection failure, and anything unrecognised all degrade the same way.
      return { status: 'failed', reasons: ['MODEL_UNAVAILABLE'] };
    }

    // Cost accrues per response received, including responses we end up discarding — a
    // retried call really did cost twice, and the eval harness must see that.
    spend.usd += response.costUsd;

    // A refusal is a 200 with no content. Retrying it produces another refusal, so there is
    // no point spending a second call on it. There is no REFUSED reason code in the frozen
    // contract; MODEL_UNAVAILABLE is the honest mapping — this model would not answer.
    if (response.stopReason === 'refusal' || response.text === null) {
      return { status: 'failed', reasons: ['MODEL_UNAVAILABLE'] };
    }

    // A `max_tokens` stop truncates the JSON mid-object. Treat it as malformed rather than
    // parsing the fragment — same rule, same single retry.
    const parsed = response.stopReason === 'max_tokens' ? { success: false as const } : parse(response.text);
    if (parsed.success) return { status: 'ok', value: parsed.data };

    if (!last) {
      repaired = true;
      continue;
    }
    // §11.6 #78 — one structured retry, then abstain. We do NOT regex-scrape the body.
    return { status: 'failed', reasons: ['MODEL_UNAVAILABLE'] };
  }

  /* c8 ignore next */
  return { status: 'failed', reasons: ['MODEL_UNAVAILABLE'] };
}

export function backoffMs(attempt: number): number {
  return RATE_LIMIT_BACKOFF_BASE_MS * 2 ** attempt;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // zod will reject it; no partial-parse salvage attempt.
  }
}

async function raceDeadline(work: Promise<unknown>, ms: number): Promise<boolean> {
  if (!Number.isFinite(ms) || ms <= 0) {
    await work;
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  const finished = await Promise.race([work.then(() => true as const), expiry]);
  if (timer) clearTimeout(timer);
  return finished;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

// ---------------------------------------------------------------------------
// Merge (§7 TC, §11.6 #76 / #77)
// ---------------------------------------------------------------------------

interface MergeInput {
  outcomes: { hunter: CallOutcome<HunterOutput>; mapper: CallOutcome<MapperOutput> };
  timedOut: boolean;
  spend: Spend;
  documentClass: DocumentClass;
  dateOpts: FreeTextOptions;
  durationMs: number;
}

function merge(input: MergeInput): TierResult {
  const { outcomes, timedOut, spend, documentClass, dateOpts, durationMs } = input;
  const reasons = new Set<ReasonCode>();

  const hunter = outcomes.hunter;
  const mapper = outcomes.mapper;

  // A call still pending when the deadline fired is a timeout for that call specifically.
  if (timedOut) reasons.add('TIMEOUT');
  for (const outcome of [hunter, mapper]) {
    if (outcome.status === 'failed') for (const reason of outcome.reasons) reasons.add(reason);
    if (outcome.status === 'pending' && timedOut) reasons.add('TIMEOUT');
  }

  const mapperValue = mapper.status === 'ok' ? mapper.value : null;
  const hunterValue = hunter.status === 'ok' ? hunter.value : null;

  // §11.5 #66 — surface it, do not act on it. The real defence is downstream grounding.
  if (mapperValue?.contains_instruction_like_text) reasons.add('PROMPT_INJECTION_SUSPECTED');

  const issuer = mapperValue?.issuing_authority?.trim() || null;
  const base = {
    tier: 'TC_VLM' as const,
    anomalies: [],
    checksum_validated: null,
    checksum_detail: null,
    issuer,
    cost_usd: spend.usd,
    duration_ms: durationMs,
  };

  // ---- Both calls unusable: nothing to merge. ----
  if (!mapperValue && !hunterValue) {
    if (reasons.size === 0) reasons.add('MODEL_UNAVAILABLE');
    return abstain('TC_VLM', [...reasons], base);
  }

  // ---- §11.6 #77 — both calls returned, and neither found anything. ----
  const mapperFoundNothing = mapperValue !== null && mapperValue.dates.length === 0;
  const hunterFoundNothing = hunterValue !== null && hunterValue.expiry_raw === null;
  if (mapperFoundNothing && hunterFoundNothing) {
    reasons.add(
      NO_EXPIRY_SEMANTICS_CLASSES.has(documentClass) ? 'NO_EXPIRY_SEMANTICS' : 'NO_DATES_FOUND',
    );
    return abstain('TC_VLM', [...reasons], base);
  }

  // ---- Every Mapper date becomes a candidate, carrying its inferred role. ----
  const candidates: TierCandidate[] = [];
  const built: BuiltCandidate[] = [];

  for (const date of mapperValue?.dates ?? []) {
    const entry = buildMapperCandidate(date, dateOpts);
    if (entry.ambiguous) reasons.add('AMBIGUOUS_DATE_FORMAT');
    candidates.push(entry.candidate);
    built.push(entry);
  }

  // ---- Cross-reference the Hunter value against that inventory. ----
  if (hunterValue && hunterValue.expiry_raw && hunterValue.expiry_raw.trim().length > 0) {
    const hunterRaw = hunterValue.expiry_raw.trim();
    const hunterNormalized = normalizeFreeTextDate(hunterRaw, { ...dateOpts, role: 'EXPIRY' });
    const hunterKeys = matchKeysFor(hunterRaw, hunterNormalized.iso);

    const match = built.find((entry) => entry.matchKeys.some((key) => hunterKeys.includes(key)));

    if (match) {
      // Corroborated: salient enough for the field-guided call to find, grounded enough for
      // the document-guided inventory to list. This is the only high-confidence path in TC.
      // An unresolvable value stays capped — agreement on an ambiguous reading is agreement
      // that we cannot read it, which is not evidence of anything.
      const ceiling =
        match.ambiguous || match.candidate.iso === null
          ? AMBIGUOUS_CONFIDENCE
          : CORROBORATED_CONFIDENCE * (match.illegible ? ILLEGIBLE_PENALTY : 1);
      match.candidate.confidence = clamp(Math.max(match.candidate.confidence, ceiling));
      // Mapper often declines to name a role it cannot infer. When the field-guided call
      // independently points at the same value, UNKNOWN becomes EXPIRY — an inference the
      // constraint engine is still free to eliminate.
      if (match.candidate.role === 'UNKNOWN') match.candidate.role = 'EXPIRY';
      if (!match.candidate.label_verbatim && hunterValue.label_verbatim) {
        match.candidate.label_verbatim = hunterValue.label_verbatim;
      }
      if (!match.candidate.snippet && hunterValue.neighbouring_text) {
        match.candidate.snippet = hunterValue.neighbouring_text;
      }
    } else if (mapperValue) {
      // §11.6 #76 — THE fabrication signature. Hunter produced a value; the Mapper's
      // inventory of what is actually printed contains nothing like it. Under
      // schema-completion pressure Hunter emits *something* for an absent field, and it does
      // so with the same fluency it uses for a real one — which is exactly why no
      // single-call confidence score catches this and why the two prompts are asymmetric.
      //
      // We keep the candidate (the "why?" panel should be able to show what was claimed and
      // rejected) but floor its confidence below REVIEW_FLOOR and raise the reason code, so
      // the fusion layer penalises it sharply instead of averaging it into a pass.
      reasons.add('HUNTER_MAPPER_DISAGREE');
      candidates.push(hunterCandidate(hunterValue, hunterNormalized.iso, HUNTER_ONLY_CONFIDENCE));
      if (hunterNormalized.ambiguous) reasons.add('AMBIGUOUS_DATE_FORMAT');
    } else {
      // Mapper never returned (failed or timed out), so there is nothing to disagree with.
      // Uncorroborated is not the same finding as contradicted — do not cry fabrication.
      reasons.add('LOW_TIER_CONFIDENCE');
      candidates.push(
        hunterCandidate(hunterValue, hunterNormalized.iso, HUNTER_UNCORROBORATED_CONFIDENCE),
      );
      if (hunterNormalized.ambiguous) reasons.add('AMBIGUOUS_DATE_FORMAT');
    }
  }

  if (candidates.length === 0) {
    reasons.add(
      NO_EXPIRY_SEMANTICS_CLASSES.has(documentClass) ? 'NO_EXPIRY_SEMANTICS' : 'NO_DATES_FOUND',
    );
    return abstain('TC_VLM', [...reasons], base);
  }

  return {
    ...base,
    abstained: false,
    candidates,
    reason_codes: [...reasons],
  };
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

interface BuiltCandidate {
  candidate: TierCandidate;
  /** Normalized keys used to decide whether the Hunter value is "the same date". */
  matchKeys: string[];
  ambiguous: boolean;
  illegible: boolean;
}

function buildMapperCandidate(date: MapperDate, opts: FreeTextOptions): BuiltCandidate {
  const raw = date.raw.trim();
  let role: DateRole = date.inferred_role;

  // Insurance cards print coverage as a range far more often than as two labelled fields
  // (§8.4). The END of the range is the one carrying expiry semantics.
  const range = parseDateRange(raw, { ...opts, role });
  const isRange = range?.end?.iso != null;
  if (isRange && (role === 'UNKNOWN' || role === 'COVERAGE_START')) role = 'COVERAGE_END';
  const normalized =
    isRange && range?.end ? range.end : normalizeFreeTextDate(raw, { ...opts, role });

  let confidence = EXPIRY_BEARING_ROLES.has(role)
    ? MAPPER_EXPIRY_CONFIDENCE
    : MAPPER_OTHER_CONFIDENCE;
  if (date.illegible) confidence *= ILLEGIBLE_PENALTY;
  if (normalized.ambiguous || normalized.iso === null) {
    confidence = Math.min(confidence, AMBIGUOUS_CONFIDENCE);
  }

  return {
    ambiguous: normalized.ambiguous,
    illegible: date.illegible,
    matchKeys: matchKeysFor(raw, normalized.iso),
    candidate: {
      raw,
      iso: normalized.iso,
      role,
      label_verbatim: date.label_verbatim,
      snippet: date.neighbouring_text,
      // The VLM path returns no geometry; the crop/bbox comes from the OCR layer upstream.
      bbox: null,
      confidence: clamp(confidence),
    },
  };
}

function hunterCandidate(value: HunterOutput, iso: string | null, confidence: number): TierCandidate {
  return {
    raw: (value.expiry_raw ?? '').trim(),
    iso,
    role: 'EXPIRY',
    label_verbatim: value.label_verbatim,
    snippet: value.neighbouring_text,
    bbox: null,
    confidence,
  };
}

/**
 * Two values are "the same date" if they normalize to the same ISO day, or — when
 * normalization failed on one side — if their alphanumeric skeletons match. The second
 * clause matters: `EXP 03-04-28` and `03/04/28` are the same printed value, and an
 * ambiguity that blocks ISO resolution blocks it identically for both calls.
 */
function matchKeysFor(raw: string, iso: string | null): string[] {
  const keys: string[] = [];
  if (iso) keys.push(`iso:${iso}`);
  const skeleton = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (skeleton.length > 0) keys.push(`raw:${skeleton}`);
  return keys;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
