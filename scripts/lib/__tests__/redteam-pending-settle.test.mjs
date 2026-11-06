// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mod from '../review-red-team-on-skip.mjs';
import { assertRunRecord, newRunRecord } from '../../operations/run-record.mjs';
import pendingBreak from '../../conveyor/soak/breaks/redteam-pending-label-never-settles.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';
import { settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

// Fail any accidental transport call locally; all intended IO is injected below.
vi.mock('../gh-throttle.mjs', async original => ({
  ...await original(), runGhSync: vi.fn(() => { throw Error('unexpected gh call'); }),
}));
vi.mock('../../operations/needs-you-feed.mjs', async original => ({
  ...await original(), publishAttention: vi.fn(() => { throw Error('unexpected feed call'); }),
}));

const repo = 'web-everything/web-everything', pr = 6416;
const head = 'a'.repeat(40), old = 'b'.repeat(40);
const acceptedAt = Date.parse('2026-10-25T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const trusted = (body, createdAt = iso(acceptedAt)) => ({ body, createdAt, author: { login: 'web-everything' } });
const accept = (sha = head) => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${sha} -->`);
const payload = (verdict = 'needs-human', rev = head) => ({
  verdict: { verdict, humanRequired: false }, findings: { read: { netBasis: { rev } } },
});
const evidence = (over = {}) => ({
  loopPayload: payload(), inFlight: false, queued: false, recorded: false, seatRecorded: false, ...over,
});
function fixture(over = {}) {
  return { repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'],
      comments: [accept()], reviews: [] }],
    readEvidence: () => evidence(), readStatus: () => null, readCarry: () => null,
    now: acceptedAt + 10_000, setting: { enabled: true, retryCooldownMin: 30 },
    lastDispatch: new Map(), ...over };
}
const decide = f => mod.planRedTeamOnSkip(f)[0];
function runFixture(over = {}) {
  const f = fixture();
  return { ...f, plan: { refusals: f.refusals }, now: () => f.now, env: {},
    readWitness: null, readReviews: vi.fn(() => []), proveMove: () => ({ ok: false }),
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 42 })),
    settlePending: vi.fn(), escalate: vi.fn(), syncLabels: vi.fn(), settle: vi.fn(() => ({ outcome: 'policy-clear' })), ...over };
}
// Historical not-owed evidence without matching acceptance must escalate.
function notOwedFixture() {
  const status = { status: 'finished', result: 'not-owed' };
  const f = fixture({ readEvidence: () => evidence({ status }), readStatus: () => status });
  f.rawPrs[0].comments = [accept(old)];
  return f;
}
function notOwedRunFixture(over = {}) {
  const f = notOwedFixture();
  return runFixture({ ...f, now: () => f.now, ...over });
}
function carryFixture() {
  const f = fixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
  f.rawPrs[0].comments = [accept(old),
    trusted(`${redTeamMarker(pr, old)}\nRed team not required on this head: card-only diff`),
    trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${head} -->\n<!-- numbering-restamp: from=${old} to=${head} -->`)];
  return f;
}
function resultComment(confirmed = false) {
  return trusted(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'fixture',
    foldedVerdict: confirmed ? 'changes' : 'accept', findings: confirmed ? [{
      summary: 'confirmed break', category: 'edge-case', impactIfUnfixed: 'broken',
      confirmedByRecheck: true, file: 'scripts/example.mjs', filesRead: ['scripts/example.mjs'],
    }] : [] }));
}

describe('complete bounded formal-review reads', () => {
  it('reads successive pages through the bounded injected transport', () => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, state: 'APPROVED' }))))
      .mockReturnValueOnce(JSON.stringify([{ id: 101, state: 'CHANGES_REQUESTED' }]));
    expect(mod.readCompletePrReviews({ repo, pr, exec })).toHaveLength(101);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][0]).toEqual(['api', `repos/${repo}/pulls/${pr}/reviews?per_page=100&page=2`]);
    expect(exec.mock.calls[1][1]).toMatchObject({ timeout: 60_000, maxBuffer: 1024 * 1024 });
  });
  it.each(['parse failure', 'non-array', 'oversize', 'page cap'])(
    '%s refuses incomplete reviews for operator inspection', kind => {
      expect(mod.readCompletePrReviews).toBeTypeOf('function');
      const exec = vi.fn(() => kind === 'parse failure' ? '{' : kind === 'non-array' ? '{}'
        : kind === 'oversize' ? JSON.stringify([{ body: 'x'.repeat(1024 * 1024) }])
          : JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, state: 'APPROVED' }))));
      expect(() => mod.readCompletePrReviews({ repo, pr, exec })).toThrow(/review|JSON/i);
      expect(exec.mock.calls.length).toBeLessThanOrEqual(10);
    });

  it.each(['clear'])(
    '%s refuses unreadable complete reviews despite a readable legacy review snapshot', kind => {
      const status = { status: 'finished', result: 'not-owed' };
      const o = runFixture({
        readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
      const readCompleteReviews = vi.fn(() => { throw Error('complete reviews unreadable'); });
      o.readCompleteReviews = readCompleteReviews;
      const row = mod.runRedTeamOnSkip(o).rows[0];
      if (kind === 'clear') expect(row.why).toBe('clear failed: evidence changed before settlement');
      else expect(row.settleError).toBe('complete reviews unreadable');
      expect(readCompleteReviews).toHaveBeenCalledOnce();
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
    });
});

