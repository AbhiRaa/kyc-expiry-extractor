# Decision log

Every `[DECIDE]` marker from the brief, every place the implementation deviates from the
spec and why, and the spec ambiguities that had to be resolved to build at all.

This file is the working record. The README summarises it.

---

## 1. Resolved `[DECIDE]` markers

| Marker | Decision | Why |
|---|---|---|
| §7 T0 — gate the pipeline on a quality pre-check? | **Attempt always; surface quality metrics in the response.** | The brief's own recommendation. Rejecting before spending saves nothing measurable at these volumes, and the metrics demo well. |
| §7 TC — model choice | **`claude-sonnet-5`**, structured outputs enforced via `output_config.format`. Started on `claude-opus-5`; switched after measuring both on this corpus (README, "Comparing VLM models"). | High-resolution vision (2576px long edge) keeps MRZ bands and small print legible, which is the whole failure mode at this tier — that reasoning drove the initial choice of the largest available model. Real per-document cost is computed from `usage` and reported in the eval, so the tier table stays honest; once real spend data existed, it showed the same reasoning didn't require the most expensive model specifically — Sonnet 5 matched accuracy and safety at 42% lower spend. `ANTHROPIC_VLM_MODEL` overrides this for anyone who wants to re-run the comparison. |
| §9 — confidence thresholds | **Ship 0.90 / 0.70, then re-derive from the measured accuracy-at-coverage curve.** | §9 says explicitly that justifying thresholds from the curve is the strongest paragraph in the README, and that round numbers are the weak answer. |
| §13 — TB OCR in-process or hosted? | **In-process (`tesseract.js`).** | Cheaper, no extra vendor, no extra failure mode, and it makes the cost argument concrete rather than theoretical. |

---

## 2. Deviations from the spec, and why

Each of these is a place where implementing the brief literally would have produced a
worse system. They are numbered G1–G12 and referenced from code comments.

### G1 — `evidence.crop_url` cannot work on the target runtime

§6 specifies `"crop_url": "/api/crop/<id>"`, described as "ephemeral, in-memory, expires
with the request". Serverless functions are stateless with no shared memory across
invocations, so that URL 404s whenever the follow-up request lands on a different
instance.

**Changed to** `evidence.bbox` only — normalized `[x0, y0, x1, y1]` coordinates, no pixels.
No substitute crop endpoint, and no inline base64 image either: the server never encodes a
document region into the response at all. This is a stronger version of the "no documents
are stored" claim in §15 than either the brief's design or an inline-pixels alternative
would give — not "expires with the request" but "never serialized as pixels in the first
place." The client already holds the original file it uploaded (see `page.tsx`'s
`prepared` state), so the UI renders the label and text snippet from `evidence`, plus the
bbox coordinates, rather than round-tripping pixels back across the network to draw a
highlight the browser could draw itself from data it already has.

### G2 — full-resolution decode conflicts with the upload ceiling

§7 T0.4 says keep a full-resolution copy "for barcode and MRZ decoding, which need the
pixels". §11.1 #11 says downscale client-side to fit the body limit. Both cannot hold:
the platform's 4.5 MB request cap is **infrastructure-level and not configurable**, so a
downscaled upload means the server never receives the pixels the highest-confidence tier
depends on.

**Changed to** a client-side full-resolution decode attempt (PDF417 and MRZ band) before
downscaling, shipping the decoded payload alongside the smaller image. The server treats
that payload as **untrusted input** — it re-parses and re-checksums independently and
never accepts it as a verdict — and falls back to server-side decode when the client
attempt fails.

### G3 — `temperature: 0` returns a 400

§7's TC call settings specify `temperature 0`. Sampling parameters (`temperature`,
`top_p`, `top_k`) are rejected with a 400 on current Claude models; the spec was written
against an older API.

**Changed to** determinism via enforced structured output plus `effort: 'low'`. No
sampling parameters are sent.

### G4 — global cost cap and upload idempotency both require shared state

§11.6 #74 (global cost cap) and §11.1 #14 (same file twice → no duplicate cost) cannot be
implemented on stateless functions.

**Implemented** the parts that are real: a per-request content-hash short-circuit and a
per-instance best-effort counter with a pessimistic pre-flight estimate. The README states
plainly that a durable cap needs Redis/KV and names that as the production path. Claiming
a global cap that does not exist would be worse than documenting the limit.

### G5 — the prompt-injection defence does not fire as specified

§11.5 #66 defends against an injected date by cross-checking VLM output against the raw
OCR token stream (`VALUE_NOT_GROUNDED_IN_OCR`). But OCR only runs in TB, and TC fires
precisely *when TB abstains* — so in the specified design the flagship security case has
no grounding stream to check against.

**Changed to** always producing the OCR grounding token stream before TC runs, including
on TB's abstain path. Costs one OCR pass; without it the defence is decorative.

### G6 — the header dates are wrong

"Sat 9 – Sun 10 Aug 2026": 9 August 2026 is a Sunday and 10 August is a Monday. Corrected
in this repo's copy of the brief.

### G7 — every named eval dataset is access-gated

§12 names HuggingFace `sugiv/synthetic_cards`, a Kaggle set, IDNet, SIDTD and MIDV. All
require account authentication and licence acceptance; several are request-access. §16
requires `npm run eval` to reproduce the published numbers **from a clean clone**, which a
gated download breaks.

**Changed to** generating the entire corpus deterministically in-repo, including real
PDF417 symbols and MRZ bands with correct check digits.

*Tradeoff, stated plainly:* we lose real capture variation, so these numbers measure
**logic** — classification, date semantics, constraint elimination, abstention discipline
— not OCR robustness on camera photographs. We gain exact ground truth that reproduces
forever with no credentials. Running against the gated sets is a documented manual
enrichment step, not a build dependency.

### G8 — the century rule reintroduces the brief's own known trap

§4.2 states: *"for expiry, always resolve to the future."*

This is precisely the error §1 and §11.4 #50 exist to correct. **An expired document's
expiry date is in the past** — that is the exact case the system was built to detect.
Applied literally, an MRZ expiry of `190315` resolves to **2119-03-15** instead of
2019-03-15, and the system returns `VALID` on an expired passport. It is the same mistake
as the rejected verbal answer ("discard past dates"), relocated into the date parser where
it is far harder to see.

**Changed to** resolving a two-digit year to whichever century places the date nearest
today, with `DATE_OF_BIRTH` special-cased so a date of birth can never land in the future.
Both directions are pinned by tests.

### G9 — §11.1 #12 contradicts §11.2 #26

#12 says reject files under 50 KB as `RESOLUTION_TOO_LOW`. #26 says a screenshot is
"usually the *easiest* case — clean pixels". Screenshots routinely compress below 50 KB, so
following both literally rejects the easiest input class in the catalogue.

**Changed to** treating the byte count as a *trigger* for a resolution check rather than a
rejection on its own: reject only when estimated effective DPI is also below 150.

### G10 — the reason-code enum has no entry for hard input rejections

Nothing in §6 covers corrupt file, unsupported type, or password-protected PDF.

**Worked around** rather than unfreezing the contract mid-build: these carried
`CLASS_UNRECOGNIZED` plus a separate machine-readable `kind` discriminant and a
client-safe message. Three codes should be added to the enum in a follow-up.

**Resolved** in the named follow-up: `UNSUPPORTED_TYPE`, `CORRUPT_FILE` and
`ENCRYPTED_PDF` are now real `ReasonCode` members (`src/types/contract.ts`), and
`normalize.ts`'s four call sites for those three `NormalizeFailureKind`s report them
directly instead of falling back to `CLASS_UNRECOGNIZED`. `EMPTY_FILE` and
`RENDER_FAILED` were not part of the named gap and still report `CLASS_UNRECOGNIZED` —
the `kind` discriminant already disambiguates them for a caller that needs to.

### G11 — the document-class taxonomy has no non-US driving licence

`DOCUMENT_CLASSES` offers `US_DRIVERS_LICENSE` but no general driving-licence class, so
the Canadian card in the eval corpus is labelled `OTHER_DOCUMENT` — `US_DRIVERS_LICENSE`
would be factually false. Worth widening the enum.

