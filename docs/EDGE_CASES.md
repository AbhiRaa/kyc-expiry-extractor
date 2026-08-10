# Edge case catalogue — §11 triage

§11 says every row needs either handling code or an explicit note saying it is out of
scope and why. **Silent gaps are the failure mode**, so this file accounts for all 78.

Status key:

- **Code** — implemented and covered by a test.
- **Code\*** — implemented, but not exercised end to end (reason given).
- **Doc** — deliberately out of scope, with the reason.

Where a row is exercised by the eval corpus, the document is named.

---

## 11.1 Input and file handling

| # | Case | Status | Where |
|---|---|---|---|
| 1 | Non-document file type (.docx/.txt/.zip) | Code | Magic-byte sniff via `file-type`; extension and client MIME carry no authority. Rejected with a client-safe message. |
| 2 | Corrupt or zero-byte file | Code | Rejected cleanly; no stack trace reaches the client. |
| 3 | HEIC/HEIF from an iPhone | Code\* | `heic-convert` with a sharp/libheif fallback. **Decode path is unproven by test** — sharp's bundled libheif has no HEVC *encoder*, so a HEIC fixture cannot be generated programmatically. One real HEIC file in the corpus would close this. |
| 4 | WebP, TIFF, multi-frame TIFF | Code | sharp with `page: 0, pages: 1`. |
| 5 | Animated GIF | Code | Frame 0. |
| 6 | PDF, text-native | Code | Text layer extracted directly and used for classification at `EXACT` provenance — cheaper and more accurate than rasterizing. Docs 14–21. |
| 7 | PDF, scanned image | Code | Rasterized at 300 DPI. |
| 8 | PDF, password-protected | Code | `PasswordException` → clean `ENCRYPTED_PDF` rejection. Never attempts to crack. |
| 9 | PDF, 40 pages | Code | First 3 pages only; the cap is reported in the response. Doc 16. |
| 10 | PDF page rotation flag | Code\* | `/Rotate` baked into the viewport. **Untested** — pdfkit cannot set the flag; the path is exercised at rotation 0. |
| 11 | File > 4.5 MB body limit | Code | Client downscales before upload (quality-then-resolution ladder targeting 3.4 MB). Server refuses >4.5 MB with a clear 413 rather than letting the platform return an opaque one. |
| 12 | Very small file (<50 KB) | Code | **Not a bare rejection** — see G9 in `DECISIONS.md`. Byte count triggers a resolution check; rejected only if effective DPI is also under 150, because §11.2 #26 says a screenshot is the *easiest* case and screenshots compress under 50 KB. |
| 13 | Two files (DL front + back) | Code | Multi-page normalize; the barcode side extracts and cross-checks against the printed side. Doc 03. |
| 14 | Same file twice | Code\* | Per-request content-hash short-circuit. A **durable** cross-request cache needs Redis/KV — serverless functions share no state (G4). |
| 15 | EXIF orientation not applied | Code | `sharp().autoOrient()` runs before anything reads pixels; applied rotation is reported. Highest-value single fix — untreated it breaks TA silently. |

## 11.2 Image quality

| # | Case | Status | Where |
|---|---|---|---|
| 16 | Motion blur / out of focus | Code | Laplacian variance below floor → `IMAGE_TOO_BLURRY` → REVIEW. Doc 22. |
| 17 | Flash glare over the expiry | Code | Luminance clipping ratio → `GLARE_OBSCURES_FIELD`. Doc 23. |
| 18 | Resolution too low for PDF417 | Code | TA abstains cleanly and falls through. Not an error. |
| 19 | Perspective distortion | Code | Corner detection → inverse homography → bilinear warp, gated on corner deviation. |
| 20 | Rotated 90°/180° | Code | `tryAllOrientations` with an injected probe; renders turns lazily so a 0° hit costs three renders less. Doc 04. |
| 21 | Document edge cropped | Code | Requires 3+ heavily contacted frame edges → `DOCUMENT_CROPPED`. Suppressed for PDFs, where a page is complete by definition. |
| 22 | Thumb over part of the card | Code | Manifests as a missing field; the tier abstains rather than inferring. |
| 23 | Dark / heavy shadow | Code | Adaptive thresholding, else `POOR_CONTRAST`. |
| 24 | B&W photocopy | Code | Works for OCR, never for barcodes — falls to TB as expected. |
| 25 | Instagram colour filter | Code | Grayscale-normalized before OCR. |
| 26 | Screenshot of a document | Code | Treated as the easiest case, not rejected on file size. See #12. |

## 11.3 Document class and coverage

