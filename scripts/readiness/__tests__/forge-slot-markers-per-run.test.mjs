// @vitest-environment node
import {describe, it, expect, afterEach, vi} from 'vitest';
import {mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync, statSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMarkerReaper, markerContent, runVerdict, recordMarkerRun, FINISH_RETRY_MS, FINISH_TIMEOUT_MS} from '../forge-slot-markers.mjs';
import {createRunFinisher, RUN_FINISH_TIMEOUT_MS} from '../forge-run-finish.mjs';

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

function setup(run = RUN_DEAD, alive = false, log = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'slot-per-run-')); roots.push(root);
  const file = join(root, 'slot-0.unconfirmed');
  writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run}));
  utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
  const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, log, liveness: pid => (pid === 111 && !alive ? 'dead' : 'alive')});
  return {file, reaper};
}

describe('release log compatibility', () => {
  it('preserves the exact legacy line when no new provenance or exit evidence exists', async () => {
    const log = vi.fn(), f = setup(RUN_DEAD, false, log);
    expect(await f.reaper.step(tel(S1, {activeRuns: 0, activeRunIds: []}, [{...dead, code: 0}]))).toEqual(['slot-0.unconfirmed']);
    expect(log.mock.calls[0][0]).toBe(`heavy-admission: released unconfirmed remote slot ${JSON.stringify({slot: 0, runId: RUN_DEAD, verdict: 'finished', activeRuns: 0, sampledAtET: iso(S1)})} activeRuns=0\n`);
  });
  it('adds only known provenance and PID when tags exist without exit evidence', async () => {
    const log = vi.fn(), f = setup(RUN_DEAD, false, log), caller = {kind: 'files'};
    writeFileSync(f.file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge', run: RUN_DEAD,
      caller, lane: 0, pr: 1017}));
    utimesSync(f.file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    expect(await f.reaper.step(tel(S1, {activeRuns: 0, activeRunIds: []}, [{...dead, code: 0}]))).toEqual(['slot-0.unconfirmed']);
    const record = JSON.parse(/released unconfirmed remote slot (\{.*\}) activeRuns=/.exec(log.mock.calls[0][0])[1]);
    expect(record).toEqual({slot: 0, runId: RUN_DEAD, verdict: 'finished', activeRuns: 0, sampledAtET: iso(S1),
      caller, lane: 0, pr: 1017, pid: 111});
  });
});

