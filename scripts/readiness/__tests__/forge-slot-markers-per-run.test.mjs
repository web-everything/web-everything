// @vitest-environment node
import {describe, it, expect, afterEach} from 'vitest';
import {mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// R512: Forge's health telemetry carries only the COUNT of active runs, never their ids, and Forge always has runs going.
// Disclosed inference (weaker than per-run ids): a dead owner's run that is unfinished AND older than the run ceiling
// cannot still be executing, so it is released after two own samples even while activeRuns > 0.
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true}); });
const NOW = Date.parse('2026-11-03T15:00:00-05:00');
const HOUR = 3_600_000;
const iso = ms => new Date(ms).toISOString().replace('Z', '+00:00');
const RUN_DEAD = 'r-' + 'd'.repeat(32), RUN_OTHER = 'r-' + 'e'.repeat(32);
const S1 = NOW + 120_000, S2 = S1 + 30_000;
const other = {runId: RUN_OTHER, startedAtET: iso(NOW - 60_000), code: null};
const tel = (sampledMs, recent) => async () => ({sampledAtET: iso(sampledMs), activeRuns: 3, recent});

async function setup(ageMs, alive = false) {
  const mod = await import('../forge-slot-markers.mjs');
  const root = mkdtempSync(join(tmpdir(), 'slot-per-run-')); roots.push(root);
  const file = join(root, 'slot-0.unconfirmed');
  writeFileSync(file, mod.markerContent({owner: 'o', pid: 111, nowMs: NOW - ageMs, host: 'forge', run: RUN_DEAD}));
  utimesSync(file, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
  const reaper = mod.createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 && !alive ? 'dead' : 'alive')});
  return {file, reaper};
}

describe('dead run while Forge reports activeRuns > 0', () => {
  it('releases a dead run missing from recent once older than the ceiling, after two samples', async () => {
    const {file, reaper} = await setup(3 * HOUR);
    expect(await reaper.step(tel(S1, [other]))).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(await reaper.step(tel(S2, [other]))).toEqual(['slot-0.unconfirmed']);
    expect(existsSync(file)).toBe(false);
  });
  it('releases a dead run listed with code:null once started longer ago than the ceiling', async () => {
    const {file, reaper} = await setup(3 * HOUR);
    const stale = {runId: RUN_DEAD, startedAtET: iso(NOW - 3 * HOUR), code: null};
    expect(await reaper.step(tel(S1, [other, stale]))).toEqual([]);
    expect(await reaper.step(tel(S2, [other, stale]))).toEqual(['slot-0.unconfirmed']);
    expect(existsSync(file)).toBe(false);
  });
  it('keeps a live owner marker whatever the telemetry says', async () => {
    const {file, reaper} = await setup(3 * HOUR, true);
    await reaper.step(tel(S1, [other])); await reaper.step(tel(S2, [other]));
    expect(existsSync(file)).toBe(true);
  });
  it('keeps a dead run younger than the ceiling that is missing from recent', async () => {
    const {file, reaper} = await setup(30 * 60_000);
    await reaper.step(tel(S1, [other])); await reaper.step(tel(S2, [other]));
    expect(existsSync(file)).toBe(true);
  });
  it('keeps a dead run younger than the ceiling that is listed with code:null', async () => {
    const {file, reaper} = await setup(30 * 60_000);
    const young = {runId: RUN_DEAD, startedAtET: iso(NOW - 30 * 60_000), code: null};
    await reaper.step(tel(S1, [other, young])); await reaper.step(tel(S2, [other, young]));
    expect(existsSync(file)).toBe(true);
  });
  it('a sample that is too early restarts the confirmation window', async () => {
    const {file, reaper} = await setup(3 * HOUR);
    await reaper.step(tel(S1, [other]));
    await reaper.step(tel(NOW + 10_000, [other])); // before the death margin: resets
    expect(await reaper.step(tel(S2, [other]))).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});
