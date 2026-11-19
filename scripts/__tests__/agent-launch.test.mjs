import { afterEach, describe, expect, it, vi } from 'vitest';
import { userInfo, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync, readFileSync } from 'node:fs';
import { launchAgent, buildAgentInvocation, buildAgentArgs, findAgentBinary, buildAgentPath } from '../lib/agent-launch.mjs';
import { defaultShimDir, checkoutShimDir, isDaemonCaller } from '../lib/gh-app-shim.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { buildCodexDirectTaskDescriptor, CODEX_SHIM_DIR } from '../codex-direct-task.mjs';

const SID = '12345678-1234-4234-8234-123456789abc';
const cwd = process.cwd();
const base = () => ({ agent: 'codex', cwd, model: 'gpt-5.6-sol', sandbox: 'workspace-write' });
const claude = () => ({ agent: 'claude', cwd, print: true, sessionId: SID, prompt: 'hello' });
const seam = () => ({ spawn: vi.fn(() => 'child'), resolveBinary: vi.fn(() => process.execPath) });
const registry = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/agent-launch-env-registry.json'), 'utf8'));
const fixedPath = (prefix) => [...new Set([prefix, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean))].join(':');
function refused(descriptor, reason) {
  const io = seam();
  expect(() => launchAgent(descriptor, io)).toThrow(reason);
  expect(io.spawn).not.toHaveBeenCalled();
  expect(io.resolveBinary).not.toHaveBeenCalled();
}
afterEach(() => vi.unstubAllEnvs());

