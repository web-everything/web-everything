// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runPreflight, formatPreflight } from '../daemon-preflight.mjs';

const NOW = 1_800_000_000_000;
const ENV = Object.freeze({ DAEMON_KEY: 'fixture/key', SECOND_KEY: 'fixture/second-key' });
const SHA = 'a'.repeat(40);
const NAMES = [
  'role', 'tool:node', 'tool:claude', 'tool:gh', 'tool:codex',
  'keyfile:DAEMON_KEY', 'keyfile:SECOND_KEY',
  'clone-head:fixture/clone-a', 'clone-head:fixture/clone-b',
  'platform-preferences', 'ssh:forge',
];

function fixture(overrides = {}) {
  const calls = [];
  const members = {
    resolveRole: () => ({ role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote' }),
    which: () => true,
    keyFiles: (env) => [
      { name: 'DAEMON_KEY', path: env.DAEMON_KEY },
      { name: 'SECOND_KEY', path: env.SECOND_KEY },
    ],
    statFile: () => true,
    cloneDirs: () => ['fixture/clone-a', 'fixture/clone-b'],
    readHead: () => SHA,
    parsePreferences: () => ({}),
    sshForge: () => ({ status: 0 }),
    ...overrides,
  };
  const io = new Proxy(members, {
    get(target, name) {
      if (!Object.hasOwn(target, name)) throw new Error(`unexpected IO member: ${String(name)}`);
      return (...args) => { calls.push({ name, args }); return target[name](...args); };
    },
  });
  return { io, calls };
}

const run = (io) => runPreflight({ thisHost: 'daemon-a', io, env: ENV, now: NOW });

describe('daemon preflight read-only checks', () => {
  it('every preflight check passes in the specified order through injected IO', async () => {
    const { io, calls } = fixture();
    const result = await run(io);
    expect(result.ok).toBe(true);
    expect(result.checks.map(({ name }) => name)).toEqual(NAMES);
    for (const check of result.checks) {
      expect(check).toEqual({ name: check.name, ok: true, detail: expect.any(String) });
    }
    expect(result.checks[0].detail).toBe('role=active reason=fresh-owner-is-this-host');
    expect(calls.filter(({ name }) => name === 'which').map(({ args }) => args[0]))
      .toEqual(['node', 'claude', 'gh', 'codex']);
    expect(calls.find(({ name }) => name === 'keyFiles').args).toEqual([ENV]);
    expect(calls.filter(({ name }) => name === 'statFile').map(({ args }) => args[0]))
      .toEqual([ENV.DAEMON_KEY, ENV.SECOND_KEY]);
    expect(calls.filter(({ name }) => name === 'readHead').map(({ args }) => args[0]))
      .toEqual(['fixture/clone-a', 'fixture/clone-b']);
  });

  it('standby role is a valid reportable state and passes', async () => {
    const { io } = fixture({ resolveRole: () => ({
      role: 'standby', reason: 'owner-is-other-host', source: 'remote',
    }) });
    const result = await run(io);
    expect(result.ok).toBe(true);
    expect(result.checks[0]).toEqual({
      name: 'role', ok: true, detail: 'role=standby reason=owner-is-other-host',
    });
  });

  it.each(['node', 'claude', 'gh', 'codex'])('missing tool:%s fails only that check', async (tool) => {
    const { io } = fixture({ which: (name) => name !== tool });
    const result = await run(io);
    expect(result.ok).toBe(false);
    expect(result.checks.filter(({ ok }) => !ok).map(({ name }) => name)).toEqual([`tool:${tool}`]);
    expect(result.checks.map(({ name }) => name)).toEqual(NAMES);
  });

  it.each(['DAEMON_KEY', 'SECOND_KEY'])('missing keyfile:%s fails its stat-only check', async (name) => {
    const { io } = fixture({ statFile: (path) => path !== ENV[name] });
    const result = await run(io);
    expect(result.ok).toBe(false);
    expect(result.checks.filter(({ ok }) => !ok).map(({ name }) => name)).toEqual([`keyfile:${name}`]);
  });

  it.each([1, 255, null])('ssh:forge fails closed for nonzero or unknown status %j', async (status) => {
    const { io } = fixture({ sshForge: () => ({ status }) });
    const result = await run(io);
    expect(result.ok).toBe(false);
    expect(result.checks.filter(({ ok }) => !ok).map(({ name }) => name)).toEqual(['ssh:forge']);
  });

  it.each([
    ['resolveRole', 'role'],
    ['which', 'tool:node', 'node'], ['which', 'tool:claude', 'claude'],
    ['which', 'tool:gh', 'gh'], ['which', 'tool:codex', 'codex'],
    ['statFile', 'keyfile:DAEMON_KEY', ENV.DAEMON_KEY],
    ['statFile', 'keyfile:SECOND_KEY', ENV.SECOND_KEY],
    ['readHead', 'clone-head:fixture/clone-a', 'fixture/clone-a'],
    ['readHead', 'clone-head:fixture/clone-b', 'fixture/clone-b'],
    ['parsePreferences', 'platform-preferences'], ['sshForge', 'ssh:forge'],
  ])('%s throwing fails only %s and remaining checks continue', async (method, checkName, argument) => {
    const success = { which: true, statFile: true, readHead: SHA };
    const { io } = fixture({
      [method]: (...args) => {
        if (argument === undefined || args[0] === argument) throw new Error('fixture unreadable');
        return success[method];
      },
    });
    const result = await run(io);
    expect(result.ok).toBe(false);
    expect(result.checks.map(({ name }) => name)).toEqual(NAMES);
    expect(result.checks.filter(({ ok }) => !ok)).toEqual([
      { name: checkName, ok: false, detail: expect.any(String) },
    ]);
    expect(result.checks.find(({ name }) => name === checkName).detail).toContain('fixture unreadable');
  });

  it('empty keyfile and clone lists add no invented checks', async () => {
    const { io } = fixture({ keyFiles: () => [], cloneDirs: () => [] });
    const result = await run(io);
    expect(result.ok).toBe(true);
    expect(result.checks.map(({ name }) => name)).toEqual([
      'role', 'tool:node', 'tool:claude', 'tool:gh', 'tool:codex', 'platform-preferences', 'ssh:forge',
    ]);
  });

  it('no writes: Proxy allows only listed read functions and keyfile presence is stat only', async () => {
    const { io, calls } = fixture();
    await run(io);
    expect([...new Set(calls.map(({ name }) => name))].sort()).toEqual([
      'cloneDirs', 'keyFiles', 'parsePreferences', 'readHead', 'resolveRole', 'sshForge', 'statFile', 'which',
    ]);
    expect(calls.some(({ name }) => /write|mkdir|append|unlink|rename|readFile/i.test(name))).toBe(false);
  });

  it('no writes: module source contains none of the forbidden mutation APIs', () => {
    const source = readFileSync(new URL('../daemon-preflight.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/writeFile|appendFile|mkdir|unlink|rename/);
  });
});

describe('preflight formatting and exit-code semantics', () => {
  it('all passing checks expose ok=true for exit 0 and format as ok lines', async () => {
    const { io } = fixture();
    const result = await run(io);
    expect(result.ok ? 0 : 1).toBe(0);
    expect(formatPreflight(result).trimEnd().split('\n')).toEqual(
      result.checks.map(({ name, detail }) => `ok   ${name} ${detail}`),
    );
  });

  it('any failed check exposes ok=false for exit 1 and formats FAIL alongside ok lines', async () => {
    const { io } = fixture({ which: (tool) => tool !== 'gh' });
    const result = await run(io);
    expect(result.ok).toBe(false);
    expect(result.ok ? 0 : 1).toBe(1);
    expect(formatPreflight(result).trimEnd().split('\n')).toEqual(
      result.checks.map(({ name, ok, detail }) => `${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`),
    );
  });
});