**Resolved**: added `NON_US_DRIVERS_LICENSE`. `classify.ts`'s `fromPdf417` (T0-F) now
reads AAMVA's `DCG` (issuing country) alongside the `DCA` (vehicle class) check it
already did — a populated `DCA` with `DCG` absent or `USA` is still
`US_DRIVERS_LICENSE`; any other `DCG` is `NON_US_DRIVERS_LICENSE`. Fixing this exposed a
second, independent bug in the same code path: `router.ts` was feeding the classifier
`pdf417Result.checksum_detail` (a human-readable prose string) as `barcodeSample`,
instead of the raw AAMVA element stream. `fromPdf417`'s regex parsing needs one
`<id><value>` element per line — exactly the shape `grounding_tokens` is already built
in — and prose never contains a literal `DCA`/`DCG` element, so the DCA check silently
never matched *any* real decoded barcode in production. Every successfully-decoded DL
was landing in the "no vehicle class" branch and being reported as `US_STATE_ID`. The
constraint engine's `EXPIRY_DATE` basis is identical for both classes (`validity.ts`),
so this never showed up as a wrong verdict — only as wrong metadata — which is likely
why it went unnoticed: there is no router-level integration test exercising a decoded
barcode end-to-end (`classify.test.ts` only unit-tests `classifyDocument` directly with
hand-built signals, bypassing this wiring). Fixed by passing
`grounding_tokens.join('\n')` instead; the eval corpus's Canadian licence
(`06_dl_on_canada_ccyymmdd.png`) now classifies as `NON_US_DRIVERS_LICENSE` end-to-end
via `TA_PDF417`, confirmed by direct pipeline run.

### G12 — §12's stated corpus size disagrees with its own itemised list

§12 asks for "20–25 documents" and then itemises a composition summing to **25**
(6+4+3+3+2+3+2+1+1). Generated 25; it is inside the stated range and covers every named
case.

---

## 3. Library-level findings

### `aamva-parser` mis-parses Canadian dates and produces a false `AUTO_FAIL`

The most consequential finding of the build, and a direct confirmation of §4.1's warning
that getting the `DCG` branch wrong "silently produces valid-looking wrong dates".

Given a genuine Ontario licence valid until 2029-02-28, encoded `DBA20290228` in the
CCYYMMDD order that `DCG=CAN` requires:

```
raw DBA field          -> 20290228   (means 2029-02-28)
library expirationDate -> Sat Aug 29 0229
library isExpired()    -> true
```

The library reads the field as month 20, day 29, year 0228, hands that to `new Date(...)`,
and JavaScript rolls the overflowing month over. Year, month and day are all wrong, and
the value is constructed in local time so the ISO form shifts again.

**Why this is worse than a wrong date:** in a system with no human in the loop this is not
a `REVIEW`, it is a confident `AUTO_FAIL` on a valid document. A legitimate customer is
rejected with no recourse and no signal that anything went wrong.

**Mitigation:** the build consumes only `getVersion` from the library, as a second opinion
on its own header parse. Element extraction scans the record stream directly, and raw
`DBA`/`DBD`/`DBB` strings are resolved by `parseAamvaDate(value, 'USA' | 'CAN')` branching
on `DCG`. A regression test pins the correct result and asserts the library's divergence
*loosely*, so that if a future version fixes the branch the assertion fails and a human
re-reviews the decision rather than the comment quietly becoming untrue.

### An exactly-20-year document fails a naive validity ceiling

20 calendar years is 7305 days, which is **20.0004** average-length years. Comparing
`yearsBetween(issue, expiry) > 20` therefore eliminates every legitimate 20-year document
as `IMPLAUSIBLE_VALIDITY_PERIOD` through a pure rounding artefact. The same trap applies
at the 15-year holder-age floor.

Both constraints now compare against calendar anniversaries. Three regression tests pin
the boundary from both sides.

---

## 4. Other resolved ambiguities

| # | Ambiguity | Resolution |
|---|---|---|
| 1 | AAMVA date order when `DCG` is absent (version 1 cards predate the field) | Resolved **arithmetically**, not guessed: a valid `CCYY` always begins 19/20/21/22 and a valid `MM` never exceeds 12, so the two orderings cannot both yield a real calendar date from the same eight digits. When the card declares an order and the digits contradict it → `AMBIGUOUS_DATE_FORMAT`, no date. |
| 2 | A4 paper and a passport data page are 1.4142:1 vs 1.4205:1 — 0.4% apart | Removed the shape-derived passport class entirely rather than pick a threshold that reliably misclassifies one of them. `PASSPORT` survives only as a hypothesis backed by other evidence. |
| 3 | What counts as `NOT_A_DOCUMENT` | Requires **positive evidence of absence** — a text pass that ran and found nothing, *and* an in-focus page — so a soft-focus passport is never classified as a meme. |
| 4 | Does a failing MRZ checksum still yield a candidate? | **No.** Values appear only in `checksum_detail`. Letting them through at reduced confidence would invite the fusion layer to use a reading we just said we cannot vouch for. |
| 5 | `NO_EXPIRY_SEMANTICS` for any class? | Only for `EMPLOYMENT_LETTER` / `OTHER_DOCUMENT` / `NOT_A_DOCUMENT`. Emitting it for a passport that yielded zero dates would launder a read failure into a clean finding. Everything else gets `NO_DATES_FOUND`. |
| 6 | Hunter returns a value, Mapper *call failed* | **Not** `HUNTER_MAPPER_DISAGREE`. There is no inventory to disagree with, so this is `LOW_TIER_CONFIDENCE`. Disagreement is reserved for Mapper genuinely returning an inventory that lacks the value — the actual fabrication signature. |
| 7 | Is a correct abstention a `REVIEW`? | **No — `AUTO_PASS`.** An employment letter has no expiry; that is a confident right answer. Routing it to a human would spend the review queue on documents that need no review. |
| 8 | No `MALFORMED_RESPONSE` / `REFUSED` reason code exists | A post-retry unparseable body and a `stop_reason: 'refusal'` both map to `MODEL_UNAVAILABLE` — honestly, "this model would not give us a usable answer". |
| 9 | Degraded-document eval labelling | The *true* printed expiry is recorded with verdict `INDETERMINATE`, so a correct abstention scores as coverage lost rather than a date miss, while the truth remains available for the confident-and-wrong table. |

---

## 5. Decisions taken during integration

These came out of running the pipeline end to end, not from reading the spec.

### Candidate ordering must follow source authority, not execution order

The pipeline is cost-ordered: PDF417 first (pixels only, no text extraction), then a
single OCR pass that feeds MRZ band detection, TB label matching and the TC grounding
stream. That means OCR results arrive *before* MRZ results.

Collecting tier results in completion order silently broke provenance. Candidates are
de-duplicated by `(iso, role)` keeping the first occurrence, so when both TB and TA-MRZ
read the same passport expiry, the 0.80 OCR reading was kept and the 0.99 checksum-
validated MRZ reading discarded. Right answer, wrong source, wrong confidence — and a
passport that should have auto-cleared went to the review queue.

Tier results are now assembled in authority order (PDF417 → MRZ → TB → TC) regardless of
when they complete.

### Exact text and OCR text deserve different evidence thresholds

Classification requires two matched keywords, or one with a clear margin, before naming a
class. Applied uniformly, every text-native PDF in the corpus fell through to
`OTHER_DOCUMENT`, which collapsed the validity basis to `UNDETERMINED` and sent correctly
extracted dates to review.

The threshold now depends on provenance. A term matched in a PDF's **embedded text layer**
is certainly on the page; one matched in **OCR output** might be a misread — "statement
period" can fall out of recognition noise in a way it cannot fall out of an embedded font.
Exact text therefore clears on one unambiguous term with no competing class.

### TB matches recency anchors, not just expiry labels

§7's TB lexicon is expiry-only, which is right for identity documents but leaves every
proof-of-address document with no deterministic path: a bank statement carries no expiry
label, so an expiry-only tier abstains on the whole class and escalates it to the VLM.
But §4.3 does not validate those on an expiry — it validates them on a `RECENCY_WINDOW`
anchored to the statement or billing date, and §11.3 #37 says outright to "find the
statement period end, apply the recency rule".

Those labels are as fixed and jurisdiction-independent as the expiry ones, so they belong
in the same deterministic tier. They bind to `STATEMENT_PERIOD_END` rather than `EXPIRY`,
so the constraint engine never applies expiry-shaped reasoning to a statement date. This
moved all three bank statements from "no candidate at all" to correct, at zero cost.

