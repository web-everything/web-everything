// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mod from '../review-red-team-on-skip.mjs';
import { RUN_MTIME_SLACK_MS, ABANDONED_REVIEW_AFTER_MS } from '../drain-red-team-evidence.mjs';
import { latestAcceptRecord } from '../accept-carry-forward.mjs';
import { redTeamMarker, redTeamForHead } from '../red-team-gate.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';
import { settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
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
  it('settles a recorded accept with matching finished not-owed evidence and live status', () => {
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.rawPrs[0].labels = ['red-team:pending']; o.rawPrs[0].comments = [];
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', settle: 'not-owed' });
    expect(o.settlePending).toHaveBeenCalledWith({ repo, pr, head, remove: ['red-team:pending'] });
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
  it.each(['!owed', 'acceptance sha mismatch', 'not accepted'])('%s non-owing stored review settles pending as not-owed', site => {
    const f = fixture();
    if (site === 'acceptance sha mismatch') {
      f.rawPrs[0].comments = [accept(old)];
      const status = { status: 'finished', result: 'not-owed' };
      f.readEvidence = () => evidence({ loopPayload: payload('changes'), status });
      f.readStatus = () => status;
    }
    if (site === 'not accepted') f.rawPrs[0].labels = ['review:prep', 'red-team:pending'];
    expect(redTeamOwedFor(f.readEvidence().loopPayload)).toBe(false);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team', settle: 'not-owed' });
  });

  it.each(['early result', 'post-evidence result'])('%s skip settles through result label synchronization', site => {
    const f = fixture(); f.rawPrs[0].comments.push(resultComment());
    // The unfinished journal bypasses the first result check; settled evidence reaches the second.
    if (site === 'post-evidence result') f.readCarry = () => ({ step: 'pending' });
    f.readEvidence = vi.fn(() => evidence({ carry: { step: 'done' } }));
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'red-team result already on head', settle: 'result' });
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
  it.each(['needsReview', 'carry'])('%s escalates lone pending without settling it', path => {
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

describe('review-unfinished reader retry with ignorable confirm ids', () => {
  it.each(['readWitness', 'readEvidence'])('%s re-reads once with ignoreRunIds and dispatches the owed accepted review', reader => {
    const f = fixture({ readEvidence: () => evidence({ loopPayload: payload('accept') }) });
    const success = reader === 'readWitness' ? { ok: true, rawWriter: { parsed: null } } : f.readEvidence();
    f[reader] = vi.fn().mockReturnValueOnce({ ok: false, reason: 'review-unfinished' }).mockReturnValue(success);
    f.readIgnorableConfirms = vi.fn(() => ['review-pr-old-confirm']);
    expect(decide(f)).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(f.readIgnorableConfirms).toHaveBeenCalledOnce();
    expect(f.readIgnorableConfirms).toHaveBeenCalledWith({ repo, pr, head, rawPr: f.rawPrs[0] });
    expect(f[reader].mock.calls).toEqual([[{ repo, pr, head }], [{ repo, pr, head, ignoreRunIds: ['review-pr-old-confirm'] }]]);
  });
  it.each(['readWitness', 'readEvidence'].flatMap(reader => ['empty ids', 'still unfinished', 'scan throws'].map(kind => [reader, kind])))(
    '%s fails closed for %s', (reader, kind) => {
      const f = fixture();
      f[reader] = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
      f.readIgnorableConfirms = vi.fn(() => { if (kind === 'scan throws') throw Error('scan failed'); return kind === 'empty ids' ? [] : ['review-pr-confirm']; });
      expect(decide(f)).toMatchObject({ action: 'skip', why: 'review-unfinished' });
      expect(f.readIgnorableConfirms).toHaveBeenCalledOnce();
      expect(f[reader]).toHaveBeenCalledTimes(kind === 'still unfinished' ? 2 : 1);
    });
  it.each(['readWitness', 'readEvidence'])('%s never re-reads a failure with another reason', reader => {
    const f = fixture(); f[reader] = vi.fn(() => ({ ok: false, reason: 'scan-capped' }));
    f.readIgnorableConfirms = vi.fn(() => ['review-pr-confirm']);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'scan-capped' });
    expect(f[reader]).toHaveBeenCalledOnce(); expect(f.readIgnorableConfirms).not.toHaveBeenCalled();
  });
});

describe.each(['readWitness', 'readEvidence'])('never-reviewed head recovery through %s', reader => {
  function neverReviewedFixture() {
    const f = fixture({ readIgnorableConfirms: vi.fn(() => []), headNeverReviewed: vi.fn(() => true) });
    f[reader] = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
    return f;
  }
  it.each(['accepted', 'unaccepted'])('%s never-reviewed head escalates lone pending before a full review', acceptance => {
    const f = neverReviewedFixture();
    if (acceptance === 'unaccepted') {
      f.rawPrs[0].labels = ['red-team:pending']; f.rawPrs[0].comments = [];
    }
    const row = decide(f);
    expect(row).toMatchObject({ action: 'skip', head, why: 'conflicting label prevents policy-clear', escalate: true });
    expect(row).not.toHaveProperty('settle');
    expect(f.rawPrs[0].labels).toContain('red-team:pending');
    expect(f.headNeverReviewed).toHaveBeenCalledOnce();
    expect(f.headNeverReviewed).toHaveBeenCalledWith({ repo, pr, head, rawPr: f.rawPrs[0] });
    expect(f.readIgnorableConfirms).toHaveBeenCalledOnce();
    expect(f[reader]).toHaveBeenCalledOnce();
    expect(decide(f)).toMatchObject({ action: 'skip', head, escalate: true, why: 'conflicting label prevents policy-clear' });
  });
  it.each([
    ['blocked label', f => { f.rawPrs[0].labels.push('red-team:blocked'); }, /conflicting label prevents policy-clear/],
    ['changes label', f => { f.rawPrs[0].labels.push('review:changes'); }, /conflicting label prevents policy-clear/],
    ['unreadable labels', f => { f.rawPrs[0].labels = null; }, /PR labels unreadable/],
    ['unreadable reviews', f => { f.rawPrs[0].reviews = null; }, /PR reviews unreadable/],
    ['later verdict', f => { f.rawPrs[0].comments.push(trusted('❌ review — changes requested')); }, /later verdict or hold supersedes acceptance/],
    ['later body-derived hold', f => { f.rawPrs[0].comments.push(trusted('manifest baseline mismatch')); }, /later verdict or hold supersedes acceptance/],
    ['formal hold without acceptance', f => {
      f.rawPrs[0].labels = []; f.rawPrs[0].comments = [];
      f.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
    }, /formal review hold prevents full review/],
    ['unreadable reviews without acceptance', f => {
      f.rawPrs[0].labels = []; f.rawPrs[0].comments = []; f.rawPrs[0].reviews = null;
    }, /PR reviews unreadable/],
  ])('refuses never-reviewed recovery for %s', (_name, mutate, why) => {
    const f = neverReviewedFixture(); f.rawPrs[0].labels = ['review:accepted']; mutate(f);
    const row = decide(f); expect(row.action).toBe('skip'); expect(row.why).toMatch(why);
    expect(row).not.toHaveProperty('settle');
  });
  it('applies dispatchDecision retry cooldown to never-reviewed recovery', () => {
    const f = neverReviewedFixture(); f.rawPrs[0].labels = ['review:accepted']; f.lastDispatch.set(`${repo}#${pr}@${head}`, f.now - 1);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
  });
  it('permits review at the retry cooldown boundary', () => {
    const f = neverReviewedFixture(); f.rawPrs[0].labels = ['review:accepted'];
    f.lastDispatch.set(`${repo}#${pr}@${head}`, f.now - f.setting.retryCooldownMin * 60_000);
    expect(decide(f)).toMatchObject({ action: 'review' });
  });
  it.each(['absent', 'false', 'throws'])('keeps review-unfinished when headNeverReviewed is %s', kind => {
    const f = neverReviewedFixture();
    if (kind === 'absent') delete f.headNeverReviewed;
    else f.headNeverReviewed = vi.fn(() => { if (kind === 'throws') throw Error('scan failed'); return false; });
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'review-unfinished' });
    expect(f[reader]).toHaveBeenCalledOnce();
  });
  it('never uses the never-reviewed predicate for another reader failure reason', () => {
    const f = neverReviewedFixture(); f[reader].mockReturnValue({ ok: false, reason: 'scan-capped' });
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'scan-capped' });
    expect(f.headNeverReviewed).not.toHaveBeenCalled();
  });
  it('dispatches the never-reviewed full review with only repo and pr', () => {
    const f = neverReviewedFixture(); f.rawPrs[0].labels = ['review:accepted'];
    const o = runFixture({ ...f, now: () => f.now });
    const out = mod.runRedTeamOnSkip(o);
    expect(out.rows[0]).toMatchObject({ action: 'review' });
    expect(o.dispatch.mock.calls).toEqual([[{ repo, pr }]]);
    expect(out.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'review' }]);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
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
  ])('an older-head unfinished %s prevents a never-reviewed proof', (_name, over) => {
    expect(scan(scanFixture({ 'review-pr-old': run(over) }))).toBe(false);
  });
  it('permits an older-head needs-human confirm with no outstanding effects', () => {
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

describe('ignorableConfirmRunIds chronology and closed scan', () => {
  const before = acceptedAt - RUN_MTIME_SLACK_MS - 1;
  const run = (over = {}) => ({ op: 'review-pr', input: { repo, pr },
    verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, effects: [],
    stepTimings: [{ step: 'read', startedAt: iso(before) }], ...over });
  function scanFixture(records = { 'review-pr-confirm': run() }) {
    return { repo, pr, head, comments: [accept()], reviews: [], labels: ['review:accepted', 'red-team:pending'],
      runsDir: 'fixture-runs', now: acceptedAt + 10_000,
      list: vi.fn(() => Object.keys(records)), read: vi.fn(id => records[id]),
      // A superseded confirm must have both started and last been written before acceptance.
      stat: vi.fn(() => ({ mtimeMs: before })) };
  }
  function scan(f) {
    expect(mod.ignorableConfirmRunIds, 'export the fail-closed confirm-run scanner').toBeTypeOf('function');
    return mod.ignorableConfirmRunIds(f);
  }
  it.each([acceptedAt + 1000, acceptedAt - RUN_MTIME_SLACK_MS, undefined, NaN, Infinity])(
    'refuses an old-start confirm with late or unreadable last-write time %s', mtimeMs => {
      const f = scanFixture(); f.stat = () => ({ mtimeMs });
      expect(scan(f)).toEqual({ ok: false, ids: [] });
    });
  it('ignores only old needs-human confirm runs, excluding finished and unrelated runs', () => {
    const f = scanFixture({ 'review-pr-confirm': run(),
      'review-pr-finished': run({ verdict: { verdict: 'accept' }, pending: null }),
      'review-pr-other-repo': run({ input: { repo: 'other/repo', pr } }),
      'review-pr-other-pr': run({ input: { repo, pr: pr + 1 } }),
      'review-pr-other-op': run({ op: 'other' }), 'other-op': run(),
    });
    expect(latestAcceptRecord(f.comments, f.reviews)).toMatchObject({ sha: head, laterVerdict: false, laterBodyDerivedHold: false });
    expect(scan(f)).toEqual({ ok: true, ids: ['review-pr-confirm'] });
    expect(f.read.mock.calls.map(([id]) => id)).not.toContain('other-op');
  });
  it.each([{}, [], { op: 'review-pr' }, { op: 'review-pr', input: { repo } }])('malformed review run invalidates all ignorable ids: %j', record => {
    expect(scan(scanFixture({ 'review-pr-confirm': run(), 'review-pr-malformed': record }))).toEqual({ ok: false, ids: [] });
  });
  it('accepts object-shaped accepted labels', () => {
    const f = scanFixture(); f.labels = [{ name: 'review:accepted' }];
    expect(scan(f)).toEqual({ ok: true, ids: ['review-pr-confirm'] });
  });
  it('returns no ids for a fully finished scan', () => {
    expect(scan(scanFixture({ 'review-pr-done': run({ pending: null }) }))).toEqual({ ok: true, ids: [] });
  });
  it('accepts an old resumed confirm only when both starts precede the slack boundary', () => {
    expect(scan(scanFixture({ 'review-pr-confirm': run({ resumeOf: 'review-pr-origin', resumedAt: iso(before) }) })))
      .toEqual({ ok: true, ids: ['review-pr-confirm'] });
  });
  it.each([
    ['no verdict', { verdict: null }], ['wrong verdict', { verdict: { verdict: 'accept' } }],
    ['not a confirm', { pending: { kind: 'agent' } }], ['no pending confirm', { verdict: null, pending: null }],
    ['pending effect', { effects: [{ status: 'pending' }] }], ['in-flight effect', { effects: [{ status: 'in-flight' }] }],
    ['missing read start', { stepTimings: [] }], ['invalid read start', { stepTimings: [{ step: 'read', startedAt: 'invalid' }] }],
    ['equal slack boundary', { stepTimings: [{ step: 'read', startedAt: iso(acceptedAt - RUN_MTIME_SLACK_MS) }] }],
    ['within slack', { stepTimings: [{ step: 'read', startedAt: iso(acceptedAt - 1) }] }],
    ['later start', { stepTimings: [{ step: 'read', startedAt: iso(acceptedAt + 1) }] }],
    ['resume missing resumedAt', { resumeOf: 'review-pr-origin' }],
    ['resume invalid resumedAt', { resumeOf: 'review-pr-origin', resumedAt: 'invalid' }],
    ['resume at slack boundary', { resumeOf: 'review-pr-origin', resumedAt: iso(acceptedAt - RUN_MTIME_SLACK_MS) }],
    ['resume after acceptance', { resumeOf: 'review-pr-origin', resumedAt: iso(acceptedAt + 1) }],
  ])('any unfinished run with %s invalidates the whole id list', (_name, over) => {
    expect(scan(scanFixture({ 'review-pr-ignorable': run(), 'review-pr-unsafe': run(over) }))).toEqual({ ok: false, ids: [] });
  });
  it('finished effects do not prevent ignoring an otherwise old confirm', () => {
    expect(scan(scanFixture({ 'review-pr-confirm': run({ effects: [{ status: 'applied' }] }) })))
      .toEqual({ ok: true, ids: ['review-pr-confirm'] });
  });
  it('omits abandoned verdict-less terminal attempts using the drain abandonment age', () => {
    const f = scanFixture({ 'review-pr-abandoned': run({ verdict: null, pending: null }) });
    f.stat = () => ({ mtimeMs: f.now - ABANDONED_REVIEW_AFTER_MS });
    expect(scan(f)).toEqual({ ok: true, ids: [] });
  });
  it('an old rewound resume is never treated as abandoned', () => {
    const f = scanFixture({ 'review-pr-rewound': run({ verdict: null, pending: null, resumeOf: 'review-pr-origin' }) });
    f.stat = () => ({ mtimeMs: f.now - ABANDONED_REVIEW_AFTER_MS - 1 });
    expect(scan(f)).toEqual({ ok: false, ids: [] });
  });
  it.each([
    ['unaccepted head', f => { f.labels = ['review:prep']; }],
    ['acceptance for another head', f => { f.comments = [accept(old)]; }],
    ['missing acceptance', f => { f.comments = []; }],
    ['later verdict', f => { f.comments.push(trusted('❌ review — changes requested')); }],
    ['later body-derived hold', f => { f.comments.push(trusted('manifest baseline mismatch')); }],
    ['later formal hold', f => { f.reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }]; }],
    ['unparseable acceptedAt', f => { f.comments[0].createdAt = 'invalid'; }],
    ['missing acceptedAt', f => { delete f.comments[0].createdAt; }],
    ['unreadable comments', f => { f.comments = undefined; }],
    ['list throws', f => { f.list = () => { throw Error('unreadable directory'); }; }],
    ['read throws', f => { f.read = () => { throw Error('unreadable record'); }; }],
    ['stat throws', f => { f.stat = () => { throw Error('unreadable metadata'); }; }],
  ])('fails closed with no ids when %s', (_name, mutate) => {
    const f = scanFixture(); mutate(f); expect(scan(f)).toEqual({ ok: false, ids: [] });
  });
  it('allows exactly 400 parsed review runs', () => {
    const records = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`review-pr-${i}`, run({ pending: null })]));
    const f = scanFixture(records); expect(scan(f)).toEqual({ ok: true, ids: [] });
    expect(f.read).toHaveBeenCalledTimes(400);
  });
  it('over 400 parses fails closed for operator inspection without partial ids or extra reads', () => {
    const records = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`review-pr-${i}`, run()]));
    const f = scanFixture(records); expect(scan(f)).toEqual({ ok: false, ids: [] });
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(400);
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
  it('unreadable live state reports settleError for not-owed', () => {
    const { provider, settle } = setup();
    provider.readPrState.mockImplementation(() => { throw Error('live state unreadable'); });
    const o = runFixture({ settlePending: settle });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ settle: 'not-owed', settleError: 'live state unreadable' });
    expect(provider.setLabels).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('runner settles pending without dispatch', () => {
  it.each(['carry', 'needsReview'])('%s escalates lone pending and keeps the merge hold across ticks', path => {
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
    expect(row.why).toBe('conflicting label prevents policy-clear');
    expect(row).not.toHaveProperty('settleError');
    expect(o.settle).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['pending', 'real conflict'])('dryRun never settles a guard conflict: %s', kind => {
    const o = runFixture({ dryRun: true, readEvidence: () => evidence({ loopPayload: undefined }) });
    if (kind === 'real conflict') o.rawPrs[0].labels.push('red-team:blocked');
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.escalate).not.toHaveBeenCalled();
  });
  it('not-owed removes only pending and never adds a label', () => {
    const o = runFixture(); const out = mod.runRedTeamOnSkip(o);
    expect(o.settlePending).toHaveBeenCalledOnce();
    expect(o.settlePending).toHaveBeenCalledWith({ repo, pr, head, remove: ['red-team:pending'] });
    expect(out.rows[0]).toMatchObject({ action: 'skip', settle: 'not-owed' });
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled(); expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
  });
  it.each(['red-team:blocked', { name: 'red-team:blocked' }])('not-owed preserves blocked label %j', label => {
    const o = runFixture(); o.rawPrs[0].labels.push(label); mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each([false, true])('a result (confirmed break=%s) synchronizes labels only', confirmed => {
    const o = runFixture(); o.rawPrs[0].comments.push(resultComment(confirmed));
    expect(redTeamForHead(o.rawPrs[0].comments, pr, head)?.findings).toHaveLength(confirmed ? 1 : 0);
    const labels = [];
    o.syncLabels = vi.fn(key => {
      labels.push(planRedTeamStatusLabels({ ...key, labels: o.rawPrs[0].labels,
        comments: o.rawPrs[0].comments, evidence: evidence(), env: { WE_RED_TEAM_CONFIRMED_BREAKS: 'broken=send-back' }, standingRuling: null }));
    });
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(o.syncLabels).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head }));
    expect(labels).toEqual([{ add: confirmed ? 'red-team:blocked' : 'red-team:clear', remove: ['red-team:pending'] }]);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['not-owed', 'result'])('dryRun settles nothing for %s', kind => {
    const o = runFixture({ dryRun: true }); if (kind === 'result') o.rawPrs[0].comments.push(resultComment());
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
  it.each(['settlePending', 'syncLabels'])('%s failure is reported in settleError with unchanged why and does not abort the next row', method => {
    const o = runFixture(); if (method === 'syncLabels') o.rawPrs[0].comments.push(resultComment());
    o[method] = vi.fn().mockImplementationOnce(() => { throw Error('settlement offline'); }).mockReturnValue(undefined);
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: pr + 1, headSha: head });
    o.rawPrs.push({ ...o.rawPrs[0], number: pr + 1, comments: [accept()] });
    if (method === 'syncLabels') o.rawPrs[1].comments.push(trusted(`${redTeamMarker(pr + 1, head)}\nRed team not required on this head: card-only diff`));
    const out = mod.runRedTeamOnSkip(o);
    expect(out.rows).toHaveLength(2); expect(out.rows[0].settleError).toBe('settlement offline');
    expect(out.rows[0].why).toBe(method === 'syncLabels' ? 'red-team result already on head' : 'stored review does not owe a red team');
    expect(out.rows[1]).toMatchObject({ prNumber: pr + 1, settle: method === 'syncLabels' ? 'result' : 'not-owed' });
    expect(o[method]).toHaveBeenCalledTimes(2);
  });
  it.each(['unreadable comments', 'head moved'])('%s never settles pending or result labels', guard => {
    const o = runFixture(); if (guard === 'unreadable comments') o.rawPrs[0].comments = undefined;
    else o.rawPrs[0].headRefOid = old;
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: guard === 'head moved' ? 'live head missing or changed' : 'PR comments unreadable' });
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
  it.each(['lone pending', 'real conflict'])('%s escalation publishes needs-you once across two ticks using real skip-published dedupe', kind => {
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
