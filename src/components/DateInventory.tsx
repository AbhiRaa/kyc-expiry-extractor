'use client';

import type { DateRole, FoundDate } from '@/types/contract';
import styles from './DateInventory.module.css';

/**
 * `SCREAMING_SNAKE_CASE` → `Screaming snake case`.
 *
 * Exported because reason codes, roles, bases and verdicts all cross the same
 * machine-readable/human-readable boundary, and the rule everywhere in this UI is
 * the same: show the human string *and* keep the raw enum visible, because the
 * raw enum is the contract an integrator codes against (§6).
 */
export function humanizeEnum(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const ROLE_LABELS: Partial<Record<DateRole, string>> = {
  DATE_OF_BIRTH: 'Date of birth',
  ISSUE: 'Issue date',
  EXPIRY: 'Expiry',
  COVERAGE_START: 'Coverage start',
  COVERAGE_END: 'Coverage end',
  STATEMENT_PERIOD_START: 'Period start',
  STATEMENT_PERIOD_END: 'Period end',
  EMPLOYMENT_START: 'Employment start',
  EMPLOYMENT_END: 'Employment end',
  APPRAISAL: 'Appraisal',
  PRINT_DATE: 'Print date',
  TRANSACTION: 'Transaction',
  UNKNOWN: 'Unknown role',
};

/** Display name for a `DateRole`. Falls back to generic prettifying. */
export function humanizeRole(role: DateRole): string {
  return ROLE_LABELS[role] ?? humanizeEnum(role);
}

/** How a candidate ended up: the chosen one, ruled out, or simply not needed. */
export type CandidateStatus = 'selected' | 'eliminated' | 'surviving';

const STATUS_LABEL: Record<CandidateStatus, { glyph: string; text: string }> = {
  selected: { glyph: '✔', text: 'Selected' },
  eliminated: { glyph: '✕', text: 'Ruled out' },
  surviving: { glyph: '–', text: 'Considered' },
};

/**
 * Which candidate the verdict rests on. Matching is by normalized ISO first
 * (the contract's canonical form) and by the raw string second, so a document
 * whose value never normalized still lines up.
 */
export function findSelectedIndex(
  dates: readonly FoundDate[],
  iso: string | null,
  raw: string | null,
): number {
  if (iso) {
    const byIso = dates.findIndex((d) => d.iso === iso && !d.eliminated_by);
    if (byIso >= 0) return byIso;
  }
  if (raw) {
    const byRaw = dates.findIndex((d) => d.raw === raw && !d.eliminated_by);
    if (byRaw >= 0) return byRaw;
  }
  return -1;
}

export function statusOf(
  date: FoundDate,
  index: number,
  selectedIndex: number,
): CandidateStatus {
  if (index === selectedIndex) return 'selected';
  return date.eliminated_by ? 'eliminated' : 'surviving';
}

export interface DateInventoryProps {
  dates: readonly FoundDate[];
  /** Index of the candidate the verdict rests on, or -1 when the system abstained. */
  selectedIndex: number;
}

/**
 * The full date inventory (§10, contract: "Always returned — this is the demo's
 * proof of work").
 *
 * v1 rendered this as a six-column table — status, as read, normalized, label,
 * role, confidence — reflowing to labelled rows below 640px. v2 replaces it with
 * the same row language the rest of the panel uses: a status pill, the string as
 * read, its role, its confidence, all on one line in a bordered well.
 *
 * That is a narrower primary line than the table had, so the three columns it drops
 * are not dropped from the *page*: the normalized ISO, the verbatim label and the
 * eliminating constraint move to a second line that appears only on the rows that
 * actually have something to say. A clean row stays one line; a ruled-out row grows
 * to carry its reason. The audit trail is intact — a 40-page bank statement's
 * transaction dates still each state what removed them — but the common case reads
 * as a list rather than as a spreadsheet, and a phone no longer needs a horizontal
 * scroller to show it.
 *
 * A list rather than a `<table>` follows from that: once a row is two lines of
 * mixed-width content it is no longer tabular data, and marking it up as a table
 * would promise column alignment the layout does not keep.
 */
export default function DateInventory({ dates, selectedIndex }: DateInventoryProps) {
  if (dates.length === 0) {
    return <p className={styles.empty}>No dates were found on this document.</p>;
  }

  return (
    <>
      <p className={styles.caption}>
        Every date string the pipeline saw, in the order it was found.
      </p>
      <ul className={styles.list}>
        {dates.map((date, index) => {
          const status = statusOf(date, index, selectedIndex);
          const label = STATUS_LABEL[status];
          // Only the parts that add something. `iso === raw` on an already-ISO
          // document would just be the same string twice.
          const showIso = Boolean(date.iso) && date.iso !== date.raw;
          const hasMeta = showIso || Boolean(date.label_verbatim) || Boolean(date.eliminated_by);

          return (
            <li key={`${date.raw}-${index}`} className={`${styles.row} ${styles[status]}`}>
              <div className={styles.rowMain}>
                <span className={styles.badge}>
                  <span aria-hidden="true">{label.glyph} </span>
                  {label.text}
                </span>
                <span className={styles.raw}>{date.raw}</span>
                <span className={styles.role}>{humanizeRole(date.inferred_role)}</span>
                <span className={styles.confidence}>{date.confidence.toFixed(2)}</span>
              </div>

              {hasMeta ? (
                <p className={styles.rowMeta}>
                  {showIso ? <span className={styles.mono}>{date.iso}</span> : null}
                  {showIso && date.label_verbatim ? ' · ' : null}
                  {date.label_verbatim ? (
                    <>
                      labelled <q className={styles.mono}>{date.label_verbatim}</q>
                    </>
                  ) : null}
                  {(showIso || date.label_verbatim) && date.eliminated_by ? ' · ' : null}
                  {date.eliminated_by ? (
                    <span className={styles.reason}>{date.eliminated_by}</span>
                  ) : null}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