describe('policy-clear publication revalidates fresh evidence', () => {
  function clearFixture() {
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.provider = { readPrState: vi.fn(() => o.rawPrs[0]), setLabels: vi.fn() };
    o.readComments = vi.fn(() => o.rawPrs[0].comments);
    return o;
  }
  it.each(['hold comment', 'formal hold', 'head moved', 'state unreadable', 'comments unreadable',
    'reviews unreadable', 'review changed'])(
    '%s appearing before publication refuses clear and publishes nothing', change => {
      const o = clearFixture();
      if (change === 'hold comment') o.readComments.mockReturnValue([...o.rawPrs[0].comments,
        trusted('🔁 review — changes requested', iso(acceptedAt + 1))]);
      if (change === 'formal hold') o.readReviews.mockReturnValue([{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }]);
      if (change === 'head moved') o.provider.readPrState.mockReturnValue({ ...o.rawPrs[0], headRefOid: old });
      if (change === 'state unreadable') o.provider.readPrState.mockImplementation(() => { throw Error('state offline'); });
      if (change === 'comments unreadable') o.readComments.mockImplementation(() => { throw Error('comments offline'); });
      if (change === 'reviews unreadable') o.readReviews.mockImplementation(() => { throw Error('reviews offline'); });
      if (change === 'review changed') o.readEvidence = vi.fn().mockReturnValueOnce(o.readEvidence())
        .mockReturnValue({ ok: false, reason: 'review-unfinished' });
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', why: change === 'review changed'
        ? 'review-unfinished' : 'clear failed: evidence changed before settlement' });
      if (change === 'review changed') {
        expect(row).toMatchObject({ escalate: true,
          escalationContext: 'review-unfinished: an unfinished review run holds this head; a human must answer or cancel the pending confirmation' });
        expect(o.escalate).toHaveBeenCalledOnce(); expect(o.settlePending).not.toHaveBeenCalled();
      }
      expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.provider.setLabels).not.toHaveBeenCalled();
    });
  it('passes freshly read comments to settle after the clear decision is revalidated', () => {
    const o = clearFixture();
    const comments = [...o.rawPrs[0].comments, trusted('🔔 conveyor — fresh status note')];
    o.readComments.mockReturnValue(comments);
    expect(mod.runRedTeamOnSkip(o).rows[0].action).toBe('clear');
    expect(o.settle).toHaveBeenCalledWith(expect.objectContaining({ comments }));
    expect(o.settle.mock.calls[0][0].comments).toBe(comments);
    expect(o.provider.readPrState).toHaveBeenCalledWith(repo, pr);
    expect(o.readComments).toHaveBeenCalledWith({ repo, pr });
    expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
    expect(o.syncLabels).toHaveBeenCalledOnce();
  });
});

describe('non-accept verdicts retain pending', () => {
  it.each(['needs-human', 'changes', 'reject'])('accepted + pending + stored %s never settles', verdict => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload(verdict) }) });
    expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('not-owed settlement evidence and holds', () => {
  it('never settles pending for an unknown verdict string', () => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('bogus') }) });
    expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
    expect(o.settlePending).not.toHaveBeenCalled();
  });
  it.each(['missing reviews', 'null reviews', 'formal hold', 'hold without acceptance', 'later verdict', 'later body hold'])(
    'planner retains pending for %s', kind => {
      const f = notOwedFixture();
      if (kind === 'missing reviews') delete f.rawPrs[0].reviews;
      if (kind === 'null reviews') f.rawPrs[0].reviews = null;
      if (kind === 'formal hold') f.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
      if (kind === 'hold without acceptance') {
        f.rawPrs[0].labels = ['review:prep', 'red-team:pending'];
        f.rawPrs[0].comments = [trusted('🔁 review — changes requested')];
      }
      if (kind === 'later verdict' || kind === 'later body hold') f.rawPrs[0].comments.push(
        trusted(kind === 'later verdict' ? '❌ review — changes requested' : 'manifest baseline mismatch', iso(acceptedAt + 1)));
      expect(decide(f)).not.toHaveProperty('settle');
      const o = runFixture({ ...f, now: () => f.now, readReviews: () => { throw Error('reviews unreadable'); } });
      mod.runRedTeamOnSkip(o);
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each(['review:prep', 'review:changes', 'review-status:running'])(
    'reads unaccepted reviews once and escalates without removal beside %s', label => {
      const o = notOwedRunFixture(); o.rawPrs[0].labels = [label, 'red-team:pending'];
      o.rawPrs[0].comments = []; delete o.rawPrs[0].reviews;
      o.rawPrs.push({ ...o.rawPrs[0] });
      expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true });
      expect(o.readReviews).toHaveBeenCalledOnce(); expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
      expect(o.settlePending).not.toHaveBeenCalled();
    });
  it.each(['throws', 'unknown', 'formal hold'])(
    'unaccepted review read %s retains pending', kind => {
      const readReviews = vi.fn(() => {
        if (kind === 'throws') throw Error('unreadable');
        return kind === 'unknown' ? null : [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
      });
      const o = notOwedRunFixture({ readReviews });
      o.rawPrs[0].labels = ['review:prep', 'red-team:pending']; o.rawPrs[0].comments = []; delete o.rawPrs[0].reviews;
      expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
      expect(readReviews).toHaveBeenCalledOnce(); expect(o.settlePending).not.toHaveBeenCalled();
    });
});

