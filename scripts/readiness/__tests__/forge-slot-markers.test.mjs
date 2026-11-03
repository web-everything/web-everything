// @vitest-environment node
import {describe, it, expect, afterEach} from 'vitest';
import {readdirSync, readFileSync, mkdirSync, renameSync, mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync, statSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {lockDirFor} from '../file-locks.mjs';
import {parseTelemetry, easternTimestamp} from '../forge-exec-run.mjs';
import {createMarkerReaper, markerContent, blockedSlots, heldTombstone, recordMarkerRun, runVerdict} from '../forge-slot-markers.mjs';

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
  it.each([97, 254])('does not classify supervisor failure code %s as confirmed cleanup while Forge is active', async code => {
    const telemetry = await tel(1, undefined, [done(RUN_A, code)])();
    expect(runVerdict(telemetry, RUN_A)).toBe('unknown');
    expect(runVerdict({...telemetry, activeRuns: 0}, RUN_A)).toBe('finished');
  });
  it.each([97, 254].flatMap(code => ['inline', 'sidecar', 'run-less'].map(binding => ({code, binding}))))(
    'keeps quarantine after supervisor failure until Forge confirms cleanup: %j', async ({code, binding}) => {
      const root = setup({0: {pid: 111, run: binding === 'inline' ? RUN_A : undefined}});
      if (binding === 'sidecar') recordMarkerRun(join(root, 'slot-0.unconfirmed'), {owner: 'o', run: RUN_A});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      const recent = [{...done(RUN_A, code), startedAtET: iso(NOW - 590_000)}];
      expect(await reaper.step(tel(1, undefined, recent))).toEqual([]);
      expect([...blockedSlots(root, 1)]).toEqual([0]);
      expect(await reaper.step(tel(0, NOW + 30_000, recent))).toEqual([]);
      expect(await reaper.step(tel(0, undefined, recent))).toEqual(['slot-0.unconfirmed']);
    });
  it.each(['missing', 'dead', 'alive'])('retains a legacy marker with a %s lock holder while remote work may survive', async holder => {
    const root = setup({0: {}});
    if (holder !== 'missing') {
      const lock = lockDirFor(root, 'slot-0');
      mkdirSync(lock, {recursive: true});
      writeFileSync(join(lock, 'lock.json'), JSON.stringify({owner: 'old', pid: 111, heartbeatAt: iso(NOW), acquiredAt: iso(NOW), path: 'slot-0'}));
    }
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: () => holder});
    expect(await reaper.step(tel(1, undefined, [going(RUN_A)]))).toEqual([]);
    expect([...blockedSlots(root, 1)]).toEqual([0]);
    // Legacy text has no host binding: even an idle configured host cannot speak for its job.
    expect(await reaper.step(tel(0))).toEqual([]);
    expect([...blockedSlots(root, 1)]).toEqual([0]);
  });
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
  describe('R475 unconfirmed-slot reconciler: a dead owner whose run Forge never started', () => {
    it('reaps the slot when Forge reports ZERO active runs and lists the run with no result (prepared, never run)', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}});
      const lines = [];
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111]), log: m => lines.push(m)});
      expect(await reaper.step(tel(0, undefined, [going(RUN_A)]))).toEqual([]); // first idle sample: not yet
      expect(names(root)).toEqual(['0']);
      expect(await reaper.step(tel(0, NOW + 120_000 + 31_000, [going(RUN_A)]))).toEqual(['slot-0.unconfirmed']);
      expect(names(root)).toEqual([]);
      expect(lines.join('')).toContain('slot-0');
      expect(lines.join('')).toContain(RUN_A);
      expect(lines.join('')).toMatch(/activeRuns=0/);
    });
    it('keeps the slot while Forge reports any active run (the listed run may still be executing)', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await reaper.step(tel(1, undefined, [going(RUN_A)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
    });
    it('keeps an idle-looking slot whose run started less than the sample margin before the sample', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await reaper.step(tel(0, NOW + 120_000, [going(RUN_A, NOW + 120_000 - 30_000)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
    });
    it('keeps the slot when a later sample shows an active run again (the first idle sample was a missed rename)', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      await reaper.step(tel(0, undefined, [going(RUN_A)]));
      expect(await reaper.step(tel(1, NOW + 160_000, [going(RUN_A)]))).toEqual([]);
      expect(await reaper.step(tel(0, NOW + 200_000, [going(RUN_A)]))).toEqual([]); // idle clock restarted
      expect(names(root)).toEqual(['0']);
    });
    it('keeps the slot when the probe fails or is unknown (fail closed)', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await reaper.step(async () => { throw new Error('ssh down'); })).toEqual([]);
      expect(await reaper.step(async () => null)).toEqual([]);
      expect(await reaper.step(async () => ({sampledAtET: iso(NOW + 120_000), activeRuns: 0, recent: 'garbage'}))).toEqual([]);
      expect(names(root)).toEqual(['0']);
    });
    it('keeps the slot while the owner is alive even with zero active runs', async () => {
      const root = setup({0: {pid: 222, run: RUN_A}});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([])});
      expect(await reaper.step(tel(0, undefined, [going(RUN_A)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
    });
    it('reaps every such slot in one pass', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}, 1: {pid: 112, run: RUN_B}});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112])});
      await reaper.step(tel(0, undefined, [going(RUN_A), going(RUN_B)]));
      expect((await reaper.step(tel(0, NOW + 160_000, [going(RUN_A), going(RUN_B)]))).sort()).toEqual(['slot-0.unconfirmed', 'slot-1.unconfirmed']);
    });
  });
  describe('R475 release predicates (boundary, one guard at a time)', () => {
    const S1 = NOW + 120_000;
    const mk = () => { const root = setup({0: {pid: 111, run: RUN_A}}); return {root, reaper: createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])})}; };
    const seedIdle = (root, sampledAt) => {
      const file = join(root, 'slot-0.unconfirmed'), st = statSync(file);
      writeFileSync(file + '.idle', JSON.stringify({key: `slot-0.unconfirmed:${st.ino}:${st.mtimeMs}`, sampledAt}));
    };
    it('retains an idle slot before the confirmation interval expires and releases at it', async () => {
      const {root, reaper} = mk();
      expect(await reaper.step(tel(0, S1, [going(RUN_A)]))).toEqual([]);
      expect(await reaper.step(tel(0, S1 + 29_999, [going(RUN_A)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
      expect(await reaper.step(tel(0, S1 + 30_000, [going(RUN_A)]))).toEqual(['slot-0.unconfirmed']);
    });
    it('retains a young run across two idle samples (run-age guard alone) and releases at the margin', async () => {
      const young = mk();
      seedIdle(young.root, S1 - 60_000);
      expect(await young.reaper.step(tel(0, S1, [going(RUN_A, S1 - 89_999)]))).toEqual([]);
      expect(names(young.root)).toEqual(['0']);
      const old = mk();
      seedIdle(old.root, S1 - 60_000);
      expect(await old.reaper.step(tel(0, S1, [going(RUN_A, S1 - 90_000)]))).toEqual(['slot-0.unconfirmed']);
    });
    it('retains the slot until the death-sample margin has passed, releasing at it', async () => {
      const {root, reaper} = mk();
      seedIdle(root, NOW - 60_000);
      const recent = [going(RUN_A, NOW - 700_000)];
      // first-seen-dead stamp is taken at clock() = NOW; a sample 1 ms short of the margin cannot speak for it
      expect(await reaper.step(tel(0, NOW + 89_999, recent))).toEqual([]);
      expect(await reaper.step(tel(0, NOW + 90_000, recent))).toEqual(['slot-0.unconfirmed']);
    });
    it('resumes idle confirmation after recreating the reaper', async () => {
      const {root, reaper} = mk();
      expect(await reaper.step(tel(0, S1, [going(RUN_A)]))).toEqual([]);
      const second = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await second.step(tel(0, S1 + 29_999, [going(RUN_A)]))).toEqual([]);
      expect(await second.step(tel(0, S1 + 30_000, [going(RUN_A)]))).toEqual(['slot-0.unconfirmed']);
    });
    it('rejects a predecessor marker idle timestamp after recreating the reaper', async () => {
      const {root, reaper} = mk();
      await reaper.step(tel(0, S1, [going(RUN_A)]));
      const file = join(root, 'slot-0.unconfirmed');
      rmSync(file); rmSync(file + '.dead', {force: true});
      writeFileSync(file, markerContent({owner: 'o2', pid: 111, nowMs: NOW - 500_000, host: 'forge', run: RUN_A}));
      const t = (NOW - 500_000) / 1000; utimesSync(file, t, t);
      const second = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await second.step(tel(0, S1 + 31_000, [going(RUN_A)]))).toEqual([]); // successor starts its own window
      expect(names(root)).toEqual(['0']);
    });
    it.each([
      ['a failed probe', async () => { throw new Error('ssh down'); }],
      ['a null probe', async () => null],
      ['malformed telemetry', async () => ({sampledAtET: iso(S1 + 10_000), activeRuns: 0, recent: 'garbage'})],
    ])('restarts idle confirmation after %s between idle samples', async (_label, bad) => {
      const {root, reaper} = mk();
      expect(await reaper.step(tel(0, S1, [going(RUN_A)]))).toEqual([]);
      expect(await reaper.step(bad)).toEqual([]);
      expect(await reaper.step(tel(0, S1 + 31_000, [going(RUN_A)]))).toEqual([]); // new window began here
      expect(names(root)).toEqual(['0']);
      expect(await reaper.step(tel(0, S1 + 61_000, [going(RUN_A)]))).toEqual(['slot-0.unconfirmed']);
    });
    it('restarts idle confirmation even when deleting the stale idle sample fails', async () => {
      const {root, reaper} = mk();
      await reaper.step(tel(0, S1, [going(RUN_A)]));
      chmodSync(root, 0o500); // unlink of the sidecar now fails with EACCES
      try { await reaper.step(async () => null); } finally { chmodSync(root, 0o700); }
      const recreated = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await recreated.step(tel(0, S1 + 31_000, [going(RUN_A)]))).toEqual([]); // neutralised on disk, not just in memory
      expect(await reaper.step(tel(0, S1 + 31_000, [going(RUN_A)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
    });
    it('rejects the stale idle sample in a recreated reaper when both delete and overwrite of it failed', async () => {
      const {root, reaper} = mk();
      await reaper.step(tel(0, S1, [going(RUN_A)]));
      const idle = join(root, 'slot-0.unconfirmed.idle');
      chmodSync(idle, 0o400); chmodSync(root, 0o500); // unlink and overwrite both fail
      try { await reaper.step(async () => null); } finally { chmodSync(root, 0o700); chmodSync(idle, 0o600); }
      const recreated = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await recreated.step(tel(0, S1 + 31_000, [going(RUN_A)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
    });
    it('logs a complete structured record for every released slot', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}, 1: {pid: 112, run: RUN_B}});
      const lines = [];
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112]), log: m => lines.push(m)});
      const recent = [going(RUN_A), going(RUN_B)];
      await reaper.step(tel(0, S1, recent));
      await reaper.step(tel(0, S1 + 31_000, recent));
      const records = lines.map(l => /released unconfirmed remote slot (\{.*\}) activeRuns=/.exec(l)).filter(Boolean).map(m => JSON.parse(m[1]));
      expect(records.sort((a, b) => a.slot - b.slot)).toEqual([
        {slot: 0, runId: RUN_A, verdict: 'idle', activeRuns: 0, sampledAtET: iso(S1 + 31_000)},
        {slot: 1, runId: RUN_B, verdict: 'idle', activeRuns: 0, sampledAtET: iso(S1 + 31_000)},
      ]);
    });
  });
  describe('R475 coroner signal', () => {
    it('signals once when >= 2 unconfirmed slots are older than the age bound, then throttles', async () => {
      const root = setup({0: {pid: 222, run: RUN_A}, 1: {pid: 223, run: RUN_B}});
      const events = [];
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([]), signal: e => events.push(e)});
      await reaper.step(tel(1));
      await reaper.step(tel(1));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({kind: 'stuck-slots', detail: {slots: ['slot-0.unconfirmed', 'slot-1.unconfirmed']}});
    });
    it('also signals stuck-slots when the old unconfirmed slots have dead owners', async () => {
      const root = setup({0: {pid: 222, run: RUN_A}, 1: {pid: 223, run: RUN_B}});
      const events = [];
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222, 223]), signal: e => events.push(e)});
      await reaper.step(tel(2, undefined, [going(RUN_A), going(RUN_B)]));
      expect(events.map(e => e.kind)).toEqual(['stuck-slots']);
    });
    it('throttles each signal kind until its configured interval expires', async () => {
      const root = setup({0: {pid: 222, run: RUN_A}, 1: {pid: 223, run: RUN_B}});
      const events = [];
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222, 223]), signalEveryMs: 5_000, signal: e => events.push(e)});
      const recent = [going(RUN_A), going(RUN_B)];
      await reaper.step(tel(2, undefined, recent), NOW);
      await reaper.step(tel(2, undefined, recent), NOW + 4_999);
      expect(events).toHaveLength(1);
      await reaper.step(tel(2, undefined, recent), NOW + 5_000);
      expect(events).toHaveLength(2);
      await reaper.step(async () => null, NOW + 5_001); // another kind is throttled independently
      expect(events.map(e => e.kind)).toEqual(['stuck-slots', 'stuck-slots', 'probe-unknown']);
    });
    it('does not signal for one stuck slot or for young slots', async () => {
      const one = setup({0: {pid: 222, run: RUN_A}});
      const young = setup({0: {pid: 222, ageMs: 60_000}, 1: {pid: 223, ageMs: 60_000}});
      const events = [];
      for (const root of [one, young]) await createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([]), signal: e => events.push(e)}).step(tel(1));
      expect(events).toEqual([]);
    });
    it('signals probe-unknown when a dead-owner slot is kept because the probe failed', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}});
      const events = [];
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111]), signal: e => events.push(e)});
      await reaper.step(async () => { throw new Error('ssh down'); });
      expect(events.map(e => e.kind)).toEqual(['probe-unknown']);
      expect(names(root)).toEqual(['0']);
    });
    it('a throwing signal sink never breaks the pass', async () => {
      const root = setup({0: {pid: 111, run: RUN_A}, 1: {pid: 112, run: RUN_B}});
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112]), signal: () => { throw new Error('x'); }});
      expect(await reaper.step(async () => null)).toEqual([]);
    });
  });
  it.each([
    null, [], 'invalid', {}, {...done(RUN_B), runId: 'invalid'}, {...done(RUN_B), runId: 123},
    {...done(RUN_B), runId: RUN_B + '\n'}, {...done(RUN_B), code: '0'}, {...done(RUN_B), code: -1},
    {...done(RUN_B), code: 256}, {...done(RUN_B), code: 0.5}, {...done(RUN_B), code: undefined},
    {...going(RUN_B), startedAtET: 'invalid'}, {...going(RUN_B), startedAtET: null},
  ])('retains known-run markers when recent telemetry contains malformed entries: %j', async entry => {
    const root = setup({0: {pid: 111, run: RUN_A}, 1: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(1, undefined, [entry]))).toEqual([]);
    // Even a matching result does not authorize removal while another entry is unreadable.
    expect(await reaper.step(tel(1, undefined, [done(RUN_A), entry]))).toEqual([]);
    expect(names(root)).toEqual(['0', '1']);
  });
  it('retains markers when duplicate recent IDs make active-run accounting ambiguous', async () => {
    const root = setup({0: {pid: 111, run: RUN_A}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(1, undefined, [done(RUN_A), going(RUN_A)]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it.each([RUN_A, undefined])('keeps an unaccounted-for marker when active runs are missing from the producer’s capped recent window: %s', async run => {
    const root = setup({0: {pid: 111, run}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    const recent = Array.from({length: 50}, (_, i) => ({...done(RUN_B), runId: `r-${i.toString(16).padStart(32, '0')}`,
      startedAtET: easternTimestamp(NOW - 500_000), stageMs: {install: 0, run: 0}}));
    const telemetry = {sampledAtET: easternTimestamp(NOW + 120_000), cores: 8, loadPerCore: 0.1, memFreePct: 90, activeRuns: 1, recent};
    // Contract with the installed producer's parser: 50 is valid, 51 exceeds its current window.
    const parsed = parseTelemetry(JSON.stringify(telemetry));
    expect(() => parseTelemetry(JSON.stringify({...telemetry, recent: [...recent, {...recent[0], runId: RUN_C}]}))).toThrow();
    expect(await reaper.step(async () => parsed)).toEqual([]);
    expect(names(root)).toEqual(['0']);
    expect(await reaper.step(async () => ({...parsed, activeRuns: 0}))).toEqual(['slot-0.unconfirmed']);
  });
  it('reaps a known finished run even when other active runs are outside the recent window', async () => {
    const root = setup({0: {pid: 111, run: RUN_A}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(8, undefined, [done(RUN_A)]))).toEqual(['slot-0.unconfirmed']);
  });
  it.each([RUN_A, undefined].flatMap(run => [1, 50].map(size => ({run, size}))))('keeps an evicted active run despite matching counts from an inactive unfinished receipt: %j', async ({run, size}) => {
    const root = setup({0: {pid: 111, run}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    const recent = Array.from({length: size}, (_, i) => ({
      runId: `r-${i.toString(16).padStart(32, '0')}`,
      startedAtET: easternTimestamp(NOW + 30_000), code: i === 0 ? null : 0,
      stageMs: {install: 0, run: 0},
    }));
    // A prepare finished without execution leaves code:null behind, while A is still active outside recent.
    const parsed = parseTelemetry(JSON.stringify({sampledAtET: easternTimestamp(NOW + 120_000),
      cores: 8, loadPerCore: 0.1, memFreePct: 90, activeRuns: 1, recent}));
    expect(await reaper.step(async () => parsed)).toEqual([]);
    expect(names(root)).toEqual(['0']);
    expect([...blockedSlots(root, 1)]).toEqual([0]);
  });
  it.each([0, 1])('keeps a run-less marker when an unfinished run starts within clock skew after observed owner death (activeRuns=%s)', async activeRuns => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(activeRuns, undefined, [going(RUN_A, NOW + 29_000)]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
    expect([...blockedSlots(root, 1)]).toEqual([0]);
  });
  it.each([
    {startedMs: NOW - 660_001, keep: false}, {startedMs: NOW - 660_000, keep: true},
    {startedMs: NOW, keep: true}, {startedMs: NOW + 60_000, keep: true},
    {startedMs: NOW + 60_001, keep: false},
  ])('applies clock-skew allowance inclusively to both ends of a run-less marker window: %j', async ({startedMs, keep}) => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    // A consumed prepare can leave an unfinished receipt even after activeRuns drops to zero.
    const result = await reaper.step(tel(0, undefined, [going(RUN_A, startedMs)]));
    expect(result).toEqual(keep ? [] : ['slot-0.unconfirmed']);
    expect([...blockedSlots(root, 1)]).toEqual(keep ? [0] : []);
  });
  it('decides per run: a busy Forge releases finished receipts but retains absent and unfinished runs', async () => {
    const root = setup({0: {pid: 111, run: RUN_A}, 1: {pid: 112, run: RUN_B}, 2: {pid: 113, run: RUN_C}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112, 113])});
    // A finished (code), B absent (possibly evicted while still active), C still running.
    const busy = [done(RUN_A, 1), going(RUN_C), ...Array.from({length: 7}, (_, i) => going('r-' + String(i).repeat(32)))];
    expect(await reaper.step(tel(8, undefined, busy))).toEqual(['slot-0.unconfirmed']);
    expect(names(root)).toEqual(['1', '2']);
    expect(await reaper.step(tel(0, undefined, [done(RUN_C)]))).toEqual(['slot-1.unconfirmed', 'slot-2.unconfirmed']);
    expect(names(root)).toEqual([]);
  });
  it('keeps a run-less marker while Forge is active or a possible matching receipt is unfinished', async () => {
    const root = setup({0: {pid: 111}, 1: {pid: 112}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111, 112])});
    const early = going('r-' + 'd'.repeat(32), NOW - 5_000_000); // began long before either marker: not theirs
    const mine = going('r-' + 'e'.repeat(32), NOW - 590_000);
    expect(await reaper.step(tel(1, undefined, [early]))).toEqual([]);
    expect(names(root)).toEqual(['0', '1']);
    expect(await reaper.step(tel(0, undefined, [early]))).toEqual(['slot-0.unconfirmed', 'slot-1.unconfirmed']);
    const again = setup({0: {pid: 111}});
    const r2 = createMarkerReaper({root: again, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await r2.step(tel(1, undefined, [mine]))).toEqual([]);
    expect(await r2.step(tel(0, undefined, [mine]))).toEqual([]);
  });
  it('retains bare legacy markers without remote termination evidence', async () => {
    const root = setup({0: {}, 1: {}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW});
    expect(await reaper.step(async () => null)).toEqual([]);
    expect(names(root)).toEqual(['0', '1']);
  });
  it('retains a legacy marker whose dead slot-lock holder cannot prove remote termination', async () => {
    const root = setup({0: {}}), lock = lockDirFor(root, 'slot-0');
    mkdirSync(lock, {recursive: true});
    writeFileSync(join(lock, 'lock.json'), JSON.stringify({owner: 'old', pid: 111, heartbeatAt: iso(NOW), acquiredAt: iso(NOW), path: 'slot-0'}));
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(async () => null)).toEqual([]);
    expect(names(root)).toEqual(['0']);
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
  it.each([
    {host: 123}, {owner: 123}, {pid: '111'}, {pid: 1.5}, {at: 'corrupt'}, {run: 'invalid'}, {run: RUN_A + '\n'},
  ])('retains malformed structured markers with eligible valid telemetry: %j', async fields => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, JSON.stringify({v: 1, host: 'forge', owner: 'o', pid: 111, at: NOW - 600_000, ...fields}));
    const old = (NOW - 600_000) / 1000; utimesSync(file, old, old);
    // A dead lock holder makes field validation the only reason to keep even a malformed pid.
    const lock = lockDirFor(root, 'slot-0'); mkdirSync(lock, {recursive: true});
    writeFileSync(join(lock, 'lock.json'), JSON.stringify({owner: 'old', pid: 111, heartbeatAt: iso(NOW), acquiredAt: iso(NOW), path: 'slot-0'}));
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: () => 'dead'});
    expect(await reaper.step(tel(0))).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
  it('ignores another owner’s sidecar while the marker’s possible run remains unfinished', async () => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed');
    const saved = JSON.stringify({owner: 'previous-owner', run: RUN_A});
    writeFileSync(file + '.run', saved);
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(1, undefined, [done(RUN_A), going(RUN_B, NOW - 590_000)]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
    expect(readFileSync(file + '.run', 'utf8')).toBe(saved);
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
    expect(recordMarkerRun(file, {owner: 'o', run: RUN_A + '\n'})).toBe(false);
    expect(recordMarkerRun(file, {owner: 'o', run: [RUN_A]})).toBe(false);
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
  it.each([undefined, null, {}, 'not-an-array'])('refuses telemetry without a recent array: %j', async recent => {
    const root = setup({0: {pid: 111, run: RUN_A}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    const telemetry = {sampledAtET: iso(NOW + 120_000), activeRuns: 0, ...(recent === undefined ? {} : {recent})};
    expect(await reaper.step(async () => telemetry)).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
});