### The auto threshold is derived, not chosen

See the README's "Deriving the thresholds from the curve". The short version: the only
confidently-wrong document sits at confidence 0.93, so 0.90 admits it and 0.95 does not.
Raising the bar to **0.95** costs 16 points of coverage and takes confident errors to zero.
It also means only self-validating sources — MRZ check digits, PDF417 Reed-Solomon ECC —
can auto-clear on their own evidence, which is the architecture's thesis falling out of the
measurement rather than being asserted.

### The WASM decoder must be hidden from the bundler

`npm run build` failed with `Module not found: Can't resolve 'a'` inside zxing-wasm's
generated loader. `serverExternalPackages` did not help, because the failure happens during
**static analysis** rather than at require time: the bundler resolves the literal
`require.resolve('zxing-wasm/reader/zxing_reader.wasm')` and pulls the loader into the build
graph. Assembling the specifier at runtime defeats the analysis and leaves Node to resolve
it normally. A deployment-blocking bug that only surfaces on `next build`, never in tests.

### Glare is not inferred from a page-level clipping ratio

Found by POSTing real documents through the running API rather than by the eval, which
scored decisions and never looked at the reason codes attached to them.

`GLARE_OBSCURES_FIELD` was firing on **every document in the corpus**, including
text-native PDFs, which cannot have flash glare because no camera was involved. The cause:
a document is mostly white paper, so the whole-page clipping ratio sits around 0.93 on a
perfectly clean scan — well past any threshold meant to catch glare.

§11.2 #17 actually specifies detecting luminance clipping **in the extraction region**, and
that distinction is load-bearing: glare is localized by nature, and a page-level average
cannot see it. Detecting it properly needs a region-level metric that is not currently
computed.

The signal is therefore not emitted at all. A reason code that is always present carries no
information and actively misleads a reviewer triaging a queue — worse than its absence.
Blur and effective resolution are genuinely page-level properties and are unaffected.

## 6. Known limits

- **HEIC decode is unproven by test.** sharp's bundled libheif ships no HEVC encoder, so a
  HEIC fixture cannot be generated programmatically. The decode path exists; one real HEIC
  file in the eval corpus would close this.
- **PDF `/Rotate` is untested** — pdfkit cannot set the flag. The code path exists and is
  exercised at rotation 0.
- **`bbox` is null on PDF417 candidates.** The symbol's position is known but an
  element's position *inside* the symbol is not a meaningful crop.
- **MRZ `ISSUE` rarely populates** — TD1/TD2/TD3 do not carry an issue date; it appears
  only on the French/Swiss layouts the same parser covers.
- **`pdfjs-dist` v6 requires the legacy build** under Node 25; the main build throws
  `ReferenceError: DOMMatrix is not defined` at import.
- The confidence weights are **hand-tuned**, not learned. A trained fusion is the
  productionization path — see the roadmap.
- **The admission gate's "absent camera EXIF" signal is a size proxy, not real tag
  parsing** — no Make/Model-reading dependency exists in this codebase, so it checks
  whether sharp's raw `exif` buffer clears a byte-count floor rather than reading actual
  camera tags. A real camera photo's EXIF block is reliably hundreds to thousands of
  bytes; a screenshot's is typically none or trivial — but this also means the eval
  corpus, which is entirely SVG/pdfkit-rendered and carries no EXIF at all by
  construction, can never exercise this signal as a discriminator between "real photo"
  and "screenshot": it reads `true` (absent) on every document in the corpus, in-domain
  and adversarial alike. The chrome-structure check (§8 A3) is the real backstop this
  relies on regardless — see A3 for why a single uniform band is never enough alone.

## 7. UI redesign (v2)

The `KYC UI Redesign v2.dc.html` Design Canvas mockup was implemented over the v1 UI. It
is a mockup, not a spec: it carries preview scaffolding, and it draws three of the four
states the real system can produce. These are the places the implementation departs from
it, and why.

### V1 — the mockup's control bar is not implemented

The mockup opens with a sticky bar of tabs switching screen state (idle / processing /
result / error), result variant (pass / fail / review), device and theme. Every one of
those is driven by real state in the app.

**Not shipped.** It is scaffolding for viewing the states side by side in the canvas. A
build that let a viewer select "pass" from a dropdown would undercut the entire claim of
the panel below it — that the verdict is derived, not chosen.

### V2 — theme follows the OS rather than a toggle

The mockup ships `theme` as a switchable prop defaulting to dark, with a light option.
Both palettes are ported verbatim into `globals.css`.

**Bound to `prefers-color-scheme`** instead of to a control. The design's two themes map
exactly onto the two states the OS already reports, honouring that setting is an
accessibility behaviour v1 had, and it costs no UI. Nothing about the palettes changed.

### V3 — fonts are self-hosted, not fetched from Google

The mockup loads Geist and Geist Mono via `<link>` from `fonts.googleapis.com`.

**Changed to `next/font/google`**, which self-hosts both as static assets and emits no
third-party request at page view. Faster (no render-blocking round trip, no layout shift)
and consistent with §15: a page whose central claim is that nothing about the document
leaves the browser should not open a connection to an ad network's font CDN to say so.

### V4 — `T0` is not shown as capable of abstaining

The mockup's pipeline rail computes each tier's state by index against the tier that
resolved, which renders `T0` (normalize + classify) as "abstained" whenever anything
downstream produced the answer.

**Changed:** `T0`, `CE` and `RT` always render as "ran". None of the three can abstain —
normalization and classification happen on every request, and the constraint engine and
router run on whatever the tiers produced, including nothing.

Related: the rail's per-step states are derived from `evidence.source_tier`, not measured,
because `timing_ms` carries `{ total, normalize, tier }` and no key per tier. The routing
is known exactly; per-tier durations are not, which is why the labels read "abstained" and
"not needed" rather than quoting times they cannot support.

### V5 — `source_tier: NONE` had to be drawn

The mockup has pass, fail and review variants. It has no variant for the case where every
tier abstains and the correct answer is no date — which is the employment-letter path, and
the behaviour the system is most worth showing.

**Extended:** all four tier tiles render "abstained" rather than collapsing to "not
needed" (nothing was skipped — everything was tried), the hero reads `No date` with the
null explained rather than left blank, and the why-panel's claim block flips to its
neutral-toned "Nothing was selected — and that is the answer" variant. Neutral, not green
and not red: an abstention is not a pass and not a failure.

### V6 — collapsibles stay native `<details>`

The mockup implements the date inventory and raw-JSON disclosures as a `<button>` toggling
component state, with a chevron rotated by inline transform.

**Kept as `<details>`/`<summary>`**, with the chevron rotated by CSS off `[open]`. Visually
identical; keyboard operation and screen-reader announcement come free instead of being
hand-rolled with ARIA.

### V7 — the date inventory keeps the columns the mockup dropped

v1 rendered the inventory as a six-column table (status, as read, normalized, label on
document, role, confidence). The mockup's row design carries four fields and drops the
normalized ISO, the verbatim label, and the eliminating constraint.

**Adopted the row design; kept the data.** The three dropped fields moved to a second line
that appears only on rows that have something to say, so a clean row is one line and a
ruled-out row grows to carry its reason. Losing them outright would have been a regression
in the one panel whose stated purpose is to be the complete record — a 40-page bank
statement's transaction dates each need to state what removed them. A list replaced the
`<table>` as a consequence: once rows are two lines of mixed-width content they are not
tabular data, and table markup would promise alignment the layout does not keep.

Also kept from v1 and absent from the mockup: the `Anomalies` fact (an integrity anomaly
forces REVIEW regardless of confidence, so it cannot read as neutral trivia), the
`Show N more ruled-out dates` truncation in the why-panel, and the quieter
`Flags raised (N)` treatment for reason codes on a document that still cleared — a flag is
real but is not a call to action.

### V8 — the processing clock is measured, not promised

The mockup's processing card shows a static `est. 4.2s`. Elapsed time is already tracked to
drive the stage list, so it is shown instead — same slot, same treatment, but a measurement
rather than an estimate the pipeline may not keep. The stage list itself remains explicitly
labelled as estimated, as in v1.

---

## 8. Admission gate (v2) — client feedback rework

Post-submission client review of the delivered v1 system, not brief-driven — its own
`A1…` series, the same pattern `## 7`'s `V1–V8` uses for later, non-brief work.

