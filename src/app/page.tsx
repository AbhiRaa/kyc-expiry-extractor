'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ResultPanel from '@/components/ResultPanel';
import UploadZone, {
  prepareUpload,
  UploadPrepError,
  type PreparedUpload,
} from '@/components/UploadZone';
import { SAMPLE_DOCS, sampleFileName, type SampleDoc } from '@/lib/sample-docs';
import type { ExtractionResponse } from '@/types/contract';
import type { GateCorpusCheckResult } from '@/types/gate-check';
import styles from './page.module.css';

const ENDPOINT = '/api/extract';
const GATE_CHECK_ENDPOINT = '/api/eval-gate';

/**
 * Client-side abort. The pipeline budget is 45 s (contract `PIPELINE_BUDGET_MS`);
 * this sits above it so a server that is *working* is never killed by the client,
 * while a server that has genuinely gone away still produces a readable message
 * instead of a spinner that never stops.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Pipeline stages, shown as a progress list while the request is in flight (§10 —
 * "loading state that shows pipeline progress").
 *
 * These are advanced on a timer, not by server events: `/api/extract` is a single
 * request/response and adding streaming for a progress bar would be tail wagging
 * dog. The timings come from the tier cost profile in the brief, and the list is
 * labelled "estimated" so it never pretends to be telemetry — the *real* per-stage
 * numbers are in `timing_ms` and are rendered in the result panel afterwards.
 * The last stage stays active until the response actually lands.
 */
const STAGES: readonly { key: string; label: string; atMs: number }[] = [
  { key: 'upload', label: 'Uploading document', atMs: 0 },
  { key: 'normalize', label: 'Normalize and classify', atMs: 900 },
  { key: 'tier-a', label: 'Deterministic read — MRZ check digits, PDF417 barcode', atMs: 2000 },
  { key: 'tier-b', label: 'Layout OCR with label matching', atMs: 4500 },
  { key: 'tier-c', label: 'Vision model, grounded against the raw OCR tokens', atMs: 8000 },
  { key: 'engine', label: 'Constraint engine — eliminating candidates', atMs: 13000 },
  { key: 'route', label: 'Confidence fusion and routing', atMs: 16000 },
];

type Status = 'idle' | 'busy' | 'done' | 'error';

/** Tone class for a sample's status dot. */
const SAMPLE_DOT: Record<SampleDoc['tone'], string> = {
  ok: styles.dotOk,
  bad: styles.dotBad,
  warn: styles.dotWarn,
  neutral: styles.dotNeutral,
  accent: styles.dotAccent,
};

/* --------------------------------------------------------------------------
 * Icons. Inline rather than an icon dependency: there are five of them in the
 * whole app and each is a dozen bytes of path data, sized and stroked to match
 * the v2 line weight (1.4–2.2px against a 24px viewBox).
 * -------------------------------------------------------------------------- */

function ShieldCheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M9 12l2 2 4-4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AwaitingIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.5 12h7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9 9l6 6M15 9l-6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Turn anything a failed request produced into one readable sentence.
 *
 * §10 requires an error state that never surfaces a stack trace, and this is the
 * chokepoint that guarantees it: nothing reaches the DOM except a string that
 * passed through here. Multi-line payloads and anything shaped like a stack frame
 * are dropped in favour of the caller's fallback rather than trusted.
 */
function safeMessage(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  if (!firstLine || firstLine.length > 200) return fallback;
  if (/\s+at\s+\S+\s*\(/.test(firstLine)) return fallback;
  if (/^[A-Za-z]*Error:/.test(firstLine)) return fallback;
  return firstLine;
}

/** Minimal shape check. A 200 from something that is not our API is still a failure. */
function looksLikeResponse(value: unknown): value is ExtractionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExtractionResponse>;
  return (
    typeof candidate.decision === 'string' &&
    typeof candidate.validity === 'object' &&
    candidate.validity !== null &&
    Array.isArray(candidate.all_dates_found)
  );
}

/** Same idea as `looksLikeResponse`, for the corpus-check response instead. */
function looksLikeGateCheckResult(value: unknown): value is GateCorpusCheckResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GateCorpusCheckResult>;
  return (
    typeof candidate.documentsChecked === 'number' &&
    typeof candidate.adversarialTotal === 'number' &&
    typeof candidate.containedCount === 'number'
  );
}

