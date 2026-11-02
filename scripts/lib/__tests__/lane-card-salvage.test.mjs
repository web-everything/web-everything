/**
 * R310 — card files left in a pool lane are saved, then cleaned, so the lane is never handed back dirty with them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, openSync, closeSync, writeSync, fsyncSync, fstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planLaneCardDirt, salvageLaneCards, removeFiledCards, isCardFilePath } from '../lane-card-salvage.mjs';
import { refreshSalvageIndex } from '../salvage-index.mjs';
import ts from 'typescript';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let root; let lane; let salvageRoot;
function realGitFixtures() {
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
}

/** The live 2026-11-01 lane-82 shape: a staged raised-by file plus an untracked prevention card. */
function leaveCards() {
  writeFileSync(join(lane, 'backlog', 'xfmkody-prevention-guard.md'), 'card body\n');
  mkdirSync(join(lane, 'backlog', 'raised-by', '5360'), { recursive: true });
  writeFileSync(join(lane, 'backlog', 'raised-by', '5360', '5771-abc.md'), 'raise body\n');
  git(['add', '--', 'backlog/raised-by/5360/5771-abc.md'], lane);
}

describe('concurrent index replacement — no Git writes', () => {
  it.each(['salvage', 'filed'])('preserves a different staged blob at the deletion boundary (%s)', mode => {
    const scratch = mkdtempSync(join(tmpdir(), 'card-index-race-'));
    const dir = join(scratch, 'lane');
    const rel = 'backlog/xabc123-prevention.md';
    const original = Buffer.from('A\n');
    const replacement = Buffer.from('B\n');
    let indexed = original;
    let replaced = false;
    const oid = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    mkdirSync(join(dir, 'backlog'), { recursive: true });
    writeFileSync(join(dir, rel), original);
    const gitRun = (_dir, args) => {
      if (args[0] === 'status') return indexed ? `${existsSync(join(dir, rel)) ? 'A ' : 'AD'} ${rel}\n` : '';
      if (args[0] === 'rev-parse') return args.includes('--show-object-format') ? 'sha1\n' : 'main\n';
      if (args[0] === 'rm' || args[0] === 'apply') {
        // Model update-index --cacheinfo after all reads, immediately before Git takes its write lock.
        indexed = replacement;
        replaced = true;
        if (args[0] === 'apply') {
          const patch = readFileSync(args.at(-1), 'utf8');
          if (!patch.includes(`index ${oid(indexed)}..`)) throw new Error('binary patch does not match index');
        }
        indexed = null;
        return '';
      }
      throw new Error(`unexpected Git command: ${args.join(' ')}`);
    };
    try {
      const options = { dir, lane: 7, salvageRoot: join(scratch, 'salvage'), gitRun, isLeaseCurrent: () => true };
      let result; let failure;
      try {
        result = mode === 'salvage' ? salvageLaneCards(options)
          : removeFiledCards({ ...options, expected: new Map([[rel, original.toString()]]) });
      } catch (error) { failure = error; }
      expect(replaced).toBe(true);
      expect(indexed).toEqual(replacement);
      if (mode === 'salvage') expect(result.status).toBe('failed');
      else expect(failure).toBeDefined();
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});

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

describe('unstaging failures — injected Git, real file retirement', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-card-unstage-'));
    lane = join(root, 'lane');
    salvageRoot = join(root, 'salvage');
    mkdirSync(join(lane, 'backlog', 'raised-by', '5360'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['filed', 'salvage'])('failed unstaging remains a release-blocking failure on every retry (%s)', mode => {
    const rel = 'backlog/raised-by/5360/5771-abc.md';
    writeFileSync(join(lane, rel), 'admitted bytes\n');
    const gitRun = (_dir, args) => {
      if (args[0] === 'status') return `${existsSync(join(lane, rel)) ? 'A ' : 'AD'} ${rel}\n`;
      if (args[0] === 'rev-parse') return args.includes('--show-object-format') ? 'sha1' : 'main';
      if (['rm', 'apply'].includes(args[0])) throw new Error('index.lock exists');
      throw new Error(`unexpected git command: ${args[0]}`);
    };
    const options = { dir: lane, lane: 7, salvageRoot, gitRun, isLeaseCurrent: () => true };
    let cleanupError; let result;
    try {
      result = mode === 'filed'
        ? removeFiledCards({ ...options, expected: new Map([[rel, 'admitted bytes\n']]) })
        : salvageLaneCards(options);
    } catch (error) { cleanupError = error; }
    expect(existsSync(join(lane, rel))).toBe(false);
    const retiredDir = mode === 'filed' ? join(salvageRoot, 'web-everything', 'retired-cards') : join(result.outDir, 'retired');
    const [retired] = readdirSync(retiredDir);
    expect(readFileSync(join(retiredDir, retired), 'utf8')).toBe('admitted bytes\n');
    // Both the filer's subsequent salvage and the release backstop must retain the lease.
    for (let retry = 0; retry < 2; retry++) {
      expect(salvageLaneCards(options)).toMatchObject({ status: 'failed', reason: expect.stringContaining('staged card deletion') });
    }
    if (mode === 'filed') expect(cleanupError?.message).toContain('index.lock exists');
    else expect(result.status).toBe('failed');
  });

  it.each(['unknown', 'unreadable'])('an %s object format leaves the staged deletion for recovery', failure => {
    const rel = 'backlog/xformat1-prevention.md';
    writeFileSync(join(lane, rel), 'saved bytes\n');
    let mutations = 0;
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true,
      gitRun: (_dir, args) => {
        if (args[0] === 'status') return `${existsSync(join(lane, rel)) ? 'A ' : 'AD'} ${rel}\n`;
        if (args[0] === 'rev-parse' && !args.includes('--show-object-format')) return 'main';
        if (args.includes('--show-object-format')) {
          if (failure === 'unreadable') throw new Error('format read failed');
          return 'unsupported';
        }
        mutations++;
        throw new Error('unexpected mutation');
      },
    });
    expect(result.status).toBe('failed');
    expect(mutations).toBe(0);
    expect(readFileSync(join(result.outDir, rel), 'utf8')).toBe('saved bytes\n');
  });

  it.each(['', '?? backlog/xother-card.md\n', ' M scripts/other.mjs\n'])('an existing AD card blocks release even with other dirt (%j)', other => {
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true,
      gitRun: (_dir, args) => {
        expect(args[0]).toBe('status');
        return `AD backlog/raised-by/5360/5771-abc.md\n${other}`;
      },
    });
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('staged card deletion'), removed: [] });
    expect(existsSync(salvageRoot)).toBe(false);
  });

  it('a quoted AD card also blocks release without attempting any mutation', () => {
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true,
      gitRun: (_dir, args) => {
        expect(args[0]).toBe('status');
        return 'AD "backlog/raised-by/5360/quoted\\tcard.md"\n';
      },
    }).status).toBe('failed');
    expect(existsSync(salvageRoot)).toBe(false);
  });
});

