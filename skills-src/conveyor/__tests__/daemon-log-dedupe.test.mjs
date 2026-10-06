/** Item 68b — collapse identical repeated daemon log lines, rotate by size, keep every health reader exact. */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDaemonLog, logSettings, dedupable, rotateLogIfNeeded, createDeduper } from '../daemon-log.mjs';
import { expandRepeatedLines, formatRepeatLine } from '../../../scripts/lib/log-timestamp.mjs';
import { parseDaemonLog } from '../../../scripts/conveyor/health-watch-core.mjs';
import { foldPrAttempts } from '../../../scripts/conveyor/health-pr-attempts.mjs';
import { liveProcessRefusals } from '../../../scripts/conveyor/health-smells/live-process-stale-transcript.mjs';
import { probeDaemonLogs } from '../../../scripts/conveyor/health-watch.mjs';
import { collectInputs } from '../../../scripts/operations/coroner-extract.mjs';
import { spawnPassOnce } from '../pass-daemon.mjs';

function run(ticks, { env = {}, line = (i) => `fix-dispatch-daemon: reconcile-refused missing-run web-everything/web-everything PR #9 — no run` } = {}) {
  const out = [];
  let t = Date.parse('2026-10-06T10:00:00.000Z');
  const c = { log: (s) => out.push(s), info: (s) => out.push(s), warn: (s) => out.push(s), error: (s) => out.push(s) };
  const restore = installDaemonLog({ target: c, env, now: () => new Date(t), logPath: null, timers: false });
  for (let i = 0; i < ticks; i++) {
    c.log('fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 0, refused 1');
    c.log(line(i));
    t += 1000;
  }
  return { out, restore, text: () => out.join('\n') };
}

describe('de-duplication', () => {
  it('100 identical refusal ticks produce <= 5 lines, and every reader still counts 100', () => {
    const r = run(100);
    r.restore(); // drain the pending repeat summaries
    expect(r.out.length).toBeLessThanOrEqual(5);
    expect(r.out.some((l) => /\(repeated 99 times since /.test(l))).toBe(true);
    const text = r.text();
    expect(parseDaemonLog(text).ticks).toHaveLength(100);
    const now = Date.parse('2026-10-06T10:05:00.000Z');
    const rows = foldPrAttempts([], { text, mtimeMs: now }, now, 60000);
    expect(rows.filter((x) => x.pr === 'web-everything/web-everything#9')).toHaveLength(100);
    // same answer as the un-deduped log
    const plain = run(100, { env: { WE_DAEMON_LOG_DEDUPE_WINDOW_MS: '0' } });
    expect(plain.out).toHaveLength(200);
    expect(foldPrAttempts([], { text: plain.text(), mtimeMs: now }, now, 60000)).toHaveLength(rows.length);
  });
  it('live-process refusals keep their per-line count', () => {
    const r = run(30, { line: () => 'fix-dispatch-daemon: reconcile-refused live-process web-everything/web-everything PR #8 — pid live' });
    r.restore();
    expect(liveProcessRefusals([{ text: r.text() }])).toEqual([{ repo: 'web-everything/web-everything', pr: 8, count: 30 }]);
  });
  it('flushes a summary when the window ends, then logs the line in full again', () => {
    const d = createDeduper({ windowMs: 1000 });
    expect(d.consider('a', 0)).toBe(true);
    expect(d.consider('a', 10)).toBe(false);
    expect(d.consider('a', 20)).toBe(false);
    expect(d.due(500)).toEqual([]);
    expect(d.due(1000)).toEqual([{ line: 'a', count: 2, since: 0 }]);
    expect(d.consider('a', 1001)).toBe(true);
  });
  it('only collapses single plain lines', () => {
    expect(dedupable('x: y')).toBe(true);
    expect(dedupable('a\nb')).toBe(false);
    expect(dedupable('  "k": 1,')).toBe(false);
    expect(dedupable('}')).toBe(false);
  });
  it('settings have safe defaults and reject junk', () => {
    expect(logSettings({})).toMatchObject({ dedupeWindowMs: 600000, maxBytes: 20 * 1024 * 1024, keep: 2 });
    expect(logSettings({ WE_DAEMON_LOG_MAX_BYTES: 'abc', WE_DAEMON_LOG_KEEP: '0' })).toMatchObject({ maxBytes: 20 * 1024 * 1024, keep: 1 });
  });
  it('expandRepeatedLines is exact and leaves plain logs byte-identical', () => {
    const plain = 'a: 1\nb: 2\n';
    expect(expandRepeatedLines(plain)).toBe(plain);
    const rep = formatRepeatLine('a: 1', 3, 0, 5000);
    expect(expandRepeatedLines(`a: 1\n${rep}\nb: 2`).split('\n')).toEqual(['a: 1', 'a: 1', 'a: 1', 'a: 1', 'b: 2']);
  });
});

describe('rotation', () => {
  it('copy-truncates over maxBytes and keeps only `keep` rotated files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    const p = join(dir, 'd.log');
    for (let i = 1; i <= 4; i++) {
      writeFileSync(p, `gen${i}\n${'x'.repeat(100)}\n`);
      expect(rotateLogIfNeeded(p, { maxBytes: 50, keep: 2 })).toBe(true);
      expect(statSync(p).size).toBe(0);
    }
    expect(readdirSync(dir).sort()).toEqual(['d.log', 'd.log.1', 'd.log.2']);
    expect(readFileSync(`${p}.1`, 'utf8')).toMatch(/^gen4/);
    expect(readFileSync(`${p}.2`, 'utf8')).toMatch(/^gen3/);
    writeFileSync(p, 'small');
    expect(rotateLogIfNeeded(p, { maxBytes: 50, keep: 2 })).toBe(false);
  });
  it('the installed wrapper rotates the daemon log when it grows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot2-'));
    const p = join(dir, 'd.log');
    writeFileSync(p, 'y'.repeat(500));
    let t = 1_000_000;
    const c = { log() {}, info() {}, warn() {}, error() {} };
    const restore = installDaemonLog({ target: c, env: { WE_DAEMON_LOG_MAX_BYTES: '100' }, now: () => new Date(t), logPath: p, timers: false });
    c.log('d: hello');
    restore();
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(statSync(p).size).toBe(0);
  });
});

