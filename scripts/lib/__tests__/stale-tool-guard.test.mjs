import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Load in each test so the absent implementation does not hide the independent wiring assertion.
const load = () => import('../stale-tool-guard.mjs');
const garbage = [];
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  for (const path of garbage.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch() {
  if (!process.env.TMPDIR) throw new Error('Tests require a task-local TMPDIR');
  const path = mkdtempSync(join(process.env.TMPDIR, 'stale-tool-'));
  garbage.push(path);
  return path;
}

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const success = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const failure = () => ({ status: 1, stdout: '', stderr: 'fixture git failure' });
const UPSTREAM_COMMIT = 'a'.repeat(40);
const MERGE_BASE_COMMIT = 'd'.repeat(40);
const configPins = env => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) },
  (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));

describe('evaluateStaleness', () => {
  it.each([
    [0, 5, ['scripts/tool.mjs'], 'ok'],
    [5, 5, ['scripts/tool.mjs'], 'ok'],
    [6, 5, ['scripts/tool.mjs'], 'stale'],
    [6, 5, ['scripts/lib/dep.mjs'], 'stale'],
    [6, 5, ['docs/unrelated.md'], 'ok'],
    [6, 5, [], 'ok'],
    [6, 5, ['scripts/lib/dep.mjs.bak'], 'ok'],
    [1, 0, ['scripts/tool.mjs'], 'stale'],
    [Number.MAX_SAFE_INTEGER, 5, ['scripts/tool.mjs'], 'stale'],
  ])('behind=%s threshold=%s changed=%j => %s', async (behind, threshold, changedPaths, action) => {
    const { evaluateStaleness } = await load();
    const depPaths = new Set(['scripts/tool.mjs', 'scripts/lib/dep.mjs']);
    const before = [...changedPaths];
    expect(evaluateStaleness({ behind, threshold, changedPaths, depPaths })).toEqual({ action, behind });
    expect(changedPaths).toEqual(before);
    expect([...depPaths]).toEqual(['scripts/tool.mjs', 'scripts/lib/dep.mjs']);
  });

  it.each([undefined, null, -1, 1.5, NaN, Infinity, '6', Number.MAX_SAFE_INTEGER + 1])(
    'fails closed with reason unknown for invalid/oversized behind=%s even without changed dependencies',
    async (behind) => {
      const { evaluateStaleness } = await load();
      expect(evaluateStaleness({ behind, threshold: 5, changedPaths: [], depPaths: new Set() }))
        .toEqual({ action: 'stale', behind, reason: 'unknown' });
    },
  );
});

describe('importClosure', () => {
  it('includes the entry and recursive static relative imports/re-exports, normalizes paths and terminates cycles', async () => {
    const { importClosure } = await load();
    const files = new Map(Object.entries({
      'scripts/fixture-tool.mjs': `
        import value from './fixture/dep.mjs';
        import './fixture/side.mjs';
        export { other } from './fixture/barrel.mjs';
        export * from './fixture/star.mjs';
        import {
          named
        } from "./fixture/multiline.mjs";
        import fs from 'node:fs';
        import pkg from 'typescript';
        const lazy = import('./fixture/dynamic.mjs');
      `,
      'scripts/fixture/dep.mjs': "import '../fixture/../fixture-tool.mjs'; export * from '../../shared/leaf.mjs';",
      'scripts/fixture/side.mjs': '',
      'scripts/fixture/barrel.mjs': "export { leaf } from '../../shared/leaf.mjs';",
      'scripts/fixture/star.mjs': '',
      'scripts/fixture/multiline.mjs': '',
      'shared/leaf.mjs': 'export const leaf = 1;',
    }).map(([path, source]) => [join(ROOT, path), source]));
    const readFile = vi.fn((path) => {
      if (!files.has(String(path))) throw new Error(`Unexpected dependency: ${path}`);
      return files.get(String(path));
    });
    const closure = await importClosure(join(ROOT, 'scripts/fixture-tool.mjs'), { readFile });
    expect(closure).toBeInstanceOf(Set);
    expect([...closure].sort()).toEqual([...files.keys()].map((path) => relative(ROOT, path)).sort());
    expect(readFile).toHaveBeenCalledTimes(files.size);
  });

  it('rejects unreadable static dependencies instead of returning an incomplete closure', async () => {
    const { importClosure } = await load();
    await expect(async () => importClosure(join(ROOT, 'scripts/fixture-tool.mjs'), {
      readFile: (path) => {
        if (String(path).endsWith('/fixture-tool.mjs')) return "import './missing.mjs';";
        throw new Error('unreadable dependency');
      },
    })).rejects.toThrow();
  });
});

