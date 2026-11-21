import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { launchAgent, buildAgentInvocation, buildAgentArgs, findAgentBinary } from '../lib/agent-launch.mjs';
import { buildCodexDirectTaskDescriptor, CODEX_SHIM_DIR } from '../codex-direct-task.mjs';

const SID = '12345678-1234-4234-8234-123456789abc';
const cwd = process.cwd();
let root, bin, binary;
const base = () => ({ agent: 'codex', cwd, model: 'gpt-5.6-sol', sandbox: 'workspace-write', env: { PATH: bin } });
const claude = () => ({ agent: 'claude', cwd, print: true, sessionId: SID, prompt: 'hello', env: { PATH: bin } });
const seam = () => ({ spawn: vi.fn(() => 'child'), resolveBinary: vi.fn(() => binary) });
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

// Independent oracle copied from origin/main c18c5279b4's codexShimPath.
function mainCodexShimPath(env) {
  const rest = String(env.PATH ?? '').split(':').filter((d) => d && d !== CODEX_SHIM_DIR);
  return [CODEX_SHIM_DIR, ...rest].join(':');
}
const matrix = [
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
  ['codex edit', env => buildCodexDirectTaskDescriptor({ cwd, env, review: false })],
  ['codex review', env => buildCodexDirectTaskDescriptor({ cwd, env, review: true })],
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
describe('B1/B2 caller environment follows main except runtime injection, without any ambient merge', () => {
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
    expect(io.spawn.mock.calls[0][2].env).toEqual({ PATH: bin });
  });
  it('has no ambient process environment access in the launcher source', () => {
    expect(readFileSync(new NodeURL('../lib/agent-launch.mjs', import.meta.url), 'utf8')).not.toContain('process.env');
  });
  for (const review of [false, true]) it.each(matrix)(`differential review=${review}: %s`, (_name, extra) => {
    vi.stubEnv('HOME', '/ambient-home'); vi.stubEnv('SEC1_AMBIENT_ONLY', 'excluded');
    const env = { PATH: `${bin}:${CODEX_SHIM_DIR}:${bin}::`, TMP: '/caller/tmp', ...extra };
    const tempRoot = '/task-temp';
    const descriptor = buildCodexDirectTaskDescriptor({ cwd, env, review, tempRoot });
    expect(descriptor.env).toBe(env);
    const io = seam(); launchAgent(descriptor, io);
    const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
    expect(io.spawn.mock.calls[0][2].env).toEqual(review ? defined : {
      ...defined, PATH: mainCodexShimPath(env), TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot,
    });
  });
  it.each([null, [], 'X=1', { X: 1 }, { X: 'nul\0value' }])('refuses invalid env %j before spawn', env => refused({ ...base(), env }, /env/));
  it('omits undefined values without changing other keys', () => {
    const env = { PATH: bin, OMIT: undefined, EMPTY: '', HOME: '/caller-home' };
    const io = seam(); launchAgent({ ...base(), env }, io);
    expect(io.spawn.mock.calls[0][2].env).toEqual({ PATH: bin, EMPTY: '', HOME: '/caller-home' });
  });
  for (const review of [false, true]) it(`preserves ambient user restrictions for normally allowed transports (review=${review})`, () => {
    // Local remote helpers implement only capabilities/list, so permitted operations
    // succeed without a network connection or a Git repository.
    const helper = '#!/bin/sh\nread command || exit 1\n[ "$command" = capabilities ] || exit 1\nprintf "\\n"\nread command || exit 1\n[ "$command" = list ] || exit 1\nprintf "\\n"\nread command\nexit 0\n';
    for (const transport of ['http', 'https', 'fixture']) {
      writeFileSync(join(bin, `git-remote-${transport}`), helper, { mode: 0o755 });
      for (const key of ['protocol.allow', `protocol.${transport}.allow`]) {
        for (const policy of ['never', 'user', 'always']) {
          for (const fromUser of ['0', '1']) {
            const env = { PATH: `${bin}:/usr/bin:/bin`, GIT_EXEC_PATH: bin,
              GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
              GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: policy,
              GIT_PROTOCOL_FROM_USER: fromUser, GIT_TERMINAL_PROMPT: '0' };
            const probe = childEnv => spawnSync('git', ['ls-remote', `${transport}::fixture`], {
              cwd: root, env: childEnv, encoding: 'utf8', timeout: 2000, maxBuffer: 8192,
            });
            const expected = policy === 'always' || (policy === 'user' && fromUser === '1');
            const label = `${key}=${policy}, fromUser=${fromUser}, review=${review}`;
            // Widening values (bare protocol.allow user/always, an unknown protocol to always) are refused.
            if (policy !== 'never' && (key === 'protocol.allow' || (transport === 'fixture' && policy === 'always'))) {
              refused(buildCodexDirectTaskDescriptor({ cwd: root, env, review }), /widens Git transport policy/);
              continue;
            }
            const parent = probe(env);
            const io = seam();
            io.spawn.mockImplementation((_file, _args, options) => probe(options.env));
            const child = launchAgent(buildCodexDirectTaskDescriptor({ cwd: root, env, review }), io);
            for (const result of [parent, child]) {
              expect(result.error, label).toBeUndefined();
              expect(result.status, label).toBe(expected ? 0 : 128);
              if (!expected) expect(result.stderr, label).toContain(`transport '${transport}' not allowed`);
            }
            expect(child.status, label).toBe(parent.status);
            expect(io.spawn.mock.calls[0][2].env.GIT_PROTOCOL_FROM_USER).toBe(fromUser);
            expect(io.spawn.mock.calls[0][2].env.GIT_CONFIG_VALUE_0).toBe(policy);
          }
        }
      }
    }
  });
  // Tighten-only transport guarantee: env-supplied Git config may restrict, never widen,
  // Git's built-in transport defaults (ext never, file and unknown user since git 2.38.1,
  // http/https/git/ssh always).
  const pair = (...kv) => Object.fromEntries([['GIT_CONFIG_COUNT', String(kv.length / 2)],
    ...kv.flatMap((v, i) => (i % 2 ? [] : [[`GIT_CONFIG_KEY_${i / 2}`, v], [`GIT_CONFIG_VALUE_${i / 2}`, kv[i + 1]]]))]);
  it.each([
    ['protocol.ext.allow=user', pair('protocol.ext.allow', 'user')],
    ['protocol.ext.allow=always', pair('protocol.ext.allow', 'always')],
    ['case-folded section and variable', pair('PROTOCOL.ext.ALLOW', 'User')],
    ['bare protocol.allow=user', pair('protocol.allow', 'user')],
    ['bare protocol.allow=always', pair('protocol.allow', 'always')],
    ['ext=user behind a protocol.allow=never pair', pair('protocol.allow', 'never', 'protocol.ext.allow', 'user')],
    ['protocol.allow=user behind ext=never', pair('protocol.ext.allow', 'never', 'protocol.allow', 'user')],
    ['unknown protocol widened to always', pair('protocol.fixture.allow', 'always')],
    ['unknown-case subsection widened to always', pair('protocol.EXT.allow', 'always')],
    ['unparseable policy value', pair('protocol.http.allow', 'sometimes')],
    ['include.path indirection', pair('include.path', '/caller/gitconfig')],
    ['includeIf indirection', pair('includeIf.gitdir:/.path', '/caller/gitconfig')],
    ['stray key beyond the count', { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_3: 'protocol.ext.allow', GIT_CONFIG_VALUE_3: 'user' }],
    ['GIT_CONFIG_PARAMETERS transport pair', { GIT_CONFIG_PARAMETERS: "'protocol.ext.allow'='user'" }],
    ['GIT_CONFIG_PARAMETERS include', { GIT_CONFIG_PARAMETERS: "'include.path'='/caller/gitconfig'" }],
    ['GIT_CONFIG_PARAMETERS old key=value form', { GIT_CONFIG_PARAMETERS: "'Protocol.ext.Allow=USER'" }],
    ['GIT_CONFIG_PARAMETERS widening after a safe entry', { GIT_CONFIG_PARAMETERS: "'soak.x'='y' 'protocol.allow'='always'" }],
    ['GIT_CONFIG_PARAMETERS unparseable', { GIT_CONFIG_PARAMETERS: "'protocol.ext.allow'=user" }],
    ['GIT_CONFIG_PARAMETERS unterminated quote', { GIT_CONFIG_PARAMETERS: "'soak.x'='y" }],
    ['protocol.file.allow=always (file defaults to user)', pair('protocol.file.allow', 'always')],
    ['GIT_ALLOW_PROTOCOL file (file defaults to user)', { GIT_ALLOW_PROTOCOL: 'https:file' }],
    ['GIT_ALLOW_PROTOCOL ext', { GIT_ALLOW_PROTOCOL: 'ext' }],
    ['GIT_ALLOW_PROTOCOL ext among safe', { GIT_ALLOW_PROTOCOL: 'https:ext' }],
    ['GIT_ALLOW_PROTOCOL unknown protocol', { GIT_ALLOW_PROTOCOL: 'https:fixture' }],
  ])('refuses caller env that widens Git transport policy before spawn: %s', (_name, extra) => {
    for (const review of [false, true]) {
      refused(buildCodexDirectTaskDescriptor({ cwd, env: { PATH: bin, ...extra }, review }), /widens Git transport policy/);
    }
    refused({ ...base(), env: { PATH: bin, ...extra } }, /widens Git transport policy/);
    refused({ ...claude(), env: { PATH: bin, ...extra } }, /widens Git transport policy/);
  });
  it.each([
    ['protocol.file.allow=user (lane-pool)', pair('protocol.file.allow', 'user')],
    ['protocol.ext.allow=never', pair('protocol.ext.allow', 'never')],
    ['protocol.allow=never', pair('protocol.allow', 'never')],
    ['protocol.https.allow=user', pair('protocol.https.allow', 'user')],
    ['protocol.ssh.allow=always', pair('protocol.ssh.allow', 'always')],
    ['protocol.fixture.allow=user', pair('protocol.fixture.allow', 'user')],
    ['protocol.version is not a transport policy', pair('protocol.version', '2')],
    ['unrelated pins', pair('core.hooksPath', '', 'fetch.fsckObjects', 'true')],
    ['GIT_ALLOW_PROTOCOL safe allowlist', { GIT_ALLOW_PROTOCOL: 'https:http:git:ssh' }],
    ['GIT_ALLOW_PROTOCOL empty (allows nothing)', { GIT_ALLOW_PROTOCOL: '' }],
    ['GIT_CONFIG_PARAMETERS unrelated', { GIT_CONFIG_PARAMETERS: "'soak.parameter'='inherited'" }],
    ['GIT_CONFIG_PARAMETERS restricting', { GIT_CONFIG_PARAMETERS: "'protocol.ext.allow'='never' 'protocol.allow'='never'" }],
    ['GIT_CONFIG_PARAMETERS old form and escaped quote', { GIT_CONFIG_PARAMETERS: "'url.x.insteadOf=https://protocol.example/' 'user.name'='O'\\''Brien'" }],
    ['GIT_CONFIG_PARAMETERS key without value', { GIT_CONFIG_PARAMETERS: "'core.bare'=" }],
  ])('passes caller env that keeps or tightens Git transport policy verbatim: %s', (_name, extra) => {
    const env = { PATH: bin, ...extra };
    const io = seam(); launchAgent({ ...base(), env }, io);
    expect(io.spawn.mock.calls[0][2].env).toEqual(env);
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
    expect(io.spawn.mock.calls[0][2].env).toEqual({ PATH: bin, HOME: '/caller-home' });
  });
});

