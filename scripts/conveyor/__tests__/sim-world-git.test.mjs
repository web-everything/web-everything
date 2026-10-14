/**
 * @file Pins no-clone commitToMain/createBranch plumbing, the slim sim template,
 * and the whole-scenario budget error.
 */
import { mkdirSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { scenario, runScenario } from './sim/scenario.mjs';

const IMPORTED = 'scripts/lib/daemon-self-sync.mjs';

describe('simulator git and budget regressions', () => {
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
        const base = w.git.headOf('we', 'main');
        const content = 'utf8: café\nno trailing newline';
        const head = w.git.commitToMain('we', { 'backlog/9999-x.md': content, [IMPORTED]: content });
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