describe('salvageLaneCards — real git', () => {
  realGitFixtures();
  it.each([
    ['salvage', 'status'], ['salvage', 'mutation'], ['filed', 'status'], ['filed', 'mutation'],
  ])('keeps an unsaved index version staged across cleanup and retry (%s, %s)', (mode, boundary) => {
    const rel = 'backlog/xabc123-prevention.md';
    writeFileSync(join(lane, rel), 'A\n');
    git(['add', '--', rel], lane);
    const replacementFile = join(root, 'replacement');
    writeFileSync(replacementFile, 'B\n');
    const replacement = git(['hash-object', '-w', '--no-filters', replacementFile], lane);
    let reads = 0; let replaced = false;
    const gitRun = (dir, args) => {
      const replace = () => {
        git(['update-index', '--cacheinfo', '100644', replacement, rel], dir);
        replaced = true;
      };
      if (args[0] === 'status') {
        const output = git(args, dir);
        if (boundary === 'status' && ++reads === (mode === 'salvage' ? 2 : 1)) replace();
        return output;
      }
      if (boundary === 'mutation' && !replaced && ['rm', 'apply'].includes(args[0])) replace();
      return git(args, dir);
    };
    const options = { dir: lane, lane: 7, salvageRoot, gitRun, isLeaseCurrent: () => true };
    let retiredDir;
    if (mode === 'salvage') {
      const result = salvageLaneCards(options);
      expect(result.status).toBe('failed');
      expect(readFileSync(join(result.outDir, rel), 'utf8')).toBe('A\n');
      retiredDir = join(result.outDir, 'retired');
    } else {
      expect(() => removeFiledCards({ ...options, expected: new Map([[rel, 'A\n']]) })).toThrow();
      retiredDir = join(salvageRoot, 'web-everything', 'retired-cards');
    }
    expect(replaced).toBe(true);
    expect(git(['show', `:${rel}`], lane)).toBe('B');
    expect(git(['status', '--porcelain'], lane)).toBe(`AD ${rel}`);
    const [retired] = readdirSync(retiredDir);
    expect(readFileSync(join(retiredDir, retired), 'utf8')).toBe('A\n');
    const retry = salvageLaneCards({ ...options, gitRun: (dir, args) => git(args, dir) });
    expect(retry.status).toBe('failed');
    expect(retry.reason).toContain('staged card deletion needs recovery');
    expect(git(['show', `:${rel}`], lane)).toBe('B');
  });

  it.each(['sha1', 'sha256'])('binary deletion preserves exact bytes and literal paths (%s)', format => {
    const dir = join(root, format);
    mkdirSync(dir);
    git(['init', '--quiet', `--object-format=${format}`], dir);
    git(['config', 'core.quotePath', 'false'], dir);
    mkdirSync(join(dir, 'backlog'));
    const rel = 'backlog/xbytes1-café[literal].md';
    const bytes = Buffer.from('binary\0card\r\nno final newline');
    writeFileSync(join(dir, rel), bytes);
    git(['add', '--', rel], dir);
    const result = salvageLaneCards({ dir, lane: 7, salvageRoot, isLeaseCurrent: () => true });
    expect(result.status).toBe('salvaged');
    expect(git(['status', '--porcelain'], dir)).toBe('');
    expect(readFileSync(join(result.outDir, rel))).toEqual(bytes);
  });

  it.each([salvageLaneCards, removeFiledCards])('requires an explicit ownership predicate before any git IO (%s)', cleanup => {
    let calls = 0;
    expect(() => cleanup({ dir: lane, lane: 7, salvageRoot, gitRun: () => { calls++; return ''; } })).toThrow('requires isLeaseCurrent');
    expect(calls).toBe(0);
    expect(existsSync(salvageRoot)).toBe(false);
  });

  it('production cleanup call sites explicitly pass isLeaseCurrent', () => {
    const files = ['../../operations/land-prevention-card.mjs', '../../lane-pool.mjs'];
    const names = new Set(['removeCards', 'salvageCards', 'removeFiledCards', 'salvageLaneCards']);
    let calls = 0;
    for (const rel of files) {
      const file = resolve(dirname(fileURLToPath(import.meta.url)), rel);
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
          calls++;
          const options = node.arguments[0];
          expect(ts.isObjectLiteralExpression(options), `${rel}: explicit cleanup options`).toBe(true);
          expect(options.properties.some(p => p.name?.getText(ast) === 'isLeaseCurrent'), `${rel}: ${node.expression.text} must state ownership`).toBe(true);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(calls).toBe(3);
  });

  it('an unreadable status is unknown, rather than a known card-save failure', () => {
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true, gitRun: () => { throw new Error('status unavailable'); } });
    expect(result).toEqual({ status: 'unknown', reason: 'status read failed: status unavailable', removed: [] });
    expect(existsSync(salvageRoot)).toBe(false);
  });
  it('saves every card byte for byte, indexes it, then leaves the lane clean', () => {
    leaveCards();
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true, now: new Date('2026-11-01T07:25:00Z') });
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
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true }).status).toBe('mixed');
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe(before);
    expect(existsSync(salvageRoot)).toBe(false);
  });
  it('a failed save removes nothing (forced error: the salvage root is a file)', () => {
    leaveCards();
    writeFileSync(salvageRoot, 'not a directory');
    const before = git(['status', '--porcelain', '--untracked-files=all'], lane);
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true });
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
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true, gitRun });
    expect(result.status).toBe('failed');
    expect(result.removed).toEqual([]);
    expect(existsSync(join(lane, 'backlog', 'xfmkody-prevention-guard.md'))).toBe(true);
    expect(readFileSync(join(result.outDir, 'backlog/xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
  });
  it('a card whose bytes differ from what was handed on is never deleted', () => {
    leaveCards();
    const removed = removeFiledCards({ dir: lane, salvageRoot, isLeaseCurrent: () => true, expected: new Map([['backlog/xfmkody-prevention-guard.md', 'older text\n']]) });
    expect(removed).toEqual([]);
    expect(readFileSync(join(lane, 'backlog', 'xfmkody-prevention-guard.md'), 'utf8')).toBe('card body\n');
  });
  it('a card edited between save and clean stays in the lane even when porcelain is unchanged', () => {
    const rel = 'backlog/xrace12-prevention.md';
    writeFileSync(join(lane, rel), 'before\n');
    const before = git(['status', '--porcelain', '--untracked-files=all'], lane);
    let reads = 0;
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true, gitRun: (dir, args) => {
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
    const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true, gitRun: (dir, args) => {
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
    // Build a filesystem URL explicitly: Vite rewrites new URL(relative, import.meta.url) to an HTTP asset URL.
    const moduleUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../lane-card-salvage.mjs')).href;
    const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      let attempts = 0;
      fs.renameSync = () => { attempts++; throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
      syncBuiltinESMExports();
      const { salvageLaneCards, removeFiledCards } = await import(${JSON.stringify(moduleUrl)});
      const o = ${JSON.stringify({ dir: lane, lane: 7, salvageRoot })};
      o.isLeaseCurrent = () => true;
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
        const result = salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true, now: new Date('2026-11-01T07:25:00Z') });
        expect(result.status).toBe('salvaged');
        retiredDir = join(result.outDir, 'retired');
      } else {
        expect(removeFiledCards({ dir: lane, salvageRoot, isLeaseCurrent: () => true, expected: new Map([[rel, 'original\n']]) })).toEqual([rel]);
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
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true }).status).toBe('mixed');
  });
  it('a clean lane is a no-op', () => {
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent: () => true }).status).toBe('none');
  });
});