describe('B3/B4 exact PATH and TMP projection', () => {
  it('retains the first caller gh guard before the real gh and appends no directories', () => {
    const guard = join(root, 'guard'), real = join(root, 'real');
    for (const dir of [guard, real]) { mkdirSync(dir); writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
    symlinkSync(binary, join(real, 'codex'));
    const io = seam(); launchAgent({ ...base(), env: { PATH: `${guard}:${real}` }, pathPrefix: CODEX_SHIM_DIR }, io);
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(`${CODEX_SHIM_DIR}:${guard}:${real}`);
    expect(findAgentBinary('gh', io.spawn.mock.calls[0][2].env.PATH.split(':'))).toBe(realpathSync(join(guard, 'gh')));
  });
  it('projects /usr/bin to exactly shim:/usr/bin, with no fixed, node or agent dirs', () => {
    const d = buildCodexDirectTaskDescriptor({ cwd, env: { PATH: '/usr/bin' } });
    expect(d.config['shell_environment_policy.set.PATH']).toBe(`${CODEX_SHIM_DIR}:/usr/bin`);
    // Claude has no Codex identity check; exercise the child projection independently of installed codex.
    const io = seam(); launchAgent({ ...claude(), env: { PATH: '/usr/bin' }, pathPrefix: CODEX_SHIM_DIR }, io);
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(`${CODEX_SHIM_DIR}:/usr/bin`);
  });
  it('review keeps PATH exactly, TMP unchanged, and an absent PATH stays absent', () => {
    const env = { PATH: `${bin}::.:${bin}`, TMPDIR: '/caller/tmp' };
    const io = seam(); launchAgent(buildCodexDirectTaskDescriptor({ cwd, env, review: true, tempRoot: '/ignored' }), io);
    expect(io.spawn.mock.calls[0][2].env).toEqual(env);
    expect(buildAgentInvocation({ ...claude(), env: { TMP: '/caller/tmp' } }, seam()).options.env).toEqual({ TMP: '/caller/tmp' });
  });
  it('review without PATH refuses Codex without adding a PATH key', () => {
    const descriptor = buildCodexDirectTaskDescriptor({ cwd, env: { TMP: '/caller/tmp' }, review: true });
    expect(descriptor.env).not.toHaveProperty('PATH');
    const io = seam();
    expect(() => launchAgent(descriptor, io)).toThrow(/codex.*PATH/);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(descriptor.env).toEqual({ TMP: '/caller/tmp' });
  });
  it('refuses a relative non-review PATH entry before spawn', () => {
    const io = seam();
    expect(() => launchAgent(buildCodexDirectTaskDescriptor({ cwd, env: { PATH: `.:${bin}` } }), io)).toThrow(/PATH/);
    expect(io.spawn).not.toHaveBeenCalled(); expect(io.resolveBinary).not.toHaveBeenCalled();
  });
  it('keeps config PATH tokens rather than rewriting them to the child PATH', () => {
    const io = seam(); launchAgent({ ...base(), config: { 'shell_environment_policy.set.PATH': '/explicit' } }, io);
    expect(io.spawn.mock.calls[0][1]).toContain('shell_environment_policy.set.PATH="/explicit"');
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(bin);
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
  it('launches the fixed realpath when it is the first executable codex', () => {
    const io = seam(); launchAgent(base(), io); expect(io.spawn.mock.calls[0][0]).toBe(binary);
  });
  it('refuses a relative entry before codex, but accepts one after the match in review mode', () => {
    noSpawn({ PATH: `.:${bin}` }, /relative|absolute/);
    const io = seam(); launchAgent(buildCodexDirectTaskDescriptor({ cwd, env: { PATH: `${bin}:.` }, review: true }), io);
    expect(io.spawn.mock.calls[0][2].env.PATH).toBe(`${bin}:.`);
  });
  it('refuses no codex, missing PATH and an empty entry before codex', () => {
    noSpawn({ PATH: root }, /codex.*PATH/); noSpawn({}, /codex.*PATH/); noSpawn({ PATH: `:${bin}` }, /relative|absolute/);
  });
  it('compares review binary identity against caller PATH without adding a prefix', () => {
    const wrapper = join(root, 'review-wrapper'); mkdirSync(wrapper);
    writeFileSync(join(wrapper, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const io = seam();
    expect(() => launchAgent(buildCodexDirectTaskDescriptor({ cwd, env: { PATH: `${wrapper}:${bin}` }, review: true }), io)).toThrow(/binary.*differ|identity/);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it('fixed lookup refuses missing and non-executable installations', () => {
    writeFileSync(join(root, 'codex'), 'not executable', { mode: 0o644 });
    expect(() => findAgentBinary('codex', [root])).toThrow(/binary not found/);
    chmodSync(join(root, 'codex'), 0o755);
    expect(findAgentBinary('codex', [join(root, 'missing'), root])).toBe(realpathSync(join(root, 'codex')));
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
  it.each(['codex', 'claude'])('11 removes runtime loader injection before spawning %s', agent => {
    const env = { PATH: bin, SAFE: 'kept', NODE_OPTIONS: '--import=/attacker/payload.mjs',
      NODE_PATH: '/attacker/modules', CUSTOM_OPTIONS: 'x', LD_PRELOAD: '/attacker/lib',
      LD_LIBRARY_PATH: '/attacker/libs', LD_AUDIT: '/attacker/audit',
      DYLD_INSERT_LIBRARIES: '/attacker/lib', DYLD_LIBRARY_PATH: '/attacker/libs',
      PYTHONPATH: '/attacker/python', PYTHONSTARTUP: '/attacker/startup.py',
      PERL5OPT: '-Mattacker', PERL5LIB: '/attacker/perl', RUBYOPT: '-rattacker', RUBYLIB: '/attacker/ruby' };
    const io = seam();
    io.spawn.mockImplementation((_file, _args, options) => {
      expect(options.env).toEqual({ PATH: bin, SAFE: 'kept' });
      return 'child';
    });
    expect(launchAgent({ ...(agent === 'codex' ? base() : claude()), env }, io)).toBe('child');
    expect(io.spawn).toHaveBeenCalledOnce();
    expect(env.NODE_OPTIONS).toBe('--import=/attacker/payload.mjs');
  });
  it('11 prevents NODE_OPTIONS preload execution in a real Node child', () => {
    const payload = join(root, 'payload.mjs'), marker = join(root, 'payload-executed');
    writeFileSync(payload, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const env = { PATH: bin, NODE_OPTIONS: `--import=${JSON.stringify(payload)}` };
    const invocation = buildAgentInvocation({ ...base(), env }, seam());
    const child = spawnSync(invocation.file, ['-e', 'process.stdout.write("agent started")'], {
      ...invocation.options, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('agent started');
    expect(existsSync(marker)).toBe(false);
  });
  it('12 passes shell startup variables through as main does', () => {
    const env = { ...base().env, BASH_ENV: '/caller/startup', ENV: '/caller/env', ZDOTDIR: '/caller/zsh', SHELL: '/caller/shell' };
    expect(buildAgentInvocation({ ...base(), env }, seam()).options.env).toEqual(env);
  });
  it('13 preserves caller HOME while refusing a raw HOME descriptor field', () => {
    vi.stubEnv('HOME', '/ambient');
    expect(buildAgentInvocation({ ...base(), env: { ...base().env, HOME: '/caller-home' } }, seam()).options.env.HOME).toBe('/caller-home');
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
    const d = buildCodexDirectTaskDescriptor({ cwd, env: { PATH: bin }, outputLastMessageFile: '/last', model: 'gpt-5.6-sol', effort: 'high' });
    const io = seam(); expect(launchAgent(d, io)).toBe('child');
    expect(io.spawn).toHaveBeenCalledWith(binary, buildAgentArgs(d), {
      shell: false, cwd, env: { PATH: mainCodexShimPath(d.env) }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
  });
  it('encodes writable roots and temp strings as data and preserves ephemeral', () => {
    const tempRoot = '/task "quote" \\ $TMP';
    const d = buildCodexDirectTaskDescriptor({ cwd, env: { PATH: bin }, model: 'gpt-5.6-sol', effort: 'high', ephemeral: true, writableRoots: [tempRoot], tempRoot });
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
