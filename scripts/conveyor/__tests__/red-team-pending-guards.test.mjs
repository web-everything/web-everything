/** Guard regressions supplement the committed phase-1 contract without changing its fixtures. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPendingRedTeam } from '../../lib/red-team-pending-watchdog.mjs';
import { runStallSweep, STALL_SWEEP_DEFAULTS } from '../pr-stall-sweep.mjs';

const evidence = patch => ({ ageMinutes: 300, status: null, ownerAlive: null,
  restarts: 0, minutesSinceLastRestart: null, thresholdMinutes: 90, maxRestarts: 3,
  staleRunMinutes: 240, ...patch });

describe('explicit watchdog guard boundaries', () => {
  it('live-owner suppression wins beyond a nondefault stale deadline', () => {
    expect(planPendingRedTeam(evidence({ status: { status: 'running' }, ownerAlive: true })).kind).toBe('wait');
  });
  it('unknown-owner grace honors the configured stale deadline inclusively', () => {
    const status = { status: 'queued' };
    expect(planPendingRedTeam(evidence({ status, ageMinutes: 239.99 })).kind).toBe('wait');
    expect(planPendingRedTeam(evidence({ status, ageMinutes: 240 })).kind).toBe('restart');
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
  host = 'local-host', namespace = 'local-ns', dir, now = NOW } = {}) {
  if (!dir) { dir = mkdtempSync(join(tmpdir(), 'red-team-guards-')); roots.push(dir); }
  const at = new Date(NOW - ageMinutes * 60_000).toISOString();
  const pr = { repo: REPO, number: 11, headRefOid: HEAD, title: 'pending head', body: '', isDraft: false,
    updatedAt: at, createdAt: at, headCommittedAt: at, labels: ['red-team:pending'], labelEvents: [],
    comments: [], statusCheckRollup: [] };
  const probe = { host: 'local-host', namespace: 'local-ns', isAlive: vi.fn(() => true), readPidStart: vi.fn(() => start) };
  const gh = vi.fn(() => { throw new Error('unexpected GitHub call'); });
  const out = await runStallSweep({ now, env: {}, dir, settings: { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow' }, sources: {}, errors: [] },
    read: () => ({ now, prs: [pr], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }), gh, probe,
    readRedTeamStatus: () => ({ repo: REPO, pr: 11, head: HEAD, status, result,
      host, pidNamespace: namespace, pid: 12345, pidStart: 'original-owner' }), log: () => {} });
  expect(gh).not.toHaveBeenCalled();
  expect(out.incomplete).toBe(false);
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
