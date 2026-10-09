/**
 * @file run.test.mjs — the REAL `run.mjs dispatch-lane` CLI refuses a stale checkout (#4329, the prevention
 * guard owed by web-everything/web-everything#2815's review).
 *
 * `dispatch-path-isolation-and-executor.test.mjs` proves `cliPreflight` with injected `arm`/`assertFresh`, so
 * deleting the `cliPreflight(name)` call from `run.mjs`'s CLI block broke no test. This runs the actual CLI as a
 * child process against a real stale checkout (real git, real origin), so that wiring is pinned.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withBareOrigin, withNarrowClone } from './helpers/real-repo.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOP_FILES = ['package.json'];
// `schemas` is read by path at import by operations/worker-result.mjs (prep-review → review daemon).
const TREES = ['scripts', 'skills-src', 'schemas'];

/** Copy the parts of this repo the CLI imports into the fixture clone, commit on main and push. */
function seedCheckout(ctx) {
  // Copying the scripts tree can trigger Git's background housekeeping while teardown removes .git.
  // Keep this fixture synchronous; the preflight assertions still exercise the real CLI and real Git.
  ctx.git(['config', 'gc.auto', '0']);
  ctx.git(['config', 'maintenance.auto', 'false']);
  for (const tree of TREES) {
    if (!existsSync(join(REPO, tree))) continue;
    cpSync(join(REPO, tree), join(ctx.clone, tree), {
      recursive: true,
      filter: (src) => !/(^|\/)(__tests__|node_modules)(\/|$)/.test(src.slice(REPO.length)),
    });
  }
  for (const f of TOP_FILES) if (existsSync(join(REPO, f))) cpSync(join(REPO, f), join(ctx.clone, f));
  writeFileSync(join(ctx.clone, '.gitignore'), 'node_modules\n');
  symlinkSync(join(REPO, 'node_modules'), join(ctx.clone, 'node_modules'));
  ctx.git(['add', '-A']);
  ctx.git(['commit', '--quiet', '-m', 'fixture: repo tree']);
  ctx.git(['push', '--quiet', 'origin', 'main']);
  return ctx.git(['rev-parse', 'HEAD']).trim();
}

/** Run the real CLI from the fixture clone, with run/call stores redirected into the fixture. */
function runCli(ctx, args, env = {}) {
  const runsDir = join(ctx.tmp, 'runs');
  const callsDir = join(ctx.tmp, 'calls');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(callsDir, { recursive: true });
  const r = spawnSync(process.execPath, [join(ctx.clone, 'scripts/operations/run.mjs'), ...args], {
    cwd: ctx.clone,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, WE_OPERATION_ALLOW_STALE: '', WE_DAEMON_MANAGED_CLONE: '', LANE_POOL_ROOT: join(ctx.tmp, 'pool'), OPERATION_RUNS_DIR: runsDir, OPERATION_CALLS_DIR: callsDir, ...env },
  });
  const records = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', records, calls: readdirSync(callsDir) };
}

describe('run.mjs dispatch-lane CLI preflight (real child process, real git)', () => {
  it('a fresh checkout on main is not refused by the preflight', async () => {
    await withBareOrigin(async (ctx) => {
      seedCheckout(ctx);
      const r = runCli(ctx, ['dispatch-lane', '--help']);
      expect(r.stderr + r.stdout).not.toMatch(/refusing to dispatch/i);
      expect(r.status).toBe(0);
      expect(r.records).toEqual([]);
    });
  }, 120_000);

  it('dispatch-lane CLI refuses a stale checkout and writes no run record', async () => {
    await withBareOrigin(async (ctx) => {
      const first = seedCheckout(ctx);
      // origin/main moves a CODE file past the checkout under test.
      ctx.seedOriginBranch('main', { 'scripts/stale-fixture.mjs': 'export const moved = true;\n' });
      ctx.git(['fetch', '--quiet', 'origin']);
      // The #3604 case: a DETACHED HEAD at the first commit.
      ctx.git(['checkout', '--quiet', '--detach', first]);

      const r = runCli(ctx, ['dispatch-lane', '--num=1']);
      expect(r.stderr).toMatch(/refusing to dispatch|stale/i);
      expect(r.status).toBe(1);
      expect(r.records).toEqual([]);
    });
  }, 120_000);
});

// Item activity uses the real registration/parser/envelope, with external reads injected.
import { resolveOperation } from '../run.mjs';
import { itemActivityOperation } from '../item-activity.mjs';
import { createItemActivityReader } from '../item-activity-io.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { runOperationCli } from '../cli-adapter.mjs';

