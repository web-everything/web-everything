/**
 * @file scripts/conveyor/health-smells/__tests__/queue-smells.test.mjs
 * @description #4066 — seed smells 9–11 (open PRs over the backpressure limit, contradictory/stray review labels,
 *   stood-down PRs), each driven through the slice-1 core (`runHealthTick`) on fixture PR records shaped like
 *   `health-watch.mjs#probePrs`'s output.
 */
import { describe, it, expect } from 'vitest';
import { runHealthTick, emptyHealthState, MINUTE, HOUR } from '../../health-watch-core.mjs';
import { STAND_DOWN_MARKER, CONCURRENT_AUTHOR_PAUSE_MARKER } from '../../stand-down.mjs';
import { PR_LIMIT_DEFAULTS } from '../../../lib/pr-limit.mjs';
import overLimit from '../open-prs-over-limit.mjs';
import labelConflict, { labelConflicts } from '../review-label-conflict.mjs';
import stoodDown, { standDownOf } from '../stood-down-prs.mjs';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const WE = 'web-everything/web-everything';
const FUI = 'frontier-ui/frontierui';

const pr = (repo, number, labels = [], comments = []) => ({ repo, number, labels: labels.map((name) => ({ name })), comments });

function ticks(smell, probesPerTick) {
  let state = emptyHealthState();
  let last;
  probesPerTick.forEach((probes, i) => {
    last = runHealthTick(state, probes, [smell], NOW + i * 15 * MINUTE);
    state = last.state;
  });
  return last;
}

describe('open-prs-over-limit', () => {
  const limits = { ...PR_LIMIT_DEFAULTS };
  const wePrs = (n, accepted = 0) => Array.from({ length: n }, (_, i) => pr(WE, i + 1, i < accepted ? ['review:accepted'] : ['review:pending']));

  it('opens when unaccepted open PRs exceed the limit read from pr-limit (WE: 15) for two samples', () => {
    const probes = { prs: wePrs(18), prLimit: { limits, globalOff: false } };
    const r = ticks(overLimit, [probes, probes]);
    expect(r.transitions.map((t) => t.key)).toEqual([`open-prs-over-limit::${WE}`]);
    expect(r.state.episodes[`open-prs-over-limit::${WE}`].measure).toMatchObject({ unaccepted: 18, limit: 15, countIsUpperBound: true });
    // the deterministic diagnosis is the backpressure module's own exact count
    expect(r.plan.find((p) => p.kind === 'diagnose').diagnose.args).toEqual(['scripts/operations/pr-limit.mjs', 'status']);
  });

  it('review:accepted PRs are not counted, and AT the limit is the limit working — no breach', () => {
    expect(ticks(overLimit, [{ prs: wePrs(20, 5), prLimit: { limits, globalOff: false } }]).evaluations[0].results[0]).toMatchObject({ breach: false, measure: { unaccepted: 15 } });
  });

  it('never breaches while the operator has the limit globally off', () => {
    const probes = { prs: wePrs(30), prLimit: { limits, globalOff: true } };
    const r = ticks(overLimit, [probes, probes]);
    expect(r.transitions).toEqual([]);
    expect(r.evaluations[0].results[0].recommendation).toContain('turned the limit off');
  });

  it('each repo is held to its own limit (frontierui: 5)', () => {
    const prs = [...wePrs(10), ...Array.from({ length: 6 }, (_, i) => pr(FUI, i + 1))];
    const res = ticks(overLimit, [{ prs, prLimit: { limits, globalOff: false } }]).evaluations[0].results;
    expect(res.find((x) => x.subject === WE).breach).toBe(false);
    expect(res.find((x) => x.subject === FUI).breach).toBe(true);
  });
});

describe('review-label-conflict', () => {
  it('names every contradiction class', () => {
    expect(labelConflicts(['review:accepted', 'review:changes'])).toEqual(['two verdicts at once: review:accepted + review:changes']);
    expect(labelConflicts(['review:pending', 'review:accepted'])).toHaveLength(1);
    expect(labelConflicts(['review:awaiting-advisory'])).toEqual(['review:awaiting-advisory without review:human']);
    expect(labelConflicts(['review-status:reviewing', 'review-status:fixing'])).toEqual(['more than one review-status: review-status:reviewing + review-status:fixing']);
    expect(labelConflicts(['review-status:stood-down', 'review-status:fixing'])).toEqual(['review-status:stood-down while review-status:fixing']);
    expect(labelConflicts(['review:aproved'])).toEqual(['stray label review:aproved']);
  });

  it('leaves consistent label sets alone', () => {
    for (const set of [
      ['review:pending', 'review-status:reviewing'],
      ['review:human', 'review:awaiting-advisory'],
      ['review:human', 'review:accepted'],
      ['review:accepted', 'redteam:accepted', 'ready-to-merge'],
      ['review-status:stood-down'],
      [],
    ]) expect(labelConflicts(set), set.join(',')).toEqual([]);
  });

  it('opens per PR after two samples, plans a (held) filing request with its known-fix template', () => {
    const probes = { prs: [pr(WE, 7, ['review:accepted', 'review:changes']), pr(WE, 8, ['review:pending'])] };
    const one = ticks(labelConflict, [probes]);
    expect(one.transitions).toEqual([]); // a label write in flight is never one inconsistent state
    const r = ticks(labelConflict, [probes, probes]);
    expect(r.transitions.map((t) => t.key)).toEqual([`review-label-conflict::${WE}#7`]);
    expect(r.plan.find((p) => p.kind === 'file')).toMatchObject({ suppressed: expect.stringContaining('fileDispatch') });
    expect(labelConflict.knownFix.title).toContain('${subject}');
  });
});

describe('stood-down-prs', () => {
  const sd = (hoursAgo, why = 'the rebase needs a human') => ({
    body: `${STAND_DOWN_MARKER}\n\nconveyor fix agent stopped rather than guessing: ${why}.`,
    createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(), author: { login: 'chalbert' },
  });

  it('standDownOf reads the same markers the operator queue counts — trusted author, never a concurrent-author pause', () => {
    expect(standDownOf(pr(WE, 1, [], [sd(3)]))).toMatchObject({ reason: 'the rebase needs a human' });
    expect(standDownOf(pr(WE, 1, ['review-status:stood-down']))).toMatchObject({ standDownAt: null });
    expect(standDownOf(pr(WE, 1, [], [{ ...sd(3), author: { login: 'random-user' } }]))).toBeNull();
    expect(standDownOf(pr(WE, 1, [], [{ body: `${CONCURRENT_AUTHOR_PAUSE_MARKER}\n…`, author: { login: 'chalbert' } }]))).toBeNull();
    expect(standDownOf(pr(WE, 1, ['review:pending']))).toBeNull();
  });

  it('opens at 5 stood-down open PRs in one repo, oldest first in the recommendation', () => {
    const prs = [1, 2, 3, 4, 5].map((n) => pr(WE, n, [], [sd(n * 2, `reason ${n}`)]));
    const r = ticks(stoodDown, [{ prs }]);
    expect(r.transitions.map((t) => t.key)).toEqual([`stood-down-prs::${WE}`]);
    const ep = r.state.episodes[`stood-down-prs::${WE}`];
    expect(ep.measure.stoodDown).toBe(5);
    expect(ep.recommendation).toMatch(/^5 PRs in .* oldest first: #5 \(10h00m\) — reason 5/);
  });

  it('4 is below the threshold', () => {
    const prs = [1, 2, 3, 4].map((n) => pr(WE, n, [], [sd(n)]));
    expect(ticks(stoodDown, [{ prs }]).evaluations[0].results[0].breach).toBe(false);
  });
});
