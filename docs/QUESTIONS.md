# Questions for the follow-up call

Deliverable D5 (§17). Split into questions that would change the build, and questions
about the role.

---

## On the assignment

Ordered by how much the answer would change what is built.

**1. What is the current auto-clear rate, and what false-accept rate is tolerable?**

This is the one that matters most, because it sets the confidence threshold — and right
now that threshold is derived from a 25-document synthetic corpus rather than from the
business constraint it should follow.

The measured curve says: at 0.90 the system auto-clears 44% at 90.9% accuracy with one
confident error; at 0.95 it auto-clears 28% at 100% with none. I chose 0.95 because a
wrong `AUTO_PASS` in KYC has no recourse while a `REVIEW` costs a reviewer a minute. But
that trade is a business decision, not an engineering one. If the review queue has real
capacity, a lower bar buys throughput; if it is saturated, the bar should go higher.
**A tolerated false-accept rate would let me set this from data instead of from judgement.**

**2. Is the document class known at upload time from the user's selection, or must it be inferred?**

This changes the architecture more than any other answer. Class determines the validity
*rule* — expiry vs recency window vs no expiry — and a misclassification currently
propagates into a wrong basis even when the date is extracted perfectly (two of the four
known misses are exactly this). If the user picks "passport" at upload, that whole failure
mode disappears and the classification tier can be deleted rather than improved.

**3. Is the input always a single document per submission?**

Front + back is supported and cross-checked today. But an ID *plus* a proof of address in
one submission is a different shape: two documents, two classes, two validity rules, and a
combined verdict. Worth knowing before the response contract hardens, because it would
become a list rather than a single object.

**4. Is there an existing review queue this routes into, or is the abstention path new?**

The system's whole value is calibrated abstention, and abstention only pays if something
consumes it. Every `REVIEW` already carries machine-readable reason codes intended for
triage. If a queue exists I would match its schema; if it does not, the reason-code
taxonomy is the more important deliverable, and the review UI belongs on the roadmap.

**5. What fraction of real uploads are phone photos rather than scans or screenshots?**

The corpus is generated, so these numbers measure *logic* — classification, date semantics,
constraint elimination, abstention discipline — not OCR robustness on camera images. The
deterministic tiers are the cheapest and most accurate path, but PDF417 decoding is
sensitive to focus and distance. The real-world tier distribution, and therefore the real
cost per document, depends almost entirely on capture quality.

---

## On the role

The JD is still broad ("Software Development, AI and agents"), and this round is where the
role gets defined.

6. **What does this role own end to end** — building the agent systems, or productizing
   them for accounts? Those are different jobs with different day-to-day work.

7. **Which accounts are live on the OCR/KYC pipeline today, and at what volume?** Volume
   decides whether self-hosted inference is a near-term necessity or a roadmap item.

8. **Team shape** — how many engineers, who owns infra, and is there an ML or eval
   function? Whether evaluation is someone's job changes how much of it lands on this role.

9. **How is the success of an agent deployment measured** — cost per resolved case,
   deflection rate, something else? I have opinions about which of those is measurable, and
   would rather match an existing definition than invent one.

10. **What is the balance between per-client custom work and shared platform?** This
    determines whether the template-library direction in the roadmap is valuable or
    irrelevant.

11. **Where does the founder's office sit relative to engineering on prioritisation?**

---

## Two things I would raise unprompted

**The most obvious library for AAMVA barcodes silently rejects valid Canadian licences.**
`aamva-parser` reads the `DBA` field as MMDDCCYY regardless of `DCG`, so an Ontario licence
valid until 2029 parses as year 0229 and `isExpired()` returns `true`. In a no-human-in-the-
loop system that is not a review — it is a confident rejection of a valid document, with no
recourse and no signal that anything went wrong. Worth checking whether anything in the
current pipeline depends on it. Detail in `docs/DECISIONS.md`.

**Production cannot send real KYC documents to a public model API.** This build uses a
hosted VLM because the corpus is synthetic. The good news is that the compliance path and
the cost path point the same way: at volume, self-hosted VLM OCR on mid-tier GPUs is now
cheaper per page than managed APIs. The architecture already isolates this — TC sits behind
a narrow injectable interface, so swapping in a self-hosted model is a one-file change.
