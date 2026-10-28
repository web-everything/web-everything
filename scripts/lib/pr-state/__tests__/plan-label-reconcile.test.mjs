import { describe, expect, it } from 'vitest';
import { planLabelReconcile } from '../plan-label-reconcile.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const START = 1_790_000_000_000;
const iso = offset => new Date(START + offset).toISOString();
const config = () => ({
  statusLabels: true,
  confirmedBreaks: { broken: 'send-back', degraded: 'hold', unconfirmed: 'advisory' },
});
const options = () => ({ config: config(), standingRuling: null });
const run = (overrides = {}) => ({
  id: 'run-1', head: HEAD, startedAt: START, completedAt: START + 1000,
  verdict: 'accept', confirm: 'accept', publishedAccept: true, parked: false, ...overrides,
});
const comment = (overrides = {}) => ({
  id: 'comment-1', author: { login: 'reviewer' }, body: '🔁 review — changes requested',
  createdAt: iso(-1000), lastEditedAt: null, ...overrides,
});
const snapshot = (overrides = {}) => ({
  head: HEAD, labels: [], labelsVersion: iso(2000), comments: [], reviews: [],
  openReferrals: [], standingRulings: [], holdEventIds: [],
  redTeam: { resultId: 'result-1', rulingNeeded: false }, humanOnlyHold: false,
  now: START + 3000, ...overrides,
});
const plan = (s, o = options()) => planLabelReconcile(s, o);
const after = (s, p) => ({ ...s, labels: [...new Set([
  ...s.labels.filter(label => !p.remove.includes(label)), ...p.add,
])] });
const expectKept = p => {
  expect(p.remove).not.toContain('review:changes');
  expect(p.remove).not.toContain('fix-waiting:review');
  expect(p.reasons.some(reason => reason.startsWith('review-hold-kept:'))).toBe(true);
};

