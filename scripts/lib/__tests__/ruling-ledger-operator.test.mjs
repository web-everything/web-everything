/** The operator's own "ruling: block" verdict comment as the standing ruling — replayed on the live PR #3794 thread. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readReferralRecords } from '../jury-core.mjs';
import { ignoredRulings, operatorBlockRulings, rulingNeeded, claimSimilarity } from '../ruling-ledger.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conveyor', '__tests__', 'fixtures', 'pr-3794-ignored-ruling.json'), 'utf8'));
const heads = {};
for (const c of fixture.comments) for (const r of readReferralRecords([c], {}).records) heads[r.head.slice(0, 9)] = r.head;
const upto = (n) => fixture.comments.filter((c) => c._liveIndex <= n);
const FIRST = heads.dd32bfb5c, SECOND = heads['13f5a7354'];

describe('operator block rulings', () => {
  it('reads one ruling per paragraph or list item, with the card ids it names', () => {
    const rulings = operatorBlockRulings(fixture.comments);
    expect(rulings.map((r) => r.hints.filter((h) => /^(x[0-9a-z]{6}|\d{3,5})$/.test(h)))).toEqual([['xcs4nce'], ['xcs4nce'], ['xi8vgqq'], ['2940']]);
  });
  it('ignores a ruling written by anyone but the operator', () => {
    const forged = fixture.comments.map((c) => ({ ...c, author: { login: 'stranger' } }));
    expect(operatorBlockRulings(forged)).toEqual([]);
  });
});

describe('PR #3794 replay (live thread)', () => {
  it('the first head after the operator ruled block is sent back, with the original ruling attached', () => {
    const ig = ignoredRulings({ headRefOid: FIRST, comments: upto(43) });
    expect(ig.escalate).toBe(false);
    expect(ig.misses).toBe(1);
    expect(ig.matches).toHaveLength(1);
    const [m] = ig.matches;
    expect(m.finding.file).toMatch(/xcs4nce/);
    expect(m.source).toBe('operator');
    expect(m.ruling).toMatch(/ruling: block/);
    expect(m.ruling).toMatch(/string pointer to another JSON file/);
    expect(m.ruledAt).toBe('2026-10-04T01:19:33.000Z');
  });
  it('the second head it came back on escalates, and shows up as a ruling the operator must give', () => {
    const ig = ignoredRulings({ headRefOid: SECOND, comments: upto(51) });
    expect(ig.misses).toBe(2);
    expect(ig.escalate).toBe(true);
    const need = rulingNeeded({ headRefOid: SECOND, comments: upto(51) });
    expect(need.findings.map((f) => [f.reason, f.file.slice(0, 15)])).toEqual([['dispute', 'backlog/xcs4nce']]);
  });
  it('the other findings on that head (never ruled block) are not flagged', () => {
    const ig = ignoredRulings({ headRefOid: SECOND, comments: upto(51) });
    expect(ig.matches.every((m) => /xcs4nce/.test(m.finding.file))).toBe(true);
  });
  it('is quiet once the operator rules again after seeing the head (the 12:11Z ruling)', () => {
    expect(ignoredRulings({ headRefOid: SECOND, comments: upto(52) })).toBeNull();
    expect(rulingNeeded({ headRefOid: SECOND, comments: upto(52) })).toBeNull();
  });
  it('is quiet on the head the operator ruled about (the finding is still the one being ruled)', () => {
    expect(ignoredRulings({ headRefOid: heads['4c488bb2c'], comments: upto(34) })).toBeNull();
  });
});

describe('claim similarity', () => {
  it('matches a paraphrase of the same claim', () => {
    expect(claimSimilarity('Human-review protection covers the root policy file but omits JSON files that supply policy values through pointers.',
      'the human-review protection registers only the root file as policy-tier, but the Loader allows a string pointer to another JSON file that supplies policy values')).toBeGreaterThanOrEqual(0.5);
  });
  it('does not match a different claim about the same file', () => {
    expect(claimSimilarity('Human-review protection covers the root policy file but omits JSON files that supply policy values through pointers.',
      'The timestamp fallback must never identify an untested main commit as tested.')).toBeLessThan(0.5);
  });
});
