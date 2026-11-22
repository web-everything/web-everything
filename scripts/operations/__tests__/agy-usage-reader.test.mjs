import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectAgyUsage, descendantPids, parseAgyUsage, readAgyUsageSettings, runAgyUsageReader } from '../agy-usage-reader.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const LOGIN = readFileSync('scripts/operations/__tests__/fixtures/agy-login-screen.raw.txt', 'utf8');
const SIGNED_IN = readFileSync('scripts/operations/__tests__/fixtures/agy-usage-signed-in.raw.txt', 'utf8');
const SCREEN = `GEMINI MODELS
Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, ...
Weekly Limit Remaining
[bar] 100.00%
Refreshes in 167h 59m
Five Hour Limit Remaining
[bar] 99.99%
Refreshes in 4h 59m
`;
const settings = { minIntervalMinutes: 15, timeoutMs: 45000 };
afterEach(() => vi.useRealTimers());

describe('Gemini usage parser', () => {
  it('parses the signed-in capture with an unused five-hour window and a weekly countdown', () => {
    expect(parseAgyUsage(SIGNED_IN, NOW)).toEqual({
      at: new Date(NOW).toISOString(), session: null, spend_limit: null,
      five_hour: { used_percentage: 0, resets_at: NOW / 1000 + 5 * 3600 },
      seven_day: { used_percentage: 6, resets_at: NOW / 1000 + (153 * 60 + 58) * 60 },
    });
  });
  it.each([['Five Hour', 'five_hour', 5], ['Weekly', 'seven_day', 168]])(
    'uses the default length for an unused %s window with Quota available and no countdown', (label, key, hours) => {
      const screen = SCREEN.replace(new RegExp(`(${label} Limit Remaining\\n\\[bar\\] )[^\\n]+\\nRefreshes in[^\\n]+`), '$1100.00%\nQuota available');
      expect(parseAgyUsage(screen, NOW)[key]).toEqual({ used_percentage: 0, resets_at: NOW / 1000 + hours * 3600 });
    });
  it.each(['Five Hour', 'Weekly'])('rejects partial %s quota without a countdown even with Quota available', label => {
    const screen = SCREEN.replace(new RegExp(`(${label} Limit Remaining\\n\\[bar\\] )[^\\n]+\\nRefreshes in[^\\n]+`), '$194.00%\nQuota available');
    expect(() => parseAgyUsage(screen, NOW)).toThrow();
  });
  it('rejects a full window without either a countdown or Quota available', () => {
    expect(() => parseAgyUsage(SCREEN.replace('Refreshes in 167h 59m', ''), NOW)).toThrow();
  });
  it('takes the last full frame after a screen clear, not the first', () => {
    const stale = SCREEN.replace('100.00%', '40.00%');
    expect(parseAgyUsage(`${stale}\x1b[2J\x1b[H${SCREEN}`, NOW).seven_day.used_percentage).toBe(0);
  });
  it('never falls back to an older frame when the last frame is partial', () => {
    expect(() => parseAgyUsage(`${SCREEN}\x1b[2JGEMINI MODELS\nWeekly Limit Remaining\n`, NOW)).toThrow();
  });
  it('treats a cursor-home repaint as a new frame', () => {
    const fresh = SCREEN.replace('100.00%', '30.00%');
    expect(parseAgyUsage(`${SCREEN}\x1b[H${fresh}`, NOW).seven_day.used_percentage).toBe(70);
  });
  it('rejects a screen that never completes after a clear', () => {
    expect(() => parseAgyUsage('\x1b[2JGEMINI MODELS\nWeekly Limit Remaining\n', NOW)).toThrow();
  });
  it('stops the Gemini group at a mixed-case next model group', () => {
    const mixed = SCREEN.replace('Five Hour Limit Remaining', 'Claude Models\nFive Hour Limit Remaining');
    expect(() => parseAgyUsage(mixed, NOW)).toThrow();
  });
  it('does not fall back to an older frame when the newest complete frame is invalid', () => {
    const invalid = SCREEN.replace('100.00%', '101.00%');
    expect(() => parseAgyUsage(`${SCREEN}\x1b[2J${invalid}`, NOW)).toThrow('Invalid usage bounds');
  });
  it.each(['-5.00%', 'abc%'])('does not fall back to older evidence when the newest frame shows %s', bad => {
    const broken = SCREEN.replace('100.00%', bad);
    expect(() => parseAgyUsage(`${SCREEN}\x1b[2J${broken}`, NOW)).toThrow();
  });
  it('does not fall back when the newest frame has an unknown reset time', () => {
    const broken = SCREEN.replace('Refreshes in 167h 59m', 'Refreshes in soon');
    expect(() => parseAgyUsage(`${SCREEN}\x1b[2J${broken}`, NOW)).toThrow();
  });
  it('uses the last GEMINI MODELS block within one frame', () => {
    const stale = SCREEN.replace('100.00%', '40.00%');
    expect(parseAgyUsage(`${stale}\n${SCREEN}`, NOW).seven_day.used_percentage).toBe(0);
  });
  it('parses the fixture, strips ANSI and converts remaining percentages and relative resets', () => {
    expect(parseAgyUsage(`\x1b[32m${SCREEN}\x1b[0m`, NOW)).toEqual({
      at: '2026-11-18T12:00:00.000Z', session: null, spend_limit: null,
      five_hour: { used_percentage: 0.01, resets_at: NOW / 1000 + 17940 },
      seven_day: { used_percentage: 0, resets_at: NOW / 1000 + 604740 },
    });
  });
  it.each(['', SCREEN.replace('Five Hour', 'Daily'), SCREEN.replace('100.00%', '101%'),
    SCREEN.replace('100.00%', '-10%'), SCREEN.replace('167h 59m', '167h nonsense'),
    SCREEN.replace('167h 59m', 'unknown'), SCREEN.replace('GEMINI MODELS', 'CLAUDE MODELS')])(
    'refuses incomplete or invalid quota evidence', screen => expect(() => parseAgyUsage(screen, NOW)).toThrow());
});

