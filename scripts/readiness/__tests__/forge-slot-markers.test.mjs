// @vitest-environment node
import {describe, it, expect, afterEach} from 'vitest';
import {readdirSync, readFileSync, mkdirSync, renameSync, mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {lockDirFor} from '../file-locks.mjs';
import {parseTelemetry, easternTimestamp} from '../forge-exec-run.mjs';
import {createMarkerReaper, markerContent, blockedSlots, heldTombstone, recordMarkerRun, recordMarkerExit, watchMarkerExit, runVerdict, RUNLESS_DEAD_GRACE_MS} from '../forge-slot-markers.mjs';

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

describe('R1017 run-less dead-owner recovery', () => {
  function fixture({minutes = 15, state = 'dead', change = () => {}} = {}) {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed');
    // The live failure shape: death before any run id or nonce was recorded.
    writeFileSync(file, JSON.stringify({v: 1, note: 'remote termination unconfirmed', host: 'forge',
      owner: 'remote-111-aabbcc', pid: 111, at: NOW - 600_000}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const st = statSync(file);
    writeFileSync(file + '.dead', JSON.stringify({key: `slot-0.unconfirmed:${st.ino}:${st.mtimeMs}`, at: NOW}));
    let sampledMs = NOW + minutes * 60_000;
    const ids = Array.from({length: 7}, (_, i) => 'r-' + (i + 1).toString(16).padStart(32, '0'));
    const telemetry = {sampledAtET: iso(sampledMs), activeRuns: 7, activeRunIds: ids,
      recent: ids.map(id => going(id, NOW + 60_001))};
    change(telemetry);
    const events = [];
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => sampledMs, liveness: () => state,
      stuckMinSlots: 1, signal: event => events.push(event)});
    return {file, root, reaper, events, sample: async () => telemetry,
      sampleAt: ms => { sampledMs = ms; telemetry.sampledAtET = iso(ms); }};
  }
  it.each([15, 28])('releases the exact seven-active-run live failure shape at %s minutes', async minutes => {
    expect(RUNLESS_DEAD_GRACE_MS).toBe(15 * 60_000);
    const f = fixture({minutes});
    expect(existsSync(f.file + '.run')).toBe(false);
    expect(await f.reaper.step(f.sample)).toEqual(['slot-0.unconfirmed']);
    expect(existsSync(f.file)).toBe(false);
    expect(existsSync(f.file + '.dead')).toBe(false);
  });
  it('accepts a dead-owner request starting after the 15-minute release, even if still active at 28 minutes', async () => {
    // R1017 explicitly accepts this residual: a dispatched request might start MORE than 15 minutes
    // after owner death. Release can add one concurrent Forge run until it finishes, within Forge's cap;
    // no run is killed and the dead owner cannot collect a result. This is not a remote start deadline.
    const f = fixture();
    expect(await f.reaper.step(f.sample)).toEqual(['slot-0.unconfirmed']);
    expect([...blockedSlots(f.root, 1)]).toEqual([]);
    const telemetry = await f.sample();
    telemetry.activeRunIds.push(RUN_A);
    telemetry.activeRuns++;
    telemetry.recent.push(going(RUN_A, NOW + 16 * 60_000));
    f.sampleAt(NOW + 28 * 60_000);
    expect(await f.reaper.step(f.sample)).toEqual([]);
    expect(existsSync(f.file)).toBe(false);
    expect(telemetry.recent.find(item => item.runId === RUN_A).code).toBe(null);
    // First observing the same delayed request at 28 minutes also permits release under the ruling.
    const late = fixture({minutes: 28, change: t => {
      t.activeRunIds.push(RUN_A);
      t.activeRuns++;
      t.recent.push(going(RUN_A, NOW + 16 * 60_000));
    }});
    expect(await late.reaper.step(late.sample)).toEqual(['slot-0.unconfirmed']);
  });
  it.each([
    ['14 minutes', {minutes: 14}],
    ['possibly live owner', {state: 'unknown'}], ['live owner', {state: 'alive'}],
    ['active receipt missing', {change: t => { t.recent.pop(); }}],
    ['unparseable active start', {change: t => { t.recent[0].startedAtET = 'bad'; }}],
    ['active start inside window', {change: t => { t.recent[0].startedAtET = iso(NOW); }}],
    ['null-code receipt inside window', {change: t => { t.recent.push(going(RUN_A, NOW)); }}],
    ['97 receipt inside window', {change: t => { t.recent.push({...going(RUN_A, NOW), code: 97}); }}],
    ['254 receipt inside window', {change: t => { t.recent.push({...going(RUN_A, NOW), code: 254}); }}],
    ['missing activeRunIds', {change: t => { delete t.activeRunIds; }}],
    ['mismatched activeRunIds', {change: t => { t.activeRuns++; }}],
    ['stale sample', {change: t => { t.sampledAtET = iso(NOW + 15 * 60_000 - 30_001); }}],
  ])('fails closed on %s', async (_label, options) => {
    const f = fixture(options);
    expect(await f.reaper.step(f.sample)).toEqual([]);
    expect(existsSync(f.file)).toBe(true);
  });
  it('requires the persisted death stamp, rather than marker age alone', async () => {
    const f = fixture();
    rmSync(f.file + '.dead');
    expect(await f.reaper.step(f.sample)).toEqual([]);
    expect(existsSync(f.file)).toBe(true);
  });
  it('requires the marker itself to be at least 15 minutes old', async () => {
    const f = fixture(), st = statSync(f.file);
    // Preserve the old death stamp for this inode/mtime while the marker's dispatch timestamp is newer.
    const marker = JSON.parse(readFileSync(f.file, 'utf8'));
    writeFileSync(f.file, JSON.stringify({...marker, at: NOW + 60_000}));
    utimesSync(f.file, st.atime, st.mtime);
    expect(await f.reaper.step(f.sample)).toEqual([]);
    expect(existsSync(f.file)).toBe(true);
  });
  it('fails closed when the marker dispatch timestamp is missing', async () => {
    const f = fixture(), st = statSync(f.file);
    const marker = JSON.parse(readFileSync(f.file, 'utf8'));
    delete marker.at;
    writeFileSync(f.file, JSON.stringify(marker));
    utimesSync(f.file, st.atime, st.mtime);
    expect(await f.reaper.step(f.sample)).toEqual([]);
    expect(existsSync(f.file)).toBe(true);
  });
  it('reports an operator-visible stuck slot when receipts exceed the retained window', async () => {
    const f = fixture({change: t => {
      t.activeRunIds = Array.from({length: 51}, (_, i) => 'r-' + (i + 1).toString(16).padStart(32, '0'));
      t.activeRuns = 51;
      t.recent = t.activeRunIds.slice(0, 50).map(id => going(id, NOW + 60_001));
    }});
    expect(await f.reaper.step(f.sample)).toEqual([]);
    expect(f.events).toContainEqual(expect.objectContaining({kind: 'stuck-slots'}));
  });
});

describe('R1017 marker traceability', () => {
  const caller = {kind: 'selected', session: 'test-session', ppid: 22, cmd: 'npm'};
  const tags = {caller, lane: 14, pr: 1017};
  it('serializes pid, caller, lane and PR while tolerating absent optional fields', async () => {
    const text = markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', ...tags});
    expect(JSON.parse(text)).toMatchObject({pid: 111, ...tags});
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed']);
  });
  it.each([
    {caller: null}, {caller: []}, {caller: {ppid: '22'}}, {caller: {ppid: -1}},
    {caller: {kind: 4}}, {caller: {session: 'bad\ntext'}}, {caller: {unknown: 'x'}},
    {caller: {cmd: 'npm run'}}, {caller: {cmd: '/bin/npm'}}, {caller: {cmd: 'a'.repeat(41)}},
    {lane: {}}, {lane: -1}, {lane: ''}, {pr: '1017'}, {pr: 0},
  ])('treats a malformed present trace field as unreadable: %j', async bad => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed');
    // Raw bytes, not markerContent: the writer now normalises these away; the reader must still refuse them on disk.
    writeFileSync(file, JSON.stringify({v: 1, note: 'remote termination unconfirmed', host: 'forge', owner: 'o', pid: 111,
      at: NOW - 600_000, ...bad}) + '\n');
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    let probes = 0;
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: () => 'dead'});
    expect(await reaper.step(async () => { probes++; return await tel(0)(); })).toEqual([]);
    expect(probes).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
  it.each([
    [{caller: null}, {}], [{caller: []}, {}], [{caller: {ppid: '22'}}, {}], [{caller: {ppid: -1, kind: 'files'}}, {caller: {kind: 'files'}}],
    [{caller: {ppid: 1.5}}, {}], [{caller: {kind: 4, ppid: 3}}, {caller: {ppid: 3}}], [{caller: {session: 'bad\ntext'}}, {}],
    [{caller: {session: ''}}, {}], [{caller: {session: 's'.repeat(201)}}, {}], [{caller: {unknown: 'x', cmd: 'npm'}}, {caller: {cmd: 'npm'}}],
    [{caller: {cmd: 'npm run'}}, {}], [{caller: {cmd: '/bin/npm'}}, {}], [{caller: {cmd: 'a'.repeat(41)}}, {}],
    [{lane: {}}, {}], [{lane: -1}, {}], [{lane: ''}, {}], [{pr: '1017'}, {}], [{pr: 0}, {}],
  ])('the writer omits any tag the reader would reject, so the marker stays readable and reapable: %j', async (bad, kept) => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', ...bad}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect({caller: written.caller, lane: written.lane, pr: written.pr}).toEqual({caller: undefined, lane: undefined, pr: undefined, ...kept});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: () => 'dead'});
    expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed']);
  });
  it.each([
    [{run: 'bogus'}, 'run'], [{run: RUN_A + '\n'}, 'run'], [{host: null}, 'host'], [{owner: 7}, 'owner'],
    [{pid: 1.5}, 'pid'], [{nowMs: Number.NaN}, 'at'],
  ])('the writer omits a core field the reader would reject instead of writing an unreadable marker: %j', async (bad, field) => {
    const root = setup({}), file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', ...bad}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty(field);
    if (field === 'run') { // a dropped run leaves a readable run-less marker, released by the idle-Forge path
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: () => 'dead'});
      expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed']);
    }
  });
  it.each([0, 1])('releases a dead owner on idle Forge alike for caller.ppid %s (0 = parent outside the PID namespace)', async ppid => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed');
    const caller = {kind: 'files', session: 'fix-7024', ppid, cmd: 'npm'};
    writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', caller, lane: 0, pr: 7024}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    expect(JSON.parse(readFileSync(file, 'utf8')).caller).toEqual(caller);
    const logs = [];
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111]), log: line => logs.push(line)});
    expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed']);
    const line = logs.find(text => text.includes('released unconfirmed'));
    expect(JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1))).toMatchObject({caller, lane: 0, pr: 7024, pid: 111});
  });
  it.each([false, true])('includes per-slot trace and exit evidence in release logs and stuck details (record=%s)', async withExit => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', ...tags}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const exit = withExit ? {owner: 'o', code: 143, signal: 'SIGTERM', at: NOW - 300_000} : 'no-exit-record';
    if (withExit) recordMarkerExit(file, exit);
    const logs = [], events = [];
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111]),
      stuckMinSlots: 1, stuckAgeMs: 1, log: line => logs.push(line), signal: event => events.push(event)});
    expect(await reaper.step(tel(1, undefined, [going(RUN_A, NOW)]))).toEqual([]);
    expect(events.find(e => e.kind === 'stuck-slots').detail.markers).toContainEqual({name: 'slot-0.unconfirmed', run: null, pid: 111, ...tags, exit});
    expect(await reaper.step(tel(0))).toEqual(['slot-0.unconfirmed']);
    const line = logs.find(text => text.includes('released unconfirmed'));
    const data = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
    expect(data).toMatchObject({pid: 111, ...tags, ...(withExit ? {exit} : {})}); // the release line omits an absent exit record; stuck details carry no-exit-record
    expect(existsSync(file + '.exit')).toBe(false);
  });
  it('writes synchronously on client exit and preserves a recorded signal with a fake process', () => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed'), client = new EventEmitter();
    const watcher = watchMarkerExit({files: [file], owner: 'o', clock: () => NOW, client});
    client.emit('exit', 7);
    expect(JSON.parse(readFileSync(file + '.exit', 'utf8'))).toEqual({owner: 'o', code: 7, signal: null, at: NOW});
    expect(statSync(file + '.exit').mode & 0o777).toBe(0o600);
    watcher.record(143, 'SIGTERM');
    client.emit('exit', 143);
    expect(JSON.parse(readFileSync(file + '.exit', 'utf8'))).toEqual({owner: 'o', code: 143, signal: 'SIGTERM', at: NOW});
    watcher.stop();
    expect(client.listenerCount('exit')).toBe(0);
  });
  it('never throws or writes exit evidence for a successor or unwritable marker', () => {
    const root = setup({0: {pid: 111}}), file = join(root, 'slot-0.unconfirmed'), client = new EventEmitter();
    const watcher = watchMarkerExit({files: [file], owner: 'predecessor', clock: () => NOW, client});
    expect(() => client.emit('exit', 0)).not.toThrow();
    expect(existsSync(file + '.exit')).toBe(false);
    rmSync(file);
    expect(() => client.emit('exit', 1)).not.toThrow();
    watcher.stop();
  });
});

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
      // the first sample is old enough to start confirmation; the second lists the run as younger than the margin
      for (const [startedAgo, expected] of [[89_999, []], [90_000, ['slot-0.unconfirmed']]]) {
        const {root, reaper} = mk();
        await reaper.step(tel(0, S1, [going(RUN_A, S1 - 90_000)]));
        expect(await reaper.step(tel(0, S1 + 30_000, [going(RUN_A, S1 + 30_000 - startedAgo)]))).toEqual(expected);
        expect(names(root)).toEqual(expected.length ? [] : ['0']);
      }
    });
    it('restarts confirmation after a non-qualifying (too-young) sample between two qualifying ones', async () => {
      const {root, reaper} = mk();
      expect(await reaper.step(tel(0, S1, [going(RUN_A, S1 - 90_000)]))).toEqual([]); // qualifying: starts the window
      expect(await reaper.step(tel(0, S1 + 10_000, [going(RUN_A, S1 + 10_000 - 89_999)]))).toEqual([]); // too young: resets
      expect(await reaper.step(tel(0, S1 + 31_000, [going(RUN_A, S1 + 31_000 - 90_000)]))).toEqual([]); // fresh window starts here
      expect(names(root)).toEqual(['0']);
      expect(await reaper.step(tel(0, S1 + 61_000, [going(RUN_A, S1 + 61_000 - 90_000)]))).toEqual(['slot-0.unconfirmed']);
    });
    it('does not start confirmation from a sample whose run is younger than the margin', async () => {
      const {root, reaper} = mk();
      await reaper.step(tel(0, S1, [going(RUN_A, S1 - 10_000)]));
      expect(await reaper.step(tel(0, S1 + 30_000, [going(RUN_A, S1 + 30_000 - 90_000)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
    });
    it('ignores a sample taken before the death-sample margin and releases only on two samples after it', async () => {
      const {root, reaper} = mk();
      const recent = [going(RUN_A, NOW - 700_000)];
      expect(await reaper.step(tel(0, NOW + 89_999, recent))).toEqual([]); // too early to speak for the death
      expect(await reaper.step(tel(0, NOW + 119_999, recent))).toEqual([]); // this is the first usable idle sample
      expect(await reaper.step(tel(0, NOW + 149_999, recent))).toEqual(['slot-0.unconfirmed']);
    });
    it('a recreated reaper needs its own two live samples and never releases on a predecessor stamp', async () => {
      const {root, reaper} = mk();
      expect(await reaper.step(tel(0, S1, [going(RUN_A)]))).toEqual([]);
      const second = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
      expect(await second.step(tel(0, S1 + 31_000, [going(RUN_A)]))).toEqual([]);
      expect(names(root)).toEqual(['0']);
      expect(await second.step(tel(0, S1 + 61_000, [going(RUN_A)]))).toEqual(['slot-0.unconfirmed']);
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
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222, 223]), signal: e => events.push(e)});
      await reaper.step(tel(1));
      await reaper.step(tel(1));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({kind: 'stuck-slots', detail: {slots: ['slot-0.unconfirmed', 'slot-1.unconfirmed']}});
    });
    it('never signals stuck-slots for old markers whose owners are alive (a long remote job is healthy)', async () => {
      const root = setup({0: {pid: 222, run: RUN_A}, 1: {pid: 223, run: RUN_B}, 2: {pid: 224, run: RUN_C}});
      const events = [];
      const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([]), signal: e => events.push(e)});
      await reaper.step(tel(3, undefined, [going(RUN_A), going(RUN_B), going(RUN_C)]));
      expect(events).toEqual([]);
      // one owner dies: still below the minimum of two dead-owner slots
      const mixed = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222]), signal: e => events.push(e)});
      await mixed.step(tel(3, undefined, [going(RUN_A), going(RUN_B), going(RUN_C)]));
      expect(events).toEqual([]);
      const two = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222, 224]), signal: e => events.push(e)});
      await two.step(tel(3, undefined, [going(RUN_A), going(RUN_B), going(RUN_C)]));
      expect(events).toHaveLength(1);
      expect(events[0].detail.slots).toEqual(['slot-0.unconfirmed', 'slot-2.unconfirmed']);
    });
    it('throttles a signal kind across reaper instances sharing one remote root', async () => {
      const root = setup({0: {pid: 222, run: RUN_A}, 1: {pid: 223, run: RUN_B}});
      const events = [];
      const make = () => createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222, 223]), signalEveryMs: 5_000, signal: e => events.push(e)});
      const recent = [going(RUN_A), going(RUN_B)];
      await make().step(tel(2, undefined, recent), NOW);
      await make().step(tel(2, undefined, recent), NOW + 4_999); // a fresh reaper (another wait loop) stays quiet
      expect(events).toHaveLength(1);
      await make().step(tel(2, undefined, recent), NOW + 5_000);
      expect(events).toHaveLength(2);
    });
    it('a future-dated or unreadable throttle stamp never suppresses the signal for good', async () => {
      const root = setup({0: {pid: 222, run: RUN_A}, 1: {pid: 223, run: RUN_B}});
      const events = [];
      const recent = [going(RUN_A), going(RUN_B)];
      const stamp = join(root, '.signal-stuck-slots');
      for (const content of [JSON.stringify({at: NOW + 86_400_000}), 'not json', '{}']) {
        writeFileSync(stamp, content);
        await createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222, 223]), signal: e => events.push(e)}).step(tel(2, undefined, recent), NOW);
      }
      expect(events).toHaveLength(3);
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
      for (const root of [one, young]) await createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([222, 223]), signal: e => events.push(e)}).step(tel(1));
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