describe('planner settlement annotations', () => {
  it.each([null, {}, undefined, { verdict: 7 }, { verdict: '' }, { verdict: '  ' }])(
    'never settles pending without a recorded review verdict: %j', verdict => {
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: { ...payload(), verdict } }) });
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
      expect(row).not.toHaveProperty('settle');
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    });
  it('escalates an unaccepted recorded accept despite finished not-owed evidence', () => {
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.rawPrs[0].labels = ['red-team:pending']; o.rawPrs[0].comments = [];
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true });
    expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['stored', 'live'].flatMap(source => ['deferredByGuard', 'deferredByCap', 'missing', 'running'].map(kind => [source, kind])))(
    'unknown verdict cannot settle with %s status %s', (source, kind) => {
      const good = { status: 'finished', result: 'not-owed' };
      const bad = kind === 'missing' ? null : kind === 'running' ? { ...good, status: 'running' }
        : { status: 'finished', result: { status: 'not-owed', [kind]: true } };
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: { ...payload(), verdict: null },
        status: source === 'stored' ? bad : good }), readStatus: () => source === 'live' ? bad : good });
      o.rawPrs[0].labels = ['red-team:pending']; o.rawPrs[0].comments = [];
      expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
      expect(o.settlePending).not.toHaveBeenCalled();
    });
  it.each(['!owed', 'acceptance sha mismatch', 'not accepted'])('%s non-owing stored review keeps pending and escalates', site => {
    const f = notOwedFixture();
    if (site === 'acceptance sha mismatch') {
      f.rawPrs[0].comments = [accept(old)];
      const status = { status: 'finished', result: 'not-owed' };
      f.readEvidence = () => evidence({ loopPayload: payload('changes'), status });
      f.readStatus = () => status;
    }
    if (site === 'not accepted') f.rawPrs[0].labels = ['review:prep', 'red-team:pending'];
    expect(redTeamOwedFor(f.readEvidence().loopPayload)).toBe(false);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team', escalate: true });
  });

  it.each(['early result', 'post-evidence result'])('%s skip escalates pending without label synchronization', site => {
    const f = fixture(); f.rawPrs[0].comments.push(resultComment());
    // The unfinished journal bypasses the first result check; settled evidence reaches the second.
    if (site === 'post-evidence result') f.readCarry = () => ({ step: 'pending' });
    f.readEvidence = vi.fn(() => evidence({ carry: { step: 'done' } }));
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'red-team result already on head', escalate: true });
    expect(f.readEvidence).toHaveBeenCalledTimes(site === 'early result' ? 0 : 1);
  });

  it.each([
    ['unreadable evidence', f => { f.readEvidence = () => { throw Error('unreadable'); }; }],
    ['evidence ok false', f => { f.readEvidence = () => ({ ok: false, reason: 'review-unfinished' }); }],
    ['missing evidence', f => { f.readEvidence = () => undefined; }],
    ['inFlight', f => { f.readEvidence = () => evidence({ inFlight: true }); }],
    ['queued', f => { f.readEvidence = () => evidence({ queued: true }); }],
    ['recorded', f => { f.readEvidence = () => evidence({ recorded: true }); }],
    ['seatRecorded', f => { f.readEvidence = () => evidence({ seatRecorded: true }); }],
    ['unknown recorded', f => { f.readEvidence = () => evidence({ recorded: undefined }); }],
    ['unknown seatRecorded', f => { f.readEvidence = () => evidence({ seatRecorded: undefined }); }],
    ['stale read head', f => { f.rawPrs[0].labels = ['review:prep']; f.readEvidence = () => evidence({ loopPayload: payload('needs-human', old) }); }],
    ['missing read head', f => { f.readEvidence = () => evidence({ loopPayload: { verdict: { verdict: 'changes' } } }); }],
    ['owed review', f => { f.readEvidence = () => evidence({ loopPayload: payload('accept') }); }],
    ['unreadable comments', f => { f.rawPrs[0].comments = undefined; }],
    ['head moved', f => { f.rawPrs[0].headRefOid = old; }],
    ['disabled', f => { f.setting.enabled = false; }],
    ['other skip reason', f => { f.readEvidence = () => evidence({ carryConflict: true }); }],
  ])('fails closed without a settle field for %s', (_name, mutate) => {
    const f = fixture(); mutate(f);
    expect(decide(f)).not.toHaveProperty('settle');
  });
});

describe('pending conflicts retain the merge hold', () => {
  const pathFixture = path => path === 'carry' ? carryFixture()
    : fixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
  it.each(['carry'])('%s escalates lone pending without settling it', path => {
    const f = pathFixture(path);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'conflicting label prevents policy-clear', escalate: true });
    expect(decide(f)).not.toHaveProperty('settle');
    expect(f.rawPrs[0].labels).toContain('red-team:pending');
  });
  it.each(['needsReview', 'carry'].flatMap(path => ['red-team:blocked', 'review:changes'].map(label => [path, label])))(
    '%s escalates the real conflict %s', (path, label) => {
      const f = pathFixture(path); f.rawPrs[0].labels.push({ name: label });
      expect(decide(f)).toMatchObject({ action: 'skip', why: 'conflicting label prevents policy-clear', escalate: true });
    });
});