/** exec is injectable spawnSync(command, argv, options), returning { status, stdout, stderr, error? }. */
function harness({ behind = '6\n', changed = 'scripts/lib/dep.mjs\n', upstream = `${UPSTREAM_COMMIT}\n`, fail, throws = false, childStatus = 0 } = {}) {
  const root = scratch();
  // The injected exec and explicit root need no on-disk Git metadata.
  mkdirSync(join(root, 'node_modules'));
  put(root, 'scripts/tool.mjs', "import './lib/dep.mjs';");
  put(root, 'scripts/lib/dep.mjs', 'export const version = 1;');
  let worktree;
  const exec = vi.fn((command, args, options) => {
    if (command === process.execPath || command === 'node') {
      expect(worktree).toBeTruthy();
      expect(realpathSync(join(worktree, 'node_modules'))).toBe(realpathSync(join(root, 'node_modules')));
      return { status: childStatus, stdout: '', stderr: '' };
    }
    expect(command).toBe('git');
    expect(options.cwd).toBe(args.includes('--show-toplevel') ? process.cwd()
      : args.includes('config') || args.includes('reset') ? worktree : root);
    if (args.includes('--show-toplevel')) return failure(); // Model a non-Git invocation cwd.
    if (args.includes('config') || args.includes('reset')) return success();
    const operation = ['fetch', 'rev-parse', 'rev-list', 'merge-base', 'diff', 'worktree'].find((name) => args.includes(name));
    const stage = operation === 'worktree' ? `worktree-${args[args.indexOf('worktree') + 1]}` : operation;
    if (stage === fail) {
      if (throws) throw new Error('fixture exec failure');
      return failure();
    }
    if (operation === 'fetch') return success();
    if (operation === 'rev-parse') {
      expect(args.slice(args.indexOf('rev-parse'))).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
      return success(upstream);
    }
    if (operation === 'rev-list') return success(behind);
    if (operation === 'merge-base') {
      expect(args.slice(2)).toEqual(['merge-base', 'HEAD', upstream.trim()]);
      return success(`${MERGE_BASE_COMMIT}\n`);
    }
    if (operation === 'diff') {
      expect(args.slice(2)).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', MERGE_BASE_COMMIT, upstream.trim(), '--']);
      return success(changed);
    }
    if (stage === 'worktree-add') {
      expect(args).toContain('--detach');
      expect(args.at(-1)).toBe(upstream.trim());
      worktree = args[args.indexOf('--detach') + 1];
      expect(worktree).toBeTruthy();
      garbage.push(worktree);
      put(worktree, 'scripts/tool.mjs', 'process.exit(0);');
      return success();
    }
    if (stage === 'worktree-remove') {
      expect(args).toContain(worktree);
      rmSync(worktree, { recursive: true, force: true });
      return success();
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  });
  return { root, entry: join(root, 'scripts/tool.mjs'), exec, env: {}, get worktree() { return worktree; } };
}

const nodeCalls = (h) => h.exec.mock.calls.filter(([cmd]) => cmd === process.execPath || cmd === 'node');
const removals = (h) => h.exec.mock.calls.filter(([, args]) => args.includes('worktree') && args.includes('remove'));

describe('review regressions', () => {
  it.each(['file', 'directory', 'chain'])('checks the real tool checkout when invoked through an external %s symlink', kind => {
    const outside = scratch();
    const fixture = mkdtempSync(join(ROOT, '.fix-tool-'));
    garbage.push(fixture);
    put(fixture, 'tool.mjs', "import { guardToolEntry } from '../scripts/lib/stale-tool-guard-entry.mjs';\nawait guardToolEntry();\nconsole.log('guard passed');\n");
    let alias = join(outside, 'tool.mjs');
    if (kind === 'directory') {
      symlinkSync(fixture, join(outside, 'alias-directory'));
      alias = join(outside, 'alias-directory/tool.mjs');
    } else {
      symlinkSync(join(fixture, 'tool.mjs'), join(outside, 'target.mjs'));
      symlinkSync(kind === 'chain' ? './target.mjs' : join(fixture, 'tool.mjs'), alias);
    }
    const trace = join(outside, 'git-calls.jsonl');
    put(outside, 'bin/git', `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args.includes('rev-parse') || args.includes('merge-base')) console.log('${UPSTREAM_COMMIT}');
else if (args.includes('rev-list')) console.log('0');
else if (!args.includes('fetch') && !args.includes('diff')) process.exit(99);
`);
    chmodSync(join(outside, 'bin/git'), 0o755);
    const env = { ...process.env, PATH: `${join(outside, 'bin')}:${process.env.PATH}`,
      WE_TOOL_STALE_MODE: 'refuse', WE_TOOL_STALE_THRESHOLD: '5' };
    delete env.NODE_OPTIONS;
    delete env.VITEST;
    const result = spawnSync(process.execPath, [alias], { cwd: outside, env,
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('guard passed');
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.args[2])).toEqual(['fetch', 'rev-parse', 'rev-list', 'merge-base', 'diff']);
    for (const call of calls) {
      expect(call.cwd).toBe(realpathSync(ROOT));
      expect(call.args.slice(0, 2)).toEqual(['-C', realpathSync(ROOT)]);
    }
  });

  it.each(['ref changed', 'lock exists'])('retries a transient fetch %s before checking freshness', async kind => {
    const { guardToolCheckout } = await load();
    const h = harness({ behind: '0\n', changed: '' });
    const runner = h.exec.getMockImplementation();
    let fetches = 0;
    h.exec.mockImplementation((command, args, options) => {
      if (args.includes('fetch') && ++fetches === 1) return { status: 1, stdout: '', stderr: kind === 'ref changed'
        ? "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def"
        : "Unable to create 'refs/remotes/origin/main.lock': File exists" };
      return runner(command, args, options);
    });
    await expect(guardToolCheckout({ ...h, env: { WE_GIT_LOCK_RETRY_BASE_MS: '0' } })).resolves.toBeUndefined();
    expect(fetches).toBe(2);
    expect(h.exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(true);
  });

  it('normalizes an explicitly supplied checkout symlink with the entry', async () => {
    const { guardToolCheckout } = await load();
    const h = harness({ behind: '0\n', changed: '' });
    const alias = join(scratch(), 'checkout');
    symlinkSync(h.root, alias);
    await expect(guardToolCheckout({ ...h, root: alias, entry: join(alias, 'scripts/tool.mjs') }))
      .resolves.toBeUndefined();
    expect(h.exec.mock.calls[0][1].slice(0, 2)).toEqual(['-C', realpathSync(h.root)]);
  });

  it('refuses a dangling entry symlink before collecting Git evidence', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    const alias = join(scratch(), 'missing-tool.mjs');
    symlinkSync(join(h.root, 'missing.mjs'), alias);
    await expect(guardToolCheckout({ ...h, entry: alias })).rejects.toThrow('ENOENT');
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('fails closed after the bounded fetch lock retries are exhausted', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    h.exec.mockReturnValue({ status: 1, stdout: '', stderr: "cannot lock ref 'refs/remotes/origin/main': is at abc but expected def" });
    await expect(guardToolCheckout({ ...h, env: { WE_GIT_LOCK_RETRY_ATTEMPTS: '2', WE_GIT_LOCK_RETRY_BASE_MS: '0' } }))
      .rejects.toThrow('git-ref-lock-transient');
    expect(h.exec).toHaveBeenCalledTimes(2);
    expect(nodeCalls(h)).toHaveLength(0);
  });

  it.each([
    'git@github.com:web-everything/web-everything.git',
    'ssh://git@github.com:2222/web-everything/web-everything.git',
  ])('checks freshness for a current SSH origin %s', async (origin) => {
    const { guardToolCheckout } = await load();
    const h = harness({ behind: '0\n', changed: '' });
    // Bare metadata avoids .git writes. The SSH stand-in advertises an empty remote
    // locally, exercising real Git transport admission without network or credentials.
    mkdirSync(join(h.root, 'objects'));
    mkdirSync(join(h.root, 'refs'));
    put(h.root, 'HEAD', 'ref: refs/heads/main\n');
    put(h.root, 'config', `[core]\n bare = true\n sshCommand = untrusted-command\n[remote "origin"]\n url = ${origin}\n[protocol "ssh"]\n allow = never\n`);
    // Answer Git's SSH capability probe separately. Keep stdin open until Git
    // finishes its request, otherwise protocol-v2 writes can race our exit (SIGPIPE).
    put(h.root, 'bin/ssh', '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "-G" ]; then exit 0; fi\ndone\nprintf "0000"\ncat >/dev/null\n');
    chmodSync(join(h.root, 'bin/ssh'), 0o755);
    const runner = h.exec.getMockImplementation();
    let probe;
    h.exec.mockImplementation((command, args, options) => {
      if (!args.includes('fetch')) return runner(command, args, options);
      // Reuse the guard's exact config/env for a read-only transport probe; the
      // subsequent count/diff use the current-checkout fixture above.
      expect(options.env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
      expect(configPins(options.env)).toMatchObject({ 'protocol.ssh.allow': 'always',
        'protocol.ext.allow': 'never', 'protocol.file.allow': 'never' });
      probe = spawnSync(command, [...args.slice(0, args.indexOf('fetch')), 'ls-remote', 'origin'], options);
      return probe;
    });
    const outcome = await guardToolCheckout({ ...h, env: { ...process.env,
      PATH: `${join(h.root, 'bin')}:${process.env.PATH}`,
      GIT_ALLOW_PROTOCOL: 'ext', GIT_SSH_COMMAND: 'untrusted-command',
    }, log: () => {} }).then(() => 'continued', error => error.message);
    expect(probe.error).toBeUndefined();
    expect(probe.signal).toBeNull();
    expect(probe.stderr).toBe('');
    expect(probe.status).toBe(0);
    expect(outcome).toBe('continued');
    expect(h.exec.mock.calls.some(([, args]) => args.includes('rev-list'))).toBe(true);
    expect(h.exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(true);
    expect(nodeCalls(h)).toHaveLength(0);
  });

  it('does not execute a repo-configured credential helper during guard Git calls', async () => {
    const { guardToolCheckout } = await load();
    const h = harness({ behind: '0\n', changed: '' });
    const marker = join(h.root, 'credential-helper-ran');
    mkdirSync(join(h.root, 'objects'));
    mkdirSync(join(h.root, 'refs'));
    put(h.root, 'HEAD', 'ref: refs/heads/main\n');
    put(h.root, 'config', `[core]\n bare = true\n[credential]\n helper = !touch '${marker}'\n`);
    const runner = h.exec.getMockImplementation();
    let credentialProbe;
    h.exec.mockImplementation((command, args, options) => {
      if (args.includes('fetch')) {
        // Exercise Git's real credential path with the fetch's exact environment,
        // without network access or fetching from another repository.
        credentialProbe = spawnSync(command, ['-C', h.root, 'credential', 'fill'], {
          ...options, input: 'protocol=https\nhost=fixture.invalid\n\n',
        });
        return success();
      }
      return runner(command, args, options);
    });
    await guardToolCheckout({ ...h, env: { ...process.env }, log: () => {} });
    expect(credentialProbe.error).toBeUndefined();
    expect(credentialProbe.status).not.toBe(0);
    expect(credentialProbe.stderr).toContain('terminal prompts disabled');
    expect(existsSync(marker)).toBe(false);
    expect(h.exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(true);
  });

  it('scrubs inherited Git context and pins every Git call to the tool checkout', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    const env = {
      GIT_DIR: '/untrusted/repository', GIT_WORK_TREE: '/untrusted/worktree',
      GIT_COMMON_DIR: '/untrusted/common', GIT_INDEX_FILE: '/untrusted/index',
      GIT_OBJECT_DIRECTORY: '/untrusted/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/untrusted/alternate',
      GIT_CONFIG: '/untrusted/config', GIT_CONFIG_GLOBAL: '/untrusted/global', GIT_CONFIG_SYSTEM: '/untrusted/system',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always',
      GIT_CONFIG_PARAMETERS: "'protocol.ext.allow=always'", GIT_EXEC_PATH: '/untrusted/bin',
      GIT_CONFIG_KEY_orphan: 'protocol.ext.allow', GIT_CONFIG_VALUE_orphan: 'always',
      GIT_ALLOW_PROTOCOL: 'ext:file', GIT_SSH_COMMAND: 'untrusted-command',
      GIT_EXTERNAL_DIFF: 'untrusted-diff', GIT_ASKPASS: 'untrusted-askpass', FIXTURE_TOKEN: 'keep',
      SSH_ASKPASS: 'untrusted-ssh-askpass', SSH_ASKPASS_REQUIRE: 'force',
    };
    await guardToolCheckout({ ...h, env, settings: { mode: 'reexec' } });
    for (const [, args, options] of h.exec.mock.calls.filter(([cmd]) => cmd === 'git')) {
      expect(args.slice(0, 2)).toEqual(['-C', options.cwd]);
      for (const key of Object.keys(env).filter(key => key.startsWith('GIT_'))) {
        if (!key.startsWith('GIT_CONFIG_')) {
          expect(options.env[key], key).toBe(key === 'GIT_ALLOW_PROTOCOL' ? 'https:ssh' : undefined);
        }
      }
      expect(options.env.FIXTURE_TOKEN).toBe('keep');
      expect(args[2]).not.toBe('-c');
      expect(configPins(options.env)).toMatchObject({ 'protocol.ext.allow': 'never', 'protocol.allow': 'never',
        'protocol.https.allow': 'always', 'protocol.ssh.allow': 'always', 'protocol.file.allow': 'never',
        'protocol.http.allow': 'never', 'protocol.git.allow': 'never', 'core.sshCommand': 'ssh',
        'credential.helper': '', 'core.askPass': '' });
      expect(options.env.SSH_ASKPASS).toBeUndefined();
      expect(options.env.SSH_ASKPASS_REQUIRE).toBeUndefined();
      expect(options.env.GIT_CONFIG_KEY_orphan).toBeUndefined();
      expect(options.env.GIT_CONFIG_VALUE_orphan).toBeUndefined();
      if (args.includes('fetch')) expect(args).toContain('--upload-pack=git-upload-pack');
    }
    const childEnv = nodeCalls(h)[0][2].env;
    for (const key of Object.keys(env).filter(key => key.startsWith('GIT_'))) expect(childEnv[key], key).toBeUndefined();
    expect(env.GIT_DIR).toBe('/untrusted/repository');
  });

  it.each(['checkout', 'elsewhere'])('refuses an ext origin with GIT_DIR pointing %s without executing its transport command', async (location) => {
    const { guardToolCheckout } = await load();
    const root = scratch();
    const marker = join(root, 'transport-executed');
    // The realpath entry check must pass before this test can exercise transport refusal.
    put(root, 'scripts/tool.mjs', '');
    // A minimal bare repository, assembled as files: no .git writes or Git setup commands.
    mkdirSync(join(root, 'objects'));
    mkdirSync(join(root, 'refs'));
    put(root, 'HEAD', 'ref: refs/heads/main\n');
    put(root, 'config', `[core]\n bare = true\n[remote "origin"]\n url = ext::sh -c >${marker}\n[protocol "ext"]\n allow = always\n`);
    // A missing inherited repository must not redirect Git away from the trusted checkout.
    // The transport-specific stderr below proves that Git actually reached that checkout's origin.
    const inheritedGitDir = location === 'checkout' ? root : join(scratch(), 'missing-repository');
    const exec = vi.fn(spawnSync);
    await expect(guardToolCheckout({ entry: join(root, 'scripts/tool.mjs'), root,
      exec, env: { ...process.env, GIT_DIR: inheritedGitDir,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always',
        GIT_ALLOW_PROTOCOL: 'ext' }, log: () => {},
    })).rejects.toThrow('Git fetch');
    expect(existsSync(marker)).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.results[0].value.stderr).toContain("transport 'ext' not allowed");
  });

  it.each([undefined, 'relative-pool', '~/private-pool'])(
    'reexec preserves original checkout and pool from a non-git cwd with override %s', async (pool) => {
      const { guardToolCheckout } = await load();
      const { defaultPoolRoot } = await import('../lane-pool-paths.mjs');
      const h = harness();
      const task = scratch();
      const cwd = scratch();
      const env = { ...process.env, TMPDIR: task, WE_TOOL_STALE_MODE: 'reexec' };
      delete env.LANE_POOL_ROOT;
      delete env.VITEST;
      delete env.WE_UNDER_TEST;
      if (pool) env.LANE_POOL_ROOT = pool;
      const runner = h.exec.getMockImplementation();
      const source = readFileSync(join(ROOT, 'scripts/lane-pool.mjs'), 'utf8');
      const bootstrap = source.slice(source.indexOf('const CWD_TOP_LEVEL ='),
        source.indexOf('// #3383 — `guardedPoolRoot`'));
      expect(bootstrap).toContain('const CHECKOUT_ROOT =');
      let child;
      h.exec.mockImplementation((command, args, options) => {
        if (command === process.execPath) {
          put(h.worktree, 'scripts/tool.mjs', `
            import { checkoutRootFor, defaultPoolRoot } from ${JSON.stringify(join(ROOT, 'scripts/lib/lane-pool-paths.mjs'))};
            import { dirname, resolve } from 'node:path';
            import { fileURLToPath } from 'node:url';
            const tryGit = () => null;
            const LOCAL_GIT_TIMEOUT_MS = 1000;
            ${bootstrap}
            console.log(JSON.stringify({ checkout: CHECKOUT_ROOT, pool: defaultPoolRoot(CHECKOUT_ROOT), cwd: process.cwd() }));
          `);
          child = spawnSync(command, args, { ...options, cwd, stdio: 'pipe', encoding: 'utf8', timeout: 10_000 });
          return child;
        }
        return runner(command, args, options);
      });
      expect(await guardToolCheckout({ ...h, env })).toBe(0);
      expect(child.stderr).toBe('');
      expect(JSON.parse(child.stdout)).toEqual({
        checkout: h.root, pool: defaultPoolRoot(h.root, env), cwd,
      });
      expect(existsSync(h.worktree)).toBe(false);
    },
  );

  it('preserves a Git cwd repository instead of the tool checkout for the child', async () => {
    const { guardToolCheckout } = await load();
    const { defaultPoolRoot } = await import('../lane-pool-paths.mjs');
    const h = harness();
    const cwdRoot = scratch();
    const runner = h.exec.getMockImplementation();
    h.exec.mockImplementation((command, args, options) => args.includes('--show-toplevel')
      ? success(`${cwdRoot}\n`) : runner(command, args, options));
    await guardToolCheckout({ ...h, settings: { mode: 'reexec' } });
    expect(nodeCalls(h)[0][2].env).toMatchObject({
      WE_TOOL_ORIGINAL_CHECKOUT: cwdRoot, LANE_POOL_ROOT: defaultPoolRoot(cwdRoot, {}),
    });
  });

  it('keeps the test real-pool refusal before creating a fresh worktree', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    await expect(guardToolCheckout({ ...h, env: { VITEST: 'true' }, settings: { mode: 'reexec' } }))
      .rejects.toThrow('refusing to resolve the REAL lane-pool root');
    expect(h.worktree).toBeUndefined();
    expect(nodeCalls(h)).toHaveLength(0);
  });
});

describe('guardToolCheckout', () => {
  it.each([
    ['current', '0\n', 'scripts/lib/dep.mjs\n'],
    ['default threshold boundary', '5\n', 'scripts/lib/dep.mjs\n'],
    ['unrelated commits', '99\n', 'docs/unrelated.md\n'],
  ])('returns normally for %s without launching a child', async (_label, behind, changed) => {
    const { guardToolCheckout } = await load();
    const h = harness({ behind, changed });
    await guardToolCheckout(h);
    expect(nodeCalls(h)).toHaveLength(0);
    expect(removals(h)).toHaveLength(0);
  });

  it('defaults to threshold 5 and refuse, naming the behind count', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    await expect(async () => guardToolCheckout(h)).rejects.toThrow('stale tool checkout (6 behind)');
    expect(nodeCalls(h)).toHaveLength(0);
  });

  it('honors a configured threshold including zero', async () => {
    const { guardToolCheckout } = await load();
    await guardToolCheckout({ ...harness(), settings: { threshold: 6 } });
    await expect(async () => guardToolCheckout({ ...harness({ behind: '1\n' }), settings: { threshold: 0 } }))
      .rejects.toThrow('stale tool checkout (1 behind)');
  });

  it('treats changes to the entry itself as relevant', async () => {
    const { guardToolCheckout } = await load();
    await expect(async () => guardToolCheckout(harness({ changed: 'scripts/tool.mjs\n' })))
      .rejects.toThrow('stale tool checkout (6 behind)');
  });

  it('re-exec marker still validates and refuses a second re-exec', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    await expect(guardToolCheckout({ ...h, env: { WE_TOOL_FRESH_REEXEC: '1' }, settings: { mode: 'reexec' } }))
      .rejects.toThrow('refusing a second re-exec');
    expect(h.exec.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(true);
    expect(nodeCalls(h)).toHaveLength(0);
    for (const marker of ['0', 'true', '']) {
      await expect(async () => guardToolCheckout({ ...h, env: { WE_TOOL_FRESH_REEXEC: marker } }))
        .rejects.toThrow('stale tool checkout (6 behind)');
    }
  });

  it.each(['fetch', 'rev-parse', 'rev-list', 'merge-base', 'diff'])('fails closed on a nonzero %s exit even in reexec mode', async (fail) => {
    const { guardToolCheckout } = await load();
    const h = harness({ fail });
    await expect(async () => guardToolCheckout({ ...h, settings: { mode: 'reexec' } })).rejects.toThrow(`Git ${fail}`);
    expect(nodeCalls(h)).toHaveLength(0);
    if (fail === 'fetch') expect(h.exec).toHaveBeenCalledTimes(1);
  });

  it.each(['fetch', 'rev-parse', 'rev-list', 'merge-base', 'diff'])('fails closed when %s throws', async (fail) => {
    const { guardToolCheckout } = await load();
    await expect(async () => guardToolCheckout(harness({ fail, throws: true }))).rejects.toThrow('fixture exec failure');
  });

  it.each(['', 'garbage\n', '-1\n', '1.5\n', '9007199254740992\n', '6junk\n'])
    ('refuses unknown/oversized rev-list output %j even for unrelated changes', async (behind) => {
      const { guardToolCheckout } = await load();
      await expect(async () => guardToolCheckout(harness({ behind, changed: 'docs/unrelated.md\n' })))
        .rejects.toThrow();
    });

  it.each(['', 'origin/main\n', '--help\n', `${UPSTREAM_COMMIT}\n${UPSTREAM_COMMIT}\n`, 'a'.repeat(39), 'a'.repeat(65)])(
    'refuses malformed upstream commit %j before counting or reexec', async (upstream) => {
      const { guardToolCheckout } = await load();
      const h = harness({ upstream });
      await expect(guardToolCheckout({ ...h, settings: { mode: 'reexec' } }))
        .rejects.toThrow('Invalid upstream commit ID');
      expect(h.exec.mock.calls.some(([, args]) => args.includes('rev-list'))).toBe(false);
      expect(nodeCalls(h)).toHaveLength(0);
    },
  );

  it.each([40, 64])('pins count, diff and reexec to one resolved %s-character commit even if the ref moves', async (length) => {
    const { guardToolCheckout } = await load();
    const upstream = 'b'.repeat(length);
    const h = harness({ upstream: `${upstream}\n` });
    const runner = h.exec.getMockImplementation();
    let resolutions = 0;
    h.exec.mockImplementation((command, args, options) => {
      if (args.includes('--verify') && resolutions++ > 0) return success(`${'c'.repeat(length)}\n`);
      return runner(command, args, options);
    });
    await guardToolCheckout({ ...h, settings: { mode: 'reexec' } });
    expect(resolutions).toBe(1);
    expect(h.exec.mock.calls.find(([, args]) => args.includes('rev-list'))[1]).toContain(`HEAD..${upstream}`);
    expect(h.exec.mock.calls.find(([, args]) => args.includes('diff'))[1]).toContain(upstream);
    expect(h.exec.mock.calls.find(([, args]) => args.includes('add'))[1].at(-1)).toBe(upstream);
  });

  it.each(['', 'HEAD\n', '--help\n', `${MERGE_BASE_COMMIT}\n${MERGE_BASE_COMMIT}\n`])(
    'refuses malformed merge-base evidence %j before diff or reexec', async (mergeBase) => {
      const { guardToolCheckout } = await load();
      const h = harness();
      const runner = h.exec.getMockImplementation();
      h.exec.mockImplementation((command, args, options) => args.includes('merge-base')
        ? success(mergeBase) : runner(command, args, options));
      await expect(guardToolCheckout({ ...h, settings: { mode: 'reexec' } }))
        .rejects.toThrow('Invalid merge-base commit ID');
      expect(h.exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(false);
      expect(nodeCalls(h)).toHaveLength(0);
    },
  );

  it('refuses an unreadable dependency instead of assuming unrelated changes are safe', async () => {
    const { guardToolCheckout } = await load();
    const h = harness({ changed: 'docs/unrelated.md\n' });
    rmSync(join(h.root, 'scripts/lib/dep.mjs'));
    await expect(async () => guardToolCheckout(h)).rejects.toThrow();
  });

  it.each([0, 23])('reexec uses detached origin/main, shared dependencies, same argv/cwd/env and returns status %s', async (childStatus) => {
    const { guardToolCheckout } = await load();
    const h = harness({ childStatus });
    const env = { FIXTURE_TOKEN: 'preserved' };
    process.argv = [process.execPath, h.entry, '--flag', 'two words', '$(inert)'];
    const result = await guardToolCheckout({ ...h, env, settings: { mode: 'reexec' } });
    expect(result).toBe(childStatus);
    expect(nodeCalls(h)).toHaveLength(1);
    const [, args, options] = nodeCalls(h)[0];
    expect(args).toEqual([join(h.worktree, 'scripts/tool.mjs'), '--flag', 'two words', '$(inert)']);
    expect(options.cwd).toBe(process.cwd());
    expect(options.env).toMatchObject({ FIXTURE_TOKEN: 'preserved', WE_TOOL_FRESH_REEXEC: '1' });
    expect(options.shell).not.toBe(true);
    expect(env).toEqual({ FIXTURE_TOKEN: 'preserved' });
    expect(removals(h)).toHaveLength(1);
    expect(existsSync(h.worktree)).toBe(false);
  });

  it('removes the worktree when launching the fresh entry throws', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    const runner = h.exec.getMockImplementation();
    h.exec.mockImplementation((cmd, args, options) => {
      if (cmd === process.execPath || cmd === 'node') throw new Error('cannot launch node');
      return runner(cmd, args, options);
    });
    await expect(async () => guardToolCheckout({ ...h, settings: { mode: 'reexec' } })).rejects.toThrow();
    expect(removals(h)).toHaveLength(1);
    expect(existsSync(h.worktree)).toBe(false);
  });

  it('refuses a failed worktree creation without running the stale entry', async () => {
    const { guardToolCheckout } = await load();
    const h = harness({ fail: 'worktree-add' });
    await expect(async () => guardToolCheckout({ ...h, settings: { mode: 'reexec' } })).rejects.toThrow();
    expect(nodeCalls(h)).toHaveLength(0);
  });

  it('removes the worktree and refuses when node returns a spawn error without an exit status', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    const runner = h.exec.getMockImplementation();
    h.exec.mockImplementation((cmd, args, options) => {
      if (cmd === process.execPath || cmd === 'node') return { status: null, error: new Error('ENOENT') };
      return runner(cmd, args, options);
    });
    await expect(async () => guardToolCheckout({ ...h, settings: { mode: 'reexec' } })).rejects.toThrow();
    expect(removals(h)).toHaveLength(1);
    expect(existsSync(h.worktree)).toBe(false);
  });
});