describe('settings', () => {
  it('resolves defaults and standard → platform → tool → environment with provenance', () => {
    const log = vi.fn();
    expect(readAgyUsageSettings({ read: () => ({}), platform: {}, env: {}, log })).toEqual(settings);
    expect(readAgyUsageSettings({ read: () => ({ agyUsage: { timeoutMs: 20000 } }),
      platform: { minIntervalMinutes: 20, timeoutMs: 10000 }, env: { WE_AGY_USAGE_MIN_INTERVAL_MINUTES: '30' }, log,
    })).toEqual({ minIntervalMinutes: 30, timeoutMs: 20000 });
    expect(log.mock.calls.flat().join(' ')).toContain('timeoutMs=20000 (tool)');
    expect(log.mock.calls.flat().join(' ')).toContain('minIntervalMinutes=30 (env)');
  });
  it('rejects invalid and overflowing settings instead of disabling timeout', () => {
    expect(readAgyUsageSettings({ read: () => ({ agyUsage: { timeoutMs: 0, minIntervalMinutes: -1 } }),
      platform: {}, env: { WE_AGY_USAGE_TIMEOUT_MS: '2147483648' }, log: () => {},
    })).toEqual(settings);
  });
});

function processFixture(options = {}) {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 1234, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const writes = [];
  child.stdin.on('data', data => writes.push(data.toString()));
  const spawnFn = vi.fn(() => child), kill = vi.fn();
  const promise = collectAgyUsage({ home: '/trusted-home', now: () => NOW, spawnFn, kill, descendants: () => [], ...options });
  return { child, writes, spawnFn, kill, promise };
}