describe('review recovery never removes pending', () => {
  it.each(['missing evidence', 'unreadable evidence', 'cooldown', 'formal hold', 'unreadable reviews'])(
    'retains pending for %s', kind => {
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
      if (kind === 'missing evidence') o.readEvidence = () => undefined;
      if (kind === 'unreadable evidence') o.readEvidence = () => { throw Error('evidence offline'); };
      if (kind === 'cooldown') o.lastDispatch.set(`${repo}#${pr}@${head}`, o.now() - 1);
      if (kind === 'formal hold') {
        o.rawPrs[0].comments = [];
        o.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
      }
      if (kind === 'unreadable reviews') {
        o.rawPrs[0].comments = []; o.rawPrs[0].reviews = null; o.readReviews = () => { throw Error('offline'); };
      }
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row.action).toBe('skip'); expect(row).not.toHaveProperty('settle');
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each([
    { lanes: 0, budget: { left: 1 } }, { lanes: 1, budget: { left: 0 } },
    { lanes: 1, remainingStarts: 0 }, undefined,
  ])('retains pending when execution capacity is exhausted: %j', capacity => {
    const o = runFixture({ capacity, readEvidence: () => evidence({ loopPayload: undefined }) });
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('head-bound default pending settlement', () => {
  function setup(state = { headRefOid: head, labels: [{ name: 'red-team:pending' }, { name: 'keep-me' }] }) {
    const provider = { readPrState: vi.fn(() => state), setLabels: vi.fn() };
    expect(mod.settlePendingFor).toBeTypeOf('function');
    return { provider, settle: mod.settlePendingFor({ provider, env: {} }) };
  }
  it('reads the live head and removes only pending', () => {
    const { provider, settle } = setup();
    settle({ repo, pr, head, remove: ['keep-me'] });
    expect(provider.readPrState).toHaveBeenCalledWith(repo, pr);
    expect(provider.setLabels).toHaveBeenCalledOnce();
    expect(provider.setLabels).toHaveBeenCalledWith(repo, pr, { remove: ['red-team:pending'] });
  });
  it('refuses a head moved since planning', () => {
    const { provider, settle } = setup({ headRefOid: old, labels: ['red-team:pending'] });
    expect(settle({ repo, pr, head })).toEqual({ skipped: 'head-moved' });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it.each([['red-team:pending', 'red-team:blocked'], [{ name: 'red-team:pending' }, { name: 'red-team:blocked' }],
    ['keep-me'], undefined].map(labels => [labels]))('preserves blocked, absent or unreadable pending labels %j', labels => {
    const { provider, settle } = setup({ headRefOid: head, labels });
    try { settle({ repo, pr, head }); } catch { /* Unreadable labels may throw, but never write. */ }
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('missing provenance escalates before attempting to read live state', () => {
    const { provider, settle } = setup();
    provider.readPrState.mockImplementation(() => { throw Error('live state unreadable'); });
    const o = notOwedRunFixture({ settlePending: settle });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true });
    expect(provider.readPrState).not.toHaveBeenCalled(); expect(o.escalate).toHaveBeenCalledOnce();
    expect(provider.setLabels).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('runner settles pending without dispatch', () => {
  it.each(['carry'])('%s escalates lone pending and keeps the merge hold across ticks', path => {
    const f = path === 'carry' ? carryFixture() : fixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
    const o = runFixture({ ...f, now: () => f.now });
    for (let tick = 0; tick < 2; tick++) {
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', escalate: true, why: 'conflicting label prevents policy-clear' });
      expect(row).not.toHaveProperty('settle');
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    }
    expect(o.escalate).toHaveBeenCalledTimes(2);
    expect(o.escalate).toHaveBeenCalledWith({ repo, pr, head, why: 'conflicting label prevents policy-clear' });
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it('escalation failure preserves why and never removes real conflicts', () => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
    o.rawPrs[0].labels.push('red-team:blocked');
    o.escalate.mockImplementation(() => { throw Error('feed offline'); });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true,
      why: 'conflicting label prevents policy-clear', settleError: 'feed offline' });
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
  it.each(['pending', 'real conflict'])('default settlement is inert under test for %s', kind => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: undefined }),
      settlePending: undefined, escalate: undefined });
    if (kind === 'real conflict') o.rawPrs[0].labels.push('red-team:blocked');
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row.action).toBe(kind === 'pending' ? 'review' : 'skip');
    expect(row).not.toHaveProperty('settleError');
    expect(o.settle).not.toHaveBeenCalled();
    expect(o.dispatch).toHaveBeenCalledTimes(kind === 'pending' ? 1 : 0);
  });
  it.each(['pending', 'real conflict'])('dryRun never settles a guard conflict: %s', kind => {
    const o = runFixture({ dryRun: true, readEvidence: () => evidence({ loopPayload: undefined }) });
    if (kind === 'real conflict') o.rawPrs[0].labels.push('red-team:blocked');
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.escalate).not.toHaveBeenCalled();
  });
  it('not-owed without acceptance provenance keeps pending and escalates', () => {
    const o = notOwedRunFixture(); const out = mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.escalate).toHaveBeenCalledOnce();
    expect(o.settlePending).not.toHaveBeenCalled();
    expect(out.rows[0]).toMatchObject({ action: 'skip', escalate: true });
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled(); expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
  });
  it.each(['red-team:blocked', { name: 'red-team:blocked' }])('not-owed preserves blocked label %j', label => {
    const o = notOwedRunFixture(); o.rawPrs[0].labels.push(label); mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });

  it.each(['not-owed', 'result'])('dryRun settles nothing for %s', kind => {
    const o = notOwedRunFixture({ dryRun: true }); if (kind === 'result') o.rawPrs[0].comments.push(resultComment());
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
    expect(o.escalate).not.toHaveBeenCalled();
  });
  it('escalation failure is reported without aborting the next row', () => {
    const method = 'escalate';
    const o = notOwedRunFixture();
    o[method] = vi.fn().mockImplementationOnce(() => { throw Error('settlement offline'); }).mockReturnValue(undefined);
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: pr + 1, headSha: head });
    o.rawPrs.push({ ...o.rawPrs[0], number: pr + 1, comments: [accept(old)] });
    const out = mod.runRedTeamOnSkip(o);
    expect(out.rows).toHaveLength(2); expect(out.rows[0].settleError).toBe('settlement offline');
    expect(out.rows[0].why).toBe('stored review does not owe a red team');
    expect(out.rows[1]).toMatchObject({ prNumber: pr + 1, escalate: true });
    expect(o[method]).toHaveBeenCalledTimes(2);
  });
  it.each(['unreadable comments', 'head moved'])('%s never settles pending or result labels', guard => {
    const o = runFixture(); if (guard === 'unreadable comments') o.rawPrs[0].comments = undefined;
    else o.rawPrs[0].headRefOid = old;
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: guard === 'head moved' ? 'live head missing or changed' : 'PR comments unreadable' });
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
  it.each(['real conflict'])('%s escalation publishes needs-you once across two ticks using real skip-published dedupe', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'redteam-pending-settle-'));
    try {
      const publishNeedsYou = vi.fn(), postComment = vi.fn();
      const o = runFixture({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') },
        readEvidence: () => evidence({ loopPayload: undefined }) });
      if (kind === 'real conflict') o.rawPrs[0].labels.push('review:changes');
      o.escalate = vi.fn(({ why, ...key }) => settleRedTeamSkip({ ...key,
        redTeam: { status: 'skipped', reason: why },
        io: { env: o.env, publishNeedsYou, postComment } }));
      for (let tick = 0; tick < 2; tick++) {
        expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true,
          why: 'conflicting label prevents policy-clear' });
        expect(o.escalate).toHaveBeenCalledTimes(tick + 1);
      }
      for (const [input] of o.escalate.mock.calls) {
        expect(input).toMatchObject({ repo, pr, head,
          why: 'conflicting label prevents policy-clear' });
        expect(input).not.toHaveProperty('policy');
      }
      expect(publishNeedsYou).toHaveBeenCalledOnce();
      expect(publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head,
        reason: 'red team skipped (conflicting label prevents policy-clear); not cleared' }));
      expect(postComment).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('dryRun never publishes conflict escalation', () => {
    const o = runFixture({ dryRun: true, readEvidence: () => evidence({ loopPayload: undefined }) });
    o.rawPrs[0].labels.push('red-team:blocked'); mod.runRedTeamOnSkip(o);
    expect(o.settle).not.toHaveBeenCalled(); expect(o.escalate).not.toHaveBeenCalled();
  });
});

