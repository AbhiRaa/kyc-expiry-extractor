# Decision log

Every `[DECIDE]` marker from the brief, every place the implementation deviates from the
spec and why, and the spec ambiguities that had to be resolved to build at all.

This file is the working record. The README summarises it.

---

## 1. Resolved `[DECIDE]` markers

| Marker | Decision | Why |
|---|---|---|
| §7 T0 — gate the pipeline on a quality pre-check? | **Attempt always; surface quality metrics in the response.** | The brief's own recommendation. Rejecting before spending saves nothing measurable at these volumes, and the metrics demo well. |
| §7 TC — model choice | **`claude-opus-5`**, structured outputs enforced via `output_config.format`. | High-resolution vision (2576px long edge) keeps MRZ bands and small print legible, which is the whole failure mode at this tier. Real per-document cost is computed from `usage` and reported in the eval, so the tier table stays honest. |
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

**Changed to** `evidence.crop_data_uri` — the crop inline as a base64 data URI, capped at
40 KB. Removes an endpoint and makes the "no documents are stored" claim in §15 strictly
true: nothing outlives the response body.

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

**Worked around** rather than unfreezing the contract mid-build: these carry
`CLASS_UNRECOGNIZED` plus a separate machine-readable `kind` discriminant and a
client-safe message. Three codes should be added to the enum in a follow-up.

### G11 — the document-class taxonomy has no non-US driving licence

`DOCUMENT_CLASSES` offers `US_DRIVERS_LICENSE` but no general driving-licence class, so
the Canadian card in the eval corpus is labelled `OTHER_DOCUMENT` — `US_DRIVERS_LICENSE`
would be factually false. Worth widening the enum.

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
