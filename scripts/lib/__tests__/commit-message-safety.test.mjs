/**
 * @file commit-message-safety.test.mjs — proof of the #2779-incident guard (2026-09-26 03:14Z, PR #2785/#2779).
 * See `../commit-message-safety.mjs`'s own docstring for the full incident account: the drain's
 * `drain: resolve #2779 on land (#2748)` commit message closed the real, unmerged PR #2779 as a GitHub
 * closing-keyword side effect of a routine backlog-status commit.
 */
import { describe, it, expect } from 'vitest';
import { hasClosingKeywordRef, assertNoClosingKeywordRef } from '../commit-message-safety.mjs';

describe('hasClosingKeywordRef — qualified refs (#6774 round 2)', () => {
  it('matches owner/repo#N and full issue/PR URLs after a closing keyword', () => {
    expect(hasClosingKeywordRef('Fixes owner/repo#6774')).toBe(true);
    expect(hasClosingKeywordRef('resolves https://github.com/o/r/issues/12')).toBe(true);
    expect(hasClosingKeywordRef('see owner/repo#6774')).toBe(false);
  });

  // #6774 round 3 — a word that merely STARTS with a closing verb ("fixtures", "closer", "fix-it", "prefix") is not
  // a keyword; GitHub needs the keyword as a whole word followed by a separator before a qualified/URL/GH- ref.
  it.each([
    'see fixtures/foo#12', 'closer/x#1', 'resolvers/a.b#3', 'prefix/foo#12', 'fix-it/foo#1', 'fixed-in/x#2',
    'closes.txt/y#4', 'fixtures#12', 'fixGH-12', 'closehttps://github.com/o/r/pull/1', 'unfixed GH12',
  ])('a path-like token that only starts with a closing verb is NOT flagged: %s', (text) => {
    expect(hasClosingKeywordRef(text)).toBe(false);
  });

  // Table-driven over GitHub's linked-issue reference forms (docs: "Linking a pull request to an issue").
  it.each([
    'Fixes #6774', 'fixes: #6774', 'fix#6774', 'Closes owner/repo#6774', 'closes: owner/repo#6774',
    'Resolves https://github.com/o/r/issues/12', 'resolved: https://github.com/o/r/pull/12',
    'Fixes GH-6774', 'fixes: gh-6774', 'Closed GH-1',
  ])('every GitHub closing reference form is detected: %s', (text) => {
    expect(hasClosingKeywordRef(text)).toBe(true);
  });

  it('every positive match has a separator (whitespace or colon) or a direct # after the keyword', () => {
    const samples = ['Fixes owner/repo#1', 'closes:o/r#2', 'resolve https://github.com/o/r/issues/3', 'fix GH-4', 'fix#5', 'see fixtures/x#6'];
    const KW = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:\s*|\s+|(?=#))/i;
    for (const s of samples) if (hasClosingKeywordRef(s)) expect(s).toMatch(KW);
  });
});

describe('hasClosingKeywordRef', () => {
  it('the exact incident shape: "resolve #N" is a closing-keyword reference', () => {
    expect(hasClosingKeywordRef('drain: resolve #2779 on land (#2748)')).toBe(true);
  });

  it.each([
    'close', 'closes', 'closed',
    'fix', 'fixes', 'fixed',
    'resolve', 'resolves', 'resolved',
  ])('every GitHub closing-keyword form ("%s") followed by #N is detected', (kw) => {
    expect(hasClosingKeywordRef(`drain: ${kw} #4200 on land`)).toBe(true);
    expect(hasClosingKeywordRef(`DRAIN: ${kw.toUpperCase()} #4200 ON LAND`)).toBe(true); // case-insensitive, like GitHub's own matcher
  });

  it('a colon between the keyword and #N still counts ("resolve: #N", GitHub accepts both)', () => {
    expect(hasClosingKeywordRef('drain: resolves: #4200 on land')).toBe(true);
  });

  it('the trailing epic citation alone — "(#2748)" with no keyword immediately before it — is NOT flagged', () => {
    expect(hasClosingKeywordRef('drain: unqueue + cleanup card 2200 lane manifest post-land (#2175)')).toBe(false);
    expect(hasClosingKeywordRef('drain: JIT-number xabc123→#2202 at land (#2288)')).toBe(false);
  });

  it('the fixed template — "card N" with no "#" sigil on the item number — is NOT flagged', () => {
    expect(hasClosingKeywordRef('drain: mark card 2779 resolved on land (#2748)')).toBe(false);
  });

  it('a keyword mentioned WITHOUT a following #N is not flagged (prose, not a GitHub directive)', () => {
    expect(hasClosingKeywordRef('drain: resolved the numbering race')).toBe(false);
    expect(hasClosingKeywordRef('this fixes the underlying bug')).toBe(false);
  });

  it('a bare #N with no keyword before it is not flagged (a citation, not a closing reference)', () => {
    expect(hasClosingKeywordRef('drain: reopen stranded card 2175 after failed land (#2175)')).toBe(false);
    expect(hasClosingKeywordRef('see #2175 for background')).toBe(false);
  });

  it('null/undefined/empty input is inert, never throws', () => {
    expect(hasClosingKeywordRef(null)).toBe(false);
    expect(hasClosingKeywordRef(undefined)).toBe(false);
    expect(hasClosingKeywordRef('')).toBe(false);
  });
});

describe('assertNoClosingKeywordRef', () => {
  it('returns the text unchanged when safe (so it can wrap a message-building expression at the call site)', () => {
    const msg = 'drain: mark card 2779 resolved on land (#2748)';
    expect(assertNoClosingKeywordRef(msg)).toBe(msg);
  });

  it('throws on the exact incident shape, naming the offending text in the error', () => {
    expect(() => assertNoClosingKeywordRef('drain: resolve #2779 on land (#2748)', 'resolve-on-land commit message'))
      .toThrow(/resolve-on-land commit message/);
    expect(() => assertNoClosingKeywordRef('drain: resolve #2779 on land (#2748)'))
      .toThrow(/#2779-incident guard/);
  });
});