describe('label reconcile rules', () => {
  it.each([
    ['R-a blocks an uncovered required ruling',
      { redTeam: { resultId: 'result-1', rulingNeeded: true } },
      ['red-team:blocked'], [], 'red-team-blocked'],
    ['R-b clears a recorded outcome', {}, ['red-team:clear'], [], 'red-team-clear'],
    ['R-c keeps pending and blocked without outcome evidence',
      { redTeam: { resultId: null, rulingNeeded: false }, labels: ['red-team:pending', 'red-team:blocked'] },
      [], [], 'red-team-kept-no-evidence'],
    ['R-d replaces every other red-team label',
      { labels: ['red-team:pending', 'red-team:blocked', 'red-team:custom'] },
      ['red-team:clear'], ['red-team:blocked', 'red-team:custom', 'red-team:pending'], 'red-team-clear'],
    ['R-e clears review holds with complete acceptance evidence',
      { labels: ['review:changes', 'fix-waiting:review', 'fix-waiting:ci', 'keep'], reviewRun: run() },
      ['red-team:clear'], ['fix-waiting:ci', 'fix-waiting:review', 'review:changes'], 'review-hold-cleared'],
    ['R-f removes readiness when review changes remain',
      { labels: ['review:changes', 'ready-to-merge'] },
      ['red-team:clear'], ['ready-to-merge'], 'ready-to-merge-removed'],
  ])('%s', (_name, overrides, add, remove, reason) => {
    const p = plan(snapshot(overrides));
    expect(p.add).toEqual(add);
    expect(p.remove).toEqual(remove);
    expect(p.reasons).toContain(reason);
  });

  it.each(['send-back', 'hold', 'card', 'advisory'])('broken policy %s controls blocking', policy => {
    const o = options();
    o.config.confirmedBreaks.broken = policy;
    const p = plan(snapshot({ redTeam: { resultId: 'result-1', rulingNeeded: true } }), o);
    expect(p.add).toEqual([['send-back', 'hold'].includes(policy) ? 'red-team:blocked' : 'red-team:clear']);
  });

  it.each(['explicit', 'snapshot'])('a covering %s standing ruling permits clear', source => {
    const s = snapshot({ redTeam: { resultId: 'result-1', rulingNeeded: true } });
    const o = options();
    if (source === 'explicit') o.standingRuling = { resultIds: ['result-1'] };
    else s.standingRulings = ['result-1'];
    expect(plan(s, o).add).toEqual(['red-team:clear']);
  });

  it('a ruling for another result does not cover the current result', () => {
    const o = { ...options(), standingRuling: { resultIds: ['other-result'] } };
    expect(plan(snapshot({ redTeam: { resultId: 'result-1', rulingNeeded: true } }), o).add)
      .toEqual(['red-team:blocked']);
  });

  it.each([undefined, null])('missing reviewRun (%s) supplies no clearance', reviewRun => {
    expectKept(plan(snapshot({ labels: ['review:changes', 'fix-waiting:review'], reviewRun })));
  });

  it.each([
    ['different head', { head: OTHER_HEAD }], ['incomplete run', { completedAt: null }],
    ['parked run', { parked: true }], ['changes verdict', { verdict: 'changes' }],
    ['changes confirmation', { confirm: 'changes' }], ['abstention', { confirm: 'abstain' }],
    ['missing confirmation', { confirm: null }], ['unpublished accept', { publishedAccept: false }],
  ])('R-e keeps holds for %s', (_name, overrides) => {
    expectKept(plan(snapshot({ labels: ['review:changes', 'fix-waiting:review'], reviewRun: run(overrides) })));
  });

  it.each([
    ['human-only hold', { humanOnlyHold: true }],
    ['open referral', { openReferrals: ['referral-1'] }],
    ['current-head changes review', { reviews: [
      { id: 'review-1', author: { login: 'human' }, state: 'CHANGES_REQUESTED', commit: { oid: HEAD } },
    ] }],
    ['verdict at run start', { comments: [comment({ createdAt: iso(0) })] }],
    ['verdict after run start', { comments: [comment({ createdAt: iso(1) })] }],
    ['unparseable creation time fails closed', { comments: [comment({ createdAt: 'unreadable' })] }],
    ['unparseable edit time fails closed', { comments: [comment({ lastEditedAt: 'unreadable' })] }],
    ['resulting blocked label', { redTeam: { resultId: 'result-1', rulingNeeded: true } }],
    ['blocked label retained without evidence', { redTeam: { resultId: null, rulingNeeded: false },
      labels: ['review:changes', 'fix-waiting:review', 'red-team:blocked'] }],
  ])('R-e preserves holds for %s', (_name, overrides) => {
    expectKept(plan(snapshot({ labels: ['review:changes', 'fix-waiting:review'], reviewRun: run(), ...overrides })));
  });

  it('old verdicts, stale changes reviews and ordinary new comments permit clearance', () => {
    const p = plan(snapshot({ labels: ['review:changes'], reviewRun: run(),
      comments: [comment({ lastEditedAt: iso(-1) }), comment({ id: 'ordinary', body: 'Thanks', createdAt: iso(1) })],
      reviews: [{ id: 'stale', author: { login: 'human' }, state: 'CHANGES_REQUESTED', commit: { oid: OTHER_HEAD } }],
    }));
    expect(p.remove).toContain('review:changes');
  });

  it('R-f uses after-labels: a new blocked result strips readiness', () => {
    const p = plan(snapshot({ labels: ['ready-to-merge'], redTeam: { resultId: 'result-1', rulingNeeded: true } }));
    expect(p.remove).toEqual(['ready-to-merge']);
  });

  it('R-f uses after-labels: cleared holds preserve readiness', () => {
    const p = plan(snapshot({ labels: ['ready-to-merge', 'review:changes', 'red-team:blocked'], reviewRun: run() }));
    expect(p.remove).toEqual(['red-team:blocked', 'review:changes']);
  });
});

describe('#5990 regressions', () => {
  it('env:{} ignored policy', () => {
    expect(() => planLabelReconcile(snapshot(), { env: {}, standingRuling: null })).toThrow(/config/);
  });
  it('missing standingRuling throws', () => {
    expect(() => planLabelReconcile(snapshot(), { config: config() })).toThrow(/standingRuling/);
  });
  it('status-labels-off makes no red-team change', () => {
    const o = options();
    o.config.statusLabels = false;
    const p = plan(snapshot({ labels: ['red-team:pending', 'red-team:blocked', 'red-team:clear', 'ready-to-merge'],
      reviewRun: run(), redTeam: { resultId: 'result-1', rulingNeeded: true } }), o);
    expect([...p.add, ...p.remove].filter(label => label.startsWith('red-team:'))).toEqual([]);
    expect(p.reasons).toContain('status-labels-off');
    expect(p.remove).toEqual(['ready-to-merge']);
  });
  it('comment edited after run start blocks clearance (edit-time race)', () => {
    expectKept(plan(snapshot({ labels: ['review:changes', 'fix-waiting:review'], reviewRun: run(),
      comments: [comment({ createdAt: iso(-10000), lastEditedAt: iso(1) })] })));
  });
  it('label-state sandwich: labels already changed externally (review:changes already removed / red-team:clear already present) yields no re-add and idempotent re-plan', () => {
    const s = snapshot({ labels: ['red-team:clear', 'keep'], reviewRun: run() });
    const p = plan(s);
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual([]);
    expect(plan(after(s, p))).toEqual(p);
  });
});

