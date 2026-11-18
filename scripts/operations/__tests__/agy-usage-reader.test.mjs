import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectAgyUsage, parseAgyUsage, readAgyUsageSettings, runAgyUsageReader } from '../agy-usage-reader.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
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
  const promise = collectAgyUsage({ home: '/trusted-home', now: () => NOW, spawnFn, kill, ...options });
  return { child, writes, spawnFn, kill, promise };
}

describe('PTY collection', () => {
  it('uses home cwd, sends Esc then usage and two interrupts without agy settings writes', async () => {
    const h = processFixture();
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
  it('skips a snapshot younger than fifteen minutes without spawning or writing', async () => {
    const h = fileFixture(JSON.stringify(complete(NOW - 899999)));
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
  it.each([undefined, JSON.stringify(complete(NOW - 900000))])(
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
  it('cleans up a temporary file after rename failure without replacing the snapshot', async () => {
    const h = fileFixture();
    h.io.rename.mockRejectedValue(new Error('rename failed'));
    await expect(runAgyUsageReader(h)).rejects.toThrow('rename failed');
    expect(h.io.unlink).toHaveBeenCalledWith(h.io.writeFile.mock.calls[0][0]);
  });
});
