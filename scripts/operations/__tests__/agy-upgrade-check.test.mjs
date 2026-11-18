import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { boundedExec, smoke, runUpgradeCheck, resolveSettings } from '../agy-upgrade-check.mjs';
import { readAgyHold } from '../../lib/antigravity-run-evidence.mjs';
import { publishAttention, replay } from '../needs-you-feed.mjs';

const roots = [];
const fresh = () => { const dir = fs.mkdtempSync(join(tmpdir(), 'agy-upgrade-')); roots.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const good = { ok: true, stdout: 'agy 1.5.11\n' };
const hung = { ok: false, hung: true, stdout: '' };
const current = { ok: true, stdout: '{"casks":[]}' };
const outdated = { ok: true, stdout: '{"casks":[{"name":"antigravity-cli"}]}' };
function fixture(results) {
  const dir = fresh(), exec = vi.fn();
  fs.mkdirSync(join(dir, 'binary'));
  for (const result of results) exec.mockResolvedValueOnce(result);
  const alert = vi.fn(), log = vi.fn();
  let time = Date.parse('2026-11-18T10:00:00Z');
  return { dir, exec, alert, log, options: { dir, exec, alert, log, env: {}, io: fs, now: () => time },
    advance: () => { time += 3600000; },
    read: name => JSON.parse(fs.readFileSync(join(dir, name), 'utf8')) };
}
function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 45678, stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}
describe('bounded commands and smoke', () => {
  it('smoke ok uses ignored stdin and parses the version', async () => {
    const child = fakeChild(), spawn = vi.fn(() => child), kill = vi.fn();
    const pending = smoke({ spawn, kill });
    child.stdout.write('Antigravity CLI 1.5.11\n'); child.emit('close', 0);
    expect(await pending).toEqual({ ok: true, version: '1.5.11', hung: false });
    expect(spawn).toHaveBeenCalledWith('agy', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    expect(kill).not.toHaveBeenCalled();
  });
  it('smoke hang kills only the exact child PID and resolves without close', async () => {
    vi.useFakeTimers();
    const child = fakeChild(), kill = vi.fn();
    const pending = smoke({ spawn: () => child, kill });
    await vi.advanceTimersByTimeAsync(19999); expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, version: 'unknown', hung: true });
    expect(kill.mock.calls).toEqual([[45678, 'SIGKILL']]);
  });
  it.each([60000, 120000])('brew deadline %s kills the exact PID', async timeoutMs => {
    vi.useFakeTimers(); const kill = vi.fn();
    const pending = boundedExec('brew', ['test'], { spawn: fakeChild, kill, timeoutMs });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(await pending).toMatchObject({ ok: false, hung: true });
    expect(kill.mock.calls).toEqual([[45678, 'SIGKILL']]);
  });
  it('oversized output kills the child and reports a bounded failure', async () => {
    const child = fakeChild(), kill = vi.fn();
    const pending = boundedExec('agy', ['--version'], { spawn: () => child, kill, timeoutMs: 20000 });
    child.stderr.write('x'.repeat(65537));
    expect(await pending).toMatchObject({ ok: false, reason: 'output-limit', stdout: '' });
    expect(kill.mock.calls).toEqual([[45678, 'SIGKILL']]);
  });
  it('ESRCH means the child already exited and preserves the bounded timeout result', async () => {
    vi.useFakeTimers();
    const pending = boundedExec('agy', ['--version'], { spawn: fakeChild, timeoutMs: 10,
      kill: () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); } });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ ok: false, hung: true, reason: 'timeout' });
  });
  it('refused kill on oversized output reports cleanup incomplete', async () => {
    const child = fakeChild();
    const pending = boundedExec('agy', ['--version'], { spawn: () => child, timeoutMs: 20000,
      kill: () => { throw Object.assign(Error('refused'), { code: 'EPERM' }); } });
    child.stderr.write('x'.repeat(65537));
    expect(await pending).toMatchObject({ ok: false, reason: 'cleanup incomplete' });
  });
  it('spawn errors, nonzero exit and missing version cannot report healthy', async () => {
    expect(await smoke({ spawn: () => { throw Error('missing'); } })).toMatchObject({ ok: false });
    const child = fakeChild(); const pending = smoke({ spawn: () => child });
    child.stdout.write('1.5.9'); child.emit('close', 1);
    expect(await pending).toMatchObject({ ok: false, version: '1.5.9' });
    expect(await smoke({ exec: async () => ({ ok: true, stdout: '' }) })).toMatchObject({ ok: false });
  });
});
describe('scheduled upgrade check', () => {
  it('outdated -> bounded upgrade -> smoke ok', async () => {
    const f = fixture([good, outdated, { ok: true }, good]);
    expect(await runUpgradeCheck(f.options)).toMatchObject({ status: 'ok' });
    expect(f.exec.mock.calls).toEqual([
      ['agy', ['--version'], { timeoutMs: 20000 }],
      ['brew', ['outdated', '--cask', '--json=v2'], { timeoutMs: 60000 }],
      ['brew', ['upgrade', '--cask', 'antigravity-cli'], { timeoutMs: 120000 }],
      ['agy', ['--version'], { timeoutMs: 20000 }],
    ]);
    expect(f.read('binary/health.json')).toMatchObject({ state: 'ok', version: '1.5.11' });
  });
  it('upgrade still hung writes dead before repair and raises one alert across repeats', async () => {
    const f = fixture([hung, outdated, { ok: true }, hung, hung, current]);
    f.alert.mockImplementation(() => {
      expect(f.read('binary/health.json')).toMatchObject({ state: 'dead', reason: 'hung' });
    });
    expect(await runUpgradeCheck(f.options)).toMatchObject({ status: 'dead' });
    f.advance(); await runUpgradeCheck(f.options);
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(f.alert.mock.calls[0][0]).toMatchObject({ kind: 'agy-binary-dead' });
  });
  it('failed smoke holds the seat and a different version/state raises a distinct alert', async () => {
    const f = fixture([hung, current, { ok: false, stdout: '1.5.9' }, current]);
    await runUpgradeCheck(f.options); f.advance(); await runUpgradeCheck(f.options);
    expect(f.alert).toHaveBeenCalledTimes(2);
    expect(f.read('binary/health.json')).toMatchObject({ state: 'dead', version: '1.5.9', reason: 'failed' });
  });
  it('healthy smoke clears dead health even when staleness is unavailable', async () => {
    const f = fixture([hung, current, good, { ok: false }]);
    await runUpgradeCheck(f.options); f.advance();
    expect(await runUpgradeCheck(f.options)).toMatchObject({ status: 'staleness-unavailable', ok: true });
    expect(f.read('binary/health.json').state).toBe('ok');
    expect(readAgyHold('sonnet', { dir: f.dir, now: Date.parse(f.read('binary/health.json').at) })).toBeNull();
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('operator should inspect'));
  });
  it('recovery resets the alert identity and an identical later outage publishes again', async () => {
    const f = fixture([hung, current, good, current, hung, current, hung, current]);
    const path = join(f.dir, 'attention.jsonl');
    f.options.alert = item => publishAttention(item, { path });
    await runUpgradeCheck(f.options);
    expect(f.read('binary/upgrade-check.json').alerted).toBe('unknown:hung');
    f.advance(); await runUpgradeCheck(f.options);
    expect(f.read('binary/upgrade-check.json').alerted).toBe('');
    f.advance(); await runUpgradeCheck(f.options);
    f.advance(); await runUpgradeCheck(f.options);
    expect(replay({ path })).toHaveLength(2);
  });
  it.each(['initial smoke', 'brew outdated', 'brew upgrade', 'post-upgrade smoke'])(
    'refused kill in %s reports dead, keeps the lock and stops subsequent commands', async step => {
      vi.useFakeTimers();
      const f = fixture([]), kill = vi.fn(() => { throw Object.assign(Error('refused'), { code: 'EPERM' }); });
      const preceding = { 'initial smoke': [], 'brew outdated': [good], 'brew upgrade': [good, outdated],
        'post-upgrade smoke': [good, outdated, { ok: true }] }[step];
      for (const result of preceding) f.exec.mockResolvedValueOnce(result);
      f.exec.mockImplementationOnce((command, args, options) => boundedExec(command, args, { ...options, spawn: fakeChild, kill }));
      f.alert.mockImplementation(item => {
        expect(item.reason).toContain('cleanup incomplete');
        expect(fs.existsSync(join(f.dir, 'upgrade-check.lock'))).toBe(true);
        expect(f.read('binary/health.json')).toMatchObject({ state: 'dead', reason: 'cleanup incomplete' });
      });
      const pending = runUpgradeCheck(f.options);
      await vi.advanceTimersByTimeAsync(120000);
      expect(await pending).toMatchObject({ status: 'dead', ok: false, reason: 'cleanup incomplete' });
      expect(kill.mock.calls).toEqual([[45678, 'SIGKILL']]);
      expect(f.exec).toHaveBeenCalledTimes(preceding.length + 1);
      expect(f.alert).toHaveBeenCalledTimes(1);
      // The lock stays so a later tick cannot overlap the surviving child.
      expect(fs.existsSync(join(f.dir, 'upgrade-check.lock'))).toBe(true);
      expect(await runUpgradeCheck(f.options)).toEqual({ status: 'locked' });
    });
  it('keeps the lock even when alert publication throws after a refused kill', async () => {
    vi.useFakeTimers();
    const f = fixture([]), kill = vi.fn(() => { throw Object.assign(Error('refused'), { code: 'EPERM' }); });
    f.exec.mockImplementationOnce((command, args, options) => boundedExec(command, args, { ...options, spawn: fakeChild, kill }));
    f.alert.mockRejectedValue(new Error('feed down'));
    const pending = expect(runUpgradeCheck(f.options)).rejects.toThrow('feed down');
    await vi.advanceTimersByTimeAsync(120000);
    await pending;
    expect(fs.existsSync(join(f.dir, 'upgrade-check.lock'))).toBe(true);
  });
  it('creates the binary folder and leaves only atomic destination files', async () => {
    const f = fixture([good, current]); fs.rmdirSync(join(f.dir, 'binary'));
    await runUpgradeCheck(f.options);
    expect(fs.readdirSync(f.dir)).toEqual(['binary']);
    expect(fs.readdirSync(join(f.dir, 'binary')).sort()).toEqual(['health.json', 'upgrade-check.json']);
    expect(readAgyHold('sonnet', { dir: f.dir, now: Date.parse(f.read('binary/health.json').at) })).toBeNull();
  });
  it('rate limits to an hour including persisted state and honors disable', async () => {
    const f = fixture([good, current, good, current]);
    await runUpgradeCheck(f.options);
    expect(await runUpgradeCheck(f.options)).toEqual({ status: 'rate-limited' });
    expect(f.exec).toHaveBeenCalledTimes(2);
    f.advance(); await runUpgradeCheck(f.options); expect(f.exec).toHaveBeenCalledTimes(4);
    expect(await runUpgradeCheck({ ...f.options, env: { WE_AGY_UPGRADE_ENABLED: '0' } })).toEqual({ status: 'disabled' });
  });
  it.each(['{', '{"at":"2099-01-01"}', '{"at":42}', 'x'.repeat(8193)])('ignores invalid or oversized cache (%#)', async text => {
    const f = fixture([good, current]); fs.writeFileSync(join(f.dir, 'binary', 'upgrade-check.json'), text);
    expect(await runUpgradeCheck(f.options)).toMatchObject({ status: 'ok' });
  });
  it('concurrent ticks cannot both execute commands', async () => {
    const f = fixture([]); let release;
    f.exec.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(current);
    const pending = runUpgradeCheck(f.options);
    expect(await runUpgradeCheck(f.options)).toEqual({ status: 'locked' });
    release(good); await pending;
  });
  it('unknown staleness refuses upgrade and logs the operator fallback', async () => {
    const f = fixture([good, { ok: true, stdout: '{}' }]);
    expect(await runUpgradeCheck(f.options)).toMatchObject({ status: 'staleness-unavailable' });
    expect(f.exec).toHaveBeenCalledTimes(2);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('operator should inspect'));
  });
  it('sanctioned writer emits one event per stable failure identity', async () => {
    const f = fixture([hung, current, hung, current]); const path = join(f.dir, 'attention.jsonl');
    f.options.alert = item => publishAttention(item, { path });
    await runUpgradeCheck(f.options); f.advance(); await runUpgradeCheck(f.options);
    expect(replay({ path })).toHaveLength(1);
  });
  it('settings log provenance and reject unsafe bounds', () => {
    const log = vi.fn();
    expect(resolveSettings({ WE_AGY_UPGRADE_MIN_INTERVAL_MINUTES: '1', WE_AGY_UPGRADE_SMOKE_TIMEOUT_MS: '999999' }, log))
      .toEqual({ enabled: true, minIntervalMinutes: 60, smokeTimeoutMs: 20000 });
    expect(resolveSettings({ WE_AGY_UPGRADE_MIN_INTERVAL_MINUTES: '120', WE_AGY_UPGRADE_SMOKE_TIMEOUT_MS: '1000' }, log))
      .toMatchObject({ minIntervalMinutes: 120, smokeTimeoutMs: 1000 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(env)'));
  });
});

