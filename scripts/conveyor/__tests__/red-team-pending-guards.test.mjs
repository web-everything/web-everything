/** Guard regressions supplement the committed phase-1 contract without changing its fixtures. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPendingRedTeam } from '../../lib/red-team-pending-watchdog.mjs';
import { runStallSweep, STALL_SWEEP_DEFAULTS, planStallActions, pendingOwnerPidAlive } from '../pr-stall-sweep.mjs';

const evidence = patch => ({ now: 0, ageMinutes: 300, status: null, ownerAlive: null,
  restarts: 0, minutesSinceLastRestart: null, thresholdMinutes: 90, maxRestarts: 3,
  staleRunMinutes: 240, ...patch });

describe('explicit watchdog guard boundaries', () => {
  it('live-owner suppression wins beyond a nondefault stale deadline', () => {
    expect(planPendingRedTeam(evidence({ status: { status: 'running' }, ownerAlive: true })).kind).toBe('wait');
  });
  it('unknown-owner grace honors the configured stale deadline inclusively', () => {
    const status = { status: 'queued', startedAt: new Date(0).toISOString() };
    expect(planPendingRedTeam(evidence({ status, now: 239.99 * 60_000 })).kind).toBe('wait');
    expect(planPendingRedTeam(evidence({ status, now: 240 * 60_000 })).kind).toBe('restart');
  });
  it('restart cooldown honors a nondefault threshold inclusively', () => {
    expect(planPendingRedTeam(evidence({ restarts: 1, minutesSinceLastRestart: 89.99 })).kind).toBe('wait');
    expect(planPendingRedTeam(evidence({ restarts: 1, minutesSinceLastRestart: 90 })).kind).toBe('restart');
  });
  it('restart ceiling escalates at a nondefault budget and includes operator evidence', () => {
    expect(planPendingRedTeam(evidence({ restarts: 2, minutesSinceLastRestart: 100 })).kind).toBe('restart');
    expect(planPendingRedTeam(evidence({ restarts: 3, minutesSinceLastRestart: 100 }))).toEqual({
      kind: 'exhausted', reason: expect.stringMatching(/3.*300.*operator/),
    });
  });
  it('publication requires both finished status and a real ran result', () => {
    expect(planPendingRedTeam(evidence({ status: { status: 'finished', result: { status: 'ran' } } })).kind).toBe('publish-result');
    expect(planPendingRedTeam(evidence({ status: { status: 'running', result: { status: 'ran' } }, ownerAlive: true })).kind).toBe('wait');
    expect(planPendingRedTeam(evidence({ status: { status: 'finished', result: { status: 'failed' } } })).kind).toBe('restart');
    expect(planPendingRedTeam(evidence({ status: { status: 'finished', result: 'ran' } })).kind).toBe('restart');
  });
});

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T18:00:00Z');
const roots = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

async function sweep({ ageMinutes = 90, start = 'original-owner', status = 'running', result = null,
  host = 'local-host', namespace = 'local-ns', dir, now = NOW, readStatus, probePatch, peer = false, incomplete = false } = {}) {
  if (!dir) { dir = mkdtempSync(join(tmpdir(), 'red-team-guards-')); roots.push(dir); }
  const at = new Date(NOW - ageMinutes * 60_000).toISOString();
  const pr = { repo: REPO, number: 11, headRefOid: HEAD, title: 'pending head', body: '', isDraft: false,
    updatedAt: at, createdAt: at, headCommittedAt: at, labels: ['red-team:pending'], labelEvents: [],
    comments: [], statusCheckRollup: [] };
  const probe = { host: 'local-host', namespace: 'local-ns', isAlive: vi.fn(() => true), readPidStart: vi.fn(() => start), ...probePatch };
  const gh = vi.fn(() => { throw new Error('unexpected GitHub call'); });
  const out = await runStallSweep({ now, env: {}, dir, settings: { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow' }, sources: {}, errors: [] },
    read: () => ({ now, prs: peer ? [pr, { ...pr, number: 12 }] : [pr], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }), gh, probe,
    readRedTeamStatus: readStatus ?? (() => ({ repo: REPO, pr: 11, head: HEAD, status, result,
      host, pidNamespace: namespace, pid: 12345, pidStart: 'original-owner' })), log: () => {} });
  expect(gh).not.toHaveBeenCalled();
  expect(out.incomplete).toBe(incomplete);
  return { out, probe, dir };
}

describe('shadow sweep owner identity and result guards', () => {
  it('PID reuse proves the old owner dead before the unknown-owner deadline', async () => {
    const { out, probe } = await sweep({ start: 'replacement-process' });
    expect(probe.isAlive).toHaveBeenCalledWith(12345);
    expect(probe.readPidStart).toHaveBeenCalledWith(12345);
    expect(out.act).toMatchObject([{ action: 'restart-red-team', headCap: 2 }]);
    expect(out.records.filter(r => r.phase === 'would-do')).toMatchObject([{ action: 'restart-red-team', mode: 'shadow' }]);
  });
  it('a matching live PID birth time suppresses restarts beyond the stale deadline', async () => {
    const { out, probe } = await sweep({ ageMinutes: 300 });
    expect(probe.readPidStart).toHaveBeenCalledWith(12345);
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
  it('an unavailable PID birth time retains the live-owner hold', async () => {
    const { out } = await sweep({ ageMinutes: 300, start: null });
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
  it.each([{ host: 'remote-host' }, { namespace: 'remote-ns' }])('unknown-owner grace never probes a foreign PID: %j', async identity => {
    const { out, probe } = await sweep(identity);
    expect(probe.isAlive).not.toHaveBeenCalled();
    expect(probe.readPidStart).not.toHaveBeenCalled();
    expect(out.act).toEqual([]);
  });
  it('the sweep publishes only a finished ran result and never labels it clear or accept', async () => {
    const finished = await sweep({ status: 'finished', result: { status: 'ran' } });
    expect(finished.out.act).toMatchObject([{ action: 'publish-red-team-result' }]);
    const unfinished = await sweep({ result: { status: 'ran' } });
    expect(unfinished.out.act).toEqual([]);
    const failed = await sweep({ status: 'finished', result: { status: 'failed' } });
    expect(failed.out.act).toMatchObject([{ action: 'restart-red-team' }]);
  });
  it('the sweep enforces restart cooldown and escalates after exactly two spaced attempts', async () => {
    const first = await sweep({ start: 'replacement-process', ageMinutes: 300 });
    expect(first.out.act).toMatchObject([{ action: 'restart-red-team', key: expect.stringMatching(/restart-1$/) }]);
    const cooldown = await sweep({ dir: first.dir, start: 'replacement-process', ageMinutes: 300, now: NOW + 59 * 60_000 });
    expect(cooldown.out.items).toEqual([]);
    const second = await sweep({ dir: first.dir, start: 'replacement-process', ageMinutes: 300, now: NOW + 60 * 60_000 });
    expect(second.out.act).toMatchObject([{ action: 'restart-red-team', key: expect.stringMatching(/restart-2$/) }]);
    const exhausted = await sweep({ dir: first.dir, start: 'replacement-process', ageMinutes: 300, now: NOW + 120 * 60_000 });
    expect(exhausted.out.act).toEqual([]);
    expect(exhausted.out.items).toMatchObject([{ lane: 'operator', action: 'red-team-restart-exhausted', reason: expect.stringMatching(/2.*420/) }]);
  });
});


describe('headCap and shared head budgets', () => {
  const limits = { maxActionsPerSweep: 20, maxActionsPerHour: 20, maxActionsPerPrHead: 2 };
  const prHead = `${REPO}#11@${HEAD}`;
  const item = (action, headCap) => ({ lane: 'system', prHead, key: `${prHead}:${action}`, action,
    ...(headCap === undefined ? {} : { headCap }) });
  const record = (it, phase = 'would-do') => ({ ...it, phase, ts: new Date(NOW - 60_000).toISOString() });
  const capped = item('restart-red-team', 2);
  const ordinary = [item('ask-review-daemon'), item('rerun-check')];
  it.each(['would-do', 'intent'])('two different ordinary %s actions exhaust the shared head budget', phase => {
    const result = planStallActions([item('third-action'), capped], {
      now: NOW, limits, history: ordinary.map(it => record(it, phase)),
    });
    expect(result.act).toEqual([]);
    expect(result.held).toMatchObject([{ held: 'per-PR-head cap' }, { ...capped, held: 'per-PR-head cap' }]);
  });
  it('ordinary actions planned this pass hold a later headCap item', () => {
    const result = planStallActions([...ordinary, capped], { now: NOW, limits });
    expect(result.act).toEqual(ordinary);
    expect(result.held).toEqual([{ ...capped, held: 'per-PR-head cap' }]);
  });
  it.each(['history', 'current pass'])('headCap actions in %s do not spend the shared budget', source => {
    const result = planStallActions(source === 'history' ? ordinary : [capped, ...ordinary], {
      now: NOW, limits, history: source === 'history' ? [record(capped)] : [],
    });
    expect(result.act).toEqual(source === 'history' ? ordinary : [capped, ...ordinary]);
    expect(result.held).toEqual([]);
  });
  it('headCap actions still stop at their own bucket below the shared ceiling', () => {
    const result = planStallActions([{ ...capped, key: 'next' }], {
      now: NOW, limits, history: [record(capped), record({ ...capped, key: 'previous' })],
    });
    expect(result.act).toEqual([]);
    expect(result.held).toMatchObject([{ held: 'per-PR-head cap' }]);
  });
  it('legacy records missing headCap conservatively spend the shared budget', () => {
    const { headCap, ...legacy } = capped;
    const result = planStallActions([{ ...capped, key: 'next' }], {
      now: NOW, limits: { ...limits, maxActionsPerPrHead: 1 }, history: [record(legacy)],
    });
    expect(result.act).toEqual([]);
    expect(result.held).toMatchObject([{ held: 'per-PR-head cap' }]);
  });
  it.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid headCap %s holds for operator budget inspection', headCap => {
    const result = planStallActions([{ ...capped, headCap }], { now: NOW, limits });
    expect(result.act).toEqual([]);
    expect(result.held).toMatchObject([{ held: 'per-PR-head cap' }]);
  });
});

describe('whole-pass red-team evidence integrity', () => {
  it.each(['throws', 'unreadable', 'wrong-repo', 'wrong-pr', 'wrong-head'])('%s status blocks an otherwise actionable peer', async fault => {
    const valid = { repo: REPO, pr: 11, head: HEAD, status: 'finished', result: { status: 'ran' } };
    const readStatus = ({ pr }) => {
      if (pr === 12) return null;
      if (fault === 'throws') throw new Error('status read failed');
      if (fault === 'unreadable') return { unreadable: true };
      return { ...valid, ...(fault === 'wrong-repo' ? { repo: 'other/repo' }
        : fault === 'wrong-pr' ? { pr: 99 } : { head: 'b'.repeat(40) }) };
    };
    const { out } = await sweep({ readStatus, peer: true, incomplete: true });
    expect(out.items).toContainEqual(expect.objectContaining({ pr: 12, action: 'restart-red-team' }));
    expect(out.act).toEqual([]);
    expect(out.held).toEqual([]);
    expect(out.records.filter(r => r.phase === 'would-do')).toEqual([]);
    expect(out.records.find(r => r.phase === 'pass')).toMatchObject({ incomplete: true, readFailed: true });
  });
});

describe('owner probes preserve unknown liveness', () => {
  it.each(['ESRCH', 'EPERM', 'EIO', 'EINVAL', undefined])('PID probe error %s only proves death for ESRCH', code => {
    const kill = vi.fn(() => { throw Object.assign(new Error('probe failed'), { code }); });
    expect(pendingOwnerPidAlive(12345, kill)).toBe(code === 'ESRCH' ? false : code === 'EPERM' ? true : null);
    expect(kill).toHaveBeenCalledWith(12345, 0);
  });
  it('a successful PID probe proves the process exists', () => {
    expect(pendingOwnerPidAlive(12345, () => {})).toBe(true);
  });
  it.each(['isAlive', 'readPidStart'])('a throwing %s probe retains the active status and waits without a run timestamp', async method => {
    const { out } = await sweep({ ageMinutes: 1000, probePatch: {
      [method]: vi.fn(() => { throw new Error('unexpected probe failure'); }),
    } });
    expect(out.errors).toContainEqual(expect.stringMatching(/red-team owner.*unexpected probe failure/));
    expect(out.items).toEqual([]);
    expect(out.act).toEqual([]);
  });
  it('the default PID probe treats unexpected process.kill errors as unknown', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('unreadable'), { code: 'EIO' }); });
    try {
      const { out } = await sweep({ ageMinutes: 1000, probePatch: { isAlive: pendingOwnerPidAlive } });
      expect(kill).toHaveBeenCalledWith(12345, 0);
      expect(out.items).toEqual([]);
      expect(out.act).toEqual([]);
    } finally { kill.mockRestore(); }
  });
  it('a throwing probe still uses retained stale run evidence for bounded recovery', async () => {
    const { out } = await sweep({ ageMinutes: 1000, readStatus: () => ({
      repo: REPO, pr: 11, head: HEAD, status: 'running', host: 'local-host', pidNamespace: 'local-ns',
      pid: 12345, startedAt: new Date(NOW - 120 * 60_000).toISOString(),
    }), probePatch: { isAlive: () => { throw new Error('probe failed'); } } });
    expect(out.act).toMatchObject([{ action: 'restart-red-team' }]);
  });
});

describe('unknown active owners use run age', () => {
  it.each(['queued', 'running'])('an ancient pending head with a fresh %s run waits', status => {
    expect(planPendingRedTeam(evidence({ now: NOW, ageMinutes: 1000,
      status: { status, startedAt: new Date(NOW - 10 * 60_000).toISOString() },
    })).kind).toBe('wait');
  });
  it.each(['pidStart', 'startedAt', 'createdAt'])('%s supplies the inclusive run deadline independently of pending age', field => {
    const status = { status: 'running', [field]: new Date(NOW - 240 * 60_000).toISOString() };
    expect(planPendingRedTeam(evidence({ now: NOW - 1, status })).kind).toBe('wait');
    expect(planPendingRedTeam(evidence({ now: NOW, status })).kind).toBe('restart');
  });
  it('a fresh process birth time takes precedence over old fallback timestamps', () => {
    expect(planPendingRedTeam(evidence({ now: NOW, status: { status: 'running',
      pidStart: new Date(NOW - 60_000).toISOString(), startedAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(),
    } })).kind).toBe('wait');
  });
  it('unreadable process birth and start timestamps fall back to readable creation time', () => {
    expect(planPendingRedTeam(evidence({ now: NOW, status: { status: 'running',
      pidStart: 'unreadable', startedAt: null, createdAt: new Date(NOW - 240 * 60_000).toISOString(),
    } })).kind).toBe('restart');
  });
  it.each([{}, { pidStart: 'bad', startedAt: '', createdAt: false }, { pidStart: new Date(NOW + 1).toISOString() }])('unreadable or future run timing %j waits with operator fallback even when exhausted', timestamps => {
    const result = planPendingRedTeam(evidence({ now: NOW, ageMinutes: 1000, restarts: 3, minutesSinceLastRestart: 300,
      status: { status: 'running', ...timestamps },
    }));
    expect(result).toMatchObject({ kind: 'wait', reason: expect.stringMatching(/operator.*inspect/) });
  });
  it('the sweep passes its clock and honors a fresh remote run on an old pending head', async () => {
    const readStatus = () => ({ repo: REPO, pr: 11, head: HEAD, status: 'running', host: 'remote',
      startedAt: new Date(NOW - 119 * 60_000).toISOString() });
    const young = await sweep({ ageMinutes: 1000, readStatus });
    expect(young.out.act).toEqual([]);
    const stale = await sweep({ ageMinutes: 1000, now: NOW + 60_000, readStatus });
    expect(stale.out.act).toMatchObject([{ action: 'restart-red-team' }]);
  });
});