describe('not-owed removal requires acceptance provenance', () => {
  const context = 'red-team:pending kept: not-owed review lacks acceptance provenance; needs a human look';
  it.each(['unaccepted', 'different head', 'needs-human', 'changes', 'reject'])(
    '%s keeps pending and escalates without publishing', kind => {
      const status = { status: 'finished', result: 'not-owed' };
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload(
        ['needs-human', 'changes', 'reject'].includes(kind) ? kind : 'accept'), status }), readStatus: () => status });
      if (kind === 'unaccepted') o.rawPrs[0].labels = ['red-team:pending'];
      if (kind === 'different head') o.rawPrs[0].comments = [accept(old)];
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', escalate: true, escalationContext: context });
      expect(row).not.toHaveProperty('settle');
      expect(o.escalate).toHaveBeenCalledOnce();
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    });
  it('needs-human with finished not-owed status preserves a human do not merge hold', () => {
    const o = notOwedRunFixture();
    o.rawPrs[0].comments = [accept(), { body: 'do not merge', createdAt: iso(acceptedAt + 1), author: { login: 'human-reviewer' } }];
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row).toMatchObject({ action: 'skip', why: 'later verdict or hold supersedes acceptance',
      escalate: true, escalationContext: context });
    expect(row).not.toHaveProperty('settle'); expect(o.escalate).toHaveBeenCalledOnce();
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('settlement requires a proven accepting comment', () => {
  const falseAccept = () => trusted(`🔁 review — changes requested
<!-- reviewed-sha: ${head} -->`);
  it('a changes-requested reviewed-sha marker cannot authorize policy-clear or pending removal', () => {
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.rawPrs[0].comments = [falseAccept()];
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row.action).toBe('skip'); expect(row).not.toHaveProperty('settle');
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });

});

