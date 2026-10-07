/**
 * @file start-build.test.mjs — item 104: a chat-started build is a durable detached job.
 * Covers the refusals (nothing claimed or spawned), the happy path (claim, lane, detached spawn, job record,
 * routing left to the wrapper), claim release on a failed spawn, and the status read `/state` renders.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardStatus, pickFreeLane, planStartBuild, settleDeadJob, startBuild, main } from '../start-build.mjs';
import { describeJob, readJob, renderJob, writeJob, listJobs } from '../start-build-jobs.mjs';

const okCard = { found: true, status: 'open' };
const freeVerdict = { status: 'free' };
function fakeIo(over = {}) {
  const calls = { claim: [], release: [], spawn: [], jobs: [] };
  return { calls, io: {
    root: '/repo', now: () => new Date('2026-10-07T12:00:00Z'),
    readJob: () => null,
    readCard: () => okCard, readScope: () => ['we:scripts/a.mjs'],
    checkFree: () => freeVerdict, freeLane: () => 7,
    acquireClaim: (num, scope) => { calls.claim.push([num, scope]); return { ok: true }; },
    releaseClaim: (num) => { calls.release.push(num); },
    spawnDetached: (argv, opts) => { calls.spawn.push([argv, opts]); return { pid: 4242 }; },
    logPathFor: (slug) => `/logs/${slug}.log`,
    writeJob: (job) => { calls.jobs.push(job); },
    ...over,
  } };
}

describe('pure helpers', () => {
  it('reads card status and picks an unleased lane', () => {
    expect(cardStatus('---\nid: 1\nstatus: open\n---\nbody')).toBe('open');
    expect(cardStatus('no front matter')).toBeNull();
    expect(pickFreeLane({ lanes: [{ lane: 1, leased: true }, { lane: 2, leased: false }, { lane: 3, leased: false }] })).toBe(2);
    expect(pickFreeLane({ lanes: [{ lane: 1, leased: true }] })).toBeNull();
  });
  it('planStartBuild refuses in order', () => {
    const base = { num: '5', card: okCard, scope: ['we:x'], free: freeVerdict, lane: 1 };
    expect(planStartBuild(base).ok).toBe(true);
    expect(planStartBuild({ ...base, card: { found: false } }).refusal).toBe('card-not-found');
    expect(planStartBuild({ ...base, card: { found: true, status: 'active' } }).refusal).toBe('not-open');
    expect(planStartBuild({ ...base, scope: [] }).refusal).toBe('no-scope');
    expect(planStartBuild({ ...base, provider: 'nope' }).refusal).toBe('bad-provider');
    expect(planStartBuild({ ...base, free: { status: 'occupied', headline: 'PR #9' } }).refusal).toBe('scope-occupied');
    expect(planStartBuild({ ...base, free: { status: 'unknown' } }).refusal).toBe('scope-unknown');
    expect(planStartBuild({ ...base, lane: null }).refusal).toBe('no-free-lane');
    expect(planStartBuild({ ...base, claim: { ok: false, heldBy: 'x' } }).refusal).toBe('claim-held');
  });
});

describe('startBuild', () => {
  it('launches a detached deliver-item-run with the free lane, takes the claim and records a job; routing left to the wrapper', () => {
    const { io, calls } = fakeIo();
    const r = startBuild({ num: '5' }, io);
    expect(r.ok).toBe(true);
    const [argv, opts] = calls.spawn[0];
    expect(argv[0]).toMatch(/deliver-item-run\.mjs$/);
    expect(argv).toContain('--num=5');
    expect(argv).toContain('--lane=7');
    expect(argv).toContain('--session=conveyor-5');
    expect(argv.some((a) => a.startsWith('--provider='))).toBe(false); // codex default / claude fallback = wrapper's routing policy
    expect(opts.logPath).toBe('/logs/conveyor-5.log');
    expect(calls.claim).toEqual([['5', ['we:scripts/a.mjs']]]);
    expect(calls.jobs[0]).toMatchObject({ id: '5', handle: 'pid:4242', lane: 7, session: 'conveyor-5', startedAt: '2026-10-07T12:00:00.000Z' });
  });
  it('passes an explicit provider through', () => {
    const { io, calls } = fakeIo();
    startBuild({ num: '5', provider: 'codex' }, io);
    expect(calls.spawn[0][0]).toContain('--provider=codex');
  });
  it('refuses on an occupied scope (Rule 26) before claiming or spawning anything', () => {
    const { io, calls } = fakeIo({ checkFree: () => ({ status: 'occupied', headline: 'held by PR #4222' }) });
    const r = startBuild({ num: '5' }, io);
    expect(r).toMatchObject({ ok: false, refusal: 'scope-occupied' });
    expect(calls.claim).toEqual([]); expect(calls.spawn).toEqual([]);
  });
  it('treats a failed scope check as unknown, not free', () => {
    const { io, calls } = fakeIo({ checkFree: () => { throw new Error('gh down'); } });
    expect(startBuild({ num: '5' }, io).refusal).toBe('scope-unknown');
    expect(calls.spawn).toEqual([]);
  });
  it('refuses when the claim is held and spawns nothing', () => {
    const { io, calls } = fakeIo({ acquireClaim: () => ({ ok: false, heldBy: 'daemon' }) });
    expect(startBuild({ num: '5' }, io).refusal).toBe('claim-held');
    expect(calls.spawn).toEqual([]);
  });
  it('releases the claim when the spawn fails', () => {
    const { io, calls } = fakeIo({ spawnDetached: () => ({}) });
    expect(startBuild({ num: '5' }, io).refusal).toBe('spawn-failed');
    expect(calls.release).toEqual(['5']);
    expect(calls.jobs).toEqual([]);
  });
  it('refuses a second start while the first job is still running', () => {
    const running = { id: '5', handle: 'pid:99', lane: 3, startedAt: 't', logPath: '/l' };
    const { io, calls } = fakeIo({ readJob: () => running, isPidAlive: () => true });
    expect(startBuild({ num: '5' }, io).refusal).toBe('already-running');
    expect(calls.claim).toEqual([]);
  });
  it('dry-run checks everything but claims and spawns nothing', () => {
    const { io, calls } = fakeIo();
    expect(startBuild({ num: '5', dryRun: true }, io)).toMatchObject({ ok: true, dryRun: true });
    expect(calls.claim).toEqual([]); expect(calls.spawn).toEqual([]);
  });
});

describe('job records and status', () => {
  it('round-trips a record and derives running / finished / failed / ended from pid + log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-jobs-'));
    try {
      const log = join(dir, 'x.log');
      const job = { id: '5', handle: 'pid:77', lane: 2, provider: null, startedAt: 't', logPath: log };
      writeJob(job, dir);
      expect(readJob('5', dir)).toEqual(job);
      expect(listJobs(dir)).toHaveLength(1);
      expect(describeJob(job, { isPidAlive: () => true }).status).toBe('running');
      writeFileSync(log, 'deliver-item-run: #5 finished — PR #123\n');
      expect(describeJob(job, { isPidAlive: () => false })).toMatchObject({ status: 'finished' });
      writeFileSync(log, 'deliver-item-run: #5 FAILED: boom\n');
      expect(describeJob(job, { isPidAlive: () => false }).status).toBe('failed');
      writeFileSync(log, 'nothing useful\n');
      expect(describeJob(job, { isPidAlive: () => false }).status).toBe('ended');
      expect(renderJob(describeJob(job, { isPidAlive: () => true }))).toContain('durable build running');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('main status prints "no durable build jobs" for an empty store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-jobs-'));
    const prev = process.env.WE_START_BUILD_JOBS_DIR; process.env.WE_START_BUILD_JOBS_DIR = dir;
    try {
      const out = vi.fn();
      expect(main(['status'], { out })).toBe(0);
      expect(out).toHaveBeenCalledWith('no durable build jobs');
    } finally { if (prev === undefined) delete process.env.WE_START_BUILD_JOBS_DIR; else process.env.WE_START_BUILD_JOBS_DIR = prev; rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('safety found by the first live launch', () => {
  it('pickFreeLane skips dirty lanes and lanes the io cannot prove hold no unpushed commits', () => {
    const doc = { lanes: [{ lane: 4, leased: false, clean: true, path: 'a' }, { lane: 5, leased: false, clean: false, path: 'b' }, { lane: 6, leased: false, clean: true, path: 'c' }] };
    expect(pickFreeLane(doc, { isSafe: (l) => l.path === 'c' })).toBe(6);
    expect(pickFreeLane(doc, { isSafe: () => false })).toBeNull();
  });
  it('a dead job without a PR outcome releases the claim once; a finished or running one does not', () => {
    const release = vi.fn(); const write = vi.fn();
    const io = { releaseClaim: release, writeJob: write };
    expect(settleDeadJob({ id: '5', status: 'failed', detail: 'x', handle: 'pid:1' }, io)).toBe(true);
    expect(release).toHaveBeenCalledWith('5');
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ id: '5', claimReleased: true }));
    expect(write.mock.calls[0][0]).not.toHaveProperty('status');
    expect(settleDeadJob({ id: '5', status: 'failed', claimReleased: true }, io)).toBe(false);
    expect(settleDeadJob({ id: '5', status: 'finished' }, io)).toBe(false);
    expect(settleDeadJob({ id: '5', status: 'running' }, io)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('start settles a previous dead job first', () => {
    const { io, calls } = fakeIo({ readJob: () => ({ id: '5', handle: 'pid:99', lane: 3, startedAt: 't', logPath: '/none' }), isPidAlive: () => false });
    expect(startBuild({ num: '5' }, io).ok).toBe(true);
    expect(calls.release).toEqual(['5']);
  });
});