describe('readers see rotated + deduped logs', () => {
  it('probeDaemonLogs reads the unread tail of <log>.1 after a rotation, then the fresh file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    const p = join(dir, 'review-daemon.log');
    writeFileSync(p, `review-daemon: tick (a) — dispatched 0, refused 0\n${'review-daemon: filler\n'.repeat(20)}`);
    const first = probeDaemonLogs(dir, {});
    appendFileSync(p, `review-daemon: tick (a) — dispatched 0, refused 1\nreview-daemon: reconcile-refused missing-run o/r PR #5 — no run\n${'review-daemon: filler\n'.repeat(20)}`);
    rotateLogIfNeeded(p, { maxBytes: 10, keep: 2 });
    appendFileSync(p, `${formatRepeatLine('review-daemon: tick (a) — dispatched 0, refused 0', 4, 0)}\n`);
    const second = probeDaemonLogs(dir, first.cursors);
    const text = second.samples[0].text;
    expect(second.samples[0].bootstrap).toBe(false);
    expect(parseDaemonLog(text).ticks).toHaveLength(1 + 4);
    expect(text).toMatch(/PR #5/);
  });
  it('coroner collectInputs reads <log>.1 and replays repeats', () => {
    const root = mkdtempSync(join(tmpdir(), 'cor-'));
    const daemon = join(root, 'daemon'); mkdirSync(daemon);
    const env = { WE_CORONER_JOBS: join(root, 'j'), WE_CORONER_JOBS_ARCHIVE: join(root, 'a'), WE_CORONER_PROJECTS: join(root, 'p'),
      WE_CORONER_DAEMON_DIR: daemon, WE_CORONER_VERIFY_LOG: join(root, 'verify.log'), WE_CORONER_ADMISSION: join(root, 'adm'), WE_CORONER_LANES: join(root, 'l') };
    writeFileSync(join(daemon, 'fix-dispatch-daemon.log.1'), 'fix-dispatch-daemon: reconcile-refused missing-run o/r PR #5 — old\n');
    writeFileSync(join(daemon, 'fix-dispatch-daemon.log'), `${formatRepeatLine('fix-dispatch-daemon: reconcile-refused missing-run o/r PR #5 — new', 3, 0)}\n`);
    writeFileSync(env.WE_CORONER_VERIFY_LOG, `${formatRepeatLine('verify-daemon: SIGTERM', 2, 0)}\n`);
    const inputs = collectInputs({ since: '2026-10-01T00:00:00.000Z', until: '2026-10-07T00:00:00.000Z' }, { env, home: root });
    expect(inputs.refusalLines.filter((l) => /PR #5/.test(l))).toHaveLength(1 + 3);
    expect(inputs.verifyLines).toHaveLength(2);
  });
});

describe('pass-daemon relays child output through its own log', () => {
  it('pipes the child and writes each line (and a trailing partial line) via log', async () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const spawnFn = (_n, _a, opts) => { expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']); setImmediate(() => { child.stdout.emit('data', 'one\ntw'); child.stdout.emit('data', 'o\nlast'); child.stderr.emit('data', 'err\n'); child.emit('exit', 0, null); }); return child; };
    const seen = [];
    await spawnPassOnce({ script: 'x.mjs' }, { root: '/r', spawnFn, log: { log: (l) => seen.push(['o', l]), error: (l) => seen.push(['e', l]) } });
    expect(seen).toEqual([['o', 'one'], ['o', 'two'], ['e', 'err'], ['o', 'last']]);
  });
});
