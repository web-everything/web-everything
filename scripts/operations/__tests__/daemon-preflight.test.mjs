// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runPreflight, formatPreflight, clean, cliIO, main } from '../daemon-preflight.mjs';

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


const HOSTILE = '\x1b[31mhostile\x00\x07\x08\x09\x0a\x0d\x7f\x85\u2028\u2029detail\x1b[0m';
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

describe('preflight sanitization and discovery failures', () => {
  it('clean strips ESC and other control characters from details', () => {
    const result = clean(HOSTILE);
    expect(result).not.toMatch(CONTROLS);
    expect(result).toContain('hostile');
    expect(result).toContain('detail');
  });

  it('formatPreflight output never contains control characters from hostile details', () => {
    const output = formatPreflight({ ok: false, checks: [
      { name: 'fixture', ok: false, detail: HOSTILE },
    ] });
    expect(output).toContain('FAIL');
    expect(output).toContain('hostile');
    expect(output).not.toMatch(CONTROLS);
  });

  for (const [method, checkName, omitted] of [
    ['keyFiles', 'keyfiles', ['keyfile:DAEMON_KEY', 'keyfile:SECOND_KEY']],
    ['cloneDirs', 'clone-dirs', ['clone-head:fixture/clone-a', 'clone-head:fixture/clone-b']],
  ]) {
    it(`${method} discovery failure is an explicit failed check and other checks still run`, async () => {
      // Non-array values must fail explicitly rather than masquerade as empty discovery.
      for (const value of [new Error('discovery unavailable'), null, {}, 'not an array']) {
        const { io, calls } = fixture({ [method]: () => {
          if (value instanceof Error) throw value;
          return value;
        } });
        const result = await run(io);
        expect(result.ok).toBe(false);
        expect(result.checks.filter(({ ok }) => !ok)).toEqual([
          { name: checkName, ok: false, detail: expect.any(String) },
        ]);
        expect(result.checks.find(({ name }) => name === checkName).detail)
          .toMatch(value instanceof Error ? /discovery unavailable/ : /unreadable|array/i);
        const expected = NAMES.filter((name) => !omitted.includes(name));
        expect(result.checks.filter(({ name }) => name !== checkName).map(({ name }) => name)).toEqual(expected);
        expect(calls.at(-1).name).toBe('sshForge');
        expect(result.checks.at(-1)).toEqual({ name: 'ssh:forge', ok: true, detail: 'status=0' });
      }
    });
  }
});

