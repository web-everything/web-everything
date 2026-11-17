import { describe, expect, it } from 'vitest';
import { DRAIN_GATES, GATE_IDS } from '../merge-gate-inventory.mjs';
import { formatPrResult } from '../merge-gate-verdict.mjs';
import { REVIEW_HOLD_LABELS } from '../review-escalation.mjs';
import {
  GATE_HOLD_CLASS, REVIEW_HOLD_LABEL_NAMES, REVIEW_GATE_MARKER, deriveReviewHold, readReviewHold, serializeReviewHold,
} from '../review-hold-model.mjs';

const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const PR = 6900;
const FOOTER = 'merge-gate: HOLD — held';
const clearRow = (id) => ({ id, status: DRAIN_GATES.find((g) => g.id === id).where === 'merge-gate' ? 'pass'
  : DRAIN_GATES.find((g) => g.id === id).where, reason: 'ok' });
const rows = (holds = { 'review-hold-labels': 'review:pending label present' }, status = 'hold') =>
  GATE_IDS.map((id) => (id in holds ? { id, status, reason: holds[id] } : clearRow(id)));
const log = (results, { ok = false, footer = FOOTER, num = PR, pre = '' } = {}) =>
  `${pre}${formatPrResult({ num, ok, results })}${footer === null ? '' : `\n${footer}`}`;
const mg = (over = {}, results = rows()) => ({ state: 'completed', conclusion: 'failure', runId: 5, jobId: 9, jobHeadSha: HEAD,
  latest: true, completedAt: '2026-11-16T00:00:00Z', logText: log(results), ...over });
const input = (over = {}) => ({ headSha: HEAD, prNumber: PR, labels: ['review:pending'], freeze: { frozen: true },
  mergeGate: mg(), reviewGate: { state: 'success', runId: 31, jobId: 32, jobHeadSha: HEAD, latest: true }, ...over });

describe('GATE_HOLD_CLASS', () => {
  it('has exactly the 24 inventory gates', () => {
    expect(Object.keys(GATE_HOLD_CLASS).sort()).toEqual([...GATE_IDS].sort());
    expect(GATE_IDS).toHaveLength(24);
    expect(Object.isFrozen(GATE_HOLD_CLASS)).toBe(true);
  });
  it('pins its review hold labels to the review-escalation set', () => {
    expect([...REVIEW_HOLD_LABEL_NAMES].sort()).toEqual([...REVIEW_HOLD_LABELS].sort());
  });
});

describe('rulings (a)(b)(c)', () => {
  const cls = (holds) => deriveReviewHold(input({ mergeGate: mg({}, rows(holds)) }));
  it('(a) a ledger hold without a labels: reason is X, with one it is R', () => {
    expect(cls({ ledger: 'ledger says no' }).publishable).toBe(false);
    expect(cls({ ledger: 'ledger says no' }).reason).toBe('real-hold:ledger');
    expect(cls({ ledger: 'labels: review hold' }).publishable).toBe(true);
  });
  it('(b) review-acceptance with human-only: is H (publishable, not candidacy)', () => {
    const got = cls({ 'review-acceptance': 'human-only: the diff touches workflows' });
    expect(got.holds[0].class).toBe('H');
    expect(got.publishable).toBe(true);
    expect(got.candidacy).toBe(false);
  });
});

