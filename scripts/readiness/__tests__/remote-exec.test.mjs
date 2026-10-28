// @vitest-environment node
/** @file Contract tests for the forge remote runner and its admission callers. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnKeepAlive } from '../../lib/test-keepalive.mjs';
import { runWithRemoteDecision, resolveAdmissionPolicy } from '../heavy-admission.mjs';
import {
  isAllowedCommand, filterEnv, validateRunId, buildRemoteScript,
  runRemote, runWithRemoteFallback, parseArgs,
} from '../remote-exec.mjs';

const argv = ['npm', 'run', 'test:unit', '--', 'blocks/a.test.mjs'];
const runId = 'abcdef-1';
const runDir = `/srv/forge-exec/${runId}`;
const lockHash = 'a'.repeat(64);
const allowedEnv = {
  CI: 'true', NODE_ENV: 'test', TZ: 'UTC', LANG: 'C', LC_ALL: 'C', FORCE_COLOR: '0', NO_COLOR: '1',
};
const forbiddenEnv = {
  GITHUB_TOKEN: 'secret-token-marker', ANTHROPIC_API_KEY: 'secret-key-marker',
  SECRET: 'secret-secret-marker', PASSWORD: 'secret-password-marker',
  LOGIN: 'secret-login-marker', AUTH: 'secret-auth-marker',
  CREDENTIAL: 'secret-credential-marker', mixedCaseToken: 'secret-mixed-marker',
  HOME: 'private-home-marker', PATH: 'private-path-marker', OTHER: 'private-other-marker',
};
let cwd;
beforeEach(() => {
  // Task scratch must stay under the launcher-provided TMPDIR.
  cwd = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'remote-exec-test-')));
  writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  for (const file of ['blocks/a.test.mjs', 'blocks/nested/b.test.tsx', 'blocks/__tests__/unit/route-map.test.ts']) {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), 'export {};\n');
  }
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const sshText = (call) => call.args.join(' ');
const isCleanup = (call) => call.file === 'ssh' && /\brm\s+-rf\b/.test(sshText(call));
const isReceipt = (call) => call.file === 'ssh' && sshText(call).includes('.exit-code');
const isRun = (call) => call.file === 'ssh' && call.inherit === true;
const callsOf = (exec) => exec.mock.calls.map(([call]) => call);

function fixture({ probeCode = 0, copyCode = 0, runCode = 0, receipt = `${runCode}\n`, receiptCode = 0 } = {}) {
  const exec = vi.fn(async (call) => {
    if (call.file === 'git') return { code: 0, stdout: 'package-lock.json\na.test.mjs\n' };
    if (call.file === 'rsync') return { code: copyCode, stdout: '' };
    if (isCleanup(call)) return { code: 0, stdout: '' };
    if (isRun(call)) return { code: runCode, stdout: '' };
    if (isReceipt(call)) return { code: receiptCode, stdout: receipt };
    if (call.file === 'ssh' && call.args.at(-1) === 'true') return { code: probeCode, stdout: '' };
    throw new Error(`Unexpected exec call: ${JSON.stringify(call)}`);
  });
  const local = vi.fn(async () => 7);
  const listFiles = vi.fn(async () => ['package-lock.json', 'a.test.mjs']);
  return { exec, local, listFiles, argv: [...argv], cwd, env: { ...allowedEnv, ...forbiddenEnv }, runId };
}

function expectNoSecrets(exec) {
  const transport = JSON.stringify(callsOf(exec).map(({ args, input }) => ({ args, input })));
  for (const value of Object.values(forbiddenEnv)) expect(transport).not.toContain(value);
}

describe('isAllowedCommand', () => {
  it.each(['test:unit', 'check:standards'])('allows exactly the npm run %s prefix, including extra args', (script) => {
    expect(isAllowedCommand(['npm', 'run', script])).toBe(true);
    expect(isAllowedCommand(['npm', 'run', script, '--', 'a.test.mjs'])).toBe(true);
  });
  it.each([
    [], null, undefined, {}, 'npm run test:unit', ['npm'], ['npm', 'run'],
    ['npm', 'run', 'build'], ['sh', '-c', 'npm run test:unit'], ['npx', 'vitest'],
    ['npm', 'run', 'test:unit-extra'], ['npm', 'run', 'check:standards-extra'],
    ['env', 'npm', 'run', 'test:unit'], ['npm', 'test'],
  ].map((value) => [value]))('fails closed for disallowed or incomplete argv: %j', (value) => {
    expect(isAllowedCommand(value)).toBe(false);
  });
});

describe('filterEnv', () => {
  it('keeps exactly the allowlist and drops secret names, HOME, PATH, and unknown names', () => {
    const env = { ...allowedEnv, ...forbiddenEnv };
    expect(filterEnv(env)).toEqual(allowedEnv);
    expect(env).toEqual({ ...allowedEnv, ...forbiddenEnv });
  });
  it('does not promote inherited or differently cased names into the allowlist', () => {
    expect(filterEnv(Object.assign(Object.create({ CI: 'inherited' }), { ci: 'lowercase', TZ: 'UTC' })))
      .toEqual({ TZ: 'UTC' });
    expect(filterEnv({})).toEqual({});
  });
});

describe('validateRunId', () => {
  it.each(['abcdef', 'abcdef-1', '0abcde', `a${'-'.repeat(63)}`])('accepts valid boundary/id %s', (id) => {
    expect(validateRunId(id)).toBe(true);
  });
  it.each([
    '', 'abcde', `a${'b'.repeat(64)}`, '-abcde', 'ABCDEF', 'abc_def', '../abcdef',
    'abcdef/x', 'abcdef\n', 'abcdef;id', '$(id)', null, undefined, 123456,
  ])('rejects malformed, oversized, or non-string id %j', (id) => {
    expect(validateRunId(id)).toBe(false);
  });
});

describe('buildRemoteScript', () => {
  it.each(['empty', 'legacy production'])('includes dev dependencies under production with an %s cache, then reuses it under test', (cacheState) => {
    const root = join(cwd, 'forge-exec');
    const bin = join(cwd, 'bin');
    const trace = join(cwd, 'install-count');
    mkdirSync(bin);
    if (cacheState !== 'empty') mkdirSync(join(root, '.cache', lockHash, 'node_modules'), { recursive: true });
    // An install models npm omit=dev under production; a test needs Vitest.
    writeFileSync(join(bin, 'npm'), `#!/bin/bash
if [ "$1" = ci ]; then
  mkdir -p node_modules
  echo install >> '${trace}'
  if [ "\${NODE_ENV:-}" != production ] || [[ " $* " == *" --include=dev "* ]]; then touch node_modules/vitest; fi
  exit 0
fi
test -f node_modules/vitest
`, { mode: 0o755 });
    for (const nodeEnv of ['production', 'test']) {
      const script = buildRemoteScript({ runId, lockHash, env: { NODE_ENV: nodeEnv }, argv });
      const harness = `env() { local a=("$@") i; for i in "\${!a[@]}"; do case "\${a[$i]}" in PATH=*) a[$i]='PATH=${bin}:/usr/bin:/bin';; esac; done; command env "\${a[@]}"; }\n`;
      const result = spawnSync('bash', ['-c', harness + script.replaceAll('/srv/forge-exec', root)], { encoding: 'utf8' });
      expect(result.status, `${nodeEnv}: ${result.stderr}`).toBe(0);
    }
    expect(readFileSync(trace, 'utf8')).toBe('install\n');
  });

  it('refuses standards scripts without the checkout Git context', () => {
    expect(() => buildRemoteScript({ runId, lockHash, argv: ['npm', 'run', 'check:standards'] }))
      .toThrow(/git context/i);
  });

  it('names the run/cache paths, enables nounset, installs an EXIT trap, and excludes secrets', () => {
    const script = buildRemoteScript({ runId, lockHash, env: { ...allowedEnv, ...forbiddenEnv }, argv });
    expect(typeof script).toBe('string');
    expect(script).toMatch(/set\s+-[a-zA-Z]*u/);
    expect(script).toContain(runDir);
    expect(script).toContain(`/srv/forge-exec/.cache/${lockHash}`);
    expect(script).toContain(`${runDir}/.exit-code`);
    expect(script).toMatch(/trap\b[^\n]*\bEXIT\b/);
    expect(script).toMatch(/env\s+-i\b/);
    for (const value of Object.values(forbiddenEnv)) expect(script).not.toContain(value);
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('executes quoted values inertly, reuses the cache, records the command code, and removes the run directory', () => {
    // Redirect only the fixed server root; execute the generated bash for real with a fake npm.
    const root = join(cwd, 'forge-exec');
    const bin = join(cwd, 'bin');
    const trace = join(cwd, 'trace.jsonl');
    const exitSnapshot = join(cwd, 'exit-snapshot');
    const marker = join(cwd, 'must-not-exist');
    const hostile = [`$(touch ${marker})`, "a'b", '; touch ' + marker, 'two words', 'line\nbreak'];
    mkdirSync(bin);
    mkdirSync(join(root, '.cache'), { recursive: true });
    const recorder = join(cwd, 'npm.mjs');
    writeFileSync(recorder, `import { appendFileSync, mkdirSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, env:process.env, cwd:process.cwd()}) + '\\n');
if (args[0] === 'ci') { mkdirSync('node_modules', {recursive:true}); process.exit(0); }
process.exit(3);
`);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o755 });
    const env = { CI: hostile[0], LANG: hostile[1], ...forbiddenEnv };
    const script = buildRemoteScript({ runId, lockHash, env, argv: [...argv, ...hostile] });
    // The env shim supplies a test npm on PATH while retaining the script's env -i semantics.
    // The rm shim observes the receipt just before the EXIT trap removes it.
    const harness = `
env() { local a=("$@") i; for i in "\${!a[@]}"; do case "\${a[$i]}" in PATH=*) a[\$i]=PATH=${quote(`${bin}:/usr/bin:/bin`)};; esac; done; command env "\${a[@]}"; }
rm() {
  if [ -f ${quote(join(root, runId, '.exit-code'))} ]; then
    command cp ${quote(join(root, runId, '.exit-code'))} ${quote(exitSnapshot)};
  fi
  command rm "$@";
}
${script.replaceAll('/srv/forge-exec', root)}`;
    for (const attempt of [1, 2]) {
      mkdirSync(join(root, runId), { recursive: true });
      const result = spawnSync('bash', ['-c', harness], {
        cwd, encoding: 'utf8', env: { ...forbiddenEnv, PATH: `${bin}:/usr/bin:/bin` },
      });
      expect(result.status, `attempt ${attempt}: ${result.stderr}`).toBe(3);
      expect(readFileSync(exitSnapshot, 'utf8').trim()).toBe('3');
      expect(existsSync(join(root, runId))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    }
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.filter((row) => row.args[0] === 'ci')).toHaveLength(1);
    const runs = rows.filter((row) => row.args[0] === 'run');
    expect(runs).toHaveLength(2);
    for (const row of runs) {
      expect(row.args).toEqual([...argv.slice(1), ...hostile]);
      expect(row.cwd).toBe(join(root, runId));
      expect(row.env).toMatchObject({ CI: hostile[0], LANG: hostile[1] });
      for (const key of Object.keys(forbiddenEnv).filter((key) => key !== 'PATH')) expect(row.env).not.toHaveProperty(key);
    }
  });
});

describe('runRemote', () => {
  it.each(['always', 'above-threshold'])('offloads the actual package-script argv through admission in %s mode', async (mode) => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    const command = pkg.scripts['test:unit'].split(' -- ')[1].split(' ');
    const args = [...command, 'blocks/__tests__/unit/route-map.test.ts'];
    const f = fixture();
    const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode } } });
    expect(await runWithRemoteDecision({ argv: args, cwd, policy, loadPerCore: () => 10, log: vi.fn(),
      remoteExec: (options) => runRemote({ ...f, ...options }),
    })).toEqual({ handled: true, exitCode: 0 });
    expect(callsOf(f.exec).some(isRun)).toBe(true);
    expect(callsOf(f.exec).find(isRun).input).toContain("'npm' 'run' 'test:unit' '--' 'blocks/__tests__/unit/route-map.test.ts'");
  });

  it('offloads the real route-map dependency closure through npx and the direct entry point', async () => {
    const root = realpathSync(new URL('../../../', import.meta.url));
    for (const prefix of [['npx', 'vitest', 'run'], ['npm', 'run', 'test:unit', '--']]) {
      const f = fixture();
      expect(await runRemote({ ...f, cwd: root,
        argv: [...prefix, 'blocks/__tests__/unit/route-map.test.ts'],
      })).toEqual({ mode: 'remote', code: 0 });
      expect(callsOf(f.exec).some(isRun)).toBe(true);
    }
  });

  it.each([
    ['vitest', 'watch', 'blocks/a.test.mjs'],
    ['npx', '--yes', 'vitest', 'run', 'blocks/a.test.mjs'],
    ['vitest', 'run', '--config=other.ts', 'blocks/a.test.mjs'],
    ['vitest', 'run', 'blocks/a.test.mjs', 'scripts/a.test.mjs'],
    ['vitest', 'run', 'blocks/a.test.mjs\n'],
  ].map((args) => [args]))('does not widen selection eligibility for expanded argv: %j', async (args) => {
    const f = fixture();
    expect(await runRemote({ ...f, argv: args })).toMatchObject({ mode: 'fallback' });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('keeps an available local sibling dependency local because transport omits it', async () => {
    const root = join(cwd, 'checkout');
    mkdirSync(join(root, 'blocks'), { recursive: true });
    mkdirSync(join(cwd, 'frontierui/plugs'), { recursive: true });
    writeFileSync(join(root, 'blocks/a.test.mjs'), "import '@frontierui/plugs/core';\n");
    writeFileSync(join(cwd, 'frontierui/plugs/core.ts'), 'export {};\n');
    const f = fixture();
    expect(await runRemote({ ...f, cwd: root })).toEqual({ mode: 'fallback', reason: 'dependency-context-required' });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each(['direct', 'transitive', 'mixed', 'missing', 'relative escape'])(
    'keeps an untransported dependency local before SSH: %s', async (shape) => {
      const f = fixture();
      const entry = join(cwd, 'blocks/a.test.mjs');
      if (shape === 'missing') rmSync(entry);
      else if (shape === 'relative escape') writeFileSync(entry, "import '../../frontierui/plugs/core';\n");
      else if (shape === 'transitive') {
        writeFileSync(entry, "import './helper.mjs';\n");
        writeFileSync(join(cwd, 'blocks/helper.mjs'), "export { default } from '@frontierui/webtheme/core';\n");
      } else writeFileSync(entry, "import CustomAttribute from '@frontierui/plugs/webbehaviors/CustomAttribute';\n");
      const args = shape === 'mixed' ? [...argv, 'blocks/__tests__/unit/route-map.test.ts'] : argv;
      const log = vi.fn();
      expect(await runWithRemoteFallback({ ...f, argv: args, log })).toBe(7);
      expect(f.exec).not.toHaveBeenCalled();
      expect(f.local).toHaveBeenCalledWith(args);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('dependency-context-required'));
    },
  );

  it('keeps the reported TrustedHtmlBehavior selection local with the real dependency closure', async () => {
    const f = fixture();
    const root = realpathSync(new URL('../../../', import.meta.url));
    expect(await runRemote({ ...f, cwd: root,
      argv: ['npm', 'run', 'test:unit', '--', 'blocks/__tests__/unit/trusted-html/TrustedHtmlBehavior.test.ts'],
    })).toEqual({ mode: 'fallback', reason: 'dependency-context-required' });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each([
    [], ['--'], ['--', 'scripts/lib/__tests__/exec-output-guard.test.mjs'],
    ['--', 'scripts/__tests__/repo-scan-tests.test.mjs'],
    ['--', 'blocks/a.test.mjs', 'scripts/lib/__tests__/exec-output-guard.test.mjs'],
    ['--', 'blocks'], ['--', '--changed'], ['--', 'blocks/../scripts/a.test.mjs'],
    ['--', 'blocks/a.test.mjs\n'], ['--', 'blocks/a.test.mjs\r'],
    ['--', 'blocks/a.test.mjs\u2028'], ['--', 'blocks/\u200ba.test.mjs'],
    ['--', 'blocks/`a`.test.mjs'], ['--', "blocks/a'b.test.mjs"],
    ['--', '--', 'blocks/a.test.mjs'], ['--', 'blocks/*.test.mjs'],
    ['--', 'ｂlocks/a.test.mjs'], ['--', 'blocks/a.test.mjsscripts/b.test.mjs'],
  ].map((args) => [args]))('keeps unit selections requiring checkout context local before transport: %j', async (args) => {
    const f = fixture();
    expect(await runRemote({ ...f, argv: ['npm', 'run', 'test:unit', ...args] }))
      .toEqual({ mode: 'fallback', reason: 'git-context-required' });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each([
    ['blocks/__tests__/unit/route-map.test.ts'],
    ['--', 'blocks/__tests__/unit/route-map.test.ts'],
    ['--', 'blocks/a.test.mjs', 'blocks/nested/b.test.tsx'],
  ].map((args) => [args]))('retains remote execution for explicit runtime tests: %j', async (args) => {
    expect(await runRemote({ ...fixture(), argv: ['npm', 'run', 'test:unit', ...args] }))
      .toEqual({ mode: 'remote', code: 0 });
  });

  it.each(['above-threshold', 'always'])(
    'keeps the reported Git-dependent unit test local through both callers in %s mode', async (mode) => {
      const f = fixture();
      const args = ['npm', 'run', 'test:unit', '--', 'scripts/lib/__tests__/exec-output-guard.test.mjs'];
      const log = vi.fn();
      const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode } } });
      expect(await runWithRemoteDecision({
        argv: args, cwd, policy, loadPerCore: () => 10, log,
        remoteExec: (options) => runRemote({ ...f, ...options }),
      })).toEqual({ handled: false });
      expect(await runWithRemoteFallback({ ...f, argv: args, log })).toBe(7);
      expect(f.local).toHaveBeenCalledTimes(1);
      expect(f.local).toHaveBeenCalledWith(args);
      expect(f.exec).not.toHaveBeenCalled();
      expect(f.listFiles).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('git-context-required'));
    },
  );

  it.each(['rejected SSH', 'SSH 255', 'receipt unavailable', 'receipt rejected'])(
    'refuses both local callers after %s while a dispatched child survives', async (loss) => {
      const child = spawnKeepAlive();
      const closed = new Promise((resolve) => child.once('close', resolve));
      try {
        const f = fixture({ runCode: loss === 'SSH 255' ? 255 : 0, receiptCode: 1 });
        const exec = vi.fn(async (call) => {
          if (isRun(call) && loss === 'rejected SSH') throw new Error('connection lost');
          if (isReceipt(call) && loss === 'receipt rejected') throw new Error('connection lost');
          return f.exec(call);
        });
        const log = vi.fn();
        const options = { ...f, exec, log };
        const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } });
        expect(await runWithRemoteDecision({
          argv, cwd, policy, log, remoteExec: (opts) => runRemote({ ...options, ...opts }),
        })).toEqual({ handled: true, exitCode: 124 });
        expect(await runWithRemoteFallback(options)).toBe(124);
        expect(f.local).not.toHaveBeenCalled();
        expect(callsOf(exec).some(isCleanup)).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
        expect(() => process.kill(child.pid, 0)).not.toThrow();
      } finally {
        child.kill('SIGKILL');
        await closed;
      }
    },
  );

  it.each([[], ['--', '--files=scripts/example.mjs']].map((args) => [args]))('falls back before transport for standards needing Git context: %j', async (args) => {
    const f = fixture();
    expect(await runRemote({ ...f, argv: ['npm', 'run', 'check:standards', ...args] }))
      .toEqual({ mode: 'fallback', reason: 'git-context-required' });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.listFiles).not.toHaveBeenCalled();
  });

  it.each(['above-threshold', 'always'])('keeps standards on local admission through the real remote executor in %s mode', async (mode) => {
    const f = fixture();
    const log = vi.fn();
    const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode } } });
    expect(await runWithRemoteDecision({
      argv: ['npm', 'run', 'check:standards'], cwd, policy, loadPerCore: () => 10, log,
      remoteExec: (options) => runRemote({ ...f, ...options }),
    })).toEqual({ handled: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('git-context-required'));
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each(['injected', 'git'])('excludes conventional credential and private-key paths from the %s transport inventory', async (inventory) => {
    const f = fixture();
    const safe = [
      'package-lock.json', 'src/a file.mjs', 'src/identity.mjs', 'docs/key-handling.md',
      ...['js', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].map((ext) => `src/identity.${ext}`),
    ];
    const secrets = [
      '.git', '.git/config', '.git-credentials', '.git-credentials.backup', 'nested/.GIT-CREDENTIALS',
      '.git-credentials~', '.git-credentials-old',
      'id_rsa', 'keys/ID_RSA', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'id_xmss',
      'keys/id_rsa.backup', 'keys/id_rsa~', 'keys/id_ed25519.pub', 'identity', 'keys/identity.pub',
      'keys/IDENTITY', 'keys/IDENTITY.PUB', 'keys/identity.backup', 'keys/identity~',
      'keys/identity-old', 'keys/identity_old', 'keys/identity.pub.backup', 'keys/identity.mjs.backup',
      'keys/identity.pem', 'keys/identity.key', '.ssh/identity.mjs', 'credentials/identity.ts',
      '.env', 'nested/.env.local', '.npmrc', '.netrc', 'credentials', 'credentials.json',
      'credentials/token', '.ssh/config', '.aws/config', 'keys/server.pem', 'keys/server.KEY',
    ];
    f.listFiles.mockResolvedValue([...safe, ...secrets]);
    const exec = vi.fn(async (call) => call.file === 'git'
      ? { code: 0, stdout: [...safe, ...secrets].join('\0') + '\0' } : f.exec(call));
    const options = { ...f, exec };
    if (inventory === 'git') delete options.listFiles;
    expect(await runRemote(options)).toEqual({ mode: 'remote', code: 0 });
    expect(callsOf(exec).find((call) => call.file === 'rsync').input).toBe(safe.join('\n') + '\n');
  });

  it('falls back without exec for a command outside the allowlist', async () => {
    const f = fixture();
    expect(await runRemote({ ...f, argv: ['npm', 'run', 'build'] }))
      .toEqual({ mode: 'fallback', reason: 'command-not-allowed' });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.local).not.toHaveBeenCalled();
  });
  it('falls back when the forge probe fails, without copying or running', async () => {
    const f = fixture({ probeCode: 255 });
    expect(await runRemote(f)).toEqual({ mode: 'fallback', reason: 'forge-unreachable' });
    expect(callsOf(f.exec)).toContainEqual(expect.objectContaining({ file: 'ssh', args: ['forge', 'true'] }));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });
  it('reports copy-failed and attempts cleanup after an unsuccessful rsync', async () => {
    const f = fixture({ copyCode: 23 });
    expect(await runRemote(f)).toEqual({ mode: 'fallback', reason: 'copy-failed' });
    expect(callsOf(f.exec).some(isRun)).toBe(false);
    expect(callsOf(f.exec).filter(isCleanup)).toHaveLength(1);
    expect(sshText(callsOf(f.exec).find(isCleanup))).toContain(runDir);
    expectNoSecrets(f.exec);
  });
  it.each([0, 3])('returns confirmed remote exit code %s and cleans up after reading the receipt', async (code) => {
    const f = fixture({ runCode: code });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code });
    const calls = callsOf(f.exec);
    const run = calls.find(isRun);
    expect(run).toMatchObject({ file: 'ssh', inherit: true, input: expect.any(String) });
    expect(calls.filter(isReceipt)).toHaveLength(1);
    expect(calls.findIndex(isReceipt)).toBeGreaterThan(calls.findIndex(isRun));
    expect(calls.findIndex(isCleanup)).toBeGreaterThan(calls.findIndex(isReceipt));
    expect(sshText(calls.find(isCleanup))).toContain(runDir);
    expect(f.local).not.toHaveBeenCalled();
    expectNoSecrets(f.exec);
  });
  it.each([
    { runCode: 0, receipt: '' }, { runCode: 0, receipt: 'not-a-number\n' },
    { runCode: 0, receipt: '0oops\n' }, { runCode: 0, receipt: '0\n3\n' },
    { runCode: 0, receipt: '3\n' }, { runCode: 3, receipt: '0\n' },
    { runCode: 0, receipt: '0\n', receiptCode: 1 },
    { runCode: 255, receipt: '255\n' }, { runCode: 255, receipt: '0\n' },
  ])('refuses reruns and preserves the run directory for ambiguous evidence: %j', async (scenario) => {
    const f = fixture(scenario);
    expect(await runRemote(f)).toEqual({ mode: 'uncertain', reason: 'ambiguous-result', terminated: false });
    expect(callsOf(f.exec).some(isCleanup)).toBe(false);
    expectNoSecrets(f.exec);
  });
  it('uses the injected file list as rsync stdin, excludes node_modules, and selects the restricted rsync user', async () => {
    const f = fixture();
    f.listFiles.mockResolvedValue(['package-lock.json', 'src/a file.mjs', 'node_modules/secret.js', 'src/node_modules/nested.js']);
    await runRemote({ ...f, host: 'custom-forge' });
    expect(f.listFiles).toHaveBeenCalledWith(cwd);
    const calls = callsOf(f.exec);
    expect(calls).toContainEqual(expect.objectContaining({ file: 'ssh', args: ['custom-forge', 'true'] }));
    const copy = calls.find((call) => call.file === 'rsync');
    expect(copy.args.join(' ')).toMatch(/--files-from(?:=|\s)-/);
    expect(copy.args.join(' ')).toMatch(/--rsync-path(?:=|\s)sudo -u forge-exec rsync/);
    expect(copy.args.join(' ')).toContain(`custom-forge:${runDir}`);
    expect(copy.input).toContain('package-lock.json');
    expect(copy.input).toContain('src/a file.mjs');
    expect(copy.input).not.toContain('node_modules');
    expectNoSecrets(f.exec);
  });
  it('defaults to git ls-files -co --exclude-standard when listFiles is omitted', async () => {
    const { listFiles, ...f } = fixture();
    await runRemote(f);
    expect(callsOf(f.exec)).toContainEqual(expect.objectContaining({
      file: 'git', args: expect.arrayContaining(['ls-files', '-co', '--exclude-standard']),
    }));
    expect(callsOf(f.exec).find((call) => call.file === 'rsync').input).toContain('a.test.mjs');
  });
});

describe('runWithRemoteFallback', () => {
  it('refuses a local rerun for a missing receipt even when SSH reports success', async () => {
    const f = fixture({ receipt: '' });
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(124);
    expect(f.local).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
    expect(callsOf(f.exec).some(isCleanup)).toBe(false);
  });

  it('preserves the local standards result and logs the Git-context fallback reason', async () => {
    const f = fixture();
    const standardArgs = ['npm', 'run', 'check:standards', '--', '--files=scripts/example.mjs'];
    const log = vi.fn();
    const local = vi.fn(async (args) => {
      expect(args).toEqual(standardArgs);
      return 9;
    });
    expect(await runWithRemoteFallback({ ...f, argv: standardArgs, local, log })).toBe(9);
    expect(local).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('git-context-required'));
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each([
    ['command-not-allowed', { argv: ['npm', 'run', 'build'] }, {}],
    ['forge-unreachable', {}, { probeCode: 255 }],
    ['copy-failed', {}, { copyCode: 23 }],
  ])('logs %s and returns the local code on fallback', async (reason, overrides, scenario) => {
    const f = { ...fixture(scenario), ...overrides };
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(f.local).toHaveBeenCalledTimes(1);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    expect(log.mock.calls.some((args) => args.some((message) => typeof message === 'string' && message.includes(reason)))).toBe(true);
    expectNoSecrets(f.exec);
  });
  it.each([0, 3])('returns remote code %s without running locally', async (code) => {
    const f = fixture({ runCode: code });
    expect(await runWithRemoteFallback({ ...f, log: vi.fn() })).toBe(code);
    expect(f.local).not.toHaveBeenCalled();
  });
});

describe('parseArgs', () => {
  it('parses host/run-id options and preserves command args after the separator', () => {
    expect(parseArgs(['--host=x', '--run-id=abcdef-1', '--', ...argv]))
      .toEqual({ host: 'x', runId: 'abcdef-1', argv });
  });
});

describe('forge-setup.sh', () => {
  it('creates the restricted user, run root and cache with strict bash and idempotency guards', () => {
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    expect(setup).toContain('set -euo pipefail');
    expect(setup).toMatch(/\buseradd\b[^\n]*\bforge-exec\b/);
    expect(setup).toContain('/srv/forge-exec');
    expect(setup).toContain('.cache');
    expect(setup).toMatch(/\bid\s+(?:-[a-zA-Z]+\s+)*forge-exec\b/);
    expect(setup).toMatch(/\bmkdir\s+-p\b/);
  });
});
