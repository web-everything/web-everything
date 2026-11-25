import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { launchAgent, buildAgentInvocation, buildAgentArgs, findAgentBinary } from '../lib/agent-launch.mjs';
const CODEX_SHIM_DIR = new NodeURL('../codex-shims', import.meta.url).pathname;

// Test data only: this slice does not depend on the direct-task adapter.
function codexDescriptor({ cwd, env, review = false, tempRoot, model, effort, ephemeral, writableRoots, outputLastMessageFile }) {
  const config = {};
  if (effort !== undefined) config.model_reasoning_effort = effort;
  if (writableRoots !== undefined) config['sandbox_workspace_write.writable_roots'] = writableRoots;
  if (!review && tempRoot !== undefined) {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) config[`shell_environment_policy.set.${key}`] = tempRoot;
  }
  return { agent: 'codex', cwd, env, sandbox: review ? 'read-only' : 'workspace-write',
    processGroup: true, model, ephemeral, outputLastMessageFile, config,
    pathPrefix: CODEX_SHIM_DIR, ...(review ? {} : { tempRoot }) };
}

const SID = '12345678-1234-4234-8234-123456789abc';
const cwd = process.cwd();
let root, bin, binary;
const base = () => ({ agent: 'codex', cwd, pathPrefix: CODEX_SHIM_DIR, model: 'gpt-5.6-sol', sandbox: 'workspace-write', env: { PATH: bin } });
const claude = () => ({ agent: 'claude', cwd, pathPrefix: CODEX_SHIM_DIR, print: true, sessionId: SID, prompt: 'hello', env: { PATH: bin } });
const seam = () => ({ admit: vi.fn(() => true), spawn: vi.fn(() => 'child'), resolveBinary: vi.fn(() => binary) });
function refused(descriptor, reason) {
  const io = seam();
  expect(() => launchAgent(descriptor, io)).toThrow(reason);
  expect(io.spawn).not.toHaveBeenCalled();
  expect(io.resolveBinary).not.toHaveBeenCalled();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-launch-'));
  bin = join(root, 'bin'); mkdirSync(bin);
  for (const agent of ['codex', 'claude']) symlinkSync(process.execPath, join(bin, agent));
  binary = realpathSync(process.execPath);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

// Expected prefix projection for local descriptor fixtures.
function prefixedPath(env) {
  const rest = String(env.PATH ?? '').split(':').filter((d) => d && d !== CODEX_SHIM_DIR);
  return [CODEX_SHIM_DIR, ...rest].join(':');
}
// Independent oracle: runtime loader variables inject caller code into the agent process
// (or the interpreters it starts) before any agent sandbox exists, so they never reach the child.
const LOADER_ORACLE = {
  NODE_OPTIONS: '--import=/attacker/payload.mjs', NODE_PATH: '/attacker/modules',
  BUN_OPTIONS: '--preload=/attacker/payload.mjs', bun_options: '--preload=/attacker/lower.mjs',
  NODE_REPL_EXTERNAL_MODULE: '/attacker/repl.js',
  OPENSSL_CONF: '/attacker/openssl.cnf', OPENSSL_MODULES: '/attacker/ossl-modules', OPENSSL_ENGINES: '/attacker/engines',
  LD_PRELOAD: '/attacker/lib', LD_LIBRARY_PATH: '/attacker/libs', LD_AUDIT: '/attacker/audit',
  DYLD_INSERT_LIBRARIES: '/attacker/lib', DYLD_LIBRARY_PATH: '/attacker/libs', DYLD_FRAMEWORK_PATH: '/attacker/fw',
  PYTHONPATH: '/attacker/python', PYTHONSTARTUP: '/attacker/startup.py', PYTHONHOME: '/attacker/home',
  PYTHONUSERBASE: '/attacker/user', PERL5OPT: '-Mattacker', PERL5LIB: '/attacker/perl', PERLLIB: '/attacker/perl',
  PERL5DB: 'BEGIN{attacker}', RUBYOPT: '-rattacker', RUBYLIB: '/attacker/ruby',
  JAVA_TOOL_OPTIONS: '-javaagent:/attacker.jar', _JAVA_OPTIONS: '-javaagent:/attacker.jar',
  JDK_JAVA_OPTIONS: '-javaagent:/attacker.jar', GCONV_PATH: '/attacker/gconv',
  // Case variants: dropped too, so a case-folding platform can never revive one.
  node_options: '--require=/attacker/x.cjs', Ld_Preload: '/attacker/lib', dyld_insert_libraries: '/attacker/lib',
};
const projectedEnv = env => ({ PATH: prefixedPath(env), HOME: userInfo().homedir,
  ...Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].filter(key => env[key] !== undefined).map(key => [key, env[key]])) });