### A1 — why the gate exists

The client's architectural criticism: there was no gatekeeping. A CRM screenshot, a
wallpaper — junk input flowed through normalization, MRZ, PDF417 and OCR before landing
in `REVIEW`, paying tier cost on noise that was never going to resolve. Their cautionary
example: a chatbot deployment with no input gating that burned tokens answering
off-topic prompts. A new Stage -1 admission gate (`src/pipeline/gate.ts`) runs before any
extraction tier and authorizes a *budget*, not just entry — three-way, not binary:
`REJECT` (confidently out of domain, no tier runs, terminal — `Decision.REJECTED`, a
fourth value distinct from `REVIEW`: `REVIEW` means a human looks, `REJECTED` means it
never enters the queue), `ADMIT_LIMITED` (uncertain — free tiers only, hard-blocked from
ever reaching TC), `ADMIT_FULL` (positive domain signal found — full pipeline eligible).

### A2 — the asymmetry rule

False-rejecting a valid document is worse than wasting an OCR pass, or even a VLM call —
the client's own framing. Encoded as a structural rule, not a tuning knob: **`REJECT` can
only be reached through confident *negative* evidence. It can never be reached merely
through *absence of positive* evidence** — that caps admission at `ADMIT_LIMITED`, never
lower. "I found no proof this is a document" and "I found proof this is not a document"
are different epistemic states, and collapsing them into one path is exactly how a real
document photographed at a bad angle would get silently dropped.

### A3 — three signals, cost-ordered, stop at the first confident rejection

1. **Document-likeness** — pixel statistics only, no OCR. Confident reject
   (`NOT_A_DOCUMENT_IMAGE`) only if no document-shaped quad, no structured text-row bands
   (`rowInkHistogram`/`countTextBands` — pulled out of `estimateSkewAngle`'s own private
   row-binning closure in `normalize.ts` as a standalone, reusable measurement), **and**
   the frame is flat or tonally extreme. Any one weak signal alone is not enough.
2. **Screen-capture detection** — the nuance a CRM screenshot exposes: it *passes*
   signal 1, since it is genuinely text-dense in structured rows. The tell is the
   *conjunction* of screen-native evidence (resolution match, or absent camera EXIF —
   see the Known Limits entry above) **and** genuine application-chrome structure, never
   "is this a screenshot" alone — a legitimate screenshot of a real document is an
   existing, celebrated first-class input path in this codebase (G9) and must never be
   rejected.
3. **Positive domain signal** — the only signal that costs anything: a coarse PDF417
   check on the already-downscaled buffer, then (only if needed) a single cheap
   low-resolution OCR presurvey (`presurveyOcrRunner`, `tier-b-ocr.ts` — not a second
   engine, the same process-wide Tesseract worker fed a smaller image) checking MRZ
   band geometry and a filtered keyword list. A hit → `ADMIT_FULL`. Nothing found →
   `NO_DOMAIN_SIGNAL`, caps at `ADMIT_LIMITED` — never `REJECT`, per A2.

**A real implementation bug, caught by testing against the actual corpus rather than
synthetic fixtures alone, worth recording in full because the failure mode generalizes
beyond this one signal.** The first working version of signal 2 scanned inward from each
edge in thin strips, looking for individual uniform-colour "bands," and treated two
same-edge bands as a stacked pair of distinct UI bars. It shipped broken: a driving
licence's single accent-coloured header contains a title or a state name, and at
strip-level resolution that text reliably fragments one visual band into several small
ones with different local means. The stacked-band count then misread the fragments of
*one* header as *multiple* distinct bars, and every card-shaped document in the corpus —
every driving licence, passport, residence permit, insurance card — started rejecting
with `appChromePresent=true`. A first fix (bridging small positional gaps between
fragments) was insufficient: this scan's own boundary imprecision produces small gaps in
*both* the "real second band" case and the "text-interrupted single band" case, so gap
size alone cannot tell them apart — a genuinely narrow gap between two truly distinct
bars looks identical to a gap produced by nothing more than a mis-aligned strip boundary.

The fix that actually held: **stop measuring at strip resolution at all.** v2 compares
two large, *fixed-size* zones per edge (0–18% and 18–36% of the frame), each spanning
enough area that a modest amount of text or an icon is a small minority of that zone's
pixels and gets averaged away — the same reason a printed page's overall mean is not
thrown off by its own body text. A header with a title on it now reads as one uniform
zone; two genuinely different stacked bars still register as two zones with clearly
different means, because that difference is the actual point of the two bars existing,
not a measurement artefact. Verified directly against the real corpus (not just unit
tests) after the fix: zero false `REJECT`s across every driving licence, passport,
residence permit, and insurance card in the set — the documents that don't find a
positive domain signal correctly fall back to `ADMIT_LIMITED`, per A2, rather than being
rejected. **The general lesson, not specific to this one signal**: a heuristic that looks
correct against a hand-built synthetic test fixture can still be wrong against real
content shaped differently than the fixture assumed — the fixture in `gate.test.ts` that
initially passed was accidentally too clean (a truly flat header colour, no text) to
catch this at all; only running against the actual generated corpus surfaced it.

### A4 — the "hardcoded bounding box" claim: investigated and found false, not assumed

The client separately stated on a call that barcode/MRZ detection uses hardcoded
positions, and asked how the system would find a barcode if a state relocated or
reoriented it. **Checked directly against the code rather than taken on trust**:
`decodePdf417` (`tier-a-pdf417.ts`) already does a full-frame `zxing-wasm` scan with
`tryRotate: true, tryHarder: true` and no region parameter; `estimateMachineReadableZone`
(`tier-b-ocr.ts`) is already geometry-derived from OCR line shape (fixed character
lengths and alphabet ratio), not fixed coordinates. The client confirmed this was their
own misstatement on the call, not a real bug — no fix was written for something that
does not exist. Instead: three new eval documents (a rotated-90° barcode, an off-centre
barcode, an edge-flush barcode — all valid, in-domain licences with real expiry dates)
prove the existing detection holds empirically, not just by code inspection.

### A5 — the gate's keyword list is derived by exclusion, not hand-duplicated

`GATE_KEYWORDS` (`gate.ts`) is `CLASS_KEYWORDS` (`classify.ts`, now exported) filtered
through an exclusion set — `'restrictions'`/`'endorsements'` (classify.ts's own comment
already says these are "worth something only in combination, never alone"),
`'bill date'`/`'total due'`/`'amount due'` (exactly a restaurant receipt's own phrasing),
`'effective date'` (too generic across document types) — rather than a second,
hand-copied list. This is not a style preference: the gate's bare "≥1 hit → admit"
trigger has no margin check behind it, unlike `classifyDocument`'s own threshold logic,
so it needed a stricter list — but `EMPLOYMENT_LETTER` and `MEDICAL_INSURANCE_CARD`
terms must never be dropped, because docs 13/19/20/21 in the eval corpus only resolve
correctly via `TC_VLM` today (no MRZ/barcode, so TB's correct abstention already means
TC must run), and losing those classes' keyword signal would return `NO_DOMAIN_SIGNAL`
on those exact documents, block TC, and regress them. Deriving by exclusion makes that
constraint structural — a future edit to `classify.ts`'s own lexicon propagates
automatically — rather than a maintenance promise, avoiding the exact silent-divergence
risk **G11**'s finding already documents once in this codebase (`checksum_detail` vs. the
raw AAMVA element stream).

### A6 — `DocumentQuad` is threaded through, not recomputed

T0's `finishPage` (`normalize.ts`) already runs `detectDocumentQuad` once per page for
perspective-correction and `DOCUMENT_CROPPED` purposes, but previously discarded the
result afterward. `NormalizedPage` now carries `quad` (captured before correction
consumes it) and `exifBytesLength`, so the gate reuses T0's own detection rather than
paying for a second full-frame quad-detection pass — recomputing it would be a little
ironic for a feature that exists to eliminate redundant compute on documents that were
never going to resolve.

### A7 — containment and reviewer-minutes are separate metrics from rejection, not restatements of it

