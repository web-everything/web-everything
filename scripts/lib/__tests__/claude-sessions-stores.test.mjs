import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultListAgents, listSessions, ownerOf, SessionsUnknown } from '../claude-sessions.mjs';
import { cachedClaudeAgents } from '../claude-agents-cache.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dirs = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sess-stores-')); dirs.push(d); return d; };

const home = '/home/u';
const oneMap = { accounts: { a: { service: 's', account: 'a' } }, daemons: {} };
const twoMap = { accounts: { a: { service: 's', account: 'a' }, b: { configDir: '/home/u/.claude-b' } }, daemons: {},
  routing: { accountB: true } };
const base = map => ({ env: {}, map, home, exists: () => true, realpath: p => p });

it('single store: same argv, same child env, rows equal today plus storeKey', () => {
  const exec = vi.fn(() => JSON.stringify([{ sessionId: A, id: 'j1', state: 'running' }]));
  const env = { PATH: '/x', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
  const rows = defaultListAgents({ ...base(oneMap), env, exec, all: true });
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][0]).toBe('claude');
  expect(exec.mock.calls[0][1]).toEqual(['agents', '--json', '--all']);
  expect(exec.mock.calls[0][2].env).toBe(env);
  expect(rows).toEqual([{ sessionId: A, id: 'j1', state: 'running', storeKey: '/home/u/.claude' }]);
});

it('two stores, one unreadable: aggregate unknown, rows tagged, positive rows kept', () => {
  const exec = vi.fn((_c, _a, o) => {
    if (o.env.CLAUDE_CONFIG_DIR === '/home/u/.claude-b') throw new Error('boom');
    return JSON.stringify([{ sessionId: A }]);
  });
  const agg = listSessions({ ...base(twoMap), exec, env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' } });
  expect(agg.status).toBe('unknown');
  expect(agg.rows.map(r => [r.sessionId, r.storeKey])).toEqual([[A, '/home/u/.claude']]);
  expect(agg.problems.join()).toContain('/home/u/.claude-b');
  let err;
  try { defaultListAgents({ ...base(twoMap), exec, env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' } }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(SessionsUnknown);
  expect(err.rows).toHaveLength(1);
});

it('unreadable map is unknown, never an empty list', () => {
  const exec = vi.fn(() => '[]');
  expect(listSessions({ ...base(null), exec }).status).toBe('unknown');
  expect(() => defaultListAgents({ ...base(null), exec })).toThrow(SessionsUnknown);
});

it('two healthy stores: ok, each listed with its own CONFIG_DIR, owner resolves to its store', () => {
  const exec = vi.fn((_c, _a, o) => JSON.stringify([{ sessionId: o.env.CLAUDE_CONFIG_DIR.endsWith('-b') ? B : A }]));
  const o = { ...base(twoMap), exec, env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' } };
  expect(listSessions(o).status).toBe('ok');
  expect(ownerOf(B, o)).toMatchObject({ kind: 'found', store: '/home/u/.claude-b' });
  expect(ownerOf('99999999', o)).toEqual({ kind: 'absent' });
});

it('absence is unknown (never absent) when a store is unreadable', () => {
  const exec = (_c, _a, o) => { if (o.env.CLAUDE_CONFIG_DIR.endsWith('-b')) throw new Error('x'); return '[]'; };
  expect(ownerOf(A, { ...base(twoMap), exec, env: {} }).kind).toBe('unknown');
});

it('cache: store key separates entries; single store keeps the legacy key; legacy entries ignored for a store key', () => {
  const dir = tmp();
  const o = { dir, env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '1000' }, now: () => 5 };
  cachedClaudeAgents({ ...o, fetch: () => '[1]' });
  const legacy = readdirSync(dir);
  const fetchB = vi.fn(() => '[2]');
  expect(cachedClaudeAgents({ ...o, storeKey: '/s/b', fetch: fetchB })).toBe('[2]');
  expect(cachedClaudeAgents({ ...o, storeKey: '/s/b', fetch: fetchB })).toBe('[2]');
  expect(fetchB).toHaveBeenCalledTimes(1);
  expect(readdirSync(dir)).toHaveLength(legacy.length + 1);
  expect(cachedClaudeAgents({ ...o, fetch: () => 'unused' })).toBe('[1]');
  writeFileSync(join(dir, legacy[0]), 'garbage');
  expect(cachedClaudeAgents({ ...o, fetch: () => '[3]' })).toBe('[3]');
});

it('fresh bypasses the cache', () => {
  const o = { dir: tmp(), env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '1000' }, now: () => 5 };
  cachedClaudeAgents({ ...o, fetch: () => '[1]' });
  expect(cachedClaudeAgents({ ...o, fresh: true, fetch: () => '[2]' })).toBe('[2]');
});

it('empty stdout is invalid (unknown), never an empty list', () => {
  const o = { ...base(oneMap), exec: () => '', env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' } };
  expect(listSessions(o).status).toBe('unknown');
  expect(ownerOf(A, o).kind).toBe('unknown');
});

it('ownerOf lists with --all so completed sessions are found', () => {
  const exec = vi.fn((_c, a) => JSON.stringify(a.includes('--all') ? [{ sessionId: A }] : []));
  expect(ownerOf(A, { ...base(oneMap), exec, env: {} }).kind).toBe('found');
});

it('home defaults to the supplied env.HOME, not the parent process home', () => {
  const seen = [];
  const exists = p => { seen.push(p); return true; };
  listSessions({ env: { HOME: '/alt-home', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' }, map: oneMap, exists, realpath: p => p,
    exec: () => '[]' });
  expect(seen).toContain('/alt-home/.claude');
});

it('ownerOf ignores a caller all:false', () => {
  const exec = vi.fn((_c, a) => JSON.stringify(a.includes('--all') ? [{ sessionId: A }] : []));
  expect(ownerOf(A, { ...base(oneMap), exec, env: {}, all: false }).kind).toBe('found');
});