const matrix = [
  ...Object.keys(LOADER_ORACLE).map(key => [key, { [key]: 'caller-value' }]),
  ['CUSTOM_OPTIONS', { CUSTOM_OPTIONS: 'caller-value' }],
  ['nonallowlisted loader look-alikes', { NODE_ENV: 'production', PYTHONUNBUFFERED: '1', LDFLAGS: '-L/x', OLD_PRELOAD: 'x' }],
  ['Git config parameters', { GIT_CONFIG_PARAMETERS: "'protocol.ext.allow'='user'" }],
  ['Git transport pair', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always' }],
  ['Git protocol allowlist', { GIT_ALLOW_PROTOCOL: 'https:ext' }],
  ['HOME', { HOME: '/caller-home' }],
  ['GH_CONFIG_DIR', { GH_CONFIG_DIR: '/caller/gh' }],
  ['GIT_INDEX_FILE', { GIT_INDEX_FILE: '/caller/index' }],
  ['Git isolation', { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }],
  ['Git pairs', { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'fetch.fsckObjects', GIT_CONFIG_VALUE_1: 'true' }],
  ['Git prompt', { GIT_TERMINAL_PROMPT: 'false' }],
  ['policy', { WE_PLATFORM_PREFERENCES_FILE: '/caller/policy.json', WE_POLICY_CONFIG: '/caller/config.json', WE_PLATFORM_PREFERENCES: 'caller-policy' }],
  ['gates', { WE_JUDGE_ACTOR_ENABLED: 'invalid', WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse', WE_HEAVY_ADMISSION: 'off', WE_PR_LIMIT_OFF: '1' }],
  ['roots', { LANE_POOL_ROOT: '/caller/lanes', WE_GH_THROTTLE_LOCK_ROOT: '/caller/locks' }],
  ['retry caps', { WE_REVIEW_RED_TEAM_ON_SKIP_CI_HELD_RECORD_RETRY_MAX: '3', WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN: '0' }],
  ['latency and TTL', { WE_SMOKE_GH_LATENCY_SCALE: '0', WE_FORCE_ADOPT_TTL_MS: '1000' }],
  ['formerly stripped non-runtime values', { GIT_SSH: '/caller/ssh', GIT_SSH_COMMAND: 'caller ssh', MAIN_PUSH_OK: '1', GH_TOKEN: 'caller-token', BASH_ENV: '/caller/startup' }],
  ['undefined and arbitrary', { OMIT: undefined, UNKNOWN: 'verbatim', EMPTY: '' }],
];
const envLaunchPaths = [
  ['codex edit', env => codexDescriptor({ cwd, env, review: false })],
  ['codex review', env => codexDescriptor({ cwd, env, review: true })],
  // Claude has no separate review/edit grammar; both roles use this same branch.
  ['claude', env => ({ ...claude(), env })],
];
const invalidEnvKeys = [
  ["GIT_CONFIG_PARAMETERS='protocol.ext.allow'", "'always'"],
  ['GIT_ALLOW_PROTOCOL=ext:', 'ssh'],
  ['NODE_OPTIONS=--require', '/caller/preload.cjs'],
  ['BAD=KEY', 'value'],
  ['BAD\0KEY', 'value'],
  ['', 'value'],
];
describe('B1/B2 caller environment without any ambient merge', () => {
  for (const [path, descriptor] of envLaunchPaths) {
    it.each(invalidEnvKeys.flatMap(([key, value]) => [[key, value], [key, undefined]]))(
      `refuses malformed env key %j with value %j before spawn (${path})`, (key, value) => {
        const d = descriptor({ PATH: bin, [key]: value });
        const reason = `env key ${JSON.stringify(key)}`;
        refused(d, reason);
        expect(() => buildAgentArgs(d)).toThrow(reason);
      });
    it.each(invalidEnvKeys.slice(0, 2))(
      `never runs real Git ext transport through an equals-key env %j (${path})`, (key, value) => {
        const marker = join(root, 'ext-ran');
        writeFileSync(join(root, 'ext-probe'), '#!/bin/sh\nprintf EXT-RAN > "$EXT_MARKER"\nexit 1\n', { mode: 0o755 });
        const env = { PATH: `${bin}:/usr/bin:/bin`, EXT_MARKER: marker,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
          [key]: value };
        const probe = childEnv => spawnSync('git', ['ls-remote', 'ext::./ext-probe'], {
          cwd: root, env: childEnv, encoding: 'utf8', timeout: 2000, maxBuffer: 8192,
        });
        // Positive control: Node's key=value serialization really enables ext here.
        const exposed = probe(env);
        expect(exposed.error).toBeUndefined();
        expect(readFileSync(marker, 'utf8')).toBe('EXT-RAN');
        rmSync(marker);
        const io = seam();
        io.spawn.mockImplementation((_file, _args, options) => probe(options.env));
        let rejection;
        try { launchAgent(descriptor(env), io); } catch (error) { rejection = error; }
        expect(existsSync(marker), 'ext transport must never execute').toBe(false);
        expect(rejection).toBeInstanceOf(TypeError);
        expect(rejection.message).toContain(`env key ${JSON.stringify(key)}`);
        expect(io.spawn).not.toHaveBeenCalled();
        expect(io.resolveBinary).not.toHaveBeenCalled();
      });
  }
  it('does not inherit omitted ambient bypasses, runtime options or Git pairs', () => {
    for (const [key, value] of Object.entries({ WE_HEAVY_ADMISSION: 'off', WE_PR_LIMIT_OFF: '1', NODE_OPTIONS: '--require x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'x' })) vi.stubEnv(key, value);
    const io = seam(); launchAgent(base(), io);
    expect(io.spawn.mock.calls[0][2].env).toEqual(projectedEnv({ PATH: bin }));
  });
  it('has no ambient process environment access in the launcher source', () => {
    expect(readFileSync(new NodeURL('../lib/agent-launch.mjs', import.meta.url), 'utf8')).not.toContain('process.env');
  });
  for (const review of [false, true]) it.each(matrix)(`environment projection review=${review}: %s`, (_name, extra) => {
    vi.stubEnv('HOME', '/ambient-home'); vi.stubEnv('SEC1_AMBIENT_ONLY', 'excluded');
    const env = { PATH: `${bin}:${CODEX_SHIM_DIR}:${bin}`, TMP: '/caller/tmp', ...extra };
    const tempRoot = '/task-temp';
    const descriptor = codexDescriptor({ cwd, env, review, tempRoot });
    expect(descriptor.env).toBe(env);
    const io = seam(); launchAgent(descriptor, io);
    const defined = projectedEnv(env);
    expect(io.spawn.mock.calls[0][2].env).toEqual(review ? defined : {
      ...defined, PATH: prefixedPath(env), TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot,
    });
  });
  it.each([null, [], 'X=1', { X: 1 }, { X: 'nul\0value' }])('refuses invalid env %j before spawn', env => refused({ ...base(), env }, /env/));
  it('omits undefined and unknown keys and replaces caller HOME', () => {
    const env = { PATH: bin, OMIT: undefined, EMPTY: '', HOME: '/caller-home' };
    const io = seam(); launchAgent({ ...base(), env }, io);
    expect(io.spawn.mock.calls[0][2].env).toEqual(projectedEnv({ PATH: bin }));
  });
  it('keeps caller TMP untouched when read-only has an explicit tempRoot', () => {
    const env = { PATH: bin, TMP: '/c' };
    const io = seam();
    launchAgent({ ...base(), sandbox: 'read-only', tempRoot: '/x', env }, io);
    expect(io.spawn.mock.calls[0][2].env).toEqual(projectedEnv(env));
  });
  it('executes a dispatcher symlink using its codex PATH name', () => {
    const dispatcher = join(root, 'dispatcher');
    writeFileSync(dispatcher, '#!/bin/sh\nname=${0##*/}\nprintf "%s\\n" "$name"\n[ "$name" = codex ] || exit 1\n', { mode: 0o755 });
    const dispatchBin = join(root, 'dispatch-bin');
    mkdirSync(dispatchBin);
    symlinkSync(dispatcher, join(dispatchBin, 'codex'));
    const child = launchAgent({ ...base(), env: { PATH: dispatchBin } }, {
      admit: () => true,
      resolveBinary: agent => findAgentBinary(agent, [dispatchBin]),
      spawn: (file, args, options) => spawnSync(file, args, { ...options, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 }),
    });
    expect(child.error).toBeUndefined();
    expect(child.stdout).toBe('codex\n');
    expect(child.status, child.stderr).toBe(0);
  });
  it('refuses legacy inherit fields, env accessors and env proxies before IO', () => {
    refused({ ...base(), inheritEnv: {} }, /inheritEnv/);
    refused({ ...base(), inheritEnvComplete: true }, /inheritEnvComplete/);
    const getter = vi.fn(); const env = Object.defineProperty({}, 'X', { get: getter });
    refused({ ...base(), env }, /accessor/); expect(getter).not.toHaveBeenCalled();
    refused({ ...base(), env: new Proxy({}, {}) }, /Proxy/);
  });
  it('snapshots caller env before a resolver can mutate it', () => {
    const env = { PATH: bin, HOME: '/caller-home' }; const io = seam();
    io.resolveBinary.mockImplementation(() => { env.PATH = '/mutated'; env.HOME = '/mutated'; return binary; });
    launchAgent({ ...base(), env }, io);
    expect(io.spawn.mock.calls[0][2].env).toEqual(projectedEnv({ PATH: bin }));
  });
});

describe('snapshot PATH isolation', () => {
  it.each(['getter', 'Proxy'])('never rereads a caller PATH replaced by a hostile %s after snapshot', kind => {
    const env = { PATH: bin }; const descriptor = { ...base(), env }; const io = seam();
    const trap = vi.fn(() => { throw Error('caller PATH read after snapshot'); });
    io.resolveBinary.mockImplementation(() => {
      if (kind === 'getter') Object.defineProperty(env, 'PATH', { get: trap });
      else descriptor.env = new Proxy(env, { get: trap, ownKeys: trap });
      return binary;
    });
    launchAgent(descriptor, io);
    expect(trap).not.toHaveBeenCalled();
    expect(io.admit.mock.calls[0][0].options.env).toEqual(projectedEnv({ PATH: bin }));
    expect(io.spawn.mock.calls[0][2].env).toEqual(projectedEnv({ PATH: bin }));
  });
  it('refuses a hostile snapshotted PATH even if the caller replaces it with a trusted PATH', () => {
    const wrapper = join(root, 'snapshot-wrapper'); mkdirSync(wrapper);
    writeFileSync(join(wrapper, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { PATH: `${wrapper}:${bin}` }; const io = seam();
    io.resolveBinary.mockImplementation(() => { env.PATH = bin; return binary; });
    expect(() => launchAgent({ ...base(), env }, io)).toThrow(/identity/);
    expect(io.admit).not.toHaveBeenCalled(); expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each(['getter', 'Proxy'])('refuses unreadable caller PATH via %s before IO', kind => {
    const trap = vi.fn(() => { throw Error('unreadable'); });
    const env = kind === 'getter' ? Object.defineProperty({}, 'PATH', { get: trap }) : new Proxy({}, { get: trap });
    refused({ ...base(), env }, /accessor|Proxy/);
    expect(trap).not.toHaveBeenCalled();
  });
});

describe('B3/B4 exact PATH and TMP projection', () => {
  it('retains the first caller gh guard before the real gh and appends no directories', () => {
    const guard = join(root, 'guard'), real = join(root, 'real');
    for (const dir of [guard, real]) { mkdirSync(dir); writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
    symlinkSync(binary, join(real, 'codex'));
    const io = seam(); launchAgent({ ...base(), env: { PATH: `${guard}:${real}` }, pathPrefix: CODEX_SHIM_DIR }, io);
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(`${CODEX_SHIM_DIR}:${guard}:${real}`);
    expect(findAgentBinary('gh', io.spawn.mock.calls[0][2].env.PATH.split(':'))).toBe(join(guard, 'gh'));
  });
  it('projects exactly shim then caller directories, with no additional installation dirs', () => {
    const d = codexDescriptor({ cwd, env: { PATH: bin } });
    expect(d.pathPrefix).toBe(CODEX_SHIM_DIR);
    const io = seam(); launchAgent(claude(), io);
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(`${CODEX_SHIM_DIR}:${bin}`);
  });
  it('review prefixes PATH while leaving caller TMP unchanged', () => {
    const env = { PATH: `${bin}:${bin}`, TMPDIR: '/caller/tmp' };
    const io = seam(); launchAgent(codexDescriptor({ cwd, env, review: true, tempRoot: '/ignored' }), io);
    expect(io.spawn.mock.calls[0][2].env).toEqual(projectedEnv(env));
  });
  it('review without caller PATH refuses when the guard directory has no Codex', () => {
    const descriptor = codexDescriptor({ cwd, env: { TMP: '/caller/tmp' }, review: true });
    expect(descriptor.env).not.toHaveProperty('PATH');
    const io = seam();
    expect(() => launchAgent(descriptor, io)).toThrow(/codex.*PATH/);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(descriptor.env).toEqual({ TMP: '/caller/tmp' });
  });
  it('refuses a relative non-review PATH entry before spawn', () => {
    const io = seam();
    expect(() => launchAgent(codexDescriptor({ cwd, env: { PATH: `.:${bin}` } }), io)).toThrow(/PATH/);
    expect(io.spawn).not.toHaveBeenCalled(); expect(io.resolveBinary).not.toHaveBeenCalled();
  });
  it('accepts config PATH only when it exactly matches the final child PATH', () => {
    const PATH = prefixedPath(base().env);
    const io = seam(); launchAgent({ ...base(), config: { 'shell_environment_policy.set.PATH': PATH } }, io);
    expect(io.spawn.mock.calls[0][1]).toContain(`shell_environment_policy.set.PATH=${JSON.stringify(PATH)}`);
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(PATH);
  });
});

describe('B5 same executable as main or refuse', () => {
  function noSpawn(env, reason) {
    const io = seam(); expect(() => launchAgent({ ...base(), env }, io)).toThrow(reason); expect(io.spawn).not.toHaveBeenCalled();
  }
  it('refuses a caller codex wrapper ahead of the fixed binary', () => {
    const wrapper = join(root, 'wrapper'); mkdirSync(wrapper);
    writeFileSync(join(wrapper, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    noSpawn({ PATH: `${wrapper}:${bin}` }, /binary.*differ|identity/);
  });
  it('launches the fixed lookup path when it is the first executable codex', () => {
    const io = seam(); launchAgent(base(), io); expect(io.spawn.mock.calls[0][0]).toBe(binary);
  });
  it.each(['.', 'relative', ''])('refuses a %j PATH entry before or after codex', entry => {
    noSpawn({ PATH: `${entry}:${bin}` }, /relative|absolute/);
    noSpawn({ PATH: `${bin}:${entry}` }, /relative|absolute/);
  });
  it('refuses no codex, missing PATH and an empty entry before codex', () => {
    noSpawn({ PATH: root }, /codex.*PATH/); noSpawn({}, /codex.*PATH/); noSpawn({ PATH: `:${bin}` }, /relative|absolute/);
  });
  it.each(['missing', 'regular-file'])('checks the literal PATH entry through a %s component', component => {
    if (component === 'regular-file') writeFileSync(join(root, component), 'not a directory');
    const literal = `${root}/${component}/../bin`;
    // The OS cannot resolve this entry, even though path.join would turn it into bin.
    const probe = spawnSync('codex', ['--version'], { env: { PATH: literal }, timeout: 5000, maxBuffer: 8192 });
    expect(['ENOENT', 'ENOTDIR']).toContain(probe.error?.code);
    noSpawn({ PATH: literal }, /codex.*PATH/);
  });
  it('does not let a normalized missing PATH entry hide a later wrapper', () => {
    const wrapper = join(root, 'later-wrapper'); mkdirSync(wrapper);
    writeFileSync(join(wrapper, 'codex'), '#!/bin/sh\nprintf wrapper\n', { mode: 0o755 });
    const PATH = `${root}/missing/../bin:${wrapper}`;
    const probe = spawnSync('codex', [], { env: { PATH }, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe('wrapper');
    noSpawn({ PATH }, /binary.*differ|identity/);
  });
  it.each(['child PATH', 'fixed binary'])('checks symlink-parent traversal in %s against the actual executable', source => {
    const other = join(root, 'other'); mkdirSync(other);
    mkdirSync(join(other, 'nested')); mkdirSync(join(other, 'bin'));
    symlinkSync(join(other, 'nested'), join(root, 'link'));
    writeFileSync(join(other, 'bin', 'codex'), '#!/bin/sh\nprintf wrapper\n', { mode: 0o755 });
    const PATH = `${root}/link/../bin`;
    const probe = spawnSync('codex', [], { env: { PATH }, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe('wrapper');
    const io = seam();
    const descriptor = { ...base(), env: { PATH: source === 'child PATH' ? PATH : bin } };
    if (source === 'fixed binary') io.resolveBinary.mockReturnValue(`${PATH}/codex`);
    expect(() => launchAgent(descriptor, io)).toThrow(/binary.*differ|identity/);
    expect(io.spawn).not.toHaveBeenCalled();
    rmSync(join(other, 'bin', 'codex'));
    symlinkSync(binary, join(other, 'bin', 'codex'));
    launchAgent(descriptor, io);
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(prefixedPath(descriptor.env));
    expect(io.spawn.mock.calls[0][0]).toBe(source === 'fixed binary' ? `${PATH}/codex` : binary);
  });
  it('compares review binary identity against prefixed child PATH', () => {
    const wrapper = join(root, 'review-wrapper'); mkdirSync(wrapper);
    writeFileSync(join(wrapper, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const io = seam();
    expect(() => launchAgent(codexDescriptor({ cwd, env: { PATH: `${wrapper}:${bin}` }, review: true }), io)).toThrow(/binary.*differ|identity/);
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it.each(['permission denied', 'symlink loop'])('refuses unreadable PATH evidence (%s) instead of falling through to a trusted binary', kind => {
    const unreadable = join(root, 'unreadable');
    if (kind === 'permission denied') { mkdirSync(unreadable); chmodSync(unreadable, 0o000); }
    else symlinkSync(unreadable, unreadable);
    try { noSpawn({ PATH: `${unreadable}:${bin}` }, /unreadable.*restore access/); }
    finally { if (kind === 'permission denied') chmodSync(unreadable, 0o700); }
  });
  it('refuses a non-executable PATH candidate instead of falling through', () => {
    const blocked = join(root, 'blocked'); mkdirSync(blocked);
    writeFileSync(join(blocked, 'codex'), 'blocked', { mode: 0o600 });
    noSpawn({ PATH: `${blocked}:${bin}` }, /unreadable/);
  });
  it('refuses unreadable fixed binary lookup instead of using a later installation', () => {
    writeFileSync(join(root, 'codex'), 'blocked', { mode: 0o600 });
    expect(() => findAgentBinary('codex', [root, bin])).toThrow(/binary unreadable/);
    const io = seam(); io.resolveBinary.mockImplementation(() => findAgentBinary('codex', [root, bin]));
    expect(() => launchAgent(base(), io)).toThrow(/binary unreadable/);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it('fixed lookup refuses missing and non-executable installations', () => {
    writeFileSync(join(root, 'codex'), 'not executable', { mode: 0o644 });
    expect(() => findAgentBinary('codex', [root])).toThrow(/binary unreadable/);
    chmodSync(join(root, 'codex'), 0o755);
    expect(findAgentBinary('codex', [join(root, 'missing'), root])).toBe(join(root, 'codex'));
    expect(() => findAgentBinary('claude', [root])).toThrow(/binary not found/);
  });
});

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
    for (const field of ['execPath', 'execArgv', 'fork', 'file', 'args', 'argv', 'stdio', 'detached']) refused({ ...base(), [field]: [] }, new RegExp(field));
  });
  it.each(['codex', 'claude'])('11 drops caller runtime loader variables for %s, admission and spawn alike', agent => {
    const kept = { PATH: prefixedPath({ PATH: bin }), HOME: userInfo().homedir, LANG: 'en_CA.UTF-8' };
    const env = { PATH: bin, LANG: kept.LANG, ...LOADER_ORACLE, SAFE: 'dropped', NODE_ENV: 'production' };
    const io = { ...seam(), admit: vi.fn(spec => { expect(spec.options.env).toEqual(kept); return true; }) };
    io.spawn.mockImplementation((_file, _args, options) => {
      expect(options.env).toEqual(kept);
      return 'child';
    });
    expect(launchAgent({ ...(agent === 'codex' ? base() : claude()), env }, io)).toBe('child');
    expect(io.admit).toHaveBeenCalledOnce();
    expect(io.spawn).toHaveBeenCalledOnce();
    expect(env.NODE_OPTIONS).toBe('--import=/attacker/payload.mjs'); // caller record is never mutated
  });
  for (const [path, descriptor] of envLaunchPaths) it(`11 never runs a caller NODE_OPTIONS preload in a real Node child (${path})`, () => {
    const payload = join(root, 'payload.mjs'), marker = join(root, 'payload-executed');
    writeFileSync(payload, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const run = options => spawnSync(binary, ['-e', 'process.stdout.write("agent started")'], {
      ...options, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    const env = { PATH: bin, NODE_OPTIONS: `--import=${JSON.stringify(payload)}` };
    // Positive control: this env really executes the payload when it reaches a Node child unfiltered.
    const exposed = run({ cwd, env });
    expect(exposed.status, exposed.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('executed');
    rmSync(marker);
    const invocation = buildAgentInvocation(descriptor(env), seam());
    const child = run(invocation.options);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('agent started');
    expect(existsSync(marker), 'caller preload must never execute in the agent').toBe(false);
  });
  it('12 drops shell startup variables while preserving allowlisted SHELL', () => {
    const env = { ...base().env, BASH_ENV: '/caller/startup', ENV: '/caller/env', ZDOTDIR: '/caller/zsh', SHELL: '/caller/shell' };
    expect(buildAgentInvocation({ ...base(), env }, seam()).options.env).toEqual({ ...projectedEnv(env), SHELL: env.SHELL });
  });
  it('13 replaces caller HOME while refusing a raw HOME descriptor field', () => {
    vi.stubEnv('HOME', '/ambient');
    expect(buildAgentInvocation({ ...base(), env: { ...base().env, HOME: '/caller-home' } }, seam()).options.env.HOME).toBe(userInfo().homedir);
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
  it('preserves direct spawn options and token order', () => {
    const d = codexDescriptor({ cwd, env: { PATH: bin }, outputLastMessageFile: '/last', model: 'gpt-5.6-sol', effort: 'high' });
    const io = seam(); expect(launchAgent(d, io)).toBe('child');
    expect(io.spawn).toHaveBeenCalledWith(binary, buildAgentArgs(d), {
      shell: false, cwd, env: projectedEnv(d.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
  });
  it('encodes writable roots and temp strings as data and preserves ephemeral', () => {
    const tempRoot = '/task "quote" \\ $TMP';
    const d = codexDescriptor({ cwd, env: { PATH: bin }, model: 'gpt-5.6-sol', effort: 'high', ephemeral: true, writableRoots: [tempRoot], tempRoot });
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
  });
  it('rejects invalid resolver evidence and preserves spawn failures', () => {
    const io = seam(); io.resolveBinary.mockReturnValue('codex');
    expect(() => launchAgent(base(), io)).toThrow(/binary/); expect(io.spawn).not.toHaveBeenCalled();
    io.resolveBinary.mockReturnValue(binary); io.spawn.mockImplementation(() => { throw Error('spawn failed'); });
    expect(() => launchAgent(base(), io)).toThrow('spawn failed');
  });
});

describe('admission hook point (#7090 moves runtime admission here)', () => {
  it('requires explicit admission and passes the exact final spec, frozen', () => {
    const io = seam(); io.admit = vi.fn(() => true);
    expect(launchAgent(base(), io)).toBe('child');
    const [spec] = io.admit.mock.calls[0];
    const [file, args, options] = io.spawn.mock.calls[0];
    expect(spec).toEqual({ file, args, options });
    expect(Object.isFrozen(spec.args) && Object.isFrozen(spec.options.env)).toBe(true);
    const plain = seam(); delete plain.admit;
    expect(() => launchAgent(base(), plain)).toThrow('launch not admitted');
    expect(plain.spawn).not.toHaveBeenCalled();
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


describe('RS-7170-1 round-2 security boundary', () => {
  const forged = {
    WE_HEAVY_ADMISSION: 'off', WE_HEAVY_ADMISSION_HELD: '1', WE_PR_LIMIT_OFF: '1', MAIN_PUSH_OK: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    BASH_ENV: '/caller/bash', ENV: '/caller/env', ZDOTDIR: '/caller/zsh',
    CODEX_HOME: '/caller/codex', CLAUDE_CONFIG_DIR: '/caller/claude', UNKNOWN_FUTURE_BYPASS: '1',
  };
  for (const [role, descriptor] of envLaunchPaths) {
    it.each(Object.entries(forged))(`drops forged %s from spawn env (${role})`, (key, value) => {
      const io = seam();
      launchAgent({ ...descriptor({ PATH: bin, [key]: value }), pathPrefix: root }, io);
      expect(io.spawn.mock.calls[0][2].env).not.toHaveProperty(key);
    });
    it(`replaces caller HOME with the OS account home (${role})`, () => {
      const io = seam();
      launchAgent({ ...descriptor({ PATH: bin, HOME: '/caller/forged-home' }), pathPrefix: root }, io);
      expect(io.spawn.mock.calls[0][2].env.HOME).toBe(userInfo().homedir);
    });
    it.each([undefined, 'relative', ''])(`refuses missing/nonabsolute guard prefix %j (${role})`, pathPrefix => {
      const d = { ...descriptor({ PATH: bin }), pathPrefix };
      const io = seam();
      expect(() => buildAgentInvocation(d, io)).toThrow(/pathPrefix/);
      expect(() => launchAgent(d, io)).toThrow(/pathPrefix/);
      expect(io.spawn).not.toHaveBeenCalled();
      expect(io.admit).not.toHaveBeenCalled();
    });
  }
  it.each(['codex', 'claude'])('preserves every allowlisted env category for %s', agent => {
    const allowed = {
      USER: 'caller', LOGNAME: 'caller', SHELL: '/bin/sh', TERM: 'xterm', LANG: 'en_CA.UTF-8',
      LC_ALL: 'C', LC_CUSTOM: 'custom', TZ: 'UTC', NO_COLOR: '', FORCE_COLOR: '1', CI: 'true',
      TMPDIR: '/task/tmp', TMP: '/task/tmp', TEMP: '/task/tmp', SSH_AUTH_SOCK: '/task/socket',
      HTTP_PROXY: 'http://proxy', HTTPS_PROXY: 'http://proxy', NO_PROXY: 'localhost',
      http_proxy: 'http://proxy', https_proxy: 'http://proxy', no_proxy: 'localhost',
      ANTHROPIC_API_KEY: 'test-anthropic', OPENAI_API_KEY: 'test-openai',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth', CODEX_API_KEY: 'test-codex',
    };
    const env = { PATH: bin, ...allowed, OMIT: undefined };
    const io = seam(); launchAgent({ ...(agent === 'codex' ? base() : claude()), env }, io);
    expect(io.spawn.mock.calls[0][2].env).toEqual({ PATH: prefixedPath(env), HOME: userInfo().homedir, ...allowed });
    expect(io.admit.mock.calls[0][0].options.env).toEqual(io.spawn.mock.calls[0][2].env);
    expect(env).not.toHaveProperty('HOME');
  });
  it.each(['.:/usr/bin', ':/usr/bin', '/usr/bin:'])('refuses unsafe Claude PATH %j', PATH => {
    refused({ ...claude(), pathPrefix: root, env: { PATH } }, /PATH/);
  });
  it('refuses Claude shadowed ahead of the fixed installation', () => {
    const shadow = join(root, 'shadow'); mkdirSync(shadow);
    writeFileSync(join(shadow, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const io = seam();
    expect(() => launchAgent({ ...claude(), pathPrefix: root, env: { PATH: `${shadow}:${bin}` } }, io)).toThrow(/claude.*identity/);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(io.admit).not.toHaveBeenCalled();
  });
  it('refuses config PATH that differs from the final prefixed child PATH', () => {
    refused({ ...base(), pathPrefix: root, config: { 'shell_environment_policy.set.PATH': bin } }, /PATH.*match|PATH.*equal/);
  });
});