describe('closed grammar rejection: the PR #7022 attack classes', () => {
  it('1 refuses shell wrappers as agent or nested invocation data', () => {
    for (const agent of ['sh', 'bash', 'zsh', 'sh -c codex', '/bin/claude']) refused({ ...base(), agent }, /agent/);
    refused({ ...base(), command: { agent: 'bash', args: ['-c', 'codex exec'] } }, /command/);
  });
  it('2 refuses env wrappers and assignment prefixes', () => {
    for (const agent of ['env', 'env -S codex', 'FOO=bar codex', 'FOO=bar; claude']) refused({ ...base(), agent }, /agent/);
    refused({ ...base(), prefix: ['env', '-i', '--unset=PATH'] }, /prefix/);
  });
  it('3 refuses the other wrapper binaries', () => {
    for (const agent of ['nohup', 'timeout', 'xargs', 'nice', 'sudo', 'node', 'npx', 'dash', 'fish', 'stdbuf', 'script']) {
      refused({ ...base(), agent }, /agent/);
      refused({ ...base(), wrapper: agent }, /wrapper/);
    }
  });
  it('4 refuses shell and every raw options object, even empty', () => {
    refused({ ...base(), shell: true }, /shell/);
    for (const options of [{}, { shell: true }, { uid: 0 }, { windowsVerbatimArguments: true }]) refused({ ...base(), options }, /options/);
  });
  it('5 refuses clusters and attached options in every scalar option/positional field', () => {
    for (const value of ['-pc', `-r${SID}`, `--resume=${SID}`, '--model=exec', '-']) {
      for (const field of ['model', 'cwd', 'outputSchemaFile', 'outputLastMessageFile', 'resumeThreadId', 'pathPrefix', 'tempRoot']) {
        refused({ ...base(), [field]: value }, new RegExp(field));
      }
      for (const field of ['model', 'prompt', 'sessionId', 'resumeId', 'outputFormat']) refused({ ...claude(), [field]: value }, new RegExp(field));
      refused({ ...base(), addDirs: [value] }, /addDirs/);
      refused({ ...base(), config: { 'model_reasoning_effort': value } }, /model_reasoning_effort/);
    }
  });
  it('6 refuses expanded, quoted and non-UUID ids, including trailing newlines', () => {
    for (const id of ['$SID', '${SID}', '$(printf id)', '`printf id`', '~', '*', 'a b', `${SID}\n`, `"${SID}"`, `'${SID}'`, 'thread-123', '', SID + SID]) {
      refused({ ...base(), resumeThreadId: id }, /resumeThreadId/);
      refused({ ...claude(), sessionId: id }, /sessionId/);
      refused({ ...claude(), sessionId: undefined, resumeId: id }, /resumeId/);
    }
  });
  it('7 refuses all accessors before invoking any getter or resolver', () => {
    const getter = vi.fn(() => getter.mock.calls.length === 1 ? 'codex' : 'bash');
    for (const key of ['agent', 'cwd', 'unused']) {
      const d = base(); Object.defineProperty(d, key, { get: getter }); refused(d, /accessor/);
    }
    const nested = {}; Object.defineProperty(nested, 'PATH', { set() { throw Error('setter ran'); } });
    refused({ ...base(), config: nested }, /accessor/);
    const array = ['/safe']; Object.defineProperty(array, '0', { get: getter });
    refused({ ...base(), addDirs: array }, /accessor/);
    expect(getter).not.toHaveBeenCalled();
  });
  it('8 refuses proxies anywhere without invoking traps, including revoked proxies', () => {
    const trap = vi.fn(() => { throw Error('trap ran'); });
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    refused(proxy, /Proxy/);
    refused({ ...base(), config: proxy }, /Proxy/);
    refused({ ...base(), addDirs: [proxy] }, /Proxy/);
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    refused({ ...base(), addDirs: revoked.proxy }, /Proxy/);
    expect(trap).not.toHaveBeenCalled();
  });
  it('9 refuses argv0 redirection', () => refused({ ...base(), argv0: 'bash' }, /argv0/));
  it('10 refuses execPath, execArgv and fork-style launches', () => {
    for (const field of ['execPath', 'execArgv', 'fork', 'file', 'args', 'argv', 'stdio', 'detached', 'env']) refused({ ...base(), [field]: [] }, new RegExp(field));
  });
  it('11 never forwards NODE_OPTIONS or any other *_OPTIONS from the caller environment', () => {
    for (const key of ['NODE_OPTIONS', 'CUSTOM_OPTIONS', 'SHELLOPTS', 'BASHOPTS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'IFS', 'PS4', 'NODE_PATH']) vi.stubEnv(key, 'hostile');
    const { options: { env } } = buildAgentInvocation(base(), seam());
    for (const key of ['NODE_OPTIONS', 'CUSTOM_OPTIONS', 'SHELLOPTS', 'BASHOPTS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'IFS', 'PS4', 'NODE_PATH']) expect(env).not.toHaveProperty(key);
    refused({ ...base(), env: { NODE_OPTIONS: '--import=hostile' } }, /env/);
  });
  it('12 never forwards shell startup variables', () => {
    for (const key of ['BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELL']) vi.stubEnv(key, '/hostile');
    const { options: { env } } = buildAgentInvocation(base(), seam());
    for (const key of ['BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELL']) expect(env).not.toHaveProperty(key);
    refused({ ...base(), env: { BASH_ENV: '/hostile' } }, /env/);
  });
  it('13 uses the real account home despite HOME override', () => {
    vi.stubEnv('HOME', '/hostile');
    expect(buildAgentInvocation(base(), seam()).options.env.HOME).toBe(userInfo().homedir);
    refused({ ...base(), HOME: '/hostile' }, /HOME/);
  });
  it('14 snapshots once before resolver mutation and detaches aliased nested arrays', () => {
    const roots = ['/safe'];
    const config = { 'sandbox_workspace_write.writable_roots': roots };
    const d = { ...base(), addDirs: roots, config };
    const io = seam();
    io.resolveBinary.mockImplementation(() => {
      roots[0] = '--resume=evil'; config['sandbox_workspace_write.network_access'] = false; d.agent = 'bash';
      return process.execPath;
    });
    launchAgent(d, io); roots.push('/later');
    const [, args] = io.spawn.mock.calls[0];
    expect(args).toContain('/safe');
    expect(args).toContain('sandbox_workspace_write.writable_roots=["/safe"]');
    expect(args.join(' ')).not.toMatch(/evil|later|network_access/);
    refused({ ...base(), unknown: true }, /unknown/);
    refused({ ...claude(), resumeId: SID }, /sessionId.*resumeId/);
    refused({ ...base(), resumeThreadId: [SID, SID] }, /resumeThreadId/);
    refused({ ...claude(), afterDelimiter: ['--session-id', SID] }, /afterDelimiter/);
  });
  it('refuses non-plain prototypes, functions, symbols, sparse arrays and cycles', () => {
    for (const value of [new Date(), new String('codex'), () => {}, Symbol('x'), new (class X {})()]) refused({ ...base(), extra: value }, /plain|function|symbol/);
    const d = base(); d.self = d; refused(d, /cyclic/);
    refused({ ...base(), [Symbol('secret')]: true }, /symbol/);
    refused({ ...base(), addDirs: Array(2 ** 32 - 1) }, /sparse/);
    refused({ ...base(), addDirs: Object.assign(['/safe'], { extra: 'x' }) }, /array/);
  });
  it('fails closed at the descriptor depth bound with an operator-visible fallback', () => {
    let nested = {}; for (let i = 0; i < 70; i++) nested = { nested };
    refused({ ...base(), extra: nested }, /limit.*simplify/);
  });
  it('fails closed at the snapshot node bound with the same simplify-and-retry fallback', () => {
    refused({ ...base(), extra: Array(10001).fill('/safe') }, /limit.*simplify/);
  });
  it('refuses unknown config keys, wrong types, relative and NUL paths, and conflicting resume options', () => {
    refused({ ...base(), config: { approval_policy: 'never' } }, /approval_policy/);
    refused({ ...base(), config: { 'sandbox_workspace_write.network_access': 'true' } }, /network_access/);
    refused({ ...base(), config: { 'shell_environment_policy.set.PATH': '/safe::/evil' } }, /PATH/);
    for (const cwd of ['relative', '/nul\0', '/no-such-agent-launch-dir']) refused({ ...base(), cwd }, /cwd/);
    for (const field of ['processGroup', 'ephemeral']) refused({ ...base(), [field]: 'true' }, new RegExp(field));
    refused({ ...base(), resumeThreadId: SID, ephemeral: true }, /ephemeral/);
    refused({ ...base(), resumeThreadId: SID, outputSchemaFile: '/schema' }, /outputSchemaFile/);
    refused({ ...base(), prompt: 'codex prompt must use stdin' }, /prompt/);
    refused({ ...base(), model: 'sonnet\n' }, /model/);
  });
});

describe('built invocation positive controls', () => {
  it.each([
    ['normal edit', {}], ['read-only review', { review: true }], ['resume', { resumeThreadId: SID.toUpperCase() }],
    ['output schema', { outputSchemaFile: '/schema with spaces.json' }], ['add-dirs', { addDirs: ['/one', '/two'] }],
  ])('pins the pre-S1 Codex argv tokens for %s', (_label, extra) => {
    const input = { cwd, outputLastMessageFile: '/last', model: 'gpt-5.6-sol', effort: 'high', env: { PATH: '/usr/bin:/bin' }, ...extra };
    const d = buildCodexDirectTaskDescriptor(input);
    const configPath = `${CODEX_SHIM_DIR}:/usr/bin:/bin`;
    const expected = ['exec', '--json', '-s', extra.review ? 'read-only' : 'workspace-write', '--skip-git-repo-check', '-C', cwd,
      ...(extra.outputSchemaFile ? ['--output-schema', extra.outputSchemaFile] : []), '-o', '/last',
      ...(extra.addDirs ?? []).flatMap(dir => ['--add-dir', dir]), '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high',
      ...(!extra.review ? ['-c', 'sandbox_workspace_write.network_access=true', '-c', `shell_environment_policy.set.PATH=${JSON.stringify(configPath)}`] : []),
      ...(extra.resumeThreadId ? ['resume', extra.resumeThreadId, '-'] : [])];
    expect(buildAgentArgs(d)).toEqual(expected);
    const io = seam(); expect(launchAgent(d, io)).toBe('child');
    expect(io.spawn).toHaveBeenCalledWith(process.execPath, expected, expect.objectContaining({ shell: false, detached: true, cwd, stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(isAbsolute(io.spawn.mock.calls[0][0])).toBe(true);
    // This explicit env bag only supplies PATH (owned by the launcher), so only ambient restrictive names survive.
    expect(Object.keys(io.spawn.mock.calls[0][2].env).every(k => ['PATH', 'HOME'].includes(k)
      || registry[k]?.class === 'forward-restrictive' || registry[k]?.restrictiveValues?.includes(io.spawn.mock.calls[0][2].env[k].trim().toLowerCase()))).toBe(true);
  });
  it('encodes writable roots and temp strings as data and preserves ephemeral', () => {
    const tempRoot = '/task "quote" \\ $TMP';
    const d = buildCodexDirectTaskDescriptor({ cwd, model: 'gpt-5.6-sol', effort: 'high', ephemeral: true, writableRoots: [tempRoot], tempRoot });
    const args = buildAgentArgs(d);
    expect(args).toContain('--ephemeral');
    expect(args).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([tempRoot])}`);
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      expect(args).toContain(`shell_environment_policy.set.${key}=${JSON.stringify(tempRoot)}`);
      expect(buildAgentInvocation(d, seam()).options.env[key]).toBe(tempRoot);
    }
  });
  it('emits Claude print and a UUID session with the prompt after a literal delimiter', () => {
    const io = seam(); launchAgent({ ...claude(), model: 'sonnet', outputFormat: 'stream-json', verbose: true }, io);
    expect(io.spawn.mock.calls[0][1]).toEqual(['-p', '--session-id', SID, '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--', 'hello']);
    expect(buildAgentArgs({ agent: 'claude', cwd, print: true, resumeId: SID, outputFormat: 'text' })).toEqual(['-p', '--resume', SID, '--output-format', 'text']);
  });
  it('builds fixed PATH with shim first and ignores ambient PATH and API keys', () => {
    vi.stubEnv('PATH', '/attacker'); vi.stubEnv('OPENAI_API_KEY', 'secret'); vi.stubEnv('USER', 'safe-user'); vi.stubEnv('CODEX_HOME', '/config');
    const env = buildAgentInvocation({ ...base(), pathPrefix: '/shim', tempRoot: '/temp' }, seam()).options.env;
    expect(env.PATH).toBe(fixedPath('/shim'));
    expect(env).toMatchObject({ USER: 'safe-user', CODEX_HOME: '/config', TMPDIR: '/temp', TMP: '/temp', TEMP: '/temp' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });
  it('resolves a real executable by name independently of hostile PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-launch-path-'));
    try {
      const trusted = join(dir, 'trusted'), hostile = join(dir, 'hostile');
      mkdirSync(trusted); mkdirSync(hostile);
      for (const binDir of [trusted, hostile]) {
        writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 99\n');
        chmodSync(join(binDir, 'codex'), 0o755);
      }
      vi.stubEnv('PATH', hostile);
      const file = findAgentBinary('codex', [join(dir, 'missing'), trusted]);
      expect(isAbsolute(file)).toBe(true);
      expect(file).toBe(realpathSync(join(trusted, 'codex')));
      expect(() => findAgentBinary('claude', [trusted])).toThrow(/binary not found/);
      expect(() => findAgentBinary('codex', [join(dir, 'missing')])).toThrow(/binary not found/);
      chmodSync(join(trusted, 'codex'), 0o644);
      expect(() => findAgentBinary('codex', [trusted])).toThrow(/binary not found/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects invalid resolver evidence and preserves spawn failures', () => {
    const io = seam(); io.resolveBinary.mockReturnValue('codex');
    expect(() => launchAgent(base(), io)).toThrow(/binary/); expect(io.spawn).not.toHaveBeenCalled();
    io.resolveBinary.mockReturnValue(process.execPath); io.spawn.mockImplementation(() => { throw Error('spawn failed'); });
    expect(() => launchAgent(base(), io)).toThrow('spawn failed');
  });
});

describe('test-isolation markers survive the env allowlist (they only narrow)', () => {
  it('forwards VITEST, WE_UNDER_TEST and an absolute LANE_POOL_ROOT, never the real-pool escape hatch', () => {
    vi.stubEnv('VITEST', 'true'); vi.stubEnv('WE_UNDER_TEST', '1');
    vi.stubEnv('LANE_POOL_ROOT', '/isolated/pool'); vi.stubEnv('WE_ALLOW_REAL_LANE_POOL_IN_TESTS', '1');
    const { env } = buildAgentInvocation(base(), seam()).options;
    expect(env).toMatchObject({ VITEST: 'true', WE_UNDER_TEST: '1', LANE_POOL_ROOT: '/isolated/pool' });
    expect(env).not.toHaveProperty('WE_ALLOW_REAL_LANE_POOL_IN_TESTS');
  });
  it('refuses to launch when a set isolation root is malformed instead of silently dropping it', () => {
    for (const bad of ['relative/pool', '-pool']) {
      vi.stubEnv('LANE_POOL_ROOT', bad);
      const io = seam();
      expect(() => launchAgent(base(), io)).toThrow(/LANE_POOL_ROOT/);
      expect(io.spawn).not.toHaveBeenCalled();
    }
  });
});

describe('three-class environment boundary', () => {
  it.each(['', ' \t\n '])('blank restrictive values (%j) cannot mask ambient restrictions or predicates', blank => {
    const markers = { WE_GH_DAEMON_CALLER: 'daemon', XPC_SERVICE_NAME: 'com.we.test', VITEST: 'true',
      WE_UNDER_TEST: '1', LANE_POOL_ROOT: '/isolated/pool', WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse' };
    for (const [key, value] of Object.entries(markers)) vi.stubEnv(key, value);
    const env = buildAgentInvocation({ ...base(), inheritEnv: Object.fromEntries(Object.keys(markers).map(k => [k, blank])) }, seam()).options.env;
    expect(env).toMatchObject(markers);
    expect(isDaemonCaller(env)).toBe(true);
    expect(isUnderTest(env)).toBe(true);
    // Each predicate input independently survives; the other marker cannot hide a regression.
    expect(isDaemonCaller({ XPC_SERVICE_NAME: env.XPC_SERVICE_NAME })).toBe(true);
    expect(isDaemonCaller({ WE_GH_DAEMON_CALLER: env.WE_GH_DAEMON_CALLER })).toBe(true);
    expect(isUnderTest({ VITEST: env.VITEST })).toBe(true);
    expect(isUnderTest({ WE_UNDER_TEST: env.WE_UNDER_TEST })).toBe(true);
    for (const key of Object.keys(markers)) vi.stubEnv(key, blank);
    const absent = buildAgentInvocation({ ...base(), inheritEnv: Object.fromEntries(Object.keys(markers).map(k => [k, blank])) }, seam()).options.env;
    for (const key of Object.keys(markers)) expect(absent).not.toHaveProperty(key);
    const ambient = buildAgentInvocation(base(), seam()).options.env;
    for (const key of Object.keys(markers)) expect(ambient).not.toHaveProperty(key);
  });
  it('every value-gated restriction survives a blank or relaxing bag, and relaxing values stay dropped', () => {
    for (const [name, rule] of Object.entries(registry).filter(([, r]) => r.restrictiveValues)) {
      for (const value of rule.restrictiveValues) {
        vi.stubEnv(name, undefined);
        expect(buildAgentInvocation({ ...base(), inheritEnv: { [name]: value } }, seam()).options.env[name], name).toBe(value);
        vi.stubEnv(name, value);
        for (const relaxed of ['', ' \t ', 'sec1-unknown-relaxation']) {
          expect(buildAgentInvocation({ ...base(), inheritEnv: { [name]: relaxed } }, seam()).options.env[name], name).toBe(value);
        }
      }
      vi.stubEnv(name, 'sec1-unknown-relaxation');
      expect(buildAgentInvocation({ ...base(), inheritEnv: { [name]: 'sec1-unknown-relaxation' } }, seam()).options.env, name).not.toHaveProperty(name);
      vi.stubEnv(name, undefined);
    }
  });
  it('retains every restrictive ambient variable even when the caller bag omits them', () => {
    const restrictive = Object.fromEntries(Object.entries(registry).filter(([, rule]) => rule.class === 'forward-restrictive')
      .map(([key, rule]) => [key, rule.value === 'absolute-path' ? '/isolated/pool' : 'restrictive-identity']));
    for (const [key, value] of Object.entries(restrictive)) vi.stubEnv(key, value);
    expect(buildAgentInvocation({ ...base(), inheritEnv: {} }, seam()).options.env).toMatchObject(restrictive);
  });
  it('uses bag values when present, and does not inherit ambient neutral metadata for an explicit bag', () => {
    vi.stubEnv('WE_GH_DAEMON_CALLER', 'host-daemon'); vi.stubEnv('USER', 'host-user');
    const env = buildAgentInvocation({ ...base(), inheritEnv: { WE_GH_DAEMON_CALLER: 'bag-daemon', LC_MESSAGES: 'C' } }, seam()).options.env;
    expect(env).toMatchObject({ WE_GH_DAEMON_CALLER: 'bag-daemon', LC_MESSAGES: 'C' });
    expect(env).not.toHaveProperty('USER');
  });
  it('drops every registered drop name and unknown names from both sources, retaining launcher-owned paths', () => {
    const dropped = Object.keys(registry).filter(key => registry[key].class === 'drop' && !key.endsWith('*'));
    const unknown = ['SEC1_UNKNOWN', 'LC_HOSTILE_OPTIONS', 'LC_HOSTILE_TOKEN', 'CUSTOM_OPTIONS'];
    const bag = Object.fromEntries([...dropped, ...unknown].map(key => [key, 'hostile']));
    for (const [key, value] of Object.entries(bag)) vi.stubEnv(key, value);
    const ambient = buildAgentInvocation(base(), seam()).options.env;
    const explicit = buildAgentInvocation({ ...base(), inheritEnv: bag }, seam()).options.env;
    for (const env of [ambient, explicit]) {
      for (const key of [...dropped, ...unknown].filter(key => !['PATH', 'HOME'].includes(key))) expect(env, key).not.toHaveProperty(key);
      expect(env.HOME).toBe(userInfo().homedir);
      expect(env.PATH).toBe(fixedPath());
    }
  });
  it('drops the enabling value of personal-auth fallback from either source (refuse is covered below)', () => {
    vi.stubEnv('WE_GH_AUTH_PERSONAL_FALLBACK', 'allow');
    expect(buildAgentInvocation(base(), seam()).options.env).not.toHaveProperty('WE_GH_AUTH_PERSONAL_FALLBACK');
    expect(buildAgentInvocation({ ...base(), inheritEnv: { WE_GH_AUTH_PERSONAL_FALLBACK: 'allow' } }, seam()).options.env)
      .not.toHaveProperty('WE_GH_AUTH_PERSONAL_FALLBACK');
  });
  it('refuses malformed roots from either source and refuses masking a malformed ambient root', () => {
    for (const bad of ['relative', '-root', '/nul\0']) {
      refused({ ...base(), inheritEnv: { LANE_POOL_ROOT: bad } }, /LANE_POOL_ROOT/);
      if (!bad.includes('\0')) {
        vi.stubEnv('LANE_POOL_ROOT', bad);
        refused({ ...base(), inheritEnv: { LANE_POOL_ROOT: '/safe' } }, /LANE_POOL_ROOT/);
        vi.stubEnv('LANE_POOL_ROOT', undefined);
      }
    }
  });
  it('requires a plain string record and keeps legacy isolation fields outside the closed grammar', () => {
    for (const inheritEnv of [[], null, 'USER=safe', { USER: 1 }, { USER: undefined }, { USER: 'nul\0' }]) {
      refused({ ...base(), inheritEnv }, /inheritEnv/);
    }
    for (const field of ['lanePoolRoot', 'underTest']) refused({ ...base(), [field]: true }, new RegExp(field));
    const getter = vi.fn(); const bag = {}; Object.defineProperty(bag, 'USER', { get: getter });
    refused({ ...base(), inheritEnv: bag }, /accessor/);
    refused({ ...base(), inheritEnv: new Proxy({}, {}) }, /Proxy/);
    expect(getter).not.toHaveBeenCalled();
  });
  it('snapshots bag and ambient env before a resolver can mutate either source', () => {
    vi.stubEnv('WE_GH_DAEMON_CALLER', 'original-daemon');
    const bag = { USER: 'original-user' };
    const io = seam(); io.resolveBinary.mockImplementation(() => {
      bag.USER = 'changed-user'; bag.NODE_OPTIONS = '--import=evil';
      process.env.WE_GH_DAEMON_CALLER = 'changed-daemon';
      return process.execPath;
    });
    launchAgent({ ...base(), inheritEnv: bag }, io);
    expect(io.spawn.mock.calls[0][2].env).toMatchObject({ USER: 'original-user', WE_GH_DAEMON_CALLER: 'original-daemon' });
    expect(io.spawn.mock.calls[0][2].env).not.toHaveProperty('NODE_OPTIONS');
  });
  it('keeps direct-task env-bag isolation and daemon identities in the launched child', () => {
    const env = { LANE_POOL_ROOT: '/caller/pool', VITEST: 'caller-vitest', WE_UNDER_TEST: 'caller-test', WE_GH_DAEMON_CALLER: 'caller-daemon' };
    const d = buildCodexDirectTaskDescriptor({ cwd, env, model: 'gpt-5.6-sol', effort: 'high' });
    expect(d.inheritEnv).toBe(env);
    expect(buildAgentInvocation(d, seam()).options.env).toMatchObject(env);
  });
});

describe('restrictive PATH projection', () => {
  it('keeps gh shims from both snapshots before pathPrefix, node, fixed dirs and agent dir in review mode', () => {
    const home = userInfo().homedir, legacy = defaultShimDir(home), checkout = checkoutShimDir({ home });
    vi.stubEnv('HOME', '/hostile-home'); vi.stubEnv('PATH', `/attacker:${checkout}:${legacy}`);
    const d = buildCodexDirectTaskDescriptor({ cwd, review: true, env: { PATH: `${legacy}:/bag-attacker:${checkout}` } });
    expect(buildAgentArgs(d).join(' ')).not.toContain('shell_environment_policy.set.PATH');
    const io = seam(); io.resolveBinary.mockReturnValue('/agent-install/codex');
    const env = buildAgentInvocation(d, io).options.env;
    expect(env.PATH).toBe(`${legacy}:${checkout}:${fixedPath()}:/agent-install`);
    expect(env.HOME).toBe(home);
  });
  it('resolves bare gh to the first parent shim ahead of a real-gh fixture without using host HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-gh-path-'));
    try {
      const home = join(dir, 'account'), legacy = defaultShimDir(home), checkout = checkoutShimDir({ home }), real = join(dir, 'real');
      for (const [where, output] of [[legacy, 'shim'], [checkout, 'checkout'], [real, 'real']]) {
        mkdirSync(where, { recursive: true });
        writeFileSync(join(where, 'gh'), `#!/bin/sh\nprintf '${output}'\n`, { mode: 0o755 });
      }
      const path = buildAgentPath({ parentPaths: [`${legacy}:${real}`, `${checkout}:${legacy}`], home,
        pathPrefix: real, nodePath: '/running-node/node', binary: '/installed-agent/codex' });
      expect(path).toBe(`${legacy}:${checkout}:${real}:/running-node:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/installed-agent`);
      const result = spawnSync('gh', [], { env: { PATH: path }, encoding: 'utf8', shell: false, timeout: 5000 });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout).toBe('shim');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('drops relative, traversal, foreign-home, malformed-hash, suffixed and arbitrary custom shim dirs', () => {
    const home = '/account', legacy = defaultShimDir(home), checkout = checkoutShimDir({ home });
    const hostile = ['.', '', 'relative/gh-shim', `/other${legacy}`, `${home}/../account/.claude/github-app-token/gh-shim`,
      `${legacy}/`, `${legacy}/evil`, checkout + 'a', checkout.slice(0, -1), checkout.toUpperCase(),
      ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(suffix => checkout + suffix), CODEX_SHIM_DIR];
    const options = { home, nodePath: '/node/node', binary: '/agent/codex' };
    expect(buildAgentPath({ ...options, parentPaths: [hostile.join(':')], pathPrefix: '/explicit-shim' }))
      .toBe('/explicit-shim:/node:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/agent');
  });
});

describe('admission hook point (#7090 moves runtime admission here)', () => {
  it('defaults to allow and passes the exact final spec, frozen', () => {
    const io = seam(); io.admit = vi.fn(() => true);
    expect(launchAgent(base(), io)).toBe('child');
    const [spec] = io.admit.mock.calls[0];
    const [file, args, options] = io.spawn.mock.calls[0];
    expect(spec).toEqual({ file, args, options });
    expect(Object.isFrozen(spec.args) && Object.isFrozen(spec.options.env)).toBe(true);
    const plain = seam(); expect(launchAgent(base(), plain)).toBe('child');
  });
  it('refuses when admit returns anything but true or throws, and never spawns', () => {
    for (const admit of [() => false, () => undefined, () => 'yes', () => Promise.resolve(true), () => { throw Error('busy'); }]) {
      const io = seam(); io.admit = admit;
      expect(() => launchAgent(base(), io)).toThrow(/not admitted/);
      expect(io.spawn).not.toHaveBeenCalled();
    }
  });
  it('cannot rewrite what is spawned', () => {
    const io = seam(); io.admit = spec => { try { spec.args.push('--dangerous'); } catch { /* frozen */ } return true; };
    launchAgent(base(), io);
    expect(io.spawn.mock.calls[0][1]).not.toContain('--dangerous');
  });
});

describe('value-gated auth vars forward only their tightening values', () => {
  const envOf = (inheritEnv) => buildAgentInvocation({ ...base(), ...(inheritEnv ? { inheritEnv } : {}) }, seam()).options.env;
  it('forwards refuse/app and drops allow/personal, from either source', () => {
    expect(envOf({ WE_GH_AUTH_PERSONAL_FALLBACK: ' Refuse ', WE_GITHUB_AUTH: 'app' }))
      .toMatchObject({ WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse', WE_GITHUB_AUTH: 'app' });
    const relaxed = envOf({ WE_GH_AUTH_PERSONAL_FALLBACK: 'allow', WE_GITHUB_AUTH: 'personal' });
    expect(relaxed).not.toHaveProperty('WE_GH_AUTH_PERSONAL_FALLBACK');
    expect(relaxed).not.toHaveProperty('WE_GITHUB_AUTH');
    vi.stubEnv('WE_GH_AUTH_PERSONAL_FALLBACK', 'refuse');
    expect(envOf()).toMatchObject({ WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse' });
  });
  it('a relaxing bag value cannot override an ambient tightening one', () => {
    vi.stubEnv('WE_GH_AUTH_PERSONAL_FALLBACK', 'refuse'); vi.stubEnv('WE_GITHUB_AUTH', 'app');
    expect(envOf({ WE_GH_AUTH_PERSONAL_FALLBACK: 'allow', WE_GITHUB_AUTH: 'personal' }))
      .toMatchObject({ WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse', WE_GITHUB_AUTH: 'app' });
  });
});

describe('value-gated restrictions reach exact-string consumers', () => {
  it('canonicalizes enabling values and keeps ambient policy when the bag supplies another tightening mode', () => {
    const names = ['WE_HEAVY_ADMISSION_CONTAINER', 'WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES'];
    for (const name of names) vi.stubEnv(name, undefined);
    const envOf = inheritEnv => buildAgentInvocation({ ...base(), inheritEnv }, seam()).options.env;
    expect(envOf(Object.fromEntries(names.map(n => [n, ' 1 '])))).toMatchObject(Object.fromEntries(names.map(n => [n, '1'])));
    for (const name of names) vi.stubEnv(name, '1');
    expect(envOf(Object.fromEntries(names.map(n => [n, ' true '])))).toMatchObject(Object.fromEntries(names.map(n => [n, '1'])));
    vi.stubEnv('WE_JUDGE_NOT_REAL_MODE', 'off');
    expect(envOf({ WE_JUDGE_NOT_REAL_MODE: 'evidence-required' }).WE_JUDGE_NOT_REAL_MODE).toBe('off');
  });
  it('snapshots restrictive shim paths before resolver mutation', () => {
    const shim = defaultShimDir(userInfo().homedir);
    const bag = { PATH: shim };
    vi.stubEnv('PATH', shim);
    const io = seam(); io.resolveBinary.mockImplementation(() => {
      bag.PATH = '/attacker'; process.env.PATH = '/other-attacker'; return process.execPath;
    });
    expect(buildAgentInvocation({ ...base(), inheritEnv: bag }, io).options.env.PATH).toBe(`${shim}:${fixedPath()}`);
  });
});
