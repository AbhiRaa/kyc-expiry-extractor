'use client';

import { useState } from 'react';
import type { ExtractionResponse, FoundDate } from '@/types/contract';
import { findSelectedIndex, humanizeEnum, humanizeRole } from './DateInventory';
import styles from './WhyPanel.module.css';

/** How many ruled-out candidates to show before folding the rest behind a toggle.
 *  A 40-page bank statement can carry ~880 transaction dates (eval row 16); an
 *  unbounded list would bury the answer it is meant to explain. */
const ELIMINATED_PREVIEW = 8;

interface Tally {
  reason: string;
  count: number;
}

/** Group identical elimination reasons so the constraint that did the most work
 *  is visible before a single row is read. */
function tallyReasons(dates: readonly FoundDate[]): Tally[] {
  const counts = new Map<string, number>();
  for (const date of dates) {
    if (!date.eliminated_by) continue;
    counts.set(date.eliminated_by, (counts.get(date.eliminated_by) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export interface WhyPanelProps {
  result: ExtractionResponse;
}

/**
 * The "why?" panel (§10: "the single most persuasive thing in the demo — it makes
 * the reasoning legible instead of magical").
 *
 * The design argument, since this is the one component worth arguing about:
 *
 * 1. **It answers a question, so it is written as an answer.** The heading is a
 *    sentence ("Why this date, and not the other N?"), and the first thing under
 *    it is the claim — the surviving candidate and the rule that kept it — not a
 *    table of data the reviewer has to reduce themselves.
 *
 * 2. **Elimination is shown as an act, not a property.** Each ruled-out row reads
 *    left-to-right as `<date> — <constraint that killed it>`, with the date struck
 *    through. That word order matters: the eye lands on the plausible-looking date
 *    the reviewer was worried about ("why not the payment due date?") and the
 *    reason is immediately to its right.
 *
 * 3. **The constraint tally sits above the list.** Two taps into the demo the
 *    interesting fact is "seven dates went out on one rule", not which seven.
 *    The tally chips say that in one line; the list is the audit trail beneath it.
 *
 * 4. **Abstention gets first-class treatment, not an empty state.** For the
 *    employment letter (15 dates, no expiry semantics) the correct output is a
 *    null date, and a panel that renders "no selection" as blank space makes the
 *    system's best behaviour look like a bug. Instead the claim block flips to
 *    "Nothing was selected — and that is the answer", with the basis and rule
 *    quoted as the justification.
 *
 * 5. **Survivors that were not chosen are their own group.** Two dates can both
 *    clear every hard constraint (a barcode expiry and its printed twin). Folding
 *    them in with eliminated candidates would imply a rejection that never
 *    happened, so they render in the "considered" tone with no reason attached.
 *
 * 6. **Colour is never load-bearing.** Every row carries a glyph and a word
 *    (✔ Selected / ✕ Ruled out / – Considered) as well as its tone, so the panel
 *    survives being read in greyscale or by a red/green-blind reviewer (WCAG 1.4.1).
 *
 * It takes the whole `ExtractionResponse` rather than a candidate list because the
 * justification for the *selection* lives in `validity` (basis, rule_applied) while
 * the justification for the *eliminations* lives in `all_dates_found[].eliminated_by`.
 * Splitting the props would just mean reassembling them here.
 */
export default function WhyPanel({ result }: WhyPanelProps) {
  const [showAll, setShowAll] = useState(false);

  const dates = result.all_dates_found;
  const selectedIndex = findSelectedIndex(
    dates,
    result.validity.date,
    result.validity.date_raw,
  );
  const selected = selectedIndex >= 0 ? dates[selectedIndex] : null;

  const eliminated = dates.filter((d) => Boolean(d.eliminated_by));
  const survivors = dates.filter((d, i) => i !== selectedIndex && !d.eliminated_by);
  const tally = tallyReasons(dates);

  const visibleEliminated = showAll ? eliminated : eliminated.slice(0, ELIMINATED_PREVIEW);
  const hiddenCount = eliminated.length - visibleEliminated.length;

  const headline =
    dates.length === 0
      ? 'Why there is no date'
      : selected
        ? `Why this date, and not the other ${dates.length - 1}?`
        : 'Why no date was selected';

  return (
    <section className={styles.panel} aria-labelledby="why-heading">
      <header className={styles.head}>
        <h3 id="why-heading" className={styles.heading}>
          {headline}
        </h3>
        <p className={styles.counts}>
          {dates.length} date{dates.length === 1 ? '' : 's'} found
          {' · '}
          {selected ? '1 selected' : 'none selected'}
          {' · '}
          {eliminated.length} ruled out
          {survivors.length > 0 ? ` · ${survivors.length} left standing` : ''}
        </p>
      </header>

      {/* The claim. */}
      {selected ? (
        <div className={styles.claim}>
          <p className={styles.claimTop}>
            <span className={`${styles.tag} ${styles.tagSelected}`}>✔ Selected</span>
            <span className={styles.claimDate}>{selected.iso ?? selected.raw}</span>
          </p>
          <dl className={styles.claimFacts}>
            <div>
              <dt>Read as</dt>
              <dd className={styles.mono}>{selected.raw}</dd>
            </div>
            <div>
              <dt>Label</dt>
              <dd>
                {selected.label_verbatim ? (
                  <q className={styles.mono}>{selected.label_verbatim}</q>
                ) : (
                  <span className={styles.faint}>unlabelled on the document</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{humanizeRole(selected.inferred_role)}</dd>
            </div>
          </dl>
          <p className={styles.claimRule}>
            <span className={styles.ruleLabel}>
              Kept because ({humanizeEnum(result.validity.basis)})
            </span>
            {result.validity.rule_applied}
          </p>
        </div>
      ) : (
        <div className={`${styles.claim} ${styles.claimAbstained}`}>
          <p className={styles.claimTop}>
            <span className={`${styles.tag} ${styles.tagAbstained}`}>– No selection</span>
            <span className={styles.claimDate}>
              {dates.length === 0
                ? 'No dates on this document'
                : 'Nothing was selected — and that is the answer'}
            </span>
          </p>
          <p className={styles.claimRule}>
            <span className={styles.ruleLabel}>
              Basis ({humanizeEnum(result.validity.basis)})
            </span>
            {result.validity.rule_applied}
          </p>
          <p className={styles.abstainNote}>
            Returning the most expiry-shaped string on the page would have been a
            guess. Abstaining is the correct output, and the inventory below is
            still complete.
          </p>
        </div>
      )}

      {/* What did the eliminating. */}
      {tally.length > 0 ? (
        <>
          <h4 className={styles.subheading}>Constraints that did the work</h4>
          <ul className={styles.tally}>
            {tally.map((entry) => (
              <li key={entry.reason} className={styles.tallyChip}>
                <span className={styles.tallyReason}>{entry.reason}</span>
                <span className={styles.tallyCount}>
                  ×{entry.count}
                  <span className={styles.srOnly}>
                    {' '}
                    candidate{entry.count === 1 ? '' : 's'} eliminated
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* The ruled-out candidates themselves. */}
      {eliminated.length > 0 ? (
        <>
          <h4 className={styles.subheading}>Ruled out</h4>
          <ul className={styles.list}>
            {visibleEliminated.map((date, index) => (
              <li key={`${date.raw}-${index}`} className={styles.row}>
                <span className={`${styles.tag} ${styles.tagOut}`}>✕ Ruled out</span>
                <span className={styles.rowBody}>
                  <span className={styles.rowDate}>
                    <s className={styles.mono}>{date.raw}</s>
                    {date.iso && date.iso !== date.raw ? (
                      <span className={styles.rowIso}>({date.iso})</span>
                    ) : null}
                  </span>
                  <span className={styles.rowMeta}>
                    {humanizeRole(date.inferred_role)}
                    {date.label_verbatim ? (
                      <>
                        {' · labelled '}
                        <q className={styles.mono}>{date.label_verbatim}</q>
                      </>
                    ) : null}
                  </span>
                  <span className={styles.rowReason}>{date.eliminated_by}</span>
                </span>
              </li>
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <button
              type="button"
              className={styles.more}
              onClick={() => setShowAll(true)}
              aria-expanded={false}
            >
              Show {hiddenCount} more ruled-out date{hiddenCount === 1 ? '' : 's'}
            </button>
          ) : null}
          {showAll && eliminated.length > ELIMINATED_PREVIEW ? (
            <button
              type="button"
              className={styles.more}
              onClick={() => setShowAll(false)}
              aria-expanded
            >
              Show fewer
            </button>
          ) : null}
        </>
      ) : null}

      {/* Candidates nothing eliminated, but which the verdict does not rest on. */}
      {survivors.length > 0 ? (
        <>
          <h4 className={styles.subheading}>
            Survived every constraint, not used for the verdict
          </h4>
          <ul className={styles.list}>
            {survivors.map((date, index) => (
              <li key={`${date.raw}-survivor-${index}`} className={styles.row}>
                <span className={`${styles.tag} ${styles.tagKept}`}>– Considered</span>
                <span className={styles.rowBody}>
                  <span className={styles.rowDate}>
                    <span className={styles.mono}>{date.raw}</span>
                    {date.iso && date.iso !== date.raw ? (
                      <span className={styles.rowIso}>({date.iso})</span>
                    ) : null}
                  </span>
                  <span className={styles.rowMeta}>
                    {humanizeRole(date.inferred_role)}
                    {' · confidence '}
                    {date.confidence.toFixed(2)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {dates.length === 0 ? (
        <p className={styles.emptyNote}>
          No date-shaped strings were extracted, so there was nothing to eliminate.
          A missing date is never reported as an expired document.
        </p>
      ) : null}
    </section>
  );
}
