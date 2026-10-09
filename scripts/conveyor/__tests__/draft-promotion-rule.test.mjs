// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isDraftOwedPromotion, isPromotionCandidate, promotionStepDue, resolveDraftPromotionSettings,
  DRAFT_PROMOTION_ENV, WITHDRAWN_LABEL,
} from '../draft-promotion-rule.mjs';
import { runDraftPromotionStep, runDraftPromotionIfDue } from '../draft-promotion-loop.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/draft-promotion/pr4567-2026-10-09.json', import.meta.url), 'utf8'));
const SHA = 'a'.repeat(40);
const draft = (over = {}) => ({ number: 1, state: 'OPEN', isDraft: true, headRefName: 'lane/x', headRefOid: SHA, labels: [], ...over });
const green = { state: 'green', sha: SHA };

describe('isDraftOwedPromotion', () => {
  it('owes a green open lane draft', () => {
    expect(isDraftOwedPromotion({ pr: draft(), checks: green }).owed).toBe(true);
  });
  it.each([
    ['not a draft', draft({ isDraft: false }), green],
    ['closed', draft({ state: 'CLOSED' }), green],
    ['a human branch', draft({ headRefName: 'feature/x' }), green],
    ['withdrawn', draft({ labels: [{ name: WITHDRAWN_LABEL }] }), green],
    ['pending checks', draft(), { state: 'pending', sha: SHA }],
    ['red checks', draft(), { state: 'red', sha: SHA }],
    ['checks for another head', draft(), { state: 'green', sha: 'b'.repeat(40) }],
    ['checks not read', draft(), null],
  ])('does not owe it when %s', (_, pr, checks) => {
    expect(isDraftOwedPromotion({ pr, checks }).owed).toBe(false);
  });
  it('candidate pre-filter needs no check read', () => {
    expect(isPromotionCandidate(draft())).toBe(true);
    expect(isPromotionCandidate(draft({ isDraft: false }))).toBe(false);
  });
});

describe('resolveDraftPromotionSettings', () => {
  const read = (obj) => () => JSON.stringify(obj);
  it('missing file → off (before this change)', () => {
    expect(resolveDraftPromotionSettings({}, { read: () => { throw new Error('ENOENT'); } })).toEqual({ loop: false, intervalSeconds: 60 });
  });
  it('the shipped file turns the loop on at 60s', () => {
    expect(resolveDraftPromotionSettings({})).toEqual({ loop: true, intervalSeconds: 60 });
  });
  it('env beats the file; a garbled switch fails off; a too-short interval is ignored', () => {
    const file = read({ draftPromotion: { loop: 'on', intervalSeconds: 90 } });
    expect(resolveDraftPromotionSettings({ [DRAFT_PROMOTION_ENV.loop]: 'off' }, { read: file }).loop).toBe(false);
    expect(resolveDraftPromotionSettings({ [DRAFT_PROMOTION_ENV.loop]: 'maybe' }, { read: file }).loop).toBe(false);
    expect(resolveDraftPromotionSettings({ [DRAFT_PROMOTION_ENV.intervalSeconds]: '3' }, { read: file }).intervalSeconds).toBe(90);
  });
  it('promotionStepDue respects the switch and the interval', () => {
    const settings = { loop: true, intervalSeconds: 60 };
    expect(promotionStepDue({ settings: { ...settings, loop: false }, nowMs: 0 })).toBe(false);
    expect(promotionStepDue({ settings, lastRunAtMs: null, nowMs: 0 })).toBe(true);
    expect(promotionStepDue({ settings, lastRunAtMs: 0, nowMs: 59_999 })).toBe(false);
    expect(promotionStepDue({ settings, lastRunAtMs: 0, nowMs: 60_000 })).toBe(true);
  });
});

describe('replay: #4567/#4563/#4535 green drafts left unpromoted (2026-10-09)', () => {
  const run = (over = {}) => {
    const readied = [];
    const result = runDraftPromotionStep({
      repos: [fixture.repo],
      listDrafts: () => fixture.drafts,
      readHeadCheckState: ({ sha }) => fixture.checksBySha[sha],
      readPrLabels: ({ prNumber }) => fixture.drafts.find((d) => d.number === prNumber).labels,
      ready: (_repo, pr) => { readied.push(pr); },
      clearAwaiting: () => {},
      ...over,
    });
    return { result, readied };
  };
  it('promotes every green lane draft in the live snapshot', () => {
    const { readied, result } = run();
    expect(readied.sort()).toEqual([...fixture.expectPromoted].sort());
    expect(result.rows.every((r) => r.action === 'promoted')).toBe(true);
  });
  it('a fresh red read on the head refuses the write (#2811 stale-green)', () => {
    const { readied } = run({ readHeadCheckState: () => ({ state: 'red' }) });
    expect(readied).toEqual([]);
  });
  it('a withdrawal that lands after the list read refuses the write', () => {
    const { readied } = run({ readPrLabels: () => [{ name: WITHDRAWN_LABEL }] });
    expect(readied).toEqual([]);
  });
  it('a failed read or write is a row, never a throw', () => {
    const { result } = run({ ready: () => { throw new Error('boom'); } });
    expect(result.rows.every((r) => r.action === 'error')).toBe(true);
    expect(run({ listDrafts: () => { throw new Error('rate limit'); } }).result.rows[0].action).toBe('error');
  });
});

describe('runDraftPromotionIfDue (the await-verify child hook)', () => {
  const settings = () => ({ loop: true, intervalSeconds: 60 });
  it('runs when due, then waits out the interval, and dedups repeated skip lines', () => {
    const lines = [];
    const step = () => ({ rows: [{ repo: 'r', pr: 1, action: 'skip', why: 'required checks read pending, not green' }] });
    let s = runDraftPromotionIfDue({ write: (l) => lines.push(l), now: () => 0, resolveSettings: settings, step });
    expect(s.ran).toBe(true);
    s = runDraftPromotionIfDue({ ...s, write: (l) => lines.push(l), now: () => 30_000, resolveSettings: settings, step });
    expect(s.ran).toBe(false);
    s = runDraftPromotionIfDue({ ...s, write: (l) => lines.push(l), now: () => 61_000, resolveSettings: settings, step });
    expect(s.ran).toBe(true);
    expect(lines).toHaveLength(1);
  });
  it('setting off never runs the step; a throwing step never escapes', () => {
    const off = runDraftPromotionIfDue({ write: () => {}, now: () => 0, resolveSettings: () => ({ loop: false, intervalSeconds: 60 }), step: () => { throw new Error('x'); } });
    expect(off.ran).toBe(false);
    const lines = [];
    const on = runDraftPromotionIfDue({ write: (l) => lines.push(l), now: () => 0, resolveSettings: settings, step: () => { throw new Error('x'); } });
    expect(on.ran).toBe(true);
    expect(lines[0]).toMatch(/draft-promotion: error/);
  });
});