The eval report (`eval/run.ts`, `eval/results.md`) originally reported one adversarial
number: out-of-domain rejection rate, 4/7. That conflates two different claims and
undersells the gate. **Containment** — did this document ever reach the paid VLM tier —
is 7/7 (100%), not 4/7, because `ADMIT_LIMITED` hard-blocks TC escalation exactly as
completely as `REJECT` does; it just leaves the document in `REVIEW` instead of
terminating it. Computed directly off `cost_usd === 0` per adversarial document rather
than by reasoning about which admission state implies zero spend, so the metric can't
drift out of sync with a future change to what `ADMIT_LIMITED` blocks.

**Human touches avoided**, by contrast, tracks only the `REJECT` count (4, this run) —
`ADMIT_LIMITED` documents still land in `REVIEW` and still cost a reviewer's time, so
they don't belong in a "touches avoided" count even though they're contained on spend.
Converted to reviewer-minutes via `src/lib/reviewer-economics.ts`, using the client's own
stated throughput (20–30 documents/reviewer/day) as the sole input constant, reported as
a range rather than a point estimate — a single number would claim precision the "20–30"
framing itself doesn't have. That module is deliberately factored out of `eval/run.ts`
rather than inlined: it's the same formula the ROI panel (planned UI work) needs, and a
second hand-tuned copy of "minutes per document" living in the UI would silently drift
from this one the first time either got adjusted.

## 9. CRM emission (v2 client rework)

Post-gate client follow-up, not brief-driven — its own `C1…` series, the same pattern
`## 7`'s `V1–V8` and `## 8`'s `A1–A7` already use for later, non-brief work.

### C1 — a side effect of a verdict, not part of it

`buildCrmPayload` (`src/pipeline/crm.ts`) is pure — no I/O, no `fetch`, only a mapping
from an already-final `ExtractionResponse` to a CRM object. `deliverCrmPayload`, the one
impure function in that file, is called from `src/app/api/extract/route.ts` — the
existing I/O boundary, the same place that already decides whether to construct a VLM
client — strictly *after* the verdict is final. The extraction result is correct
regardless of whether the CRM is reachable, so `crm_payload` is always present in the
response body (whether or not `CRM_WEBHOOK_URL` is even set) and delivery failure can
change `crm_delivery`, never the decision or the HTTP status. Same posture a missing
`ANTHROPIC_API_KEY` already has one layer in: the system keeps working when a dependent
service is degraded, it just reports the degradation honestly instead of hiding it.

### C2 — `REJECTED` emits nothing: the gate's asymmetry rule, extended one layer out

A gate `REJECT` (`gateRejectedResponse`, `router.ts`) produces no `crm_payload` and
attempts no delivery — only a `console.log` for server-side observability. This is not
an oversight scoped down from "always emit"; it is the direct extension of §8 A2's
asymmetry rule past the extraction boundary: input confidently out of domain never
occupied a review-queue slot in the first place, so it must not occupy a CRM task slot
either. `REVIEW` (including the pre-gate T0 rejection path, `rejectionResponse`) is
different — a human still has to look at it, so the CRM still needs to know.

### C3 — the idempotency key reuses an existing hash, not a new one

