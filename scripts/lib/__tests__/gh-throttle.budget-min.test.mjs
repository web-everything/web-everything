import { afterEach, beforeEach, expect, it, vi, describe } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as gh from './gh-throttle.window-fixture.mjs';

const KEY = 'gh.throttle.pointsBudgetPerMin';
const ENV = 'WE_GH_THROTTLE_POINTS_BUDGET_PER_MIN';
const NOW = Date.parse('2026-11-24T12:30:00Z');
let dir, file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-budget-min-'));
  file = join(dir, 'overrides.json');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const save = value => writeFileSync(file, JSON.stringify({ [KEY]: value }));
const resolve = env => gh.resolveGhPointsBudgetPerMin(env, { overrideFile: file, lockRoot: dir });
const settingsLog = () => readFileSync(join(dir, 'points-budget-settings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

it('valid env wins over override and retains fractional flooring', () => {
  save(500);
  expect(resolve({ [ENV]: '42.9' })).toBe(42);
});
it('invalid env falls through to the operator override', () => {
  save(500);
  expect(resolve({ [ENV]: 'invalid' })).toBe(500);
  expect(resolve({})).toBe(500);
});
it.each([0, -1, 601, 1.5, '500', null])('invalid override %s falls back to 300', value => {
  save(value);
  expect(resolve({})).toBe(300);
});
it('absent, malformed and unreadable overrides use 300', () => {
  expect(resolve({})).toBe(300);
  writeFileSync(file, '{');
  expect(resolve({})).toBe(300);
  expect(gh.resolveGhPointsBudgetPerMin({}, { overrideFile: dir, lockRoot: dir })).toBe(300);
});
it('env zero keeps main meaning: invalid env falls through, defaulting to 300', () => {
  expect(resolve({ [ENV]: '0' })).toBe(300);
  save(450);
  expect(resolve({ [ENV]: '0' })).toBe(450);
});
it('env over 600 uses 300 with a warning even with a valid override', () => {
  save(500);
  expect(resolve({ [ENV]: '601' })).toBe(300);
  expect(settingsLog()).toContainEqual(expect.objectContaining({ outcome: 'settings_warning', message: expect.stringContaining('600') }));
  expect(process.stderr.write).not.toHaveBeenCalled();
});
it('logs effective source once per process', async () => {
  vi.resetModules();
  const fresh = await import('../gh-throttle.mjs');
  save(450);
  fresh.resolveGhPointsBudgetPerMin({}, { overrideFile: file, lockRoot: dir });
  fresh.resolveGhPointsBudgetPerMin({}, { overrideFile: file, lockRoot: dir });
  expect(settingsLog().filter(row => row.outcome === 'settings')).toEqual([
    expect.objectContaining({ pointsBudgetPerMin: 450, source: 'override' }),
  ]);
  expect(process.stderr.write).not.toHaveBeenCalled();
});

it.each([['env', { [ENV]: '375' }, 375], ['default', {}, 300]])('logs %s provenance without writing to stderr', async (source, env, budget) => {
  vi.resetModules();
  const fresh = await import('../gh-throttle.mjs');
  expect(fresh.resolveGhPointsBudgetPerMin(env, { overrideFile: file, lockRoot: dir })).toBe(budget);
  expect(settingsLog()).toContainEqual(expect.objectContaining({ pointsBudgetPerMin: budget, source }));
  expect(process.stderr.write).not.toHaveBeenCalled();
});

it.each(['invalid', 'malformed', 'unreadable'])('keeps %s override diagnostics in the sidecar', kind => {
  if (kind === 'invalid') save(601);
  if (kind === 'malformed') writeFileSync(file, '{');
  const overrideFile = kind === 'unreadable' ? dir : file;
  expect(gh.resolveGhPointsBudgetPerMin({}, { overrideFile, lockRoot: dir })).toBe(300);
  expect(settingsLog()).toContainEqual(expect.objectContaining({ outcome: 'settings_warning', message: expect.stringContaining('operator-override:') }));
  expect(process.stderr.write).not.toHaveBeenCalled();
});

it('an unwritable settings sidecar never changes resolution or emits stderr', async () => {
  vi.resetModules();
  const fresh = await import('../gh-throttle.mjs');
  const lockRoot = join(dir, 'not-a-directory');
  writeFileSync(lockRoot, 'blocked');
  expect(fresh.resolveGhPointsBudgetPerMin({ [ENV]: '375' }, { lockRoot })).toBe(375);
  expect(fresh.resolveGhPointsBudgetPerMin({ [ENV]: '601' }, { lockRoot })).toBe(300);
  expect(process.stderr.write).not.toHaveBeenCalled();
});

describe.each(['sync', 'cli'])('%s native process output fidelity with budget resolution', mode => {
  it.each(['success', 'rate-limit', 'auth'])('preserves %s stdout, stderr and exit status', outcome => {
    // Pin this lane's module: the installed shim may use a different checkout.
    const moduleUrl = pathToFileURL(resolvePath(dirname(fileURLToPath(import.meta.url)), '../gh-throttle.mjs')).href;
    const status = outcome === 'success' ? 0 : 1;
    const stdout = outcome === 'success' ? 'x'.repeat(3 * 1024 * 1024) : 'partial';
    const stderr = outcome === 'success' ? 'w'.repeat(3 * 1024 * 1024)
      : outcome === 'auth' ? 'HTTP 401: Bad credentials\n' : 'GraphQL: API rate limit already exceeded.\n';
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { runGhSync, runGhCliPassthrough } from ${JSON.stringify(moduleUrl)};
      const status = ${status};
      const stdout = status === 0 ? 'x'.repeat(3 * 1024 * 1024) : 'partial';
      const stderr = ${outcome === 'success' ? "'w'.repeat(3 * 1024 * 1024)" : JSON.stringify(stderr)};
      const throttle = { pointsAlgorithm: 'window', lockRoot: ${JSON.stringify(dir)}, cap: 2, maxAttempts: 1,
        env: { WE_GH_THROTTLE_POINTS_BUDGET_PER_MIN: '375', WE_GH_THROTTLE_NO_BUDGET_PROBE: '1' } };
      if (${JSON.stringify(mode)} === 'cli') {
        const result = runGhCliPassthrough(['api', 'user'], { throttle,
          spawn: () => ({ status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }) });
        process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status;
      } else {
        try {
          const result = runGhSync(['api', 'user'], { throttle: { ...throttle, exec: () => {
            if (status) throw Object.assign(new Error('Command failed'), { status, stdout, stderr });
            process.stderr.write(stderr); return stdout;
          } } });
          process.stdout.write(result);
        } catch (error) {
          process.stdout.write(error.stdout); process.stderr.write(error.stderr); process.exitCode = error.status;
        }
      }
    `], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe(stderr);
    expect(settingsLog()).toContainEqual(expect.objectContaining({ pointsBudgetPerMin: 375, source: 'env' }));
  });
});

const secondary = 'gh: You have exceeded a secondary rate limit. (HTTP 403)';
const headerSecondary = '< HTTP/2.0 429 Too Many Requests\n< Retry-After: 2\n\ngh: rate limit exceeded (HTTP 429)';
function invoke(mode, messages, extra = {}) {
  const sleep = vi.fn();
  const throttle = { lockRoot: dir, cap: 2, budgetPerMin: 300, env: { WE_GH_THROTTLE_NO_BUDGET_PROBE: '1' },
    now: () => NOW, sleep, maxAttempts: 3, retryBaseMs: 7, ...extra };
  let calls = 0;
  const failure = Object.assign(new Error('Command failed'), { status: 1 });
  let result, thrown;
  if (mode === 'sync') {
    try { result = gh.runGhSync(['api', 'user'], { throttle: { ...throttle, exec: () => {
      const text = messages[calls++];
      if (text) { failure.stderr = text; throw failure; }
      return 'ok';
    } } }); } catch (e) { thrown = e; }
  } else {
    result = gh.runGhCliPassthrough(['api', 'user'], { throttle, spawn: () => {
      const text = messages[calls++];
      return { status: text ? 1 : 0, stdout: Buffer.from('ok'), stderr: Buffer.from(text || '') };
    } });
  }
  return { calls, sleep, result, thrown, failure };
}
describe.each(['sync', 'cli'])('%s observational accounting', mode => {
  it.each([secondary, headerSecondary])('counts secondary and preserves main retry/backoff: %s', text => {
    const r = invoke(mode, [text, text, null]);
    expect(r.calls).toBe(3);
    expect(r.sleep.mock.calls).toEqual(text === secondary ? [[7], [14]] : [[2000], [2000]]);
    expect(r.thrown).toBeUndefined();
    expect(mode === 'sync' ? r.result : r.result.status).toBe(mode === 'sync' ? 'ok' : 0);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 2, last60Min: 2 });
  });
  it.each(['gh: API rate limit exceeded. (HTTP 403)', 'plain failure'])('does not count %s', text => {
    const r = invoke(mode, [text]);
    expect(r.calls).toBe(1);
    expect(r.sleep).not.toHaveBeenCalled();
    expect(mode === 'sync' ? r.thrown : r.result.status).toBe(mode === 'sync' ? r.failure : 1);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 0, last60Min: 0 });
  });
  it('exhausted secondary preserves the exact final failure and retry ladder', () => {
    const r = invoke(mode, [secondary, secondary, secondary]);
    expect(r.calls).toBe(3);
    expect(r.sleep.mock.calls).toEqual([[7], [14]]);
    if (mode === 'sync') expect(r.thrown).toBe(r.failure);
    else expect(r.result).toEqual({ status: 1, stdout: Buffer.from('ok'), stderr: Buffer.from(secondary) });
  });
  it('counter write failure never throws or changes the call result', () => {
    mkdirSync(join(dir, 'gh-secondary-hits.json'));
    const r = invoke(mode, [secondary, null]);
    expect(r.calls).toBe(2);
    expect(r.sleep.mock.calls).toEqual([[7]]);
    expect(r.thrown).toBeUndefined();
    expect(mode === 'sync' ? r.result : r.result.status).toBe(mode === 'sync' ? 'ok' : 0);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 0, last60Min: 0 });
  });
});
it('counter persists across reads, crosses UTC hours and prunes 48-hour history', () => {
  const hour = ms => new Date(ms).toISOString().slice(0, 13);
  const old = NOW - 49 * 3600000;
  const previous = NOW - 40 * 60000;
  writeFileSync(join(dir, 'gh-secondary-hits.json'), JSON.stringify({ [hour(old)]: [old], [hour(previous)]: [previous] }));
  invoke('cli', [secondary, null]);
  expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 1, last60Min: 2 });
  expect(JSON.parse(readFileSync(join(dir, 'gh-secondary-hits.json'), 'utf8'))[hour(old)]).toBeUndefined();
  expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW + 3600000 })).toEqual({ currentHour: 0, last60Min: 0 });
});
