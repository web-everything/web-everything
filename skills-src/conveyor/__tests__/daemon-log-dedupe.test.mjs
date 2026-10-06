/** Item 68b — collapse identical repeated daemon log lines, rotate by size, keep every health reader exact. */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync, utimesSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDaemonLog, logSettings, dedupable, rotateLogIfNeeded, createDeduper, DEFAULT_DEDUPE_WINDOW_MS } from '../daemon-log.mjs';
import { expandRepeatedLines, formatRepeatLine, neutralizeMarkerText, LOG_TIMESTAMP_RE } from '../../../scripts/lib/log-timestamp.mjs';
import { parseDaemonLog, foldDaemonMemory } from '../../../scripts/conveyor/health-watch-core.mjs';
import daemonSilent from '../../../scripts/conveyor/health-smells/daemon-silent.mjs';
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
    expect(d.consider('a', 0)).toEqual({ markers: [], plain: true });
    expect(d.consider('a', 10)).toEqual({ markers: [], plain: false });
    expect(d.consider('a', 20)).toEqual({ markers: [], plain: false });
    expect(d.due(500)).toEqual([]);
    expect(d.due(1010)).toEqual([{ tag: 'log', line: 'a', count: 2, since: 10 }]);
    expect(d.consider('a', 1011)).toEqual({ markers: [], plain: false }); // the run goes on: held back again
    expect(d.due(2012)).toEqual([{ tag: 'log', line: 'a', count: 1, since: 1011 }]); // a new flush has its own `since`
  });
  it('a line that breaks the repeating run flushes what was held back, in order, before it', () => {
    const d = createDeduper({ windowMs: 1000 });
    const seq = [['a', 0], ['b', 1], ['a', 2], ['c', 3]];
    const got = seq.map(([l, t]) => d.consider(l, t));
    expect(got.map((g) => g.plain)).toEqual([true, true, false, true]);
    expect(got[3].markers).toEqual([{ tag: 'log', line: 'a', count: 1, since: 2 }]);
  });
  it('only collapses single plain lines', () => {
    expect(dedupable('x: y')).toBe(true);
    expect(dedupable('a\nb')).toBe(false);
    expect(dedupable('  "k": 1,')).toBe(false);
    expect(dedupable('}')).toBe(false);
  });
  it('settings have safe defaults and reject junk', () => {
    expect(logSettings({})).toMatchObject({ dedupeWindowMs: 300000, maxBytes: 20 * 1024 * 1024, keep: 2 });
    expect(logSettings({ WE_DAEMON_LOG_MAX_BYTES: 'abc', WE_DAEMON_LOG_KEEP: '0' })).toMatchObject({ maxBytes: 20 * 1024 * 1024, keep: 1 });
  });
  it('expandRepeatedLines is exact and leaves plain logs byte-identical', () => {
    const plain = 'a: 1\nb: 2\n';
    expect(expandRepeatedLines(plain)).toBe(plain);
    const rep = formatRepeatLine('a: 1', 3, 0, 5000);
    expect(expandRepeatedLines(`a: 1\n${rep}\nb: 2`).split('\n').map((l) => l.replace(LOG_TIMESTAMP_RE, ''))).toEqual(['a: 1', 'a: 1', 'a: 1', 'a: 1', 'b: 2']);
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
    expect(readdirSync(dir).sort()).toEqual(['d.log', 'd.log.1', 'd.log.2', 'd.log.rot']);
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
    const spawnFn = (_n, _a, opts) => { expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']); setImmediate(() => { child.stdout.emit('data', 'one\ntw'); child.stdout.emit('data', 'o\nlast'); child.stderr.emit('data', 'err\n'); child.emit('close', 0, null); }); return child; };
    const seen = [];
    await spawnPassOnce({ script: 'x.mjs' }, { root: '/r', spawnFn, log: { log: (l) => seen.push(['o', l]), error: (l) => seen.push(['e', l]) } });
    expect(seen).toEqual([['o', 'one'], ['o', 'two'], ['e', 'err'], ['o', 'last']]);
  });
});