// Leaked run-less markers (client died before prepare returned) walled off the cap while Forge was idle: a busy
// Forge (activeRuns > 0) never proved a run-less marker idle, so only a zero-active sample could release it.
describe('bounded orphan release of run-less markers', () => {
  const BOUND = 120 * 60_000, SKEW = 60_000;
  const unrelated = going(RUN_B, NOW + SKEW + 1);
  const withIds = (sampledMs, ids, recent = []) => async () => ({sampledAtET: iso(sampledMs), activeRuns: ids.length, activeRunIds: ids, recent});
  const make = () => {
    const root = setup({0: {pid: 111}});
    return {root, reaper: createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])})};
  };
  it('releases a dead-owner run-less marker on a busy Forge once any run it could own is older than the run ceiling', async () => {
    const {root, reaper} = make();
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1_000, [RUN_B], [unrelated]))).toEqual(['slot-0.unconfirmed']);
    expect(names(root)).toEqual([]);
  });
  it('keeps it when the sample is not yet past the run ceiling plus skew after the owner was first seen dead', async () => {
    const {root, reaper} = make();
    expect(await reaper.step(withIds(NOW + BOUND + SKEW - 1_000, [RUN_B], [unrelated]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('keeps it when Forge does not list its active run ids (count-only telemetry)', async () => {
    const {root, reaper} = make();
    expect(await reaper.step(tel(1, NOW + BOUND + SKEW + 1_000))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it('keeps it when an unfinished run started inside its possible window is still listed', async () => {
    const {root, reaper} = make();
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1_000, [RUN_B], [going(RUN_B, NOW + 1_000)]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it.each([97, 254])('keeps it when a code-%s receipt (surviving descendants possible) started inside its window', async code => {
    const {root, reaper} = make();
    const failure = {...done(RUN_A, code), startedAtET: iso(NOW - 1_000)};
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1_000, [RUN_B], [unrelated, failure]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it.each([97, 254].flatMap(code => ['same reaper', 'restarted reaper', 'first observed after eviction'].map(observation => ({code, observation}))))(
    'retains an active slot after its supervisor-failure receipt is evicted: %j', async ({code, observation}) => {
      const {root, reaper} = make();
      const failure = {...done(RUN_A, code), startedAtET: iso(NOW - 1_000)};
      if (observation !== 'first observed after eviction') {
        expect(await reaper.step(withIds(NOW + 120_000, [RUN_A], [failure]))).toEqual([]);
      }
      const current = observation === 'restarted reaper'
        ? createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])}) : reaper;
      const newer = Array.from({length: 50}, (_, i) => ({
        ...done('r-' + i.toString(16).padStart(32, '0')), startedAtET: iso(NOW + SKEW + 1 + i),
      }));
      expect(await current.step(withIds(NOW + BOUND + SKEW + 1, [RUN_A], newer))).toEqual([]);
      expect([...blockedSlots(root, 1)]).toEqual([0]);
      // An authoritative idle sample can still settle the run-less marker.
      expect(await current.step(withIds(NOW + BOUND + SKEW + 2, [], newer))).toEqual(['slot-0.unconfirmed']);
    });
  it('never applies to a live owner', async () => {
    const root = setup({0: {pid: 111}});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([])});
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1_000, [RUN_B], [unrelated]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it.each([-1, 0, 1])('requires the sample strictly past the ceiling plus skew (offset %s ms)', async offset => {
    const {root, reaper} = make();
    const released = offset > 0;
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + offset, [RUN_B], [unrelated]))).toEqual(released ? ['slot-0.unconfirmed'] : []);
    expect(names(root)).toEqual(released ? [] : ['0']);
  });
  it.each([null, [], [RUN_B, RUN_B], ['invalid']])('keeps the marker with invalid authoritative active ids: %j', async activeRunIds => {
    const {root, reaper} = make();
    expect(await reaper.step(async () => ({sampledAtET: iso(NOW + BOUND + SKEW + 1), activeRuns: 1, activeRunIds, recent: []}))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
  it.each([null, 97, 254].flatMap(code => [NOW - 660_001, NOW - 660_000, NOW + SKEW, NOW + SKEW + 1].map(startedMs => ({code, startedMs}))))(
    'guards the inclusive receipt window even when the receipt is absent from active ids: %j', async ({code, startedMs}) => {
      const {root, reaper} = make();
      const keep = startedMs >= NOW - 660_000 && startedMs <= NOW + SKEW;
      const recent = [unrelated, {runId: RUN_A, code, startedAtET: iso(startedMs)}];
      expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1, [RUN_B], recent))).toEqual(keep ? [] : ['slot-0.unconfirmed']);
      expect(names(root)).toEqual(keep ? ['0'] : []);
    });
  it.each([{recent: []}, {recent: [unrelated]}])('keeps it when receipts cannot place every active run outside its window: %j', async ({recent}) => {
    const {root, reaper} = make();
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1, [RUN_A, RUN_B], recent))).toEqual([]);
    expect([...blockedSlots(root, 1)]).toEqual([0]);
  });
  it.each([null, 0, 97, 254].flatMap(code => [NOW - 660_001, NOW - 660_000, NOW + SKEW, NOW + SKEW + 1].map(startedMs => ({code, startedMs}))))(
    'requires each active run to be strictly outside the ownership window regardless of receipt code: %j', async ({code, startedMs}) => {
      const {root, reaper} = make();
      const keep = startedMs >= NOW - 660_000 && startedMs <= NOW + SKEW;
      const recent = [unrelated, {runId: RUN_A, code, startedAtET: iso(startedMs)}];
      expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1, [RUN_A, RUN_B], recent))).toEqual(keep ? [] : ['slot-0.unconfirmed']);
      expect(names(root)).toEqual(keep ? ['0'] : []);
    });
  it('retains and signals a stuck slot when active runs exceed the 50-receipt window', async () => {
    const root = setup({0: {pid: 111}}), signals = [];
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111]),
      stuckMinSlots: 1, signal: event => signals.push(event)});
    const ids = Array.from({length: 51}, (_, i) => 'r-' + i.toString(16).padStart(32, '0'));
    const recent = ids.slice(0, 50).map(run => going(run, NOW + SKEW + 1));
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1, ids, recent))).toEqual([]);
    expect([...blockedSlots(root, 1)]).toEqual([0]);
    expect(signals.some(event => event.kind === 'stuck-slots')).toBe(true);
  });
  it.each(['inline', 'sidecar'])('does not apply the bound to a marker with a %s run id', async binding => {
    const root = setup({0: {pid: 111, run: binding === 'inline' ? RUN_A : undefined}});
    if (binding === 'sidecar') recordMarkerRun(join(root, 'slot-0.unconfirmed'), {owner: 'o', run: RUN_A});
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: liveness([111])});
    expect(await reaper.step(withIds(NOW + BOUND + SKEW + 1, [RUN_A, RUN_B]))).toEqual([]);
    expect(names(root)).toEqual(['0']);
  });
});
