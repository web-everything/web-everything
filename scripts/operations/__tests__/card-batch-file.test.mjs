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
import { cardIdOf, decideBatchFiling, fileIntoBatch, main, NOT_BATCHED_EXIT } from '../card-batch-file.mjs';
import { AI_TRAILER } from '../card-batch-io.mjs';
import { sealDueBatches } from '../card-batch-seal-io.mjs';
import { effectiveCardBatchPolicy, resolveCardBatchSettings } from '../../lib/card-batch-settings.mjs';
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
