/**
 * @file lane-lease-liveness.test.mjs — RS-7179-2: a ttl-stale lease whose lane still has a live process with its
 *   cwd inside it is KEPT by reapPlan + applyReclaimSafety and by the reclaim guard. Negative cases first.
 */
import { describe, it, expect } from 'vitest';
import { parseLsofCwd, liveCwdPids, applyReclaimSafety } from '../lane-lease-liveness.mjs';
import { liveCwdRefusal } from '../lane-lease-guard.mjs';
import { reapPlan } from '../../conveyor/lease-reaper.mjs';

const DIR = '/pool/lane-3';
const nowMs = Date.parse('2026-11-25T12:00:00.000Z');
const stale = { session: 's', acquiredAt: '2026-11-24T00:00:00.000Z', ttlMinutes: 240 };
const cand = (dir = DIR) => ({ pool: 'p', lane: 3, dir, lease: stale });
const rows = (...r) => () => r.map(([pid, cwd]) => ({ pid, cwd }));
const alive = () => true;

describe('parseLsofCwd', () => {
  it('reads pid/cwd pairs and ignores junk', () => {
    expect(parseLsofCwd('p12\nfcwd\nn/pool/lane-3/x\np13\nn/other\ngarbage\n')).toEqual([{ pid: 12, cwd: '/pool/lane-3/x' }, { pid: 13, cwd: '/other' }]);
    expect(parseLsofCwd('')).toEqual([]);
    expect(parseLsofCwd(null)).toEqual([]);
  });
});

describe('liveCwdPids', () => {
  it('does not match a sibling lane that shares a name prefix', () => {
    expect(liveCwdPids(DIR, { listCwds: rows([5, '/pool/lane-30'], [6, '/pool/lane-3x/y']) })).toEqual([]);
  });
  it('matches the lane itself and anything under it, never our own process', () => {
    expect(liveCwdPids(DIR, { selfPids: [9], isAlive: alive, listCwds: rows([5, DIR], [6, `${DIR}/a/b`], [9, DIR]) })).toEqual([5, 6]);
  });
  it('resolves aliases so /var and /private/var spellings match, and counts a parent shell', () => {
    const realpath = (p) => p.replace(/^\/var\//, '/private/var/');
    expect(liveCwdPids('/var/pool/lane-3', { realpath, isAlive: alive, selfPids: [1], listCwds: rows([process.ppid, '/private/var/pool/lane-3']) })).toEqual([process.ppid]);
  });
  it('is null (unknown) when the probe throws', () => {
    expect(liveCwdPids(DIR, { listCwds: () => { throw new Error('no lsof'); } })).toBeNull();
  });
  it('a pid that is not alive is ignored', () => {
    expect(liveCwdPids(DIR, { listCwds: rows([5, DIR]), isAlive: () => false })).toEqual([]);
  });
});

describe('reapPlan + applyReclaimSafety', () => {
  it('baseline: the ttl-stale lease is in reap before the safety pass', () => {
    expect(reapPlan([cand()], { nowMs }).reap.map((c) => c.reason)).toEqual(['ttl-stale']);
  });
  it('keeps a ttl-stale lease with a live cwd pid', () => {
    const plan = applyReclaimSafety(reapPlan([cand()], { nowMs }), { isAlive: alive, listCwds: rows([5, DIR]) });
    expect(plan.reap).toEqual([]);
    expect(plan.keep[0]).toMatchObject({ reason: 'live-cwd:5', wouldHaveBeen: 'ttl-stale' });
  });
  it('still reaps when nothing lives there, and when the probe is unknown', () => {
    expect(applyReclaimSafety(reapPlan([cand()], { nowMs }), { listCwds: rows([5, '/elsewhere']) }).reap).toHaveLength(1);
    expect(applyReclaimSafety(reapPlan([cand()], { nowMs }), { listCwds: () => { throw new Error('x'); } }).reap).toHaveLength(1);
  });
  it('does not touch what was already kept', () => {
    const plan = applyReclaimSafety({ reap: [], keep: [{ ...cand(), reason: 'reserved' }] }, { listCwds: rows([5, DIR]) });
    expect(plan.keep[0].reason).toBe('reserved');
  });
});

describe('liveCwdRefusal', () => {
  it('refuses with the pids and allows when the lane is empty', () => {
    expect(liveCwdRefusal(DIR, 'take-over', { isAlive: alive, listCwds: rows([5, DIR]) })).toMatchObject({ pids: [5] });
    expect(liveCwdRefusal(DIR, 'take-over', { listCwds: rows() })).toBeNull();
    expect(liveCwdRefusal(DIR, 'take-over', { listCwds: () => { throw new Error('x'); } })).toBeNull();
  });
});
