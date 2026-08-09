/**
 * The eval harness (§12). `npm run eval`.
 *
 * §12 calls the eval table the thing that separates this from a toy, and the thing most
 * candidates will not produce. Its job is to make every number in the README reproducible
 * from a clean clone — so nothing here is hand-written, and nothing is rounded by hand.
 *
 * The headline is deliberately NOT raw accuracy. For a system with an abstention path,
 * raw accuracy hides whether the abstentions were the right ones — a system that abstains
 * on everything scores 100% on the two documents it answered. The number that matters is
 * **accuracy at a stated coverage level**: "N% of documents clear with zero human touch,
 * at X% accuracy on those, at $Y per document."
 *
 * Two labelling policies this harness has to respect, both from the corpus generator:
 *
 *   1. Everything is evaluated against the pinned ANCHOR_TODAY, never the wall clock.
 *      Otherwise every recency-window and expiry verdict drifts by the day you run it.
 *   2. Degraded documents (blur, glare) carry the TRUE printed expiry with an expected
 *      verdict of INDETERMINATE. The correct behaviour is abstention, so an abstention
 *      there scores as COVERAGE LOST, not as a wrong date. The truth is recorded only so
 *      the confident-and-wrong table can be computed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Decision, ExtractionResponse, SourceTier } from '@/types/contract';
import { accuracyAtCoverage, pointAtCoverage } from '@/engine/confidence';
import { normalizeDocument } from '@/pipeline/normalize';
import { runPipeline } from '@/pipeline/router';
import { AnthropicVlmClient } from '@/pipeline/vlm-client';
import { terminateOcrWorker } from '@/pipeline/tier-b-ocr';
import { ANCHOR_TODAY, CORPUS_DIR, GROUND_TRUTH_PATH } from './generate-corpus';

const RESULTS_PATH = path.join(path.dirname(GROUND_TRUTH_PATH), 'results.md');
const TARGET_COVERAGE = 0.8;

interface Expected {
  filename: string;
  expected_class: string;
  expected_basis: string;
  expected_date: string | null;
  expected_verdict: string;
  notes: string;
}

interface Outcome {
  expected: Expected;
  actual: ExtractionResponse | null;
  error: string | null;
  /** Did the system produce the right answer, under the policies described above? */
  correct: boolean;
  /** Did the system commit to an answer at all? Abstentions are coverage lost. */
  committed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180 — the notes column is quoted and contains commas)
// ---------------------------------------------------------------------------

