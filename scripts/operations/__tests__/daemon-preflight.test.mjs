// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { getThisHost } from '../../lib/daemon-host-guard.mjs';
import { runPreflight, formatPreflight, clean, cliIO, main } from '../daemon-preflight.mjs';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VERSION = 'a'.repeat(40);
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

const run = (io) => runPreflight({ thisHost: ME, io, env: ENV, now: NOW });

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
  it.each(['missing directory', 'unreadable directory', 'corrupt record', 'unreadable record', 'invalid record'])(
    'production discovery reports %s through main and continues remaining checks', async (failure) => {
      const root = mkdtempSync(join(tmpdir(), 'preflight-discovery-'));
      const overlays = join(root, 'overlays');
      try {
        if (failure === 'unreadable directory') writeFileSync(overlays, 'not a directory');
        else if (failure !== 'missing directory') {
          mkdirSync(overlays);
          if (failure === 'unreadable record') mkdirSync(join(overlays, 'bad.json'));
          else writeFileSync(join(overlays, 'bad.json'), failure === 'corrupt record' ? '{' : '{"clone":42}');
        }
        const env = { ...ENV, WE_WORKSPACE_ROOT: root, WE_DAEMON_OVERLAY_DIR: overlays };
        // Keep the shipped discovery adapter; inject only unrelated probes.
        const adapter = cliIO(env);
        const { io, calls } = fixture({ cloneDirs: adapter.cloneDirs, readHead: () => SHA });
        const lines = [];
        expect(await main({ thisHost: ME, env, now: NOW, io, log: (line) => lines.push(line) })).toBe(1);
        expect(lines[0]).toMatch(/FAIL clone-dirs /);
        expect(lines[0]).toContain(overlays);
        expect(lines[0]).toContain('ok   ssh:forge status=0');
        expect(calls.at(-1).name).toBe('sshForge');
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('production discovery includes live clones and excludes valid stale records and sidecars', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-discovery-valid-'));
    const overlays = join(root, 'overlays');
    try {
      mkdirSync(overlays);
      const live = join(root, 'custom-daemon');
      const stale = join(root, 'retired-daemon');
      const lane = join(root, '.lanes', 'repo', 'lane-5');
      for (const [name, clone, entries] of [['live', live, [{}]], ['stale', stale, []], ['lane', lane, [{}]]]) {
        writeFileSync(join(overlays, `${name}.json`), JSON.stringify({ clone, overlays: entries }));
      }
      writeFileSync(join(overlays, 'live.json.main-sync.json'), '{');
      writeFileSync(join(overlays, 'live.events.jsonl'), '{');
      const roots = cliIO({ WE_WORKSPACE_ROOT: root, WE_DAEMON_OVERLAY_DIR: overlays }).cloneDirs();
      expect(roots).toContain(live);
      expect(roots).toContain(join(root, 'wev-review-daemon'));
      expect(roots).not.toContain(stale);
      expect(roots).not.toContain(lane);
      expect(new Set(roots).size).toBe(roots.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('readHead rejects a plain directory inside another checkout', () => {
    // Read the existing checkout so this regression also runs in Git-read-only lanes.
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const io = cliIO();
    expect(() => io.readHead(join(repo, 'scripts'))).toThrow('not a git checkout root');
    expect(io.readHead(repo)).toBe(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    }).trim());
  });

  it('cliIO rejects unknown option keys instead of silently ignoring spies', () => {
    for (const key of ['readCache', 'writeCache', 'invalidateCache', 'execFileSyncc']) {
      expect(() => cliIO({}, { [key]: () => {} })).toThrow(`unknown cliIO option: ${key}`);
    }
  });

  it('cliIO.readHead bounds both git probes to 15s and 1 MiB', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-bounds-'));
    try {
      const calls = [];
      const io = cliIO(ENV, { execFileSync: (...args) => {
        calls.push(args);
        return args[1].at(-1) === '--show-toplevel' ? root : SHA;
      } });
      expect(io.readHead(root)).toBe(SHA);
      expect(calls).toEqual(['--show-toplevel', 'HEAD'].map((arg) => ['git', ['-C', root, 'rev-parse', arg],
        expect.objectContaining({ env: ENV, timeout: 15000, maxBuffer: 1024 * 1024 })]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('cliIO.resolveRole reads every time and maps source errors to remote-failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-role-'));
    try {
      const env = { HOME: root, PATH: '', XDG_CACHE_HOME: root };
      let remote;
      let reads = 0;
      const io = cliIO(env, {
        source: { readOwner: () => { reads += 1; return remote; } },
        spawnSync: () => { throw new Error('unexpected spawn'); },
        execFileSync: () => { throw new Error('unexpected exec'); },
        daemonCloneRoots: () => [],
      });
      const cases = [
        [{ host: ME, version: VERSION }, 'active', 'fresh-owner-is-this-host', 'remote'],
        [{ host: OTHER, version: VERSION }, 'standby', 'owner-is-other-host', 'remote'],
        [{ host: '', version: VERSION }, 'standby', 'owner-unset', 'remote'],
        [{ status: 'error', error: 'offline' }, 'standby', 'owner-unreadable', 'remote-failed'],
      ];
      for (const [response, role, reason, source] of cases) {
        remote = response;
        // Repeated calls at the same timestamp must still obtain startup evidence.
        expect(await io.resolveRole({ thisHost: ME, now: NOW })).toEqual({ role, reason, source });
      }
      expect(reads).toBe(cases.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['missing', 'present'])('main reads %s identity without provisioning or changing files', async (state) => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-identity-'));
    try {
      const env = { ...ENV, HOME: root };
      const id = state === 'present' ? getThisHost({ home: root }) : ME;
      const adapter = cliIO(env, { source: { readOwner: () => ({ host: id, version: VERSION }) } });
      const before = readdirSync(root);
      const { io } = fixture({ resolveRole: adapter.resolveRole });
      const lines = [];
      expect(await main({ env, io, log: (line) => lines.push(line) })).toBe(state === 'present' ? 0 : 1);
      expect(lines[0]).toContain(state === 'present' ? 'role=active' : 'role=standby reason=invalid-input');
      expect(lines[0].split('\n').filter((line) => line.startsWith('FAIL'))).toEqual(
        state === 'present' ? [] : ['FAIL role role=standby reason=invalid-input'],
      );
      expect(readdirSync(root)).toEqual(before);
      if (state === 'present') {
        expect(readdirSync(join(root, '.claude'))).toEqual(['host-id']);
        expect(readFileSync(join(root, '.claude', 'host-id'), 'utf8')).toBe(id + '\n');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preflight supports migration aliases through the same resolver', async () => {
    for (const alias of ['legacy-alpha', 'legacy-beta']) {
      const io = cliIO({ WE_DAEMON_LEGACY_OWNER_VALUES: `legacy-alpha=${ME},legacy-beta=${ME}` }, {
        source: { readOwner: () => ({ host: alias, version: VERSION }) }, legacyHost: alias,
      });
      expect((await io.resolveRole({ thisHost: ME })).role).toBe('active');
    }
  });

  it.each([[undefined, 'owner-unreadable'], ['', 'owner-unreadable'], [`legacy-beta=${ME}`, 'owner-unreadable'],
    [`legacy-alpha=${ME}\n`, 'owner-unreadable'], ['legacy-alpha', 'owner-unreadable'],
    // A valid alias bound to another host's UUID is a different host, never this one.
    [`legacy-alpha=${OTHER}`, 'owner-is-other-host'], [`legacy-alpha=${ME}`, 'fresh-owner-is-this-host']])(
    'default source and resolver share the preflight alias configuration %j', async (configured, reason) => {
      const alias = 'legacy-alpha';
      const env = configured === undefined ? {} : { WE_DAEMON_LEGACY_OWNER_VALUES: configured };
      const adapter = cliIO(env, { legacyHost: alias, execFileSync: (_file, args) => JSON.stringify(
        args[1].includes('/git/ref/') ? { object: { type: 'commit', sha: VERSION } }
          : { type: 'file', encoding: 'base64', content: Buffer.from(alias + '\n').toString('base64') },
      ) });
      expect(await adapter.resolveRole({ thisHost: ME })).toMatchObject({
        role: reason === 'fresh-owner-is-this-host' ? 'active' : 'standby', reason });
    },
  );

  it('default source wires bounded GitHub reads and pinned contents into preflight', async () => {
    const calls = [];
    const adapter = cliIO(ENV, { execFileSync: (...args) => {
      calls.push(args);
      return JSON.stringify(calls.length === 1 ? { object: { type: 'commit', sha: VERSION } }
        : { type: 'file', encoding: 'base64', content: Buffer.from(ME + '\n').toString('base64') });
    } });
    const { io } = fixture({ resolveRole: adapter.resolveRole });
    expect((await run(io)).checks[0]).toEqual({ name: 'role', ok: true, detail: 'role=active reason=fresh-owner-is-this-host' });
    expect(calls).toHaveLength(2);
    expect(calls[1][1][1]).toContain('/contents/host?ref=' + VERSION);
    for (const [command, args, options] of calls) {
      expect(command).toBe('gh');
      expect(args[0]).toBe('api');
      expect(options).toMatchObject({ env: ENV, timeout: 15000, maxBuffer: 1024 * 1024 });
    }
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

  it('cliIO.sshForge uses BatchMode and a ConnectTimeout argv', () => {
    const calls = [];
    const result = { status: 0 };
    const io = cliIO({ PATH: '', HOME: 'unused-fixture-home' }, {
      spawnSync: (...args) => { calls.push(args); return result; },
    });
    expect(io.sshForge()).toBe(result);
    expect(calls).toEqual([['ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'forge', 'true',
    ], expect.objectContaining({ timeout: 15000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] })]]);
  });
});

describe('preflight CLI entry point', () => {
  it.each(['real path', 'checkout symlink', 'relative checkout symlink', 'script symlink', 'preserved checkout symlink'])(
    'executes failed checks via %s', (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'preflight-entry-'));
      const script = fileURLToPath(new URL('../daemon-preflight.mjs', import.meta.url));
      try {
        const view = join(root, 'checkout # view');
        symlinkSync(fileURLToPath(new URL('../../../', import.meta.url)), view, 'dir');
        const link = join(root, 'preflight # link.mjs');
        symlinkSync(script, link);
        const entry = kind === 'real path' ? script : kind === 'script symlink' ? link
          : join(kind === 'relative checkout symlink' ? 'checkout # view' : view,
            'scripts/operations/daemon-preflight.mjs');
        const flags = kind === 'preserved checkout symlink' ? ['--preserve-symlinks-main'] : [];
        const result = spawnSync(process.execPath, [...flags, entry], {
          cwd: root, env: { HOME: join(root, 'missing-home'), PATH: '',
            WE_WORKSPACE_ROOT: join(root, 'missing-workspace'),
            WE_DAEMON_OVERLAY_DIR: join(root, 'missing-overlays') },
          encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('FAIL tool:node node');
        expect(result.stdout).toContain('FAIL ssh:forge');
        expect(result.status).toBe(1);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it.each([undefined, 'nonexistent-preflight-importer', process.execPath])(
    'import stays silent with argv[1]=%s', (entry) => {
      const url = new URL('../daemon-preflight.mjs', import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `process.argv[1] = ${JSON.stringify(entry)}; await import(${JSON.stringify(url)});`], {
        env: { PATH: '' }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(0);
    },
  );
});

describe('preflight main', () => {
  it.each(['returned', 'thrown'])('main fails unreadable ownership (%s error) and continues remaining checks', async (kind) => {
    const adapter = cliIO({}, { source: { readOwner: () => {
      if (kind === 'thrown') throw new Error('offline');
      return { status: 'error', error: 'offline' };
    } } });
    const { io, calls } = fixture({ resolveRole: adapter.resolveRole });
    const lines = [];
    expect(await main({ thisHost: ME, env: ENV, now: NOW, io, log: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toContain('FAIL role role=standby reason=owner-unreadable');
    expect(lines[0].split('\n').filter((line) => line.startsWith('FAIL'))).toHaveLength(1);
    expect(lines[0]).toContain('ok   tool:node node');
    expect(lines[0]).toContain('ok   ssh:forge status=0');
    expect(calls.at(-1).name).toBe('sshForge');
  });

  it('main returns 1 and prints FAIL when a check fails, 0 when all pass', async () => {
    for (const passes of [false, true]) {
      const { io } = fixture({ which: (tool) => passes || tool !== 'gh' });
      const lines = [];
      const exitCode = await main({ thisHost: ME, env: ENV, now: NOW, io, log: (line) => lines.push(line) });
      expect(exitCode).toBe(passes ? 0 : 1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(formatPreflight(await run(io)));
      if (passes) expect(lines[0]).not.toContain('FAIL');
      else expect(lines[0]).toContain('FAIL tool:gh gh');
    }
  });
});