describe('binary health hold', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const health = { state: 'dead', at: new Date(now).toISOString(), version: 'unknown', reason: 'hung' };
  it('fresh dead record holds every model without launching', () => {
    const dir = fresh(); fs.mkdirSync(join(dir, 'binary')); fs.writeFileSync(join(dir, 'binary/health.json'), JSON.stringify(health));
    for (const model of ['sonnet', 'gemini-3.1-pro', undefined])
      expect(readAgyHold(model, { dir, now })).toMatchObject({ fallbackDecision: 'skip-binary-dead', modelEvidence: 'not-launched' });
  });
  it.each([JSON.stringify({ ...health, at: new Date(now - 86400000).toISOString() }),
    JSON.stringify({ ...health, state: 'ok' })])('allows stale dead and valid healthy health (%#)', text => {
    const dir = fresh(); fs.mkdirSync(join(dir, 'binary')); fs.writeFileSync(join(dir, 'binary/health.json'), text);
    expect(readAgyHold('sonnet', { dir, now })).toBeNull();
  });
  it.each(['{', 'null', '[]', '42', JSON.stringify({ ...health, at: new Date(now + 1).toISOString() }),
    JSON.stringify({ ...health, at: 'invalid' }), JSON.stringify({ ...health, state: 'other' }),
    JSON.stringify({ state: 'dead', at: health.at }), JSON.stringify({ ...health, version: 42 }),
    JSON.stringify({ ...health, reason: null }), JSON.stringify({ state: 'ok' })])('holds unreadable or malformed health (%#)', text => {
    const dir = fresh(); fs.mkdirSync(join(dir, 'binary')); fs.writeFileSync(join(dir, 'binary/health.json'), text);
    expect(readAgyHold('sonnet', { dir, now })).toMatchObject({ fallbackDecision: 'skip-binary-dead', reason: expect.stringContaining('health record is unreadable') });
  });
  it('only missing health continues; a present unreadable record holds', () => {
    const dir = fresh(); expect(readAgyHold('sonnet', { dir, now })).toBeNull();
    fs.mkdirSync(join(dir, 'binary/health.json'), { recursive: true });
    expect(readAgyHold('sonnet', { dir, now })).toMatchObject({ fallbackDecision: 'skip-binary-dead', reason: expect.stringContaining('unreadable') });
  });
});