describe('removeFiledCards', () => {
  realGitFixtures();
  it.each(['before-retirement', 'after-retirement'])('lost ownership %s preserves the staged index', boundary => {
    const rel = 'backlog/xlease3-filed.md';
    writeFileSync(join(lane, rel), 'card\n');
    git(['add', '--', rel], lane);
    const beforeIndex = readFileSync(join(lane, '.git', 'index'));
    const retiredDir = join(salvageRoot, 'web-everything', 'retired-cards');
    const cleanup = () => removeFiledCards({ dir: lane, salvageRoot, expected: new Map([[rel, 'card\n']]),
      isLeaseCurrent: () => boundary === 'before-retirement' ? !existsSync(retiredDir) : existsSync(join(lane, rel)),
    });
    if (boundary === 'before-retirement') expect(cleanup()).toEqual([]);
    else expect(cleanup).toThrow('lease changed before unstaging cards');
    expect(readFileSync(join(lane, '.git', 'index'))).toEqual(beforeIndex);
    if (boundary === 'before-retirement') {
      expect(readFileSync(join(lane, rel), 'utf8')).toBe('card\n');
    } else {
      const [name] = readdirSync(retiredDir);
      expect(readFileSync(join(retiredDir, name), 'utf8')).toBe('card\n');
    }
  });

  it.each([() => false, () => { throw new Error('lease unreadable'); }])('unproven ownership leaves every card and index untouched', isLeaseCurrent => {
    leaveCards();
    const beforeStatus = git(['status', '--porcelain', '--untracked-files=all'], lane);
    const beforeIndex = readFileSync(join(lane, '.git', 'index'));
    const expected = new Map([['backlog/xfmkody-prevention-guard.md', 'card body\n'], ['backlog/raised-by/5360/5771-abc.md', 'raise body\n']]);
    expect(removeFiledCards({ dir: lane, expected, salvageRoot, isLeaseCurrent })).toEqual([]);
    expect(salvageLaneCards({ dir: lane, lane: 7, salvageRoot, isLeaseCurrent }).status).toBe('failed');
    expect(readFileSync(join(lane, '.git', 'index'))).toEqual(beforeIndex);
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe(beforeStatus);
    expect(existsSync(salvageRoot)).toBe(false);
  });

  it('removes only the named, still-uncommitted card files', () => {
    leaveCards();
    writeFileSync(join(lane, 'backlog', 'xother1-keep.md'), 'not mine\n');
    const expected = new Map([['backlog/xfmkody-prevention-guard.md', 'card body\n'], ['backlog/raised-by/5360/5771-abc.md', 'raise body\n'], ['backlog/100-old.md', 'old\n']]);
    const removed = removeFiledCards({ dir: lane, expected, salvageRoot, isLeaseCurrent: () => true });
    expect(removed.sort()).toEqual(['backlog/raised-by/5360/5771-abc.md', 'backlog/xfmkody-prevention-guard.md']);
    expect(git(['status', '--porcelain', '--untracked-files=all'], lane)).toBe('?? backlog/xother1-keep.md');
    expect(readFileSync(join(lane, 'backlog', '100-old.md'), 'utf8')).toBe('old\n');
  });
});