describe('item-activity CLI', () => {
  it('is registered without effect sinks', () => {
    const { declaration, sinks } = resolveOperation('item-activity');
    expect(declaration.name).toBe('item-activity');
    expect(isReadOnlyOperation(declaration)).toBe(true);
    expect(sinks).toEqual({});
  });
  it('the real CLI can query read-only evidence stores without writing a cursor', () => {
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/operations/run.mjs'), 'item-activity', '--pr=0', '--json'], {
      cwd: REPO, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OPERATION_RUNS_DIR: '/dev/null/item-activity-forbidden', OPERATION_CALLS_DIR: '/dev/null/item-activity-forbidden' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('pr must be a positive integer');
    expect(result.stdout + result.stderr).not.toMatch(/ENOTDIR|EPERM|EACCES/);
  });
  async function query(argv, options = {}) {
    const declaration = itemActivityOperation({ readActivity: createItemActivityReader({
      readSources: () => ({ rows: [] }), listCompletions: () => [], prToCard: {}, ...options,
    }) });
    const registry = createRegistry();
    registry.register(declaration);
    return runOperationCli({ declaration, argv: [...argv, '--json'], registry,
      store: createMemoryRunStore(), sinks: {}, newRunId: () => 'item-query-test' });
  }
  it('parses PR/card selectors and prints the actual JSON envelope', async () => {
    for (const argv of [['--pr=42', '--repo=frontierui'], ['--card=xabc123']]) {
      const result = await query(argv);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.lines.join('\n')).verdict).toEqual({ runs: [], gaps: [] });
    }
  });
  it('refuses invalid input before reading and distinguishes metadata failure from no match', async () => {
    for (const argv of [[], ['--pr=0'], ['--pr=1', '--card=42'], ['--card=bad']]) {
      const result = await query(argv, { readSources: () => { throw new Error('must not read'); } });
      expect(result.code).not.toBe(0);
      expect(result.lines.join('\n')).not.toContain('must not read');
    }
    const result = await query(['--pr=42'], { prToCard: undefined, viewPr: () => { throw new Error('offline'); } });
    const verdict = JSON.parse(result.lines.join('\n')).verdict;
    expect(verdict.runs).toEqual([]);
    expect(verdict.gaps.join(' ')).toContain('metadata unavailable');
  });
});


describe('runner freshness CLI', () => {
  for (const name of ['verify', 'open-pr']) {
    it(`refuses stale ${name} before persistence or execution`, async () => {
      await withBareOrigin(async (ctx) => {
        seedCheckout(ctx);
        ctx.seedOriginBranch('main', { 'docs/change.md': 'documentation drift' });
        ctx.seedOriginBranch('main', { 'config.json': '{}' });
        const r = runCli(ctx, [name, '--json']);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(name);
        expect(r.stderr).toContain('2 commits behind');
        expect(r.stderr).toContain('run from a lane');
        expect(r.stdout).toBe('');
        expect(r.records).toEqual([]);
        expect(r.calls).toEqual([]);
        expect(existsSync(join(ctx.clone, '.git/.lane-verify'))).toBe(false);
      });
    }, 120_000);
  }
});


import { FRESHNESS_CACHE, FRESHNESS_TTL } from '../runner-freshness.mjs';

function treeFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => join(e.parentPath ?? e.path, e.name)).sort();
}