describe('R1017 finish settled active runs for dead owners', () => {
  const nonce = 'a'.repeat(32);
  function fixture({code = 97, savedNonce = nonce, alive = false, host = 'forge', finishRun = vi.fn(async () => {})} = {}) {
    const root = mkdtempSync(join(tmpdir(), 'slot-finish-')); roots.push(root);
    const file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host, run: RUN_DEAD}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    expect(recordMarkerRun(file, {owner: 'o', run: RUN_DEAD, nonce: savedNonce})).toBe(true);
    const st = statSync(file);
    writeFileSync(file + '.dead', JSON.stringify({key: `slot-0.unconfirmed:${st.ino}:${st.mtimeMs}`, at: NOW - 120_000}));
    let now = NOW;
    const log = vi.fn();
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => now, liveness: () => alive ? 'alive' : 'dead', finishRun, log});
    const sample = (patch = {}) => async () => ({sampledAtET: iso(now), activeRuns: 1, activeRunIds: [RUN_DEAD], recent: [{...dead, code}], ...patch});
    return {root, file, log, reaper, sample, finishRun, setNow: value => { now = value; }};
  }
  it.each([0, 97, 254, 255])('finishes listed active code %s once and removes marker and sidecars', async code => {
    const f = fixture({code});
    writeFileSync(f.file + '.exit', JSON.stringify({owner: 'o', code: 143, signal: 'SIGTERM', at: NOW - 120_000}));
    writeFileSync(f.file + '.idle', '{}');
    expect(await f.reaper.step(f.sample())).toEqual(['slot-0.unconfirmed']);
    expect(f.finishRun).toHaveBeenCalledTimes(1);
    expect(f.finishRun).toHaveBeenCalledWith({run: RUN_DEAD, nonce});
    expect(readdirSync(f.root).filter(name => name.startsWith('slot-'))).toEqual([]);
    expect(f.log.mock.calls.filter(([line]) => line.includes("(finished on owner's behalf)"))).toHaveLength(1);
    await f.reaper.step(f.sample());
    expect(f.finishRun).toHaveBeenCalledTimes(1);
  });
  it('keeps failed finishes, logs once and retries no more often than every 30 seconds per run', async () => {
    expect(FINISH_RETRY_MS).toBe(30_000);
    const f = fixture({finishRun: vi.fn().mockRejectedValue(new Error('transport failed'))});
    expect(await f.reaper.step(f.sample())).toEqual([]);
    f.setNow(NOW + FINISH_RETRY_MS - 1);
    expect(await f.reaper.step(f.sample())).toEqual([]);
    expect(f.finishRun).toHaveBeenCalledTimes(1);
    f.setNow(NOW + FINISH_RETRY_MS);
    expect(await f.reaper.step(f.sample())).toEqual([]);
    expect(f.finishRun).toHaveBeenCalledTimes(2);
    expect(existsSync(f.file)).toBe(true);
    expect(f.log.mock.calls.filter(([line]) => line.includes('finish failed'))).toHaveLength(1);
  });
  it('logs finish and exit evidence while omitting unknown provenance', async () => {
    const f = fixture(), exit = {owner: 'o', code: 143, signal: 'SIGTERM', at: NOW - 120_000};
    writeFileSync(f.file + '.exit', JSON.stringify(exit));
    expect(await f.reaper.step(f.sample())).toEqual(['slot-0.unconfirmed']);
    const record = JSON.parse(/released unconfirmed remote slot (\{.*\}) activeRuns=/.exec(f.log.mock.calls[0][0])[1]);
    expect(record).toEqual({slot: 0, runId: RUN_DEAD, verdict: 'finished-on-behalf', activeRuns: 1, sampledAtET: iso(NOW),
      exit, finishedOnBehalf: true, pid: 111});
  });
  it('bounds a stalled injected finish, retains the marker and throttles the retry', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({finishRun: vi.fn(() => new Promise(() => {}))});
      const pending = f.reaper.step(f.sample());
      await vi.advanceTimersByTimeAsync(FINISH_TIMEOUT_MS);
      expect(await pending).toEqual([]);
      expect(existsSync(f.file)).toBe(true);
      f.setNow(NOW + FINISH_RETRY_MS - 1);
      expect(await f.reaper.step(f.sample())).toEqual([]);
      expect(f.finishRun).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    ['null code', {code: null}], ['missing code', {code: undefined}], ['noninteger code', {code: 1.5}],
    ['out of range', {code: 256}], ['live owner', {alive: true}], ['wrong host', {host: 'other'}],
    ['legacy nonce', {savedNonce: undefined}],
  ])('never finishes with %s', async (label, options) => {
    // Explicitly remove nonce for legacy state (destructuring defaults otherwise fill it).
    const f = fixture(options);
    if (label === 'legacy nonce') writeFileSync(f.file + '.run', JSON.stringify({owner: 'o', run: RUN_DEAD}));
    expect(await f.reaper.step(f.sample(label === 'missing code' ? {recent: [{runId: RUN_DEAD, startedAtET: dead.startedAtET}]} : {}))).toEqual([]);
    expect(f.finishRun).not.toHaveBeenCalled();
    expect(existsSync(f.file)).toBe(true);
  });
  it.each(['stale', 'future', 'death margin', 'marker grace'])('does not finish before fresh qualifying evidence: %s', async condition => {
    const f = fixture();
    let sampledAtET = iso(NOW);
    if (condition === 'stale') sampledAtET = iso(NOW - 30_001);
    if (condition === 'future') sampledAtET = iso(NOW + 60_001);
    if (condition === 'death margin') {
      const st = statSync(f.file);
      writeFileSync(f.file + '.dead', JSON.stringify({key: `slot-0.unconfirmed:${st.ino}:${st.mtimeMs}`, at: NOW - 89_999}));
    }
    if (condition === 'marker grace') utimesSync(f.file, (NOW - 119_999) / 1000, (NOW - 119_999) / 1000);
    expect(await f.reaper.step(f.sample({sampledAtET}))).toEqual([]);
    expect(f.finishRun).not.toHaveBeenCalled();
  });
  it('releases on an idempotent already-consumed result', async () => {
    const f = fixture({finishRun: vi.fn(async () => ({alreadyFinished: true}))});
    expect(await f.reaper.step(f.sample())).toEqual(['slot-0.unconfirmed']);
    expect(f.finishRun).toHaveBeenCalledTimes(1);
    expect(f.finishRun).toHaveBeenCalledWith({run: RUN_DEAD, nonce});
  });
  it('does not finish a run absent from activeRunIds', async () => {
    const f = fixture({code: 0});
    expect(await f.reaper.step(f.sample({activeRuns: 0, activeRunIds: []}))).toEqual(['slot-0.unconfirmed']);
    expect(f.finishRun).not.toHaveBeenCalled();
  });
  it('retains legacy code 97 without a finish seam', async () => {
    const f = fixture();
    const reaper = createMarkerReaper({root: f.root, host: 'forge', clock: () => NOW, liveness: () => 'dead'});
    expect(await reaper.step(f.sample())).toEqual([]);
    expect(existsSync(f.file)).toBe(true);
  });
  it('preserves legacy nonce-less settled code 0 release without calling finish', async () => {
    const f = fixture({code: 0});
    writeFileSync(f.file + '.run', JSON.stringify({owner: 'o', run: RUN_DEAD}));
    expect(await f.reaper.step(f.sample())).toEqual(['slot-0.unconfirmed']);
    expect(f.finishRun).not.toHaveBeenCalled();
  });
  it('finishes once for multiple unit markers belonging to the same run', async () => {
    const f = fixture(), other = join(f.root, 'slot-1.unconfirmed');
    writeFileSync(other, readFileSync(f.file));
    utimesSync(other, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    expect(recordMarkerRun(other, {owner: 'o', run: RUN_DEAD, nonce})).toBe(true);
    const st = statSync(other);
    writeFileSync(other + '.dead', JSON.stringify({key: `slot-1.unconfirmed:${st.ino}:${st.mtimeMs}`, at: NOW - 120_000}));
    expect(await f.reaper.step(f.sample())).toEqual(['slot-0.unconfirmed', 'slot-1.unconfirmed']);
    expect(f.finishRun).toHaveBeenCalledTimes(1);
    expect(existsSync(other)).toBe(false);
  });
  it.each([undefined, null, '', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(32) + '\n'])('validates persisted nonce strictly: %j', async invalid => {
    const f = fixture();
    if (invalid === undefined) {
      expect(recordMarkerRun(f.file, {owner: 'o', run: RUN_DEAD})).toBe(true);
      expect(JSON.parse(readFileSync(f.file + '.run', 'utf8'))).toEqual({owner: 'o', run: RUN_DEAD});
    } else {
      expect(recordMarkerRun(f.file, {owner: 'o', run: RUN_DEAD, nonce: invalid})).toBe(false);
      writeFileSync(f.file + '.run', JSON.stringify({owner: 'o', run: RUN_DEAD, nonce: invalid}));
    }
    expect(await f.reaper.step(f.sample())).toEqual([]);
    expect(f.finishRun).not.toHaveBeenCalled();
  });
  it('round-trips nonce in a private owner-bound sidecar', () => {
    const f = fixture();
    expect(JSON.parse(readFileSync(f.file + '.run', 'utf8'))).toEqual({owner: 'o', run: RUN_DEAD, nonce});
    expect(statSync(f.file + '.run').mode & 0o777).toBe(0o600);
    expect(recordMarkerRun(f.file, {owner: 'successor', run: RUN_DEAD, nonce})).toBe(false);
  });
});