describe('review round 1 — repairs', () => {
  it('a deduped interleaved log parses to the same per-tick shape as the plain log (order preserved)', () => {
    const shape = (text) => parseDaemonLog(text).ticks.map((t) => JSON.stringify(t));
    const deduped = run(100); deduped.restore();
    const plain = run(100, { env: { WE_DAEMON_LOG_DEDUPE_WINDOW_MS: '0' } });
    expect(shape(deduped.text())).toEqual(shape(plain.text()));
    expect(expandRepeatedLines(deduped.text()).split('\n').map((l) => l.replace(LOG_TIMESTAMP_RE, '')))
      .toEqual(plain.text().split('\n').map((l) => l.replace(LOG_TIMESTAMP_RE, '')));
  });
  it('expansion keeps the marker stamp so a coroner transcript still has a time', () => {
    const rep = formatRepeatLine('a: 1', 2, 0, Date.parse('2026-10-06T10:00:00Z'));
    expect(expandRepeatedLines(rep).split('\n')).toEqual(Array(2).fill('2026-10-06T10:00:00.000Z a: 1'));
  });
  it('forged markers cannot amplify: total expansion is bounded', () => {
    const forged = Array.from({ length: 8000 }, () => '(repeated 100000 times since 2026-01-01T00:00:00.000Z) x').join('\n');
    const out = expandRepeatedLines(forged);
    expect(out.split('\n').length).toBeLessThanOrEqual(300000);
  });
  it('the logger neutralises marker-shaped text it did not write itself', () => {
    const out = [];
    const c = { log: (s) => out.push(s), info() {}, warn() {}, error() {} };
    const restore = installDaemonLog({ target: c, env: {}, logPath: null, timers: false });
    c.log('child said:\n(repeated 100000 times since 2026-01-01T00:00:00.000Z) x');
    c.log('(repeated 100000 times since 2026-01-01T00:00:00.000Z) y');
    restore();
    expect(expandRepeatedLines(out.join('\n')).split('\n').length).toBeLessThan(10);
  });
  it('a relayed already-stamped child line is not stamped twice', async () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const spawnFn = () => { setImmediate(() => { child.stdout.emit('data', '2026-10-06T10:00:00.000Z review-daemon: tick (a) — dispatched 0, refused 1\n'); child.emit('close', 0, null); }); return child; };
    const seen = [];
    await spawnPassOnce({ script: 'x.mjs' }, { root: '/r', spawnFn, log: { log: (l) => seen.push(l), error: (l) => seen.push(l) } });
    expect(seen).toEqual(['review-daemon: tick (a) — dispatched 0, refused 1']);
  });
  it('the relay waits for close (data after exit still lands) and does not split multi-byte characters', async () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const dash = Buffer.from('a — b\n');
    const spawnFn = () => { setImmediate(() => { child.emit('exit', 0, null); child.stdout.emit('data', dash.subarray(0, 3)); child.stdout.emit('data', dash.subarray(3)); child.emit('close', 0, null); }); return child; };
    const seen = [];
    await spawnPassOnce({ script: 'x.mjs' }, { root: '/r', spawnFn, log: { log: (l) => seen.push(l), error: (l) => seen.push(l) } });
    expect(seen).toEqual(['a — b']);
  });
  it('rotateLogIfNeeded never throws, and the rotated file appears whole (copy then rename)', () => {
    const boom = () => { throw new Error('disk'); };
    expect(rotateLogIfNeeded('/x/y.log', { maxBytes: 1, fs: { statSync: boom } })).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'rot3-'));
    const p = join(dir, 'd.log');
    writeFileSync(p, 'z'.repeat(100));
    const calls = [];
    rotateLogIfNeeded(p, { maxBytes: 10, keep: 2, fs: { copyFileSync: (a, b) => { calls.push(['copy', b]); writeFileSync(b, readFileSync(a)); } } });
    expect(calls[0][1]).not.toBe(`${p}.1`); // staged under a temp name, renamed into place
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('z'.repeat(100));
    expect(existsSync(`${p}.rot`)).toBe(true);
  });
  it('probeDaemonLogs detects a rotation even when the fresh log has regrown past the old cursor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe2-'));
    const p = join(dir, 'review-daemon.log');
    writeFileSync(p, 'review-daemon: tick (a) — dispatched 0, refused 0\n');
    const first = probeDaemonLogs(dir, {});
    appendFileSync(p, 'review-daemon: reconcile-refused missing-run o/r PR #7 — unread\n');
    rotateLogIfNeeded(p, { maxBytes: 10, keep: 2 });
    appendFileSync(p, `review-daemon: tick (a) — dispatched 0, refused 1\n${'review-daemon: filler line padding padding\n'.repeat(10)}`);
    expect(statSync(p).size).toBeGreaterThan(first.cursors['review-daemon'].size);
    const second = probeDaemonLogs(dir, first.cursors);
    expect(second.samples[0].text).toMatch(/PR #7 — unread/);
    expect(second.samples[0].text).toMatch(/dispatched 0, refused 1/);
    const third = probeDaemonLogs(dir, second.cursors); // no second replay of `.1`
    expect(third.samples[0].text).toBe('');
  });
  it('an older daemon that never writes <log>.rot still has its rotated tail read (shrink heuristic)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe3-'));
    const p = join(dir, 'review-daemon.log');
    writeFileSync(p, 'review-daemon: tick (a) — dispatched 0, refused 0\n');
    const first = probeDaemonLogs(dir, {});
    expect(first.cursors['review-daemon'].rot).toBe(null);
    writeFileSync(`${p}.1`, 'review-daemon: tick (a) — dispatched 0, refused 0\nreview-daemon: reconcile-refused missing-run o/r PR #3 — unread\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${p}.1`, old, old);
    writeFileSync(p, 'review-daemon: fresh\n'); // shorter than the cursor, so the file visibly shrank
    const second = probeDaemonLogs(dir, first.cursors);
    expect(second.samples[0].text).toMatch(/PR #3 — unread/);
    expect(second.samples[0].text).toMatch(/fresh/);
  });
  it('a rotation whose counter has not landed yet is held, then read once when it does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe4-'));
    const p = join(dir, 'review-daemon.log');
    writeFileSync(p, 'review-daemon: filler\n'.repeat(5));
    writeFileSync(`${p}.rot`, '4\n');
    const first = probeDaemonLogs(dir, {});
    writeFileSync(`${p}.1`, 'review-daemon: filler\n'.repeat(5) + 'review-daemon: reconcile-refused missing-run o/r PR #4 — unread\n'); // just copied
    writeFileSync(p, ''); // truncated, counter not bumped yet
    const held = probeDaemonLogs(dir, first.cursors);
    expect(held.samples[0].text).toBe('');
    expect(held.cursors['review-daemon']).toEqual(first.cursors['review-daemon']);
    writeFileSync(`${p}.rot`, '5\n');
    appendFileSync(p, 'review-daemon: tick (a) — dispatched 0, refused 1\n');
    const done = probeDaemonLogs(dir, held.cursors);
    expect(done.samples[0].text.match(/PR #4 — unread/g)).toHaveLength(1);
    expect(done.samples[0].text).toMatch(/refused 1/);
  });
  it('rotateLogIfNeeded still reports a rotation when only the counter bump fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot4-'));
    const p = join(dir, 'd.log');
    writeFileSync(p, 'q'.repeat(100));
    const boom = (a) => { if (String(a).endsWith('.rot.tmp')) throw new Error('disk'); writeFileSync(a, ''); };
    expect(rotateLogIfNeeded(p, { maxBytes: 10, keep: 2, fs: { writeFileSync: boom } })).toBe(true);
    expect(statSync(p).size).toBe(0);
  });
});