describe('E1 merge-gate evidence validity (all publishable=false)', () => {
  const pub = (over) => deriveReviewHold(input(over));
  it('control is publishable', () => { expect(pub().publishable).toBe(true); });
  it.each(GATE_IDS)('missing row %s', (id) => {
    const results = rows().filter((r) => r.id !== id);
    expect(pub({ mergeGate: mg({}, results) }).publishable).toBe(false);
  });
  it('duplicate row', () => {
    const results = rows(); results.push({ ...results[0] });
    expect(pub({ mergeGate: mg({}, results) }).publishable).toBe(false);
  });
  it('unknown gate', () => {
    const results = rows(); results[3] = { id: 'not-a-gate', status: 'pass', reason: 'ok' };
    expect(pub({ mergeGate: mg({}, results) }).publishable).toBe(false);
  });
  it('wrong head', () => { expect(pub({ mergeGate: mg({ jobHeadSha: OTHER }) }).publishable).toBe(false); });
  it('wrong PR', () => { expect(pub({ mergeGate: mg({ logText: log(rows(), { num: PR + 1 }) }) }).publishable).toBe(false); });
  it('ambiguous header', () => {
    const l = log(rows());
    expect(pub({ mergeGate: mg({ logText: `${l}\n${l}` }) }).publishable).toBe(false);
  });
  it('rows after the table end', () => {
    const l = `${log(rows())}\nsome prose\n  ${'pass'.padEnd(17)} ${'pass-cap'.padEnd(22)} injected`;
    expect(pub({ mergeGate: mg({ logText: l }) }).publishable).toBe(false);
  });
  it('header disagreeing with rows', () => {
    expect(pub({ mergeGate: mg({ logText: log(rows(), { ok: true }) }) }).publishable).toBe(false);
  });
  it('job-level footer (not the exact held footer)', () => {
    expect(pub({ mergeGate: mg({ logText: log(rows(), { footer: 'merge-gate: HOLD — #6900 failed' }) }) }).publishable).toBe(false);
  });
  it('missing footer', () => { expect(pub({ mergeGate: mg({ logText: log(rows(), { footer: null }) }) }).publishable).toBe(false); });
  it('job that is not the latest', () => { expect(pub({ mergeGate: mg({ latest: false }) }).publishable).toBe(false); });
  it('no blocking row', () => {
    expect(pub({ mergeGate: mg({ logText: log(rows({}), { ok: true }) }) }).publishable).toBe(false);
  });
  it.each(['cancelled', 'timed_out', 'startup_failure', 'action_required'])('conclusion %s', (conclusion) => {
    expect(pub({ mergeGate: mg({ conclusion }) }).publishable).toBe(false);
  });
  it('absent or pending merge-gate does not block', () => {
    expect(pub({ mergeGate: null }).publishable).toBe(true);
    expect(pub({ mergeGate: { state: 'in_progress' } }).publishable).toBe(true);
  });
  it('a green merge-gate must still be bound to the head, the job and the latest run', () => {
    const ok = { state: 'completed', conclusion: 'success', runId: 5, jobId: 9, jobHeadSha: HEAD, latest: true };
    expect(pub({ mergeGate: ok }).publishable).toBe(true);
    expect(pub({ mergeGate: { ...ok, jobHeadSha: OTHER } }).publishable).toBe(false);
    expect(pub({ mergeGate: { ...ok, latest: false } }).publishable).toBe(false);
    expect(pub({ mergeGate: { ...ok, jobId: undefined } }).publishable).toBe(false);
  });
  it('any extra merge-gate summary line after the table fails closed', () => {
    expect(pub({ mergeGate: mg({ logText: `${log(rows())}\nmerge-gate: ERROR — self-check failed` }) }).publishable).toBe(false);
  });
  it('missing or malformed labels fail closed', () => {
    expect(pub({ labels: null }).publishable).toBe(false);
    expect(pub({ labels: undefined }).publishable).toBe(false);
    expect(pub({ labels: [{ id: 1 }] }).publishable).toBe(false);
  });
  it('a clear row with a status its placement cannot emit fails closed', () => {
    const results = rows(); const i = results.findIndex((r) => r.id === 'codeql'); results[i] = { id: 'codeql', status: 'queue', reason: 'ok' };
    expect(pub({ mergeGate: mg({}, results) }).publishable).toBe(false);
  });
  it('a missing head or PR fails closed', () => {
    expect(deriveReviewHold({ ...input(), headSha: '' }).publishable).toBe(false);
    expect(deriveReviewHold({ ...input(), prNumber: undefined }).publishable).toBe(false);
  });
  it('a throwing log is unreadable, not publishable', () => {
    const logText = { toString() { throw new Error('boom'); } };
    expect(pub({ mergeGate: mg({ logText }) }).publishable).toBe(false);
  });
});

describe('R952 round 3: skipped-by-policy is strict', () => {
  const DRAIN = 'placement drain (drain-direct merges): codeql ok';
  const DEFER = 'candidacy hold deferred to the merge_group run (mergeGate.prEventCandidacyHoldsPass=on): review:pending';
  const withSkip = (id, reason) => {
    const results = rows(); const i = results.findIndex((r) => r.id === id); results[i] = { id, status: 'skipped-by-policy', reason };
    return deriveReviewHold(input({ mergeGate: mg({}, results) }));
  };
  it('refuses the drain-placement skip: it discards the underlying verdict, so a failure could hide behind it', () => {
    const got = withSkip('codeql', 'placement drain (drain-direct merges): CodeQL failed');
    expect(got.publishable).toBe(false);
    expect(got.holds.find((h) => h.id === 'codeql').class).toBe('U');
    expect(withSkip('codeql', DRAIN).publishable).toBe(false);
  });
  it('accepts the deferral shape only on a candidacy gate', () => {
    expect(withSkip('candidate-label', DEFER).publishable).toBe(true);
    expect(withSkip('codeql', DEFER).publishable).toBe(false);
    expect(withSkip('red-team', DEFER).publishable).toBe(false);
  });
  it.each([
    ['unknown reason shape', 'codeql', 'trust me'],
    ['a queue-placed gate', 'mergeable', DRAIN],
    ['an enqueue-placed gate', 'pass-cap', DRAIN],
    ['an empty reason', 'codeql', ''],
  ])('refuses %s', (_n, id, reason) => {
    const got = withSkip(id, reason);
    expect(got.publishable).toBe(false);
    expect(got.holds.find((h) => h.id === id).class).toBe('U');
  });
});