function parseCsv(text: string): Expected[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim().length > 0));
  const idx = (name: string) => header.indexOf(name);
  return body.map((r) => ({
    filename: r[idx('filename')],
    expected_class: r[idx('expected_class')],
    expected_basis: r[idx('expected_basis')],
    expected_date: r[idx('expected_date')] === 'null' ? null : r[idx('expected_date')],
    expected_verdict: r[idx('expected_verdict')],
    notes: r[idx('notes')] ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * A run is "correct" when it produced the right ANSWER, which is not always a date.
 *
 * - Where the expected verdict is INDETERMINATE (degraded documents), the correct
 *   behaviour is to abstain. Committing to a date there is wrong even if the date is
 *   right, because the system had no business being confident.
 * - Where the expected date is null (NO_EXPIRY classes), returning null with the right
 *   basis is the correct answer, and returning any date is a failure.
 * - Otherwise the date must match exactly and the basis must be right — a right date
 *   under the wrong rule is a coincidence, not an answer.
 */
function score(expected: Expected, actual: ExtractionResponse): Omit<Outcome, 'expected' | 'actual' | 'error'> {
  const committed = actual.decision !== 'REVIEW';

  if (expected.expected_verdict === 'INDETERMINATE') {
    return committed
      ? { correct: false, committed, reason: 'committed to an answer on a document it should have abstained on' }
      : { correct: true, committed, reason: 'correctly abstained on a degraded document' };
  }

  const basisOk = actual.validity.basis === expected.expected_basis;

  if (expected.expected_date === null) {
    const ok = actual.validity.date === null && basisOk;
    return {
      correct: ok,
      committed,
      reason: ok
        ? `correctly returned no date under ${expected.expected_basis}`
        : `expected no date under ${expected.expected_basis}, got ${actual.validity.date ?? 'null'} under ${actual.validity.basis}`,
    };
  }

  const dateOk = actual.validity.date === expected.expected_date;
  const verdictOk = actual.validity.verdict === expected.expected_verdict;
  const ok = dateOk && basisOk && verdictOk;
  return {
    correct: ok,
    committed,
    reason: ok
      ? 'exact match on date, basis and verdict'
      : [
          !dateOk && `date ${actual.validity.date ?? 'null'} != ${expected.expected_date}`,
          !basisOk && `basis ${actual.validity.basis} != ${expected.expected_basis}`,
          !verdictOk && `verdict ${actual.validity.verdict} != ${expected.expected_verdict}`,
        ]
          .filter(Boolean)
          .join('; '),
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const today = new Date(`${ANCHOR_TODAY}T00:00:00Z`);
  const csv = await readFile(GROUND_TRUTH_PATH, 'utf8');
  const expectations = parseCsv(csv);

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const vlmClient = hasKey ? new AnthropicVlmClient() : undefined;
  if (!hasKey) {
    console.warn(
      '! ANTHROPIC_API_KEY is not set — the TC dual-VLM tier will not run.\n' +
        '  Deterministic and OCR tiers are evaluated in full; TC rows will show as MODEL_UNAVAILABLE.\n',
    );
  }

  const outcomes: Outcome[] = [];
  for (const expected of expectations) {
    process.stdout.write(`  ${expected.filename.padEnd(40)}`);
    try {
      const bytes = new Uint8Array(await readFile(path.join(CORPUS_DIR, expected.filename)));
      const outcome = await normalizeDocument(bytes, { declaredName: expected.filename });
      const actual = await runPipeline({ outcome, vlmClient, today, budgetUsd: 0.25 });
      const scored = score(expected, actual);
      outcomes.push({ expected, actual, error: null, ...scored });
      console.log(
        `${scored.correct ? 'OK  ' : 'MISS'}  ${actual.decision.padEnd(9)} ${actual.evidence.source_tier.padEnd(11)} conf=${actual.confidence.toFixed(2)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        expected,
        actual: null,
        error: message,
        correct: false,
        committed: false,
        reason: `harness error: ${message}`,
      });
      console.log(`ERROR  ${message}`);
    }
  }

  await terminateOcrWorker().catch(() => undefined);
  await writeFile(RESULTS_PATH, renderReport(outcomes, hasKey), 'utf8');
  console.log(`\nWrote ${path.relative(process.cwd(), RESULTS_PATH)}`);

  const answered = outcomes.filter((o) => o.committed);
  const correctAnswered = answered.filter((o) => o.correct).length;
  console.log(
    `Coverage ${pct(answered.length / outcomes.length)} · accuracy on covered ${
      answered.length ? pct(correctAnswered / answered.length) : 'n/a'
    } · overall ${pct(outcomes.filter((o) => o.correct).length / outcomes.length)}`,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderReport(outcomes: Outcome[], hasKey: boolean): string {
  const total = outcomes.length;
  const correct = outcomes.filter((o) => o.correct).length;
  const answered = outcomes.filter((o) => o.committed);
  const abstained = total - answered.length;

  const curve = accuracyAtCoverage(
    outcomes.map((o) => ({ confidence: o.actual?.confidence ?? 0, correct: o.correct })),
  );
  const at80 = pointAtCoverage(curve, TARGET_COVERAGE);

  // Confident and wrong is the only truly bad outcome in a no-human-in-the-loop system.
  const confidentlyWrong = outcomes.filter(
    (o) => o.actual && o.actual.decision !== 'REVIEW' && !o.correct,
  );
  const confidentlyRight = outcomes.filter(
    (o) => o.actual && o.actual.decision !== 'REVIEW' && o.correct,
  );

  const byTier = new Map<SourceTier, Outcome[]>();
  for (const o of outcomes) {
    const tier = o.actual?.evidence.source_tier ?? 'NONE';
    byTier.set(tier, [...(byTier.get(tier) ?? []), o]);
  }

  const byDecision = new Map<Decision, number>();
  for (const o of outcomes) {
    if (!o.actual) continue;
    byDecision.set(o.actual.decision, (byDecision.get(o.actual.decision) ?? 0) + 1);
  }

  const totalCost = outcomes.reduce((sum, o) => sum + (o.actual?.cost_usd ?? 0), 0);
  const meanLatency =
    outcomes.reduce((sum, o) => sum + (o.actual?.timing_ms.total ?? 0), 0) / Math.max(1, total);

  const lines: string[] = [];
  lines.push('# Evaluation results');
  lines.push('');
  lines.push(`Generated by \`npm run eval\` against the pinned anchor date **${ANCHOR_TODAY}**.`);
  lines.push('Every number below is computed, not hand-written.');
  lines.push('');
  if (!hasKey) {
    lines.push(
      '> **TC tier did not run** — `ANTHROPIC_API_KEY` was not set. Deterministic and OCR',
      '> tiers are evaluated in full; documents that would escalate to the dual-VLM call',
      '> abstain instead. Re-run with a key for the complete picture.',
      '',
    );
  }

  lines.push('## Headline');
  lines.push('');
  if (at80) {
    lines.push(
      `**${pct(at80.coverage)} of documents clear with zero human touch, at ${pct(at80.accuracy)} accuracy on those, at $${(totalCost / total).toFixed(4)} per document.**`,
    );
  } else {
    lines.push(
      `Coverage did not reach ${pct(TARGET_COVERAGE)} at any confidence threshold. ` +
        'The curve below shows where it does land.',
    );
  }
  lines.push('');
  lines.push(`- Documents: **${total}**`);
  lines.push(`- Overall accuracy (all documents, abstentions count as unanswered): **${pct(correct / total)}**`);
  lines.push(`- Answered (AUTO_PASS or AUTO_FAIL): **${answered.length}** — coverage ${pct(answered.length / total)}`);
  lines.push(
    `- Accuracy on answered: **${answered.length ? pct(correct === 0 ? 0 : answered.filter((o) => o.correct).length / answered.length) : 'n/a'}**`,
  );
  lines.push(`- Abstained to REVIEW: **${abstained}** — abstention rate ${pct(abstained / total)}`);
  lines.push(`- **Confident and wrong: ${confidentlyWrong.length}** ← the only truly bad outcome`);
  lines.push(`- Confident and right: ${confidentlyRight.length}`);
  lines.push('');

  lines.push('## Accuracy at coverage');
  lines.push('');
  lines.push('| Threshold | Coverage | Accuracy on covered | Confidently wrong |');
  lines.push('|---|---|---|---|');
  for (const p of curve) {
    lines.push(
      `| ${p.threshold.toFixed(2)} | ${pct(p.coverage)} | ${pct(p.accuracy)} | ${p.confidentlyWrong} |`,
    );
  }
  lines.push('');
  lines.push(
    'This curve is what the routing thresholds should be derived from, rather than picked',
    'as round numbers (§9).',
  );
  lines.push('');

  lines.push('## Tier hit distribution — the cost story');
  lines.push('');
  lines.push('| Tier | Documents | Share | Mean latency | Mean cost |');
  lines.push('|---|---|---|---|---|');
  for (const [tier, group] of [...byTier.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const meanMs = group.reduce((s, o) => s + (o.actual?.timing_ms.total ?? 0), 0) / group.length;
    const meanUsd = group.reduce((s, o) => s + (o.actual?.cost_usd ?? 0), 0) / group.length;
    lines.push(
      `| ${tier} | ${group.length} | ${pct(group.length / total)} | ${meanMs.toFixed(0)} ms | $${meanUsd.toFixed(4)} |`,
    );
  }
  lines.push('');
  lines.push(`Mean latency across all documents: **${meanLatency.toFixed(0)} ms**.`);
  lines.push(`Total spend for the whole corpus: **$${totalCost.toFixed(4)}**.`);
  lines.push('');

  lines.push('## Routing');
  lines.push('');
  lines.push('| Decision | Count | Share |');
  lines.push('|---|---|---|');
  for (const [decision, count] of byDecision.entries()) {
    lines.push(`| ${decision} | ${count} | ${pct(count / total)} |`);
  }
  lines.push('');

  if (confidentlyWrong.length > 0) {
    lines.push('## Confident and wrong');
    lines.push('');
    lines.push('These are the failures that matter. Each one auto-cleared with a wrong answer.');
    lines.push('');
    lines.push('| Document | Confidence | Tier | What went wrong |');
    lines.push('|---|---|---|---|');
    for (const o of confidentlyWrong) {
      lines.push(
        `| \`${o.expected.filename}\` | ${o.actual!.confidence.toFixed(2)} | ${o.actual!.evidence.source_tier} | ${o.reason} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Per-document');
  lines.push('');
  lines.push('| Document | Expected | Actual | Decision | Conf | Tier | Result |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const o of outcomes) {
    const exp = o.expected.expected_date ?? `(none, ${o.expected.expected_basis})`;
    const act = o.actual
      ? (o.actual.validity.date ?? `(none, ${o.actual.validity.basis})`)
      : 'ERROR';
    lines.push(
      `| \`${o.expected.filename}\` | ${exp} | ${act} | ${o.actual?.decision ?? '—'} | ${
        o.actual?.confidence.toFixed(2) ?? '—'
      } | ${o.actual?.evidence.source_tier ?? '—'} | ${o.correct ? 'OK' : `MISS — ${o.reason}`} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