describe('review round 2 — repairs', () => {
  const strip = (text) => text.split('\n').map((l) => l.replace(LOG_TIMESTAMP_RE, ''));

  it('the default dedupe window (plus the flush timer lag) stays below daemon-silent\'s threshold, and a steady idle log never reads as silent', () => {
    expect(DEFAULT_DEDUPE_WINDOW_MS + 30_000).toBeLessThan(daemonSilent.silentMinMs);
    const start = Date.parse('2026-10-06T10:00:00.000Z');
    let t = start;
    const out = [];
    const c = { log: (s) => out.push(s), info() {}, warn() {}, error() {} };
    const restore = installDaemonLog({ target: c, env: {}, now: () => new Date(t), logPath: null, timers: false });
    let mem; let sentLines = 0; let size = 0; let silentBreaches = 0;
    for (let step = 0; step <= 180; step += 1) { // every 30 s for 90 min; an idle tick every 2 min
      t = start + step * 30_000;
      if (step % 4 === 0) c.log('review-daemon: tick (a) — dispatched 0, refused 0'); else restore.housekeeping?.();
      if (step % 2 !== 0) continue; // the health watch samples once a minute
      const fresh = out.slice(sentLines).join('\n'); sentLines = out.length; size += fresh.length;
      mem = foldDaemonMemory(mem, { name: 'review-daemon', text: fresh ? `${fresh}\n` : '', sizeBytes: size, mtimeMs: t, bootstrap: false }, t);
      if (step < 30) continue; // let the watch warm up
      const [row] = daemonSilent.evaluate({ leases: [{ log: 'review-daemon', pidAlive: true, pid: 1, heartbeatAt: t }] }, { now: t, daemons: { 'review-daemon': mem } });
      if (row.breach) silentBreaches += 1;
    }
    restore();
    expect(silentBreaches).toBe(0);
    expect(out.length).toBeLessThan(45 / 2); // and it still halves the ~45 ticks' lines
  });

  it('dedupe then expand reproduces the plain log across changing details, unequal repeats and unique lines', () => {
    const lines = ['T: tick', 'T: tick', 'R1: x', 'T: tick', 'R2: y', 'T: tick', 'R1: x', 'T: tick', 'R2: y', 'U: once', 'T: tick', 'R1: x', 'T: tick', 'R1: x', 'T: tick'];
    let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 300; trial += 1) {
      const seq = Array.from({ length: 5 + rnd(60) }, () => lines[rnd(lines.length)]);
      // a periodic stretch, so cycles actually form, then noise
      const cycle = Array.from({ length: 1 + rnd(4) }, () => lines[rnd(lines.length)]);
      const all = [...seq.slice(0, 5), ...Array.from({ length: cycle.length * (2 + rnd(12)) }, (_, i) => cycle[i % cycle.length]), ...seq.slice(5)];
      const out = []; let t = 0;
      const methods = ['log', 'info', 'warn', 'error'];
      const c = Object.fromEntries(methods.map((m) => [m, (s) => out.push(s)]));
      const restore = installDaemonLog({ target: c, env: { WE_DAEMON_LOG_DEDUPE_WINDOW_MS: '5000' }, now: () => new Date(t), logPath: null, timers: false });
      const plain = [];
      for (const l of all) {
        const m = rnd(5) === 0 ? methods[rnd(4)] : 'log'; // mostly one method, some mixed
        t += rnd(4) === 0 ? 3000 : 400; restore.housekeeping?.();
        plain.push(l); c[m](l);
      }
      restore();
      expect(strip(expandRepeatedLines(out.join('\n')))).toEqual(plain);
    }
  });

  it('a deduped log with alternating detail lines parses to the same per-tick shape as the plain log', () => {
    const shape = (text) => parseDaemonLog(text).ticks.map((x) => JSON.stringify(x));
    const gen = (env) => {
      const out = []; let t = Date.parse('2026-10-06T10:00:00.000Z');
      const c = { log: (s) => out.push(s), info() {}, warn() {}, error() {} };
      const restore = installDaemonLog({ target: c, env, now: () => new Date(t), logPath: null, timers: false });
      for (let i = 0; i < 40; i += 1) {
        c.log('fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 0, refused 1');
        c.log(`fix-dispatch-daemon: reconcile-refused missing-run web-everything/web-everything PR #${i % 2 ? 7 : 9} — no run`);
        t += 1000;
      }
      restore();
      return out.join('\n');
    };
    expect(shape(gen({}))).toEqual(shape(gen({ WE_DAEMON_LOG_DEDUPE_WINDOW_MS: '0' })));
  });

  it('a summary goes out through the method its line was written with (separate stdout / stderr sinks stay self-consistent)', () => {
    const so = []; const se = [];
    const c = { log: (s) => so.push(s), info: (s) => so.push(s), warn: (s) => se.push(s), error: (s) => se.push(s) };
    const restore = installDaemonLog({ target: c, env: {}, logPath: null, timers: false });
    for (let i = 0; i < 6; i += 1) c.error('d: refused x');
    c.log('d: refused x'); // same text on the other stream is a different line
    restore();
    expect(so.some((l) => /repeated/.test(l))).toBe(false);
    expect(se.filter((l) => /repeated 5 times/.test(l))).toHaveLength(1);
    expect(so.filter((l) => /d: refused x/.test(l))).toHaveLength(1);
  });

  it('the marker sanitiser is linear on whitespace-heavy text (no quadratic scan)', () => {
    const hostile = `(repeated${'\n'.repeat(100_000)}x`;
    const t0 = Date.now();
    neutralizeMarkerText(hostile);
    neutralizeMarkerText(`${' '.repeat(200_000)}\n(repeated`);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(neutralizeMarkerText('(repeated 5 times since 2026-01-01T00:00:00.000Z) x')).not.toMatch(/^\(repeated \d/);
  });

  it('the pass-daemon relay caps what it buffers when a child writes without a newline', async () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const big = 'z'.repeat(3 * 1024 * 1024 + 5);
    const spawnFn = () => { setImmediate(() => { for (let i = 0; i < big.length; i += 65536) child.stdout.emit('data', big.slice(i, i + 65536)); child.emit('close', 0, null); }); return child; };
    const seen = [];
    await spawnPassOnce({ script: 'x.mjs' }, { root: '/r', spawnFn, log: { log: (l) => seen.push(l), error: (l) => seen.push(l) } });
    expect(Math.max(...seen.map((l) => l.length))).toBeLessThanOrEqual(1024 * 1024);
    expect(seen.join('')).toBe(big);
  });

  it('a manual truncation (counter present on both sides, stale <log>.1) is a bootstrap, never a replay of <log>.1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe5-'));
    const p = join(dir, 'review-daemon.log');
    writeFileSync(`${p}.rot`, '3\n');
    writeFileSync(`${p}.1`, 'review-daemon: reconcile-refused missing-run o/r PR #2 — stale\n');
    const old = new Date(Date.now() - 60_000); utimesSync(`${p}.1`, old, old);
    writeFileSync(p, 'review-daemon: filler\n'.repeat(20));
    const first = probeDaemonLogs(dir, {});
    writeFileSync(p, 'review-daemon: fresh\n'); // an operator truncated it; the counter never moved
    const second = probeDaemonLogs(dir, first.cursors);
    expect(second.samples[0].text).not.toMatch(/stale/);
    expect(second.samples[0].bootstrap).toBe(true);
  });

  it('a cursor from before the counter existed does not replay a stale <log>.1 after a manual truncation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe6-'));
    const p = join(dir, 'review-daemon.log');
    writeFileSync(`${p}.1`, 'review-daemon: reconcile-refused missing-run o/r PR #2 — stale\n');
    const old = new Date(Date.now() - 60_000); utimesSync(`${p}.1`, old, old);
    writeFileSync(p, 'review-daemon: filler\n'.repeat(20));
    const first = probeDaemonLogs(dir, {});
    writeFileSync(p, 'review-daemon: fresh\n');
    expect(probeDaemonLogs(dir, first.cursors).samples[0].text).not.toMatch(/stale/);
  });

  it('probeDaemonLogs delivers the unread rotated tail once even when an existing counter failed to bump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe7-'));
    const p = join(dir, 'review-daemon.log');
    writeFileSync(p, 'review-daemon: filler\n'.repeat(5));
    writeFileSync(`${p}.rot`, '4\n');
    writeFileSync(`${p}.1`, 'review-daemon: older\n');
    const old = new Date(Date.now() - 60_000); utimesSync(`${p}.1`, old, old);
    const first = probeDaemonLogs(dir, {});
    appendFileSync(p, `review-daemon: reconcile-refused missing-run o/r PR #6 — unread\n${'review-daemon: filler\n'.repeat(5)}`);
    const boom = (a, ...rest) => { if (String(a).endsWith('.rot.tmp')) throw new Error('disk'); return writeFileSync(a, ...rest); };
    expect(rotateLogIfNeeded(p, { maxBytes: 10, keep: 2, fs: { writeFileSync: boom } })).toBe(true);
    expect(readFileSync(`${p}.rot`, 'utf8').trim()).toBe('4'); // the counter never moved
    const rotated = new Date(Date.now() - 30_000); utimesSync(`${p}.1`, rotated, rotated); // past the in-flight hold
    appendFileSync(p, 'review-daemon: tick (a) — dispatched 0, refused 0\n');
    const second = probeDaemonLogs(dir, first.cursors);
    expect(second.samples[0].text.match(/PR #6 — unread/g)).toHaveLength(1);
    const third = probeDaemonLogs(dir, second.cursors);
    expect(third.samples[0].text).not.toMatch(/PR #6/);
  });

  it('rotation still works for a real daemon: no explicit logPath, stdout redirected to a log in a log dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot5-'));
    const logPath = join(dir, 'd.log');
    const fd = openSync(logPath, 'a');
    const modUrl = pathToFileURL(join(process.cwd(), 'skills-src/conveyor/daemon-log.mjs')).href;
    const script = `import { installDaemonLog } from ${JSON.stringify(modUrl)};
      let t = Date.parse('2026-10-06T10:00:00Z');
      installDaemonLog({ now: () => new Date(t), logDirs: [${JSON.stringify(dir)}], timers: false, env: { WE_DAEMON_LOG_MAX_BYTES: '2000', WE_DAEMON_LOG_DEDUPE_WINDOW_MS: '0' } });
      for (let i = 0; i < 50; i++) { t += 31000; console.log('d: unique line number ' + i + ' ' + 'x'.repeat(60)); }`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', fd, 'pipe'] });
    closeSync(fd);
    expect(r.status, String(r.stderr)).toBe(0);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(logPath).size).toBeLessThan(4000);
  });

  it('one flush is written as one write per method, so a sampling reader never sees half a cycle', () => {
    const writes = [];
    const c = { log: (s) => writes.push(s), info() {}, warn() {}, error() {} };
    let t = 0;
    const restore = installDaemonLog({ target: c, env: {}, now: () => new Date(t), logPath: null, timers: false });
    for (let i = 0; i < 6; i += 1) { t += 1000; c.log('a: tick'); c.log('a: detail'); }
    restore();
    const flushWrites = writes.filter((w) => /repeated/.test(w));
    expect(flushWrites).toHaveLength(1);
    expect(flushWrites[0].split('\n')).toHaveLength(2);
  });

  it('a probe that sees two rotations since its cursor reads the old tail from <log>.2 and <log>.1 whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe8-'));
    const p = join(dir, 'review-daemon.log');
    const row = (i) => `review-daemon: reconcile-refused missing-run o/r PR #${100 + i} — row ${i}\n`;
    writeFileSync(p, Array.from({ length: 10 }, (_, i) => row(i)).join(''));
    const first = probeDaemonLogs(dir, {});
    const seenFirst = first.samples[0].text;
    for (let gen = 0; gen < 2; gen += 1) {
      appendFileSync(p, Array.from({ length: 10 }, (_, i) => row(10 + gen * 10 + i)).join(''));
      expect(rotateLogIfNeeded(p, { maxBytes: 10, keep: 2 })).toBe(true);
      const old = new Date(Date.now() - 60_000 + gen * 1000); utimesSync(`${p}.1`, old, old);
    }
    appendFileSync(p, 'review-daemon: tick (a) — dispatched 0, refused 0\n');
    const second = probeDaemonLogs(dir, first.cursors);
    const rows = new Set([...`${seenFirst}\n${second.samples[0].text}`.matchAll(/ — row (\d+)/g)].map((m) => Number(m[1])));
    expect([...rows].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('replay of a hostile group (one huge count beside thousands of tiny ones) stays fast', () => {
    const since = '2026-01-01T00:00:00.000Z';
    const lines = [`(repeated 100000 times since ${since}) big`, ...Array.from({ length: 8000 }, (_, i) => `(repeated 1 times since ${since}) s${i}`)];
    const t0 = Date.now();
    expandRepeatedLines(lines.join('\n'));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('the relay copes with a flood of tiny newline-free chunks in linear time', async () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const spawnFn = () => { setImmediate(() => { for (let i = 0; i < 300_000; i += 1) child.stdout.emit('data', 'x'); child.stdout.emit('data', '\n'); child.emit('close', 0, null); }); return child; };
    const seen = [];
    const t0 = Date.now();
    await spawnPassOnce({ script: 'x.mjs' }, { root: '/r', spawnFn, log: { log: (l) => seen.push(l), error: (l) => seen.push(l) } });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(seen.join('').length).toBe(300_000);
  });

  it('lines too long to hold are never collapsed', () => {
    expect(dedupable('x'.repeat(100))).toBe(true);
    expect(dedupable('x'.repeat(9000))).toBe(false);
  });
});
