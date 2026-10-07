import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedClaudeAgents, claudeAgentsCacheTtlMs } from '../claude-agents-cache.mjs';

const dirs = [];
function setup(ttl = '20') {
  const dir = mkdtempSync(join(tmpdir(), 'agents-cache-test-'));
  dirs.push(dir);
  return { dir, env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: ttl }, now: () => 100, fetch: vi.fn(() => '[]') };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
it('reuses raw stdout within TTL and refetches at expiry', () => {
  const o = setup();
  o.fetch.mockReturnValue(Buffer.from('[1]\n'));
  expect(cachedClaudeAgents(o)).toBe('[1]\n');
  expect(cachedClaudeAgents({ ...o, now: () => 119 })).toBe('[1]\n');
  expect(o.fetch).toHaveBeenCalledTimes(1);
  cachedClaudeAgents({ ...o, now: () => 120 });
  expect(o.fetch).toHaveBeenCalledTimes(2);
});
it('disables caching for zero and invalid TTLs and defaults off in Vitest', () => {
  for (const ttl of ['0', '-1', 'invalid']) {
    const o = setup(ttl);
    cachedClaudeAgents(o); cachedClaudeAgents(o);
    expect(o.fetch).toHaveBeenCalledTimes(2);
    expect(readdirSync(o.dir)).toEqual([]);
  }
  expect(claudeAgentsCacheTtlMs({ VITEST: 'true' })).toBe(0);
  expect(claudeAgentsCacheTtlMs({})).toBe(20000);
});
it('rethrows fetch errors without caching or returning stale data', () => {
  const o = setup();
  const error = new Error('fetch failed');
  o.fetch.mockImplementation(() => { throw error; });
  expect(() => cachedClaudeAgents(o)).toThrow(error);
  expect(readdirSync(o.dir)).toEqual([]);
  o.fetch.mockReturnValue('[]');
  cachedClaudeAgents(o);
  o.fetch.mockImplementation(() => { throw error; });
  expect(() => cachedClaudeAgents({ ...o, now: () => 120 })).toThrow(error);
});
it('does not cache non-array or invalid JSON', () => {
  for (const stdout of ['{}', 'bad json']) {
    const o = setup(); o.fetch.mockReturnValue(stdout);
    expect(cachedClaudeAgents(o)).toBe(stdout);
    cachedClaudeAgents(o);
    expect(o.fetch).toHaveBeenCalledTimes(2);
    expect(readdirSync(o.dir)).toEqual([]);
  }
});
it('separates all sessions and leaves no temporary files after atomic writes', () => {
  const o = setup();
  cachedClaudeAgents(o);
  cachedClaudeAgents({ ...o, all: true });
  cachedClaudeAgents(o);
  cachedClaudeAgents({ ...o, all: true });
  expect(o.fetch).toHaveBeenCalledTimes(2);
  const files = readdirSync(o.dir).sort();
  expect(files).toHaveLength(2);
  expect(files[0]).toMatch(/^agents-all-[0-9a-f]{12}\.json$/);
  expect(files[1]).toMatch(/^agents-[0-9a-f]{12}\.json$/);
});

it('scopes the cache file to PATH/HOME/CLAUDE_CONFIG_DIR so a faked `claude` never shares the live cache', () => {
  const o = setup();
  o.fetch.mockReturnValue('[1]');
  cachedClaudeAgents({ ...o, env: { ...o.env, PATH: '/real/bin' } });
  const fake = vi.fn(() => '[2]');
  expect(cachedClaudeAgents({ ...o, fetch: fake, env: { ...o.env, PATH: '/fake/bin' } })).toBe('[2]');
  expect(fake).toHaveBeenCalledTimes(1);
});

it('suppresses real state with WE_UNDER_TEST alone', () => {
  expect(claudeAgentsCacheTtlMs({ WE_UNDER_TEST: '1' })).toBe(0);
});
