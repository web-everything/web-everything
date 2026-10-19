/**
 * @file Pins no-clone commitToMain/createBranch plumbing, the slim sim template,
 * and the whole-scenario budget error.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { scenario, runScenario } from './sim/scenario.mjs';

const IMPORTED = 'scripts/lib/daemon-self-sync.mjs';

describe('simulator git and budget regressions', () => {
  it('renders the living reviewer checklist from the isolated simulator clone', async () => {
    const checklistPath = 'docs/agent/reviewer-expectations.md';
    const checklist = readFileSync(resolve(process.cwd(), checklistPath), 'utf8').trim();
    await runScenario(scenario('dispatch brief dependencies', {
      lanes: 1,
      play: [(w) => {
        expect(readFileSync(join(w.simCloneRoot, checklistPath), 'utf8').trim()).toBe(checklist);
        const policyModule = pathToFileURL(join(w.simCloneRoot, 'scripts/lib/build-policy.mjs')).href;
        const brief = execFileSync(process.execPath, ['--input-type=module', '-e', `
          import { renderBuildRequirements, resolveBuildPolicy } from ${JSON.stringify(policyModule)};
          process.stdout.write(renderBuildRequirements({
            policy: resolveBuildPolicy({ env: {}, tool: {}, platform: {} }),
          }));
        `], { cwd: w.simCloneRoot, env: w.env, encoding: 'utf8', timeout: 5_000 });
        expect(brief).toContain(checklist);
        expect(brief).toContain('not done until `node scripts/verify-lane.mjs` is green');
      }],
    }));
  }, 180_000);

  it('isolates throttle windows across worlds whose clocks move backwards', async () => {
    // cwd-based: under the default vitest transform `import.meta.url` is an http: URL, which neither
    // `import()` in a child node nor `readFileSync` accepts.
    const throttle = pathToFileURL(resolve(process.cwd(), 'scripts/lib/gh-throttle.mjs')).href;
    const roots = [];
    const inherited = process.env.WE_GH_THROTTLE_LOCK_ROOT;
    for (const clockStartOffsetMs of [11 * 60_000, 0]) {
      await runScenario(scenario('independent throttle windows', {
        lanes: 1,
        clockStartOffsetMs,
        play: [(w) => {
          const lockRoot = w.env.WE_GH_THROTTLE_LOCK_ROOT;
          expect(lockRoot).toBe(join(w.root, 'gh-throttle'));
          expect(lockRoot).not.toBe(inherited);
          expect(roots).not.toContain(lockRoot);
          roots.push(lockRoot);
          // Spend the entire budget at +11m, then spend at baseline time in a fresh world. A shared root
          // times out on the second spend. Bound the probe so a regression fails without a two-minute wait.
          const spend = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
            import { acquireGhPointsSync } from ${JSON.stringify(throttle)};
            console.log(JSON.stringify(acquireGhPointsSync({
              lockRoot: process.env.WE_GH_THROTTLE_LOCK_ROOT,
              budgetPerMin: 1, owner: 'sim-world-regression', timeoutMs: 100,
            })));
          `], { env: w.env, encoding: 'utf8', timeout: 5_000 }));
          expect(spend()).toMatchObject({ ok: true, timedOut: false });
          // Two children of the SAME world must still share the budget.
          expect(spend()).toMatchObject({ ok: false, timedOut: true });
        }],
      }));
    }
  }, 180_000);

  it('keeps launcher routing snapshots and live gh shim directories out of the world', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-launcher-env-'));
    const shim = join(dir, 'github-app-token', 'gh-shim.d', 'fixture');
    mkdirSync(shim, { recursive: true });
    const liveTool = 'sim-live-shim-only-tool';
    writeFileSync(join(shim, liveTool), '');
    const policy = JSON.parse(readFileSync(resolve(process.cwd(), 'scripts/lib/dispatch-routing-policy.json'), 'utf8'));
    policy.aliases.claude.haiku = 'model-only-in-the-launcher-checkout';
    const oldSnapshot = process.env.WE_DISPATCH_ROUTING_SNAPSHOT;
    const oldPath = process.env.PATH;
    process.env.WE_DISPATCH_ROUTING_SNAPSHOT = JSON.stringify(policy);
    process.env.PATH = `${shim}:${oldPath}`;
    try {
      await runScenario(scenario('launcher isolation', {
        lanes: 1,
        play: [(w) => {
          expect(w.env.WE_DISPATCH_ROUTING_SNAPSHOT).toBeUndefined();
          expect(existsSync(join(w.root, 'tools', liveTool))).toBe(false);
        }],
      }));
    } finally {
      if (oldSnapshot === undefined) delete process.env.WE_DISPATCH_ROUTING_SNAPSHOT;
      else process.env.WE_DISPATCH_ROUTING_SNAPSHOT = oldSnapshot;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('recovers an orphan fake-gh lock during a fix-dispatch tick', async () => {
    await runScenario(scenario('fix-dispatch orphan lock', {
      repos: ['we'],
      lanes: 1,
      daemons: ['fix-dispatch'],
      play: [(w) => {
        const lock = `${w.env.FAKE_GH_STORE}.lock`;
        mkdirSync(lock);
        const past = new Date(performance.timeOrigin + performance.now() - 60_000);
        utimesSync(lock, past, past);
      }, 'tick fix-dispatch'],
      expect(s) {
        const ticks = s.ticks('fix-dispatch');
        expect(ticks).toHaveLength(1);
        expect(ticks[0].error).toBeNull();
        expect(ticks[0].ms).toBeLessThan(60_000);
      },
    }), { budgetMs: 60_000 });
  }, 90_000);

  it('writes exact blobs and advances branches only by fast-forward', async () => {
    await runScenario(scenario('bare-origin writes', {
      lanes: 1,
      play: [(w) => {
        const origin = w.repos.we.originPath;
        const show = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: origin, encoding: 'utf8' });
        const git = (args, input) => execFileSync('git', args, { cwd: origin, encoding: 'utf8', input });
        const executable = 'executable script.sh';
        const script = '#!/bin/sh\nexit 1\n';
        const beforeSeed = w.git.headOf('we', 'main');
        const blob = git(['hash-object', '-w', '--stdin'], '#!/bin/sh\nexit 0\n').trim();
        const tree = git(['mktree', '-z'], git(['ls-tree', '-z', beforeSeed]) +
          `100755 blob ${blob}\t${executable}\0`).trim();
        const seed = git(['-c', 'user.name=Sim World', '-c', 'user.email=sim@example.com',
          'commit-tree', tree, '-p', beforeSeed, '-m', 'seed executable']).trim();
        git(['update-ref', 'refs/heads/main', seed, beforeSeed]);
        const mode = (ref, path) => git(['ls-tree', ref, '--', path]).split(' ')[0];
        expect(mode('main', executable)).toBe('100755');
        const base = w.git.headOf('we', 'main');
        const content = 'utf8: café\nno trailing newline';
        const head = w.git.commitToMain('we', { 'backlog/9999-x.md': content, [IMPORTED]: content, [executable]: script });
        expect.soft(mode('main', executable)).toBe('100755');
        expect(show('main', executable)).toBe(script);
        expect(mode('main', IMPORTED)).toBe('100644');
        expect(mode('main', 'backlog/9999-x.md')).toBe('100644');
        // Start from the original executable too, so this caller is checked independently of commitToMain.
        w.git.createBranch('we', 'executable-update', { from: base, files: { [executable]: script } });
        expect.soft(mode('executable-update', executable)).toBe('100755');
        expect(show('executable-update', executable)).toBe(script);
        expect(head).not.toBe(base);
        expect(show('main', 'backlog/9999-x.md')).toBe(content);
        expect(show('main', IMPORTED)).toBe(content);
        expect(execFileSync('git', ['show', '-s', '--format=%an <%ae>|%cn <%ce>|%P', head], {
          cwd: origin, encoding: 'utf8',
        }).trim()).toBe(`Sim World <sim@example.com>|Sim World <sim@example.com>|${base}`);
        expect(w.git.createBranch('we', 'unchanged')).toBe(head);
        expect(w.git.createBranch('we', 'unchanged')).toBe(head);
        const branch = w.git.createBranch('we', 'seeded', { from: 'unchanged', files: { 'nested/new.txt': '' } });
        expect(branch).not.toBe(head);
        expect(show('seeded', 'nested/new.txt')).toBe('');
        expect(w.git.headOf('we', 'main')).toBe(head);
        expect(() => w.git.createBranch('we', 'seeded')).toThrow('non-fast-forward');
        expect(w.git.headOf('we', 'seeded')).toBe(branch);
        const advanced = w.git.createBranch('we', 'seeded', {
          from: 'seeded', files: { 'nested/new.txt': 'advanced\n' },
        });
        expect(advanced).not.toBe(branch);
        expect(w.git.headOf('we', 'seeded')).toBe(advanced);
        expect(show('seeded', 'nested/new.txt')).toBe('advanced\n');
        expect(execFileSync('git', ['show', '-s', '--format=%P', advanced], {
          cwd: origin, encoding: 'utf8',
        }).trim()).toBe(branch);
        expect(w.git.createBranch('we', 'seeded', { from: 'seeded' })).toBe(advanced);
        expect(() => w.git.createBranch('we', 'seeded', {
          files: { 'nested/divergent.txt': 'a sibling commit\n' },
        })).toThrow('non-fast-forward');
        expect(w.git.headOf('we', 'seeded')).toBe(advanced);
        expect(() => w.git.commitToMain('we')).toThrow('nothing to commit');
        expect(() => w.git.commitToMain('we', {})).toThrow('nothing to commit');
        expect(() => w.git.commitToMain('we', { [IMPORTED]: content })).toThrow('nothing to commit');
        expect(w.git.headOf('we', 'main')).toBe(head);
        expect(() => w.git.createBranch('we', 'seeded', {
          from: 'seeded', files: { 'nested/new.txt': 'advanced\n' },
        })).toThrow('nothing to commit');
        expect(w.git.headOf('we', 'seeded')).toBe(advanced);
        expect(() => w.git.commitToMain('unknown')).toThrow('world.git: unknown repo "unknown"');
        expect(() => w.git.createBranch('unknown', 'new')).toThrow('world.git: unknown repo "unknown"');
        const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: origin, encoding: 'utf8' });
        expect(paths).not.toMatch(/__tests__\/|\.(test|spec)\.[^/\n]+|scripts\/(golden-corpus|review-corpus)\/|scripts\/(?:[^\n]*\/)?fixtures\//);
      }],
      expect(s) { expect(s.trace).toEqual([]); },
    }));
  }, 180_000);

  it.each([{}, { budgetMs: Infinity }])('does not apply a scenario budget with options %j', async (options) => {
    let time = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => time);
    const completed = [];
    try {
      await runScenario(scenario('unbounded play list', {
        lanes: 1,
        play: [() => { time += 200; }, () => { completed.push('done'); }],
      }), { timeoutMs: 100, ...options });
      expect(completed).toEqual(['done']);
    } finally {
      now.mockRestore();
    }
  }, 180_000);

  it('reports cumulative budget exhaustion with every step duration', async () => {
    const realNow = Date.now.bind(Date);
    let time = realNow();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => time);
    function spendBudget() { time += 70; }
    function waitForReply() {
      const started = realNow();
      now.mockImplementation(() => time + realNow() - started);
      return new Promise(() => {});
    }
    try {
      const error = await runScenario(scenario('shared budget', {
        lanes: 1,
        play: ['advance 1m', spendBudget, waitForReply],
      }), { budgetMs: 100 }).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(
        /scenario "shared budget" timed out .*step 2: fn waitForReply: [^\n]*…[\s\S]*0: advance 1m → 0ms[\s\S]*1: fn spendBudget: [^\n]*[\s\S]*→ 70ms[\s\S]*2: fn waitForReply: [^\n]*…[\s\S]*→ \d+ms[\s\S]*recent host output:/,
      );
      const timings = [...error.message.matchAll(/^\d+: (.+) → \d+ms$/gm)];
      expect(timings).toHaveLength(3);
      for (const [, text] of timings) {
        expect(text.length).toBeLessThanOrEqual(100);
        expect(text).not.toMatch(/\s{2,}/);
      }
    } finally {
      now.mockRestore();
    }
  }, 180_000);
});