describe('R1017 bounded finish transport', () => {
  const request = {run: RUN_DEAD, nonce: 'a'.repeat(32)};
  function transport(error, stdout = '', stderr = '') {
    const stdin = {on: vi.fn(), end: vi.fn()};
    const exec = vi.fn((_file, _args, _options, callback) => { queueMicrotask(() => callback(error, stdout, stderr)); return {stdin}; });
    return {exec, stdin, finish: createRunFinisher({host: 'forge', exec})};
  }
  it('sends only run and nonce on stdin with BatchMode, a timeout and bounded output', async () => {
    const f = transport(null);
    await expect(f.finish(request)).resolves.toEqual({finished: true});
    expect(f.exec).toHaveBeenCalledWith('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'forge',
      'sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs finish'],
    expect.objectContaining({timeout: RUN_FINISH_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024}), expect.any(Function));
    expect(JSON.parse(f.stdin.end.mock.calls[0][0])).toEqual(request);
  });
  it.each(['State mismatch', 'ENOENT: state missing', 'No such file or directory'])('recognizes consumed remote state: %s', async stderr => {
    const f = transport(Object.assign(new Error('remote failure'), {code: 254}), '', stderr);
    await expect(f.finish(request)).resolves.toEqual({alreadyFinished: true});
  });
  it.each([
    {code: 255}, {code: 127}, {code: 254, killed: true}, {code: 254, signal: 'SIGKILL'},
    {code: 'ENOENT'}, {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},
  ])('fails closed on transport, timeout or oversized output: %j', async fields => {
    const error = Object.assign(new Error('failed'), fields);
    const f = transport(error, '', 'ENOENT: no such file or directory');
    await expect(f.finish(request)).rejects.toBe(error);
  });
  it('retains a maxBuffer failure even when oversized output contains a consumed-state phrase', async () => {
    const error = Object.assign(new Error('output too large'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
    const f = transport(error, 'ENOENT' + 'x'.repeat(64 * 1024));
    await expect(f.finish(request)).rejects.toBe(error);
  });
  it.each([{run: 'bad'}, {nonce: 'bad'}, {nonce: 'a'.repeat(32) + '\n'}])('rejects invalid input before SSH: %j', async patch => {
    const f = transport(null);
    await expect(f.finish({...request, ...patch})).rejects.toThrow('Invalid finish parameters');
    expect(f.exec).not.toHaveBeenCalled();
  });
});

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

describe('R518 audit round 1', () => {
  it('a run-less marker is NOT released from activeRunIds alone while any run is active', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slot-per-run-')); roots.push(root);
    const file = join(root, 'slot-0.unconfirmed');
    writeFileSync(file, markerContent({owner: 'o', pid: 111, nowMs: NOW - 600_000, host: 'forge'}));
    utimesSync(file, (NOW - 600_000) / 1000, (NOW - 600_000) / 1000);
    const reaper = createMarkerReaper({root, host: 'forge', clock: () => NOW, liveness: pid => (pid === 111 ? 'dead' : 'alive')});
    const t = ms => tel(ms, {activeRunIds: [RUN_LIVE]}, []);
    await reaper.step(t(S1)); await reaper.step(t(S2));
    expect(existsSync(file)).toBe(true);
  });
  it.each([97, 254])('a supervisor failure code %s absent from activeRunIds needs two own samples', async code => {
    const {file, reaper} = setup();
    const fin = {runId: RUN_DEAD, startedAtET: iso(NOW - 600_000), code};
    const t = ms => tel(ms, {activeRunIds: [RUN_LIVE]}, [live, fin]);
    expect(await reaper.step(t(S1))).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(await reaper.step(t(S2))).toEqual(['slot-0.unconfirmed']);
  });
});

