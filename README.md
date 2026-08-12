# KYC Document Expiry Extraction

Upload a KYC document, get back a **verdict** — not a date.

> **Headline:** the deterministic + OCR tiers alone — no API key, **$0 cost** — clear
> **51.4% of documents with zero human touch at 100% accuracy on those**, and **zero
> confident errors** across the whole corpus. Turning on the paid VLM tier
> (`claude-sonnet-5` by default) doesn't mechanically add coverage on top of that (see
> [Results](#results) for why); its payoff is on the 3 documents the deterministic tiers
> have no information about at all, at **$0.0032 per document** averaged across the full
> corpus. A Stage -1 admission gate ahead of all of this rejects out-of-domain input
> before it costs a tier at all — 4/7 adversarial documents terminate outright, and 7/7
> never reach the paid tier. Reproduce any of this with `npm run eval`.

---

## The insight this is built around

The literal ask is "extract the expiry date". Three things make that the wrong problem:

1. **The expiry label is not knowable in advance.** "Expiry date", "ends on", "till date",
   or no label at all. A label-matching or regex-only solution is *structurally* incapable
   of satisfying this. A regex tier is a fine **first** tier; it is not the answer.

2. **Most of this data is already machine-readable and should never be OCR'd.** The PDF417
   barcode on the back of every AAMVA-compliant North American licence carries the expiry
   under a fixed element ID. Every ICAO-compliant passport carries it at a fixed offset in
   the MRZ, with check digits. The per-state variation that makes this look hard applies to
   the printed **front**, not the barcode. Reading the machine-readable region first is both
   the cheapest and the most accurate path — and it is self-validating.

3. **With no human in the loop, the hard problem is not extraction accuracy — it is knowing
   when the extraction is wrong.** A system that is 95% accurate with no abstention path is
   unusable in KYC. One that is 90% accurate with a calibrated review route is shippable.

And the output is not a date at all. In KYC, different document classes are validated by
different rules — a bank statement has no expiry date, yet it is a KYC document. So the
response is a **verdict plus the basis it was reached on**:

| Class | Basis | Rule |
|---|---|---|
| Driver's licence, passport, national ID | `EXPIRY_DATE` | Must be unexpired at submission (31 CFR 1020.220) |
| Utility bill | `RECENCY_WINDOW` | Dated within 90 days (FATF Rec. 10; UK JMLSG, EU AMLD) |
| Bank statement | `RECENCY_WINDOW` | Commonly 180 days in practice |
| Medical insurance card | `COVERAGE_END` | Coverage period end; frequently unlabelled |
| Employment letter | `NO_EXPIRY` | No expiry semantics — **abstain**, do not select a termination date |

---

## Architecture

A **tiered router**, not a single extractor. Cheap deterministic paths first; the expensive
path fires only when the cheap ones abstain.

```
client: full-res PDF417 + MRZ decode attempt      (G2 — see docs/DECISIONS.md)
        downscale to fit the 4.5 MB body limit
                        │
              ┌─────────▼──────────┐
              │ T0  normalize      │  magic bytes, EXIF, HEIC/PDF,
              │     + classify     │  quality metrics, orientation
              └─────────┬──────────┘
              ┌─────────▼──────────┐
              │ Stage -1 admission │  pixel stats + ≤1 cheap OCR presurvey
              │ gate (docs §8)     │  REJECT · ADMIT_LIMITED · ADMIT_FULL
              └─────────┬──────────┘
                REJECT ──┴── terminal, no tier below ever runs → REJECTED
                        │  ADMIT_LIMITED / ADMIT_FULL
        ┌───────────────┼───────────────┐
   ┌────▼─────┐   ┌─────▼─────┐   ┌─────▼──────┐
   │ TA  MRZ  │   │ TA PDF417 │   │ (no machine│
   │ ICAO9303 │   │  AAMVA    │   │  readable  │
   │ +checkdig│   │ +version  │   │  region)   │
   └────┬─────┘   └─────┬─────┘   └─────┬──────┘
        └───────────────┴───────────────┘
                        │  abstain?
              ┌─────────▼──────────┐
              │ TB  layout OCR     │  label lexicon + AAMVA
              │     + label map    │  printed codes 4a/4b/3
              └─────────┬──────────┘  always emits grounding tokens (G5)
                        │  abstain? (never reached if gate said ADMIT_LIMITED)
              ┌─────────▼──────────┐
              │ TC  dual-call VLM  │  Hunter ∥ Mapper
              └─────────┬──────────┘
              ┌─────────▼──────────┐
              │ constraint engine  │  eliminate impossible candidates
              └─────────┬──────────┘
              ┌─────────▼──────────┐
              │ validity rule +    │  class-specific
              │ confidence fusion  │
              └─────────┬──────────┘
      AUTO_PASS · AUTO_FAIL · REVIEW   (+ REJECTED, terminal at the gate above)
```

**Design rule:** every tier can abstain. No tier may return a low-confidence guess to keep
the pipeline moving. Abstention is a first-class return value, not an error.

### The constraint engine is the actual answer

This is the direct response to *"we may or we might not know the labels."* The strategy is
deliberately **not** to recognise the label. Inventory every date on the document, then
eliminate the impossible ones. What survives is the expiry — even when it was never
labelled at all.

**Hard constraints** (violation eliminates a candidate): `expiry > issue` ·
`expiry > DOB + 15y` · `DOB` earliest on an ID · `expiry − issue ≤ 20y` · `issue ≤ today` ·
`expiry ≤ today + 25y`, independent of whether an `issue` date was even found — the
defense-in-depth backstop that keeps an implausible candidate (e.g. a prompt-injected
"2099-01-01") from surviving on documents where no issue date is present to anchor the
per-issuance check.

**Soft signals** (adjust confidence, never eliminate alone): validity period matching a
typical term (4/5/6/8/10y) · expiry month-day equal to DOB month-day, since many US state
licences renew on the holder's birthday · latest date on the page · present in **both**
Hunter and Mapper output · appears verbatim in the raw OCR token stream.

Every elimination carries a human-readable reason, and the UI's **"why?" panel** shows
them. Making the reasoning legible instead of magical is the most persuasive thing in the
demo.

### Why the dual VLM call, and why not log-probs

Following *ExtractConf* (arXiv:2606.24420, RobustifAI @ IJCAI-ECAI 2026): on a 55-field
invoice benchmark with a 26% natural failure rate, mean token log-probability reached only
0.705 ROC AUC and collapsed to all-positive at practical thresholds. Verbalized confidence
was 0.692. Self-consistency over 5 samples reached 0.744 — at 5× the cost.

The diagnosis is the useful part: **extraction errors are document-caused, not
model-caused.** A frontier model transcribing OCR noise produces high log-probabilities for
a wrong answer. Log-probs measure a consequence; document quality measures the cause. In
their ablation, OCR-grounding features alone (0.896) beat log-prob features alone (0.880).

So the two VLM calls are deliberately **asymmetric**:

- **Hunter** is field-guided — "extract field X". Under schema-completion pressure it
  produces *something* even when the field is absent, so it **fabricates** on missing fields.
- **Mapper** is document-guided — "list what this document actually contains". It reports
  only what is visually grounded, so it **misses** non-salient fields but rarely invents.

Their failure modes differ, so their **disagreement is informative** in a way that
resampling the same call is not. Cost is fixed at two calls per document. Hunter returning
a value that Mapper's inventory does not contain is the fabrication signature, and it is
penalised below the review floor.

This build ships the Hunter/Mapper pair plus hand-weighted fusion. **The trained fusion
classifier from the paper is not implemented** — it cannot be trained in a weekend. It is
named in the roadmap as the productionization path.

---

## Results

Run `npm run eval` to reproduce (unset `ANTHROPIC_API_KEY` for the deterministic-only row,
set it for the full-pipeline row). Everything below is generated by the harness against the
pinned anchor date 2026-08-09, not hand-written. Full detail in
[`eval/results.md`](eval/results.md), which reflects the full-pipeline (TC-enabled) run.

> These numbers reflect the 35-document corpus (`eval/generate-corpus.ts`) as of commit
> `a709143`, which also carries the matching `eval/results.md`. If a fresh `npm run eval`
> disagrees with this README, trust the fresh run over this page — regenerating these
> numbers is exactly what that command is for, and this page will drift the moment the
> corpus or pipeline changes again without a matching update here.

### Deterministic-only vs full pipeline

| | Deterministic + OCR only (no key) | Full pipeline (TC enabled, `claude-sonnet-5`) |
|---|---|---|
| Answered (`AUTO_PASS`, `AUTO_FAIL`, or `REJECTED`) | 18 — **coverage 51.4%** | 16 — **coverage 45.7%** |
| Accuracy on answered | 100.0% | 100.0% |
| Overall accuracy (abstentions unanswered) | 97.1% | 97.1% |
| Abstained to `REVIEW` | 17 — 48.6% | 19 — 54.3% |
| Confident and wrong | **0** | **0** |
| Cost for the entire corpus | **$0.0000** | $0.1115 ($0.0032/doc) |
| Mean latency | 726 ms | 1443 ms |

Turning TC on does **not** mechanically buy more coverage on this corpus — it actually
costs two documents' worth. Without a key, an `EMPLOYMENT_LETTER` with no dates found at
all short-circuits straight to `NOT_APPLICABLE` / `AUTO_PASS`, because there is nothing to
be wrong about. With TC on, the model actually reads the page, and on
`19_employment_letter_many_dates.pdf` (15 dates, the showcase abstention case) and
`20_employment_letter_non_expiring.pdf`, that read is cautious enough to route both to
`REVIEW` at the same 0.92 confidence instead of auto-clearing blind. The third document in
this class, `21_employment_letter_plain.pdf`, lands on `AUTO_PASS` either way — it
genuinely has nothing on the page to be cautious about, with or without a model reading it.
A fast path that never looked is not more correct than a slower path that did, just less
honest about it.

TC's real payoff is exactly these 3 documents — the only ones where enabling it changes the
outcome at all. Every other document that ends up on `NONE` tier (`13`, `22`–`25`, `31`,
`32`, `35`) does so identically whether or not a key is set: the router only escalates to
TC when TB genuinely abstained rather than merely finding nothing (§5), and two of those
(`31`, `32`) are additionally hard-blocked from ever reaching TC by the admission gate's
`ADMIT_LIMITED` state regardless of budget (docs/DECISIONS.md §8 A3) — a document the gate
isn't confident enough to admit fully never gets the paid tier, confidence-blind escalation
or not.

### Tier hit distribution — the cost story (full pipeline)

| Tier | Documents | Share | Mean latency | Mean cost |
|---|---|---|---|---|
| NONE | 12 | 34.3% | 254 ms | $0.0000 |
| TB_OCR | 10 | 28.6% | 1446 ms | $0.0000 |
| TA_PDF417 | 7 | 20.0% | **52 ms** | $0.0000 |
| TA_MRZ | 3 | 8.6% | 1113 ms | $0.0000 |
| TC_VLM | 3 | 8.6% | 9768 ms | $0.0372 |

7 of the 11 auto-cleared documents resolved on a machine-readable barcode region in
double-digit milliseconds at zero marginal cost (`TA_PDF417`); another 3 decoded a
checksummed MRZ in about a second, also free. TC is the expensive tail — 3 documents, 8.6%
of the corpus, carrying essentially all of the $0.1115 total spend. `NONE`'s 12 documents
split between 4 gate `REJECTED` (no tier ran at all) and 8 that reached extraction tiers
but resolved with no machine-readable signal.

### Deriving the thresholds from the curve

The build ships `AUTO_THRESHOLD = 0.95` and `REVIEW_FLOOR = 0.7`
(`src/types/contract.ts`) — the conservative end of the measured curve below, not round
numbers picked in advance. The full sweep (full pipeline, TC enabled):

| Threshold | Coverage | Accuracy on covered | Confidently wrong |
|---|---|---|---|
| 0.50 – 0.80 | 77.1% | 100.0% | 0 |
| 0.85 – 0.90 | 74.3% | 100.0% | 0 |
| **0.95 – 0.99** | **31.4%** | **100.0%** | **0** |

A `REVIEW` costs a reviewer a minute. An `AUTO_PASS` on a bad document costs a wrong KYC
decision with no recourse. Confident errors are zero at every threshold on this corpus —
error count alone doesn't distinguish where to draw the line; provenance does.

**What separates 0.95 is usually provenance, but not a hard rule.** 10 of the 11 documents
that clear 0.95 do so on a self-validating source (MRZ with passing check digits, PDF417
with intact Reed-Solomon ECC). The 11th (`01_dl_ca_front_only.png`) clears it on `TB_OCR`
alone, at confidence **1.00** on this run — full OCR grounding, an unambiguous single
surviving candidate, and a strong soft-signal score are enough to reach the same ceiling a
checksummed read gets, without a checksum behind it. So 0.95 is *close* to a tier boundary
in this corpus, not an absolute one: nothing stops a sufficiently well-corroborated OCR
read from crossing it, and one already has. Whether the threshold should instead sit at
0.80 — which clears with zero confidently-wrong outcomes at 77.1% coverage, well above the
45.7% shipped headline — is a real question the curve raises rather than settles: it turns
on how much weight "no checksum behind the read" should carry by itself, independent of
measured accuracy on this corpus. That is a policy call, not one this README makes
unilaterally.

This curve is a confidence-only sensitivity sweep — "if coverage were gated on confidence
alone, what would threshold X buy" — used to justify `AUTO_THRESHOLD`. It is not a replay of
the shipped routing policy, so its rows do not reconcile with the headline above. The actual
`route()` decision (`src/engine/confidence.ts`) also forces `REVIEW` on any anomaly or an
`INDETERMINATE` verdict regardless of confidence, and separately auto-passes `NOT_APPLICABLE`
verdicts (the `NO_EXPIRY` classes) at a lower bar (0.70) since there is no wrong-date risk to
guard against. That second path is part of why the headline shows 45.7% coverage rather than
the curve's own 31.4% at 0.95 — `21_employment_letter_plain.pdf` clears at confidence 0.92
through this fast path (its two `NO_EXPIRY` siblings, `19` and `20`, don't — TC's actual read
of those two is cautious enough to route to `REVIEW` instead, see above), while the curve has
no notion of that fast path at all and scores every document on raw confidence alone.

### The corpus is entirely synthetic — read the numbers above accordingly

Every one of the 35 documents in `eval/corpus/` is generated by
[`eval/generate-corpus.ts`](eval/generate-corpus.ts), not sourced from any real document,
real dataset, or real person. §12 of the brief named six candidate real-world sets
(HuggingFace `sugiv/synthetic_cards`, a Kaggle DL set, IDNet, SIDTD, MIDV-500/2020,
dlptest.com); all six sit behind account auth or explicit licence acceptance, which breaks
the requirement that `npm run eval` reproduce these numbers **from a clean clone, with no
credentials** (§16). So none of them are vendored, and there is no cache of real specimens
anywhere in this repo to fall back to — the corpus really is 100% generated, every time.
This is a deliberate, recorded deviation (see `docs/DECISIONS.md` G7), not an oversight.

The sharpest consequence is on Tier A. The same generator that stamps a PDF417 barcode with
a given expiry date and correct Reed-Solomon ECC, or an MRZ band with correct check digits,
is the thing `bwip-js`/the barcode decoder and the MRZ parser then read back. **TA's 100%
accuracy in this corpus is proof the parser correctly implements the AAMVA and ICAO 9303
specs against well-formed input — it is "parser correctness," not a measurement of
real-world barcode/MRZ read rate** against a phone camera's motion blur, glare, print skew,
a worn or scratched card, or a barcode symbol that a real printer rendered slightly out of
spec. Those failure modes exist in the real world and this corpus cannot produce or measure
them, in either direction.

The same caveat applies one level down for TB: its OCR runs against synthetically rendered
text (SVG rasterized through whatever fonts resolve on the machine that generated the
corpus), not a photograph of a printed, laminated card under real lighting. What this corpus
*does* validate end-to-end, honestly, is **logic** — classification, date-format parsing,
the constraint engine's elimination rules, confidence fusion, and abstention discipline —
because those are pure functions of the text/values a tier reports, independent of how
faithfully a real camera would have captured them. That is also precisely the part of this
assignment §11.4 calls out as the actual hard problem, so it is the right thing to have
gotten an honest, reproducible number on.

One thing this repo does **not** contain, despite `dlptest.com` being named above: there is
no folder of real specimen images anywhere in the repository to run as an unscored sanity
check. `docs/DECISIONS.md` G7 names running against a gated real dataset as a documented
*possible future step*, not something already done — so that comparison remains open, not
completed here.

---

## What this deliberately does not do

Stated as conscious exclusions, not oversights.

- **Face match / selfie liveness** — out of scope by agreement; assume it is handled upstream.
- **Full authenticity / forgery detection.** MRZ and barcode check digits give a *tamper
  hint* for free; that is all that is claimed. A failing check digit is reported as a
  finding, never silently repaired.
- **Sanctions / PEP screening, address matching, full CIP workflow.**
- **Any persistence of uploaded documents.** Processed in memory, discarded at response.
- **Non-Latin-script documents** — detected and abstained on, not attempted.
- **Real production identity documents.** The eval corpus is synthetic and generated — see
  [Corpus honesty](#the-corpus-is-entirely-synthetic--read-the-numbers-above-accordingly).

---

## Security and PII

- No document is persisted, and no document pixels are ever returned by the server either
  — evidence is a label, a text snippet, and normalized bbox coordinates only. There is no
  crop endpoint, no shared store, and no inline-image response body to expire (see G1).
- No document content in logs. Metrics, tier decisions and reason codes only — never
  extracted values, never raw OCR text.
- CRM emission (§9) carries the same posture one layer out: `crm_payload` is built only
  from the decision itself — a decision code, a date, a confidence, reason codes — never
  a document pixel, snippet, or crop. A gate `REJECTED` document is excluded entirely,
  by design: junk that never entered the review queue must not create CRM noise either.
- All document text is treated as untrusted **data**, never as instruction. The real
  defence against an injected date is not prompt hardening — it is grounding every VLM
  value against the raw OCR token stream, so a value that is not physically on the page
  cannot survive.
- Rate limited by IP.
- **The production note that matters:** real KYC documents cannot be sent to a public model
  API. This demo uses a hosted VLM because the corpus is synthetic. Production requires
  self-hosted inference — and at volume, self-hosted VLM OCR on mid-tier GPUs is now
  cheaper per page than managed APIs, so the compliance path and the cost path point the
  same direction. Candidate open-weight models: dots.ocr, DeepSeek-OCR, PaddleOCR-VL.

---

## Running it locally

Under five minutes from a cold start. **No API key is needed** for anything except the TC
dual-VLM tier — the deterministic tiers, OCR tier, constraint engine, routing, UI and the
entire 332-test suite all run without one.

### Requirements

| | |
|---|---|
| Node.js | **20 or newer** (developed on 25.x) |
| npm | 10+ |
| Disk | ~600 MB for `node_modules` (sharp and tesseract.js ship platform binaries) |
| OS | macOS, Linux, or Windows via WSL |

No Docker, no database, no external services.

### First run

```bash
# 1. Install. Takes a few minutes — sharp and tesseract.js compile/download binaries.
npm install

# 2. Environment. Works with an empty key; fill it in to enable the TC tier.
cp .env.example .env.local

# 3. Generate the 35-document eval corpus.
#    REQUIRED — the corpus is NOT included in the repo. It is generated deterministically
#    (byte-identical every run), so shipping it would be redundant weight. This also
#    populates the sample documents the UI's one-tap buttons load.
npm run generate:corpus

# 4. Start it.
npm run dev
```

Open **http://localhost:3000**. The six sample-document buttons work immediately — no
upload needed. Start with *Driver's licence (back)*, which resolves through the barcode
path in single-digit milliseconds at zero cost, then *Employment letter*, which correctly
refuses to pick any of its 15 dates.

### Verifying it

```bash
npm test                # 332 unit tests. No network, no API key. ~7 s.
npm run eval            # full pipeline over all 35 documents -> eval/results.md
npm run build           # production build
```

`npm run eval` regenerates `eval/results.md` from scratch. Every number in the Results
section above comes from that file — nothing in this README is hand-written.

### Enabling the TC dual-VLM tier

Put a key in `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then re-run `npm run eval`. Without a key the harness prints a warning, skips TC, and the 3
documents that would have escalated abstain (or, for one of them, fast-path auto-pass)
instead — the run still completes and every other tier is evaluated in full. A key does not
mechanically raise the headline coverage number on this corpus (see [Results](#results) for
why); what it buys is an actual grounded read on those 3 documents instead of a blind
short-circuit, which matters most on the ones deterministic tiers cannot resolve at all.

Cost for a full eval run with a key is measured, not estimated, at **~$0.11** for this
35-document corpus at claude-sonnet-5 pricing, the default model (2 calls per escalated
document; the harness reports actual spend computed from `usage`). See
`eval/results.md`'s "Total spend" line for the exact figure from your run.

#### Comparing VLM models

`ANTHROPIC_VLM_MODEL` overrides the default (`claude-sonnet-5`) for TC's two calls, so
comparing a different model is a rerun, not a code change:

```bash
ANTHROPIC_VLM_MODEL=claude-opus-5 npm run eval
```

Sonnet 5 wasn't the starting choice — this build shipped on `claude-opus-5` first, on the
reasoning that TC only ever sees the hardest documents (everything the deterministic/OCR
tiers already gave up on), so it seemed to warrant the most capable model available. On
this 35-document corpus, `claude-sonnet-5` and `claude-opus-5` now produce **identical
decisions on every single document** — same 45.7% coverage, same 97.1% overall accuracy,
**zero confidently-wrong outcomes on either model** — so the comparison comes down entirely
to cost and latency: Sonnet at **38.6% lower total spend** ($0.1115 vs $0.1817) for the same
3 escalated documents, at essentially the same mean TC latency (9.8s vs 9.8s — a wash on
this corpus, not the gap a slower/faster narrative would suggest). The default was switched
on that basis. TC's absolute dollars are small either way given how rarely it fires, so the
point of running this side by side wasn't the money — it was not assuming the most expensive
model is the right one without measuring, the same way `AUTO_THRESHOLD` is derived from the
accuracy-at-coverage curve rather than picked as a round number.

### Enabling CRM emission

Every non-`REJECTED` `/api/extract` response always carries a `crm_payload` — a compact,
HubSpot-shaped (`properties` + `associations`) summary of the verdict, never document
pixels or raw extracted text. Nothing is sent anywhere until a webhook URL is configured;
until then `crm_delivery.status` reads `not_configured` and the payload just sits in the
response body for inspection. Point it at the bundled mock receiver to see a real round
trip locally:

```
CRM_WEBHOOK_URL=http://localhost:3000/api/mock-crm-webhook
```

Upload any document and check the server console — the receiver logs what it got and
`crm_delivery.status` in the response flips to `sent`. A gate `REJECTED` document emits
nothing at all (no payload, no POST, log only) — see docs/DECISIONS.md §9 for why that
mirrors the admission gate's own asymmetry rule one layer out. `CRM_OBJECT_TYPE` and the
association env vars (`.env.example`) let the property/object naming match a real CRM
without touching code — see `src/pipeline/crm.ts`.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot find module` on first run | `npm install` did not finish. Re-run it. |
| Eval says every document is `NONE` / abstains | The corpus was not generated. Run `npm run generate:corpus`. |
| Sample buttons say "not bundled in this build yet" | Same — `npm run generate:corpus` populates `public/samples/`. |
| `DOMMatrix is not defined` | A `pdfjs-dist` import bypassing the legacy build. The code already uses `pdfjs-dist/legacy/build/pdf.mjs`; this only appears if that import is changed. |
| Eval numbers differ from this README | Expected either way — see the deterministic-only vs full-pipeline rows in [Results](#results); which one your run matches depends on whether `ANTHROPIC_API_KEY` is set. Within either mode, numbers should match exactly; the anchor date is pinned to 2026-08-09 so results do not drift with the calendar. |
| Tesseract writes into the repo root | Set `TESSERACT_CACHE_PATH` in `.env.local`. Defaults to the OS temp directory. |
| `crm_delivery.status` stays `failed` | Confirm `CRM_WEBHOOK_URL` is reachable from the server process — a typo'd path (e.g. missing `/api/mock-crm-webhook`) fails the same way a real outage would, by design (§9 C4). |

### Deploying

Targets Vercel with zero configuration — it is a stock Next.js App Router project.

```bash
npx vercel            # preview
npx vercel --prod     # production
```

Set `ANTHROPIC_API_KEY` in the Vercel project's environment variables. The extract route
pins `runtime = 'nodejs'` (not Edge) because the barcode, MRZ, OCR and image libraries all
need Node APIs, and `next.config.ts` marks them as server-external so the bundler leaves
their native and WASM assets alone.

`GET /api/health` is a liveness probe (`{status, timestamp}`, no external calls — it never
spends money). `GET /api/version` returns the deployed commit (`VERCEL_GIT_COMMIT_SHA`,
set automatically by Vercel; falls back to `git rev-parse HEAD` in local dev) and the
environment (`VERCEL_ENV`), so a deployment is auditable from the outside.

---

## Roadmap

Ordered by expected value.

1. **Trained confidence fusion.** Replace the hand-weighted score with a learned classifier
   over the same signals (the paper reaches 0.928 AUC vs 0.705 for log-probs alone). The
   signals are already computed and logged; only the fusion is hand-tuned.
2. **Self-hosted inference.** Required for real documents; also cheaper at volume.
3. **Durable cost cap and idempotency** via Redis/KV — currently per-instance and
   best-effort because serverless functions share no state (G4).
4. **Template library** for high-volume issuers, to lift more documents into the TB tier
   and off the VLM path entirely.
5. **Human review queue UI** — the abstention path currently ends at a reason code; the
   thing that consumes it is out of scope here.

---

## Documentation

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every `[DECIDE]` resolved, all twelve
  deviations from the spec with reasoning, library-level findings, and known limits.
- [`docs/BRIEF.md`](docs/BRIEF.md) — the original specification.
- [`docs/EDGE_CASES.md`](docs/EDGE_CASES.md) — the §11 catalogue, each row marked handled
  in code or documented out of scope.

### Two findings worth reading

**`aamva-parser` produces a false `AUTO_FAIL` on Canadian licences.** Given a genuine
Ontario card valid until 2029 (`DBA20290228`, CCYYMMDD per `DCG=CAN`), the library returns
`Sat Aug 29 0229` and `isExpired() === true`. With no human in the loop that is not a
review — it is a confident rejection of a valid document. This build owns the `DCG` branch
and consumes only `getVersion` from the library.

**The brief's own century rule reintroduces the trap it exists to correct.** §4.2 says "for
expiry, always resolve to the future", which turns an expired 2019 passport into a 2119
one and passes it — the same error as "discard past dates", relocated into the date parser.
Corrected, with tests pinning both directions.
