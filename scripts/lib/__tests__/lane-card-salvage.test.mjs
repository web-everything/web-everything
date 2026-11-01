/**
 * R310 — card files left in a pool lane are saved, then cleaned, so the lane is never handed back dirty with them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planLaneCardDirt, salvageLaneCards, removeFiledCards, isCardFilePath } from '../lane-card-salvage.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let root; let lane; let salvageRoot;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lane-card-salvage-'));
  lane = join(root, 'lane-7');
  salvageRoot = join(root, 'salvage');
  mkdirSync(lane);
  git(['init', '--quiet', '--initial-branch=main'], lane);
  git(['config', 'user.email', 't@t.com'], lane);
  git(['config', 'user.name', 't'], lane);
  mkdirSync(join(lane, 'backlog'));
  writeFileSync(join(lane, 'backlog', '100-old.md'), 'old\n');
  git(['add', '.'], lane);
  git(['commit', '--quiet', '-m', 'seed'], lane);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The live 2026-11-01 lane-82 shape: a staged raised-by file plus an untracked prevention card. */
function leaveCards() {
  writeFileSync(join(lane, 'backlog', 'xfmkody-prevention-guard.md'), 'card body\n');
  mkdirSync(join(lane, 'backlog', 'raised-by', '5360'), { recursive: true });
  writeFileSync(join(lane, 'backlog', 'raised-by', '5360', '5771-abc.md'), 'raise body\n');
  git(['add', '--', 'backlog/raised-by/5360/5771-abc.md'], lane);
}

describe('planLaneCardDirt — PURE', () => {
  it('a lane with only card files and allowlisted litter is card-only', () => {
    const plan = planLaneCardDirt('?? backlog/xabc123-x.md\nA  backlog/raised-by/5360/5771-abc.md\n?? .pr-body.md\n?? tmp/a.txt\n');
    expect(plan.cardOnly).toBe(true);
    expect(plan.cards.map(c => c.path)).toEqual(['backlog/xabc123-x.md', 'backlog/raised-by/5360/5771-abc.md']);
    expect(plan.litter).toEqual(['.pr-body.md', 'tmp/a.txt']);
  });
  it('any other change makes it mixed, and a modified tracked card is never a card file', () => {
    expect(planLaneCardDirt('?? backlog/xabc123-x.md\n M scripts/a.mjs\n').cardOnly).toBe(false);
    expect(planLaneCardDirt(' M backlog/100-old.md\n').cardOnly).toBe(false);
    expect(planLaneCardDirt('').cardOnly).toBe(false);
  });
  it('only backlog markdown counts, never a traversal', () => {
    expect(isCardFilePath('backlog/x.md')).toBe(true);
    expect(isCardFilePath('backlog/../x.md')).toBe(false);
    expect(isCardFilePath('docs/x.md')).toBe(false);
  });
});

describe('salvageLaneCards — real git', () => {
  it('saves every card byte for byte, indexes it, then leaves the lane clean', () => {
    leaveCards();
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, now: new Date('2026-11-01T07:25:00Z') });
    expect(result.status).toBe('salvaged');
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe('');
    expect(readFileSync(join(result.outDir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
    expect(readFileSync(join(result.outDir, 'backlog/raised-by/5360/5771-abc.md'), 'utf8')).toBe('raise body\n');
    const row = JSON.parse(readFileSync(join(salvageRoot, 'index.jsonl'), 'utf8').trim());
    expect(row.lane).toBe(7);
    expect(row.changedFiles).toHaveLength(2);
    expect(row.cards).toEqual(expect.arrayContaining(['xfmkody', '5360']));
  });
  it('a lane with other changes too is left exactly as it was', () => {
    leaveCards();
    writeFileSync(join(lane, 'backlog', '100-old.md'), 'edited\n');
    const before = git(['status', '--porcelain', '--untracked-files=all'], lane);
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot }).status).toBe('mixed');
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe(before);
    expect(existsSync(salvageRoot)).toBe(false);
  });
  it('a failed save removes nothing (forced error: the salvage root is a file)', () => {
    leaveCards();
    writeFileSync(salvageRoot, 'not a directory');
    const before = git(['status', '--porcelain', '--untracked-files=all'], lane);
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot });
    expect(result.status).toBe('failed');
    expect(result.removed).toEqual([]);
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe(before);
  });
  it('a lane that changes between the save and the clean is not cleaned (copies kept)', () => {
    leaveCards();
    let statusReads = 0;
    const gitRun = (dir, args) => {
      if (args[0] === 'status' && ++statusReads === 2) writeFileSync(join(lane, 'late-edit.txt'), 'new work\n');
      return git(args, dir) + (args[0] === 'status' ? '\n' : '');
    };
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, gitRun });
    expect(result.status).toBe('failed');
    expect(result.removed).toEqual([]);
    expect(existsSync(join(lane, 'backlog', 'xfmkody-prevention-guard.md'))).toBe(true);
    expect(readFileSync(join(result.outDir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
  });
  it('a card whose bytes differ from what was handed on is never deleted', () => {
    leaveCards();
    const removed = removeFiledCards({ dir: lane, salvageRoot, expected: new Map([['backlog/xfmkody-prevention-guard.md', 'older text\n']]) });
    expect(removed).toEqual([]);
    expect(readFileSync(join(lane, 'backlog', 'xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
  });
  it('a staged-then-edited card (AM) is not treated as a card: the lane is left alone', () => {
    leaveCards();
    writeFileSync(join(lane, 'backlog', 'raised-by', '5360', '5771-abc.md'), 'edited after staging\n');
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot }).status).toBe('mixed');
  });
  it('a clean lane is a no-op', () => {
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot }).status).toBe('none');
  });
});

describe('removeFiledCards', () => {
  it('removes only the named, still-uncommitted card files', () => {
    leaveCards();
    writeFileSync(join(lane, 'backlog', 'xother1-keep.md'), 'not mine\n');
    const expected = new Map([['backlog/xfmkody-prevention-guard.md', 'card body\n'], ['backlog/raised-by/5360/5771-abc.md', 'raise body\n'], ['backlog/100-old.md', 'old\n']]);
    const removed = removeFiledCards({ dir: lane, expected, salvageRoot });
    expect(removed.sort()).toEqual(['backlog/raised-by/5360/5771-abc.md', 'backlog/xfmkody-prevention-guard.md']);
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe('?? backlog/xother1-keep.md');
    expect(readFileSync(join(lane, 'backlog', '100-old.md'), 'utf8')).toBe('old\n');
  });
});