| # | Case | Status | Where |
|---|---|---|---|
| 27 | DL front only, no barcode | Code | TB via printed `4b` field code. Doc 01. |
| 28 | DL back only | Code | TA-PDF417. Highest-confidence path in the system. Doc 02 — 9 ms, $0, confidence 1.00. |
| 29 | Vertical under-21 layout | Code | Orientation retry; same barcode. Doc 04. |
| 30 | Temporary paper licence | Code | No barcode, short validity → `TEMPORARY_DOCUMENT` → REVIEW. Doc 05. |
| 31 | mDL screenshot | Doc | **Out of scope.** The trust model is entirely different — an mDL is a signed credential whose authenticity comes from its issuer signature, not from anything visible. Detecting one and treating it as an image would be worse than declining it. |
| 32 | Passport data page | Code | TA-MRZ. Docs 07, 08 — confidence 1.00. |
| 33 | Passport visa page / cover | Code | No MRZ band → `WRONG_SIDE_CAPTURED`. |
| 34 | Non-US passport | Code | MRZ is international; works unchanged. Doc 08 (GBR). |
| 35 | TD1 residence permit (3×30) | Code | TD1 layout handled as a first-class case. Doc 09. |
| 36 | Medical insurance card | Code | `COVERAGE_END`, or `NO_EXPIRY` where only an effective date is printed. Never fabricates. Docs 11–13. |
| 37 | Bank statement | Code | `RECENCY_WINDOW`. Statement period end found deterministically via recency-anchor labels in TB. Docs 14–16. |
| 38 | Utility bill | Code | Same, 90-day rule. Docs 17, 18. |
| 39 | Employment letter, 8+ dates | Code | **The showcase abstention case.** `NO_EXPIRY` / `NOT_APPLICABLE`; the termination date is explicitly not selected. Doc 19 carries 15 dates. |
| 40 | Non-Latin script | Code | Script profiling → `UNSUPPORTED_SCRIPT`. Detect, do not attempt. |
| 41 | Two documents in one photo | Code | `MULTIPLE_DOCUMENTS_IN_FRAME`. |
| 42 | Completely unrecognized document | Code | `CLASS_UNRECOGNIZED`, but the date inventory is still returned — partial output beats none. |
| 43 | Not a document at all | Code | `NOT_A_DOCUMENT` on **positive evidence of absence** (a text pass ran and found nothing *and* the page is in focus), so a soft-focus passport is never classed as a meme. No spend beyond classification. Doc 25. |

## 11.4 Date semantics — the core of the assignment

| # | Case | Status | Where |
|---|---|---|---|
| 44 | 10–12 dates on one document | Code | Full inventory plus constraint elimination; eliminated candidates and their reasons render in the "why?" panel. Doc 19. |
| 45 | Zero dates found | Code | `NO_DATES_FOUND` → REVIEW. **Explicitly not "expired".** |
| 46 | Expiry present but unlabelled | Code | **The assignment's real test.** Resolved by elimination rather than label matching. Tested directly. |
| 47 | Novel label not in the lexicon | Code | TB abstains, TC handles it. |
| 48 | "NON-EXPIRING" / "INDEFINITE" | Code | Sentinel list → `NO_EXPIRY` / `NOT_APPLICABLE`. Doc 20. |
| 49 | Expiry MM-DD equals DOB MM-DD | Code | Birthday-aligned renewal used as a **tie-break signal**, not a confusion source. Doc 01. |
| 50 | Expiry already in the past | Code | `EXPIRED`, high confidence. **The case the earlier verbal answer would have discarded.** Doc 10 — `AUTO_FAIL` at confidence 1.00. |
| 51 | Expiry is today | Code | End-of-day inclusive, UTC; the policy is stated in every response. |
| 52 | Ambiguous DD/MM vs MM/DD | Code | Self-disambiguates when day > 12; otherwise `AMBIGUOUS_DATE_FORMAT` → REVIEW. Never guesses. |
| 53 | Two-digit year | Code | Century resolved to the nearest plausible, `date_raw` always retained. See **G8** — the brief's own rule was wrong here. |
| 54 | Month-year only | Code | Last day of month, stated in `rule_applied`. |
| 55 | Date range printed | Code | Second element is the end. Doc 12. |
| 56 | Handwritten date | Code | **A finding, not an abstention** — abstaining would hand it to TC, whose self-reported confidence is worthless as a stop signal (§4.4). Returned with scaled confidence + `LOW_TIER_CONFIDENCE` → REVIEW. |
| 57 | Date split across two lines | Code | Layout-aware reassembly via bbox adjacency; verified by test. |
| 58 | OCR digit confusion → implausible date | Code | Flagged, **never auto-corrected**. Silent correction is how wrong KYC decisions get made. |
| 59 | MRZ expiry ≠ printed expiry | Code | `MRZ_VIZ_MISMATCH` → REVIEW. Tamper signal, not a tie to break; both values retained, neither preferred. |
| 60 | Barcode expiry ≠ printed expiry | Code | `BARCODE_PRINT_MISMATCH` → REVIEW. Same handling. |

## 11.5 Integrity and adversarial

