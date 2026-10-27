// @vitest-environment node
/** @file Contract and execution tests for the Forge remote runner. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isAllowedCommand, filterEnv, validateRunId, buildRemoteScript,
  runRemote, runWithRemoteFallback, parseArgs,
} from '../remote-exec.mjs';

const argv = ['npm', 'run', 'test:unit', '--', 'a.test.mjs'];
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

// Exercise the transport and generated shell locally, without SSH or a registry.
function realRemoteFixture(files) {
  const f = fixture();
  const root = join(cwd, 'server');
  const bin = join(cwd, 'bin');
  const npmCli = realpathSync(spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim());
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(cwd, 'user.npmrc'), '');
  writeFileSync(join(cwd, 'global.npmrc'), '');
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'npm'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(npmCli)} --offline --cache=${quote(join(cwd, 'npm-cache'))} --userconfig=${quote(join(cwd, 'user.npmrc'))} --globalconfig=${quote(join(cwd, 'global.npmrc'))} "$@"\n`, { mode: 0o755 });
  const runs = [];
  f.listFiles.mockResolvedValue(files);
  const fakeExec = f.exec;
  f.exec = vi.fn(async (call) => {
    if (call.file === 'rsync') {
      const args = call.args.filter((arg, i, all) => !arg.startsWith('--rsync-path=') && arg !== '-e' && all[i - 1] !== '-e');
      args[args.length - 1] = join(root, runId) + '/';
      const result = spawnSync('rsync', args, { cwd, input: call.input, encoding: 'utf8', timeout: 10000 });
      return { code: result.status, stdout: result.stdout };
    }
    if (isRun(call)) {
      const script = call.input.replaceAll('/srv/forge-exec', root)
        .replaceAll('PATH=/usr/local/bin:/usr/bin:/bin', `PATH=${quote(`${bin}:/usr/bin:/bin`)}`);
      const result = spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', timeout: 20000 });
      runs.push(result);
      return { code: result.status, stdout: result.stdout };
    }
    if (isReceipt(call)) {
      const receipt = join(root, runId, '.exit-code');
      return { code: existsSync(receipt) ? 0 : 1, stdout: existsSync(receipt) ? readFileSync(receipt, 'utf8') : '' };
    }
    if (isCleanup(call)) {
      rmSync(join(root, runId), { recursive: true, force: true });
      return { code: 0, stdout: '' };
    }
    return fakeExec(call);
  });
  return { ...f, root, bin, runs };
}

describe('remote snapshot regressions', () => {
  it('copies rsync comment-like and shell-special filenames literally through the real transport', async () => {
    const files = ['#required-fixture.json', ';required-fixture.json', 'two words', "quote'`$()", '--option', 'é\u2028fixture', '＃invisible\u200b', 'tab\tfile', 'trailing '];
    const f = realRemoteFixture(['package-lock.json', ...files]);
    for (const file of files) writeFileSync(join(cwd, file), `contents: ${file}`);
    // Inspect the real rsync result before allowing the mocked remote command.
    const transport = f.exec;
    const transferred = new Map();
    f.exec = vi.fn(async (call) => {
      if (isRun(call)) {
        for (const file of files) {
          const path = join(f.root, runId, file);
          transferred.set(file, existsSync(path) ? readFileSync(path, 'utf8') : null);
        }
        return { code: 0, stdout: '' };
      }
      if (isReceipt(call)) return { code: 0, stdout: '0\n' };
      return transport(call);
    });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code: 0 });
    for (const file of files) expect(transferred.get(file), file).toBe(`contents: ${file}`);
  });

  it.each(['root', 'workspace'])('rejects a changed %s manifest against an unchanged lock on both warm and cold caches', async (kind) => {
    const manifest = { name: 'fixture', version: '1.0.0', workspaces: ['packages/*'], scripts: { 'test:unit': 'node -e "console.log(\'COMMAND_RAN\')"' } };
    const worker = { name: 'worker', version: '1.0.0' };
    const packages = {
      '': { name: 'fixture', version: '1.0.0', workspaces: manifest.workspaces },
      'packages/worker': worker,
      'node_modules/worker': { resolved: 'packages/worker', link: true },
    };
    const files = ['package.json', 'package-lock.json', 'packages/worker/package.json', 'vendor/missing-lock-dependency/package.json'];
    mkdirSync(join(cwd, 'vendor/missing-lock-dependency'), { recursive: true });
    writeFileSync(join(cwd, 'vendor/missing-lock-dependency/package.json'), JSON.stringify({ name: 'missing-lock-dependency', version: '1.0.0' }));
    mkdirSync(join(cwd, 'packages/worker'), { recursive: true });
    writeFileSync(join(cwd, 'packages/worker/package.json'), JSON.stringify(worker));
    let changedManifest = manifest;
    let changedPath = join(cwd, 'package.json');
    if (kind === 'workspace') {
      changedManifest = worker;
      changedPath = join(cwd, 'packages/worker/package.json');
    }
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages }));
    const f = realRemoteFixture(files);
    // Populate, then prove a valid cache hit can still execute.
    for (const attempt of [1, 2]) {
      expect(await runRemote(f), `valid attempt ${attempt}: ${f.runs.at(-1)?.stderr}`).toEqual({ mode: 'remote', code: 0 });
      expect(f.runs.at(-1).stdout).toContain('COMMAND_RAN');
    }
    changedManifest.dependencies = { 'missing-lock-dependency': kind === 'root' ? 'file:vendor/missing-lock-dependency' : 'file:../../vendor/missing-lock-dependency' };
    writeFileSync(changedPath, JSON.stringify(changedManifest));
    const validation = spawnSync(join(f.bin, 'npm'), ['ci', '--dry-run', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', timeout: 20000 });
    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain('Missing: missing-lock-dependency@1.0.0 from lock file');
    for (const state of ['warm', 'cold']) {
      if (state === 'cold') rmSync(join(f.root, '.cache'), { recursive: true, force: true });
      const log = vi.fn();
      expect(await runWithRemoteFallback({ ...f, log }), state).toBe(7);
      expect(f.runs.at(-1).status, f.runs.at(-1).stderr).toBe(97);
      expect(f.runs.at(-1).stderr).toContain('npm ci');
      expect(f.runs.at(-1).stdout).not.toContain('COMMAND_RAN');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
    }
  }, 120000);
});

describe('isAllowedCommand', () => {
  it.each(['test:unit', 'check:standards'])('rejects npm options before the argument separator for %s', (script) => {
    for (const args of [
      ['--script-shell=/usr/bin/true'], ['--script-shell', '/usr/bin/true'],
      ['--ignore-scripts'], ['--if-present'], ['--help'], ['--workspace=other'],
      ['a.test.mjs', '--script-shell=/usr/bin/true'],
      ['--script-shell=/usr/bin/true', '--', 'a.test.mjs'],
      ['—', '--script-shell=/usr/bin/true'], ['--\u200b', '--help'],
    ]) {
      expect(isAllowedCommand(['npm', 'run', script, ...args]), JSON.stringify(args)).toBe(false);
      expect(() => buildRemoteScript({ runId, lockHash, argv: ['npm', 'run', script, ...args] }))
        .toThrow('Invalid remote execution parameters');
    }
    expect(isAllowedCommand(['npm', 'run', script, '--', '--script-shell=/usr/bin/true'])).toBe(true);
  });
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
  it('installs dev dependencies under production and invalidates the old incomplete cache profile', () => {
    const script = buildRemoteScript({ runId, lockHash, env: { NODE_ENV: 'production' }, argv });
    expect(script).toMatch(/npm ci --include=dev\b/);
    expect(script).toContain(`/srv/forge-exec/.cache/${lockHash}/dev-v1/node_modules`);
    expect(script).toContain("NODE_ENV='production'");
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
    writeFileSync(recorder, `import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, env:process.env, cwd:process.cwd()}) + '\\n');
if (args[0] === 'ci') {
  if (args.includes('--dry-run')) process.exit(0);
  mkdirSync('node_modules', {recursive:true});
  if (process.env.NODE_ENV !== 'production' || args.includes('--include=dev')) writeFileSync('node_modules/vitest', 'dev dependency');
  process.exit(0);
}
if (!existsSync('node_modules/vitest')) process.exit(98);
process.exit(3);
`);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o755 });
    const env = { CI: hostile[0], LANG: hostile[1], ...forbiddenEnv };
    // An old production-only cache must not satisfy the new install profile.
    mkdirSync(join(root, '.cache', lockHash, 'node_modules'), { recursive: true });
    // The env shim supplies a test npm on PATH while retaining the script's env -i semantics.
    // The rm shim observes the receipt just before the EXIT trap removes it.
    const harnessFor = (script) => `
env() { local a=("$@") i; for i in "\${!a[@]}"; do case "\${a[$i]}" in PATH=*) a[\$i]=PATH=${quote(`${bin}:/usr/bin:/bin`)};; esac; done; command env "\${a[@]}"; }
rm() {
  if [ -f ${quote(join(root, runId, '.exit-code'))} ]; then
    command cp ${quote(join(root, runId, '.exit-code'))} ${quote(exitSnapshot)};
  fi
  command rm "$@";
}
${script.replaceAll('/srv/forge-exec', root)}`;
    for (const attempt of [1, 2]) {
      const script = buildRemoteScript({ runId, lockHash, env: { ...env, ...(attempt === 1 ? { NODE_ENV: 'production' } : {}) }, argv: [...argv, ...hostile] });
      mkdirSync(join(root, runId), { recursive: true });
      const result = spawnSync('bash', ['-c', harnessFor(script)], {
        cwd, encoding: 'utf8', env: { ...forbiddenEnv, PATH: `${bin}:/usr/bin:/bin` },
      });
      expect(result.status, `attempt ${attempt}: ${result.stderr}`).toBe(3);
      expect(readFileSync(exitSnapshot, 'utf8').trim()).toBe('3');
      expect(existsSync(join(root, runId))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    }
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.filter((row) => row.args[0] === 'ci' && !row.args.includes('--dry-run'))).toHaveLength(1);
    expect(rows.filter((row) => row.args[0] === 'ci' && row.args.includes('--dry-run'))).toHaveLength(1);
    const runs = rows.filter((row) => row.args[0] === 'run');
    expect(runs).toHaveLength(2);
    expect(runs[0].env.NODE_ENV).toBe('production');
    expect(runs[1].env).not.toHaveProperty('NODE_ENV');
    for (const row of runs) {
      expect(row.args).toEqual([...argv.slice(1), ...hostile]);
      expect(row.cwd).toBe(join(root, runId));
      expect(row.env).toMatchObject({ CI: hostile[0], LANG: hostile[1] });
      for (const key of Object.keys(forbiddenEnv).filter((key) => key !== 'PATH')) expect(row.env).not.toHaveProperty(key);
    }
  });
});

describe('runRemote', () => {
  it('falls back before copying when literal inventory framing exceeds the byte limit', async () => {
    const f = fixture();
    // Prefix and NUL are part of the 4 MiB transport budget.
    f.listFiles.mockResolvedValue(['a'.repeat(4 * 1024 * 1024 - 2)]);
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('copy-failed'));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });

  it.each(['test:unit', 'check:standards'])('falls back before transport for %s when the snapshot requires the unsynchronized sibling', async (command) => {
    const f = fixture();
    f.argv = ['npm', 'run', command, '--', 'blocks/__tests__/unit/resource-loader/ResourceLoader.test.ts'];
    f.listFiles.mockResolvedValue(['package-lock.json', 'vitest.shared.ts']);
    writeFileSync(join(cwd, 'vitest.shared.ts'), "export const fuiPlugsRoot = resolve(repoRoot, '../frontierui/plugs');\n");
    const log = vi.fn();
    expect(await runWithRemoteFallback({ ...f, log })).toBe(7);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unsupported-sibling-dependency'));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
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
  ])('fails closed with ambiguous-result and attempts cleanup for %j', async (scenario) => {
    const f = fixture(scenario);
    expect(await runRemote(f)).toEqual({ mode: 'fallback', reason: 'ambiguous-result' });
    expect(callsOf(f.exec).some(isCleanup)).toBe(true);
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
    expect(copy.args).toContain('--from0');
    expect(copy.input.split('\0')).toEqual(['./package-lock.json', './src/a file.mjs', '']);
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
  it.each([
    ['npm', 'run', 'build'],
    ['npm', 'run', 'test:unit', '--script-shell=/usr/bin/true'],
    ['npm', 'run', 'check:standards', '--ignore-scripts'],
  ])('refuses disallowed argv without remote or local execution: %j', async (...command) => {
    const f = { ...fixture(), argv: command };
    await expect(runWithRemoteFallback(f)).rejects.toThrow('command-not-allowed');
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.local).not.toHaveBeenCalled();
  });
  it.each([
    ['forge-unreachable', {}, { probeCode: 255 }],
    ['copy-failed', {}, { copyCode: 23 }],
    ['ambiguous-result', {}, { receipt: '' }],
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
  function directorySetup() {
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    const body = setup.match(/python3 - <<'DIRECTORIES'\n([\s\S]*?)\nDIRECTORIES/);
    expect(body, 'setup must use descriptor-anchored directory operations').not.toBeNull();
    return body[1];
  }

  it.each(['forge-exec', 'forge-exec/.cache'])('rejects a symlink at %s without changing its target', (path) => {
    const srv = join(cwd, 'srv');
    const target = join(cwd, 'target');
    mkdirSync(srv);
    mkdirSync(target, { mode: 0o755 });
    if (path.includes('/')) mkdirSync(join(srv, 'forge-exec'));
    symlinkSync(target, join(srv, path));
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    const body = setup.match(/python3 - <<'DIRECTORIES'\n([\s\S]*?)\nDIRECTORIES/);
    // The legacy branch lets the real symlink regression discriminate the old
    // shell setup too, rather than failing only because its implementation differs.
    const script = body
      ? `python3 - <<'DIRECTORIES'\n${directoryHarness(body[1], srv)}\nDIRECTORIES`
      : `set -euo pipefail\nchown() { :; }\n${setup.slice(setup.indexOf('\nfi\n') + 4, setup.indexOf('# ops')).replaceAll('/srv/forge-exec', join(srv, 'forge-exec'))}`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).not.toBe(0);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
    expect(existsSync(join(target, '.cache'))).toBe(false);
  });

  // Exercise the real no-follow opens and modes without requiring root or a system account.
  function directoryHarness(body, srv) {
    return `import os, grp, types
original_fstat = os.fstat
owners = {}
os.fstat = lambda fd: types.SimpleNamespace(st_uid=0, st_mode=original_fstat(fd).st_mode)
os.fchown = lambda fd, uid, gid: owners.__setitem__(original_fstat(fd).st_ino, (uid, gid))
grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=os.getgid())
${body.replaceAll('"/srv"', JSON.stringify(srv))}
assert owners[os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_ino] == (0, os.getgid())
assert owners[os.stat(${JSON.stringify(join(srv, 'forge-exec/.cache'))}).st_ino] == (0, os.getgid())`;
  }

  it('keeps parent entries protected on rerun and freezes the parent before opening the cache', () => {
    const body = directorySetup();
    const srv = join(cwd, 'srv');
    mkdirSync(srv);
    const harness = directoryHarness(body, srv).replace('original_fstat = os.fstat', `original_open = os.open
def checked_open(path, flags, *args, **kwargs):
    if path == '.cache':
        assert flags & os.O_NOFOLLOW
        assert os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_mode & 0o7777 == 0o700
        assert owners.get(os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_ino) == (0, os.getgid())
    return original_open(path, flags, *args, **kwargs)
os.open = checked_open
original_fstat = os.fstat`);
    for (const attempt of [1, 2]) {
      const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
      expect(result.status, `attempt ${attempt}: ${result.stderr}`).toBe(0);
      expect(statSync(join(srv, 'forge-exec')).mode & 0o7777).toBe(0o1770);
      expect(statSync(join(srv, 'forge-exec/.cache')).mode & 0o7777).toBe(0o2770);
    }
  });

  it('rejects a cache swapped to a symlink immediately before opening it', () => {
    const srv = join(cwd, 'srv');
    const target = join(cwd, 'target');
    mkdirSync(srv);
    mkdirSync(target, { mode: 0o755 });
    const harness = directoryHarness(directorySetup(), srv).replace('original_fstat = os.fstat', `original_open = os.open
def swapping_open(path, flags, *args, **kwargs):
    if path == '.cache':
        os.rename('.cache', '.cache.saved', src_dir_fd=kwargs['dir_fd'], dst_dir_fd=kwargs['dir_fd'])
        os.symlink(${JSON.stringify(target)}, '.cache', dir_fd=kwargs['dir_fd'])
    return original_open(path, flags, *args, **kwargs)
os.open = swapping_open
original_fstat = os.fstat`);
    const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
    expect(result.status, result.stderr).not.toBe(0);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
    // A failed migration leaves the root closed, so an operator can repair it.
    expect(statSync(join(srv, 'forge-exec')).mode & 0o7777).toBe(0o700);
  });

  it.each([0o775, 0o757])('refuses a writable trusted parent (mode %s)', (mode) => {
    const srv = join(cwd, 'srv');
    mkdirSync(srv, { mode });
    // mkdir respects umask, so explicitly expose the untrusted write bits.
    // The harness changes only its scratch parent before executing setup.
    const forced = directoryHarness(directorySetup(), srv).replace('original_fstat = os.fstat', `os.chmod(${JSON.stringify(srv)}, ${mode})\noriginal_fstat = os.fstat`);
    const unsafe = spawnSync('python3', ['-c', forced], { encoding: 'utf8' });
    expect(unsafe.status, unsafe.stderr).not.toBe(0);
    expect(unsafe.stderr).toContain('/srv must be root-owned');
    expect(existsSync(join(srv, 'forge-exec'))).toBe(false);
  });

  it('creates the restricted user, run root and cache with strict bash and idempotency guards', () => {
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    expect(setup).toContain('set -euo pipefail');
    expect(setup).toMatch(/\buseradd\b[^\n]*\bforge-exec\b/);
    expect(setup).toContain('/srv/forge-exec');
    expect(setup).toContain('.cache');
    expect(setup).toMatch(/\bid\s+(?:-[a-zA-Z]+\s+)*forge-exec\b/);
    expect(setup).toContain('os.mkdir("forge-exec", 0o700, dir_fd=with_parent)');
    expect(setup).toContain('os.mkdir(".cache", 0o700, dir_fd=root)');
  });
});
