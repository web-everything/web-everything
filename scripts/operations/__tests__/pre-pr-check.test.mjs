/**
 * @file scripts/operations/__tests__/pre-pr-check.test.mjs
 * @description xcbwt4r — the `pre-pr-check` helper answers gated-or-not and prints the exact receipt commands;
 *   open-pr's advise message carries the same commands.
 */
import { describe, it, expect } from 'vitest';
import { assessPrePrCheck, finishPrePrCheckOutcome, prePrCheckOperation } from '../pre-pr-check.mjs';
import { prePrReviewCommands, decidePrePrReview } from '../../lib/pre-pr-review.mjs';

const LANE = '/w/.lanes/we/lane-7';
const gatedDecision = { action: 'advise', why: 'receipt-missing', risk: { gated: true, reasons: ['300 lines changed (> 264)'], lines: 300, subsystems: 1, files: 2 }, settings: { mode: 'advise' } };

describe('prePrReviewCommands', () => {
  it('prints the init, loop, commit and receipt commands for the lane', () => {
    const c = prePrReviewCommands(LANE);
    expect(c.init).toBe(`node scripts/converge-cli.mjs init --lane=${LANE} --state=${LANE}/.converge-state.json --care=elevated --goal="<one sentence: what this work does>"`);
    expect(c.receipt).toBe(`node scripts/converge-cli.mjs receipt --lane=${LANE} --state=${LANE}/.converge-state.json`);
  });
  it('quotes a lane path with spaces', () => {
    expect(prePrReviewCommands('/a b/lane').receipt).toContain("--lane='/a b/lane'");
  });
});

describe('assessPrePrCheck', () => {
  it('gated with no receipt: needs review and carries the commands', () => {
    const v = assessPrePrCheck({ checkout: LANE, decision: gatedDecision });
    expect(v).toMatchObject({ gated: true, needsReview: true, why: 'receipt-missing' });
    expect(v.next).toContain('converge-cli.mjs receipt');
  });
  it('gated with a valid receipt: nothing more to run', () => {
    const v = assessPrePrCheck({ checkout: LANE, decision: { ...gatedDecision, action: 'pass', why: 'receipt' } });
    expect(v).toMatchObject({ gated: true, needsReview: false, next: '' });
  });
  it('card-only is not gated', () => {
    const v = assessPrePrCheck({ checkout: LANE, decision: { action: 'pass', why: 'card-only', risk: { gated: false, reasons: [] }, settings: { mode: 'advise' } } });
    expect(v).toMatchObject({ gated: false, needsReview: false });
  });
  it('fails closed: an error reads as gated', () => {
    expect(assessPrePrCheck({ checkout: LANE, error: 'boom' })).toMatchObject({ gated: true, needsReview: true, why: 'check-error' });
  });
});

describe('finishPrePrCheckOutcome', () => {
  it('leads with gated and lists the four numbered commands', () => {
    const verdict = assessPrePrCheck({ checkout: LANE, decision: gatedDecision });
    const { lines } = finishPrePrCheckOutcome({ run: { verdict }, code: 0, lines: ['x'] });
    expect(lines[0]).toMatch(/^pre-pr-check: gated/);
    expect(lines.join('\n')).toMatch(/1\. node scripts\/converge-cli\.mjs init[\s\S]*4\. node scripts\/converge-cli\.mjs receipt/);
  });
  it('says not gated in one line', () => {
    const verdict = assessPrePrCheck({ checkout: LANE, decision: { action: 'pass', why: 'low-risk', risk: { gated: false, reasons: [] }, settings: { mode: 'advise' } } });
    const { lines } = finishPrePrCheckOutcome({ run: { verdict }, code: 0, lines: ['x'] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pre-pr-check: not gated/);
  });
});

describe('open-pr advise message', () => {
  it('prints the same receipt command the helper prints', () => {
    const risk = { gated: true, cardOnly: false, reasons: ['6 files (> 5)'] };
    const d = decidePrePrReview({ settings: { mode: 'advise' }, risk, receipt: null, headTree: 't', baseSha: 'b', lane: LANE });
    expect(d.action).toBe('advise');
    expect(d.message).toContain(prePrReviewCommands(LANE).receipt);
    expect(d.message).toContain(`pre-pr-check --checkout=${LANE}`);
  });
});

describe('prePrCheckOperation', () => {
  it('needs a reader', () => { expect(() => prePrCheckOperation({})).toThrow(/check reader/); });
});