describe('PTY collection', () => {
  it.each(['\x1b[2J', '\x1bc', '\x1b[?1049h', '\x1b[H'])(
    'does not combine login markers across frame break %j', async frameBreak => {
      const h = processFixture();
      const assertion = expect(h.promise).rejects.toThrow('timed out');
      h.child.stdout.write(`Not signed in${frameBreak}Select login method`);
      await vi.advanceTimersByTimeAsync(45000);
      await assertion;
    });
  it('rejects login plus folder-trust text as a trust error', async () => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow('trust this folder');
    h.child.stdout.write('Not signed in\nSelect login method\nDo you trust this folder?');
    await assertion;
    await vi.advanceTimersByTimeAsync(45000);
    expect(h.writes).toEqual([]);
  });
  it('waits without keys for split login markers arriving across the startup delay', async () => {
    const h = processFixture();
    h.child.stdout.write('Not signed in\n');
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.writes).toEqual([]);
    h.child.stderr.write('Select login method');
    expect(await h.promise).toEqual({ at: new Date(NOW).toISOString(), status: 'signed-out' });
    await vi.advanceTimersByTimeAsync(45000);
    expect(h.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['', '? for shortcuts', '────────────────',
    '? for shortcuts\x1b[2J────────────────'])('types nothing until timeout for unresolved startup %j', async screen => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow('agy usage timed out');
    h.child.stdout.write(screen);
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
    expect(h.writes).toEqual([]);
  });
  it('waits for both signed-in markers and the minimum startup delay', async () => {
    const h = processFixture();
    h.child.stdout.write('? for shortcuts');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.writes).toEqual([]);
    h.child.stdout.write('\n────────────────\n');
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.writes).toEqual(['\x1b']);
    await vi.advanceTimersByTimeAsync(300);
    h.child.stdout.write(SCREEN);
    await h.promise;
    expect(h.writes).toEqual(['\x1b', '/usage\r', '\x03', '\x03']);
  });
  it('cancels /usage when login replaces a resolved signed-in prompt after Escape', async () => {
    const h = processFixture();
    h.child.stdout.write(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.writes).toEqual(['\x1b']);
    h.child.stderr.write('\x1b[2JNot signed in\nSelect login method');
    expect(await h.promise).toEqual({ at: new Date(NOW).toISOString(), status: 'signed-out' });
    await vi.advanceTimersByTimeAsync(45000);
    expect(h.writes).toEqual(['\x1b']);
  });
  it.each(['Not signed in', 'Select login method'])(
    'never writes /usage when only %s replaces the prompt after Escape', async marker => {
      const h = processFixture();
      const assertion = expect(h.promise).rejects.toThrow('timed out');
      h.child.stdout.write(SIGNED_IN);
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.writes).toEqual(['\x1b']);
      h.child.stderr.write(`\x1b[2J${marker}`);
      await vi.advanceTimersByTimeAsync(45000);
      await assertion;
      expect(h.writes).toEqual(['\x1b']);
    });
  it('rechecks the last frame when the minimum startup delay elapses', async () => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow('timed out');
    h.child.stdout.write(SIGNED_IN);
    h.child.stdout.write('\x1b[2Jstill painting');
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
    expect(h.writes).toEqual([]);
  });
  it('resolves parsed usage when the fake PTY replays the signed-in capture', async () => {
    const h = processFixture();
    const resolved = vi.fn();
    h.promise.then(resolved);
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.writes).toEqual([]);
    h.child.stdout.write(SIGNED_IN);
    expect(h.writes).toEqual(['\x1b']);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.writes).toEqual(['\x1b', '/usage\r']);
    h.child.stdout.write(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledWith({
      at: new Date(NOW).toISOString(), session: null, spend_limit: null,
      five_hour: { used_percentage: 0, resets_at: NOW / 1000 + 5 * 3600 },
      seven_day: { used_percentage: 6, resets_at: NOW / 1000 + (153 * 60 + 58) * 60 },
    });
    expect(await h.promise).toEqual(resolved.mock.calls[0][0]);
    expect(h.writes).toEqual(['\x1b', '/usage\r', '\x03', '\x03']);
    expect(h.kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('resolves the raw login screen before startup, writes no keys and kills descendants', async () => {
    const h = processFixture({ descendants: () => [1236, 1235] });
    const resolved = vi.fn();
    h.promise.then(resolved);
    await vi.advanceTimersByTimeAsync(100);
    // Exercise chunked output, including the two login markers arriving separately.
    const split = LOGIN.indexOf('Select login method');
    h.child.stdout.write(LOGIN.slice(0, split));
    expect(h.kill).not.toHaveBeenCalled();
    h.child.stdout.write(LOGIN.slice(split));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledWith({ at: new Date(NOW).toISOString(), status: 'signed-out' });
    expect(h.kill.mock.calls).toEqual([[1236, 'SIGKILL'], [1235, 'SIGKILL'], [-1234, 'SIGKILL']]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(45000);
    expect(h.writes).toEqual([]);
  });
  it.each(['not signed in', 'Select login method'])('does not classify a lone %s marker as signed out', async marker => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow('exited before complete usage');
    h.child.stderr.write(marker);
    expect(h.kill).not.toHaveBeenCalled();
    h.child.emit('close');
    await assertion;
    expect(h.writes).toEqual([]);
  });
  it('uses home cwd, sends Esc then usage and two interrupts without agy settings writes', async () => {
    const h = processFixture();
    h.child.stdout.write(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(3300);
    h.child.stdout.write(SCREEN);
    await vi.advanceTimersByTimeAsync(300);
    h.child.emit('close', 130);
    expect(await h.promise).toEqual(parseAgyUsage(SCREEN, NOW));
    expect(h.spawnFn).toHaveBeenCalledWith('sh', ['-c', 'cat | script -q /dev/null agy'], {
      cwd: '/trusted-home', detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(h.writes).toEqual(['\x1b', '/usage\r', '\x03', '\x03']);
    expect(h.kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });
  it('kills only the explicit child PID on hard timeout when usage never appears', async () => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledWith(-1234, "SIGKILL");
  });
  it('kills the pty grandchild by exact PID before the wrapper group', async () => {
    const h = processFixture({ descendants: () => [1236, 1235] });
    const assertion = expect(h.promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
    expect(h.kill.mock.calls).toEqual([[1236, 'SIGKILL'], [1235, 'SIGKILL'], [-1234, 'SIGKILL']]);
  });
  it('says so loudly when child processes cannot be listed', async () => {
    const h = processFixture({ descendants: () => { throw new Error('ps failed'); } });
    const assertion = expect(h.promise).rejects.toThrow('cleanup incomplete');
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
    expect(h.kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });
  it('fails a successful read when a kill is refused', async () => {
    const kill = vi.fn(() => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); });
    const h = processFixture({ kill });
    const assertion = expect(h.promise).rejects.toThrow('cleanup incomplete');
    h.child.stdout.write(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(3300);
    h.child.stdout.write(SCREEN);
    await assertion;
  });
  it('lists descendants leaf first from ps output', () => {
    expect(descendantPids(10, () => '10 1\n11 10\n12 11\n13 99\n')).toEqual([12, 11]);
  });
  it('bounds oversized output with an operator-visible manual retry fallback', async () => {
    const h = processFixture({ maxBytes: 8 });
    const assertion = expect(h.promise).rejects.toThrow('inspect agy manually and retry');
    h.child.stdout.write('x'.repeat(9));
    await assertion;
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledWith(-1234, "SIGKILL");
  });
  it('ignores usage-looking startup output and an unfinished refresh line', async () => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow('timed out');
    h.child.stdout.write(SCREEN);
    h.child.stdout.write(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(3300);
    h.child.stdout.write(SCREEN.slice(0, -2));
    await vi.advanceTimersByTimeAsync(41700);
    await assertion;
    expect(h.writes).toEqual(['\x1b', '/usage\r']);
  });
  it('fails closed instead of answering a folder-trust prompt', async () => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow('trust this folder');
    h.child.stdout.write('Do you trust this folder?');
    await assertion;
    expect(h.writes).toEqual([]);
  });
  it.each(['error', 'close'])('fails closed on process %s before usage', async event => {
    const h = processFixture();
    const assertion = expect(h.promise).rejects.toThrow();
    h.child.emit(event, new Error('spawn failed'));
    await assertion;
  });
});

const complete = at => ({ at: new Date(at).toISOString(), five_hour: { used_percentage: 1, resets_at: 1 }, seven_day: { used_percentage: 1, resets_at: 1 } });

function fileFixture(previous) {
  const io = { readFile: vi.fn(async () => {
    if (previous === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return previous;
  }), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), unlink: vi.fn(async () => {}) };
  const collect = vi.fn(async () => parseAgyUsage(SCREEN, NOW));
  return { io, collect, home: '/trusted-home', now: () => NOW, settings };
}

describe('snapshot persistence', () => {
  it('atomically writes the login fixture result without any usage fields', async () => {
    const pty = processFixture({ descendants: () => [1235] });
    const h = fileFixture();
    h.collect.mockImplementation(() => pty.promise);
    const result = runAgyUsageReader(h);
    pty.child.stderr.write(LOGIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.io.rename).toHaveBeenCalled();
    expect(await result).toEqual({ at: new Date(NOW).toISOString(), status: 'signed-out' });
    const [temporary, data, flags] = h.io.writeFile.mock.calls[0];
    const written = JSON.parse(data);
    expect(written).toEqual({ at: new Date(NOW).toISOString(), status: 'signed-out' });
    for (const field of ['five_hour', 'seven_day', 'used_percentage']) expect(data).not.toContain(field);
    expect(flags).toEqual({ flag: 'wx', mode: 0o600 });
    expect(h.io.rename).toHaveBeenCalledWith(temporary, '/trusted-home/.plateau/agy-usage.json');
    expect(pty.writes).toEqual([]);
    expect(pty.kill).toHaveBeenCalledWith(1235, 'SIGKILL');
  });
  it('throttles a recent signed-out record without treating it as usage', async () => {
    const h = fileFixture(JSON.stringify({ at: new Date(NOW - 839999).toISOString(), status: 'signed-out' }));
    expect(await runAgyUsageReader(h)).toEqual({ skipped: true });
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.io.writeFile).not.toHaveBeenCalled();
  });
  // The throttle boundary is the 15-minute interval minus the one-minute tick slack (THROTTLE_SLACK_MS).
  it.each([NOW - 840000, NOW + 1, 'invalid'])('retries signed-out records with expired or invalid timestamps: %s', async at => {
    const h = fileFixture(JSON.stringify({ at: typeof at === 'number' ? new Date(at).toISOString() : at, status: 'signed-out' }));
    await runAgyUsageReader(h);
    expect(h.collect).toHaveBeenCalledOnce();
  });
  it('skips a snapshot younger than fifteen minutes less the tick slack without spawning or writing', async () => {
    const h = fileFixture(JSON.stringify(complete(NOW - 839999)));
    expect(await runAgyUsageReader(h)).toEqual({ skipped: true });
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.io.writeFile).not.toHaveBeenCalled();
  });
  it.each([
    JSON.stringify({ at: new Date(NOW + 86400000).toISOString() }),
    JSON.stringify({ at: new Date(NOW - 1000).toISOString() }),
    JSON.stringify({ ...complete(NOW + 86400000) }),
    JSON.stringify({ ...complete(NOW - 1000), five_hour: { used_percentage: -5, resets_at: 1 } }),
    JSON.stringify({ ...complete(NOW - 1000), seven_day: { used_percentage: 150, resets_at: 1 } }),
    JSON.stringify({ ...complete(NOW - 1000), seven_day: { used_percentage: 1, resets_at: -1 } }),
  ])('does not let a future-dated or incomplete previous record suppress collection', async previous => {
    const h = fileFixture(previous);
    await runAgyUsageReader(h);
    expect(h.collect).toHaveBeenCalled();
  });
  it.each([undefined, JSON.stringify(complete(NOW - 840000))])(
    'collects missing or expired snapshots, writes private temp file then atomically renames', async previous => {
      const h = fileFixture(previous);
      await runAgyUsageReader(h);
      expect(h.collect).toHaveBeenCalledWith({ home: h.home, timeoutMs: 45000, now: h.now });
      const [temporary, data, flags] = h.io.writeFile.mock.calls[0];
      expect(temporary).toMatch(/agy-usage\.json\..*\.tmp$/);
      expect(JSON.parse(data)).toEqual(parseAgyUsage(SCREEN, NOW));
      expect(flags).toEqual({ flag: 'wx', mode: 0o600 });
      expect(h.io.rename).toHaveBeenCalledWith(temporary, '/trusted-home/.plateau/agy-usage.json');
      expect(h.io.unlink).toHaveBeenCalledWith(temporary);
    });
  it.each(['timeout', 'incomplete screen'])('preserves the old snapshot on collection failure: %s', async reason => {
    const h = fileFixture();
    h.collect.mockRejectedValue(new Error(reason));
    await expect(runAgyUsageReader(h)).rejects.toThrow(reason);
    expect(h.io.writeFile).not.toHaveBeenCalled();
    expect(h.io.rename).not.toHaveBeenCalled();
  });
  it.each(['garbage'])('refuses unreadable previous evidence', async previous => {
    const h = fileFixture(previous);
    await expect(runAgyUsageReader(h)).rejects.toThrow();
    expect(h.collect).not.toHaveBeenCalled();
  });
  it('does not let the collection time push the next half-hour launchd tick into the throttle window', async () => {
    // Judge repro (PR 7331): collection starts 12:00:00 and finishes 12:00:03.3; the 30-min tick must run.
    const store = new Map();
    const io = { readFile: vi.fn(async path => {
      if (!store.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return store.get(path);
    }), mkdir: vi.fn(), writeFile: vi.fn(async (path, data) => { store.set(path, data); }),
    rename: vi.fn(async (from, to) => { store.set(to, store.get(from)); store.delete(from); }), unlink: vi.fn(async () => {}) };
    let clock = NOW;
    const collect = vi.fn(async ({ now }) => { clock += 3300; return parseAgyUsage(SCREEN, now()); });
    const run = at => { clock = at; return runAgyUsageReader({ io, collect, home: '/h', now: () => clock,
      settings: { minIntervalMinutes: 30, timeoutMs: 45000 } }); };
    await run(NOW);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(await run(NOW + 15 * 60000)).toEqual({ skipped: true });
    expect(collect).toHaveBeenCalledTimes(1);
    await run(NOW + 30 * 60000);
    expect(collect).toHaveBeenCalledTimes(2);
    // A tick firing slightly early (process start jitter) still collects.
    await run(NOW + 60 * 60000 - 500);
    expect(collect).toHaveBeenCalledTimes(3);
  });
  it('lets a record stamped at collection END (pre-fix snapshot) still pass the next tick', async () => {
    const h = fileFixture(JSON.stringify(complete(NOW - 30 * 60000 + 3300)));
    h.settings = { minIntervalMinutes: 30, timeoutMs: 45000 };
    await runAgyUsageReader(h);
    expect(h.collect).toHaveBeenCalledOnce();
  });
  it('stamps the written snapshot with the collection START time', async () => {
    const h = fileFixture();
    let clock = NOW;
    h.now = () => clock;
    h.collect.mockImplementation(async ({ now }) => { clock += 3300; return parseAgyUsage(SCREEN, now()); });
    const result = await runAgyUsageReader(h);
    expect(result.at).toBe(new Date(NOW).toISOString());
    expect(JSON.parse(h.io.writeFile.mock.calls[0][1]).at).toBe(new Date(NOW).toISOString());
  });
  it('cleans up a temporary file after rename failure without replacing the snapshot', async () => {
    const h = fileFixture();
    h.io.rename.mockRejectedValue(new Error('rename failed'));
    await expect(runAgyUsageReader(h)).rejects.toThrow('rename failed');
    expect(h.io.unlink).toHaveBeenCalledWith(h.io.writeFile.mock.calls[0][0]);
  });
});