describe('prep-advisory PR with no full review settles stale pending (R639, #6418)', () => {
  const prepNote = (sha = head, extra = '') => trusted(`<!-- prep-review: head=${sha} round=1${extra} -->\n🔎 review — prep advisory (single reviewer)`);
  const prepFixture = (over = {}) => {
    const f = fixture({ readEvidence: () => evidence({ loopPayload: undefined }), ...over });
    f.rawPrs[0].labels = ['review:prep', 'ready-to-merge', 'red-team:pending'];
    f.rawPrs[0].comments = [prepNote()];
    Object.assign(f.rawPrs[0], { headRefName: 'lane/4421-prepare-item-guards', files: [{ path: 'backlog/4421-guards.md' }] });
    return f;
  };
  it('plans a not-owed settlement instead of escalating, and removes only pending', () => {
    const f = prepFixture(); const o = runFixture({ ...f, now: () => f.now });
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row).toMatchObject({ action: 'skip', settle: 'not-owed' });
    expect(row).not.toHaveProperty('escalate');
    expect(o.escalate).not.toHaveBeenCalled();
    expect(o.settlePending).toHaveBeenCalledOnce();
    expect(o.settlePending.mock.calls[0][0]).toMatchObject({ repo, pr, head, remove: ['red-team:pending'] });
  });
  it.each([
    ['no review:prep label', f => { f.rawPrs[0].labels = ['red-team:pending']; }],
    ['code PR carrying the label and note', f => { f.rawPrs[0].files.push({ path: 'scripts/lib/x.mjs' }); }],
    ['non-prepare branch', f => { f.rawPrs[0].headRefName = 'lane/other'; }],
    ['file list missing', f => { delete f.rawPrs[0].files; }],
    ['prep note for another head', f => { f.rawPrs[0].comments = [prepNote(old)]; }],
    ['prep note blocked', f => { f.rawPrs[0].comments = [prepNote(head, ' blocked=1')]; }],
    ['prep note from untrusted author', f => { f.rawPrs[0].comments = [{ ...prepNote(), author: { login: 'rando' } }]; }],
    ['later changes-requested review verdict', f => { f.rawPrs[0].comments = [prepNote(), trusted(`🔁 review — changes requested\n<!-- reviewed-sha: ${head} -->`, iso(acceptedAt + 1))]; }],
    ['review hold label', f => { f.rawPrs[0].labels.push('review:changes'); }],
    ['red team blocked', f => { f.rawPrs[0].labels.push('red-team:blocked'); }],
    ['a stored review exists that owes a red team', f => { f.readEvidence = () => evidence({ loopPayload: payload('accept') }); }],
    ['a red-team run is recorded', f => { f.readEvidence = () => evidence({ loopPayload: undefined, recorded: true }); }],
    ['a red-team pass is in flight', f => { f.readEvidence = () => evidence({ loopPayload: undefined, inFlight: true }); }],
  ])('%s keeps pending and never settles', (_name, mutate) => {
    const f = prepFixture(); mutate(f);
    const o = runFixture({ ...f, now: () => f.now });
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row).not.toHaveProperty('settle');
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
});

describe('pending soak always replays recovery availability', () => {
  it.each(['missing module', 'missing exports'])('%s fails the replay instead of becoming expected-failure', async kind => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'pending-soak-missing-'));
    try {
      if (kind === 'missing exports') {
        mkdirSync(join(sourceRoot, 'scripts/lib'), { recursive: true });
        writeFileSync(join(sourceRoot, 'scripts/lib/review-red-team-on-skip.mjs'), 'export const unrelated = true;\n');
      }
      expect(pendingBreak.fixPresent(sourceRoot)).toBe(true);
      const report = await pendingBreak.run({ sourceRoot });
      expect(pendingBreak.judge(report).length).toBeGreaterThan(0);
      expect(report.violations.join(' ')).toMatch(/recovery module.*(import|export)/i);
    } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
  });
});