describe('preflight CLI IO hooks', () => {
  it('readHead rejects a plain directory inside another checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-git-'));
    try {
      const repo = join(root, 'repo');
      const subdir = join(repo, 'plain');
      const env = { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') };
      writeFileSync(env.GIT_CONFIG_GLOBAL, '');
      mkdirSync(repo);
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
        env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 1024 * 1024,
      }).trim();
      git('init', '--template=');
      writeFileSync(join(repo, 'fixture.txt'), 'fixture\n');
      git('add', 'fixture.txt');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
      mkdirSync(subdir);
      const io = cliIO(env);
      expect(() => io.readHead(subdir)).toThrow();
      const head = io.readHead(repo);
      expect(head).toMatch(/^[a-f0-9]{40}$/);
      expect(head).toBe(git('rev-parse', 'HEAD'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('cliIO.resolveRole uses atStart, maps a remote error to source remote-failed and never writes a cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-role-'));
    try {
      const env = { HOME: root, PATH: '', XDG_CACHE_HOME: root };
      let remote;
      let reads = 0;
      const effects = [];
      const io = cliIO(env, {
        readOwnerRemote: () => { reads += 1; return remote; },
        spawnSync: () => { throw new Error('unexpected spawn'); },
        execFileSync: () => { throw new Error('unexpected exec'); },
        daemonCloneRoots: () => [],
        readCache: () => { effects.push('readCache'); throw new Error('no cache reads'); },
        writeCache: () => { effects.push('writeCache'); throw new Error('no cache writes'); },
        invalidateCache: () => { effects.push('invalidateCache'); throw new Error('no cache invalidation'); },
      });
      const cases = [
        [{ status: 'ok', owner: 'daemon-a' }, 'active', 'fresh-owner-is-this-host', 'remote'],
        [{ status: 'ok', owner: 'daemon-b' }, 'standby', 'owner-is-other-host', 'remote'],
        [{ status: 'unset' }, 'standby', 'owner-unset', 'remote'],
        [{ status: 'error', error: 'offline' }, 'standby', 'owner-unreadable', 'remote-failed'],
      ];
      for (const [response, role, reason, source] of cases) {
        remote = response;
        // Repeated calls at the same timestamp must still obtain startup evidence.
        expect(await io.resolveRole({ thisHost: 'daemon-a', now: NOW })).toEqual({ role, reason, source });
      }
      expect(reads).toBe(cases.length);
      expect(effects).toEqual([]);
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('cliIO.which finds executables on PATH and rejects directories and non-executables', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-path-'));
    try {
      writeFileSync(join(root, 'fixture-executable'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(root, 'fixture-executable'), 0o700);
      writeFileSync(join(root, 'fixture-non-executable'), 'fixture');
      chmodSync(join(root, 'fixture-non-executable'), 0o600);
      mkdirSync(join(root, 'fixture-directory'), { mode: 0o700 });
      const io = cliIO({ PATH: root, HOME: root });
      expect(io.which('fixture-executable')).toBe(true);
      expect(io.which('fixture-non-executable')).toBe(false);
      expect(io.which('fixture-directory')).toBe(false);
      expect(io.which('fixture-missing')).toBe(false);
      expect(io.statFile(join(root, 'fixture-executable'))).toBe(true);
      expect(io.statFile(join(root, 'fixture-directory'))).toBe(false);
      expect(cliIO({ PATH: '', HOME: root }).which('fixture-executable')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('actual preflight role transport never calls filesystem mutation APIs, including on rejection', () => {
    const moduleUrl = new URL('../daemon-preflight.mjs', import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const effects = [];
      for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'renameSync']) {
        fs[name] = () => { effects.push(name); throw new Error('unexpected mutation'); };
      }
      syncBuiltinESMExports();
      const { cliIO } = await import(${JSON.stringify(moduleUrl)});
      const results = [];
      for (const response of [{ status: 'ok', owner: 'daemon-a' }, { status: 'unset' },
        { status: 'error' }, null]) {
        const io = cliIO({}, { readOwnerRemote: async () => {
          if (response === null) throw new Error('offline');
          return response;
        } });
        results.push(await io.resolveRole({ thisHost: 'daemon-a', now: ${NOW} }));
      }
      console.log(JSON.stringify({ effects, results }));
    `;
    const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    }));
    expect(report.effects).toEqual([]);
    expect(report.results.map(({ role }) => role)).toEqual(['active', 'standby', 'standby', 'standby']);
    expect(report.results.slice(2)).toEqual(Array(2).fill({
      role: 'standby', reason: 'owner-unreadable', source: 'remote-failed',
    }));
  });

  it('cliIO.sshForge uses BatchMode and a ConnectTimeout argv', () => {
    const calls = [];
    const result = { status: 0 };
    const io = cliIO({ PATH: '', HOME: 'unused-fixture-home' }, {
      spawnSync: (...args) => { calls.push(args); return result; },
    });
    expect(io.sshForge()).toBe(result);
    expect(calls).toEqual([['ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'forge', 'true',
    ], expect.objectContaining({ timeout: expect.any(Number), maxBuffer: expect.any(Number),
      stdio: ['ignore', 'pipe', 'pipe'] })]]);
  });
});

describe('preflight main', () => {
  it('main returns 1 and prints FAIL when a check fails, 0 when all pass', async () => {
    for (const passes of [false, true]) {
      const { io } = fixture({ which: (tool) => passes || tool !== 'gh' });
      const lines = [];
      const exitCode = await main({ thisHost: 'daemon-a', env: ENV, now: NOW, io, log: (line) => lines.push(line) });
      expect(exitCode).toBe(passes ? 0 : 1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(formatPreflight(await run(io)));
      if (passes) expect(lines[0]).not.toContain('FAIL');
      else expect(lines[0]).toContain('FAIL tool:gh gh');
    }
  });
});
