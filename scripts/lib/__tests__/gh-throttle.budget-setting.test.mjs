// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gh from '../gh-throttle.mjs';
import { CAPACITY_LEAVES, readOperatorOverrides } from '../operator-override-reader.mjs';

const KEY = 'gh.throttle.pointsBudgetPerMin';
const ENV = 'WE_GH_THROTTLE_POINTS_BUDGET_PER_MIN';
const NOW = Date.parse('2026-11-24T12:30:00Z');
let dir, file, stderr;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-budget-setting-'));
  file = join(dir, 'overrides.json');
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const save = value => writeFileSync(file, JSON.stringify({ [KEY]: value }));
const resolve = (env = {}) => gh.resolveGhPointsBudgetPerMinDetailed(env, { overrideFile: file });

it('logs the effective budget and source once per process', () => {
  expect(resolve()).toEqual({ budget: 300, source: 'default' });
  resolve();
  expect(stderr.mock.calls.filter(([s]) => s.includes('pointsBudgetPerMin=300 source=default'))).toHaveLength(1);
});
it('env wins over operator override; legacy resolver returns a number', () => {
  save(500);
  expect(resolve()).toEqual({ budget: 500, source: 'override' });
  expect(resolve({ [ENV]: '450' })).toEqual({ budget: 450, source: 'env' });
  expect(gh.resolveGhPointsBudgetPerMin({ [ENV]: '450' })).toBe(450);
  save(400);
  expect(resolve()).toEqual({ budget: 400, source: 'override' });
});
it.each(['bad', '-1', '', 'Infinity', '601'])('invalid env %s falls through to a valid override', value => {
  save(500);
  expect(resolve({ [ENV]: value })).toEqual({ budget: 500, source: 'override' });
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid env'));
});
it.each(['bad', '500', 0, -1, 1.5, null, true, 601])('invalid override %s falls back to 300 and warns', value => {
  save(value);
  expect(resolve()).toEqual({ budget: 300, source: 'default' });
  expect(stderr).toHaveBeenCalled();
});
it.each([1, 300, 600])('accepts integer boundary/default %s from either source', budget => {
  save(budget);
  expect(resolve()).toEqual({ budget, source: 'override' });
  expect(resolve({ [ENV]: String(budget) })).toEqual({ budget, source: 'env' });
});
it('zero env wins over an override and positive env fractions retain main flooring', () => {
  save(500);
  expect(resolve({ [ENV]: '0' })).toEqual({ budget: 0, source: 'env' });
  expect(resolve({ [ENV]: '1.5' })).toEqual({ budget: 1, source: 'env' });
});
it('absent, malformed and unreadable override stores fall back to 300', () => {
  expect(resolve()).toEqual({ budget: 300, source: 'default' });
  writeFileSync(file, '{');
  expect(resolve()).toEqual({ budget: 300, source: 'default' });
  expect(gh.resolveGhPointsBudgetPerMinDetailed({}, { overrideFile: dir })).toEqual({ budget: 300, source: 'default' });
});
it.each(['symlink', 'fifo', 'oversized'])('skips a %s override store with a warning', kind => {
  if (kind === 'symlink') {
    const target = join(dir, 'target.json');
    writeFileSync(target, JSON.stringify({ [KEY]: 500 }));
    symlinkSync(target, file);
  } else if (kind === 'fifo') execFileSync('mkfifo', [file]);
  else writeFileSync(file, JSON.stringify({ [KEY]: 500, padding: ' '.repeat(64 * 1024) }));
  expect(resolve()).toEqual({ budget: 300, source: 'default' });
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('using 300'));
});
it.each(['bad', '', '601'])('invalid env %s without an override uses 300', value => {
  expect(resolve({ [ENV]: value })).toEqual({ budget: 300, source: 'default' });
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid env'));
});
it('registers the bounded capacity leaf and reads it with the builtin-only reader', () => {
  expect(CAPACITY_LEAVES[KEY]).toMatchObject({ direction: 'cap', failClosedFallback: 300 });
  save(600);
  expect(readOperatorOverrides({ file }).values[KEY]).toBe(600);
  save(601);
  expect(readOperatorOverrides({ file, log: () => {} }).values[KEY]).toBeUndefined();
});
it('keeps the separate write budget unchanged', () => {
  expect(gh.DEFAULT_GH_WRITE_BUDGET_PER_MIN).toBe(40);
  expect(gh.resolveGhWriteBudgetPerMin({ [ENV]: '600' })).toBe(40);
});