| # | Case | Status | Where |
|---|---|---|---|
| 61 | MRZ check digit fails | Code | `CHECKSUM_FAILED` → REVIEW, naming the failing field **and position**. Returns zero candidates — letting a value through at reduced confidence would invite fusion to use a reading we just said we cannot vouch for. |
| 62 | Expiry before issue | Code | `EXPIRY_BEFORE_ISSUE`. |
| 63 | Validity period > 20 years | Code | `IMPLAUSIBLE_VALIDITY_PERIOD`. Compared against the **calendar anniversary** — see `DECISIONS.md`; the naive form eliminates every legitimate 20-year document. |
| 64 | DOB after expiry | Code | `DOB_AFTER_EXPIRY`. |
| 65 | Issue date in the future | Code | `FUTURE_DATED_ISSUE`. |
| 66 | Text in the image instructing the model | Code | **The real defence is grounding, not prompt hardening.** Every VLM value is cross-checked against the raw OCR token stream; a value not physically on the page fails and emits `VALUE_NOT_GROUNDED_IN_OCR`. This required a deviation from the brief (**G5**) — as specified, TC fires only when TB abstains, so no grounding stream would have existed. Doc 24. |
| 67 | Photo of a screen (moiré) | Doc | **Known gap.** Cheap moiré detection is unreliable at the resolutions we accept; a naive detector would false-positive on halftone-printed documents, which are legitimate. |
| 68 | Digitally edited date | Doc | Out of scope. MRZ/barcode cross-check catches the naive version for free (#59, #60); real forgery detection is a different system. |
| 69 | Huge wall of text to blow context | Code | Input tokens capped; truncation reported with a reason code. |
| 70 | Malicious PDF with embedded JS | Code | Rasterized without a scripting manager; JS is never executed. `pdfjs-dist` v6 removed `isEvalSupported` because eval support was removed upstream, so this is satisfied structurally rather than by a flag. |

## 11.6 Operations

| # | Case | Status | Where |
|---|---|---|---|
| 71 | VLM API down / 5xx | Code | Degrades to any TA/TB result; else `MODEL_UNAVAILABLE` → REVIEW. **Never a 500 to the user.** |
| 72 | Function timeout | Code | Pipeline hard-capped at 25 s, well inside the platform limit; partial result returned with `TIMEOUT`. (The brief cites a 60 s platform cap; fluid compute now allows more — the internal cap is the real constraint.) |
| 73 | Rate limited (429) | Code | Exponential backoff, one retry, then degrade. |
| 74 | Cost runaway | Code\* | Per-document budget checked **before** spending, plus a per-instance counter. A **durable global** cap needs Redis/KV (G4) — documented rather than claimed. |
| 75 | Concurrent uploads | Code | Stateless handlers, no shared mutable state; determinism under concurrency is tested. |
| 76 | Hunter returns a value, Mapper returns nothing | Code | **The fabrication signature.** `HUNTER_MAPPER_DISAGREE`, confidence floored at 0.15 — deliberately below the review floor, so no weighting can let it carry a document. The candidate is kept so the "why?" panel can show what was claimed and rejected. |
| 77 | Both calls return null | Code | `NO_EXPIRY_SEMANTICS` **only** for classes that can legitimately have none; everything else gets `NO_DATES_FOUND`, so a read failure is never laundered into a clean finding. |
| 78 | Malformed JSON from the model | Code | One structured retry, then abstain. **Never regex-scrapes a broken response into a date.** |

---

## Known misses in the current eval

As of the current full pipeline (`claude-sonnet-5`, `npm run eval` with a key —
`eval/results.md`), one document does not resolve, and it is not a *confident* error: it
routes to `REVIEW` with `date: null`, which is the safe failure. Listed here rather than
hidden.

| Doc | Symptom | Cause |
|---|---|---|
| 24 Injection sticker | Zero candidates, `all_dates_found: []` | Confirmed by direct pipeline run: `reason_codes` come back `NO_MACHINE_READABLE_REGION, NO_EXPIRY_SEMANTICS, AMBIGUOUS_DATE_FORMAT, PROMPT_INJECTION_SUSPECTED`. The injection defence this doc exists to test (§11.5 #66) is doing exactly its job — `PROMPT_INJECTION_SUSPECTED` fires and no fabricated 2099-01-01 is ever returned. What it does not do this run is separately recover the genuine printed 4b expiry (08/01/2030): the VLM read landed on `AMBIGUOUS_DATE_FORMAT` with nothing groundable, so the inventory comes back empty rather than holding the real date. Safe (`INDETERMINATE`, not a wrong `VALID`), not correct. `claude-sonnet-5` VLM reads have run-to-run variance (see README, "Comparing VLM models"), so a re-run is not guaranteed to reproduce this exact miss. |

Three previously-listed misses here (doc 01 DL front-only, doc 09 TD1 residence permit,
doc 12 insurance date range — all landing on basis `UNDETERMINED` or no candidate) are
resolved: all three now score correctly on date **and** basis via deterministic tiers
(`TB_OCR`), no VLM call needed. This table is regenerated by hand against
`eval/results.md`, not derived automatically — re-check it whenever the eval numbers move.