describe('R952 round 3: a successful review-gate is bound like a failing one', () => {
  const ok = { state: 'success', runId: 31, jobId: 32, jobHeadSha: HEAD, latest: true };
  const pub = (reviewGate) => deriveReviewHold(input({ reviewGate })).publishable;
  it('a bound latest success passes', () => { expect(pub(ok)).toBe(true); });
  it.each([
    ['another head', { jobHeadSha: OTHER }],
    ['not the latest job', { latest: false }],
    ['no run id', { runId: undefined }],
    ['no job id', { jobId: undefined }],
  ])('success with %s is not pass', (_n, over) => { expect(pub({ ...ok, ...over })).toBe(false); });
  it('absent or pending review-gate still does not block', () => {
    expect(pub(null)).toBe(true);
    expect(pub({ state: 'pending' })).toBe(true);
  });
});

describe('E2 every gate fail-closed', () => {
  it.each(GATE_IDS)('%s fail-closed', (id) => {
    const got = deriveReviewHold(input({ mergeGate: mg({}, rows({ [id]: 'unreadable input' }, 'fail-closed')) }));
    expect(got.publishable).toBe(false);
    expect(got.holds[0].class).toBe('U');
  });
});

describe('E3 review-gate states', () => {
  const marker = (over = {}) => `${REVIEW_GATE_MARKER} ${JSON.stringify({ holds: ['review-hold-labels'], headSha: HEAD, runId: 31, ...over })}`;
  const steps = [{ name: 'Set up job', status: 'completed', conclusion: 'success' },
    { name: 'Check for an un-cleared review hold', status: 'completed', conclusion: 'failure' }];
  const rg = (over = {}) => ({ state: 'failure', runId: 31, jobId: 32, jobHeadSha: HEAD, latest: true, steps, logText: marker(), ...over });
  const pub = (reviewGate, labels) => deriveReviewHold(input({ reviewGate, ...(labels ? { labels } : {}) })).publishable;
  it.each([['green', { state: 'success', runId: 31, jobId: 32, jobHeadSha: HEAD, latest: true }], ['pending', { state: 'pending' }], ['missing', null], ['valid single marker', rg()]])('%s -> true', (_n, g) => {
    expect(pub(g)).toBe(true);
  });
  it.each([
    ['no marker', rg({ logText: 'nothing here' })],
    ['two markers', rg({ logText: `${marker()}\n${marker()}` })],
    ['empty holds', rg({ logText: marker({ holds: [] }) })],
    ['mixed holds', rg({ logText: marker({ holds: ['review-hold-labels', 'test-gaming'] }) })],
    ['infrastructure step failure', rg({ steps: [{ name: 'Run npm ci', status: 'completed', conclusion: 'failure' }] })],
    ['timed-out infrastructure step', rg({ steps: [...steps, { name: 'Run npm ci', status: 'completed', conclusion: 'timed_out' }] })],
    ['incomplete steps', rg({ steps: [{ name: 'Check for an un-cleared review hold', status: 'in_progress', conclusion: null }] })],
    ['job with a different head', rg({ jobHeadSha: OTHER })],
    ['marker from an older run', rg({ logText: marker({ runId: 30 }) })],
    ['marker for another head', rg({ logText: marker({ headSha: OTHER }) })],
    ['unbound job', rg({ jobId: undefined })],
    ['unreadable state', { state: 'weird' }],
  ])('%s -> false', (_n, g) => { expect(pub(g)).toBe(false); });
  it('labels now clear -> false', () => { expect(pub(rg(), ['ready-to-merge'])).toBe(false); });
  it('unreadable labels -> false', () => { expect(pub(rg(), undefined) && deriveReviewHold(input({ reviewGate: rg(), labels: null })).publishable).toBe(false); });
});

