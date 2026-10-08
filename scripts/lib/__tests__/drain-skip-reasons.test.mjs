import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unlandableStateReason } from '../../merge-ai-prs.mjs';
import { buildSkipReasons, classifySkipReason, formatSkipSummary, formatSkipReasonsLine } from '../drain-skip-reasons.mjs';

describe('drain skip reasons (card 122 slice 1)', () => {
  it('a pass with 3 ready PRs, 1 landed and 2 skipped for different reasons, lists both reasons', () => {
    const verdicts = [
      { num: 101, repo: null, decision: 'merge' },
      { num: 102, repo: null, decision: 'merge' },
      { num: 103, repo: null, decision: 'merge' },
    ];
    const rows = buildSkipReasons({
      verdicts,
      merged: [{ num: 101, repo: null }],
      revalidationAborted: [{ num: 102, repo: null, reason: 'not mergeable (mergeable=UNKNOWN)' }],
      coupleHeld: [{ num: 103, repo: null, reason: 'its impl half was held', role: 'carrier' }],
    });
    expect(rows.map((r) => [r.num, r.kind])).toEqual([[102, 'unknown-mergeability'], [103, 'couple-held']]);
    expect(formatSkipSummary(rows)).toBe('skipped 2: #102 unknown-mergeability, #103 couple-held');
    expect(JSON.parse(formatSkipReasonsLine(rows).split('skip-reasons: ')[1])).toEqual(rows);
  });
  it('classifies the common drain reasons', () => {
    expect(classifySkipReason('merge state BEHIND (BEHIND⇒needs rebase, DIRTY/BLOCKED/DRAFT⇒not landable) — left for its author')).toBe('behind');
    expect(classifySkipReason('required check "test" is not green')).toBe('checks-pending');
    expect(classifySkipReason('unsatisfied review hold ("review:human") present without review:accepted')).toBe('review-hold');
    expect(classifySkipReason('head moved since the pass-start decision (a → b)')).toBe('head-moved');
  });
  it('accounts for a ready PR no bucket explained, and never lists a landed one', () => {
    const rows = buildSkipReasons({ verdicts: [{ num: 1, decision: 'merge' }, { num: 2, decision: 'merge' }], merged: [{ num: 1 }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ num: 2, kind: 'ready-not-reached', source: 'unaccounted' });
  });
  it('names the couple partner instead of "other" (plateau-app #212 sat 86 passes unexplained)', () => {
    const rows = buildSkipReasons({ verdicts: [
      { num: 212, repo: 'plateau-app', decision: 'merge', item: 4288 },
      { num: 4288, repo: null, decision: 'skip', item: 4288, reason: 'required check "test" is not green' },
    ] });
    expect(rows.find((r) => r.num === 212)).toMatchObject({ kind: 'partner-pending', source: 'unaccounted' });
    expect(rows.find((r) => r.num === 212).reason).toMatch(/#4288.*checks-pending/);
  });
  it('never emits the "other" bucket, for any skip reason', () => {
    for (const r of ['', undefined, 'something new', 'not AI-generated (x)', 'base is not main (y)', 'CodeQL check failed',
      'empty/whitespace description — x', 'could not re-read the PR fresh right before merging', 'test-gaming suspected']) {
      expect(classifySkipReason(r)).not.toBe('other');
    }
    expect(classifySkipReason('something new')).toBe('unrecognized-reason');
    expect(buildSkipReasons({ verdicts: [{ num: 9, decision: 'skip', reason: 'x', escalated: 'yes' }] })[0].kind).toBe('escalated');
  });
  it('the drain wires it into the result and the summary line', () => {
    const src = readFileSync(resolve(process.cwd(), 'scripts/merge-ai-prs.mjs'), 'utf8');
    expect(src).toMatch(/heldCoupleMembers, skipReasons,/);
    expect(src).toMatch(/formatSkipReasonsLine\(skipReasons\)/);
    expect(src).toMatch(/formatSkipSummary\(skipReasons\)/);
  });

  it('a BLOCKED merge state is not classified as behind (#4235 was read as an unowned rebase)', () => {
    expect(classifySkipReason(unlandableStateReason('BLOCKED'))).toBe('checks-pending');
    expect(unlandableStateReason('BLOCKED')).toMatch(/ci-heal/);
    expect(classifySkipReason(unlandableStateReason('BEHIND'))).toBe('behind');
  });
});