const secondary = 'gh: You have exceeded a secondary rate limit. (HTTP 403)';
const primary = 'gh: API rate limit exceeded. (HTTP 403)';
const retryHeader = '< HTTP/2.0 429 Too Many Requests\n< Retry-After: 2\n\ngh: request refused (HTTP 429)';
function invoke(mode, messages, extra = {}, args = ['api', 'user']) {
  const sleep = vi.fn();
  const throttle = { env: { WE_GH_THROTTLE_NO_BUDGET_PROBE: '1' }, lockRoot: dir, cap: 2,
    budgetPerMin: 300, now: () => NOW, maxAttempts: 2, retryBaseMs: 1, sleep, ...extra };
  let calls = 0;
  const next = () => messages[calls++];
  let status = 0, failure;
  if (mode === 'sync') {
    try { gh.runGhSync(args, { throttle: { ...throttle, exec: () => {
      const text = next();
      if (text) throw Object.assign(new Error(text), { stderr: text, status: 1 });
      return 'ok';
    } } }); } catch (error) { status = error.status; failure = error; }
  } else {
    const result = gh.runGhCliPassthrough(args, { throttle, spawn: () => {
      const text = next();
      return { status: text ? 1 : 0, stdout: Buffer.from('ok'), stderr: Buffer.from(text || '') };
    } });
    status = result.status;
    failure = result.stderr.toString();
  }
  return { sleep, calls, status, failure };
}
describe.each(['sync', 'cli'])('%s secondary refusal accounting', mode => {
  it('does not count primary exhaustion', () => {
    const result = invoke(mode, [primary]);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 0, last60Min: 0 });
  });
  it.each([secondary, 'gh: abuse detection mechanism (HTTP 429)', retryHeader])('counts a secondary refusal and honours Retry-After: %s', message => {
    const result = invoke(mode, [message, null]);
    expect(result.calls).toBe(2);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 1, last60Min: 1 });
    if (message === retryHeader) expect(result.sleep).toHaveBeenCalledWith(2000);
  });
  it.each(['text', 'headers', 'both'])('records primary exhaustion despite Retry-After (%s)', evidence => {
    const text = `< HTTP/2.0 403 Forbidden\n< Retry-After: 2\n${evidence !== 'text' ? `< X-Ratelimit-Remaining: 0\n< X-Ratelimit-Reset: ${Math.floor(NOW / 1000) + 3600}\n` : ''}\n${evidence !== 'headers' ? primary : 'gh: refused (HTTP 403)'}`;
    const result = invoke(mode, [text, null]);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.sleep).not.toHaveBeenCalled();
    expect(gh.readBudgetBlock(dir, gh.ghAuthIdentity({}), 'core', NOW)).not.toBeNull();
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW }).last60Min).toBe(0);
  });
  it.each([
    ['REST', ['api', '--method', 'POST', 'user'], 'core'],
    ['GraphQL', ['api', 'graphql', '-f', 'query=mutation { test }'], 'graphql'],
  ])('records primary exhaustion for a %s write without replaying it', (_kind, args, resource) => {
    const text = `< HTTP/2.0 403 Forbidden\n< X-Ratelimit-Remaining: 0\n< X-Ratelimit-Reset: ${Math.floor(NOW / 1000) + 3600}\n\ngh: refused (HTTP 403)`;
    const result = invoke(mode, [text, null], {}, args);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.sleep).not.toHaveBeenCalled();
    expect(gh.readBudgetBlock(dir, gh.ghAuthIdentity({}), resource, NOW)).not.toBeNull();
  });
  it.each(['explicit', 'env'])('a zero %s budget blocks a reserved read before execution', source => {
    let clock = NOW;
    const throttle = { lockRoot: dir, cap: 2, reservedSlot: true, caller: 'red-main-freeze-read',
      env: { WE_GH_THROTTLE_NO_BUDGET_PROBE: '1', ...(source === 'env' ? { [ENV]: '0' } : {}) },
      ...(source === 'explicit' ? { budgetPerMin: 0 } : {}),
      now: () => clock, sleep: ms => { clock += ms; }, reservedTimeoutMs: 2000 };
    const args = ['api', '-i', 'repos/o/r/git/ref/heads/main'];
    const execute = vi.fn(() => mode === 'sync' ? '[]' : { status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) });
    if (mode === 'sync') {
      expect(() => gh.runGhSync(args, { timeout: 2000, throttle: { ...throttle, exec: execute } })).toThrow(/throttled/);
    } else {
      const result = gh.runGhCliPassthrough(args, { throttle, spawn: execute });
      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toMatch(/throttled/);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(clock - NOW).toBeLessThanOrEqual(2000);
  });
  it.each(['', 'nonsense'])('invalid Retry-After %s does not count as secondary', header => {
    const result = invoke(mode, [`< HTTP/2.0 403 Forbidden\n< Retry-After: ${header}\n\ngh: refused (HTTP 403)`, null]);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.sleep).not.toHaveBeenCalled();
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW }).last60Min).toBe(0);
  });
  it.each([
    [500, ['api', 'user']],
    [403, ['api', '--method', 'POST', 'user']],
    [403, ['api', 'graphql', '-f', 'query=mutation { test }']],
  ])('does not replay HTTP %s for %j with Retry-After', (code, args) => {
    const result = invoke(mode, [`< HTTP/2.0 ${code} Refused\n< Retry-After: 2\n\ngh: refused (HTTP ${code})`, null], {}, args);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.sleep).not.toHaveBeenCalled();
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW }).last60Min).toBe(0);
  });
  it.each([601, -1, '500', NaN, null])('invalid explicit budget %s uses 300 and warns', budgetPerMin => {
    const result = invoke(mode, [null], { budgetPerMin, points: 300 });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.sleep).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid throttle.budgetPerMin'));
    let clock = NOW;
    const sleep = vi.fn(ms => { clock += ms; });
    const next = invoke(mode, [null], { budgetPerMin, points: 1, now: () => clock, sleep });
    expect(next.status).toBe(0);
    expect(next.calls).toBe(1);
    expect(sleep).toHaveBeenCalled();
  });
  it('keeps an explicit fractional budget without rounding it up to 300', () => {
    let clock = NOW;
    const sleep = vi.fn(ms => { clock += ms; });
    expect(invoke(mode, [null], { budgetPerMin: 1.5, points: 1.5 }).calls).toBe(1);
    expect(invoke(mode, [null], { budgetPerMin: 1.5, points: 1, now: () => clock, sleep }).calls).toBe(1);
    expect(sleep).toHaveBeenCalled();
  });
  it('counts the final refused attempt too', () => {
    const result = invoke(mode, [secondary, secondary]);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(2);
    expect(mode === 'sync' ? result.failure.stderr : result.failure).toBe(secondary);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 2, last60Min: 2 });
  });
  it('counter write failure never throws or delays a successful retry', () => {
    mkdirSync(join(dir, 'gh-secondary-hits.json'));
    const result = invoke(mode, [secondary, null]);
    expect(result.calls).toBe(2);
    expect(result.sleep.mock.calls).toEqual([[1]]);
  });
});
it('persists UTC-hour buckets, counts across hour boundaries and prunes after 48 hours', () => {
  invoke('sync', [secondary, null], { now: () => NOW - 40 * 60000 });
  invoke('cli', [secondary, null]);
  expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 1, last60Min: 2 });
  expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW + 21 * 60000 })).toEqual({ currentHour: 1, last60Min: 1 });
  invoke('sync', [secondary, null], { now: () => NOW + 49 * 3600000 });
  const stored = JSON.parse(readFileSync(join(dir, 'gh-secondary-hits.json'), 'utf8'));
  expect(Object.keys(stored)).toEqual(['2026-11-26T13']);
});
it('reader fails open on missing or corrupt counters', () => {
  expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 0, last60Min: 0 });
  writeFileSync(join(dir, 'gh-secondary-hits.json'), '{');
  expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 0, last60Min: 0 });
});