/**
 * The demo (§10), in the v2 shell: a persistent rail carrying every input, and a
 * canvas carrying exactly one of four states — awaiting, processing, error,
 * verdict.
 *
 * It is a client component in full: the page is a single interactive form whose
 * every byte of state (selected file, in-flight request, result) lives in the
 * browser, and there is nothing to render on the server. That is also the §15
 * position expressed structurally — the document is prepared in the browser,
 * POSTed once, and never persisted anywhere.
 *
 * What the v2 layout buys, beyond looking like a product: the inputs no longer
 * scroll away under the result. v1 stacked upload → samples → verdict in one
 * column, so firing the second sample meant scrolling back up past the whole
 * output panel. Here the six samples stay put and only the canvas swaps.
 *
 * The mockup's sticky control bar (screen-state / variant / device / theme tabs)
 * is deliberately not implemented. It is scaffolding for previewing the states
 * side by side — every one of those tabs is driven by real state here, and a
 * shipped build that let you fake a verdict would undercut the entire point of
 * the panel underneath it.
 */
export default function Home() {
  const [status, setStatus] = useState<Status>('idle');
  const [prepared, setPrepared] = useState<PreparedUpload | null>(null);
  const [result, setResult] = useState<ExtractionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [pendingSample, setPendingSample] = useState<string | null>(null);
  // Deliberately separate from result/status: a structurally different result (a corpus
  // summary, not a single document's verdict) that must stay triggerable whether or not a
  // document has ever been extracted — see docs/DECISIONS.md's live gate-check entry.
  const [gateCheckStatus, setGateCheckStatus] = useState<'idle' | 'busy' | 'done' | 'error'>(
    'idle',
  );
  const [gateCheckResult, setGateCheckResult] = useState<GateCorpusCheckResult | null>(null);
  const [gateCheckError, setGateCheckError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLElement>(null);

  const busy = status === 'busy';

  // Drive the estimated-progress list. The counter is zeroed by the submit handler
  // rather than here — setting state in an effect body causes a cascading render.
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [busy]);

  // On a phone the canvas sits below the rail, so a verdict lands off-screen.
  // Bring it into view once. (On desktop the canvas is already beside the rail and
  // this is a no-op scroll.)
  useEffect(() => {
    if (status === 'done' && canvasRef.current) {
      canvasRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [status]);

  const submit = useCallback(async (upload: PreparedUpload) => {
    setPrepared(upload);
    setResult(null);
    setError(null);
    setElapsed(0);
    setStatus('busy');

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const body = new FormData();
      body.append('file', upload.file, upload.file.name);

      const response = await fetch(ENDPOINT, {
        method: 'POST',
        body,
        signal: controller.signal,
      });

      // The endpoint may not be deployed yet — that must read as a clear message,
      // not as a JSON parse exception.
      if (response.status === 404) {
        throw new UploadPrepError(
          `The extraction API is not available in this build (POST ${ENDPOINT} returned 404).`,
        );
      }
      if (response.status === 413) {
        throw new UploadPrepError(
          'The server rejected the upload as too large. Try a smaller photo or fewer PDF pages.',
        );
      }
      if (response.status === 429) {
        throw new UploadPrepError('Rate limited. Wait a moment and try again.');
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new UploadPrepError(
          `The server returned ${response.status} without a JSON body. The API may still be deploying.`,
        );
      }

      const payload: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof payload === 'object' && payload !== null
            ? (payload as { error?: unknown; message?: unknown }).error ??
              (payload as { message?: unknown }).message
            : null;
        throw new UploadPrepError(
          safeMessage(message, `The document could not be processed (HTTP ${response.status}).`),
        );
      }

      if (!looksLikeResponse(payload)) {
        throw new UploadPrepError(
          'The server replied with a response this build does not recognise.',
        );
      }

      setResult(payload);
      setStatus('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('That took too long and was cancelled. Try again, or try a smaller file.');
      } else if (err instanceof UploadPrepError) {
        setError(err.message);
      } else if (err instanceof TypeError) {
        // fetch() only throws TypeError for network-level failures.
        setError('Could not reach the server. Check your connection and try again.');
      } else {
        setError('Something went wrong processing that document. Try again.');
      }
      setStatus('error');
    } finally {
      window.clearTimeout(timeout);
      setPendingSample(null);
    }
  }, []);

  const onFile = useCallback(
    (upload: PreparedUpload) => {
      void submit(upload);
    },
    [submit],
  );

  const onUploadError = useCallback((message: string) => {
    setError(message);
    setStatus('error');
    setPrepared(null);
  }, []);

  /**
   * Load a curated eval document in one tap (§10). The sample files are static
   * assets populated by another track, so a missing file is an expected state and
   * gets its own message rather than a broken image or an unhandled rejection.
   */
  const loadSample = useCallback(
    async (doc: SampleDoc) => {
      setPendingSample(doc.id);
      setError(null);
      try {
        const response = await fetch(doc.path, { cache: 'force-cache' });
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok || contentType.startsWith('text/html')) {
          throw new UploadPrepError(
            `The “${doc.label}” sample is not bundled in this build yet. Upload your own document instead.`,
          );
        }
        const blob = await response.blob();
        if (blob.size === 0) {
          throw new UploadPrepError(
            `The “${doc.label}” sample file is empty. Upload your own document instead.`,
          );
        }
        const file = new File([blob], sampleFileName(doc), { type: doc.mime });
        const upload = await prepareUpload(file);
        await submit(upload);
      } catch (err) {
        setError(
          err instanceof UploadPrepError
            ? err.message
            : `Could not load the “${doc.label}” sample. Upload your own document instead.`,
        );
        setStatus('error');
        setPendingSample(null);
      }
    },
    [submit],
  );

  /** Runs the real admission gate against the real 35-document eval corpus, live,
   *  server-side — $0 cost, since /api/eval-gate never constructs a VLM client at all
   *  (docs/DECISIONS.md's live gate-check entry). Independent of document-extraction
   *  state on purpose: someone should be able to verify the gate's numbers whether or not
   *  they have uploaded anything yet. */
  const runGateCheck = useCallback(async () => {
    setGateCheckStatus('busy');
    setGateCheckError(null);
    try {
      const response = await fetch(GATE_CHECK_ENDPOINT, { method: 'POST' });

      if (response.status === 429) {
        throw new UploadPrepError('Too many live checks. Wait a few minutes and try again.');
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new UploadPrepError(
          `The server returned ${response.status} without a JSON body.`,
        );
      }

      const payload: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof payload === 'object' && payload !== null
            ? (payload as { error?: unknown }).error
            : null;
        throw new UploadPrepError(
          safeMessage(message, `The live check failed (HTTP ${response.status}).`),
        );
      }

      if (!looksLikeGateCheckResult(payload)) {
        throw new UploadPrepError('The server replied with a response this build does not recognise.');
      }

      setGateCheckResult(payload);
      setGateCheckStatus('done');
    } catch (err) {
      setGateCheckError(
        err instanceof UploadPrepError ? err.message : 'Could not reach the server. Try again.',
      );
      setGateCheckStatus('error');
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setResult(null);
    setError(null);
    setPrepared(null);
  }, []);

  const activeStage = Math.min(
    STAGES.length - 1,
    STAGES.reduce((acc, stage, index) => (elapsed >= stage.atMs ? index : acc), 0),
  );

  return (
    <div className={styles.shell}>
      <div className={styles.frame}>
        {/* ---------------------------------------------------------- rail ---- */}
        <aside className={styles.rail} aria-label="Document input">
          <div className={styles.brand}>
            <span className={styles.brandMark}>
              <ShieldCheckIcon />
            </span>
            <span className={styles.brandText}>
              <span className={styles.brandName}>Expiry extraction</span>
              <span className={styles.brandSub}>KYC document verdicts</span>
            </span>
          </div>

          <UploadZone onFile={onFile} onError={onUploadError} busy={busy} preview={prepared} />

          <div className={styles.samples}>
            <h2 className={styles.eyebrow}>Or load a sample in one tap</h2>
            <ul className={styles.sampleList}>
              {SAMPLE_DOCS.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    className={styles.sample}
                    onClick={() => void loadSample(doc)}
                    disabled={busy || pendingSample !== null}
                  >
                    <span className={styles.sampleHead}>
                      <span
                        className={`${styles.sampleDot} ${SAMPLE_DOT[doc.tone]}`}
                        aria-hidden="true"
                      />
                      <span className={styles.sampleLabel}>{doc.label}</span>
                      {pendingSample === doc.id ? (
                        <span className={styles.sampleLoading}>loading…</span>
                      ) : null}
                    </span>
                    <span className={styles.sampleWhat}>{doc.demonstrates}</span>
                    <span className={styles.sampleExpected}>{doc.expected}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.gateCheck}>
            <h2 className={styles.eyebrow}>Verify the admission gate, live</h2>
            <button
              type="button"
              className={styles.sample}
              onClick={() => void runGateCheck()}
              disabled={gateCheckStatus === 'busy'}
            >
              <span className={styles.sampleHead}>
                <span className={styles.sampleLabel}>
                  {gateCheckStatus === 'busy' ? 'Running…' : 'Run the eval corpus check'}
                </span>
                {gateCheckStatus === 'busy' ? (
                  <span className={styles.sampleLoading}>~30s, all 35 documents</span>
                ) : null}
              </span>
              <span className={styles.sampleWhat}>
                Runs the real gate against all 35 eval documents, right now — $0 cost, never
                touches the paid model tier.
              </span>
            </button>
            {gateCheckStatus === 'done' && gateCheckResult ? (
              <p className={styles.gateCheckResult}>
                ✓ {gateCheckResult.containedCount}/{gateCheckResult.adversarialTotal} contained
                {' · '}
                {gateCheckResult.rejectedCount}/{gateCheckResult.adversarialTotal} rejected
                {' · '}
                {gateCheckResult.falseRejectCount}/{gateCheckResult.nonAdversarialTotal} false-rejects
                {' · '}${gateCheckResult.spendAvoidedUsd.toFixed(2)} avoided
              </p>
            ) : null}
            {gateCheckStatus === 'error' && gateCheckError ? (
              <p className={styles.gateCheckError}>{gateCheckError}</p>
            ) : null}
          </div>

          <p className={styles.railNote}>
            <strong>No documents are stored.</strong> Files are processed in memory and
            discarded with the response; evidence is returned as coordinates, never as
            pixels.
          </p>
        </aside>

        {/* -------------------------------------------------------- canvas ---- */}
        <main className={styles.canvas} ref={canvasRef}>
          <header className={styles.header}>
            <h1 className={styles.title}>KYC document expiry extraction</h1>
            <p className={styles.tagline}>
              Upload an identity or address document. The answer is not a date — it is a
              verdict, the rule it was reached under, the evidence it was read from, and
              the constraints that eliminated every other candidate.
            </p>
          </header>

          {/* Awaiting input. */}
          {status === 'idle' ? (
            <div className={`${styles.idle} ${styles.fade}`}>
              <span className={styles.idleGlyph}>
                <AwaitingIcon />
              </span>
              <p className={styles.idleTitle}>Your verdict will appear here</p>
              <p className={styles.idleBody}>
                Every tier can abstain. Nothing is answered on a low-confidence guess.
              </p>
            </div>
          ) : null}

          {/* Loading state — the estimated pipeline walk. */}
          {busy ? (
            <section
              className={`${styles.processing} ${styles.fade}`}
              aria-label="Processing"
            >
              <div className={styles.processingHead}>
                <span className={styles.processingPulse} aria-hidden="true" />
                <h2 className={styles.processingTitle}>Processing</h2>
                <span className={styles.processingClock}>
                  {(elapsed / 1000).toFixed(1)}s elapsed
                </span>
              </div>
              <ol className={styles.stages}>
                {STAGES.map((stage, index) => {
                  const state =
                    index < activeStage ? 'past' : index === activeStage ? 'now' : 'next';
                  return (
                    <li
                      key={stage.key}
                      className={`${styles.stage} ${styles[`stage_${state}`]}`}
                    >
                      <span className={styles.stageMarker} aria-hidden="true">
                        <span className={styles.stageDot} />
                        <span className={styles.stageLine} />
                      </span>
                      <span className={styles.stageLabel}>{stage.label}</span>
                    </li>
                  );
                })}
              </ol>
              <p className={styles.stageNote} role="status">
                Stages are estimated — a single request is in flight. Real per-stage
                timings are returned in the response and shown below when it lands.
              </p>
            </section>
          ) : null}

          {/* Error state — one sentence, never a stack trace. */}
          {status === 'error' && error ? (
            <section className={`${styles.error} ${styles.fade}`} role="alert">
              <h2 className={styles.errorTitle}>
                <ErrorIcon />
                That did not work
              </h2>
              <p className={styles.errorBody}>{error}</p>
              <button type="button" className={styles.retry} onClick={reset}>
                Start over
              </button>
            </section>
          ) : null}

          {status === 'done' && result ? (
            <div className={styles.fade}>
              <ResultPanel result={result} liveGateCheck={gateCheckResult} />
            </div>
          ) : null}

          <footer className={styles.footer}>
            <p>
              Verdicts are advisory and evaluated in UTC, end-of-day inclusive. Every
              abstention carries machine-readable reason codes rather than a guessed date.
            </p>
            <p>No documents are stored. Nothing on this page outlives the response.</p>
          </footer>
        </main>
      </div>
    </div>
  );
}
