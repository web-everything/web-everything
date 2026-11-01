// @vitest-environment node
/**
 * Batch filing (operator go 2026-10-10): N mechanical filings land on ONE batch ref (one PR), the age limit seals
 * a batch with no new arrival, concurrent filers lose no card, and an opt-out or interactive filing goes alone.
 * Admission runs against a REAL bare origin; only the detached seal launch is recorded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardIdOf, decideBatchFiling, fileIntoBatch, freshMainBase, launchSealJob, main, NOT_BATCHED_EXIT } from '../card-batch-file.mjs';
import { budgetError, STEP_MIN_MS } from '../../lib/tick-deadline.mjs';
import { AI_TRAILER } from '../card-batch-io.mjs';
import { sealDueBatches } from '../card-batch-seal-io.mjs';
import { effectiveCardBatchPolicy, resolvePreventionBatchSettings, resolveCardBatchSettings } from '../../lib/card-batch-settings.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
import { withNarrowClone } from './helpers/real-repo.mjs';

const standard = loadCardBatchPolicy().filing;
const settingsWith = (repo = {}) => resolveCardBatchSettings({ standard, repo });
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'card-batch-file-')); dirs.push(dir); return dir; };

function writeCard(clone, id) {
  mkdirSync(join(clone, 'backlog'), { recursive: true });
  const rel = `backlog/${id}-follow-up-card.md`;
  writeFileSync(join(clone, rel), `---\nbornAs: ${id}\nkind: task\nstatus: open\n---\n\n# Card ${id}\n`);
  return rel;
}

describe('decideBatchFiling', () => {
  const settings = settingsWith();
  const policy = effectiveCardBatchPolicy(settings);
  it.each([
    [{ batch: 'false' }, false, 'opt-out (--batch=false)'],
    [{ batch: false }, false, 'opt-out (--batch=false)'],
    [{ actor: 'interactive' }, false, 'actor interactive files alone'],
    [{ priority: 'high' }, false, 'priority high bypasses the batch'],
    [{}, true, 'mechanical filing'],
    [{ batch: 'true', actor: 'mechanical', priority: 'medium' }, true, 'mechanical filing'],
  ])('%j → batch=%s', (input, batch, reason) => {
    expect(decideBatchFiling({ ...input, settings, policy })).toEqual({ batch, reason });
  });
  it('names the layer that switched batching off', () => {
    const off = resolveCardBatchSettings({ standard, env: { WE_CARDS_BATCH_FILING: '0' } });
    expect(decideBatchFiling({ settings: off, policy: effectiveCardBatchPolicy(off) }).reason).toBe('cards.batchFiling is off (env)');
  });
  it('reads the card id from a top-level backlog path only', () => {
    expect(cardIdOf('backlog/x1a2b3c-some-card.md')).toBe('x1a2b3c');
    expect(cardIdOf('backlog/sub/x1-card.md')).toBeNull();
    expect(cardIdOf('src/x1-card.md')).toBeNull();
  });
});

describe('fileIntoBatch against a real origin', () => {
  it('N filings land as N single-card commits on ONE batch ref; the seal job is launched for that batch', async () => {
    await withNarrowClone(async (ctx) => {
      const stateDir = tempDir();
      const launch = vi.fn();
      const baseSha = ctx.git(['rev-parse', 'HEAD']).trim();
      const results = [];
      for (const id of ['xaaaaa1', 'xaaaaa2', 'xaaaaa3']) {
        const cardPath = writeCard(ctx.clone, id);
        results.push(await fileIntoBatch({ laneDir: ctx.clone, cardPath, source: { repo: 'org/repo', note: `filer ${id}` } },
          { settings: settingsWith(), stateDir, launch, baseSha, log: () => {} }));
      }
      expect(results.map((r) => r.batched)).toEqual([true, true, true]);
      expect(new Set(results.map((r) => r.batchRef))).toEqual(new Set(['lane/card-batch-filing-1']));
      const statePath = join(stateDir, 'org-repo-filing.json');
      expect(launch.mock.calls.map((call) => call[0])).toEqual([statePath, statePath, statePath]);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(state.members.map((m) => m.cardId)).toEqual(['xaaaaa1', 'xaaaaa2', 'xaaaaa3']);
      // One commit per card, each adding exactly its card, each carrying the AI trailer the drain requires.
      // The narrow clone does not track the batch ref, so history is read on the origin.
      const commits = ctx.git(['--git-dir', ctx.origin, 'rev-list', '--reverse', `${baseSha}..lane/card-batch-filing-1`]).trim().split('\n');
      expect(commits).toHaveLength(3);
      for (const [i, sha] of commits.entries()) {
        const files = ctx.git(['--git-dir', ctx.origin, 'diff-tree', '--no-commit-id', '--name-status', '-r', sha]).trim();
        expect(files).toBe(`A\tbacklog/xaaaaa${i + 1}-follow-up-card.md`);
        expect(ctx.git(['--git-dir', ctx.origin, 'show', '-s', '--format=%B', sha])).toContain(AI_TRAILER);
      }
      // A re-filed card (same id) dedupes instead of adding a second commit.
      const again = await fileIntoBatch({ laneDir: ctx.clone, cardPath: 'backlog/xaaaaa2-follow-up-card.md', source: { repo: 'org/repo' } },
        { settings: settingsWith(), stateDir, launch, baseSha, log: () => {} });
      expect(again).toMatchObject({ batched: true, deduped: true });
      expect(ctx.git(['--git-dir', ctx.origin, 'rev-list', '--count', `${baseSha}..lane/card-batch-filing-1`]).trim()).toBe('3');
    });
  }, 60_000);

  it('concurrent filers lose no card: both land on the batch ref', async () => {
    await withNarrowClone(async (ctx) => {
      const stateDir = tempDir();
      const baseSha = ctx.git(['rev-parse', 'HEAD']).trim();
      const a = writeCard(ctx.clone, 'xbbbbb1');
      const b = writeCard(ctx.clone, 'xbbbbb2');
      const opts = { settings: settingsWith(), stateDir, launch: () => {}, baseSha, log: () => {}, pause: () => new Promise((r) => setTimeout(r, 20)) };
      const [ra, rb] = await Promise.all([
        fileIntoBatch({ laneDir: ctx.clone, cardPath: a, source: { repo: 'org/repo' } }, opts),
        fileIntoBatch({ laneDir: ctx.clone, cardPath: b, source: { repo: 'org/repo' } }, opts),
      ]);
      expect([ra.batched, rb.batched]).toEqual([true, true]);
      const tree = ctx.git(['--git-dir', ctx.origin, 'ls-tree', '-r', '--name-only', 'lane/card-batch-filing-1', 'backlog/']).trim().split('\n');
      expect(tree.sort()).toEqual([a, b].sort());
    });
  }, 60_000);

  it('a run of admissions in one lane fetches origin/main once per freshness window, not once per card', async () => {
    await withNarrowClone(async (ctx) => {
      const trace = join(tempDir(), 'trace2.jsonl');
      const prior = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = trace;
      const fetchesOfMain = () => {
        let text = '';
        try { text = readFileSync(trace, 'utf8'); } catch { return 0; }
        return text.split('\n').filter((l) => l.includes('"event":"start"'))
          .filter((l) => JSON.parse(l).argv.slice(1).join(' ') === 'fetch --no-tags -q origin main').length;
      };
      const bases = [];
      const admit = async (input) => { bases.push(input.baseSha); return { action: 'refuse', reason: 'head-mismatch' }; };
      const deps = { admit, launch: () => {}, stateDir: tempDir(), log: () => {}, settings: settingsWith() };
      try {
        for (const id of ['xfffff1', 'xfffff2', 'xfffff3', 'xfffff4']) {
          await fileIntoBatch({ laneDir: ctx.clone, cardPath: writeCard(ctx.clone, id), source: { repo: 'org/repo' } }, deps);
        }
      } finally {
        if (prior === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = prior;
      }
      expect(bases).toHaveLength(4);
      expect(new Set(bases)).toEqual(new Set([ctx.git(['rev-parse', 'origin/main']).trim()]));
      expect(fetchesOfMain()).toBe(1);
    });
  }, 60_000);

  it('freshMainBase refetches once the window passes, and never caches a failed fetch', () => {
    let t = 0;
    const calls = [];
    let failFetch = false;
    let sha = 'a'.repeat(40);
    const run = (cwd, args) => {
      calls.push(`${cwd}:${args[0]}`);
      if (args[0] === 'fetch' && failFetch) throw new Error('offline');
      return args[0] === 'rev-parse' ? sha : '';
    };
    const opts = { run, now: () => t, cache: new Map(), maxAgeMs: 1000 };
    const fetches = () => calls.filter((c) => c.endsWith(':fetch')).length;
    expect(freshMainBase('/lane-a', opts)).toBe(sha);
    t = 999; sha = 'b'.repeat(40);
    expect(freshMainBase('/lane-a', opts)).toBe('a'.repeat(40));
    expect(fetches()).toBe(1);
    t = 1000;
    expect(freshMainBase('/lane-a', opts)).toBe('b'.repeat(40));
    expect(fetches()).toBe(2);
    expect(freshMainBase('/lane-b', opts)).toBe('b'.repeat(40));
    expect(fetches()).toBe(3);
    failFetch = true; t = 5000;
    expect(freshMainBase('/lane-a', opts)).toBe('b'.repeat(40));
    expect(freshMainBase('/lane-a', opts)).toBe('b'.repeat(40));
    expect(fetches()).toBe(5);
    failFetch = false;
    freshMainBase('/lane-a', opts); freshMainBase('/lane-a', opts);
    expect(fetches()).toBe(6);
  });

  it.each([60_000, 20_000])('freshMainBase caps fetch at min(30s, %i ms left) and rev-parse at the remaining budget', (left) => {
    let remaining = left;
    const run = vi.fn((cwd, args) => {
      if (args[0] === 'fetch') remaining = 4_000;
      return args[0] === 'rev-parse' ? 'sha' : '';
    });
    expect(freshMainBase('/lane', { run, cache: new Map(), deadline: { left: () => remaining } })).toBe('sha');
    expect(run.mock.calls.map(call => call[2])).toEqual([Math.min(30_000, left), 4_000]);
  });

  it('freshMainBase returns a fresh cached hit even with no budget and no git calls', () => {
    const run = vi.fn(() => 'sha');
    const opts = { run, cache: new Map(), now: () => 0 };
    freshMainBase('/lane', opts);
    run.mockClear();
    expect(freshMainBase('/lane', { ...opts, deadline: { left: () => 0 } })).toBe('sha');
    expect(run).not.toHaveBeenCalled();
  });

  it('freshMainBase rethrows a budget-failed fetch without fallback or caching, then retries', () => {
    const error = budgetError('git');
    const run = vi.fn().mockImplementationOnce(() => { throw error; }).mockReturnValue('sha');
    const opts = { run, cache: new Map(), deadline: { left: () => 20_000 } };
    expect(() => freshMainBase('/lane', opts)).toThrow(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(opts.cache.size).toBe(0);
    expect(freshMainBase('/lane', opts)).toBe('sha');
    expect(run.mock.calls.map(call => call[1][0])).toEqual(['fetch', 'fetch', 'rev-parse']);
  });

  it('freshMainBase refuses fetch below 1000ms and refuses rev-parse if fetch consumes the budget', () => {
    let left = 999;
    const run = vi.fn(() => { left = 999; return ''; });
    const opts = { run, cache: new Map(), deadline: { left: () => left } };
    expect(() => freshMainBase('/lane', opts)).toThrow(/tick budget exhausted before git/);
    expect(run).not.toHaveBeenCalled();
    left = 20_000;
    expect(() => freshMainBase('/lane', opts)).toThrow(/tick budget exhausted before git/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(opts.cache.size).toBe(0);
  });

  it('freshMainBase propagates rev-parse budget errors without caching', () => {
    const error = budgetError('git');
    const run = vi.fn().mockReturnValueOnce('').mockImplementationOnce(() => { throw error; });
    const cache = new Map();
    expect(() => freshMainBase('/lane', { run, cache, deadline: { left: () => 20_000 } })).toThrow(error);
    expect(cache.size).toBe(0);
  });

  it('fileIntoBatch forwards deadline to mainBase and refuses a budget error without admitting', async () => {
    const error = budgetError('git');
    const mainBase = vi.fn(() => { throw error; });
    const admit = vi.fn();
    const deadline = { left: () => 20_000 };
    const card = { laneDir: '/lane', cardPath: 'backlog/xccccc1-card.md' };
    const opts = { settings: settingsWith(), mainBase, admit, deadline, log: () => {} };
    const refused = await fileIntoBatch(card, opts);
    expect(refused.batched).toBe(false);
    expect(refused.reason).toMatch(/^admission failed: .*tick budget exhausted before git/);
    expect(mainBase).toHaveBeenCalledWith('/lane', { deadline });
    expect(admit).not.toHaveBeenCalled();
    deadline.left = () => STEP_MIN_MS.admit - 1;
    mainBase.mockClear();
    expect(await fileIntoBatch(card, opts)).toEqual({ batched: false, retryable: true, reason: 'tick budget exhausted before admission' });
    expect(mainBase).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('opt-out, interactive actor and a disabled setting never touch the coordinator', async () => {
    const admit = vi.fn();
    const deps = { admit, launch: vi.fn(), stateDir: tempDir(), baseSha: 'a'.repeat(40), log: () => {} };
    const card = { laneDir: '/nowhere', cardPath: 'backlog/xccccc1-card.md' };
    expect(await fileIntoBatch({ ...card, batch: 'false' }, { ...deps, settings: settingsWith() })).toEqual({ batched: false, reason: 'opt-out (--batch=false)' });
    expect((await fileIntoBatch({ ...card, actor: 'operator' }, { ...deps, settings: settingsWith() })).batched).toBe(false);
    expect((await fileIntoBatch(card, { ...deps, settings: settingsWith({ batchFiling: false }) })).reason).toBe('cards.batchFiling is off (repo)');
    expect(admit).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('a coordinator refusal or error falls back to the per-card path with the reason', async () => {
    const deps = { launch: vi.fn(), stateDir: tempDir(), baseSha: 'a'.repeat(40), log: () => {}, settings: settingsWith(), pause: async () => {} };
    const card = { laneDir: '/nowhere', cardPath: 'backlog/xddddd1-card.md' };
    const held = vi.fn(async () => ({ action: 'refuse', reason: 'lease-held' }));
    expect(await fileIntoBatch(card, { ...deps, admit: held, retries: 2 })).toEqual({ batched: false, reason: 'coordinator refused: lease-held' });
    expect(held).toHaveBeenCalledTimes(3);
    const boom = vi.fn(async () => { throw new Error('git exploded\nstack'); });
    expect(await fileIntoBatch(card, { ...deps, admit: boom })).toEqual({ batched: false, reason: 'admission failed: git exploded' });
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('CLI exits 3 when not batched so the caller opens its own PR', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { code, result } = await main(['--lane=/nowhere', '--card=backlog/xeeeee1-card.md', '--batch=false', '--json'],
        { settings: settingsWith(), log: () => {} });
      expect(code).toBe(NOT_BATCHED_EXIT);
      expect(result.batched).toBe(false);
      expect((await main(['--card=backlog/x.md'])).code).toBe(1);
    } finally { log.mockRestore(); }
  });
});

describe('closing a batch at N cards or T minutes', () => {
  const fakeChild = () => ({ once: vi.fn((event, callback) => { if (event === 'spawn') queueMicrotask(callback); }), unref: vi.fn() });
  function batch(dir, members, openedAt) {
    const path = join(dir, 'org-repo-filing.json');
    writeFileSync(path, JSON.stringify({ batchRef: 'lane/card-batch-filing-1', seq: 1, headSha: 'a'.repeat(40), openedAt, pr: 7, holdApplied: true,
      members: Array.from({ length: members }, (_, i) => ({ cardId: `x${i}`, source: { repo: 'org/repo' } })) }));
    return path;
  }
  it('T: a one-card batch is sealed at batchMaxMinutes with no new arrival, not a minute before', async () => {
    const dir = tempDir();
    const path = batch(dir, 1, 0);
    const policy = effectiveCardBatchPolicy(settingsWith({ batchMaxMinutes: 60 }));
    const spawn = vi.fn(fakeChild);
    expect(await sealDueBatches({ now: 59 * 60_000, stateDir: dir, policy, spawn })).toEqual([]);
    expect(await sealDueBatches({ now: 60 * 60_000, stateDir: dir, policy, spawn })).toEqual([path]);
  });
  it('N: the batch is sealed as soon as it holds batchMaxCards cards', async () => {
    const dir = tempDir();
    const policy = effectiveCardBatchPolicy(settingsWith({ batchMaxCards: 3 }));
    const spawn = vi.fn(fakeChild);
    batch(dir, 2, 0);
    expect(await sealDueBatches({ now: 1000, stateDir: dir, policy, spawn })).toEqual([]);
    const path = batch(dir, 3, 0);
    expect(await sealDueBatches({ now: 1000, stateDir: dir, policy, spawn })).toEqual([path]);
  });
});


describe('prevention batching is independent of filing', () => {
  it.each([true, false])('prevention.batchFiling=%s overrides the opposite cards switch', async (enabled) => {
    const admit = vi.fn(async () => ({ action: 'admit', batchRef: 'lane/card-batch-prevention-1' }));
    const log = vi.fn();
    const result = await fileIntoBatch({ laneDir: '/unused', cardPath: 'backlog/x123456-card.md', kind: 'prevention' }, {
      settings: settingsWith({ batchFiling: !enabled }),
      preventionSettings: resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention,
        repo: { batchFiling: enabled, batchWindowMinutes: 30, batchMaxCards: 4 } }),
      admit, launch: vi.fn(), stateDir: tempDir(), baseSha: 'a'.repeat(40), log,
    });
    expect(result.batched).toBe(enabled);
    expect(log.mock.calls[0][0]).toContain('prevention-batch settings: prevention.batchFiling=');
    if (enabled) expect(admit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prevention' }),
      expect.objectContaining({ policy: expect.objectContaining({ prevention: expect.objectContaining({ enabled: true, maxAgeMinutes: 30, maxCards: 4 }) }) }));
    else {
      expect(result.reason).toBe('prevention.batchFiling is off (repo)');
      expect(admit).not.toHaveBeenCalled();
    }
  });
});

it('launchSealJob starts the seal worker as the worker App role even from a read-only observer caller', () => {
  const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
  const prior = process.env.WE_GITHUB_APP_ROLE; process.env.WE_GITHUB_APP_ROLE = 'observer';
  try { launchSealJob('/nonexistent/state.json', { spawn, open: () => { throw Error('no log'); } }); }
  finally { if (prior === undefined) delete process.env.WE_GITHUB_APP_ROLE; else process.env.WE_GITHUB_APP_ROLE = prior; }
  expect(spawn.mock.calls[0][2].env.WE_GITHUB_APP_ROLE).toBe('worker');
});
