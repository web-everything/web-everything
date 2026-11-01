// @vitest-environment node
import {describe, it, expect, afterEach} from 'vitest';
import {mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMarkerReaper, markerContent} from '../forge-slot-markers.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true}); });
const NOW = Date.parse('2026-11-01T12:00:00-05:00');
const iso = ms => new Date(ms).toISOString().replace('Z', '+00:00');
function setup(markers) {
  const root = mkdtempSync(join(tmpdir(), 'slot-markers-')); roots.push(root);
  for (const [index, {pid, ageMs = 600_000}] of Object.entries(markers)) {
    const file = join(root, `slot-${index}.unconfirmed`);
    writeFileSync(file, pid === undefined ? 'remote termination unconfirmed\n' : markerContent({owner: 'o', pid, nowMs: NOW}));
    const t = (NOW - ageMs) / 1000; utimesSync(file, t, t);
  }
  return root;
}
const tel = (activeRuns, sampledMs = NOW + 5_000) => async () => ({sampledAtET: iso(sampledMs), activeRuns});
const liveness = dead => pid => (dead.includes(pid) ? 'dead' : 'alive');
const names = root => ['0', '1', '2'].filter(i => existsSync(join(root, `slot-${i}.unconfirmed`)));

describe('stale remote slot markers (perf10)', () => {
  it('reaps a dead owner whose run Forge cannot account for', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed']);
    expect(names(root)).toEqual([]);
  });
  it('never reaps a live owner', async () => {
    const root = setup({0: {pid: 222}});
    const reaper = createMarkerReaper({root, clock: () => NOW, liveness: liveness([])});
    expect(await reaper.step(tel(0))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('keeps a dead owner marker while Forge reports it may still be running', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(1))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('keeps every dead marker while Forge reports any active run (telemetry cannot say whose it is)', async () => {
    const root = setup({0: {pid: 111, ageMs: 900_000}, 1: {pid: 112, ageMs: 600_000}, 2: {pid: 113, ageMs: 300_000}});
    const reaper = createMarkerReaper({root, clock: () => NOW, liveness: liveness([111, 112, 113])});
    expect(await reaper.step(tel(2))).toEqual([]);
    expect(await reaper.step(tel(1))).toEqual([]);
    expect(names(root)).toEqual(['0', '1', '2']);
    expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed', 'slot-1.unconfirmed', 'slot-2.unconfirmed']);
  });
  it('keeps a young marker inside the grace window', async () => {
    const root = setup({0: {pid: 111, ageMs: 30_000}});
    const reaper = createMarkerReaper({root, clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(0))).toEqual([]);
  });
  it('waits for a Forge sample taken after the owner was first seen dead', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(0, NOW - 4_000))).toEqual([]);
    expect(await reaper.step(tel(0, NOW + 1_000))).toEqual(['slot-0.unconfirmed']);
  });
  it('refuses to reap without usable Forge telemetry', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(async () => null)).toEqual([]);
    expect(await reaper.step(async () => ({sampledAtET: 'nope', activeRuns: 0}))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('treats an owner it cannot identify (legacy marker, no slot lock) as not provably dead', async () => {
    const root = setup({0: {}});
    const reaper = createMarkerReaper({root, clock: () => NOW});
    expect(await reaper.step(tel(0))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
});
