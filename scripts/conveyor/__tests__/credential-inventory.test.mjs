import { describe, it, expect } from 'vitest';
import { collectCredentialInventory as collect, normalizeInventory, DEFAULT_REPOS } from '../credential-inventory.mjs';
const now = Date.parse('2026-10-01T12:00:00Z');
const run = (overrides = {}) => ({ id: 42, run_attempt: 1, name: 'CI', status: 'completed', conclusion: 'failure', updated_at: new Date(now - 1000).toISOString(), ...overrides });
const secret = (name = 'FUI_READ_TOKEN') => ({ name, updated_at: '2026-01-01T00:00:00Z', value: 'SECRET_CANARY' });
function runner({ secrets = [secret()], runs = [run()], logs = 'step Bad credentials SECRET_CANARY', error } = {}) {
  const calls = [];
  const exec = (cmd, args, options) => {
    calls.push(args);
    expect(cmd).toBe('gh'); expect(options.timeout).toBeGreaterThan(0); expect(options.maxBuffer).toBeGreaterThan(0);
    if (args[0] === 'run') { if (error) throw error; return logs; }
    expect(args.slice(0, 3)).toEqual(['api', '--method', 'GET']);
    return JSON.stringify(args[3].includes('/secrets?') ? { secrets, total_count: secrets.length } : { workflow_runs: runs, total_count: runs.length });
  };
  return { exec, calls };
}
describe('credential metadata collector', () => {
  it('collects all repositories, projects allowlists and never retains logs or extra API fields', () => {
    const { exec, calls } = runner(); const result = collect({ now, exec });
    expect(result.repositories).toHaveLength(3); expect(result.secrets).toHaveLength(3);
    expect(result.secrets.map((r) => r.repo)).toEqual([...DEFAULT_REPOS].sort());
    expect(result.ciFindings.every((r) => r.badCredentials)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
    expect(calls.filter((a) => a[0] === 'run')[0]).toEqual(['run', 'view', '42', '--repo', 'frontier-ui/frontierui', '--attempt', '1', '--log-failed']);
  });
  it('paginates secrets and deduplicates; retains partial rows on a later denial', () => {
    const page = Array.from({ length: 100 }, (_, i) => secret(`S_${i}`));
    const exec = (_cmd, args) => {
      if (args[3].includes('/runs?')) return JSON.stringify({ total_count: 0, workflow_runs: [] });
      if (args[3].endsWith('page=2')) throw { stderr: 'HTTP 403 SECRET_CANARY' };
      return JSON.stringify({ total_count: 101, secrets: page });
    };
    const result = collect({ now, repos: ['a/b'], exec });
    expect(result.secrets).toHaveLength(100); expect(result.repositories[0].secrets).toEqual({ complete: false, errors: ['denied'] });
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
    const complete = collect({ now, repos: ['a/b'], exec: (_c, a) => a[3].includes('/runs?') ? JSON.stringify({ total_count: 0, workflow_runs: [] }) : JSON.stringify({ total_count: 101, secrets: a[3].endsWith('page=2') ? [page[0], secret('LAST')] : page }) });
    expect(complete.secrets).toHaveLength(101); expect(complete.repositories[0].secrets.complete).toBe(true);
  });
  it.each(['401', 'test failed'])('does not classify %s as authentication failure', (logs) => {
    expect(collect({ now, exec: runner({ logs }).exec }).ciFindings.every((r) => !r.badCredentials)).toBe(true);
  });
  it('filters successful and old runs, includes the exact lookback edge, and limits scan coverage', () => {
    const runs = [run({ id: 1, conclusion: 'success' }), run({ id: 2, updated_at: new Date(now - 86400001).toISOString() }), run({ id: 3, updated_at: new Date(now - 86400000).toISOString() }), run({ id: 4 })];
    const result = collect({ now, repos: ['a/b'], runLimit: 1, exec: runner({ runs }).exec });
    expect(result.ciFindings.map((r) => r.runId)).toEqual([3]); expect(result.repositories[0].ci.errors).toEqual(['incomplete']);
  });
  it('reuses only successful run/attempt observations and retries missing logs', () => {
    const initial = collect({ now, repos: ['a/b'], exec: runner().exec });
    const cached = runner(); collect({ now: now + 1000, repos: ['a/b'], cache: initial.ciFindings, exec: cached.exec });
    expect(cached.calls.filter((a) => a[0] === 'run')).toHaveLength(0);
    const next = runner({ runs: [run({ run_attempt: 2 })] }); collect({ now, repos: ['a/b'], cache: initial.ciFindings, exec: next.exec });
    expect(next.calls.filter((a) => a[0] === 'run')).toHaveLength(1);
    const failed = collect({ now, repos: ['a/b'], exec: runner({ error: new Error('SECRET_CANARY') }).exec });
    expect(failed.ciFindings).toEqual([]); expect(failed.repositories[0].ci.complete).toBe(false);
    const retry = runner(); collect({ now, repos: ['a/b'], cache: failed.ciFindings, exec: retry.exec });
    expect(retry.calls.filter((a) => a[0] === 'run')).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain('SECRET_CANARY');
  });
  it.each([['ETIMEDOUT', 'timeout'], ['ENOBUFS', 'output-limit'], ['OTHER', 'unavailable']])('bounds error %s', (code, expected) => {
    const result = collect({ now, repos: ['a/b'], exec: () => { throw { code, message: 'SECRET_CANARY' }; } });
    expect(result.repositories[0].secrets.errors).toEqual([expected]); expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
  });
  it('distinguishes empty, malformed, truncated, oversized and exhausted-budget responses', () => {
    expect(collect({ now, exec: runner({ secrets: [], runs: [] }).exec }).repositories.every((r) => r.secrets.complete && r.ci.complete)).toBe(true);
    for (const [raw, code] of [['bad SECRET_CANARY', 'malformed'], [JSON.stringify({ total_count: 2, secrets: [secret()] }), 'incomplete']]) {
      expect(collect({ now, repos: ['a/b'], exec: () => raw }).repositories[0].secrets.errors).toEqual([code]);
    }
    expect(collect({ now, repos: ['a/b'], maxBytes: 1, exec: () => 'xx' }).repositories[0].secrets.errors).toEqual(['output-limit']);
    expect(collect({ now, repos: ['a/b'], budgetMs: 0, exec: () => { throw Error('must not run'); } }).repositories[0].secrets.errors).toEqual(['timeout']);
    expect(normalizeInventory({ secrets: [ { repo: 'a/b', ...secret() }, { repo: 'a/b', ...secret(), updated_at: 'invalid' }] }).secrets[0].updated_at).toBeNull();
  });
});
