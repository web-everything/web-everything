import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciCheckName, collectInputs, extractMetrics, fetchCiRuns, fixOutcome, gateCause, parseMarkers, parseTranscript, percentile, rateMetric, readBounded, runCoroner } from '../coroner-extract.mjs';

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
  env = Object.fromEntries(['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'STATE', 'COORD'].map((key) => [`WE_CORONER_${key}`, join(root, key.toLowerCase())]));
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

describe('coroner error rates (reported first)', () => {
  const marker = (sha, startMin, endMin, extra = {}) => ({ sha, status: 'red', startedAt: at(startMin), finishedAt: at(endMin), suites: 'x', exitCode: 1, ...extra });
  const writeMarkers = (rowsByLane) => Object.entries(rowsByLane).forEach(([lane, row]) => write(join(env.WE_CORONER_LANES, lane, '.git', '.lane-verify'), row));

  it('leads the output with errorRates', () => {
    expect(Object.keys(run().metrics)).toEqual(['window', 'errorRates', ...Object.keys(run().metrics).slice(2)]);
    expect(run().output.startsWith('{"window"')).toBe(true);
    expect(run().output.indexOf('"errorRates"')).toBeLessThan(run().output.indexOf('"sessions"'));
  });

  it('gate runs: splits red into in-diff, flaky-outside-diff, still-red, vitest timeout, killed-superseded and wait-timeout', () => {
    writeMarkers({
      'lane-1': marker('a'.repeat(40), 0, 10),
      'lane-2': marker('b'.repeat(40), 0, 20, { isolatedRetry: 'flaky-outside-diff', retriedFailures: [{ file: 'x', kind: 'assertion' }] }),
      'lane-3': marker('c'.repeat(40), 0, 30, { isolatedRetry: 'still-red' }),
      'lane-4': marker('d'.repeat(40), 1, 11, { retriedTimeouts: ['t.test.mjs'] }),
      'lane-5': marker('e'.repeat(40), 2, 12, { status: 'green' }),
      'lane-6': marker('f'.repeat(40), 3, 13, { status: 'green', isolatedRetry: 'flaky-outside-diff' }),
    });
    write(env.WE_CORONER_VERIFY_LOG, `${at(5)} verify-daemon: tick — dispatched 0\n  ✂ web-everything/lane-3: in-flight run 1 superseded by a newer request — killed\n  ✂ web-everything/lane-3: in-flight run 2 superseded by a newer request — killed\n${at(70)} verify-daemon: tick\n  ✂ web-everything/lane-9: in-flight run 3 superseded by a newer request — killed\n`);
    job('a');
    transcript('a', [use('1', 'node scripts/verify-lane.mjs check --wait', 0), result('1', '{"status":"timeout","reason":"wait-timeout"}', 7)]);
    const g = run().metrics.errorRates.gateRuns;
    expect(g.total).toBe(6 + 2 + 1);
    expect(g.count).toBe(4 + 2 + 1);
    expect(Object.fromEntries(Object.entries(g.causes).map(([k, v]) => [k, v.count]))).toEqual({ 'flaky-outside-diff': 1, 'in-diff-real-failure': 1, 'killed-superseded': 2, 'still-red-after-isolated-retry': 1, 'verify-wait-timeout': 1, 'vitest-timeout': 1 });
    expect(g.flakyRescuedGreen).toBe(1);
    expect(run().metrics.errorRates.notes).toMatchObject({ verifyLogUnstampedLines: 0, ciRunsTruncated: false });
    expect(g.pct).toBe(77.8);
    expect(g.causes['killed-superseded'].examples).toEqual([{ ref: 'web-everything/lane-3', at: at(5) }, { ref: 'web-everything/lane-3', at: at(5) }]);
    expect(g.causes['verify-wait-timeout'].minutes).toBe(7);
    expect(g.causes['still-red-after-isolated-retry'].minutes).toBe(30);
    expect(gateCause({ status: 'red', retriedFailures: [{ kind: 'timeout' }] })).toBe('vitest-timeout');
  });

  it('CI: red by check and by cause class (cancelled, flaky rerun, soak, real), at most two examples, bounded gh calls', () => {
    const wf = (id, name, conclusion, sha, pr, min) => ({ id, name, conclusion, head_sha: sha, pull_requests: pr ? [{ number: pr }] : [], run_attempt: 1, created_at: at(min), updated_at: at(min + 3) });
    const pages = [{ workflow_runs: [
      wf(1, 'CI', 'failure', 'aaa1111', 10, 1), wf(2, 'CI', 'success', 'aaa1111', 10, 9),
      wf(3, 'CI', 'failure', 'bbb2222', 11, 2), wf(4, 'Review gate', 'cancelled', 'ccc3333', 12, 3),
      wf(5, 'Soak replay gate', 'failure', 'ddd4444', 13, 4), wf(6, 'CI', 'success', 'eee5555', 14, 5),
      wf(7, 'Review gate', 'cancelled', 'fff6666', 15, 6), wf(8, 'Review gate', 'cancelled', 'ggg7777', 16, 7),
      wf(9, 'CI', 'failure', 'hhh8888', 17, 80), wf(10, 'Review gate', 'failure', 'iii9999', 18, 8), wf(11, 'CI', 'cancelled', 'jjj1010', 19, 9),
    ] }];
    const jobs = { 1: ['test (2/4)'], 3: ['test (1/4)', 'smoke'], 5: ['soak shard 2'] };
    const calls = [];
    const gh = (args) => {
      if (args[1].includes('/pulls?')) return [];
      calls.push(args[1]);
      const m = args[1].match(/runs\/(\d+)\/jobs/);
      if (m) return { jobs: (jobs[m[1]] ?? []).map((name) => ({ name, conclusion: 'failure' })) };
      return pages.shift() ?? null;
    };
    const ci = run0(gh).metrics.errorRates.ci;
    expect(ci.total).toBe(5);
    expect(ci.count).toBe(2);
    expect(Object.fromEntries(Object.entries(ci.causes).map(([k, v]) => [k, v.count]))).toEqual({ 'real-code-defect': 1, 'soak-scenario': 1 });
    expect(ci.superseded.count).toBe(1);
    expect(ci.flakyRecovered).toBe(1);
    expect(ci.awaitingReview.count).toBe(1);
    expect(Object.fromEntries(Object.entries(ci.byCheck).map(([k, v]) => [k, v.count]))).toEqual({ 'test-shard': 1, 'soak-shard': 1, smoke: 1 });
    expect(ci.redHeads).toBe(2);
    expect(calls.length).toBeLessThanOrEqual(1 + 5);
    expect(fetchCiRuns({ since, until }, null)).toEqual({ runs: [], found: false, calls: 0, truncated: false });
    let n = 0;
    expect(fetchCiRuns({ since, until }, () => (++n, { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i, conclusion: 'success' })) }), { maxPages: 2 })).toMatchObject({ calls: 2, truncated: true });
    expect(ciCheckName('CodeQL / Analyze')).toBe('CodeQL');
    expect(ciCheckName('daemon-soak (1/2)')).toBe('daemon-soak');
  });

  it('fix/ci-heal sessions: outcomes with causes and rounds per PR', () => {
    job('a', 'fix-42', 10, { detail: 'PR 42 fix pushed, re-armed review:pending' });
    job('b', 'fix-42', 20, { detail: 'PR 42: inode fix in tests, gate-red (unrelated timeout)' });
    job('c', 'ci-heal-43', 5, { detail: 'PR 43: no CI break found, heal stood down' });
    job('d', 'ci-heal-44', 8, { detail: 'PR 44 ci-heal: no CI break found; escalated review-gate hold' });
    job('e', 'fix-45', 30, { detail: 'lock race fixed; hold posted for quiet-host reverify' });
    job('f', 'fix-46', 2, { state: 'stopped', detail: 'stopped' });
    job('g', 'fix-47', 2, { state: 'blocked', detail: 'permission denied' });
    job('h', 'build-48', 9, { detail: 'built and pushed' });
    const f = run().metrics.errorRates.fixSessions;
    expect(f.total).toBe(7);
    expect(Object.fromEntries(Object.entries(f.causes).map(([k, v]) => [k, v.count]))).toEqual({ blocked: 1, escalated: 1, 'gate-red-not-pushed': 1, 'load-flake-hold': 1, 'no-op': 1, pushed: 1, 'stopped-without-outcome': 1 });
    expect(f.causes['load-flake-hold'].minutes).toBe(30);
    expect(f.rounds).toEqual({ prs: 6, multiRoundPrs: 1, max: 2, top: [{ pr: 42, rounds: 2 }, { pr: 43, rounds: 1 }, { pr: 44, rounds: 1 }, { pr: 45, rounds: 1 }, { pr: 46, rounds: 1 }] });
    expect(fixOutcome({ state: 'done', detail: 'weird' })).toBe('other');
  });

  it('builder launches: launched / not confirmed / failed / repeated same card, from rows above the normal line cap', () => {
    const row = (min, dispatched, failures, pad = 0) => JSON.stringify({ at: at(min), timings: { totalMs: 1 }, dispatched, failures, pad: 'x'.repeat(pad) });
    write(join(env.WE_CORONER_COORD, 'build-dispatch-daemon.log'), [
      `${at(0)} build-dispatch-daemon: live`,
      row(1, [{ num: '1' }, { num: '2' }], [], 300 * 1024),
      row(3, [], [{ num: '1', stage: 'dispatch', reason: 'dispatch launch not confirmed (missing effect; no running session)' }, { num: '3', stage: 'dispatch', reason: 'Command failed: node run.mjs' }, { num: '9', stage: 'plan', reason: 'x' }]),
      row(5, [], [{ num: '1', stage: 'dispatch', reason: 'dispatch launch not confirmed (x)' }]),
      row(90, [{ num: '4' }], []),
    ].join('\n') + '\n');
    const b = run().metrics.errorRates.builderLaunches;
    expect(b.launched).toBe(2);
    expect(b.total).toBe(5);
    expect(Object.fromEntries(Object.entries(b.causes).map(([k, v]) => [k, v.count]))).toEqual({ 'launch-not-confirmed': 2, failed: 1, 'repeated-same-card': 2 });
    expect(b.repeatedSameCard).toBe(2);
    expect(b.causes['launch-not-confirmed'].examples).toEqual([{ ref: 'card 1', at: at(5) }, { ref: 'card 1', at: at(3) }]);
  });

  it('daemon errors: expands "(repeated N times)" lines, windows by the nearest stamp, counts per source', () => {
    write(join(env.WE_CORONER_DAEMON_DIR, 'review-daemon.log'), [
      `${at(1)} daemon-self-sync: rebuild did not move the clone (concurrent-mover) — ticking on the current code`,
      `${at(9)} (repeated 3 times since ${at(2)}) daemon-self-sync: rebuild did not move the clone (concurrent-mover) — ticking on the current code`,
      `${at(10)} daemon-rebuild: smoke-failed {"x":1}`,
      '  continuation line without a stamp: tick-in-progress',
      `${at(11)} GitHub core API rate limit exceeded for this identity`,
      `${at(12)} error: Command failed: gh pr list --repo chalbert/web-everything`,
      `${at(12)} gh-throttle: GitHub core API rate limit exceeded`,
      `${at(-30)} daemon-self-sync: rebuild did not move the clone (concurrent-mover)`,
      `${at(80)} daemon-self-sync: rebuild did not move the clone (concurrent-mover)`,
    ].join('\n') + '\n');
    write(join(env.WE_CORONER_COORD, 'build-dispatch-daemon.log'), `${at(20)} daemon-rebuild: smoke-slow {"ms":1}\n${at(21)} daemon-rebuild: smoke-fail {"ms":1}\n${at(22)} build: concurrent-mover\n`);
    const d = run().metrics.errorRates.daemonErrors;
    expect(d.concurrentMover.count).toBe(1 + 3 + 1);
    expect(d.concurrentMover.causes['review-daemon'].count).toBe(4);
    expect(d.concurrentMover.causes['build-dispatch'].count).toBe(1);
    expect(d.smokeFailures.count).toBe(2);
    expect(d.smokeFailures.total).toBe(3);
    expect(d.tickInProgress.count).toBe(1);
    expect(d.tickInProgress.causes['review-daemon'].examples).toEqual([{ ref: 'review-daemon', at: at(10) }]);
    expect(d.rateLimit.count).toBe(2);
    expect(d.ghReadFailures.count).toBe(1);
    expect(d.ghReadFailures.causes).toHaveProperty('chalbert/web-everything');
  });

  it('merge conflicts: events per PR opened with minutes, before/after the scoping cutoff', () => {
    env.WE_CORONER_SCOPING_CUTOFF = at(30);
    write(join(env.WE_CORONER_DAEMON_DIR, 'fix-dispatch-daemon.log'), [
      `${at(5)} {"checked":true,"results":[{"num":77,"isConflicting":true,"add":"merge-status:conflicting","remove":[],"newlyDetected":true},{"num":78,"isConflicting":true,"remove":[],"newlyDetected":false}]}`,
      `${at(6)} reconcile: unowned-mechanical-rebase PR #77`,
      `${at(7)} reconcile: scope-overlap with PR #12 — waiting`,
      `${at(40)} fix-dispatch: dispatch-conflict-fix PR #90`,
      `${at(41)} drain: overlap-yield-ready-at later`,
    ].join('\n') + '\n');
    job('a', 'fix-77', 12, { detail: 'PR 77 rebased onto main, conflict resolved', createdAt: at(10) });
    const pulls = [{ number: 1, created_at: at(3) }, { number: 2, created_at: at(20) }, { number: 3, created_at: at(45) }, { number: 4, created_at: at(-60) }];
    const c = run0((args) => args[1].includes('/pulls?') ? pulls : null).metrics.errorRates.mergeConflicts;
    expect(c).toMatchObject({ count: 6, total: 3, prsOpened: 3, eventsPerPr: 2, minutes: 2 });
    expect(Object.fromEntries(Object.entries(c.causes).map(([k, v]) => [k, v.count]))).toEqual({ 'conflict-fix-round': 1, 'conflict-fix-session': 1, 'drain-overlap-yield': 1, 'mechanical-rebase': 1, 'newly-conflicting-pr': 1, 'scope-overlap-wait': 1 });
    expect(c.causes['newly-conflicting-pr'].examples).toEqual([{ ref: 'PR #77', at: at(5) }]);
    expect(c.beforeAfter.cutoff).toBe(at(30));
    expect(c.beforeAfter.before).toMatchObject({ count: 4, prsOpened: 2, hours: 0.5 });
    expect(c.beforeAfter.after).toMatchObject({ count: 2, prsOpened: 1 });
  });

  it('rateMetric reports count, total, percent and two examples at most', () => {
    const m = rateMetric([1, 2, 3].map((i) => ({ cause: 'a', ref: `r${i}`, at: at(i) })), 12, 'x');
    expect(m).toMatchObject({ count: 3, total: 12, pct: 25 });
    expect(m.causes.a.examples).toEqual([{ ref: 'r3', at: at(3) }, { ref: 'r2', at: at(2) }]);
  });
});

function run0(gh) { return runCoroner([`--since=${since}`, '--json', '--no-save'], { env, home: root, now: until, gh }); }
