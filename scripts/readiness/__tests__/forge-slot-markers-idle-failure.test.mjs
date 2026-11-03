// @vitest-environment node
import {describe, it, expect, vi, afterEach} from 'vitest';
import {mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// D-R451: when deleting AND overwriting the idle sidecar both fail, no process may release the slot.
const fault = {on: false, void: false};
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const eio = () => Object.assign(new Error('EIO'), {code: 'EIO'});
  const guarded = fn => (path, ...rest) => { if (fault.on && (fault.void ? /\.idle(-void)?$/ : /\.idle$/).test(String(path))) throw eio(); return fn(path, ...rest); };
  return {...actual, unlinkSync: guarded(actual.unlinkSync), writeFileSync: guarded(actual.writeFileSync)};
});

const roots = [];
afterEach(() => { fault.on = false; fault.void = false; for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true}); });
const NOW = Date.parse('2026-11-01T12:00:00-05:00');
const iso = ms => new Date(ms).toISOString().replace('Z', '+00:00');
const RUN_A = 'r-' + 'a'.repeat(32);
const going = {runId: RUN_A, startedAtET: iso(NOW - 700_000), code: null};
const tel = (activeRuns, sampledMs) => async () => ({sampledAtET: iso(sampledMs), activeRuns, recent: [going]});
const S1 = NOW + 120_000;

describe('idle sample reset failure fails closed across processes', () => {
  it('keeps the slot in a second process after delete and overwrite of the idle sample both failed', async () => {
    const first = await import('../forge-slot-markers.mjs');
    const root = mkdtempSync(join(tmpdir(), 'slot-idle-fail-')); roots.push(root);
    const file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, first.markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run: RUN_A}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const opts = {root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 ? 'dead' : 'alive')};
    const lines = [];
    const one = first.createMarkerReaper({...opts, log: m => lines.push(m)});
    expect(await one.step(tel(0, S1))).toEqual([]); // first idle sample persisted
    fault.on = true;
    expect(await one.step(async () => null)).toEqual([]); // unknown probe: the reset cannot be written
    fault.on = false;
    expect(lines.join('')).toMatch(/idle sample reset failed/);
    vi.resetModules(); // a second process: no shared module state
    const second = (await import('../forge-slot-markers.mjs')).createMarkerReaper(opts);
    expect(await second.step(tel(0, S1 + 31_000))).toEqual([]); // stale first sample must not count
    expect(existsSync(file)).toBe(true);
    expect(await second.step(tel(0, S1 + 50_000))).toEqual([]); // the fresh window began at +31 s
    expect(existsSync(file)).toBe(true);
    expect(await second.step(tel(0, S1 + 62_000))).toEqual(['slot-0.unconfirmed']); // a full fresh window releases
  });

  it('quarantines the marker under a held name when the void marker cannot be written either', async () => {
    const mod = await import('../forge-slot-markers.mjs');
    const root = mkdtempSync(join(tmpdir(), 'slot-idle-fail-')); roots.push(root);
    const file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, mod.markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run: RUN_A}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const opts = {root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 ? 'dead' : 'alive')};
    const one = mod.createMarkerReaper(opts);
    await one.step(tel(0, S1));
    fault.on = true; fault.void = true;
    await one.step(async () => null);
    fault.on = false; fault.void = false;
    vi.resetModules();
    const second = (await import('../forge-slot-markers.mjs')).createMarkerReaper(opts);
    expect(await second.step(tel(0, S1 + 31_000))).toEqual([]);
    expect(await second.step(tel(0, S1 + 90_000))).toEqual([]);
    expect([...(await import('../forge-slot-markers.mjs')).blockedSlots(root, 1)]).toEqual([0]);
  });
  it('treats an unreadable or malformed void marker as void, not as absent', async () => {
    const mod = await import('../forge-slot-markers.mjs');
    const root = mkdtempSync(join(tmpdir(), 'slot-idle-fail-')); roots.push(root);
    const file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, mod.markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run: RUN_A}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const reaper = mod.createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 ? 'dead' : 'alive')});
    await reaper.step(tel(0, S1));
    writeFileSync(file + '.idle-void', 'not json');
    expect(await reaper.step(tel(0, S1 + 31_000))).toEqual([]);
  });
});