`NormalizedDocument.contentHash` / `NormalizeRejection.contentHash` (`normalize.ts`) —
SHA-256 of the input bytes — already existed for a documented but previously unwired
purpose (§11.1 #14, "lets a caller make repeat uploads free"). `crm_payload.idempotencyKey`
is `kyc-${contentHash}` rather than a freshly minted value: a retried upload of identical
bytes produces the same key on every attempt, so the CRM dedupes instead of opening a
second review task for one physical document, without this codebase computing a second
hash of the same bytes for a second purpose.

### C4 — delivery is bounded and awaited, not truly non-awaited fire-and-forget

The two stated requirements are in real tension: "never blocks or fails the response"
reads as classic fire-and-forget (don't await the POST at all), but reporting `sent` vs.
`failed` synchronously in the same response — not just `queued` — is only possible if the
call *is* awaited. The resolution: `deliverCrmPayload` is awaited, but bounded by a 3s
`AbortController` timeout and wrapped so every outcome (success, non-2xx, network error,
timeout) resolves to a `CrmDeliveryInfo` rather than throwing. "Never blocks" is honored
as "never blocks beyond a short, fixed bound, and never converts a CRM problem into a
5xx" rather than literally "returns before the POST starts" — the latter would have made
`sent`/`failed` unreportable in-band, which the requirement explicitly wanted.

### C5 — HubSpot's properties-plus-associations shape, names centralized not hardcoded

`CrmPayload` (`contract.ts`) mirrors HubSpot's own object-write shape — `properties`
(flat key/value) plus `associations` (links to other objects) — since HubSpot is the
client's primary platform. Property and object-type names live in one exported table,
`CRM_PROPERTY_KEYS` plus three `CRM_*` env vars (`crm.ts`), rather than inline literals
scattered through `buildCrmPayload`'s body — the same reasoning `GATE_KEYWORDS` (§8 A5)
already applies to keyword lists: swapping to a different CRM's naming convention means
editing one table, not hunting through the mapping function. Reason codes map to a
semicolon-joined string, not a JSON array, matching HubSpot's own convention for a
multi-value/checkbox property rather than a shape that happened to be convenient here.

### C6 — associations require a caller-supplied `applicantRef`; empty otherwise

The pipeline is document-in, verdict-out — nothing in this system tracks an applicant or
contact identity on its own, so there is no id to associate a CRM object with unless the
caller supplies one. `RouterInput.applicantRef` (optional, threaded from `route.ts`'s
`applicantRef` form field) becomes the payload's one association when present; omitted,
`associations` is `[]`. This is a known limitation of the payload's usefulness, not a gap
in the shape itself — the same category as the EXIF-presence proxy already recorded in
`## 6. Known limits`: correct within what the system actually tracks today.

### Verification note

Router-level wiring (REJECT → no payload; every other path → payload present, keyed off
the real content hash) is verified by hand against the actual pipeline and real generated
corpus documents, not by a mocked unit test — `eval/corpus/*.png` is gitignored
(deterministically regenerated by `npm run generate:corpus`, never committed), so a test
in `npm test` cannot depend on those files without breaking on a fresh clone that hasn't
run corpus generation yet. `buildCrmPayload` and `deliverCrmPayload` themselves are fully
unit-tested (`src/pipeline/crm.test.ts`) with no such dependency, since neither touches
the filesystem.

## 10. A real document surfaces a date-parsing bug the synthetic corpus never could

Found on a real Indian driving licence uploaded during manual testing, not by the eval
harness — the exact gap §8's own corpus-honesty section already warns about (a synthetic
corpus proves logic, never a real capture's actual failure modes). No PII from the
document is reproduced here; only the shape of the bug.

### D1 — the actual failure: two bugs stacked, not one

The DL prints `Issue Date: 16-02-2023` and `Validity (NT): 02-03-2039` (DD-MM-YYYY,
standard everywhere outside the US). The system returned `INDETERMINATE` with the real
expiry nowhere in the response — not misread, not misclassified as issue date, just gone.

1. **`inferIssuerConvention` (`router.ts`) never received a usable signal.** It takes
   `classification.issuer`, which `resolveIssuer` (`classify.ts`) can only populate from
   an MRZ, a barcode hint, or a literal US state name matched in OCR text — never a
   foreign country name. This DL has no MRZ and no barcode, so `classification.issuer`
   was `null`, `issuerConvention` was `null`, and `02-03-2039` — day and month both ≤12,
   genuinely ambiguous either way — hit `engine/dates.ts`'s "no convention, cannot
   resolve" branch: `iso: null, ambiguous: true`. A near-identical bug was already found
   and partially fixed once before on a real Indian *passport* (see the comment on
   `inferIssuerConvention` itself) — that fix works when an MRZ supplies the issuer name;
   a DL with neither an MRZ nor a barcode has no such fallback at all, so the same root
   cause resurfaced through a gap the earlier fix didn't cover.
2. **`applyHardConstraints` (`engine/constraints.ts`) silently dropped it.** The
   per-candidate loop skipped any candidate with `iso: null` outright (`if (!candidate.iso)
   continue`), so it landed in neither `survivors` (requires `iso`) nor `eliminated`
   (requires `eliminatedBy`, never set for a merely-unresolved candidate). The date wasn't
   wrong — it was invisible, indistinguishable in the response from a date that was never
   found at all. This directly contradicted the file's own header comment: the inventory
   exists specifically so every candidate's fate is legible, not just the ones that
   resolved cleanly.

### D2 — the fix that didn't work, and why

The first attempt broadened `inferIssuerConvention` with a `documentClass` fallback:
`NON_US_DRIVERS_LICENSE` / `NATIONAL_ID_CARD` already mean "confidently not US," no
country name required. Correct in principle, but verified wrong in practice: at the
moment TC is actually dispatched, `documentClass` is still classify.ts's **pre-TC** guess
— and with zero OCR text to work with (TB had already abstained; that's *why* TC runs at
all), that guess defaulted to `US_DRIVERS_LICENSE` off aspect ratio alone (`inconclusive:
true`, confidence 0.73). Confirmed by direct instrumentation, not assumed: TC's own
`mapper_document_class` correctly said `NON_US_DRIVERS_LICENSE` only *after* running —
the exact same call whose input needed to know that already. Fixing this at the call site
alone cannot work; the class isn't reliably known until the call it would inform has
already happened.

### D3 — the fix that did: re-resolve locally, using what TC already paid for

`router.ts` already reconsiders `documentClass` after TC returns, when
`classification.inconclusive && tcResult?.mapper_document_class` — that machinery just
never fed anything back into the dates TC had already parsed. Now it does: once the
class is corrected, if the newly-inferred `issuerConvention` differs from what was used
at dispatch, every `tcResult` candidate still sitting at `iso: null` gets re-run through
`normalizeFreeTextDate` (pure, already exported, `engine/dates.ts`) with the corrected
convention, using the **raw strings TC already returned** — no second VLM call, no
additional spend, on a corpus where TC is already the expensive tail (§ Results). This is
deliberately narrow: it only touches candidates TC itself couldn't resolve, never
overrides a candidate that already has a value, and changes nothing when the class
guess was right the first time (the common case).

Verified against the real document with the actual fix, not a synthetic stand-in: the
same DL now returns `validity.date: "2039-03-02"`, `verdict: VALID`, with the date
inventory showing `02-03-2039 -> 2039-03-02` as the winning `EXPIRY` candidate and the
issue date correctly excluded — instead of `INDETERMINATE` with nothing to show why.
`npm run eval` against the full synthetic corpus is byte-for-byte unchanged in every
decision (only real-API latency/cost noise moved), confirming neither fix disturbs any
existing behavior — D3's guard conditions mean it is a no-op everywhere this exact
timing gap doesn't apply.

## 11. A real passport scan surfaces the pipeline's single-page assumption

Found on a real passport PDF uploaded during manual testing: a photographed *spread* of
two facing physical pages stacked into one image — a visa-stamps page upside-down on top,
the bio-data page (photo, MRZ, expiry) right-side up on the bottom, both within a single
frame. `router.ts` only ever processes `doc.pages[0]`; that page's content was real, the
image quality was genuinely fine (`laplacian_variance` 1143, `effective_dpi` 300, no
skew), and the pipeline still came back `NO_DATES_FOUND` with nothing explaining why.

### E1 — the actual mechanism: OCR confidence collapse, not a rotation bug

Verified directly, not assumed: running the exact normalized raster through Tesseract
gave a mean confidence of **28.6/100** (clean printed text on a real document routinely
scores 85+) and visibly garbled output (`"TIES yy brim ody sie y pre as ghee"`). The real
values were technically present in the noise — one fragment carried both `07/07/2022` and
`06/07/2032` — but never as a clean, matchable line. `T0` applies **no** rotation or
perspective correction here (`rotationAppliedDeg: 0`, `perspectiveCorrected: false` —
the detected quad covered only 34.8% of the frame, below whatever threshold triggers a
correction), so this is not a mis-applied rotation flipping a correct read upside down.
It's simpler and more mundane than that: Tesseract's page segmentation degrades badly
when a large fraction of a single frame is text in a different orientation than the rest,
even without anything actually being rotated by the pipeline itself.

This cascades exactly as every other tier is designed to behave, which is the frustrating
part — nothing malfunctioned: TA (MRZ/barcode) correctly finds nothing in OCR output that
degraded, TB correctly can't match a label, and the admission gate's own cheap OCR
presurvey hits the *same* degraded recognition and lands on `ADMIT_LIMITED` — which
hard-blocks the paid VLM tier by design (§8's asymmetry rule). A VLM would very likely
read this composite far better than Tesseract's layout analysis does, but it never gets
the chance, because the gate's "is this worth paying for" check and "can we read this at
all" check share the same weak, cheap signal.

### E2 — what was rejected, and why

Two more invasive options were considered and explicitly rejected:

- **Detect and split the two-orientation composite before OCR.** The real fix, but a
  genuinely new capability this codebase doesn't have (no sub-region orientation
  detection exists anywhere today) — a real engineering investment for an input shape
  this system's own stated scope (§ Corpus honesty) doesn't claim to handle, not a quick
  patch.
- **Let the gate's positive-domain-signal check fall back to document-likeness alone,**
  bypassing the requirement that OCR/MRZ/barcode actually prove a domain match. Rejected
  outright: this is the exact cost guarantee the admission gate exists to provide (§8 A2)
  — loosening it to fix one edge case would let any merely document-shaped image
  (a book page, a flyer) reach the paid tier without ever proving it's KYC-relevant.

### E3 — what shipped: name the anomaly, change nothing else

A new reason code, `MIXED_ORIENTATION_SUSPECTED`, fires when OCR confidence collapses
(`< OCR_CONFIDENCE_ANOMALY_FLOOR`, 40 — a judgment call, not a measured boundary; no
existing corpus fixture exercises this path) **and** none of T0's own existing
input-quality codes (`IMAGE_TOO_BLURRY`, `RESOLUTION_TOO_LOW`, `GLARE_OBSCURES_FIELD`,
`EXTREME_SKEW`, `POOR_CONTRAST`, `DOCUMENT_CROPPED`, `OBSTRUCTED_BY_HAND`,
`PHOTOCOPY_DEGRADED`) already explain it — reusing that existing fixed set rather than
inventing new thresholds, so this can't silently duplicate or contradict logic that
already exists elsewhere. It changes no decision: `REVIEW` was already correct here
(nothing was confidently found), this only makes the abstention legible instead of
opaque, replacing an unexplained `NO_DATES_FOUND` with something the person holding the
document can actually act on — retake it one page at a time. `isUnexplainedOcrConfidenceCollapse`
(`router.ts`) is deliberately a small, pure, exported function specifically so this
judgment call is unit-testable without a real OCR pass (`router.test.ts` — router.ts's
first unit test file; everything else about it is verified through the eval harness
against real generated documents, per §9's verification note).

Verified against the real document: the fix fires `MIXED_ORIENTATION_SUSPECTED` exactly
as intended. Verified against the full 35-document synthetic corpus: zero false
positives — the anomaly never fires on any existing document, and every decision,
coverage, and accuracy number is unchanged.

## 12. The ROI panel is per-document, not a live aggregate — and why

The last of the three items deferred after the gate + CRM emission shipped (ROI panel,
"try to break it" mode, maturity-ladder README section). `src/lib/reviewer-economics.ts`
was already built specifically for this (its own header comment says so); nothing in the
UI had ever read `ExtractionResponse.admission` before this.

### F1 — why the panel can't show live "7/7 containment" the way `eval/run.ts` does

`src/app/page.tsx` holds exactly one `ExtractionResponse | null` in state, replaced on
every upload — no history array, no `localStorage`, nothing accumulated across requests.
`eval/run.ts`'s containment/rejection rates are corpus statistics computed over a labeled
`outcomes[]` array with known ground truth ("is this document adversarial"); a single
live upload has neither a corpus to aggregate over nor a ground-truth label to score
itself against. Building live aggregation would mean introducing a genuinely new
client-side persistence pattern — a real feature, not a UI tweak, and out of scope for
"keep styling the same, nothing should break."

### F2 — the resolution: two honestly-labeled sections, not one blended number

1. **This document** — live, from `result.admission` (decision, `spend_avoided_usd`, and
   one reviewer-touch avoided when `decision === 'REJECTED'`). The only thing a single
   request can honestly report about itself.
2. **Proven on the evaluation corpus** — the real numbers from `eval/results.md` as of
   commit `b7d8b62` (containment 7/7, rejection 4/7, false-reject 0/28, spend avoided
   $0.88), hardcoded as named constants (`CORPUS_REFERENCE`, `src/components/RoiPanel.tsx`)
   with a source note pointing at the commit and `npm run eval` — the exact provenance
   pattern the README already uses (`a709143`/`d435d22`) for the same reason: a number
   with no stated source is unfalsifiable, and this codebase's whole ethos is "nothing is
   hand-written, everything is reproducible."

Both sections run through the *same* editable throughput/loaded-cost inputs
(`reviewerMinutesAvoided`, and the new `minutesToDollars`/`DEFAULT_LOADED_COST_PER_HOUR_USD`
added to `reviewer-economics.ts` for this), so a viewer sees the dollar impact under their
own numbers on both the live document and the corpus reference, not two disconnected
figures.

### F3 — `DEFAULT_LOADED_COST_PER_HOUR_USD` is explicitly illustrative, not client-stated

Unlike `DEFAULT_REVIEWER_ASSUMPTION` (the client's own stated 20-30 docs/reviewer/day,
§8), no client ever gave a loaded reviewer-hour cost — $35 is a placeholder default,
labeled as an editable assumption in the UI copy itself, not presented as researched or
measured. Kept as a separate function (`minutesToDollars`) rather than folded into
`reviewerMinutesAvoided`, since the two assumptions have different provenance and should
stay independently editable rather than compounded into one function that obscures which
number came from where.

### F4 — placement and styling: purely additive, no existing pattern reused across files

`RoiPanel.tsx`/`RoiPanel.module.css` follow the `WhyPanel.tsx` precedent exactly — its own
`'use client'`, its own state, its own CSS module, imported into `ResultPanel.tsx` and
rendered as a new standalone card after the existing final bento block. Not injected into
the existing 2-column `.bento` grid (`ResultPanel.module.css`), which would have
unbalanced a grid built for exactly two children. The card recipe, tone system (`--tone-fg`
/`--tone-bg`/`--tone-border`), eyebrow labels, and `.facts` label/value grid are duplicated
from `ResultPanel.module.css` rather than cross-imported — consistent with every other
sub-component's CSS module in this codebase, each of which is self-contained. This is the
first numeric `<input>` in the app; styled to the existing `--surface-alt`/`--border`/mono
conventions with native spinner arrows removed (visual noise against the app's otherwise
flat control language), relying on the global `:focus-visible` treatment already defined
in `globals.css` rather than introducing new focus styling.

## 13. A live gate check, triggerable from the UI

Feedback on §12's panel from a UI-only walkthrough: someone testing only the deployed app,
with no terminal, has no way to check whether "7/7 contained, $0.88 avoided" is real —
it's a hardcoded constant. This entry covers making it genuinely live: a button in the
sidebar that runs the real admission gate against the real 35-document corpus, server-side,
right now, with a hard structural guarantee that it costs $0.

### G1 — `runPipeline` with no `vlmClient`, not a hand-rolled call to the gate

The first instinct was to call `runAdmissionGate` (`gate.ts`) directly per corpus document,
reconstructing its input via `normalizeDocument`. Wrong: `admission.spend_avoided_usd` for
`ADMIT_LIMITED` is finalized by **router-level** logic — whether `needVlm` would actually
have been true (`router.ts`'s `needVlm && admitLimited` branch) — not by the gate alone.
Reproducing that correctly means running the real router, not a shortcut that happens to
look similar.

The fix: `POST /api/eval-gate` (`src/app/api/eval-gate/route.ts`) calls **`runPipeline()`**
with **no `vlmClient` passed at all**. TA (MRZ/PDF417) and TB (Tesseract OCR) are already
free, deterministic tiers; only TC costs money, and `runPipeline` already handles a missing
`vlmClient` gracefully (`MODEL_UNAVAILABLE`, never attempts a call) — the exact path
`eval/run.ts` already exercises for its own "no key" row. Cost is structurally $0: there is
no client object to call the paid API with, not a budget check that could be bypassed.
Verified directly, not assumed: the live endpoint's output matches `eval/results.md`'s
committed figures exactly (7/7 contained, 4/7 rejected, 0/28 false-rejects, $0.88 avoided).

### G2 — the corpus has to actually exist where the code runs

`eval/corpus/*` is deliberately gitignored (§6/§12's own header: reproducibility, avoid
bloating every clone) and `next build` never runs `generate:corpus`, so none of the 35
files exist in a deployed build. `public/samples/` (`eval/copy-samples.ts`) already solves
exactly this for the 6 one-tap sample documents — `public/` carries no gitignore rule, so
whatever lands there survives into any deployment. New `eval/copy-eval-corpus.ts`, modeled
directly on `copy-samples.ts`, extends the same mechanism to the whole corpus: copies all
35 files plus a `manifest.json` (`{filename, expectedClass, adversarial}[]`, `adversarial`
computed once via `isAdversarial()`, now exported from `eval/run.ts` — one source of truth,
not a second hand-copied condition) into `public/eval-corpus/`, wired as a third step in
`npm run generate:corpus`. Committing the result (~1.7 MB across 35 files) is a deliberate,
documented exception to `eval/corpus/`'s own policy, following the exact precedent
`public/samples/` already set at 1/6th the scale — the cost of the exception is trivial
next to what it buys (a corpus that's actually reachable at runtime).

`ANCHOR_TODAY` moved from `eval/generate-corpus.ts` to `src/lib/anchor-date.ts` (re-exported
from its old location for compatibility, same pattern as `src/lib/resolution.ts`), since
`src/app/api/eval-gate` needs to evaluate against the same pinned date the corpus was built
against and cannot import from `eval/` at runtime (that tree isn't part of the deployed
server bundle).

**A real bug caught by running the code, not by review.** `eval/copy-eval-corpus.ts`
originally imported `isAdversarial`/`parseCsv` directly from `eval/run.ts`. `run.ts` called
its own `main()` unconditionally at module scope, with no guard — unlike
`generate-corpus.ts`, which already guards its own `main()` behind an `invokedDirectly`
check (`process.argv[1]` against the module's own URL). The result: importing two small,
pure helper functions silently triggered a full `npm run eval` as a side effect of the
import — caught immediately by actually running `npm run generate:corpus` and noticing
`eval/results.md` had changed when nothing should have touched it. Fixed at the root: gave
`run.ts` the same `invokedDirectly` guard `generate-corpus.ts` already had, rather than
routing around it by relocating the helpers — the guard is the correct invariant for any
script in this directory that wants to be safely importable, and now both scripts hold it.

### G3 — the rate limiter, and fixing a false claim along the way

No rate limiting existed anywhere in this codebase before this — no `middleware.ts`, no
dependency, nothing in any route — despite the README claiming "Rate limited by IP" under
Security and PII. `page.tsx`'s `submit()` even had a dedicated 429-handling branch already
written, unreachable, since nothing had ever sent a 429. New `src/lib/rate-limit.ts`:
in-memory, per-IP, fixed-window. Honestly limited on purpose — module-level `Map` state is
per-instance and best-effort, the same limitation this repo's own Roadmap already accepts
for the (also in-memory) per-document cost cap: "currently per-instance and best-effort
because serverless functions share no state" (G4). Applied to both `/api/extract` (making
the README's existing claim actually true, confirmed by the user rather than assumed —
touches an already-shipped route) and `/api/eval-gate` (stricter window: one request now
does ~35x the work of one extraction). Verified live: a burst of requests against
`/api/eval-gate` correctly 429s on the request past the limit, in milliseconds, before any
of the expensive per-document work starts — the check runs first in the handler, not after.

### G4 — the UI: independent of document-extraction state, on purpose

The trigger lives in the sidebar (`page.tsx`), not inside `ResultPanel`, and its state
(`gateCheckStatus`/`gateCheckResult`/`gateCheckError`) is deliberately separate from
`result`/`status` — a corpus summary is a structurally different result from a single
document's verdict, and the button must stay usable whether or not anyone has uploaded
anything yet. Once a check completes, its result is threaded down through `ResultPanel` to
`RoiPanel` as `liveGateCheck`, which prefers it over the static `CORPUS_REFERENCE` fallback
when present — the static numbers never disappear, they're just superseded the moment a
real one exists.

The disclosure itself does **not** auto-open when a live result lands (`<details
open={corpus.isLive}>` was tried and reverted). It sounded helpful — reveal the proof the
moment it's fetched — but the trigger and the disclosure live in different parts of the
page (sidebar button, main-panel card), so the "reveal" could fire well after the click, on
an unrelated later action (the next document extracted), which reads as a box popping open
for no visible reason rather than a response to anything the viewer just did. Reverted on
that feedback: the section always starts closed, exactly like before this feature, and the
"verified live just now" badge still correctly reflects state the moment someone opens it
themselves.

## 14. `/api/eval-gate` missed an existing production fix — found by actually deploying

`next.config.ts` already carries `outputFileTracingIncludes: { '/api/extract': [...] }`,
with its own detailed comment explaining why: Vercel's deploy-time file tracer is a
separate step from `next build`/`next dev` — it decides which files actually ship in each
route's serverless function by statically following `require`/`import`, and tesseract.js's
Node worker (`worker-script/node/index.js`) does a bare `require('..')` plus further
runtime-computed requires for its own dependencies (`bmp-js`, `zlibjs`, ...) — patterns a
static tracer cannot follow. The existing fix ships the whole of `node_modules` for that
one route rather than chasing the transitive closure package by package.

`/api/eval-gate` runs the identical tesseract.js-dependent code path (`runPipeline`, via
the gate's OCR presurvey and TB_OCR) and was never added to that map when the route was
created — an oversight, not a different bug. First production request 504'd after the full
120s `maxDuration`; Vercel's runtime error aggregation (`get_runtime_errors`) showed the
real cause directly: `Error: Cannot find module '..'`, `requireStack:
['.../tesseract.js/src/worker-script/node/index.js']` — the exact failure mode the existing
comment already documents, just on a route the fix's list hadn't caught up to yet.

**This is invisible locally by construction, not a testing gap** — `next dev` and
`next build` never run Vercel's separate file tracer at all, so no amount of local
`npm test`/`next build`/manual dev-server checking this session could have caught it. Only
an actual deploy exercises the step that fails. Confirmed `/api/extract` itself was already
fine in production (a real OCR-tier extraction succeeded, `source_tier: TB_OCR`) before
concluding the gap was scoped to the one route the fix's list didn't cover, rather than
guessing a broader regression. Fixed by adding `/api/eval-gate` to the same
`outputFileTracingIncludes` map — no application code changed, no new pattern introduced.

## 15. Auditing the gate for filtration headroom — and the T0 asymmetry rule extension

The client's ask: verify the gate is filtering as strongly as it can — only clean documents
should reach a human or a paid tier, no unnecessary garbage. Rather than answer from the
existing 7/7 containment number alone, the gate's own two pure, synchronous pixel signals
(`evaluateDocumentLikeness`, `evaluateScreenCapture` — no OCR involved) were run directly
against the corpus's residual "leak" cases to see, with real measurements, whether there is
any safe headroom left to tighten.

**Finding 1 — two adversarial documents are contained but not hard-rejected, and cannot
safely become hard-rejected.**

| Document | Real measurement | Why REJECT is unreachable |
|---|---|---|
| `31_adversarial_selfie.png` | `quad=present, bandCount=2, stddev=11.9` | `evaluateDocumentLikeness` requires `!hasQuad` as one of three ANDed conditions — a detected quad blocks REJECT outright, regardless of the other two |
| `32_adversarial_receipt.png` | `bandCount=14, inkFraction=0.028` (just above `INK_FRACTION_MIN=0.02`) | `noStructure` requires `bandCount < MIN_TEXT_BAND_COUNT(2)` — 14 is nowhere close |

The proof this has no safe headroom: `35_illegible_dl_wy.png` — a genuine, valid licence
that the ground truth explicitly requires must *never* be rejected, however badly it was
captured — measures `quad=present, bandCount=2`, the identical signature to the selfie.
Any threshold change that flips the selfie to REJECT flips this real document too. The
receipt is the same story against every genuine ID card in the corpus, which are all
`bandCount ≥ 6`: a receipt's row-structured text is not pixel-distinguishable from a real
document's, by design (§8 A5's own note on why doc 32 exists). This is the asymmetry rule
(§8 A2) working exactly as designed, confirmed with real numbers rather than re-asserted
from the code comment: containment (7/7, both of these are `ADMIT_LIMITED` and permanently
blocked from TC) is already 100%; pushing the *hard-reject* rate higher than 4/7 would
require abandoning the "a quad or real text structure is never overridden" rule that is
also the only thing protecting docs 22/23/35 from false rejection. Not changed.

**Finding 2 — `25_not_a_document_meme.png` never even reaches the gate, and neither does
any T0-level "unreadable bytes" rejection, yet all of them were routed identically.**

Instrumenting the pipeline showed the meme is rejected at T0 (`normalizeDocument`,
`RESOLUTION_TOO_LOW`) before the gate ever runs — correct in outcome, but `rejectionResponse()`
in `router.ts` set `decision: 'REVIEW'` **unconditionally** for every T0 failure kind
(`EMPTY_FILE`, `UNSUPPORTED_TYPE`, `CORRUPT_FILE`, `ENCRYPTED_PDF`, `RESOLUTION_TOO_LOW`,
`RENDER_FAILED`), with no distinction between them, and — per the CRM rule in §9 ("every
non-REJECTED verdict gets a payload") — emitted a CRM payload for all of them too. That is
defensible for most of these kinds: a `CORRUPT_FILE` or a too-small photo could genuinely be
a real customer's document with a technical problem (a truncated upload, a bad phone photo),
so a human should still see it and CRM should still know about it. It is not defensible for
`EMPTY_FILE` or `UNSUPPORTED_TYPE`: no real KYC document is ever a 0-byte upload or a file
whose magic bytes match nothing this system reads (§7.1 — the declared name/mime is never
trusted). Those two are impossibilities, not uncertainties, and were consuming the same
review-queue slot and CRM noise as a genuinely ambiguous case.

**Fix: extend the asymmetry rule one layer before the gate.** `router.ts` now splits T0
rejections in two. `isTerminalT0Rejection()` (pure, exported, unit-tested directly —
`router.test.ts`) is true only for `EMPTY_FILE`/`UNSUPPORTED_TYPE`; those now go through a
new `terminalRejectionResponse()`, built the same way `gateRejectedResponse()` already is:
`decision: 'REJECTED'`, no `admission` (T0 never reached the gate), and — following
`gateRejectedResponse()`'s own precedent exactly — no `crm_payload`, logged only
(`[crm] T0 terminal reject — no CRM payload emitted`). Confidence is `1`, not the gate's
`0.9`: this is a deterministic fact about the bytes (length, magic-byte sniff), not a
statistical pixel judgment, so borrowing the gate's own hedge would have been dishonest in
the other direction. The remaining four kinds keep going through the original
`rejectionResponse()`, unchanged: `REVIEW`, CRM payload emitted, a human sees it.

**A second, real bug found while wiring this up, unrelated to the gate itself:**
`src/app/api/eval-gate/route.ts` special-cased any T0 rejection with a hand-rolled
`if (!isNormalized(outcome)) { if (adversarial) containedCount++; return; }` that never
called `runPipeline` at all — meaning it could never have observed the new `REJECTED`
decision, or any future change to T0 handling, without silently drifting from what the
router actually returns (the exact class of bug §8's `GATE_KEYWORDS`-by-exclusion comment
already warns about once in this codebase). Fixed by calling `runPipeline({ outcome, today })`
unconditionally, exactly like `eval/run.ts`'s own harness already does — one source of truth
for "what happens to a T0 rejection" instead of two that can diverge.

**Verification.** None of the 35 corpus documents are an empty file or an unsupported type
(all 35 are real images/PDFs, adversarial only in *content*, never in file validity), so this
change was invisible to the corpus's own numbers by construction — confirmed live against
the running `/api/eval-gate` route post-fix: `containedCount: 7, rejectedCount: 4,
falseRejectCount: 0, spendAvoidedUsd: 0.88` — bit-for-bit identical to the committed
`eval/results.md` figures. Coverage for the new behavior itself comes from `router.test.ts`:
`isTerminalT0Rejection` pinned directly against all six T0 kinds, plus three end-to-end
`runPipeline()` calls on real (non-mocked) fixtures — a zero-byte file and a plain-text
upload both resolve `REJECTED` with `crm_payload` and `admission` both `undefined`; the
existing `CORRUPT_FILE` fixture from `normalize.test.ts` still resolves `REVIEW` with a
`crm_payload` present, guarding against the split ever silently swallowing a kind it
shouldn't.
