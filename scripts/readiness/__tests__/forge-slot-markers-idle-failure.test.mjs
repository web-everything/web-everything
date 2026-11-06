// @vitest-environment node
import {describe, it, expect, vi, afterEach} from 'vitest';
import {mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// D-R451: a release rests only on the releasing process's own two live samples. A persisted idle stamp (even a stale one
// from another process) is never evidence, and failing writes cannot turn it into one.
const fault = {on: false};
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const eio = () => Object.assign(new Error('EIO'), {code: 'EIO'});
  const guarded = fn => (path, ...rest) => { if (fault.on && /\.(idle|dead)(-void)?$/.test(String(path))) throw eio(); return fn(path, ...rest); };
  return {...actual, unlinkSync: guarded(actual.unlinkSync), writeFileSync: guarded(actual.writeFileSync)};
});

const roots = [];
afterEach(() => { fault.on = false; for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true}); });
const NOW = Date.parse('2026-11-01T12:00:00-05:00');
const iso = ms => new Date(ms).toISOString().replace('Z', '+00:00');
const RUN_A = 'r-' + 'a'.repeat(32);
const going = {runId: RUN_A, startedAtET: iso(NOW - 700_000), code: null};
const tel = (activeRuns, sampledMs) => async () => ({sampledAtET: iso(sampledMs), activeRuns, recent: [going]});
const S1 = NOW + 120_000;

describe('release rests only on the releasing process own live samples', () => {
  it('does not release on another process stale idle stamp when every sidecar write fails', async () => {
    const mod = await import('../forge-slot-markers.mjs');
    const root = mkdtempSync(join(tmpdir(), 'slot-idle-fail-')); roots.push(root);
    const file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, mod.markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run: RUN_A}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const st = statSync(file);
    // a predecessor process persisted a first idle sample long ago
    writeFileSync(file + '.idle', JSON.stringify({key: `slot-0.unconfirmed:${st.ino}:${st.mtimeMs}`, sampledAt: S1 - 600_000}));
    fault.on = true; // from here every sidecar write and delete fails
    const reaper = mod.createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 ? 'dead' : 'alive')});
    expect(await reaper.step(tel(0, S1))).toEqual([]); // one live sample is never enough
    expect(existsSync(file)).toBe(true);
    expect(await reaper.step(tel(0, S1 + 29_999))).toEqual([]);
    expect(await reaper.step(tel(0, S1 + 30_000))).toEqual(['slot-0.unconfirmed']); // two own samples 30 s apart
  });
  it.each(['{}', '[]', 'not json'])('ignores a stale idle sidecar whatever it contains (%s)', async content => {
    const mod = await import('../forge-slot-markers.mjs');
    const root = mkdtempSync(join(tmpdir(), 'slot-idle-fail-')); roots.push(root);
    const file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, mod.markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run: RUN_A}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    writeFileSync(file + '.idle', content);
    writeFileSync(file + '.idle-void', content);
    const reaper = mod.createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 ? 'dead' : 'alive')});
    expect(await reaper.step(tel(0, S1))).toEqual([]);
  });
});
