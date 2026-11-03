// @vitest-environment node
import {describe, it, expect, afterEach} from 'vitest';
import {mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMarkerReaper, markerContent, runVerdict} from '../forge-slot-markers.mjs';

// R518: Forge publishes the ids of its active runs (activeRunIds). A dead owner's run ABSENT from that list is
// positively not executing, even while activeRuns > 0. A missing field keeps the count-only behaviour.
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true}); });
const NOW = Date.parse('2026-11-03T15:00:00-05:00');
const iso = ms => new Date(ms).toISOString().replace('Z', '+00:00');
const RUN_DEAD = 'r-' + 'd'.repeat(32), RUN_LIVE = 'r-' + 'e'.repeat(32), RUN_OTHER = 'r-' + 'f'.repeat(32);
const S1 = NOW + 120_000, S2 = S1 + 31_000;
const live = {runId: RUN_LIVE, startedAtET: iso(NOW - 60_000), code: null};
const dead = {runId: RUN_DEAD, startedAtET: iso(NOW - 600_000), code: null};
const tel = (sampledMs, extra, recent = [live]) => async () => ({sampledAtET: iso(sampledMs), activeRuns: 1, recent, ...extra});

function setup(run = RUN_DEAD, alive = false) {
  const root = mkdtempSync(join(tmpdir(), 'slot-per-run-')); roots.push(root);
  const file = join(root, 'slot-0.unconfirmed');
  writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run}));
  utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
  const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 && !alive ? 'dead' : 'alive')});
  return {file, reaper};
}

describe('R518 activeRunIds: dead run while Forge reports activeRuns > 0', () => {
  it('releases a dead run absent from activeRunIds (listed or not) after two own samples', async () => {
    for (const recent of [[live], [live, dead]]) {
      const {file, reaper} = setup();
      const t = ms => tel(ms, {activeRunIds: [RUN_LIVE]}, recent);
      expect(await reaper.step(t(S1))).toEqual([]);
      expect(existsSync(file)).toBe(true);
      expect(await reaper.step(t(S2))).toEqual(['slot-0.unconfirmed']);
      expect(existsSync(file)).toBe(false);
    }
  });
  it('keeps a live run present in activeRunIds', async () => {
    const {file, reaper} = setup(RUN_LIVE);
    const t = ms => tel(ms, {activeRunIds: [RUN_LIVE]});
    await reaper.step(t(S1)); await reaper.step(t(S2));
    expect(existsSync(file)).toBe(true);
    expect(runVerdict(await t(S1)(), RUN_LIVE)).toBe('inflight');
  });
  it('keeps the old behaviour when the field is missing', async () => {
    const {file, reaper} = setup();
    await reaper.step(tel(S1, {})); await reaper.step(tel(S2, {}));
    expect(existsSync(file)).toBe(true);
    expect(runVerdict(await tel(S1, {})(), RUN_DEAD)).toBe('unknown');
  });
  it('reports absent for a run missing from activeRunIds', async () => {
    expect(runVerdict(await tel(S1, {activeRunIds: [RUN_LIVE]})(), RUN_DEAD)).toBe('absent');
  });
  it.each([
    ['count mismatch', {activeRunIds: []}],
    ['not an array', {activeRunIds: 'x'}],
    ['bad id', {activeRunIds: ['nope']}],
    ['duplicate id', {activeRunIds: [RUN_LIVE, RUN_LIVE], activeRuns: 2}],
  ])('fails closed on a malformed field: %s', async (_l, extra) => {
    const {file, reaper} = setup();
    await reaper.step(tel(S1, extra)); await reaper.step(tel(S2, extra));
    expect(existsSync(file)).toBe(true);
    expect(runVerdict(await tel(S1, extra)(), RUN_DEAD)).toBe('unknown');
  });
  it('never releases when the owner is alive', async () => {
    const {file, reaper} = setup(RUN_DEAD, true);
    const t = ms => tel(ms, {activeRunIds: [RUN_LIVE]});
    await reaper.step(t(S1)); await reaper.step(t(S2));
    expect(existsSync(file)).toBe(true);
  });
  it('a later sample listing the run again restarts the confirmation', async () => {
    const {file, reaper} = setup();
    await reaper.step(tel(S1, {activeRunIds: [RUN_LIVE]}));
    await reaper.step(tel(S2 - 1000, {activeRunIds: [RUN_DEAD]}, [live, dead]));
    expect(await reaper.step(tel(S2, {activeRunIds: [RUN_LIVE]}))).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});
