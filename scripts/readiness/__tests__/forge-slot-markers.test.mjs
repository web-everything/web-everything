// @vitest-environment node
import {describe, it, expect, afterEach} from 'vitest';
import {readdirSync, readFileSync, mkdirSync, renameSync, mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {lockDirFor} from '../file-locks.mjs';
import {createMarkerReaper, markerContent, blockedSlots, heldTombstone, recordMarkerRun} from '../forge-slot-markers.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true}); });
const NOW = Date.parse('2026-11-01T12:00:00-05:00');
const iso = ms => new Date(ms).toISOString().replace('Z', '+00:00');
function setup(markers) {
  const root = mkdtempSync(join(tmpdir(), 'slot-markers-')); roots.push(root);
  for (const [index, {pid, ageMs = 600_000, run}] of Object.entries(markers)) {
    const file = join(root, `slot-${index}.unconfirmed`);
    writeFileSync(file, pid === undefined ? 'remote termination unconfirmed\n' : markerContent({owner: 'o', pid, nowMs: NOW - ageMs, host: 'forge', run}));
    const t = (NOW - ageMs) / 1000; utimesSync(file, t, t);
  }
  return root;
}
const RUN_A = 'r-' + 'a'.repeat(32), RUN_B = 'r-' + 'b'.repeat(32), RUN_C = 'r-' + 'c'.repeat(32);
const tel = (activeRuns, sampledMs = NOW + 120_000, recent = []) => async () => ({sampledAtET: iso(sampledMs), activeRuns, recent});
const done = (runId, code = 0) => ({runId, startedAtET: iso(NOW - 700_000), code});
const going = (runId, startedMs = NOW - 700_000) => ({runId, startedAtET: iso(startedMs), code: null});
const liveness = dead => pid => (dead.includes(pid) ? 'dead' : 'alive');
const names = root => ['0', '1', '2'].filter(i => existsSync(join(root, `slot-${i}.unconfirmed`)));

describe('stale remote slot markers (perf10)', () => {
  it('never removes a replacement marker created after the one it judged', async () => {
    const root = setup({0: {pid: 111}});
    const file = join(root, 'slot-0.unconfirmed');
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    const swapped = async () => { // the dispatcher replaces the marker while the reaper awaits telemetry
      rmSync(file); writeFileSync(file, markerContent({owner: 'new', pid: 111, nowMs: NOW, host: 'forge'}));
      const t = (NOW - 600_000) / 1000; utimesSync(file, t + 1, t + 1);
      return {sampledAtET: iso(NOW + 5_000), activeRuns: 0};
    };
    expect(await reaper.step(swapped)).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('does not let a replacement marker inherit its predecessor\'s death stamp', async () => {
    const root = setup({0: {pid: 111}});
    const file = join(root, 'slot-0.unconfirmed');
    let clockNow = NOW;
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => clockNow, liveness: liveness([111])});
    expect(await reaper.step(tel(0, NOW + 30_000))).toEqual([]);
    rmSync(file); writeFileSync(file, markerContent({owner: 'new', pid: 111, nowMs: NOW, host: 'forge'}));
    const t = (NOW - 600_000) / 1000; utimesSync(file, t + 7, t + 7);
    clockNow = NOW + 10_000;
    expect(await reaper.step(tel(0, NOW + 95_000))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('blocks a slot for a marker or a held tombstone, never for a sidecar', () => {
    const root = setup({0: {pid: 1}, 2: {pid: 1}});
    writeFileSync(join(root, 'slot-1.unconfirmed.held-0123456789abcdef'), 'x');
    writeFileSync(join(root, 'slot-3.unconfirmed.dead'), '{}');
    expect([...blockedSlots(root, 8)].sort()).toEqual([0, 1, 2]);
  });
  it('retakes the listing when a listed marker is renamed away mid-scan, never missing its tombstone', () => {
    const root = setup({0: {pid: 1}});
    let lists = 0;
    const readdir = dir => { const out = readdirSync(dir); if (lists++ === 0) renameSync(join(dir, 'slot-0.unconfirmed'), join(dir, 'slot-0.unconfirmed.held-0123456789abcdef')); return out; };
    expect([...blockedSlots(root, 8, readdir)]).toEqual([0]);
    expect(heldTombstone(root, 0)).toBe(true);
    expect(heldTombstone(root, 1)).toBe(false);
  });
  it('fails closed when the marker directory cannot be listed', () => {
    expect(() => blockedSlots('/x', 8, () => { throw Object.assign(new Error('boom'), {code: 'EIO'}); })).toThrow('boom');
    expect([...blockedSlots('/x', 8, () => { throw Object.assign(new Error('none'), {code: 'ENOENT'}); })]).toEqual([]);
  });
  it('reaps a dead owner whose run Forge cannot account for', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed']);
    expect(names(root)).toEqual([]);
  });
  it('never reaps a live owner', async () => {
    const root = setup({0: {pid: 222}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([])});
    expect(await reaper.step(tel(0))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('keeps a dead owner marker while Forge lists its own run without a result', async () => {
    const root = setup({0: {pid: 111, run: RUN_A}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(1, undefined, [going(RUN_A)]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('decides per run: a busy Forge does not keep a marker whose own run finished or is absent', async () => {
    const root = setup({0: {pid: 111, run: RUN_A}, 1: {pid: 112, run: RUN_B}, 2: {pid: 113, run: RUN_C}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112, 113])});
    // A finished (code), B absent (evicted), C still running; seven other runs keep Forge busy.
    const busy = [done(RUN_A, 1), going(RUN_C), ...Array.from({length: 7}, (_, i) => going('r-' + String(i).repeat(32)))];
    expect(await reaper.step(tel(8, undefined, busy))).toEqual(['slot-0.unconfirmed', 'slot-1.unconfirmed']);
    expect(names(root)).toEqual(['2']);
  });
  it('keeps a run-less marker only while a run that could be its own is unfinished', async () => {
    const root = setup({0: {pid: 111}, 1: {pid: 112}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112])});
    const early = going('r-' + 'd'.repeat(32), NOW - 5_000_000); // began long before either marker: not theirs
    const mine = going('r-' + 'e'.repeat(32), NOW - 590_000);
    expect(await reaper.step(tel(2, undefined, [early]))).toEqual(['slot-0.unconfirmed', 'slot-1.unconfirmed']);
    const again = setup({0: {pid: 111}});
    const r2 = createMarkerReaper({root: again, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await r2.step(tel(1, undefined, [mine]))).toEqual([]);
  });
  it('reaps a bare legacy marker once no live local process holds its slot lock', async () => {
    const root = setup({0: {}, 1: {}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW});
    expect(await reaper.step(async () => null)).toEqual(['slot-0.unconfirmed', 'slot-1.unconfirmed']);
  });
  it('keeps a bare legacy marker inside the grace window or while its slot lock owner is alive', async () => {
    const root = setup({0: {ageMs: 30_000}, 1: {}});
    const lock = lockDirFor(root, 'slot-1');
    mkdirSync(lock, {recursive: true});
    writeFileSync(join(lock, 'lock.json'), JSON.stringify({owner: 'x', pid: 4242, heartbeatAt: new Date(NOW).toISOString(), acquiredAt: new Date(NOW).toISOString(), path: 'slot-1'}));
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: () => 'alive'});
    expect(await reaper.step(async () => null)).toEqual([]);
    expect(names(root)).toEqual(['0', '1']);
  });
  it('treats unreadable evidence as unknown, never as permission to reap', async () => {
    const root = setup({0: {}, 1: {}});
    // slot-0: lock metadata present but corrupt; slot-1: marker itself unreadable (a directory).
    const lock = lockDirFor(root, 'slot-0');
    mkdirSync(lock, {recursive: true}); writeFileSync(join(lock, 'lock.json'), '{corrupt');
    rmSync(join(root, 'slot-1.unconfirmed')); mkdirSync(join(root, 'slot-1.unconfirmed'));
    writeFileSync(join(root, 'slot-2.unconfirmed'), '{"v":1,"host":"other","pid"'); // truncated structured marker
    writeFileSync(join(root, 'slot-3.unconfirmed'), JSON.stringify({v: 1, host: 'forge', owner: 'old', pid: 111, at: 'corrupt', run: 'invalid'}));
    const old = (NOW - 600_000) / 1000; utimesSync(join(root, 'slot-1.unconfirmed'), old, old); utimesSync(join(root, 'slot-2.unconfirmed'), old, old); utimesSync(join(root, 'slot-3.unconfirmed'), old, old);
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: () => 'dead'});
    expect(await reaper.step(async () => null)).toEqual([]);
    expect(existsSync(join(root, 'slot-0.unconfirmed'))).toBe(true);
    expect(existsSync(join(root, 'slot-1.unconfirmed'))).toBe(true);
    expect(existsSync(join(root, 'slot-2.unconfirmed'))).toBe(true);
    expect(existsSync(join(root, 'slot-3.unconfirmed'))).toBe(true);
  });
  it('reaps by the run id recorded in the sidecar and removes the sidecar', async () => {
    const root = setup({0: {pid: 111}});
    const file = join(root, 'slot-0.unconfirmed');
    recordMarkerRun(file, {owner: 'o', run: RUN_A});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(1, undefined, [going(RUN_A)]))).toEqual([]);
    expect(await reaper.step(tel(1, undefined, [done(RUN_A)]))).toEqual(['slot-0.unconfirmed']);
    expect(existsSync(file + '.run')).toBe(false);
  });
  it('records the Forge run id into its own marker only', () => {
    const root = setup({0: {pid: 111}});
    const file = join(root, 'slot-0.unconfirmed');
    expect(recordMarkerRun(file, {owner: 'someone-else', run: RUN_A})).toBe(false);
    expect(recordMarkerRun(file, {owner: 'o', run: 'nope'})).toBe(false);
    expect(recordMarkerRun(file, {owner: 'o', run: RUN_A})).toBe(true);
    expect(JSON.parse(readFileSync(file + '.run', 'utf8'))).toEqual({owner: 'o', run: RUN_A});
    expect(JSON.parse(readFileSync(file, 'utf8')).run).toBeUndefined();
  });
  it('retains a marker bound to another host or to no host', async () => {
    const root = setup({0: {pid: 111}});
    writeFileSync(join(root, 'slot-1.unconfirmed'), markerContent({owner: 'o', pid: 112, nowMs: NOW, host: 'other'}));
    writeFileSync(join(root, 'slot-2.unconfirmed'), JSON.stringify({v: 1, pid: 113}));
    for (const i of [1, 2]) { const t = (NOW - 600_000) / 1000; utimesSync(join(root, `slot-${i}.unconfirmed`), t, t); }
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112, 113])});
    await reaper.step(tel(0, NOW + 30_000));
    expect(await reaper.step(tel(0, NOW + 120_000))).toEqual(['slot-0.unconfirmed']);
    expect(names(root)).toEqual(['1', '2']);
  });
  it('keeps a young marker inside the grace window', async () => {
    const root = setup({0: {pid: 111, ageMs: 30_000}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(0))).toEqual([]);
  });
  it('waits for a Forge sample taken after the owner was first seen dead', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(0, NOW + 30_000))).toEqual([]);
    expect(await reaper.step(tel(0, NOW + 100_000))).toEqual(['slot-0.unconfirmed']);
  });
  it('refuses to reap without usable Forge telemetry', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(async () => null)).toEqual([]);
    expect(await reaper.step(async () => ({sampledAtET: 'nope', activeRuns: 0}))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
});
