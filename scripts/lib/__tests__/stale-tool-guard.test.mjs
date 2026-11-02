import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
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
        import pkg from 'external-package';
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
function harness({ behind = '6\n', changed = 'scripts/lib/dep.mjs\n', fail, throws = false, childStatus = 0 } = {}) {
  const root = scratch();
  mkdirSync(join(root, '.git'));
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
    expect(options.cwd).toBe(root);
    const operation = ['fetch', 'rev-list', 'diff', 'worktree'].find((name) => args.includes(name));
    const stage = operation === 'worktree' ? `worktree-${args[args.indexOf('worktree') + 1]}` : operation;
    if (stage === fail) {
      if (throws) throw new Error('fixture exec failure');
      return failure();
    }
    if (operation === 'fetch') return success();
    if (operation === 'rev-list') return success(behind);
    if (operation === 'diff') return success(changed);
    if (stage === 'worktree-add') {
      expect(args).toContain('--detach');
      expect(args).toContain('origin/main');
      worktree = args.slice(args.indexOf('add') + 1).find((arg) => !arg.startsWith('-') && arg !== 'origin/main');
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

  it('only the exact re-exec marker 1 bypasses all Git IO', async () => {
    const { guardToolCheckout } = await load();
    const h = harness();
    await guardToolCheckout({ ...h, env: { WE_TOOL_FRESH_REEXEC: '1' } });
    expect(h.exec).not.toHaveBeenCalled();
    for (const marker of ['0', 'true', '']) {
      await expect(async () => guardToolCheckout({ ...h, env: { WE_TOOL_FRESH_REEXEC: marker } }))
        .rejects.toThrow('stale tool checkout (6 behind)');
    }
  });

  it.each(['fetch', 'rev-list', 'diff'])('fails closed on a nonzero %s exit even in reexec mode', async (fail) => {
    const { guardToolCheckout } = await load();
    const h = harness({ fail });
    await expect(async () => guardToolCheckout({ ...h, settings: { mode: 'reexec' } })).rejects.toThrow();
    expect(nodeCalls(h)).toHaveLength(0);
  });

  it.each(['fetch', 'rev-list', 'diff'])('fails closed when %s throws', async (fail) => {
    const { guardToolCheckout } = await load();
    await expect(async () => guardToolCheckout(harness({ fail, throws: true }))).rejects.toThrow();
  });

  it.each(['', 'garbage\n', '-1\n', '1.5\n', '9007199254740992\n', '6junk\n'])
    ('refuses unknown/oversized rev-list output %j even for unrelated changes', async (behind) => {
      const { guardToolCheckout } = await load();
      await expect(async () => guardToolCheckout(harness({ behind, changed: 'docs/unrelated.md\n' })))
        .rejects.toThrow();
    });

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
  it.each(['scripts/lib/dep.mjs', 'docs/unrelated.md'])('six upstream commits touching %s use real ancestry and diff evidence', async (changedPath) => {
    const { guardToolCheckout } = await load();
    const base = scratch();
    const writer = join(base, 'writer');
    const origin = join(base, 'origin.git');
    const checkout = join(base, 'checkout');
    mkdirSync(writer);
    function git(cwd, ...args) {
      if (args.includes('fetch') || args.includes('push')) throw new Error('Fixture forbids fetch/push');
      const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
        cwd, encoding: 'utf8', maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error));
      return result;
    }
    git(writer, 'init', '-b', 'main');
    put(writer, 'scripts/tool.mjs', "import './lib/dep.mjs';");
    put(writer, 'scripts/lib/dep.mjs', 'export const version = 0;');
    git(writer, 'add', '.');
    git(writer, 'commit', '-m', 'base');
    // Shared local object stores and update-ref model upstream publication without fetch/push.
    git(base, 'clone', '--bare', '--shared', writer, origin);
    git(base, 'clone', '--shared', origin, checkout);
    for (let version = 1; version <= 6; version++) {
      put(writer, changedPath, `// version ${version}\n`);
      git(writer, 'add', '.');
      git(writer, 'commit', '-m', `upstream ${version}`);
    }
    const tip = git(writer, 'rev-parse', 'HEAD').stdout.trim();
    git(origin, 'update-ref', 'refs/heads/main', tip);
    const exec = vi.fn((command, args, options) => {
      expect(command).toBe('git');
      expect(options.cwd).toBe(checkout);
      if (args.includes('fetch')) return git(checkout, 'update-ref', 'refs/remotes/origin/main', tip);
      return git(options.cwd, ...args);
    });
    const run = () => guardToolCheckout({ root: checkout, entry: join(checkout, 'scripts/tool.mjs'), exec, env: {} });
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
  it('imports the separate guard side-effect entry before every other import', () => {
    const source = readFileSync(join(ROOT, 'scripts/lane-pool.mjs'), 'utf8');
    const imports = source.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line));
    expect(imports[0]).toMatch(/^import\s+['"]\.\/lib\/stale-tool-guard-entry\.mjs['"];?\s*$/);
    expect(imports).not.toContain("import './lib/stale-tool-guard.mjs';");
  });
});
