/** Preparation contract tests: injected execFn, real disposable files, no CLI/model spawn. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildHistorySurgeryCloneArgv,
  buildHistorySurgeryCommands,
  buildIsolationCloneArgv,
  buildNativeDenyCodexArgs,
  createConfigOverrideIsolationProvider,
  createMacosDeletionIsolationProvider,
  createNativeDenyWithHistoryStripIsolationProvider,
  normalizeExcludePaths,
} from '../isolation-provider.mjs';

const execFileAsync = promisify(execFile);

let root, source, scratch;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'we-isolation-test-')));
  source = join(root, 'source with spaces');
  scratch = join(root, 'scratch');
  await mkdir(source);
  await mkdir(scratch);
  await writeFile(join(source, 'AGENTS.md'), 'source doctrine');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function executor(prepare = async (cwd) => { await writeFile(join(cwd, 'AGENTS.md'), 'clone doctrine'); }) {
  return vi.fn(async (_file, argv) => {
    const cwd = argv.at(-1);
    await mkdir(cwd);
    await writeFile(join(cwd, 'work.txt'), 'work');
    await prepare(cwd);
  });
}

describe('IsolationProvider preparation contract', () => {
  it('keeps metacharacters in single argv entries with an option boundary', () => {
    const from = join(root, '$(touch nope); repo');
    const to = join(root, 'clone `whoami`');
    expect(buildIsolationCloneArgv(from, to)).toEqual(['clone', '--quiet', '--no-hardlinks', '--', from, to]);
  });

  it.each(['relative', '', '--upload-pack=bad', 'https://example.com/repo', '/bad\0path', null])(
    'rejects invalid source paths before exec or allocation: %s', async (sourceCwd) => {
      const execFn = executor();
      await expect(createMacosDeletionIsolationProvider({ execFn })({ sourceCwd, scratchParent: scratch }))
        .rejects.toThrow(/absolute local path/);
      expect(execFn).not.toHaveBeenCalled();
      expect(await readdir(scratch)).toEqual([]);
    },
  );

  it('rejects a relative scratch parent before exec', async () => {
    const execFn = executor();
    await expect(createMacosDeletionIsolationProvider({ execFn })({ sourceCwd: source, scratchParent: '.' }))
      .rejects.toThrow(/absolute local path/);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('awaits clone completion, excludes doctrine before handoff, preserves source and cleans edits', async () => {
    const execFn = executor(async (cwd) => {
      await Promise.resolve();
      await writeFile(join(cwd, 'AGENTS.md'), 'delayed doctrine');
    });
    const outcome = await createMacosDeletionIsolationProvider({ execFn })({ sourceCwd: source, scratchParent: scratch });
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledWith('git', buildIsolationCloneArgv(source, outcome.cwd), {
      cwd: scratch, encoding: 'utf8', shell: false,
    });
    expect(outcome.guarantee).toBe('root-agents-absent-before-start');
    expect(outcome.excludedPaths).toEqual(['AGENTS.md']);
    expect(outcome.extraCliArgs).toEqual([]);
    await expect(lstat(join(outcome.cwd, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('source doctrine');
    expect(await readFile(join(outcome.cwd, 'work.txt'), 'utf8')).toBe('work');
    await writeFile(join(outcome.cwd, 'proof.txt'), 'tool work');
    await outcome.cleanup();
    await outcome.cleanup();
    expect(await readdir(scratch)).toEqual([]);
    expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('source doctrine');
  });

  it('accepts an already absent root AGENTS.md, while leaving other instruction sources alone', async () => {
    const execFn = executor(async (cwd) => {
      await mkdir(join(cwd, 'nested'));
      await writeFile(join(cwd, 'nested', 'AGENTS.md'), 'nested');
      await writeFile(join(cwd, 'AGENTS.override.md'), 'override');
    });
    const outcome = await createMacosDeletionIsolationProvider({ execFn })({ sourceCwd: source, scratchParent: scratch });
    expect(await readFile(join(outcome.cwd, 'nested', 'AGENTS.md'), 'utf8')).toBe('nested');
    expect(await readFile(join(outcome.cwd, 'AGENTS.override.md'), 'utf8')).toBe('override');
    await outcome.cleanup();
  });

  it('unlinks an AGENTS.md symlink without deleting its target', async () => {
    const execFn = executor(async (cwd) => { await symlink(join(source, 'AGENTS.md'), join(cwd, 'AGENTS.md')); });
    const outcome = await createMacosDeletionIsolationProvider({ execFn })({ sourceCwd: source, scratchParent: scratch });
    await expect(lstat(join(outcome.cwd, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('source doctrine');
    await outcome.cleanup();
  });

  it('surfaces a clone failure and removes partial scratch material', async () => {
    const failure = new Error('git clone failed');
    const execFn = executor(async () => { throw failure; });
    await expect(createMacosDeletionIsolationProvider({ execFn })({ sourceCwd: source, scratchParent: scratch }))
      .rejects.toBe(failure);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('fails closed and cleans up when AGENTS.md is a directory', async () => {
    const execFn = executor(async (cwd) => { await mkdir(join(cwd, 'AGENTS.md')); });
    await expect(createMacosDeletionIsolationProvider({ execFn })({ sourceCwd: source, scratchParent: scratch }))
      .rejects.toThrow();
    expect(await readdir(scratch)).toEqual([]);
  });

  it('rejects executor success without a clone instead of returning a nonexistent cwd', async () => {
    await expect(createMacosDeletionIsolationProvider({ execFn: vi.fn(async () => {}) })({
      sourceCwd: source, scratchParent: scratch,
    })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('allocates independent clones and cleanup cannot remove another outcome', async () => {
    const provider = createMacosDeletionIsolationProvider({ execFn: executor() });
    const request = { sourceCwd: source, scratchParent: scratch };
    const [first, second] = await Promise.all([provider(request), provider(request)]);
    expect(first.cwd).not.toBe(second.cwd);
    await first.cleanup();
    expect(await readFile(join(second.cwd, 'work.txt'), 'utf8')).toBe('work');
    await second.cleanup();
    expect(await readdir(scratch)).toEqual([]);
  });

  // #3371 follow-up: excludePaths is a REQUEST field, not a hardcoded 'AGENTS.md' literal, so this
  // same backend serves a different repo's own doctrine-file convention (or more than one file).
  it('defaults to AGENTS.md when the request omits excludePaths (backward compatible)', async () => {
    const execFn = executor(async (cwd) => { await writeFile(join(cwd, 'AGENTS.md'), 'clone doctrine'); });
    const outcome = await createMacosDeletionIsolationProvider({ execFn })({
      sourceCwd: source, scratchParent: scratch,
    });
    expect(outcome.excludedPaths).toEqual(['AGENTS.md']);
    await outcome.cleanup();
  });

  it('removes a request-level excludePaths list instead of the AGENTS.md default', async () => {
    const execFn = executor(async (cwd) => {
      await writeFile(join(cwd, 'CLAUDE.md'), 'clone doctrine');
      await mkdir(join(cwd, '.github'));
      await writeFile(join(cwd, '.github', 'copilot-instructions.md'), 'clone doctrine');
      // AGENTS.md is deliberately absent here — this repo's own convention is CLAUDE.md instead.
    });
    const outcome = await createMacosDeletionIsolationProvider({ execFn })({
      sourceCwd: source, scratchParent: scratch,
      excludePaths: ['CLAUDE.md', '.github/copilot-instructions.md'],
    });
    await expect(lstat(join(outcome.cwd, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(outcome.cwd, '.github', 'copilot-instructions.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(outcome.excludedPaths).toEqual(['CLAUDE.md', '.github/copilot-instructions.md']);
    await outcome.cleanup();
  });

  it('a factory-level defaultExcludePaths is used only when the request omits the field', async () => {
    const execFn = executor(async (cwd) => { await writeFile(join(cwd, 'CLAUDE.md'), 'clone doctrine'); });
    const provider = createMacosDeletionIsolationProvider({ execFn, defaultExcludePaths: ['CLAUDE.md'] });
    const outcome = await provider({ sourceCwd: source, scratchParent: scratch });
    expect(outcome.excludedPaths).toEqual(['CLAUDE.md']);
    await expect(lstat(join(outcome.cwd, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await outcome.cleanup();
  });

  it('rejects an invalid excludePaths before any exec', async () => {
    const execFn = executor();
    await expect(createMacosDeletionIsolationProvider({ execFn })({
      sourceCwd: source, scratchParent: scratch, excludePaths: [],
    })).rejects.toThrow(/non-empty array/);
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe('normalizeExcludePaths', () => {
  it('defaults to AGENTS.md when excludePaths is undefined', () => {
    expect(normalizeExcludePaths(undefined)).toEqual(['AGENTS.md']);
  });

  it('honors a caller-supplied fallback when excludePaths is undefined', () => {
    expect(normalizeExcludePaths(undefined, ['CLAUDE.md'])).toEqual(['CLAUDE.md']);
  });

  it('passes through an explicit list, ignoring the fallback', () => {
    expect(normalizeExcludePaths(['a.md', 'b/c.md'], ['CLAUDE.md'])).toEqual(['a.md', 'b/c.md']);
  });

  it.each([[], null, ['', 'ok'], ['/absolute'], [null], ['has\0nul']])(
    'rejects invalid excludePaths: %j', (excludePaths) => {
      expect(() => normalizeExcludePaths(excludePaths)).toThrow();
    },
  );
});

// #3371 Probe 14 — the real fix. Pure argv builders first (zero cost), then the injected-execFn
// preparation contract (mirrors the deletion-provider tests above), then a REAL git-surgery
// integration check with no injection at all: a genuine repo, a genuine clone, a genuine
// exhaustive object scan — the same bar Probe 14e itself proved against ("0/8252 objects").

describe('buildHistorySurgeryCloneArgv', () => {
  it('uses a file:// URL (not a bare path) and --depth 1, matching Probe 14e', () => {
    const from = join(root, 'source with spaces');
    const to = join(root, 'dest clone');
    expect(buildHistorySurgeryCloneArgv(from, to)).toEqual([
      'clone', '--quiet', '--depth', '1', '--no-hardlinks', '--', pathToFileURL(from).href, to,
    ]);
  });

  it.each(['relative', '', '/bad\0path', null])(
    'rejects invalid source paths: %s', (sourceCwd) => {
      expect(() => buildHistorySurgeryCloneArgv(sourceCwd, join(root, 'dest'))).toThrow(/absolute local path/);
    },
  );

  it('rejects an invalid destination', () => {
    expect(() => buildHistorySurgeryCloneArgv(source, '.')).toThrow(/absolute local path/);
  });
});

describe('buildHistorySurgeryCommands', () => {
  it('returns the exact ordered recipe from Probe 14e', () => {
    expect(buildHistorySurgeryCommands(['AGENTS.md'])).toEqual([
      ['remote', 'remove', 'origin'],
      ['rm', '--quiet', '--', 'AGENTS.md'],
      ['-c', 'user.name=we-isolation', '-c', 'user.email=isolation@localhost',
        'commit', '--quiet', '--amend', '--no-edit'],
      ['reflog', 'expire', '--expire=now', '--all'],
      ['repack', '-a', '-d', '-f', '-q'],
      ['prune'],
    ]);
  });

  it('removes origin before amending, and repacks with -f rather than a plain gc', () => {
    const commands = buildHistorySurgeryCommands(['AGENTS.md']);
    const removeOriginIndex = commands.findIndex((c) => c[0] === 'remote');
    const amendIndex = commands.findIndex((c) => c.includes('--amend'));
    const repackIndex = commands.findIndex((c) => c[0] === 'repack');
    expect(removeOriginIndex).toBeLessThan(amendIndex);
    expect(commands[repackIndex]).toContain('-f');
    expect(commands.some((c) => c[0] === 'gc')).toBe(false);
  });

  it('supports multiple target paths in one rm', () => {
    const commands = buildHistorySurgeryCommands(['AGENTS.md', 'docs/agent/AGENTS.local.md']);
    expect(commands[1]).toEqual(['rm', '--quiet', '--', 'AGENTS.md', 'docs/agent/AGENTS.local.md']);
  });

  it.each([[], null, ['', 'ok'], ['/absolute'], [null]])(
    'rejects invalid targetPaths: %j', (targetPaths) => {
      expect(() => buildHistorySurgeryCommands(targetPaths)).toThrow();
    },
  );
});

describe('buildNativeDenyCodexArgs', () => {
  it('combines the deny permission map with default_permissions=locked and project_doc_max_bytes=0', () => {
    const args = buildNativeDenyCodexArgs(['/**/AGENTS.md', '/Users/x/repo', '/Users/x/repo/**']);
    expect(args).toEqual([
      '--strict-config',
      '-c', 'permissions={locked={extends=":workspace",filesystem={' +
        '"/**/AGENTS.md"="deny","/Users/x/repo"="deny","/Users/x/repo/**"="deny"}}}',
      '-c', 'default_permissions=locked',
      '-c', 'project_doc_max_bytes=0',
    ]);
  });

  it('4443: writableRoots add only write entries after the denies; omitted/empty leaves the argv unchanged', () => {
    const base = buildNativeDenyCodexArgs(['/deny/x']);
    expect(buildNativeDenyCodexArgs(['/deny/x'], { writableRoots: [] })).toEqual(base);
    const args = buildNativeDenyCodexArgs(['/deny/x'], { writableRoots: ['/we/lane 1', '/we/lane-2'] });
    expect(args[2]).toBe(
      'permissions={locked={extends=":workspace",filesystem={"/deny/x"="deny","/we/lane 1"="write","/we/lane-2"="write"}}}',
    );
    expect(args).not.toContain('-s');
  });

  it('always includes project_doc_max_bytes=0, per Probe 14f (mandatory alongside the deny)', () => {
    const args = buildNativeDenyCodexArgs(['/one/path']);
    expect(args).toContain('project_doc_max_bytes=0');
    expect(args).toContain('default_permissions=locked');
    expect(args[0]).toBe('--strict-config');
  });

  it('never emits an -s/--sandbox flag — a caller-added one silently overrides default_permissions', () => {
    // Measured live (this backend's own real re-verification of Probe 14, codex-cli 0.153.4): a
    // real `codex exec` run with `-s workspace-write` (and, separately, `-s danger-full-access`)
    // ADDED alongside this config read a denied path's content successfully — the deny had zero
    // effect. Omitting `-s` entirely (letting `default_permissions=locked` govern the sandbox on
    // its own) was the run where the same session genuinely declined the same reads. So this
    // builder must never emit `-s`/`--sandbox` itself, and a caller must not add one either.
    const args = buildNativeDenyCodexArgs(['/one/path']);
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--sandbox');
  });

  it.each([[], null, undefined])('rejects an empty/missing denyPaths: %j', (denyPaths) => {
    expect(() => buildNativeDenyCodexArgs(denyPaths)).toThrow(/non-empty array/);
  });

  it.each(['', 'has "quote"', null, 'has\0nul'])('rejects an invalid deny path entry: %j', (badPath) => {
    expect(() => buildNativeDenyCodexArgs(['/ok', badPath])).toThrow();
  });
});

describe('createNativeDenyWithHistoryStripIsolationProvider (injected execFn)', () => {
  function historyExecutor() {
    const calls = [];
    const execFn = vi.fn(async (_file, argv, options) => {
      calls.push({ argv, cwd: options.cwd });
      if (argv[0] === 'clone') {
        const cwd = argv.at(-1);
        await mkdir(cwd);
        await writeFile(join(cwd, 'AGENTS.md'), 'source doctrine');
      }
    });
    return { execFn, calls };
  }

  it('clones then runs the surgery commands in order, all against the clone cwd', async () => {
    const { execFn, calls } = historyExecutor();
    const provider = createNativeDenyWithHistoryStripIsolationProvider({ execFn });
    const outcome = await provider({ sourceCwd: source, scratchParent: scratch });

    expect(calls[0].argv).toEqual(buildHistorySurgeryCloneArgv(source, outcome.cwd));
    expect(calls[0].cwd).toBe(scratch);
    const surgery = buildHistorySurgeryCommands(['AGENTS.md']);
    expect(calls.slice(1).map((c) => c.argv)).toEqual(surgery);
    for (const call of calls.slice(1)) expect(call.cwd).toBe(outcome.cwd);

    expect(outcome.guarantee).toBe('history-stripped-before-start');
    expect(outcome.excludedPaths).toEqual(['AGENTS.md']);
    expect(outcome.extraCliArgs).toEqual(
      buildNativeDenyCodexArgs(['/**/AGENTS.md', source, `${source}/**`]),
    );
    await outcome.cleanup();
    expect(await readdir(scratch)).toEqual([]);
  });

  it('folds extraDenyPaths and a factory-level defaultExcludePaths into extraCliArgs and the rm list', async () => {
    const { execFn, calls } = historyExecutor();
    const provider = createNativeDenyWithHistoryStripIsolationProvider({
      execFn, defaultExcludePaths: ['AGENTS.md', 'nested/AGENTS.md'], extraDenyPaths: ['/other/tree'],
    });
    const outcome = await provider({ sourceCwd: source, scratchParent: scratch });
    const rmCall = calls.find((c) => c.argv[0] === 'rm');
    expect(rmCall.argv).toEqual(['rm', '--quiet', '--', 'AGENTS.md', 'nested/AGENTS.md']);
    expect(outcome.extraCliArgs).toEqual(buildNativeDenyCodexArgs([
      '/**/AGENTS.md', '/**/nested/AGENTS.md', source, `${source}/**`, '/other/tree',
    ]));
    await outcome.cleanup();
  });

  it('a REQUEST-level excludePaths overrides the factory default (a different repo convention)', async () => {
    const { execFn, calls } = historyExecutor();
    // The factory was built with the AGENTS.md default; this call is for a repo whose doctrine
    // file is CLAUDE.md instead — proving one factory instance serves both conventions.
    const provider = createNativeDenyWithHistoryStripIsolationProvider({ execFn });
    const outcome = await provider({
      sourceCwd: source, scratchParent: scratch, excludePaths: ['CLAUDE.md'],
    });
    const rmCall = calls.find((c) => c.argv[0] === 'rm');
    expect(rmCall.argv).toEqual(['rm', '--quiet', '--', 'CLAUDE.md']);
    expect(outcome.excludedPaths).toEqual(['CLAUDE.md']);
    expect(outcome.extraCliArgs).toEqual(
      buildNativeDenyCodexArgs(['/**/CLAUDE.md', source, `${source}/**`]),
    );
    await outcome.cleanup();
  });

  it('a request excludePaths list can also strip more than one doctrine file at once', async () => {
    const { execFn, calls } = historyExecutor();
    const provider = createNativeDenyWithHistoryStripIsolationProvider({ execFn });
    const outcome = await provider({
      sourceCwd: source, scratchParent: scratch,
      excludePaths: ['AGENTS.md', '.github/copilot-instructions.md'],
    });
    const rmCall = calls.find((c) => c.argv[0] === 'rm');
    expect(rmCall.argv).toEqual(['rm', '--quiet', '--', 'AGENTS.md', '.github/copilot-instructions.md']);
    expect(outcome.excludedPaths).toEqual(['AGENTS.md', '.github/copilot-instructions.md']);
    await outcome.cleanup();
  });

  it('rejects an invalid request-level excludePaths before any exec', async () => {
    const { execFn } = historyExecutor();
    await expect(createNativeDenyWithHistoryStripIsolationProvider({ execFn })({
      sourceCwd: source, scratchParent: scratch, excludePaths: ['/absolute/not/allowed'],
    })).rejects.toThrow(/repo-relative path/);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('rejects invalid inputs before any exec, same as the deletion provider', async () => {
    const { execFn } = historyExecutor();
    await expect(createNativeDenyWithHistoryStripIsolationProvider({ execFn })({
      sourceCwd: 'relative', scratchParent: scratch,
    })).rejects.toThrow(/absolute local path/);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('surfaces a clone failure and removes partial scratch material', async () => {
    const failure = new Error('git clone failed');
    const execFn = vi.fn(async () => { throw failure; });
    await expect(createNativeDenyWithHistoryStripIsolationProvider({ execFn })({
      sourceCwd: source, scratchParent: scratch,
    })).rejects.toBe(failure);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('surfaces a mid-surgery failure (e.g. the amend) and still cleans up', async () => {
    const { execFn } = historyExecutor();
    const failure = new Error('amend failed: nothing to commit');
    execFn.mockImplementation(async (_file, argv, options) => {
      if (argv[0] === 'clone') {
        const cwd = argv.at(-1);
        await mkdir(cwd);
        return undefined;
      }
      if (argv.includes('--amend')) throw failure;
      return undefined;
    });
    await expect(createNativeDenyWithHistoryStripIsolationProvider({ execFn })({
      sourceCwd: source, scratchParent: scratch,
    })).rejects.toBe(failure);
    expect(await readdir(scratch)).toEqual([]);
  });
});

describe('createNativeDenyWithHistoryStripIsolationProvider — REAL git surgery (#3371 Probe 14e)', () => {
  const MARKER = 'PROBE14-CANARY-c9f1a3';
  let realSource, realScratch;

  async function realGit(dir, args, options = {}) {
    return execFileAsync('git', args, { cwd: dir, encoding: 'utf8', ...options });
  }

  /** Exhaustive scan, mirroring Probe 14e's "0 hits across all 8252 objects" check: decode EVERY
   *  object in the packfile/loose-object database and search blob content directly — never trust
   *  the working tree or a single `git show`. */
  async function scanAllBlobsForMarker(repoDir, needle) {
    // One process decodes the entire database, avoiding a process spawn per blob
    // under shard load. Parse byte lengths: tree objects contain binary data.
    const { stdout } = await realGit(repoDir, ['cat-file', '--batch-all-objects', '--batch'],
      { encoding: 'buffer', maxBuffer: 8 << 20 });
    const marker = Buffer.from(needle);
    let hits = 0, totalObjects = 0, offset = 0;
    while (offset < stdout.length) {
      const headerEnd = stdout.indexOf(10, offset);
      expect(headerEnd).toBeGreaterThanOrEqual(offset);
      const header = /^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(stdout.toString('ascii', offset, headerEnd));
      expect(header).not.toBeNull();
      const contentStart = headerEnd + 1, contentEnd = contentStart + Number(header[3]);
      expect(contentEnd).toBeLessThan(stdout.length);
      expect(stdout[contentEnd]).toBe(10);
      if (header[2] === 'blob' && stdout.subarray(contentStart, contentEnd).includes(marker)) hits++;
      totalObjects++;
      offset = contentEnd + 1;
    }
    return { totalObjects, hits };
  }

  beforeEach(async () => {
    realSource = join(root, 'real-source-repo');
    realScratch = join(root, 'real-scratch');
    await mkdir(realSource);
    await mkdir(realScratch);
    await realGit(realSource, ['init', '--quiet']);
    await writeFile(join(realSource, 'AGENTS.md'), `# doctrine — UTF-8 byte lengths\n${MARKER}\n`);
    await writeFile(join(realSource, 'other.txt'), 'unrelated file, must survive');
    await realGit(realSource, ['add', '-A']);
    await realGit(realSource, [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '-m', 'initial commit with doctrine',
    ]);
    // A second commit, so history is non-trivial before the --depth 1 clone collapses it.
    await writeFile(join(realSource, 'other.txt'), 'unrelated file, changed');
    await realGit(realSource, ['add', '-A']);
    await realGit(realSource, [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '-m', 'second commit',
    ]);
  });

  it('control: the marker IS present in the untouched source repo (proves the test is not vacuous)', async () => {
    const { totalObjects, hits } = await scanAllBlobsForMarker(realSource, MARKER);
    expect(totalObjects).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
  });

  it('strips the file from every object in the packfile, not just the working tree', async () => {
    const provider = createNativeDenyWithHistoryStripIsolationProvider();
    const outcome = await provider({ sourceCwd: realSource, scratchParent: realScratch });
    try {
      // Working tree: absent.
      await expect(readFile(join(outcome.cwd, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      // Unrelated file survived the surgery.
      expect(await readFile(join(outcome.cwd, 'other.txt'), 'utf8')).toBe('unrelated file, changed');
      // No signpost: git status is clean (the exact defect Probe 14a found in plain deletion).
      const status = await realGit(outcome.cwd, ['status', '--porcelain']);
      expect(status.stdout.trim()).toBe('');
      // HEAD, HEAD's history, and the removed origin ref all fail to produce the file.
      await expect(realGit(outcome.cwd, ['show', 'HEAD:AGENTS.md'])).rejects.toThrow();
      const log = await realGit(outcome.cwd, ['log', '--all', '--', 'AGENTS.md']);
      expect(log.stdout.trim()).toBe('');
      await expect(realGit(outcome.cwd, ['show', 'origin/main:AGENTS.md'])).rejects.toThrow();
      // The exhaustive check: every object in the database, decoded and searched — Probe 14e's own bar.
      const { totalObjects, hits } = await scanAllBlobsForMarker(outcome.cwd, MARKER);
      expect(totalObjects).toBeGreaterThan(0);
      expect(hits).toBe(0);
      // The Codex argv fragment is present and denies both the file glob and the source tree.
      expect(outcome.extraCliArgs.join(' ')).toContain('/**/AGENTS.md');
      expect(outcome.extraCliArgs.join(' ')).toContain(realSource);
      expect(outcome.extraCliArgs).toContain('project_doc_max_bytes=0');
    } finally {
      await outcome.cleanup();
    }
  }, 20_000);

  it('never mutates the real source repo', async () => {
    const before = await scanAllBlobsForMarker(realSource, MARKER);
    const provider = createNativeDenyWithHistoryStripIsolationProvider();
    const outcome = await provider({ sourceCwd: realSource, scratchParent: realScratch });
    await outcome.cleanup();
    expect(await readFile(join(realSource, 'AGENTS.md'), 'utf8')).toContain(MARKER);
    const after = await scanAllBlobsForMarker(realSource, MARKER);
    expect(after).toEqual(before);
  }, 20_000);
});

describe('createConfigOverrideIsolationProvider (#3371 Probe 12)', () => {
  it.each(['relative', '', '--upload-pack=bad', 'https://example.com/repo', '/bad\0path', null])(
    'rejects an invalid source path before any work: %s', async (sourceCwd) => {
      await expect(createConfigOverrideIsolationProvider()({ sourceCwd })).rejects.toThrow(/absolute local path/);
    },
  );

  it('returns the realpath of sourceCwd unchanged — no clone, no scratch directory touched', async () => {
    const outcome = await createConfigOverrideIsolationProvider()({ sourceCwd: source, scratchParent: scratch });
    expect(outcome.cwd).toBe(await realpath(source));
    expect(await readdir(scratch)).toEqual([]);
  });

  it('ignores scratchParent entirely — works with none given at all', async () => {
    const outcome = await createConfigOverrideIsolationProvider()({ sourceCwd: source });
    expect(outcome.cwd).toBe(await realpath(source));
  });

  it('carries the config-override argv the caller must append, not a filesystem exclusion', async () => {
    const outcome = await createConfigOverrideIsolationProvider()({ sourceCwd: source });
    expect(outcome.extraCliArgs).toEqual(['-c', 'project_doc_max_bytes=0']);
    expect(outcome.excludedPaths).toEqual([]);
    expect(outcome.guarantee).toBe('root-agents-doc-suppressed-in-cli-context');
  });

  it('never touches AGENTS.md on disk — the file a deliberate read would still recover', async () => {
    await createConfigOverrideIsolationProvider()({ sourceCwd: source });
    expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('source doctrine');
  });

  it('cleanup is a no-op safe to call repeatedly, since nothing was ever allocated', async () => {
    const outcome = await createConfigOverrideIsolationProvider()({ sourceCwd: source });
    await expect(outcome.cleanup()).resolves.toBeUndefined();
    await expect(outcome.cleanup()).resolves.toBeUndefined();
    expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('source doctrine');
  });

  it('rejects a missing source directory instead of returning an unreal cwd', async () => {
    await expect(createConfigOverrideIsolationProvider()({ sourceCwd: join(root, 'does-not-exist') }))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  // #3371 follow-up: excludePaths is accepted for interface symmetry with the other two backends,
  // but this backend's guarantee comes from a CLI flag that suppresses whatever doc Codex's own
  // auto-loader resolves — there is no per-filename behavior for excludePaths to change here.
  it('validates a request-level excludePaths the same way as the other backends, but it has no effect', async () => {
    const outcome = await createConfigOverrideIsolationProvider()({
      sourceCwd: source, excludePaths: ['CLAUDE.md', '.github/copilot-instructions.md'],
    });
    expect(outcome.extraCliArgs).toEqual(['-c', 'project_doc_max_bytes=0']);
    expect(outcome.excludedPaths).toEqual([]);
    expect(outcome.guarantee).toBe('root-agents-doc-suppressed-in-cli-context');
    // Still on disk — excludePaths never made this backend touch the filesystem.
    expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('source doctrine');
  });

  it('rejects an invalid request-level excludePaths, same fail-loud rule as the other backends', async () => {
    await expect(createConfigOverrideIsolationProvider()({ sourceCwd: source, excludePaths: [] }))
      .rejects.toThrow(/non-empty array/);
    await expect(createConfigOverrideIsolationProvider()({ sourceCwd: source, excludePaths: ['/absolute'] }))
      .rejects.toThrow(/repo-relative path/);
  });

  it('a factory-level defaultExcludePaths is validated too, though never read', async () => {
    const provider = createConfigOverrideIsolationProvider({ defaultExcludePaths: ['CLAUDE.md'] });
    const outcome = await provider({ sourceCwd: source });
    expect(outcome.extraCliArgs).toEqual(['-c', 'project_doc_max_bytes=0']);
  });
});