describe('explicit input validation', () => {
  it.each([
    ['config', o => { delete o.config; }],
    ['config', o => { o.config = null; }],
    ['config', o => { o.config = []; }],
    ['statusLabels', o => { delete o.config.statusLabels; }],
    ['statusLabels', o => { o.config.statusLabels = 'true'; }],
    ['confirmedBreaks', o => { delete o.config.confirmedBreaks; }],
    ['confirmedBreaks', o => { o.config.confirmedBreaks = []; }],
    ...['broken', 'degraded', 'unconfirmed'].flatMap(field => [
      [field, o => { delete o.config.confirmedBreaks[field]; }],
      [field, o => { o.config.confirmedBreaks[field] = 'unknown'; }],
    ]),
    ['standingRuling', o => { o.standingRuling = undefined; }],
    ['standingRuling', o => { o.standingRuling = { resultIds: [42] }; }],
    ['standingRuling', o => { o.standingRuling = []; }],
  ])('rejects invalid %s', (field, alter) => {
    const o = options(); alter(o);
    expect(() => plan(snapshot(), o)).toThrow(new RegExp(field));
  });
  it('missing options do not read defaults', () => {
    expect(() => planLabelReconcile(snapshot())).toThrow(/config/);
  });
  it.each([
    ['head', 'bad-sha'], ['head', `${HEAD}\n`], ['labels', null], ['labels', [42]],
    ['labelsVersion', 'bad-date'], ['comments', null], ['reviews', null],
    ['openReferrals', null], ['standingRulings', null], ['holdEventIds', null],
    ['redTeam', null], ['humanOnlyHold', 'false'], ['now', 1.5],
  ])('rejects invalid snapshot.%s', (field, value) => {
    expect(() => plan(snapshot({ [field]: value }))).toThrow(new RegExp(field));
  });
  it('rejects a missing snapshot', () => expect(() => plan(null)).toThrow(/snapshot/));
});

describe('pure deterministic plans', () => {
  it('same snapshot twice and shuffled comments/labels produce identical plans without mutation', () => {
    const s = snapshot({ labels: ['review:changes', 'red-team:pending', 'fix-waiting:z', 'fix-waiting:a'],
      reviewRun: run(), comments: [comment(), comment({ id: 'c2', body: 'Thanks', createdAt: iso(1) })],
      holdEventIds: ['hold-z', 'hold-a', 'hold-z'],
    });
    const original = structuredClone(s);
    const p = plan(s);
    expect(plan(s)).toEqual(p);
    expect(plan({ ...s, labels: [...s.labels].reverse(), comments: [...s.comments].reverse() })).toEqual(p);
    expect(s).toEqual(original);
    for (const values of Object.values(p)) expect(values).toEqual([...new Set(values)].sort());
    expect(p.evidenceIds).toEqual(['hold-a', 'hold-z', 'result-1', 'run-1']);
  });
  it.each([
    snapshot({ labels: ['review:changes', 'fix-waiting:ci', 'red-team:pending'], reviewRun: run() }),
    snapshot({ labels: ['red-team:clear', 'ready-to-merge'], redTeam: { resultId: 'result-1', rulingNeeded: true } }),
    snapshot({ labels: ['red-team:pending'], redTeam: { resultId: null, rulingNeeded: false } }),
  ])('applying a plan leaves no subsequent label operations %#', s => {
    const next = plan(after(s, plan(s)));
    expect(next.add).toEqual([]);
    expect(next.remove).toEqual([]);
  });
  it('does not invent evidence IDs without a result or run', () => {
    expect(plan(snapshot({ redTeam: { resultId: null, rulingNeeded: false } })).evidenceIds).toEqual([]);
  });
});