describe('policy-clear needs a proven acceptance even without a pending label', () => {
  it('a changes-requested comment carrying a reviewed-sha marker never authorises the clear action', () => {
    const f = notOwedFixture();
    const o = runFixture({ ...f, now: () => f.now });
    o.rawPrs[0].labels = o.rawPrs[0].labels.filter(label => (label.name ?? label) !== 'red-team:pending');
    o.rawPrs[0].comments = [{ author: { login: 'web-everything' }, createdAt: iso(acceptedAt),
      body: `\u{1F501} review \u2014 changes requested\n\nFix it.\n<!-- reviewed-sha: ${head} -->` }];
    mod.runRedTeamOnSkip(o);
    expect(o.settle).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});


describe.each(['readWitness', 'readEvidence'])('unfinished review holds through %s', reader => {
  it('publishes one needs-you note per head across two ticks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unfinished-review-hold-'));
    try {
      const publishNeedsYou = vi.fn(), postComment = vi.fn();
      const o = runFixture();
      o.env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      o[reader] = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
      o.escalate = vi.fn(({ why, ...key }) => settleRedTeamSkip({ ...key,
        redTeam: { status: 'skipped', reason: why }, io: { env: o.env, publishNeedsYou, postComment } }));
      for (let tick = 0; tick < 2; tick++) {
        const row = mod.runRedTeamOnSkip(o).rows[0];
        expect(row).toMatchObject({ action: 'skip', why: 'review-unfinished', escalate: true,
          escalationContext: 'review-unfinished: an unfinished review run holds this head; a human must answer or cancel the pending confirmation' });
        expect(row).not.toHaveProperty('settle');
        expect(o.rawPrs[0].labels).toContain('red-team:pending');
      }
      expect(o.escalate).toHaveBeenCalledTimes(2); expect(publishNeedsYou).toHaveBeenCalledOnce();
      expect(o[reader]).toHaveBeenCalledTimes(2);
      expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
      expect(postComment).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['scan-capped', 'review-unreadable'])('%s does not trigger unfinished-review escalation', reason => {
    const o = runFixture(); o[reader] = vi.fn(() => ({ ok: false, reason }));
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: reason });
    expect(o.escalate).not.toHaveBeenCalled(); expect(o[reader]).toHaveBeenCalledOnce();
    expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});

describe('write-time guard also requires acceptance and covers the policy-clear action', () => {
  function clearFixture(writeState) {
    const good = { headRefOid: head, labels: ['review:accepted', 'red-team:pending'] };
    let state = good;
    const provider = { readPrState: vi.fn(() => state), setLabels: vi.fn() };
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ provider,
      readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.syncLabels = vi.fn(input => {
      if (writeState) state = writeState;
      input.provider.setLabels(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
    });
    return { o, provider };
  }
  it('a proven policy-clear reaches clear and supplies a guarded provider to synchronization', () => {
    const { o, provider } = clearFixture();
    expect(mod.runRedTeamOnSkip(o).rows[0].action).toBe('clear');
    expect(o.settle).toHaveBeenCalledOnce(); expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(o.syncLabels.mock.calls[0][0].provider).not.toBe(provider);
    expect(provider.setLabels).toHaveBeenCalledWith(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
  });
  it.each([
    ['acceptance removed', { headRefOid: head, labels: ['red-team:pending'] }],
    ['blocked label added', { headRefOid: head, labels: ['review:accepted', 'red-team:pending', 'red-team:blocked'] }],
    ['review hold added', { headRefOid: head, labels: ['review:accepted', 'red-team:pending', 'review:changes'] }],
    ['malformed labels', { headRefOid: head, labels: ['review:accepted', 'red-team:pending', {}] }],
    ['head moved', { headRefOid: old, labels: ['review:accepted', 'red-team:pending'] }],
  ])('a policy-clear reaching the write-time guard refuses %s', (_name, writeState) => {
    const { o, provider } = clearFixture(writeState);
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.settle).toHaveBeenCalledOnce(); expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(provider.setLabels).not.toHaveBeenCalled();
    expect(row).toMatchObject({ action: 'skip', why: expect.stringMatching(/^clear failed: .*label unchanged$/) });
    expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
  });
});


describe('posted red-team results retain pending and escalate', () => {
  const context = 'red-team result already on head but red-team:pending is still set; the drain/job label sync did not settle it';
  it.each([false, true])('a posted result (confirmed break=%s) publishes one needs-you note across two ticks', confirmed => {
    const dir = mkdtempSync(join(tmpdir(), 'posted-result-hold-'));
    try {
      const publishNeedsYou = vi.fn(), postComment = vi.fn();
      const o = runFixture({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') } });
      o.rawPrs[0].comments.push(resultComment(confirmed));
      o.escalate = vi.fn(({ why, ...key }) => settleRedTeamSkip({ ...key,
        redTeam: { status: 'skipped', reason: why }, io: { env: o.env, publishNeedsYou, postComment } }));
      for (let tick = 0; tick < 2; tick++) {
        const row = mod.runRedTeamOnSkip(o).rows[0];
        expect(row).toMatchObject({ action: 'skip', why: 'red-team result already on head', escalate: true, escalationContext: context });
        expect(row).not.toHaveProperty('settle');
        expect(o.rawPrs[0].labels).toContain('red-team:pending');
      }
      expect(publishNeedsYou).toHaveBeenCalledOnce(); expect(o.escalate).toHaveBeenCalledTimes(2);
      expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([[], ['review:accepted'], undefined, null].map(labels => [labels]))('a result without known pending labels %j has no side effects', labels => {
    const o = runFixture(); o.rawPrs[0].labels = labels; o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
    expect(row).not.toHaveProperty('settle'); expect(row).not.toHaveProperty('escalate');
    expect(o.escalate).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('object-shaped pending labels also escalate', () => {
    const o = runFixture(); o.rawPrs[0].labels = [{ name: 'red-team:pending' }];
    o.rawPrs[0].comments.push(resultComment());
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ escalate: true, escalationContext: context });
    expect(o.escalate).toHaveBeenCalledOnce(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
});

describe('headNeverReviewedFromRuns complete bounded proof', () => {
  const run = (over = {}) => ({ op: 'review-pr', input: { repo, pr }, ...payload('accept', old),
    pending: null, effects: [], ...over });
  function scanFixture(records = {}) {
    return { repo, pr, head, runsDir: 'fixture-runs', list: vi.fn(() => Object.keys(records)),
      read: vi.fn(id => records[id]), stat: vi.fn(() => ({ mtimeMs: acceptedAt })) };
  }
  function scan(f) {
    expect(mod.headNeverReviewedFromRuns, 'export the complete never-reviewed-head scanner').toBeTypeOf('function');
    return mod.headNeverReviewedFromRuns(f);
  }
  it.each([
    ['running review', { verdict: null }],
    ['pending review', { pending: { kind: 'agent' } }],
    ['pending effect', { effects: [{ status: 'pending' }] }],
    ['in-flight effect', { effects: [{ status: 'in-flight' }] }],
    ['confirm with in-flight effect', { verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, effects: [{ status: 'in-flight' }] }],
  ])('an older-head unfinished %s permits a never-reviewed proof under R640', (_name, over) => {
    expect(scan(scanFixture({ 'review-pr-old': run(over) }))).toBe(true);
  });
  it('an older-head needs-human confirm still permits a never-reviewed proof under R640', () => {
    expect(scan(scanFixture({ 'review-pr-old': run({ verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } }) }))).toBe(true);
  });
  it('an exact-head unfinished confirm prevents proof even beside an older-head confirm', () => {
    const confirm = { verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } };
    expect(scan(scanFixture({ 'review-pr-old': run(confirm), 'review-pr-head': run({ ...confirm, ...payload('needs-human') }) }))).toBe(false);
  });
  it.each([{}, [], { op: 'review-pr' }, { op: 'review-pr', input: { repo } }])('malformed review run cannot prove an unreviewed head: %j', record => {
    expect(scan(scanFixture({ 'review-pr-malformed': record }))).toBe(false);
  });
  it('proves an empty completed scan has never reviewed the head', () => {
    expect(scan(scanFixture())).toBe(true);
  });
  it('ignores old heads and exact-head records belonging to another repo or PR', () => {
    expect(scan(scanFixture({ 'review-pr-old': run(),
      'review-pr-other-repo': run({ input: { repo: 'other/repo', pr }, ...payload('accept') }),
      'review-pr-other-pr': run({ input: { repo, pr: pr + 1 }, ...payload('accept') }),
    }))).toBe(true);
  });
  it.each(['finished', 'unfinished', 'pending confirm'])('an exact-head %s run disproves never-reviewed', state => {
    const exact = run({ ...payload('accept'), ...(state === 'unfinished' ? { verdict: null } : {}),
      ...(state === 'pending confirm' ? { verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } } : {}) });
    expect(scan(scanFixture({ 'review-pr-exact': exact }))).toBe(false);
  });
  it('recognizes an exact-head record with a string PR number', () => {
    expect(scan(scanFixture({ 'review-pr-exact': run({ ...payload('accept'), input: { repo, pr: String(pr) } }) }))).toBe(false);
  });
  it.each(['list', 'read', 'stat'])('returns false when %s throws instead of claiming no review', method => {
    const f = scanFixture({ 'review-pr-old': run() });
    f[method] = () => { throw Error('unreadable run scan'); };
    expect(scan(f)).toBe(false);
  });
  it('proves no exact-head review after exactly 400 parsed old-head runs', () => {
    const f = scanFixture(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`review-pr-${i}`, run()])));
    expect(scan(f)).toBe(true); expect(f.read).toHaveBeenCalledTimes(400);
  });
  it('over 400 parses returns false for operator inspection without claiming never-reviewed', () => {
    const f = scanFixture(Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`review-pr-${i}`, run()])));
    expect(scan(f)).toBe(false); expect(f.read.mock.calls.length).toBeLessThanOrEqual(400);
  });
});


// R640: operator-accepted change, class correctness-in-normal-use.
describe('R640 full review preserves pending', () => {
  it('dispatches the full review with lone pending and applies retry cooldown', () => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
    expect(mod.runRedTeamOnSkip(o).rows[0].action).toBe('review');
    expect(o.dispatch).toHaveBeenCalledOnce(); expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  describe.each(['readWitness', 'readEvidence'])('never-reviewed head through %s', reader => {
    const setup = () => runFixture({ [reader]: () => ({ ok: false, reason: 'review-unfinished' }),
      headNeverReviewed: vi.fn(() => true) });
    it('allows a full review without a finished review and never dispatches a red team', () => {
      const o = setup(); delete o.rawPrs[0].reviews;
      expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', why: 'head never reviewed; a review is always allowed' });
      expect(o.readReviews).toHaveBeenCalledOnce();
      expect(o.headNeverReviewed).toHaveBeenCalledWith({ repo, pr, head });
      expect(o.dispatch).toHaveBeenCalledOnce(); expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
      expect(o.escalate).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    });
    it.each(['unknown scan', 'throwing scan', 'unreadable reviews', 'formal hold', 'hold comment',
      'red-team:blocked', 'review:changes', 'review-status:reviewing', 'cooldown'])(
      'does not dispatch with %s', kind => {
        const o = setup();
        if (kind === 'unknown scan') o.headNeverReviewed = () => false;
        if (kind === 'throwing scan') o.headNeverReviewed = () => { throw Error('unknown'); };
        if (kind === 'unreadable reviews') { delete o.rawPrs[0].reviews; o.readReviews = () => { throw Error('offline'); }; }
        if (kind === 'formal hold') o.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
        if (kind === 'hold comment') o.rawPrs[0].comments.push(trusted('do not merge', iso(acceptedAt + 1)));
        if (kind.includes(':')) o.rawPrs[0].labels.push(kind);
        if (kind === 'cooldown') o.lastDispatch.set(`${repo}#${pr}@${head}`, o.now() - 1);
        expect(mod.runRedTeamOnSkip(o).rows[0].action).toBe('skip');
        expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
        if (['unknown scan', 'throwing scan'].includes(kind)) expect(o.escalate).toHaveBeenCalledWith({ repo, pr, head, why: 'review-unfinished' });
      });
  });
});

describe('R640 default never-reviewed scan', () => {
  it('allows this head with a persisted unfinished review on another head', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r640-review-runs-'));
    try {
      writeFileSync(join(dir, 'review-pr-old.json'), JSON.stringify(assertRunRecord({ ...newRunRecord({ id: 'review-pr-old', op: 'review-pr', input: { repo, pr } }),
        findings: payload('needs-human', old).findings, verdict: null,
        pending: { kind: 'confirm', step: 'verdict', stepIndex: 1 }, effects: [] })));
      const o = runFixture({ env: { OPERATION_RUNS_DIR: dir }, readEvidence: () => ({ ok: false, reason: 'review-unfinished' }) });
      expect(mod.runRedTeamOnSkip(o).rows[0].action).toBe('review');
      expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