describe('real local Git fixture (no network)', () => {
  it.each([
    ['scripts/lib/dep.mjs', null, 'none'], ['docs/unrelated.md', null, 'none'],
    ['docs/unrelated.md', null, 'committed'], ['docs/unrelated.md', null, 'uncommitted'],
    ['docs/unrelated.md', null, 'no-common-history'],
    ['scripts/lib/dep.mjs', 'refs/heads/origin/main', 'none'],
    ['scripts/lib/dep.mjs', 'refs/tags/origin/main', 'none'],
    ['scripts/lib/dep.mjs', 'refs/tags/refs/remotes/origin/main', 'none'],
  ])('six upstream commits touching %s with shadow %s and local change %s use real ancestry and diff evidence', async (changedPath, shadow, localChange) => {
    const { guardToolCheckout } = await load();
    const checkout = scratch();
    // Assemble a bare object store as files: all Git commands below are read-only,
    // and neither setup nor the simulated fetch needs a .git directory or network.
    function object(type, contents) {
      const body = Buffer.from(contents);
      const bytes = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
      const oid = createHash('sha1').update(bytes).digest('hex');
      put(checkout, `objects/${oid.slice(0, 2)}/${oid.slice(2)}`, deflateSync(bytes));
      return oid;
    }
    let tip;
    let head;
    for (let version = 0; version <= 6; version++) {
      let oid = object('blob', `// version ${version}\n`);
      let mode = '100644';
      for (const name of changedPath.split('/').reverse()) {
        oid = object('tree', Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]));
        mode = '40000';
      }
      tip = object('commit', `tree ${oid}\n${tip ? `parent ${tip}\n` : ''}`
        + 'author Fixture <fixture@example.invalid> 1700000000 +0000\n'
        + `committer Fixture <fixture@example.invalid> 1700000000 +0000\n\nversion ${version}\n`);
      if (version === 0) head = tip;
    }
    if (['committed', 'no-common-history'].includes(localChange)) {
      const blob = object('blob', 'export const version = 42;');
      const lib = object('tree', Buffer.concat([Buffer.from('100644 dep.mjs\0'), Buffer.from(blob, 'hex')]));
      const scripts = object('tree', Buffer.concat([Buffer.from('40000 lib\0'), Buffer.from(lib, 'hex')]));
      const tree = object('tree', Buffer.concat([Buffer.from('40000 scripts\0'), Buffer.from(scripts, 'hex')]));
      head = object('commit', `tree ${tree}\n${localChange === 'committed' ? `parent ${head}\n` : ''}`
        + 'author Fixture <fixture@example.invalid> 1700000001 +0000\n'
        + 'committer Fixture <fixture@example.invalid> 1700000001 +0000\n\nlocal dependency change\n');
    }
    put(checkout, 'config', '[core]\n bare = true\n');
    put(checkout, 'HEAD', 'ref: refs/heads/main\n');
    put(checkout, 'refs/heads/main', `${head}\n`);
    put(checkout, 'refs/remotes/origin/main', `${head}\n`);
    if (shadow) put(checkout, shadow, `${head}\n`);
    put(checkout, 'scripts/tool.mjs', "import './lib/dep.mjs';");
    put(checkout, 'scripts/lib/dep.mjs', `export const version = ${localChange === 'none' ? 0 : 42};`);
    const exec = vi.fn((command, args, options) => {
      expect(command).toBe('git');
      expect(options.cwd).toBe(checkout);
      if (args.includes('fetch')) {
        put(checkout, 'refs/remotes/origin/main', `${tip}\n`);
        return success();
      }
      expect(args.some(arg => ['rev-parse', 'rev-list', 'merge-base', 'diff'].includes(arg))).toBe(true);
      return spawnSync(command, args, options);
    });
    const run = () => guardToolCheckout({ root: checkout, entry: join(checkout, 'scripts/tool.mjs'), exec, env: {} });
    if (localChange === 'no-common-history') {
      await expect(run()).rejects.toThrow('Git merge-base failed');
      expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(false);
      return;
    }
    if (changedPath === 'scripts/lib/dep.mjs') {
      await expect(async () => run()).rejects.toThrow('stale tool checkout (6 behind)');
    } else {
      await run();
    }
    expect(exec.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(true);
    expect(exec.mock.calls.some(([, args]) => args.includes('rev-list'))).toBe(true);
    expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(true);
  });
});

