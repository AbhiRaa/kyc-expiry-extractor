/**
 * POST /api/eval-gate — a live, real run of the admission gate against the real
 * 35-document eval corpus (docs/DECISIONS.md's live gate-check entry).
 *
 * Structurally $0: `runPipeline` is called with no `vlmClient` at all, so there is no
 * client object to call the paid VLM tier with — not a budget check that could be
 * bypassed, an absence of the thing that would need to be called. TA (MRZ/PDF417) and TB
 * (Tesseract OCR) are already-free, deterministic tiers, so this still runs the *real*
 * router logic (the same code path `eval/run.ts` already exercises for its own "no key"
 * row), not a re-implemented shortcut — see the design note in DECISIONS.md for why
 * calling `runAdmissionGate` directly instead would have under-counted `spend_avoided_usd`
 * on `ADMIT_LIMITED` documents.
 *
 * Reads the corpus from `public/eval-corpus/` (committed to git, unlike `eval/corpus/`
 * itself — see `eval/copy-eval-corpus.ts`), not `eval/corpus/`, since that tree does not
 * exist in a deployed build at all.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

import { ANCHOR_TODAY } from '@/lib/anchor-date';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { normalizeDocument } from '@/pipeline/normalize';
import { runPipeline } from '@/pipeline/router';
import type { GateCorpusCheckResult } from '@/types/gate-check';

export const runtime = 'nodejs';
export const maxDuration = 120;

const EVAL_CORPUS_DIR = path.join(process.cwd(), 'public', 'eval-corpus');

/** One request already does ~35x the work of a single extraction — a much stricter
 *  window than /api/extract's. */
const RATE_LIMIT_MAX_REQUESTS = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;

/** Bounds how many documents are normalized/routed at once. Parallelizing aggressively
 *  buys little here regardless — OCR calls funnel through one shared, queued Tesseract
 *  worker (tier-b-ocr.ts) — but a small batch still overlaps the non-OCR work (file read,
 *  image decode, PDF417/MRZ attempts) across documents instead of running everything
 *  fully sequentially. */
const CONCURRENCY = 4;

interface ManifestEntry {
  filename: string;
  expectedClass: string;
  adversarial: boolean;
}

async function runBatch<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function POST(request: Request): Promise<NextResponse> {
  const { allowed, retryAfterSeconds } = checkRateLimit(
    `eval-gate:${getClientIp(request)}`,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many live checks. Wait a few minutes and try again.' },
      { status: 429, headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {} },
    );
  }

  const started = Date.now();
  try {
    const manifestRaw = await readFile(path.join(EVAL_CORPUS_DIR, 'manifest.json'), 'utf8');
    const manifest: ManifestEntry[] = JSON.parse(manifestRaw);

    if (manifest.length === 0) {
      return NextResponse.json(
        { error: 'The eval corpus manifest is empty — run "npm run generate:corpus".' },
        { status: 503 },
      );
    }

    const today = new Date(ANCHOR_TODAY);
    let containedCount = 0;
    let rejectedCount = 0;
    let falseRejectCount = 0;
    let spendAvoidedUsd = 0;

    await runBatch(manifest, CONCURRENCY, async (doc) => {
      const bytes = new Uint8Array(await readFile(path.join(EVAL_CORPUS_DIR, doc.filename)));
      const outcome = await normalizeDocument(bytes, { declaredName: doc.filename });
      // runPipeline handles T0 rejections internally (router.ts's rejectionResponse() /
      // terminalRejectionResponse()) — called unconditionally here, exactly like
      // eval/run.ts's own harness does, so a T0-level rejection's real decision (REJECTED
      // for EMPTY_FILE/UNSUPPORTED_TYPE, REVIEW for the rest) is what gets counted below,
      // not a hand-rolled guess that can drift from what the router actually returns.
      const response = await runPipeline({ outcome, today }); // no vlmClient — see file header
      spendAvoidedUsd += response.admission?.spend_avoided_usd ?? 0;

      if (doc.adversarial) {
        if (response.admission?.decision !== 'ADMIT_FULL') containedCount++;
        if (response.decision === 'REJECTED') rejectedCount++;
      } else if (response.decision === 'REJECTED') {
        falseRejectCount++;
      }
    });

    const adversarialTotal = manifest.filter((d) => d.adversarial).length;
    const nonAdversarialTotal = manifest.length - adversarialTotal;

    const result: GateCorpusCheckResult = {
      computedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      documentsChecked: manifest.length,
      adversarialTotal,
      containedCount,
      rejectedCount,
      nonAdversarialTotal,
      falseRejectCount,
      spendAvoidedUsd: Number(spendAvoidedUsd.toFixed(4)),
    };

    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (error) {
    console.error('[eval-gate] unhandled failure', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json(
      { error: 'The live gate check failed to complete.' },
      { status: 500 },
    );
  }
}

export function GET(): NextResponse {
  return NextResponse.json({ error: 'Use POST — no body required.' }, { status: 405 });
}
