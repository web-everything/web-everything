// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
it.each(['bad', '0', '-1', '1.5', '', 'Infinity', '601'])('invalid env %s refuses to default 300, even with a valid override', value => {
  save(500);
  expect(resolve({ [ENV]: value })).toEqual({ budget: 300, source: 'default' });
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
it('absent, malformed and unreadable override stores fall back to 300', () => {
  expect(resolve()).toEqual({ budget: 300, source: 'default' });
  writeFileSync(file, '{');
  expect(resolve()).toEqual({ budget: 300, source: 'default' });
  expect(gh.resolveGhPointsBudgetPerMinDetailed({}, { overrideFile: dir })).toEqual({ budget: 300, source: 'default' });
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
function invoke(mode, messages, extra = {}) {
  const sleep = vi.fn();
  const throttle = { env: { WE_GH_THROTTLE_NO_BUDGET_PROBE: '1' }, lockRoot: dir, cap: 2,
    budgetPerMin: 300, now: () => NOW, maxAttempts: 2, retryBaseMs: 1, sleep, ...extra };
  let calls = 0;
  const next = () => messages[calls++];
  if (mode === 'sync') {
    gh.runGhSync(['api', 'user'], { throttle: { ...throttle, exec: () => {
      const text = next();
      if (text) throw Object.assign(new Error(text), { stderr: text, status: 1 });
      return 'ok';
    } } });
  } else {
    gh.runGhCliPassthrough(['api', 'user'], { throttle, spawn: () => {
      const text = next();
      return { status: text ? 1 : 0, stdout: Buffer.from('ok'), stderr: Buffer.from(text || '') };
    } });
  }
  return { sleep, calls };
}
describe.each(['sync', 'cli'])('%s secondary refusal accounting', mode => {
  it('does not count primary exhaustion', () => {
    try { invoke(mode, [primary]); } catch (error) { expect(error.stderr).toBe(primary); }
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 0, last60Min: 0 });
  });
  it.each([secondary, 'gh: abuse detection mechanism (HTTP 429)', retryHeader])('counts a secondary refusal and honours Retry-After: %s', message => {
    const result = invoke(mode, [message, null]);
    expect(result.calls).toBe(2);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 1, last60Min: 1 });
    if (message === retryHeader) expect(result.sleep).toHaveBeenCalledWith(2000);
  });
  it('Retry-After takes precedence over primary wording and headers', () => {
    const text = `< HTTP/2.0 403 Forbidden\n< Retry-After: 2\n< X-Ratelimit-Remaining: 0\n< X-Ratelimit-Reset: ${Math.floor(NOW / 1000) + 3600}\n\n${primary}`;
    const result = invoke(mode, [text, null]);
    expect(result.calls).toBe(2);
    expect(result.sleep).toHaveBeenCalledWith(2000);
    expect(gh.readGhSecondaryHits({ lockRoot: dir, nowMs: NOW })).toEqual({ currentHour: 1, last60Min: 1 });
  });
  it('counts the final refused attempt too', () => {
    try { invoke(mode, [secondary, secondary]); } catch (error) { expect(error.stderr).toBe(secondary); }
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
