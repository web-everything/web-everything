import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectInputs, extractMetrics, parseMarkers, parseTranscript, percentile, readBounded, runCoroner } from '../coroner-extract.mjs';

const since = '2026-10-05T17:00:00.000Z', until = '2026-10-05T18:00:00.000Z';
const at = (minutes) => new Date(Date.parse(since) + minutes * 60000).toISOString();
let root, env;
function write(file, value) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
function ledger(key, name, rows) { return write(join(env[key], name), rows.map((row) => JSON.stringify(row)).join('\n') + '\n'); }
function job(id, name = 'fix-42', duration = 10, extra = {}, archive = '') {
  write(join(archive ? env.WE_CORONER_JOBS_ARCHIVE : env.WE_CORONER_JOBS, archive, id, 'state.json'), { name, sessionId: id, state: 'completed', createdAt: since, updatedAt: at(duration), ...extra });
}
function transcript(id, rows) { return ledger('WE_CORONER_PROJECTS', `project/${id}.jsonl`, rows); }
function use(id, command, time = 0) { return { type: 'assistant', timestamp: at(time), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }; }
function result(id, text, time = 1, is_error = false) { return { type: 'user', timestamp: at(time), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: [{ type: 'text', text }] }] } }; }
const run = (args = []) => runCoroner([`--since=${since}`, '--json', '--no-save', ...args], { env, home: root, now: until });

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'coroner-'));
  env = Object.fromEntries(['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'STATE'].map((key) => [`WE_CORONER_${key}`, join(root, key.toLowerCase())]));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('coroner metrics', () => {
  it('counts sessions by kind, outcomes, window boundaries and PR duration, including both archive layouts', () => {
    job('a', 'ci-heal-42', 10);
    job('b', 'fix-42', 20, { lastTerminalAt: at(15) }, '2026-10-05');
    job('c', 'review-12', 25, { state: 'error' });
    job('d', 'unnumbered', 5, { intent: 'inspect #12' }, '.');
    job('e', 'build-9', 5, { createdAt: until });
    job('f', 'fix-9', 5, { createdAt: at(-1) });
    job('a', 'ci-heal-42', 10, {}, 'duplicate');
    job('fallback', 'build-90', 0, { createdAt: undefined, updatedAt: since });
    const { sessions, topPrs } = run().metrics;
    expect(sessions.count).toBe(5);
    expect(sessions.minutes).toBe(55);
    expect(sessions.medianMin).toBe(10);
    expect(sessions.p90Min).toBe(25);
    expect(sessions.byKind).toEqual({ build: { count: 1, minutes: 0 }, 'ci-heal': { count: 1, minutes: 10 }, fix: { count: 1, minutes: 15 }, other: { count: 1, minutes: 5 }, review: { count: 1, minutes: 25 } });
    expect(sessions.outcomes).toEqual({ completed: 4, failed: 1 });
    expect(topPrs).toEqual([{ pr: 12, sessions: 2, minutes: 30 }, { pr: 42, sessions: 2, minutes: 25 }, { pr: 90, sessions: 1, minutes: 0 }]);
  });

  it('joins gate durations and computes share, nearest-rank median/p90 and wait timeouts', () => {
    job('a');
    transcript('a', [use('1', 'npm run test:unit'), use('2', 'node scripts/verify-lane.mjs check', 1), result('2', 'timed out waiting', 4), result('1', 'ok', 1), use('3', 'npx vitest run', 4), result('3', 'wait ceiling', 6), use('4', 'npm run check:standards', 7), use('5', 'echo hi'), result('5', 'ok')]);
    expect(run().metrics.gate).toEqual({ minutesInGate: 6, shareInGate: 0.6, commands: 4, medianMin: 3, p90Min: 3, allCommands: { count: 3, minutes: 6, medianMin: 2, p90Min: 3 }, verifyLane: { calls: 1, medianMin: 3, p90Min: 3, waitTimeouts: 1 }, directVitest: { runs: 1, minutes: 2 }, waitTimeouts: 2, waitTimeoutSessions: 1, waitTimeoutMinutes: 5 });
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([], 0.9)).toBe(0);
  });

  it('classifies denial results by type and retains the last assistant text', () => {
    job('a');
    transcript('a', [result('1', 'Blocked by hook'), result('2', 'classifier denied', 1, true), result('3', 'Refusing: unsafe'), result('4', 'permission to use Bash'), result('5', 'not allowed by classifier'), { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier' }, { type: 'text', text: 'final'.repeat(80) }] } }]);
    const metrics = run().metrics;
    expect(metrics.denials).toEqual({ byType: { 'classifier-denied': 2, 'hook-blocked': 1, 'user-denied': 1, refusing: 1 }, total: 5 });
    expect(metrics.sessions.records[0].outcomeLine).toBe('final'.repeat(32));
  });

  it('detects normalized repeated commands, sorted with a ten-row limit', () => {
    job('a');
    transcript('a', Array.from({ length: 12 }, (_, i) => Array.from({ length: 3 }, (_, j) => use(`${i}-${j}`, `echo  ${i} ${'x'.repeat(250)}\n`))).flat());
    const { loops } = run().metrics;
    expect(loops.count).toBe(12);
    expect(loops.top).toHaveLength(10);
    expect(loops.top[0]).toEqual({ session: 'a', command: `echo 0 ${'x'.repeat(250)}`.slice(0, 200), count: 3 });
  });

  it('counts verify daemon events in the bounded tail', () => {
    env.WE_CORONER_LOG_TAIL = '512';
    write(env.WE_CORONER_VERIFY_LOG, `verify-daemon: SIGTERM\n${'x'.repeat(800)}\n dispatching verify for lane-1\ndispatching verify for lane-2\nsuperseded by a newer request\nverify worker exited with code null\nverify-daemon: loop stopped (code-changed)\nverify-daemon: SIGTERM\nSIGTERM\ngate start\nnot superseded\n`);
    expect(run().metrics.verifyDaemon).toEqual({ starts: 2, superseded: 1, codeNull: 1, codeChanged: 1, sigterm: 1, note: 'untimestamped log tail window' });
    expect(run().metrics.sources.verifyDaemon.windowed).toBe(false);
  });

  it('ranks real refusal tokens and the ten most refused PRs', () => {
    write(join(env.WE_CORONER_DAEMON_DIR, 'fix-dispatch-daemon.log'), [
      'reconcile-fix-dispatch-daemon: reconcile-refused fix-claimed web-everything/web-everything PR #3990 — held',
      'reconcile-fix-dispatch-daemon: refused own-failure web-everything/web-everything PR #3990 — failed',
      ...Array.from({ length: 11 }, (_, i) => `reconcile-refused fix-claimed PR #${4000 + i}`),
      'refused',
      'reconcile-fix-dispatch-daemon: tick () — dispatched 0, refused 0',
      'reconcile-fix-dispatch-daemon: tick (repo) — dispatched 4, refused 9',
      'review-dispatch: running last-known-good, not refusing (abc)',
    ].join('\n'));
    const metrics = run().metrics;
    expect(metrics.refusalReasons).toEqual([{ reason: 'fix-claimed', count: 12 }, { reason: 'own-failure', count: 1 }, { reason: 'unparsed', count: 1 }]);
    expect(metrics.refusalByPr).toEqual([{ pr: 3990, count: 2 }, ...Array.from({ length: 9 }, (_, i) => ({ pr: 4000 + i, count: 1 }))]);
  });

  it('summarizes admission slot holds, reaped reasons and waiter minutes within the window', () => {
    ledger('WE_CORONER_ADMISSION', 'durations.jsonl', [{ kind: 'FULL', ms: 60000, at: since }, { kind: 'FULL', ms: 180000, at: at(2) }, { kind: 'selected', ms: 30000, at: at(3) }, { kind: 'FULL', ms: 999999, at: until }, { kind: 'bad', ms: -1, at: since }]);
    ledger('WE_CORONER_ADMISSION', 'reaped.jsonl', [{ reason: 'pid-dead', requestedAt: since, reapedAt: at(2) }, { reason: 'no-lease', requestedAt: since, reapedAt: at(4) }, { reason: 'late', requestedAt: since, reapedAt: until }]);
    expect(run().metrics.admission).toEqual({ waitMedianSec: 0, waitP90Sec: 0, markers: { count: 0, byMode: {}, gateMedianSec: 0, gateP90Sec: 0, vitestMedianSec: 0, standardsMedianSec: 0 }, holdsByKind: { FULL: { count: 2, minutes: 4, medianMin: 1, p90Min: 3 }, selected: { count: 1, minutes: 0.5, medianMin: 0.5, p90Min: 0.5 } }, reaped: { waiterMedianSec: 120, waiterP90Sec: 240, byReason: { 'no-lease': 1, 'pid-dead': 1 }, waiterMinutes: 6 } });
  });

  it('reads both bounded .git markers, dedupes sha+startedAt and windows only by finishedAt', () => {
    const marker = { sha: 'abc', status: 'passed', startedAt: at(-10), finishedAt: at(2), phases: { admissionMode: 'phase', admissionWaitMs: 0, gateMs: 60000, vitestMs: 20000, standardsMs: 10000 } };
    write(join(env.WE_CORONER_LANES, 'lane-1/.git/.lane-verify'), JSON.stringify(marker, null, 2));
    write(join(env.WE_CORONER_LANES, 'lane-1/.git/.lane-verify.previous'), marker);
    write(join(env.WE_CORONER_LANES, 'lane-2/.git/.lane-verify.previous'), { ...marker, startedAt: at(1), phases: { admissionMode: 'gate', admissionWaitMs: 136000, gateMs: 180000, vitestMs: 40000, standardsMs: 30000 } });
    write(join(env.WE_CORONER_LANES, 'lane-2/.lane-verify'), { ...marker, sha: 'wrong', phases: { admissionWaitMs: 999999 } });
    write(join(env.WE_CORONER_LANES, 'lane-3/.git/.lane-verify'), { ...marker, sha: 'late', finishedAt: until });
    write(join(env.WE_CORONER_LANES, 'lane-3/.git/.lane-verify.previous'), { ...marker, sha: 'unfinished', finishedAt: undefined, startedAt: since });
    const oversized = write(join(env.WE_CORONER_LANES, 'lane-4/.git/.lane-verify'), { ...marker, padding: 'x'.repeat(70000) });
    expect(readBounded(oversized, { cap: 65536 }).bytesRead).toBe(65536);
    const { admission, sources } = run().metrics;
    expect(admission.waitMedianSec).toBe(0);
    expect(admission.waitP90Sec).toBe(136);
    expect(admission.markers).toEqual({ count: 2, byMode: { gate: 1, phase: 1 }, gateMedianSec: 60, gateP90Sec: 180, vitestMedianSec: 20, standardsMedianSec: 10 });
    expect(sources.lanes.count).toBe(6);
    expect(parseMarkers(['null', 'garbage', '[]'])).toEqual([]);
  });

  it('excludes successful prose and limits denial evidence to the first 300 characters', () => {
    const denied = [result('a', '  BLOCKED by hook'), result('b', "The user doesn't want this"), result('c', 'Error: request denied'), result('d', 'Bash was denied by auto mode'), result('e', 'PreToolUse hook blocked this')];
    const harmless = [result('f', 'Read the file: Blocked by hook'), result('g', 'classifier denied'), result('h', 'test failed', 1, true), result('i', 'x'.repeat(300) + ' denied', 1, true), result('j', 'ok\nBlocked later')];
    expect(parseTranscript([...denied, ...harmless]).denials).toEqual({ 'classifier-denied': 1, 'hook-blocked': 2, other: 1, 'user-denied': 1 });
  });

  it('counts invocations without counting echo, grep or sed file references', () => {
    const real = ['node scripts/verify-lane.mjs check --wait=60', './scripts/verify-lane.mjs request', 'vitest run foo', 'npx vitest related foo', 'npm run test:unit -- foo', 'npm run check:standards', 'cd /tmp && node "scripts/verify-lane.mjs" run', 'node scripts/readiness/heavy-admission.mjs run -- npx vitest run foo', 'timeout 500 npx vitest run foo'];
    const fake = ['echo "node scripts/verify-lane.mjs check"', 'grep verify-lane.mjs scripts/verify-lane.mjs', "sed -n '1,40p' scripts/verify-lane.mjs", 'echo "vitest run; npm run test:unit"', 'cat tests/vitest.test.ts', 'echo npm run check:standards', 'cat <<EOF\nnode scripts/verify-lane.mjs check\nvitest run\nEOF', '# documentation; node scripts/verify-lane.mjs check'];
    const entries = [...real, ...fake].flatMap((cmd, i) => [use(String(i), cmd), result(String(i), 'ok', 2)]);
    job('a'); transcript('a', entries);
    const { gate } = run().metrics;
    expect(gate.commands).toBe(9);
    expect(gate.verifyLane.calls).toBe(3);
    expect(gate.directVitest).toEqual({ runs: 4, minutes: 8 });
  });

  it('matches real verify-lane timeout reason and status variants once per call and session', () => {
    job('a');
    transcript('a', [use('1', 'node scripts/verify-lane.mjs check --wait=60'), result('1', JSON.stringify({ status: 'timeout', reason: 'wait-timeout', ok: false, detail: 'still not settled after waiting 60000ms (ceiling 60000ms)' })), use('2', 'node scripts/verify-lane.mjs check'), result('2', '{"status":"wait-timeout"}')]);
    expect(run().metrics.gate).toMatchObject({ waitTimeouts: 2, waitTimeoutSessions: 1, verifyLane: { waitTimeouts: 2 } });
  });

  it('caps compact session records at 60, sorted by minutes then session', () => {
    for (let i = 0; i < 62; i++) job(`id-${String(i).padStart(2, '0')}`, 'fix-42', Math.floor(i / 2));
    transcript('id-60', [use('x', 'echo hi'), { type: 'assistant', message: { content: [{ type: 'text', text: '  done \n  '.repeat(100) }] } }]);
    const { records, count } = run().metrics.sessions;
    expect(count).toBe(62);
    expect(records).toHaveLength(60);
    expect(records[0]).toEqual({ session: 'id-60', name: 'fix-42', kind: 'fix', pr: 42, outcome: 'completed', minutes: 30, truncated: false, outcomeLine: 'done '.repeat(32) });
    expect(records[1].session).toBe('id-61');
    expect(records.at(-1).session).toBe('id-03');
    expect(records.every((record) => !('commands' in record))).toBe(true);
  });

  it('is byte deterministic, including shuffled core inputs and missing sources', () => {
    job('z', 'fix-2'); job('a', 'fix-1');
    expect(run().output).toBe(run().output);
    const inputs = collectInputs({ since, until }, { env, home: root });
    expect(JSON.stringify(extractMetrics(inputs))).toBe(JSON.stringify(extractMetrics({ ...inputs, sessions: [...inputs.sessions].reverse() })));
    expect(run().metrics.sources.projects).toEqual({ found: false, count: 0 });
    expect(run().metrics.gate.shareInGate).toBe(0);
    expect(runCoroner([`--since=${since}`, '--no-save'], { env, home: root, now: until }).output).toContain('gate.minutesInGate  0');
  });

  it('round-trips --since=last atomically and respects --no-save and explicit --state', () => {
    const invoke = (args, now = until) => runCoroner(args, { env, home: root, now });
    expect(() => invoke(['--since=last'])).toThrow('no previous run; pass an ISO --since');
    const rename = vi.spyOn(fs, 'renameSync');
    invoke([`--since=${since}`]);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(env.WE_CORONER_STATE, 'utf8'))).toEqual({ lastEnd: until });
    const next = at(120);
    expect(invoke(['--since=last', '--no-save'], next).metrics.window).toEqual({ since: until, until: next });
    expect(JSON.parse(fs.readFileSync(env.WE_CORONER_STATE, 'utf8')).lastEnd).toBe(until);
    invoke(['--since=last'], next);
    expect(JSON.parse(fs.readFileSync(env.WE_CORONER_STATE, 'utf8')).lastEnd).toBe(next);
    const explicit = join(root, 'custom-state');
    invoke([`--since=${since}`, `--state=${explicit}`, `--until=${at(1)}`]);
    expect(JSON.parse(fs.readFileSync(explicit, 'utf8')).lastEnd).toBe(at(1));
    expect(() => invoke(['--since=bad'])).toThrow('valid ISO');
  });

  it('strictly caps transcript bytes using real fd reads and retains head/tail records', () => {
    const cap = 4096;
    env.WE_CORONER_TRANSCRIPT_CAP = String(cap);
    job('a');
    const file = transcript('a', [use('first', 'echo head')]);
    const fd = fs.openSync(file, 'a');
    try { for (let i = 0; i < 300; i++) fs.writeSync(fd, JSON.stringify({ padding: 'x'.repeat(100) }) + '\n'); fs.writeSync(fd, JSON.stringify(use('last', 'echo tail')) + '\n'); }
    finally { fs.closeSync(fd); }
    const originalOpen = fs.openSync.bind(fs), originalRead = fs.readSync.bind(fs);
    let transcriptFd, observed = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((path, ...args) => { const fd = originalOpen(path, ...args); if (path === file) transcriptFd = fd; return fd; });
    vi.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => { const n = originalRead(fd, ...args); if (fd === transcriptFd) observed += n; return n; });
    // Probe the isolated reader so reused descriptors for other files cannot inflate the spy.
    const data = readBounded(file, { cap });
    expect(fs.statSync(file).size).toBeGreaterThan(3 * cap);
    expect(data.bytesRead).toBe(cap);
    expect(observed).toBe(cap);
    expect(data.truncated).toBe(true);
    vi.restoreAllMocks();
    const metrics = run().metrics;
    expect(metrics.truncation).toEqual({ transcriptsTruncated: 1, bytesRead: cap });
    expect(metrics.sessions.records[0].truncated).toBe(true);
    expect(parseTranscript(data.lines.map(JSON.parse)).commands).toEqual(['echo head', 'echo tail']);
  });

  it('skips oversized lines, does not parse partial tail lines, and prefers linkScanPath', () => {
    job('a', 'fix-42', 10, { linkScanPath: join(root, 'linked.jsonl') });
    transcript('a', [use('wrong', 'echo wrong')]);
    write(join(root, 'linked.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'big', name: 'Bash', input: { command: 'x'.repeat(270000) } }] } }) + '\n' + JSON.stringify(use('small', 'echo small')));
    expect(parseTranscript(collectInputs({ since, until }, { env, home: root }).sessions[0].transcript.entries).commands).toEqual(['echo small']);
    const file = write(join(root, 'partial'), 'head\nxxxxxxxxx{"valid":true}\ntail\n');
    expect(readBounded(file, { cap: 28 }).lines).toEqual(['head', 'tail']);
  });
});
