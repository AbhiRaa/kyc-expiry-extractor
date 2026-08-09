/**
 * Label lexicon tests (§7 TB).
 *
 * Pure string logic — no OCR, no fixtures. The point of separating these from the tier
 * tests is that the lexicon's failure modes are *false positives*, and false positives are
 * cheapest to pin down here: a threshold that lets "EYE" match "EXP" cannot be diagnosed
 * from a tier-level assertion about an extracted date.
 */

import { describe, expect, it } from 'vitest';

import {
  FUZZY_MATCH_THRESHOLD,
  LABEL_LEXICON,
  MAX_LABEL_WORDS,
  hasAamvaFieldCodeLayout,
  isNoExpirySentinel,
  levenshtein,
  matchLabelPhrase,
  normalizeLabelText,
  similarityRatio,
} from '@/pipeline/label-lexicon';

/** Verbatim from §7 TB. If the spec's lexicon changes, this list is the thing to update. */
const SPEC_LABELS = [
  'EXP',
  'EXP.',
  'EXPIRES',
  'EXPIRATION',
  'EXPIRATION DATE',
  'EXPIRY',
  'EXPIRY DATE',
  'DATE OF EXPIRY',
  'DATE OF EXPIRATION',
  'VALID THRU',
  'VALID THROUGH',
  'VALID UNTIL',
  'VALID TO',
  'ENDS ON',
  'END DATE',
  'GOOD THRU',
  'GOOD THROUGH',
  'NOT VALID AFTER',
  'EXPIRE LE',
  'FECHA DE VENCIMIENTO',
];

describe('normalizeLabelText', () => {
  it('case-folds, strips punctuation and collapses whitespace (§7 TB)', () => {
    expect(normalizeLabelText('Exp.')).toBe('EXP');
    expect(normalizeLabelText('  expiry   date  ')).toBe('EXPIRY DATE');
    expect(normalizeLabelText('VALID\nTHRU')).toBe('VALID THRU');
    expect(normalizeLabelText('N/A')).toBe('N A');
  });

  it('strips diacritics so an OCR-invented accent cannot break a match', () => {
    expect(normalizeLabelText('Expire lé')).toBe('EXPIRE LE');
    expect(normalizeLabelText('FECHA DE VENCIMIÉNTO')).toBe('FECHA DE VENCIMIENTO');
  });
});

describe('similarity', () => {
  it('computes edit distance', () => {
    expect(levenshtein('EXPIRES', 'EXPIRES')).toBe(0);
    expect(levenshtein('EXPIRES', 'EXPIRFS')).toBe(1);
    expect(levenshtein('', 'EXP')).toBe(3);
  });

  it('reports a ratio in [0,1] normalized on the longer string', () => {
    expect(similarityRatio('EXPIRES', 'EXPIRES')).toBe(1);
    expect(similarityRatio('EXPIRES', 'EXPIRFS')).toBeCloseTo(6 / 7, 5);
    expect(similarityRatio('', '')).toBe(1);
  });
});

describe('lexicon coverage', () => {
  it('matches every label the spec lists, as an expiry label', () => {
    for (const label of SPEC_LABELS) {
      const match = matchLabelPhrase(label);
      expect(match, label).not.toBeNull();
      expect(match!.exact, label).toBe(true);
      expect(match!.entry.role, label).toBe('EXPIRY');
    }
  });

  it('is whitespace- and case-tolerant on multi-word labels', () => {
    expect(matchLabelPhrase('  fecha  de   vencimiento ')?.entry.display).toBe(
      'FECHA DE VENCIMIENTO',
    );
    expect(matchLabelPhrase('Not Valid After')?.entry.display).toBe('NOT VALID AFTER');
  });

  it('exposes the widest label window a caller must try', () => {
    expect(MAX_LABEL_WORDS).toBe(3); // "FECHA DE VENCIMIENTO", "DATE OF EXPIRATION"
  });
});

describe('fuzzy matching', () => {
  it('survives OCR noise on long labels at the spec ratio (§7 TB)', () => {
    const match = matchLabelPhrase('EXPIRAT10N DATE');
    expect(match?.entry.display).toBe('EXPIRATION DATE');
    expect(match?.exact).toBe(false);
    expect(match!.score).toBeGreaterThanOrEqual(FUZZY_MATCH_THRESHOLD);
  });

  it('accepts a single substitution in a seven-character label', () => {
    expect(matchLabelPhrase('EXPIRFS')?.entry.display).toBe('EXPIRES');
  });

  it('refuses to fuzzy-match short labels, where any tolerance is noise', () => {
    expect(matchLabelPhrase('EYP')).toBeNull();
    expect(matchLabelPhrase('SEX')).toBeNull();
    expect(matchLabelPhrase('EXP')?.exact).toBe(true);
  });

  it('rejects phrases that are simply a different length', () => {
    expect(matchLabelPhrase('EXPIRATION DATE OF BIRTH OF HOLDER')).toBeNull();
    expect(matchLabelPhrase('')).toBeNull();
  });
});

describe('AAMVA printed field codes (§4.1, §7 TB)', () => {
  it('maps the three codes to their roles', () => {
    expect(matchLabelPhrase('4a')?.entry.role).toBe('ISSUE');
    expect(matchLabelPhrase('4b')?.entry.role).toBe('EXPIRY');
    expect(matchLabelPhrase('3')?.entry.role).toBe('DATE_OF_BIRTH');
  });

  it('is case-insensitive but never fuzzy — a 2-char code has no error budget', () => {
    expect(matchLabelPhrase('4B')?.entry.role).toBe('EXPIRY');
    expect(matchLabelPhrase('Ab')).toBeNull();
    expect(matchLabelPhrase('48')).toBeNull();
    expect(matchLabelPhrase('4')).toBeNull();
  });

  it('flags only the bare numeric code as needing corroboration', () => {
    const byCanonical = new Map(LABEL_LEXICON.map((entry) => [entry.canonical, entry]));
    expect(byCanonical.get('3')!.requiresCorroboration).toBe(true);
    expect(byCanonical.get('4A')!.requiresCorroboration).toBe(false);
    expect(byCanonical.get('4B')!.requiresCorroboration).toBe(false);
    expect(byCanonical.get('EXP')!.requiresCorroboration).toBe(false);
  });

  it('detects the field-code layout that licenses trusting a bare "3"', () => {
    expect(hasAamvaFieldCodeLayout(['3', '07/09/1985'])).toBe(false);
    expect(hasAamvaFieldCodeLayout(['SMITH', '4b', '03/14/2029'])).toBe(true);
    expect(hasAamvaFieldCodeLayout(['4d', 'D12345678'])).toBe(true);
  });
});

describe('no-expiry sentinels (§11.4 #48)', () => {
  it('recognises the printed denials of an expiry date', () => {
    expect(isNoExpirySentinel('NONE')).toBe(true);
    expect(isNoExpirySentinel('none')).toBe(true);
    expect(isNoExpirySentinel('N/A')).toBe(true);
    expect(isNoExpirySentinel('Indefinite')).toBe(true);
    expect(isNoExpirySentinel('NON-EXPIRING')).toBe(true);
  });

  it('does not mistake a date or a name for one', () => {
    expect(isNoExpirySentinel('03/14/2029')).toBe(false);
    expect(isNoExpirySentinel('NANCY')).toBe(false);
  });
});