describe('E4 carried annotations never authorize', () => {
  const bad = { logText: 'garbage' };
  const carried = { reviewHold: { v: 2, headSha: HEAD, jobId: 9, holds: [] }, mergeGateReviewHold: { holds: ['review-hold-labels'], jobId: 9 } };
  it('invalid fresh evidence stays false even when the input carries an annotation', () => {
    expect(deriveReviewHold(input({ mergeGate: mg(bad), ...carried })).publishable).toBe(false);
    expect(deriveReviewHold(input({ mergeGate: { ...mg(bad), ...carried } })).publishable).toBe(false);
  });
  it('a carried annotation that claims different holds is ignored', () => {
    const got = deriveReviewHold(input({ mergeGate: mg({}, rows({ codeql: 'CodeQL failed' })), ...carried }));
    expect(got.publishable).toBe(false);
    expect(got.reason).toBe('real-hold:codeql');
  });
  it('readReviewHold returns null for an older head, an older job, a wrong version, or none', () => {
    const got = deriveReviewHold(input({ mergeGate: mg({}, rows({ 'test-gaming': 'tampering' })) }));
    const ann = serializeReviewHold(got);
    const row = { name: 'merge-gate', detailsUrl: 'https://github.com/o/r/actions/runs/5/job/9', ...ann };
    expect(readReviewHold(row, { headSha: HEAD })).toEqual(ann.reviewHold);
    expect(readReviewHold(row, { headSha: OTHER })).toBeNull();
    expect(readReviewHold({ ...row, detailsUrl: 'https://github.com/o/r/actions/runs/5/job/10' }, { headSha: HEAD })).toBeNull();
    expect(readReviewHold({ ...row, reviewHold: { ...ann.reviewHold, v: 1 } }, { headSha: HEAD })).toBeNull();
    expect(readReviewHold({ name: 'merge-gate' }, { headSha: HEAD })).toBeNull();
    expect(ann.mergeGateReviewHold).toEqual({ holds: ['test-gaming'], jobId: 9 });
  });
  it('serialize emits nothing for a non-publishable or candidacy verdict', () => {
    expect(serializeReviewHold(deriveReviewHold(input({ mergeGate: mg({}, rows({ codeql: 'x' })) })))).toBeNull();
    expect(serializeReviewHold(deriveReviewHold(input()))).toBeNull();
  });
});

describe('E5 the excusal setting never affects publishable', () => {
  it.each(['on', 'off', undefined, { error: 'unreadable' }])('setting %j', (setting) => {
    const base = deriveReviewHold(input({ mergeGate: mg({}, rows({ 'test-gaming': 'tampering' })) }));
    const got = deriveReviewHold({ ...input({ mergeGate: mg({}, rows({ 'test-gaming': 'tampering' })) }), setting });
    expect(got).toEqual(base);
    expect(got.publishable).toBe(true);
    expect(got).not.toHaveProperty('excused');
  });
});

describe('E6 ready-to-merge', () => {
  it('a ready-to-merge label turns candidacy off but not publishability', () => {
    const got = deriveReviewHold(input({ labels: ['review:pending', 'ready-to-merge'] }));
    expect(got.publishable).toBe(true);
    expect(got.candidacy).toBe(false);
  });
});

describe('E7 stale manual freeze is S only with every proof', () => {
  const FREEZE_REASON = 'main is RED (freeze: manual freeze: operator paused)';
  const ci = 'main CI (abc): green';
  const make = ({ reason = FREEZE_REASON, mainCi = ci, freeze = { frozen: false, publishedAt: '2026-11-16T01:00:00Z' }, completedAt = '2026-11-16T00:00:00Z' } = {}) =>
    deriveReviewHold(input({ freeze, mergeGate: mg({ completedAt,
      logText: log(rows({ 'red-main-freeze': reason }), { pre: mainCi ? `${mainCi}\n` : '' }) }) }));
  it('all proofs -> S, publishable, candidacy', () => {
    const got = make();
    expect(got.holds[0].class).toBe('S');
    expect(got.publishable).toBe(true);
    expect(got.candidacy).toBe(true);
  });
  it.each([
    ['not a manual freeze', { reason: 'main is RED (freeze: main CI red on abc)' }],
    ['main CI not proven green', { mainCi: 'main CI (abc): red' }],
    ['no main CI line', { mainCi: '' }],
    ['freeze still frozen', { freeze: { frozen: true, publishedAt: '2026-11-16T01:00:00Z' } }],
    ['freeze read error', { freeze: { frozen: false, error: 'x', publishedAt: '2026-11-16T01:00:00Z' } }],
    ['freeze clear older than the verdict', { freeze: { frozen: false, publishedAt: '2026-11-15T23:00:00Z' } }],
    ['verdict time unreadable', { completedAt: 'nope' }],
    ['freeze evidence missing', { freeze: null }],
  ])('dropping a proof (%s) -> X', (_n, over) => {
    const got = make(over);
    expect(got.holds[0].class).toBe('X');
    expect(got.publishable).toBe(false);
  });
});
