/**
 * R310 — card files left in a pool lane are saved, then cleaned, so the lane is never handed back dirty with them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, openSync, closeSync, writeSync, fsyncSync, fstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planLaneCardDirt, salvageLaneCards, removeFiledCards, isCardFilePath } from '../lane-card-salvage.mjs';
import { refreshSalvageIndex } from '../salvage-index.mjs';

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
  it('an unreadable status is unknown, rather than a known card-save failure', () => {
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, gitRun: () => { throw new Error('status unavailable'); } });
    expect(result).toEqual({ status: 'unknown', reason: 'status read failed: status unavailable', removed: [] });
    expect(existsSync(salvageRoot)).toBe(false);
  });
  it('saves every card byte for byte, indexes it, then leaves the lane clean', () => {
    leaveCards();
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, now: new Date('2026-11-01T07:25:00Z') });
    expect(result.status).toBe('salvaged');
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe('');
    expect(readFileSync(join(result.outDir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
    expect(readFileSync(join(result.outDir, 'backlog/raised-by/5360/5771-abc.md'), 'utf8')).toBe('raise body\n');
    const retired = readdirSync(join(result.outDir, 'retired'));
    expect(retired).toHaveLength(2);
    expect(retired.map(name => readFileSync(join(result.outDir, 'retired', name), 'utf8')).sort()).toEqual(['card body\n', 'raise body\n']);
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
  it('a card edited between save and clean stays in the lane even when porcelain is unchanged', () => {
    const rel = 'backlog/xrace12-prevention.md';
    writeFileSync(join(lane, rel), 'before\n');
    const before = git(['status', '--porcelain', '--untracked-files=all'], lane);
    let reads = 0;
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, gitRun: (dir, args) => {
      if (args[0] === 'status' && ++reads === 2) writeFileSync(join(lane, rel), 'after\n');
      return git(args, dir);
    } });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('changed after the save');
    expect(result.removed).toEqual([]);
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe(before);
    expect(readFileSync(join(lane, rel), 'utf8')).toBe('after\n');
    expect(readFileSync(join(result.outDir, rel), 'utf8')).toBe('before\n');
  });
  it('a status-read failure after saving known cards still fails closed', () => {
    leaveCards();
    let reads = 0;
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, gitRun: (dir, args) => {
      if (args[0] === 'status' && ++reads === 2) throw new Error('status unavailable');
      return git(args, dir);
    } });
    expect(result.status).toBe('failed');
    expect(result.removed).toEqual([]);
    expect(readFileSync(join(lane, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
    expect(readFileSync(join(result.outDir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
  });
  it.each(['save', 'recheck'])('a lease replaced during %s leaves every card in the lane', stage => {
    leaveCards();
    let current = true; let reads = 0;
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => current, gitRun: (dir, args) => {
      if ((stage === 'save' && args[0] === 'rev-parse') || (stage === 'recheck' && args[0] === 'status' && ++reads === 2)) current = false;
      return git(args, dir);
    } });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('lease changed');
    expect(result.removed).toEqual([]);
    expect(existsSync(join(result.outDir, 'retired'))).toBe(false);
    expect(readFileSync(join(lane, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
    expect(readFileSync(join(lane, 'backlog/raised-by/5360/5771-abc.md'), 'utf8')).toBe('raise body\n');
    expect(existsSync(join(salvageRoot, 'index.jsonl'))).toBe(stage === 'recheck');
  });
  it('ownership lost at the retirement boundary preserves the card and staged index', () => {
    const rel = 'backlog/xlease1-prevention.md';
    writeFileSync(join(lane, rel), 'card\n');
    git(['add', '--', rel], lane);
    const staged = git(['show', `:${rel}`], lane);
    const now = new Date('2026-11-01T07:25:00Z');
    // Retirement creates this directory after comparing bytes, before its final ownership check.
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, now,
      isLeaseCurrent: () => !existsSync(salvageRoot) || !readdirSync(join(salvageRoot, 'web-everything')).some(stamp => existsSync(join(salvageRoot, 'web-everything', stamp, 'retired'))),
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('lease changed');
    expect(result.removed).toEqual([]);
    expect(readFileSync(join(lane, rel), 'utf8')).toBe('card\n');
    expect(git(['show', `:${rel}`], lane)).toBe(staged);
  });
  it('ownership lost after retirement preserves the replacement holder staged index', () => {
    const rel = 'backlog/xlease2-prevention.md';
    writeFileSync(join(lane, rel), 'card\n');
    git(['add', '--', rel], lane);
    const staged = git(['show', `:${rel}`], lane);
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot,
      isLeaseCurrent: () => existsSync(join(lane, rel)),
    });
    expect(result.status).toBe('failed');
    expect(result.removed).toEqual([rel]);
    expect(git(['show', `:${rel}`], lane)).toBe(staged);
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe(`AD ${rel}`);
    const [retired] = readdirSync(join(result.outDir, 'retired'));
    expect(readFileSync(join(result.outDir, 'retired', retired), 'utf8')).toBe('card\n');
  });
  it.each(['salvage', 'filed'])('EXDEV preserves the source and staged identity (%s)', mode => {
    leaveCards();
    const before = git(['status', '--porcelain', '--untracked-files=all'], lane);
    // Native ESM imports share this patched builtin; no Vitest module-mocking assumptions.
    const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      let attempts = 0;
      fs.renameSync = () => { attempts++; throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
      syncBuiltinESMExports();
      const { salvageLaneCards, removeFiledCards } = await import(${JSON.stringify(new URL('../lane-card-salvage.mjs', import.meta.url).href)});
      const o = ${JSON.stringify({ dir: lane, lane: 7, salvageRoot })};
      const result = ${JSON.stringify(mode)} === 'salvage' ? salvageLaneCards(o)
        : removeFiledCards({ ...o, expected: new Map([['backlog/raised-by/5360/5771-abc.md', 'raise body\\n']]) });
      console.log(JSON.stringify({ result, attempts }));
    `], { encoding: 'utf8' }));
    expect(child.attempts).toBe(1);
    const { result } = child;
    if (mode === 'salvage') {
      expect(result.status).toBe('failed');
      expect(result.removed).toEqual([]);
      expect(readFileSync(join(result.outDir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
    } else {
      expect(result).toEqual([]);
    }
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe(before);
    expect(readFileSync(join(lane, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
    expect(readFileSync(join(lane, 'backlog/raised-by/5360/5771-abc.md'), 'utf8')).toBe('raise body\n');
  });
  it.each(['salvage', 'filed'])('open-descriptor writes survive retirement, lane removal and salvage expiry (%s)', mode => {
    const rel = 'backlog/xopen12-prevention.md';
    writeFileSync(join(lane, rel), 'original\n');
    const fd = openSync(join(lane, rel), 'a');
    try {
      let retiredDir;
      if (mode === 'salvage') {
        const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, now: new Date('2026-11-01T07:25:00Z') });
        expect(result.status).toBe('salvaged');
        retiredDir = join(result.outDir, 'retired');
      } else {
        expect(removeFiledCards({ dir: lane, salvageRoot, expected: new Map([[rel, 'original\n']]) })).toEqual([rel]);
        retiredDir = join(salvageRoot, 'web-everything', 'retired-cards');
      }
      const [name] = readdirSync(retiredDir);
      const retired = join(retiredDir, name);
      expect(statSync(retired).ino).toBe(fstatSync(fd).ino);
      expect(existsSync(join(lane, rel))).toBe(false);
      rmSync(lane, { recursive: true });
      const refreshed = refreshSalvageIndex({ root: salvageRoot, nowMs: Date.parse('2027-01-01T00:00:00Z'), isLanded: () => false });
      expect(refreshed.expired).toHaveLength(mode === 'salvage' ? 1 : 0);
      writeSync(fd, 'late descriptor write\n');
      fsyncSync(fd);
      expect(readFileSync(retired, 'utf8')).toBe('original\nlate descriptor write\n');
      expect(fstatSync(fd).nlink).toBe(1);
    } finally { closeSync(fd); }
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