describe('lane-pool entry wiring', () => {
  it('uses the original checkout fallback only in the fresh reexec child', () => {
    const source = readFileSync(join(ROOT, 'scripts/lane-pool.mjs'), 'utf8');
    expect(source).toContain("process.env.WE_TOOL_FRESH_REEXEC === '1' && process.env.WE_TOOL_ORIGINAL_CHECKOUT");
    expect(source).toContain('? process.env.WE_TOOL_ORIGINAL_CHECKOUT : resolve(dirname(fileURLToPath(import.meta.url))');
  });

  it('awaits the guard entry before loading tool dependencies', () => {
    const source = readFileSync(join(ROOT, 'scripts/lane-pool.mjs'), 'utf8');
    const imports = source.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line));
    expect(imports[0]).toBe("import { guardToolEntry } from './lib/stale-tool-guard-entry.mjs';");
    expect(imports).not.toContain("import './lib/stale-tool-guard.mjs';");
    expect(imports).toEqual(["import { guardToolEntry } from './lib/stale-tool-guard-entry.mjs';"]);
    expect(source.indexOf('await guardToolEntry();')).toBeLessThan(source.indexOf('= await import('));
  });
});

describe('guard bounds and settings', () => {
  it('lets unit fixtures inject a check without an environment exemption', async () => {
    const { guardToolEntry } = await import('../stale-tool-guard-entry.mjs');
    const check = vi.fn(async () => undefined);
    await guardToolEntry({ check });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ entry: process.argv[1] });
  });

  it.each(['missing directory', 'missing legacy', 'malformed', 'non-object', 'dangling feature'])(
    'refuses %s declared settings with a named error', async kind => {
      const { readDeclaredSettings } = await import('../settings-files.mjs');
      const { resolveStaleToolSettings } = await load();
      const root = scratch();
      let dir = root, legacyPath = null;
      if (kind === 'missing directory') dir = join(root, 'missing');
      else if (kind === 'missing legacy') legacyPath = join(root, 'missing.json');
      else if (kind === 'dangling feature') {
        const { symlinkSync } = await import('node:fs');
        symlinkSync(join(root, 'missing'), join(root, 'strict.json'));
      } else put(root, 'strict.json', kind === 'malformed' ? '{broken' : '[]');
      const readDeclared = options => readDeclaredSettings({ ...options, dir, legacyPath });
      expect(() => resolveStaleToolSettings({ platform: {}, env: {}, readDeclared, log: () => {} }))
        .toThrow(/staleToolGuard declared settings/);
    },
  );

  it.each(['current', 'fetch failure', 'invalid settings'])('re-exec child repeats validation: %s', async kind => {
    const { guardToolCheckout } = await load();
    const h = harness({ behind: '0\n', fail: kind === 'fetch failure' ? 'fetch' : undefined });
    const run = guardToolCheckout({ ...h, env: { WE_TOOL_FRESH_REEXEC: '1' },
      settings: kind === 'invalid settings' ? { threshold: -1 } : {} });
    if (kind === 'current') {
      await expect(run).resolves.toBeUndefined();
      expect(h.exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(true);
    } else await expect(run).rejects.toThrow(kind === 'fetch failure' ? 'Git fetch' : 'Invalid staleToolGuard');
    expect(nodeCalls(h)).toHaveLength(0);
  });

  it('refuses unreadable declared settings directories instead of using defaults', async () => {
    const { readDeclaredSettings } = await import('../settings-files.mjs');
    const { resolveStaleToolSettings } = await load();
    const dir = join(scratch(), 'not-a-directory');
    writeFileSync(dir, 'unreadable settings inventory');
    const readDeclared = options => readDeclaredSettings({ ...options, dir, legacyPath: null });
    expect(() => resolveStaleToolSettings({ platform: {}, env: {}, readDeclared, log: () => {} }))
      .toThrow(/staleToolGuard.*settings/);
  });

  it('disables configured checkout filters before populating the re-exec worktree', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    const runner = h.exec.getMockImplementation();
    h.exec.mockImplementation((command, args, options) => {
      if (args.includes('config')) return success('filter.fixture.smudge\0filter.fixture.process\0filter.fixture.required\0');
      if (args.includes('reset')) {
        expect(configPins(options.env)).toMatchObject({ 'filter.fixture.smudge': '',
          'filter.fixture.process': '', 'filter.fixture.clean': '', 'filter.fixture.required': 'false',
          'core.hooksPath': '/dev/null' });
        return success();
      }
      return runner(command, args, options);
    });
    await guardToolCheckout({ ...h, settings: { mode: 'reexec' } });
    const add = h.exec.mock.calls.find(([, args]) => args.includes('add'));
    expect(add[1]).toContain('--no-checkout');
    expect(h.exec.mock.calls.some(([, args]) => args.includes('reset'))).toBe(true);
  });

  it.each(['smudge', 'process'])('real Git cannot run a configured %s filter with checkout hardening', async driver => {
    const { laneGitCheckoutEnv, laneGitHardeningEnv } = await import('../lane-git-hardening.mjs');
    const root = scratch();
    const marker = join(root, 'filter-ran');
    const payload = 'fixture payload\n';
    const bytes = Buffer.from(`blob ${Buffer.byteLength(payload)}\0${payload}`);
    const oid = createHash('sha1').update(bytes).digest('hex');
    put(root, `objects/${oid.slice(0, 2)}/${oid.slice(2)}`, deflateSync(bytes));
    mkdirSync(join(root, 'refs'));
    put(root, 'HEAD', 'ref: refs/heads/main\n');
    put(root, 'config', `[core]\n bare = true\n[filter "fixture.with.dots"]\n ${driver} = touch '${marker}'\n required = true\n`);
    put(root, 'info/attributes', '*.txt filter=fixture.with.dots\n');
    const env = laneGitHardeningEnv({ ...process.env });
    const options = { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 };
    const config = spawnSync('git', ['-C', root, 'config', '--name-only', '--list', '--includes', '-z'], options);
    expect(config.status, config.stderr).toBe(0);
    const result = spawnSync('git', ['-C', root, 'cat-file', '--filters', '--path=payload.txt', oid],
      { ...options, env: laneGitCheckoutEnv(env, config.stdout) });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(payload);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses truncated, control-bearing and oversized filter inventories with a recovery path', async () => {
    const { laneGitCheckoutEnv } = await import('../lane-git-hardening.mjs');
    for (const config of ['filter.fixture.smudge', 'filter.fi\nxture.smudge\0', 'filter.fi\rxture.process\0',
      'filter.fi\u2028xture.smudge\0',
      Array.from({ length: 257 }, (_, i) => `filter.driver${i}.smudge\0`).join('')]) {
      expect(() => laneGitCheckoutEnv({}, config)).toThrow(/checkout filter/i);
    }
  });

  it.each(['--driver', 'with.dots', 'two words', "quote'back`tick", '$(inert)', 'ｆilter', 'invisible\u200bname'])(
    'pins the exact filter name %s without normalization or shell interpolation', async driver => {
      const { laneGitCheckoutEnv } = await import('../lane-git-hardening.mjs');
      const env = laneGitCheckoutEnv({}, `filter.${driver}.process\0`);
      expect(configPins(env)).toMatchObject({ [`filter.${driver}.process`]: '',
        [`filter.${driver}.smudge`]: '', [`filter.${driver}.required`]: 'false' });
    },
  );

  it.each(['config', 'reset'])('fails closed when re-exec %s fails and cleans the worktree', async operation => {
    const { guardToolCheckout } = await load();
    const h = harness();
    const runner = h.exec.getMockImplementation();
    h.exec.mockImplementation((command, args, options) => args.includes(operation) ? failure() : runner(command, args, options));
    await expect(guardToolCheckout({ ...h, settings: { mode: 'reexec' } })).rejects.toThrow(`Git ${operation}`);
    expect(nodeCalls(h)).toHaveLength(0);
    expect(removals(h)).toHaveLength(1);
  });

  it('resolves each setting through standard, platform, tool and environment with provenance', async () => {
    const { resolveStaleToolSettings } = await load();
    const log = vi.fn();
    expect(resolveStaleToolSettings({ platform: {}, settings: {}, env: {}, log }))
      .toEqual({ threshold: 5, mode: 'refuse' });
    expect(log.mock.lastCall[0]).toContain('threshold=5 (standard)');
    expect(resolveStaleToolSettings({ platform: { threshold: 2, mode: 'reexec' },
      settings: { threshold: 3 }, env: {}, log })).toEqual({ threshold: 3, mode: 'reexec' });
    expect(log.mock.lastCall[0]).toContain('threshold=3 (tool)');
    expect(log.mock.lastCall[0]).toContain('mode="reexec" (platform)');
    expect(resolveStaleToolSettings({ platform: { threshold: 2 }, settings: { threshold: 3 },
      env: { WE_TOOL_STALE_THRESHOLD: '0', WE_TOOL_STALE_MODE: 'refuse' }, log }))
      .toEqual({ threshold: 0, mode: 'refuse' });
    expect(log.mock.lastCall[0]).toContain('threshold=0 (env)');
  });

  it.each([{ threshold: -1 }, { threshold: Infinity }, { threshold: '6' },
    { threshold: Number.MAX_SAFE_INTEGER + 1 }, { mode: 'off' }, null])(
    'refuses invalid tool settings %j before Git IO', async (settings) => {
      const { guardToolCheckout } = await load();
      const h = harness();
      await expect(guardToolCheckout({ ...h, settings })).rejects.toThrow('Invalid staleToolGuard');
      expect(h.exec).not.toHaveBeenCalled();
    },
  );

  it('refuses unreadable platform settings and malformed environment overrides', async () => {
    const { resolveStaleToolSettings } = await load();
    const file = join(scratch(), 'preferences.json');
    writeFileSync(file, '{broken');
    expect(() => resolveStaleToolSettings({ settings: {}, env: { WE_PLATFORM_PREFERENCES_FILE: file } }))
      .toThrow('Unreadable staleToolGuard');
    for (const threshold of ['', '6junk', '9007199254740992']) {
      expect(() => resolveStaleToolSettings({ settings: {}, platform: {},
        env: { WE_TOOL_STALE_THRESHOLD: threshold } })).toThrow('Invalid staleToolGuard');
    }
  });

  it.each(['timeout', 'output overflow'])('refuses a fetch %s with an operator recovery path', async (reason) => {
    const { guardToolCheckout } = await load();
    const h = harness();
    h.exec.mockReturnValue({ status: null, error: new Error(reason), stdout: '',
      stderr: "cannot lock ref 'refs/remotes/origin/main': is at abc but expected def" });
    await expect(guardToolCheckout({ ...h, settings: { mode: 'reexec' } }))
      .rejects.toThrow('Update the tool checkout from origin/main and retry');
    expect(h.exec).toHaveBeenCalledTimes(1);
    const [, args, options] = h.exec.mock.calls[0];
    expect(args).toContain('fetch');
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(30_000);
    expect(options.maxBuffer).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(options.killSignal).toBe('SIGKILL');
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('refuses worktree cleanup failure instead of reporting a successful reexec', async () => {
    const { guardToolCheckout } = await load();
    const h = harness({ fail: 'worktree-remove' });
    await expect(guardToolCheckout({ ...h, settings: { mode: 'reexec' } })).rejects.toThrow('Git worktree');
    expect(nodeCalls(h)).toHaveLength(1);
    expect(removals(h)).toHaveLength(1);
  });

  it('parses static imports without following comments, quoted text or dynamic imports', async () => {
    const { importClosure } = await load();
    const root = scratch();
    put(root, 'entry.mjs', `// import './missing.mjs';
      const text = "import './also-missing.mjs'";
      const lazy = import('./lazy.mjs');
      export * from './real.mjs';`);
    put(root, 'real.mjs', '');
    expect([...await importClosure(join(root, 'entry.mjs'), { root })].sort())
      .toEqual(['entry.mjs', 'real.mjs']);
  });
});