describe('runner freshness real repository witnesses', () => {
  it('fresh execution, cache-hit soak, and expiry update a narrow origin ref', async () => {
    await withNarrowClone(async ctx => {
      seedCheckout(ctx);
      // Deliberately exclude main from configured fetch mappings.
      ctx.git(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other']);
      const args = ['verify', `--checkout=${ctx.clone}`, '--mode=check', '--json'];
      const fresh = runCli(ctx, args);
      expect(fresh.stderr).not.toMatch(/Refusing/);
      expect(JSON.parse(fresh.stdout).verdict).toBeDefined();
      const cachePath = join(ctx.clone, '.git', FRESHNESS_CACHE);
      const cached = readFileSync(cachePath, 'utf8');
      for (const path of ['docs/new.md', 'config.json', 'src/page.njk', 'src/_data/data.json']) {
        ctx.seedOriginBranch('main', { [path]: 'new content' });
      }
      // Ten sequential invocations must reuse the same successful fetch, not observe the new remote yet.
      for (let i = 0; i < 10; i++) {
        const r = runCli(ctx, args);
        expect(JSON.parse(r.stdout).verdict).toBeDefined();
        expect(r.stderr).not.toMatch(/Refusing/);
        expect(readFileSync(cachePath, 'utf8')).toBe(cached);
      }
      writeFileSync(cachePath, JSON.stringify({ ...JSON.parse(cached), time: Date.now() - FRESHNESS_TTL }));
      const expired = runCli(ctx, args);
      expect(expired.status).toBe(1);
      expect(expired.stderr).toContain('4 commits behind');
      expect(ctx.git(['rev-list', '--count', 'HEAD..refs/remotes/origin/main']).trim()).toBe('4');
    });
  }, 120_000);

  it('stale-state emits parseable JSON and one warning with zero new files', async () => {
    await withBareOrigin(async ctx => {
      seedCheckout(ctx);
      ctx.seedOriginBranch('main', { 'docs/change.md': 'drift' });
      ctx.git(['fetch', '--quiet', 'origin']);
      for (const dir of ['runs', 'calls', 'pool']) mkdirSync(join(ctx.tmp, dir));
      mkdirSync(join(ctx.clone, 'backlog'));
      const before = treeFiles(ctx.tmp);
      const r = runCli(ctx, ['stale-state', '--json']);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).verdict.records).toEqual([]);
      expect(r.stderr.match(/^Warning:/gm)).toHaveLength(1);
      expect(r.stderr).toContain('1 commits behind');
      expect(r.records).toEqual([]); expect(r.calls).toEqual([]);
      expect(treeFiles(ctx.tmp)).toEqual(before);
    });
  }, 120_000);

  it('ahead-only passes; divergent and detached HEAD count all remote commits', async () => {
    await withBareOrigin(async ctx => {
      seedCheckout(ctx);
      ctx.commit({ 'local.txt': 'ahead' });
      const args = ['verify', `--checkout=${ctx.clone}`, '--mode=check', '--json'];
      expect(JSON.parse(runCli(ctx, args).stdout).verdict).toBeDefined();
      ctx.seedOriginBranch('main', { 'data.json': '{}' });
      ctx.git(['fetch', '--quiet', 'origin']); // changed ref invalidates cache
      expect(runCli(ctx, args).stderr).toContain('1 commits behind');
      ctx.git(['checkout', '--quiet', '--detach']);
      expect(runCli(ctx, args).stderr).toContain('1 commits behind');
    });
  }, 120_000);

  it('daemon and audited override reach harmless input validation, even on resume', async () => {
    await withBareOrigin(async ctx => {
      seedCheckout(ctx);
      ctx.seedOriginBranch('main', { 'data.json': '{}' });
      for (const env of [{ WE_DAEMON_MANAGED_CLONE: '1' }, { WE_OPERATION_ALLOW_STALE: '1' }]) {
        const r = runCli(ctx, ['open-pr', '--json'], env);
        expect(r.status).toBe(1); // no ref, no --branch, no lane lease (#81): the plan refuses; no PR sink is invoked
        expect(r.stdout).toMatch(/cannot plan this PR/);
        if (env.WE_OPERATION_ALLOW_STALE) expect(r.stderr).toMatch(/override: open-pr.*1 commits behind/);
      }
      const r = runCli(ctx, ['verify', '--resume=missing', '--json']);
      expect(r.status).toBe(1); expect(r.stderr).toContain('1 commits behind');
    });
  }, 120_000);
});


it('real lane slot passes while override cannot suppress the dispatch guard', async () => {
  await withBareOrigin(async ctx => {
    seedCheckout(ctx);
    ctx.seedOriginBranch('main', { 'scripts/drift.mjs': 'export const drift = 1;' });
    ctx.git(['fetch', '--quiet', 'origin']);
    // Off-main loaded code cannot be repaired by the dispatcher's main fast-forward.
    ctx.git(['checkout', '--quiet', '--detach']);
    const dispatch = runCli(ctx, ['dispatch-lane', '--num=1'], { WE_OPERATION_ALLOW_STALE: '1' });
    expect(dispatch.status).toBe(1);
    expect(dispatch.stderr).toMatch(/refusing to dispatch|stale/i);
    expect(dispatch.records).toEqual([]);
    const lane = join(ctx.tmp, 'pool', 'web-everything', 'lane-1');
    mkdirSync(dirname(lane), { recursive: true });
    renameSync(ctx.clone, lane);
    const r = runCli({ ...ctx, clone: lane }, ['open-pr', '--json']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/cannot plan this PR/);
    expect(r.stderr).not.toMatch(/Refusing|override/);
  });
}, 120_000);
