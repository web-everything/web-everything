/** @file R863 ownership, safety, durable budgets, smells and health cadence regressions. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyOwner, planActions, processLive, selfAudit, detectSmells, runLiveOwnerWatchPass, probeLiveOwnerWatch } from '../pr-live-owner-watch.mjs';
import { feedTail, resolveLiveOwnerSettings, createLiveOwnerWatchIo } from '../pr-live-owner-watch-io.mjs';

const NOW = Date.parse('2026-11-10T18:00:00Z'), MIN = 60_000;
const ago = minutes => new Date(NOW - minutes * MIN).toISOString();
const pr = (overrides = {}) => ({ number: 863, repo: 'web-everything/web-everything', headRefOid: 'a'.repeat(40),
  labels: [], isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [], ...overrides });
const evidence = (overrides = {}) => ({ complete: true, claims: [], liveClaim: false, held: false, ...overrides });
const classified = (p = pr(), e = evidence()) => ({ pr: p, evidence: e, classification: classifyOwner(p, e, NOW) });
function harness(prs = [pr({ labels: ['status:fixing'] })], overrides = {}) {
  const history = [], events = [], state = {};
  const io = { repo: 'web-everything/web-everything', config: {}, acquireRun: vi.fn(() => vi.fn()),
    readHistory: vi.fn(() => [...history]), appendDecision: vi.fn(r => history.push(r)),
    readSweepHistory: vi.fn(() => ({ complete: true, records: [] })), listPRs: vi.fn(() => prs),
    readEvidence: vi.fn(() => evidence()), checkAdmission: vi.fn(() => ({ ok: true })),
    execute: vi.fn(() => ({ ok: true })), readGaps: vi.fn(() => []),
    readSmellState: vi.fn(() => ({ ...state })), writeSmellState: vi.fn(s => Object.assign(state, s)),
    emit: vi.fn(e => events.push(e)), readSystemEvidence: vi.fn(() => ({ prs })), ...overrides };
  const run = (mode = 'on', now = NOW) => runLiveOwnerWatchPass({ now, mode, env: {}, deps: io });
  return { io, history, events, state, run };
}

describe('pure owner classification and planning', () => {
  it('stale status:fixing with no live pid selects only clear-label', () => {
    expect(planActions([classified(pr({ labels: ['status:fixing'] }))], [], NOW)).toMatchObject([{ action: 'clear-label', label: 'status:fixing' }]);
  });
  it('live progressing fixer owns the PR and selects no action', () => {
    const row = classified(pr({ labels: ['status:fixing'] }), evidence({ claims: [{ alive: true, activityMs: NOW - MIN, kind: 'fix' }] }));
    expect(row.classification.owner).toBe('live-process'); expect(planActions([row], [], NOW)).toEqual([]);
  });
  it.each([{ alive: true, stat: 'Z+' }, { alive: true, command: 'claude <defunct>' }])('zombie/defunct pid is none: %j', claim => {
    expect(classifyOwner(pr(), evidence({ claims: [claim] }), NOW).owner).toBe('none');
    expect(processLive(claim)).toBe(false);
  });
  it('dead red-team with running status selects red-team dispatch', () => {
    const row = classified(pr(), evidence({ redTeam: { status: 'running', alive: true, stat: 'Z', startedAt: ago(5) } }));
    expect(row.classification.owner).toBe('none');
    expect(planActions([row], [], NOW)[0].action).toBe('red-team-dispatch');
  });
  it.each(['review:human', 'needs-you', 'operator-approval'])('operator label %s permits NEEDS-YOU only', label => {
    const row = classified(pr({ labels: [label, 'status:fixing', 'review:changes'], mergeable: 'CONFLICTING' }));
    expect(row.classification.owner).toBe('operator');
    expect(planActions([row], [], NOW).map(a => a.action)).toEqual(['needs-you']);
  });
  it('stacked on open PR X waits with a deadline', () => {
    const row = classified(pr(), evidence({ stackedOn: 12, stackSince: ago(10) }));
    expect(row.classification).toMatchObject({ owner: 'external-wait' });
    expect(row.classification.detail).toMatch(/stacked-on-PR-12; deadline=/);
    expect(planActions([row], [], NOW)).toEqual([]);
  });
  it('CI running on the current head within budget waits', () => {
    const row = classified(pr({ statusCheckRollup: [{ status: 'IN_PROGRESS', startedAt: ago(5) }] }));
    expect(row.classification.owner).toBe('external-wait'); expect(planActions([row], [], NOW)).toEqual([]);
  });
  it('live non-zombie red-team waits, while unknown PID evidence fails closed', () => {
    expect(classifyOwner(pr(), evidence({ redTeam: { status: 'running', alive: true, startedAt: ago(5) } }), NOW).owner).toBe('external-wait');
    expect(classifyOwner(pr(), evidence({ redTeam: { status: 'running', alive: null } }), NOW).detail).toBe('evidence-unavailable');
  });
  it('queued review within budget waits with a deadline', () => {
    expect(classifyOwner(pr(), evidence({ reviewQueuedAt: ago(5) }), NOW)).toMatchObject({ owner: 'external-wait' });
  });
  it('live owner past progress budget escalates to operator inspection without takeover', () => {
    const row = classified(pr({ labels: ['status:fixing'] }), evidence({ claims: [{ alive: true, activityMs: NOW - 21 * MIN }] }));
    expect(row.classification).toMatchObject({ owner: 'none', detail: 'stalled-owner', overBudget: true, progressAgeMin: 21 });
    expect(planActions([row], [], NOW)[0]).toMatchObject({ action: 'needs-you', reason: expect.stringContaining('operator must inspect before recovery') });
  });
  it.each([
    [pr({ mergeable: 'CONFLICTING' }), {}, 'fix-dispatch'],
    [pr({ labels: ['review:changes'] }), {}, 'fix-dispatch'],
    [pr({ labels: ['review:pending'] }), {}, 'review-dispatch'],
    [pr(), { redTeamOwed: true }, 'red-team-dispatch'],
    [pr(), { missingRequiredCheck: true }, 'refresh-check'],
    [pr(), { stuckRequiredCheck: true }, 'refresh-check'],
  ])('maps the owed state to its existing entry point (%s)', (p, e, action) => {
    expect(planActions([classified(p, evidence(e))], [], NOW)[0].action).toBe(action);
  });
  it('bot timing-only PR selects validator and missing validator selects NEEDS-YOU', () => {
    const p = pr({ author: { login: 'app-bot' }, files: [{ path: 'scripts/ci/test-timings.json' }] });
    expect(planActions([classified(p, evidence({ validatorAvailable: true }))], [], NOW)[0].action).toBe('validate-data-refresh');
    expect(planActions([classified(p)], [], NOW)[0]).toMatchObject({ action: 'needs-you', reason: 'validator missing' });
  });
  it('caps one action per PR per hour across changed heads and counts orphan intent', () => {
    const row = classified(pr({ labels: ['status:fixing'] }));
    for (const phase of ['would-do', 'intent', 'did']) {
      const history = [{ repo: row.pr.repo, pr: 863, head: 'old', phase, ts: ago(59) }];
      expect(planActions([row], history, NOW)).toEqual([]);
      expect(planActions([row], history, NOW + 2 * MIN)).toHaveLength(1);
    }
    expect(planActions([row, row], [], NOW)).toHaveLength(1);
  });
  it('draft, unreadable evidence and existing live claims never act', () => {
    expect(planActions([classified(pr({ isDraft: true, labels: ['status:fixing'] }))], [], NOW)).toEqual([]);
    expect(planActions([classified(pr({ labels: ['status:fixing'] }), { complete: false })], [], NOW)).toEqual([]);
    expect(planActions([classified(pr({ labels: ['status:fixing'] }), evidence({ liveClaim: true }))], [], NOW)).toEqual([]);
    expect(planActions([classified(pr({ labels: ['status:fixing'] }), evidence({ claims: [{ alive: null }] }))], [], NOW)).toEqual([]);
  });
});

describe('pass audit and admission', () => {
  it('shadow writes only would-do records and never calls an injected dispatcher', async () => {
    const h = harness(); const result = await h.run('shadow');
    expect(result.actions.map(r => r.phase)).toEqual(['would-do']); expect(h.io.execute).not.toHaveBeenCalled();
    expect(h.history[0]).toMatchObject({ ts: new Date(NOW).toISOString(), repo: h.io.repo, pr: 863, head: 'a'.repeat(40), ownerClass: 'none', action: 'clear-label', reason: 'unowned' });
    expect(h.history[0].et).toBeTruthy();
    await h.run('shadow'); expect(h.history).toHaveLength(1);
  });
  it('records intent before execution and did only after proven success', async () => {
    const h = harness(); h.io.execute.mockImplementation(() => { expect(h.history.map(r => r.phase)).toEqual(['intent']); return { ok: true }; });
    expect((await h.run()).actions.map(r => r.phase)).toEqual(['intent', 'did']);
    await h.run(); expect(h.io.execute).toHaveBeenCalledTimes(1);
  });
  it('fresh live claim blocks an action even after an unowned snapshot', async () => {
    const h = harness(undefined, { checkAdmission: vi.fn(() => ({ ok: false, reason: 'live claim' })) });
    const result = await h.run(); expect(result.held).toContainEqual({ pr: 863, reason: 'live claim' });
    expect(h.io.execute).not.toHaveBeenCalled(); expect(h.history).toEqual([]);
  });
  it('awaiting operator emits NEEDS-YOU only and never changes labels or dispatches', async () => {
    const h = harness([pr({ labels: ['review:human', 'status:fixing'] })]);
    await h.run(); expect(h.events[0].reason).toContain('operator-approval');
    expect(h.io.execute).not.toHaveBeenCalled(); expect(h.history).toEqual([]);
  });
  it('validator path uses the injected action adapter and missing validator only emits', async () => {
    const p = pr({ author: 'app-bot', files: ['scripts/ci/test-timings.json'] });
    const h = harness([p], { readEvidence: vi.fn(() => evidence({ validatorAvailable: true })) });
    await h.run(); expect(h.io.execute.mock.calls[0][0].action).toBe('validate-data-refresh');
    const missing = harness([p]); await missing.run();
    expect(missing.events[0].reason).toContain('validator missing'); expect(missing.io.execute).not.toHaveBeenCalled();
  });
  it('skips PRs handled by stall-sweep during the same hour', async () => {
    const h = harness(undefined, { readSweepHistory: () => ({ complete: true, records: [{ repo: pr().repo, pr: 863, ts: ago(10), phase: 'intent' }] }) });
    const result = await h.run(); expect(result.considered).toBe(0); expect(h.io.execute).not.toHaveBeenCalled();
  });
  it.each(['audit', 'sweep', 'oversized', 'labels', 'lock'])('fails closed on %s with operator-visible fallback', async type => {
    const h = harness();
    if (type === 'audit') h.io.readHistory = () => { throw Error('corrupt audit'); };
    if (type === 'sweep') h.io.readSweepHistory = () => ({ complete: false });
    if (type === 'oversized') h.io.listPRs = () => Array.from({ length: 101 }, (_, n) => pr({ number: n + 1 }));
    if (type === 'labels') h.io.readEvidence = () => { throw Error('label read failed'); };
    if (type === 'lock') h.io.acquireRun = () => { throw Error('busy lock'); };
    const result = await h.run(); expect(h.io.execute).not.toHaveBeenCalled();
    expect(result.held.some(r => /operator/.test(r.reason))).toBe(true);
    expect(h.events.some(e => e.reason.includes('evidence-unavailable'))).toBe(true);
  });
  it('a refused dispatch retains intent, omits did and escalates without retry', async () => {
    const h = harness(undefined, { execute: vi.fn(() => ({ ok: false, reason: 'held by admission' })) });
    await h.run(); await h.run(); expect(h.io.execute).toHaveBeenCalledTimes(1);
    expect(h.history.map(r => r.phase)).toEqual(['intent']); expect(h.events[0].reason).toContain('action-failed');
  });
  it('oversized hook gaps stop automation and request inspection of the full input', async () => {
    const h = harness(undefined, { readGaps: () => Array.from({ length: 5001 }, () => ({ action: 'stale label' })) });
    const result = await h.run(); expect(h.io.execute).not.toHaveBeenCalled();
    expect(result.held[0].reason).toMatch(/hook gaps.*oversized.*operator must inspect full input/);
  });
});

describe('system smells and self-audit', () => {
  const system = () => ({ prs: [pr({ mergeStateStatus: 'CLEAN', ready: true })], lastMergeAt: ago(31),
    overlays: [{ clone: 'review-clone', ref: 'lane/example', registered: true, adopted: false, at: ago(21) }], heavyFallback: true });
  it('each smell fires and durable state deduplicates it for 60 minutes', async () => {
    const h = harness([], { readSystemEvidence: system });
    const first = await h.run(); expect(first.smells.map(s => s.key)).toEqual(['NO-MERGE', 'OVERLAY-OVERDUE-STALE:review-clone:lane/example', 'HEAVY-MAC-FALLBACK']);
    expect((await h.run()).smells).toEqual([]);
    expect((await h.run('on', NOW + 61 * MIN)).smells).toHaveLength(3);
  });
  it('existing FORGE-FALLBACK feed event suppresses duplicate heavy event', () => {
    expect(detectSmells({ heavyFallback: true, feedEvents: [{ kind: 'FORGE-FALLBACK' }] }, NOW)).toEqual([]);
  });
  it('smells require observed clean readiness, merge timestamps and registered unadopted overlays', () => {
    expect(detectSmells({ prs: [pr({ ready: true })], overlays: [{ adopted: false, at: ago(50) }] }, NOW)).toEqual([]);
    expect(detectSmells({ ...system(), lastMergeAt: ago(2), overlays: [], heavyFallback: false }, NOW)).toEqual([]);
    expect(detectSmells({ ...system(), prs: [pr({ isDraft: true, mergeStateStatus: 'CLEAN', ready: true })], overlays: [], heavyFallback: false }, NOW)).toEqual([]);
  });
  it('selfAudit reports unruled classes, excludes ruled ones and groups source/action keywords', () => {
    const audit = selfAudit([{ action: 'dead red-team restart' }, { eventSource: 'load-gate hold' }, { action: 'stale label clear' }]);
    expect(audit.counts).toMatchObject({ 'dead-red-team': 1, 'stale-label': 1, 'load-gate-hold': 1 });
    expect(audit.unruled).toEqual(['load-gate-hold']); expect(audit.summary).toContain('load-gate-hold (1)');
  });
  it('unruled summary emits once per 24 hours and appears in every pass result', async () => {
    const h = harness([], { readGaps: () => [{ gapClass: 'false-positive' }] });
    expect((await h.run()).selfAudit.unruled).toEqual(['false-positive']);
    await h.run('on', NOW + 61 * MIN); expect(h.events.filter(e => e.reason.startsWith('SELF-AUDIT'))).toHaveLength(1);
    await h.run('on', NOW + 1441 * MIN); expect(h.events.filter(e => e.reason.startsWith('SELF-AUDIT'))).toHaveLength(2);
  });
});

describe('health-watch registration', () => {
  it('registers an awaited, attempt-wrapped pass with the shared tick budget', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/conveyor/health-watch.mjs'), 'utf8');
    expect(source).toContain("probes.liveOwnerWatch = await attempt('liveOwnerWatch'");
    expect(source).toContain('remainingMs: Math.max(0, (config.tickBudgetMs');
    expect(source).toContain('probeErrors.liveOwnerWatch = probes.liveOwnerWatch.error');
  });
  it('interval gating runs every five minutes and treats future cache stamps as stale', async () => {
    let cache; const runPass = vi.fn(() => ({ considered: 1 }));
    const args = { dir: 'unused', now: NOW, runPass, readCache: () => cache, writeCache: value => { cache = value; } };
    await probeLiveOwnerWatch(args);
    expect((await probeLiveOwnerWatch({ ...args, now: NOW + 4 * MIN })).cached).toBe(true);
    await probeLiveOwnerWatch({ ...args, now: NOW + 5 * MIN }); expect(runPass).toHaveBeenCalledTimes(2);
    await probeLiveOwnerWatch({ ...args, now: NOW - MIN }); expect(runPass).toHaveBeenCalledTimes(3);
  });
  it('pass failure is fail-soft and does not cache success', async () => {
    const writeCache = vi.fn(); const result = await probeLiveOwnerWatch({ dir: 'unused', now: NOW, readCache: () => null,
      writeCache, runPass: () => { throw Error('probe failed'); } });
    expect(result.error).toBe('probe failed'); expect(writeCache).not.toHaveBeenCalled();
  });
  it('corrupt health cache and invalid intervals fail soft without running a pass', async () => {
    const runPass = vi.fn(), args = { dir: 'unused', now: NOW, runPass, writeCache: vi.fn() };
    expect((await probeLiveOwnerWatch({ ...args, readCache: () => { throw Error('corrupt'); } })).error).toContain('cache unreadable');
    expect((await probeLiveOwnerWatch({ ...args, readCache: () => null, config: { liveOwnerWatch: { intervalMinutes: 0 } } })).error).toContain('invalid');
    expect(runPass).not.toHaveBeenCalled();
  });
  it('isolated fixtures and exhausted tick budget never run the pass', async () => {
    const runPass = vi.fn(), base = { dir: 'unused', now: NOW, readCache: () => null, writeCache: vi.fn(), runPass };
    await probeLiveOwnerWatch({ ...base, flags: { 'state-root': 'fixture' } });
    await probeLiveOwnerWatch({ ...base, remainingMs: 10 }); expect(runPass).not.toHaveBeenCalled();
  });
});

describe('portable feed IO and settings', () => {
  const dirs = []; afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
  async function localIo(adapters = {}, now = NOW, dir) {
    if (!dir) { dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'live-owner-')); dirs.push(dir); }
    writeFileSync(join(dir, 'platform.json'), '{}');
    const env = { GH_REPO: pr().repo, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'platform.json'),
      WE_COORDINATION_ROOT: join(dir, 'coordination'), WE_LIVE_OWNER_WATCH_DIR: join(dir, 'watch'), WE_NEEDS_YOU_FEED: join(dir, 'feed.jsonl'), WE_POLICY_CASCADE_LOG: '0' };
    return { dir, io: await createLiveOwnerWatchIo({ env, home: dir, root: dir, now, adapters: {
      lockOptions: { stamp: () => ({ runnerStart: 'fixture-birth' }), identity: () => ({ alive: true }) }, ...adapters,
    } }) };
  }
  it('reads the existing human + JSON feed format as a byte tail', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'live-owner-')); dirs.push(dir);
    const path = join(dir, 'events.jsonl'), line = 'NEEDS-YOU repo#0 live-owner-watch: NO-MERGE {"at":"2026-11-10T18:00:00Z","kind":"live-owner-watch"}';
    writeFileSync(path, `${line}\n`); expect(feedTail(path)).toEqual([line]);
  });
  it('bounds feed read offset and length to 2 MiB and excludes the partial leading record', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'live-owner-')); dirs.push(dir);
    const path = join(dir, 'large-feed.jsonl'), limit = 2 * 1024 * 1024;
    const last = 'NEEDS-YOU repo#0 live-owner-watch: retained';
    const bytes = Buffer.from(`${'x'.repeat(limit + 100)}\n${last}\n`);
    writeFileSync(path, bytes);
    const read = vi.fn(readSync);
    expect(feedTail(path, { read })).toEqual([last]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0].slice(2)).toEqual([0, limit, bytes.length - limit]);
    expect(read.mock.calls[0][1]).toHaveLength(limit);
    expect(read.mock.results[0].value).toBe(limit);
  });
  it.each(['fix', 'build', 'review'])('production %s owner evidence escalates an inactive living owner through a pass and retains admission', async kind => {
    const p = pr({ labels: ['status:fixing'], baseRefName: 'main', headRefName: 'lane/fixture' });
    let alive = true, activityMs = NOW - 21 * MIN;
    const { io, dir } = await localIo({
      readAgents: () => [{ name: 'fixture-owner', repo: p.repo, pr: p.number, kind, state: 'running' }],
      probePid: () => ({ alive }), readActivity: () => activityMs,
      readRedTeamStatus: () => null, readLedgerSnapshot: () => ({ status: 'ok', rows: [] }),
      readRequiredChecks: () => ({ source: 'live', checks: [] }),
      readGhText: () => JSON.stringify({ headRefOid: p.headRefOid, labels: p.labels.map(name => ({ name })), isDraft: false }),
    });
    const e = await io.readEvidence(p, [p]);
    expect(e).toMatchObject({ complete: true, liveClaim: true, held: false, claims: [{ alive: true, kind, activityMs }] });
    expect(await io.checkAdmission(p)).toMatchObject({ ok: false, reason: expect.stringContaining('live/unknown claim') });
    const execute = vi.fn(), deps = { ...io, execute, listPRs: () => [p],
      readSweepHistory: () => ({ complete: true, records: [] }), readSystemEvidence: () => ({ prs: [] }) };
    const result = await runLiveOwnerWatchPass({ now: NOW, mode: 'on', deps });
    expect(result.held).toEqual([]); expect(result.actions).toEqual([]);
    expect(execute).not.toHaveBeenCalled(); expect(io.readHistory()).toEqual([]);
    const events = () => feedTail(join(dir, 'feed.jsonl'));
    expect(events()).toHaveLength(1);
    expect(events()[0]).toContain('stalled-owner: living worker exceeded progress budget; operator must inspect before recovery');
    await runLiveOwnerWatchPass({ now: NOW, mode: 'on', deps });
    expect(events()).toHaveLength(1); // Escalation is rate limited across passes.
    activityMs = NOW;
    expect(classifyOwner(p, await io.readEvidence(p, [p]), NOW).owner).toBe('live-process');
    expect(await io.checkAdmission(p)).toMatchObject({ ok: false });
    activityMs = null; alive = null;
    const unknown = await io.readEvidence(p, [p]);
    expect(classifyOwner(p, unknown, NOW).detail).toBe('evidence-unavailable');
    expect(planActions([classified(p, unknown)], [], NOW)).toEqual([]);
    expect(await io.checkAdmission(p)).toMatchObject({ ok: false });
    expect(execute).not.toHaveBeenCalled();
  });
  it('settings cascade defaults shadow, permits env override and closes invalid modes', () => {
    const opts = { env: {}, tool: {}, platform: {}, log: vi.fn() };
    expect(resolveLiveOwnerSettings(opts).mode).toBe('shadow');
    expect(resolveLiveOwnerSettings({ ...opts, env: { WE_LIVE_OWNER_WATCH_MODE: 'on' } }).mode).toBe('on');
    expect(resolveLiveOwnerSettings({ ...opts, tool: { mode: 'garbage' } }).mode).toBe('shadow');
  });
  it('real label adapter removes status:fixing only, using the shared provider path', async () => {
    const setLabels = vi.fn(); const { io } = await localIo({ labelProvider: { setLabels } });
    expect(await io.execute({ pr: pr(), action: 'clear-label' })).toEqual({ ok: true });
    expect(setLabels).toHaveBeenCalledWith(pr().repo, 863, { remove: ['status:fixing'] });
  });
  it('real review adapter forwards expectedHead to the injected manual dispatcher', async () => {
    const dispatchManualPass = vi.fn(() => ({ mode: 'session', agentId: 'review-agent' }));
    const { io } = await localIo({ dispatchManualPass });
    expect((await io.execute({ pr: pr(), action: 'review-dispatch' })).ok).toBe(true);
    expect(dispatchManualPass.mock.calls[0][0]).toEqual({ daemon: 'review', repo: pr().repo, pr: 863, expectedHead: pr().headRefOid });
  });
  it('dead red-team adapter abandons, replans recovery and forwards redTeamMode', async () => {
    const order = [], dispatchManualPass = vi.fn(input => { order.push('dispatch'); return { jobPid: 123 }; });
    const { io } = await localIo({ dispatchManualPass, readRedTeamStatus: () => ({ status: 'running' }),
      probePid: () => ({ alive: true, stat: 'Z' }), readRecoveryWitness: () => ({}),
      abandonStaleRedTeamRun: () => { order.push('abandon'); return { ok: true }; },
      planRedTeamRecovery: () => { order.push('replan'); return { abandon: false, mode: 'resume' }; } });
    expect((await io.execute({ pr: pr(), action: 'red-team-dispatch' })).ok).toBe(true);
    expect(order).toEqual(['abandon', 'replan', 'dispatch']);
    expect(dispatchManualPass.mock.calls[0][0]).toMatchObject({ daemon: 'red-team', redTeamMode: 'resume', expectedHead: pr().headRefOid });
  });
  const queueBaseline = { slots: 1, backlogMinutes: 0, maxWaitMinutes: 30 };
  const comment = (id, body = 'fixture comment') => ({ node_id: `IC_${id}`, body, user: { login: 'web-everything' } });
  function commentGh(comments = [], totalCount = comments.length) {
    return vi.fn(args => {
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount } } } } });
      const page = Number(args[1]?.match(/&page=(\d+)$/)?.[1]);
      if (!page) throw Error('unexpected GitHub call');
      return JSON.stringify(comments.slice((page - 1) * 100, page * 100));
    });
  }
  function fixAdapters(overrides = {}) {
    return { resolveLiveQueueBaseline: vi.fn(() => queueBaseline),
      buildFixThrottle: vi.fn(() => ({ tryAdmit: vi.fn(() => ({ admit: false, kind: 'fix-cap' })) })),
      readGhText: commentGh(), ...overrides };
  }
  it('fix adapter restricts the existing daemon planner to one PR and forwards active queue and daemon throttle gates', async () => {
    const reconcileFixDispatch = vi.fn(() => ({ dispatched: [{ pr: 863 }] }));
    const adapters = fixAdapters({ reconcileFixDispatch,
      resolveLiveQueueBaseline: vi.fn(() => ({ ...queueBaseline, backlogMinutes: 60 })) });
    const { io, dir } = await localIo(adapters);
    expect((await io.execute({ pr: pr(), action: 'fix-dispatch' })).ok).toBe(true);
    const input = reconcileFixDispatch.mock.calls[0][0];
    expect(input.repo).toBe('we'); expect(input.readPrs()).toEqual([{ ...pr(), comments: [] }]);
    expect(adapters.resolveLiveQueueBaseline).toHaveBeenCalledWith({ checkoutRoot: dir, env: expect.objectContaining({ GH_REPO: pr().repo }) });
    expect(adapters.buildFixThrottle).toHaveBeenCalledWith({ env: expect.objectContaining({ GH_REPO: pr().repo }) });
    expect(input.queueAdmission.active).toBe(true);
    expect(input.queueAdmission.tryAdmit('fix')).toMatchObject({ admit: false });
    expect(input.dispatchThrottle).toBe(adapters.buildFixThrottle.mock.results[0].value);
    expect(input.dispatchThrottle.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'fix-cap' });
  });
  it.each(['baseline throws', 'baseline missing', 'baseline bypassed', 'baseline malformed', 'throttle throws', 'throttle missing'])
  ('fix adapter holds when admission cannot be built: %s', async failure => {
    const reconcileFixDispatch = vi.fn(), adapters = fixAdapters({ reconcileFixDispatch });
    if (failure === 'baseline throws') adapters.resolveLiveQueueBaseline = () => { throw Error('unreadable'); };
    if (failure === 'baseline missing') adapters.resolveLiveQueueBaseline = () => null;
    if (failure === 'baseline bypassed') adapters.resolveLiveQueueBaseline = () => ({ ...queueBaseline, bypassed: 'error' });
    if (failure === 'baseline malformed') adapters.resolveLiveQueueBaseline = () => ({});
    if (failure === 'throttle throws') adapters.buildFixThrottle = () => { throw Error('unreadable'); };
    if (failure === 'throttle missing') adapters.buildFixThrottle = () => null;
    const { io } = await localIo(adapters);
    expect(await io.execute({ pr: pr(), action: 'fix-dispatch' })).toMatchObject({ ok: false,
      reason: expect.stringMatching(/admission unavailable; operator must inspect/) });
    expect(reconcileFixDispatch).not.toHaveBeenCalled(); expect(adapters.readGhText).not.toHaveBeenCalled();
  });
  it('fix adapter includes the complete validated thread, including markers beyond the first page', async () => {
    const comments = Array.from({ length: 101 }, (_, i) => comment(i));
    comments[100].body = '<!-- stand-down -->';
    const reconcileFixDispatch = vi.fn(() => ({ dispatched: [] })), readGhText = commentGh(comments);
    const { io } = await localIo(fixAdapters({ reconcileFixDispatch, readGhText }));
    await io.execute({ pr: pr(), action: 'fix-dispatch' });
    const snapshot = reconcileFixDispatch.mock.calls[0][0].readPrs()[0];
    expect(snapshot.comments).toHaveLength(101);
    expect(snapshot.comments[100]).toMatchObject({ id: 'IC_100', body: comments[100].body, author: { login: 'web-everything' } });
    expect(readGhText).toHaveBeenCalledTimes(3);
    expect(readGhText.mock.calls[0][0][1]).toBe(`repos/${pr().repo}/issues/863/comments?per_page=100&page=1`);
    expect(readGhText.mock.calls[2][0]).toContain('graphql');
  });
  it.each(['read fails', 'count mismatch', 'missing author', 'page cap'])
  ('fix adapter holds incomplete comments with full-thread operator fallback: %s', async failure => {
    const reconcileFixDispatch = vi.fn();
    let readGhText = commentGh([comment(1)], 2);
    if (failure === 'read fails') readGhText = vi.fn(() => { throw Error('unreadable'); });
    if (failure === 'missing author') readGhText = commentGh([{ ...comment(1), user: {} }]);
    if (failure === 'page cap') readGhText = commentGh(Array.from({ length: 1000 }, (_, i) => comment(i)));
    const { io } = await localIo(fixAdapters({ reconcileFixDispatch, readGhText }));
    expect(await io.execute({ pr: pr(), action: 'fix-dispatch' })).toMatchObject({ ok: false,
      reason: expect.stringMatching(/comments unavailable; operator must inspect full thread/) });
    expect(reconcileFixDispatch).not.toHaveBeenCalled();
    if (failure === 'page cap') expect(readGhText).toHaveBeenCalledTimes(10);
  });
  it('stale-base gate and optional validator use injected existing entry points', async () => {
    const staleBaseGate = vi.fn(() => ({ held: true, reason: 'stale-base refresh first: refreshed onto main, CI re-runs before any fixer' }));
    const validateDataRefresh = vi.fn(() => ({ ok: true }));
    const { io } = await localIo({ staleBaseGate, validateDataRefresh });
    expect((await io.execute({ pr: pr(), action: 'refresh-check' })).ok).toBe(true);
    expect(staleBaseGate.mock.calls[0][0]).toMatchObject({ repo: 'we', planned: { pr: 863 } });
    expect((await io.execute({ pr: pr(), action: 'validate-data-refresh' })).ok).toBe(true);
    expect(validateDataRefresh.mock.calls[0][0].expectedHead).toBe(pr().headRefOid);
  });
  it('monthly append-only decisions survive a new reader and the month boundary', async () => {
    const boundary = Date.parse('2026-12-01T00:10:00Z'), previous = new Date(boundary - 20 * MIN).toISOString();
    const { io, dir } = await localIo({}, boundary);
    const release = io.acquireRun();
    const record = { ts: previous, et: 'ET', repo: pr().repo, pr: 863, head: pr().headRefOid, ownerClass: 'none', action: 'clear-label', phase: 'intent', reason: 'unowned' };
    io.appendDecision(record); release();
    const next = (await localIo({}, boundary, dir)).io;
    expect(next.readHistory()).toEqual([record]);
    expect(planActions([classified(pr({ labels: ['status:fixing'] }))], next.readHistory(), boundary)).toEqual([]);
  });
  it('producer writes the exact existing human-plus-JSON feed format', async () => {
    const { io, dir } = await localIo();
    io.emit({ repo: pr().repo, pr: 0, head: '', kind: 'live-owner-no-merge', reason: 'NO-MERGE: inspect', at: new Date(NOW).toISOString() });
    const line = readFileSync(join(dir, 'feed.jsonl'), 'utf8');
    expect(line).toMatch(/^NEEDS-YOU web-everything\/web-everything#0 live-owner-no-merge: NO-MERGE: inspect \{"at":/);
    expect(line.trim().split('\n')).toHaveLength(1);
  });
  it('oversized on-disk audit fails closed with explicit full-input fallback', async () => {
    const { io, dir } = await localIo(); const release = io.acquireRun();
    writeFileSync(join(dir, 'watch', '2026-11.jsonl'), 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(() => io.readHistory()).toThrow(/oversized.*operator must inspect full input/); release();
  });
});