describe('side-effect entry exit behavior', () => {
  it.each([undefined, 'true'])('refusal prevents sibling dependency side effects with VITEST=%s', (vitest) => {
    const root = scratch();
    const marker = join(root, 'sibling-ran');
    // Exercise the actual lane-pool bootstrap, including its dependency loading strategy.
    const source = readFileSync(join(ROOT, 'scripts/lane-pool.mjs'), 'utf8');
    put(root, 'scripts/lane-pool.mjs', source);
    put(root, 'scripts/lib/stale-tool-guard-entry.mjs',
      readFileSync(join(ROOT, 'scripts/lib/stale-tool-guard-entry.mjs'), 'utf8'));
    put(root, 'scripts/lib/stale-tool-guard.mjs', `export async function guardToolCheckout() {
      await new Promise(resolve => setImmediate(resolve));
      throw new Error('asynchronous fixture refusal');
    }`);
    const firstDependency = source.match(/(?:import|const) \{([^}]+)\}(?: from | = await import\()['"]\.\/lib\/lane-pool-recover\.mjs['"]/);
    expect(firstDependency).toBeTruthy();
    put(root, 'scripts/lib/lane-pool-recover.mjs', `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'stale side effect');
      ${firstDependency[1].split(',').map(name => `export const ${name.trim()} = undefined;`).join('\n')}`);
    const result = spawnSync(process.execPath, [join(root, 'scripts/lane-pool.mjs')], {
      env: { ...process.env, VITEST: vitest }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('asynchronous fixture refusal\n');
    expect(existsSync(marker)).toBe(false);
  });

  it('guard follows deferred bootstrap dependencies when deciding staleness', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    put(h.root, 'scripts/tool.mjs', "const { version } = await import('./lib/dep.mjs');");
    await expect(guardToolCheckout(h)).rejects.toThrow('stale tool checkout (6 behind)');
    expect(nodeCalls(h)).toHaveLength(0);
  });

  it('eager awaited imports include their recursive static dependencies', async () => {
    const { importClosure } = await load();
    const root = scratch();
    put(root, 'entry.mjs', "const { value } = await import('./dep.mjs'); await import('./side.mjs');");
    put(root, 'dep.mjs', "export { value } from './leaf.mjs';");
    put(root, 'leaf.mjs', 'export const value = 1;');
    put(root, 'side.mjs', "import './entry.mjs';");
    expect([...await importClosure(join(root, 'entry.mjs'), { root })].sort())
      .toEqual(['dep.mjs', 'entry.mjs', 'leaf.mjs', 'side.mjs']);
  });

  it.each(['continue', 'reexec', 'refuse'])('%s prevents stale tool continuation when appropriate', (action) => {
    const root = scratch();
    // Execute the actual entry source with a hermetic guard, never network Git IO.
    put(root, 'entry.mjs', readFileSync(join(ROOT, 'scripts/lib/stale-tool-guard-entry.mjs'), 'utf8'));
    put(root, 'stale-tool-guard.mjs', `export async function guardToolCheckout({ entry }) {
      if (entry !== process.argv[1]) throw new Error('wrong tool entry');
      ${action === 'continue' ? 'return;' : action === 'reexec' ? 'return 23;' : "throw new Error('fixture refusal');"}
    }`);
    put(root, 'tool.mjs', "import { guardToolEntry } from './entry.mjs'; await guardToolEntry(); console.log('tool continued');");
    const result = spawnSync(process.execPath, [join(root, 'tool.mjs')], {
      env: (({ VITEST, ...e }) => e)(process.env), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(action === 'continue' ? 0 : action === 'reexec' ? 23 : 1);
    expect(result.stdout).toBe(action === 'continue' ? 'tool continued\n' : '');
    expect(result.stderr).toBe(action === 'refuse' ? 'fixture refusal\n' : '');
  });
});
