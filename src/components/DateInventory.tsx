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
 * It is deliberately a *table* rather than the card list the why-panel uses: the
 * why-panel argues, this enumerates. A reviewer scanning a bank statement with 40
 * transaction dates wants dense aligned columns, not 40 paragraphs. Below 640px
 * the table reflows into labelled rows, because a six-column table at 375px is
 * unreadable no matter how it is styled.
 */
export default function DateInventory({ dates, selectedIndex }: DateInventoryProps) {
  if (dates.length === 0) {
    return <p className={styles.empty}>No dates were found on this document.</p>;
  }

  return (
    <div className={styles.scroller}>
      <table className={styles.table}>
        <caption className={styles.caption}>
          Every date string the pipeline saw, in the order it was found.
        </caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">As read</th>
            <th scope="col">Normalized</th>
            <th scope="col">Label on document</th>
            <th scope="col">Role</th>
            <th scope="col">Conf.</th>
          </tr>
        </thead>
        <tbody>
          {dates.map((date, index) => {
            const status = statusOf(date, index, selectedIndex);
            return (
              <tr key={`${date.raw}-${index}`} className={styles[status]}>
                <td data-label="Status">
                  <span className={`${styles.badge} ${styles[`badge_${status}`]}`}>
                    {status === 'selected'
                      ? '✔ Selected'
                      : status === 'eliminated'
                        ? '✕ Ruled out'
                        : '– Considered'}
                  </span>
                  {date.eliminated_by ? (
                    <span className={styles.reason}>{date.eliminated_by}</span>
                  ) : null}
                </td>
                <td data-label="As read" className={styles.mono}>
                  {date.raw}
                </td>
                <td data-label="Normalized" className={styles.mono}>
                  {date.iso ?? <span className={styles.null}>not normalizable</span>}
                </td>
                <td data-label="Label on document">
                  {date.label_verbatim ?? <span className={styles.null}>unlabelled</span>}
                </td>
                <td data-label="Role">{humanizeRole(date.inferred_role)}</td>
                <td data-label="Confidence" className={styles.mono}>
                  {date.confidence.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
