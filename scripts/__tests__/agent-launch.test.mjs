import { afterEach, describe, expect, it, vi } from 'vitest';
import { userInfo, tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { launchAgent, buildAgentInvocation, buildAgentArgs, findAgentBinary } from '../lib/agent-launch.mjs';
import { buildCodexDirectTaskDescriptor, CODEX_SHIM_DIR } from '../codex-direct-task.mjs';

const SID = '12345678-1234-4234-8234-123456789abc';
const cwd = process.cwd();
const base = () => ({ agent: 'codex', cwd, model: 'gpt-5.6-sol', sandbox: 'workspace-write' });
const claude = () => ({ agent: 'claude', cwd, print: true, sessionId: SID, prompt: 'hello' });
const seam = () => ({ spawn: vi.fn(() => 'child'), resolveBinary: vi.fn(() => process.execPath) });
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
    expect(Object.keys(io.spawn.mock.calls[0][2].env).every(k => ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'VITEST', 'WE_UNDER_TEST', 'LANE_POOL_ROOT'].includes(k))).toBe(true);
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
    expect(env.PATH).toBe(`/shim:/usr/bin:/bin:/usr/sbin:/sbin:${dirname(process.execPath)}`);
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
    for (const bad of ['relative/pool', '-pool', '']) {
      vi.stubEnv('LANE_POOL_ROOT', bad);
      const io = seam();
      expect(() => launchAgent(base(), io)).toThrow(/LANE_POOL_ROOT/);
      expect(io.spawn).not.toHaveBeenCalled();
    }
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