describe('settled receipts with lingering active state', () => {
  // Reduced from captured health state: a finished receipt and a live prepare share activeRunIds.
  const capture = {
    v: 1, lastReadAt: S1, failures: 0, backoffUntil: 0, trigger: '',
    telemetry: {
      sampledAtET: iso(S1), activeRuns: 2, activeRunIds: [RUN_DEAD, RUN_LIVE],
      recent: [live, {...dead, startedAtET: iso(NOW - 300_000), stageMs: {install: 4029, run: 1464}, code: 1, prewarmed: false}],
    },
  };
  it.each([0, 1, 255])('classifies settled code %s as finished even while listed active', code => {
    const telemetry = {...capture.telemetry, recent: [live, {...capture.telemetry.recent[1], code}]};
    expect(runVerdict(telemetry, RUN_DEAD)).toBe('finished');
  });
  it('reaps and logs a dead-owner marker older than the finished run after the existing death margin', async () => {
    const logs = [];
    const {file, reaper} = setup(RUN_DEAD, false, line => logs.push(line));
    expect(await reaper.step(async () => ({...capture.telemetry, sampledAtET: iso(NOW + 89_999)}))).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(await reaper.step(async () => capture.telemetry)).toEqual(['slot-0.unconfirmed']);
    expect(existsSync(file)).toBe(false);
    expect(logs.join('')).toContain('reaped stale remote slot marker(s) slot-0.unconfirmed (owner dead; its Forge run is finished (still listed active) or absent)');
  });
  it.each([null, 97, 254])('retains and does not log a reap for active code %s', async code => {
    const logs = [];
    const {file, reaper} = setup(RUN_DEAD, false, line => logs.push(line));
    const telemetry = {...capture.telemetry, recent: [live, {...dead, code}]};
    expect(runVerdict(telemetry, RUN_DEAD)).toBe('inflight');
    await reaper.step(async () => telemetry);
    expect(await reaper.step(async () => ({...telemetry, sampledAtET: iso(S2)}))).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(logs).toEqual([]);
  });
  it.each(['absent with incomplete evidence', 'unreadable'])('retains an old unconfirmable marker: %s', async evidence => {
    const logs = [];
    const {file, reaper} = setup(RUN_DEAD, false, line => logs.push(line));
    const probe = async () => {
      if (evidence === 'unreadable') throw new Error('telemetry unreadable');
      return {sampledAtET: iso(S1), activeRuns: 1, recent: [live]};
    };
    expect(await reaper.step(probe)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(logs).toEqual([]);
  });
});
