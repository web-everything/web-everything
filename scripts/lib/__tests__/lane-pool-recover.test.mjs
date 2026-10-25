import { describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyLaneNames, nextLaneNumbers, capState, qualifiesForCardBackup,
  recoverPool, diagnosePool, buildNeedsYouItem, backupLaneContent, realRecoverIo,
} from '../lane-pool-recover.mjs';
import { LANE_CONFIG_LIST_ARGS, LANE_GIT_CONFIG_PINS, laneGitHardeningEnv, scrubGitRepoEnv } from '../lane-git-hardening.mjs';
import { diffFeed, REPORT_KINDS, sanitizeForFeed } from '../../operations/needs-you-feed.mjs';

const preserved = () => ({ preserved: true, unpreservedFiles: [], unpreservedCommitShas: [], reason: 'safe' });
const cards = () => ({ preserved: false, unpreservedFiles: ['backlog/42-card.md'], unpreservedCommitShas: [], reason: 'cards only' });
function harness(overrides = {}) {
  const calls = [];
  const io = {
    isLeased: () => false,
    proof: n => { calls.push(['proof', n]); return preserved(); },
    backup: n => { calls.push(['backup', n]); return { ok: true }; },
    reclaim: (n, options) => { calls.push(['reclaim', n, options]); return { reclaimed: true }; },
    ...overrides,
  };
  return { calls, io, run: (options = {}) => recoverPool({ lanes: [1, 2], io, budgetMs: 100, now: () => 0, ...options }) };
}

describe('lane names and count-based capacity', () => {
  it('accepts only canonical names within the hard maximum', () => {
    const invalid = ['lane-x', 'lane-1a', 'lane-01', 'lane-1.5', 'lane-', '.trash-3', 'lane--1'];
    expect(classifyLaneNames(['lane-1', 'lane-90', ...invalid, 'lane-0', 'lane-91', 'lane-999999'], 90)).toEqual({
      valid: [1, 90],
      rejected: [
        ...invalid.map(name => ({ name, why: 'not-integer' })),
        // The explicit lane-0 example takes precedence over the contract's regex shorthand.
        ...['lane-0', 'lane-91', 'lane-999999'].map(name => ({ name, why: 'out-of-range' })),
      ],
    });
  });
  it('fills gaps first, ascending, and never allocates beyond the cap', () => {
    expect(nextLaneNumbers([5, 1, 3], 6, 4)).toEqual([2, 4, 6]);
    expect(nextLaneNumbers([], 3, 2)).toEqual([1, 2]);
    expect(nextLaneNumbers([1, 2, 3], 3, 1)).toEqual([]);
    expect(nextLaneNumbers([], 3, 0)).toEqual([]);
  });
  it('counts lanes rather than the highest lane number', () => {
    expect(capState([1, 2, 90], 90)).toEqual({ count: 3, hardMax: 90, atCap: false });
    expect(capState([1, 2, 3], 3)).toEqual({ count: 3, hardMax: 3, atCap: true });
    expect(capState([1, 2, 3, 4], 3)).toEqual({ count: 4, hardMax: 3, atCap: true });
  });
});

describe('card-only backup qualification', () => {
  it('accepts nonempty top-level backlog markdown files with no commits', () => {
    expect(qualifiesForCardBackup({ ...cards(), unpreservedFiles: ['backlog/a.md', 'backlog/b.md'] })).toBe(true);
  });
  it.each([
    { ...cards(), unpreservedCommitShas: ['abc123'] },
    { ...cards(), unpreservedFiles: [] },
    ...['src/file.ts', 'backlog/nested/a.md', 'backlog/a.txt', 'backlog/.md'].map(file => ({
      ...cards(), unpreservedFiles: ['backlog/a.md', file],
    })),
  ])('refuses commits, empty evidence, and files outside the exact card pattern: %j', proof => {
    expect(qualifiesForCardBackup(proof)).toBe(false);
  });
});

describe('recoverPool fail-closed lane recovery', () => {
  it('never proofs, backs up, or reclaims a leased lane', async () => {
    const h = harness({ isLeased: n => n === 1 });
    const result = await h.run();
    expect(result.keptLeased).toEqual([1]);
    expect(result.reclaimed).toEqual([2]);
    expect(h.calls.every(call => call[1] !== 1)).toBe(true);
  });
  it('backs up preserved lanes before reclaiming without override', async () => {
    const h = harness();
    expect(await h.run({ lanes: [1] })).toEqual({
      reclaimed: [1], keptUnpushed: [], keptLeased: [], skipped: [], backedUp: [1], salvaged: [], budgetExhausted: false,
    });
    expect(h.calls).toEqual([['proof', 1], ['backup', 1], ['reclaim', 1, { override: false }]]);
  });
  it.each([preserved, cards])('never reclaims when backup verification fails (%#)', async proof => {
    const h = harness({ proof, backup: () => ({ ok: false }) });
    const result = await h.run({ lanes: [1] });
    expect(result.reclaimed).toEqual([]);
    expect(result.backedUp).toEqual([]);
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringMatching(/backup/i) }]);
    expect(h.calls).toEqual([]); // default reclaim records every invocation
  });
  it('backs up card-only work before reclaiming with override', async () => {
    const h = harness({ proof: cards });
    const result = await h.run({ lanes: [1] });
    expect(result.reclaimed).toEqual([1]);
    expect(result.backedUp).toEqual([1]);
    expect(h.calls).toEqual([['backup', 1], ['reclaim', 1, { override: true }]]);
  });
  it.each([
    { ...cards(), unpreservedCommitShas: ['abc123'], reason: 'unpushed commit' },
    { ...cards(), unpreservedFiles: ['src/tracked.ts'], reason: 'tracked edits' },
  ])('keeps non-card work without backup or reclaim: $reason', async proof => {
    const h = harness({ proof: () => proof });
    const result = await h.run({ lanes: [1] });
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: proof.reason }]);
    expect(result.reclaimed).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it('keeps unreadable proof even when preserved is true and surfaces the error', async () => {
    const h = harness({ proof: () => ({ ...preserved(), error: 'cannot read refs' }) });
    const result = await h.run({ lanes: [1] });
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringContaining('cannot read refs') }]);
    expect(result.reclaimed).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it('bounds an oversized scan and reports every remaining lane as skipped', async () => {
    let time = 1000;
    const lanes = Array.from({ length: 1000 }, (_, i) => i + 1);
    const h = harness({ reclaim: () => { time += 11; return { reclaimed: true }; } });
    const result = await h.run({ lanes, budgetMs: 10, now: () => time });
    expect(result.reclaimed).toEqual([1]);
    expect(result.skipped).toEqual(lanes.slice(1));
    expect(result.budgetExhausted).toBe(true);
    expect(h.calls).toEqual([['proof', 1], ['backup', 1]]);
  });
  it.each(['proof', 'backup', 'reclaim'])('contains an exception from %s and continues other lanes', async method => {
    const h = harness();
    const original = h.io[method];
    h.io[method] = (n, ...args) => {
      if (n === 1) throw new Error(`${method} unavailable`);
      return original(n, ...args);
    };
    const result = await h.run();
    expect(result.reclaimed).toEqual([2]);
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringContaining(`${method} unavailable`) }]);
    if (method !== 'reclaim') expect(h.calls.some(c => c[0] === 'reclaim' && c[1] === 1)).toBe(false);
  });
  it('does not claim success when reclaim returns false', async () => {
    const h = harness({ reclaim: () => ({ reclaimed: false }) });
    expect((await h.run({ lanes: [1] })).reclaimed).toEqual([]);
  });
});

describe('operator diagnosis and feed item', () => {
  it('counts verdicts, sorts unpushed lanes, and strips controls from the one-line summary', () => {
    const result = diagnosePool({
      verdictByLane: { 1: 'leased', 2: 'dirty', 9: 'dirty' },
      keptUnpushed: [{ lane: 9, reason: 'work\n\u001b[31m' }, { lane: 2, reason: 'work' }],
      rejected: [{ name: 'lane-abc\n\u0007', why: 'not-integer' }],
    });
    expect(result.verdictCounts).toEqual({ leased: 1, dirty: 2 });
    expect(result.unpushedLanes).toEqual([2, 9]);
    expect(result.rejectedNames).toEqual(['lane-abc\n\u0007']);
    expect(result.summary).toMatch(/leased/);
    expect(result.summary).toMatch(/dirty/);
    for (const value of ['1', '2', '9', 'lane-abc']) expect(result.summary).toContain(value);
    expect(result.summary).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  });
  it('builds a sanitized needs-you feed item with stable per-repo identity across repeated failures', () => {
    const diagnosis = { verdictCounts: { dirty: 2 }, unpushedLanes: [2, 9], rejectedNames: [], summary: 'full\n\u001b[31m\u202efix lanes 2,9' };
    const make = nowIso => buildNeedsYouItem({ repoName: 'example', diagnosis, nowIso });
    const first = make('2026-10-24T12:00:00Z');
    const second = make('2026-10-24T13:00:00Z');
    expect(first.key).toBe('lane-pool-full:example');
    expect(second.key).toBe(first.key);
    expect(first.repo).toBe('example');
    expect(first.kind).toBe('needs-you');
    expect(REPORT_KINDS.has(first.kind)).toBe(true);
    expect(first).toHaveProperty('pr');
    expect(first).toHaveProperty('head');
    expect(typeof first.reason).toBe('string');
    expect(typeof first.title).toBe('string');
    expect(first.reason + first.title).toContain(sanitizeForFeed(diagnosis.summary, 100));
    expect(first.reason).toBe(sanitizeForFeed(first.reason, 100));
    expect(first.title).toBe(sanitizeForFeed(first.title, 200));
    const initial = diffFeed([], [first], '2026-10-24T12:00:00Z');
    expect(initial.lines).toHaveLength(1);
    expect(diffFeed(initial.openKeys, [second], '2026-10-24T13:00:00Z').lines).toEqual([]);
  });
});

function fixture() {
  const laneDir = join('pool', 'lane-4');
  const backupRoot = 'backups';
  const dir = join(backupRoot, 'lane-4-preserve');
  const files = ['backlog/a.md', 'drafts/a.md'];
  const data = new Map(files.map((file, i) => [join(laneDir, file), `content-${i}`]));
  const copies = [], patches = [], directories = [];
  const io = {
    untracked: path => { expect(path).toBe(laneDir); return files; },
    stashCount: path => { expect(path).toBe(laneDir); return 2; },
    stashPatch: (path, i) => { expect(path).toBe(laneDir); return `patch ${i}`; },
    archiveStash: vi.fn(),
    copyFile: (src, dst) => { copies.push([src, dst]); data.set(dst, data.get(src)); },
    writeFile: (path, text) => { patches.push([path, text]); data.set(path, text); },
    exists: path => data.has(path),
    size: path => data.get(path).length,
    mkdirp: path => directories.push(path),
  };
  return { laneDir, dir, files, data, copies, patches, directories, io,
    run: () => backupLaneContent({ lane: 4, laneDir, backupRoot, io }) };
}

describe('backupLaneContent verified preservation', () => {
  describe('complete stash archive regression', () => {
    it('requires a verified object archive for every stash before authorizing reclaim', async () => {
      const f = fixture();
      f.io.archiveStash = vi.fn();
      expect(await f.run()).toMatchObject({ ok: true, stashes: 2 });
      expect(f.io.archiveStash.mock.calls).toEqual([
        [f.laneDir, 0, join(f.dir, 'stash-0')], [f.laneDir, 1, join(f.dir, 'stash-1')],
      ]);
    });

    it('keeps the lane when complete stash preservation fails even if patch writes succeed', async () => {
      const f = fixture();
      f.io.archiveStash = () => { throw new Error('stash archive exceeds limit; inspect the lane manually'); };
      const h = harness({ backup: f.run });
      expect(await h.run({ lanes: [1] })).toMatchObject({ reclaimed: [], backedUp: [],
        keptUnpushed: [{ lane: 1, reason: expect.stringMatching(/archive exceeds limit/) }] });
      expect(h.calls.some(([method]) => method === 'reclaim')).toBe(false);
    });
  });
  it('copies all untracked contents without basename collisions and saves every stash patch', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({ ok: true, dir: f.dir, stashes: 2 });
    expect(result.files).toHaveLength(2);
    expect(f.directories).toContain(f.dir);
    expect(f.copies.map(([src]) => src).sort()).toEqual(f.files.map(file => join(f.laneDir, file)).sort());
    const destinations = f.copies.map(([, dst]) => dst);
    expect(new Set(destinations).size).toBe(2);
    for (const [src, dst] of f.copies) {
      expect(dst.startsWith(`${f.dir}/`)).toBe(true);
      expect(f.data.get(dst)).toBe(f.data.get(src));
      // Retaining relative paths or encoding '/' as '__' both avoid collisions.
      expect([join(f.dir, src.slice(f.laneDir.length + 1)), join(f.dir, src.slice(f.laneDir.length + 1).replaceAll('/', '__'))]).toContain(dst);
    }
    expect(f.patches).toEqual([[join(f.dir, 'stash-0.patch'), 'patch 0'], [join(f.dir, 'stash-1.patch'), 'patch 1']]);
    expect(result.files.every(file => typeof file === 'string')).toBe(true);
  });
  it('succeeds for a lane with no untracked files or stashes', async () => {
    const f = fixture();
    f.io.untracked = () => [];
    f.io.stashCount = () => 0;
    expect(await f.run()).toEqual({ ok: true, dir: f.dir, files: [], stashes: 0 });
  });
  it('fails closed when a copy silently produces no destination', async () => {
    const f = fixture();
    f.io.copyFile = () => {};
    expect((await f.run()).ok).toBe(false);
  });
  it('fails closed when a copied file has a different size than its source', async () => {
    const f = fixture();
    f.io.copyFile = (src, dst) => f.data.set(dst, 'x');
    expect((await f.run()).ok).toBe(false);
  });
  it('fails closed when a patch writer silently leaves no patch on disk', async () => {
    const f = fixture();
    f.io.writeFile = () => {};
    expect((await f.run()).ok).toBe(false);
  });
  it.each(['untracked', 'stashCount', 'stashPatch', 'archiveStash', 'copyFile', 'writeFile', 'exists', 'size', 'mkdirp'])(
    'contains %s failures and returns ok:false instead of throwing', async method => {
      const f = fixture();
      f.io[method] = () => { throw new Error(`${method} failed`); };
      expect((await f.run()).ok).toBe(false);
    },
  );
});

describe('real recovery backup Git hardening', () => {
  it('successive recovery backups retain earlier bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-successive-'));
    try {
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const dir = join(repo.poolDir, 'lane-1');
      mkdirSync(join(dir, 'drafts'), { recursive: true });
      const versions = [
        { file: Buffer.from([0, 1, 255]), patch: 'first stash patch\n', pack: Buffer.from('PACK first archive'), sha: 'a'.repeat(40) },
        { file: Buffer.from([0, 2, 128]), patch: 'later stash patch\n', pack: Buffer.from('PACK later archive'), sha: 'b'.repeat(40) },
      ];
      let version = versions[0];
      // Inject only Git reads; directory creation, copying, and archive writes are real.
      const runGit = (_git, args) => {
        if (['config', 'index-pack'].includes(args[0])) return '';
        if (args[0] === 'status') return '?? drafts/note.bin\0';
        if (args[0] === 'stash' && args[1] === 'list') return 'stash@{0}\n';
        if (args[0] === 'stash' && args[1] === 'show') return version.patch;
        if (args[0] === 'rev-parse') return version.sha;
        if (args.includes('pack-objects')) return version.pack;
        throw new Error(`Unexpected Git command: ${args.join(' ')}`);
      };
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false, runGit });
      writeFileSync(join(dir, 'drafts/note.bin'), version.file);
      const first = await io.backup(1);
      expect(first).toMatchObject({ ok: true, stashes: 1 });
      version = versions[1];
      writeFileSync(join(dir, 'drafts/note.bin'), version.file);
      const second = await io.backup(1);
      expect(second).toMatchObject({ ok: true, stashes: 1 });
      expect(second.dir).not.toBe(first.dir);
      rmSync(repo.poolDir, { recursive: true, force: true });
      for (const [i, backup] of [first, second].entries()) {
        expect(readFileSync(join(backup.dir, 'drafts/note.bin'))).toEqual(versions[i].file);
        expect(readFileSync(join(backup.dir, 'stash-0.patch'), 'utf8')).toBe(versions[i].patch);
        expect(readFileSync(join(backup.dir, 'stash-0.pack'))).toEqual(versions[i].pack);
        expect(readFileSync(join(backup.dir, 'stash-0.restore.txt'), 'utf8')).toContain(versions[i].sha);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('stash backups restore every content kind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-stash-objects-'));
    try {
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const dir = join(repo.poolDir, 'lane-1');
      mkdirSync(dir, { recursive: true });
      const env = laneGitHardeningEnv(scrubGitRepoEnv(process.env));
      const git = (args, cwd = dir, options = {}) => execFileSync('git', args,
        { cwd, env, encoding: 'utf8', ...options });
      git(['init', '-q']);
      git(['config', 'user.name', 'Fixture']);
      git(['config', 'user.email', 'fixture@example.test']);
      writeFileSync(join(dir, '.gitignore'), 'ignored.bin\n');
      writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2]));
      writeFileSync(join(dir, 'staged.txt'), 'base\n');
      writeFileSync(join(dir, 'deleted.txt'), 'remove me\n');
      writeFileSync(join(dir, 'renamed.txt'), 'rename me\n');
      writeFileSync(join(dir, 'executable'), 'script\n');
      git(['add', '.']);
      git(['commit', '-qm', 'base']);
      const base = git(['rev-parse', 'HEAD']).trim();
      const binary = Buffer.from([0, 255, 128, 10, 0]);
      writeFileSync(join(dir, 'binary.bin'), binary);
      writeFileSync(join(dir, 'staged.txt'), 'index version\n');
      git(['add', 'staged.txt']);
      writeFileSync(join(dir, 'staged.txt'), 'worktree version\n');
      git(['rm', '-q', 'deleted.txt']);
      git(['mv', 'renamed.txt', 'new-name.txt']);
      chmodSync(join(dir, 'executable'), 0o755);
      symlinkSync('staged.txt', join(dir, 'link'));
      git(['add', 'link', 'executable']);
      writeFileSync(join(dir, 'untracked.bin'), binary);
      writeFileSync(join(dir, 'ignored.bin'), binary);
      git(['stash', 'push', '-aq', '-m', 'all content kinds']);
      writeFileSync(join(dir, 'staged.txt'), 'second stash\n');
      git(['stash', 'push', '-q', '-m', 'newer stash']);
      const shas = git(['stash', 'list', '--format=%H']).trim().split('\n');
      // Lane metadata must not prune the stash's index or untracked parent graph.
      writeFileSync(join(dir, '.git', 'shallow'), `${shas.join('\n')}\n`);
      writeFileSync(join(dir, '.git', 'info', 'grafts'), `${shas.join('\n')}\n`);
      const backup = await realRecoverIo({ repo, backupRoot: root, isLeased: () => false }).backup(1);
      expect(backup).toMatchObject({ ok: true, stashes: 2 });
      // Remove the source entirely: no alternate object store can mask missing data.
      rmSync(repo.poolDir, { recursive: true, force: true });
      for (const [i, sha] of shas.entries()) {
        const restored = join(root, `restored-${i}`);
        mkdirSync(restored);
        git(['init', '-q'], restored);
        git(['unpack-objects'], restored, { input: readFileSync(join(backup.dir, `stash-${i}.pack`)) });
        git(['checkout', '-q', base], restored);
        git(['stash', 'store', sha], restored);
        git(['stash', 'apply', '--index'], restored);
        expect(git(['rev-parse', 'stash@{0}'], restored).trim()).toBe(sha);
        expect(readFileSync(join(backup.dir, `stash-${i}.restore.txt`), 'utf8')).toContain(sha);
        if (i === 0) {
          expect(readFileSync(join(restored, 'staged.txt'), 'utf8')).toBe('second stash\n');
        } else {
          for (const file of ['binary.bin', 'untracked.bin', 'ignored.bin']) {
            expect(readFileSync(join(restored, file))).toEqual(binary);
          }
          expect(readFileSync(join(restored, 'staged.txt'), 'utf8')).toBe('worktree version\n');
          expect(git(['show', ':staged.txt'], restored)).toBe('index version\n');
          expect(existsSync(join(restored, 'deleted.txt'))).toBe(false);
          expect(existsSync(join(restored, 'renamed.txt'))).toBe(false);
          expect(readFileSync(join(restored, 'new-name.txt'), 'utf8')).toBe('rename me\n');
          expect(lstatSync(join(restored, 'executable')).mode & 0o111).not.toBe(0);
          expect(readlinkSync(join(restored, 'link'))).toBe('staged.txt');
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an archive missing parents even while the source lane still has those objects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-incomplete-pack-'));
    try {
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const dir = join(repo.poolDir, 'lane-1');
      mkdirSync(dir, { recursive: true });
      const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
        env: laneGitHardeningEnv(scrubGitRepoEnv(process.env)) });
      git(['init', '-q']);
      writeFileSync(join(dir, 'tracked'), 'base\n');
      git(['add', '.']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base']);
      writeFileSync(join(dir, 'tracked'), 'work\n');
      git(['stash', 'push', '-q']);
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false,
        runGit: (command, args, options) => execFileSync(command,
          args.includes('pack-objects') ? ['pack-objects', '--stdout'] : args, options) });
      const backup = await io.backup(1);
      expect(backup).toMatchObject({ ok: false, error: expect.stringMatching(/complete stash backup failed/) });
      expect(git(['stash', 'list', '--format=%gd']).trim()).toBe('stash@{0}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['pack-objects', 'index-pack'])('refuses reclaim if complete stash %s fails', async failure => {
    const root = mkdtempSync(join(tmpdir(), 'recover-stash-failure-'));
    try {
      const runGit = vi.fn((_git, args) => {
        if (args.includes(failure)) throw new Error('archive unreadable or oversized');
        if (['config', 'status'].includes(args[0])) return '';
        if (args[0] === 'rev-parse') return 'a'.repeat(40);
        if (args.includes('pack-objects')) return Buffer.from('PACK fixture bytes');
        return args[1] === 'list' ? 'stash@{0}\n' : 'patch\n';
      });
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false, runGit });
      const h = harness({ backup: () => io.backup(1) });
      expect(await h.run({ lanes: [1] })).toMatchObject({ reclaimed: [], backedUp: [],
        keptUnpushed: [{ lane: 1, reason: expect.stringMatching(/complete stash backup failed.*inspect/) }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a lane clean filter before status can execute its sentinel command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-filter-'));
    try {
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const dir = join(repo.poolDir, 'lane-1'), sentinel = join(root, 'filter-ran');
      mkdirSync(dir, { recursive: true });
      const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: laneGitHardeningEnv(scrubGitRepoEnv(process.env)) });
      git(['init', '-q']);
      writeFileSync(join(dir, 'tracked.txt'), 'original\n');
      git(['add', 'tracked.txt']);
      // Poison only after staging, so fixture setup cannot run the driver.
      writeFileSync(join(dir, '.gitattributes'), 'tracked.txt filter=x\n');
      writeFileSync(join(dir, 'tracked.txt'), 'changed size\n');
      git(['config', 'filter.x.clean', `touch '${sentinel}'; cat`]);
      const commands = [];
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false,
        runGit: (command, args, options) => { commands.push(args); return execFileSync(command, args, options); } });
      const backup = await io.backup(1);
      expect(existsSync(sentinel)).toBe(false);
      expect(backup).toMatchObject({ ok: false, error: expect.stringMatching(/filter.*inspect/i) });
      expect(commands.every(args => args[0] === 'config')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['clean', 'smudge', 'process'])('refuses included worktree filter.%s config before reading content', async driver => {
    const root = mkdtempSync(join(tmpdir(), 'recover-driver-'));
    try {
      const runGit = vi.fn(() => `worktree\0filter.x.${driver}\ncommand\0`);
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false, runGit });
      expect(await io.backup(1)).toMatchObject({ ok: false, error: expect.stringMatching(/filter.*inspect/i) });
      expect(runGit).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed when config cannot be read, without running status or stash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-config-'));
    try {
      const runGit = vi.fn(() => { throw new Error('config unreadable'); });
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false, runGit });
      expect(await io.backup(1)).toMatchObject({ ok: false, error: expect.stringMatching(/config unreadable/) });
      expect(runGit).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('backs up raw stash patches without executing textconv or external diff drivers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-textconv-'));
    try {
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const dir = join(repo.poolDir, 'lane-1'), sentinel = join(root, 'diff-ran');
      mkdirSync(dir, { recursive: true });
      const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: laneGitHardeningEnv(scrubGitRepoEnv(process.env)) });
      git(['init', '-q']);
      writeFileSync(join(dir, '.gitattributes'), 'tracked.txt diff=x\n');
      writeFileSync(join(dir, 'tracked.txt'), 'original\n');
      git(['add', '.gitattributes', 'tracked.txt']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
      writeFileSync(join(dir, 'tracked.txt'), 'changed size\n');
      git(['stash', 'push', '-q']);
      git(['config', 'diff.x.textconv', `touch '${sentinel}'; cat`]);
      git(['config', 'diff.external', `touch '${sentinel}'`]);
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false });
      const backup = await io.backup(1);
      expect(existsSync(sentinel)).toBe(false);
      expect(backup).toMatchObject({ ok: true, stashes: 1 });
      expect(readFileSync(join(backup.dir, 'stash-0.patch'), 'utf8')).toContain('+changed size');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes a scrubbed, hardened read-only env to status, stash list and stash show', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-env-'));
    try {
      vi.stubEnv('GIT_DIR', '/untrusted/repo');
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'remote.origin.url');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'untrusted-origin');
      vi.stubEnv('GIT_EXTERNAL_DIFF', 'untrusted-command');
      const sha = 'a'.repeat(40);
      const runGit = vi.fn((_git, args) => {
        if (['config', 'status', 'index-pack'].includes(args[0])) return '';
        if (args[0] === 'rev-parse') return `${sha}\n`;
        if (args.includes('pack-objects')) return Buffer.from('PACK fixture bytes');
        return args[1] === 'list' ? 'stash@{0}\n' : 'patch\n';
      });
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false, runGit });
      const backup = await io.backup(1);
      expect(backup).toMatchObject({ ok: true, stashes: 1 });
      expect(runGit.mock.calls.map(([, args]) => args)).toEqual([
        [...LANE_CONFIG_LIST_ARGS],
        ['status', '--porcelain', '--untracked-files=all', '-z'],
        [...LANE_CONFIG_LIST_ARGS], ['stash', 'list', '--format=%gd'],
        [...LANE_CONFIG_LIST_ARGS], ['stash', 'show', '--no-ext-diff', '--no-textconv', '-p', 'stash@{0}'],
        [...LANE_CONFIG_LIST_ARGS], ['rev-parse', '--verify', 'stash@{0}^{commit}'],
        [...LANE_CONFIG_LIST_ARGS], ['-c', 'pack.threads=1', 'pack-objects', '--stdout', '--revs'],
        [...LANE_CONFIG_LIST_ARGS], ['index-pack', '--strict', '-o', join(backup.dir, 'stash-0.idx'), join(backup.dir, 'stash-0.pack')],
      ]);
      const env = laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null' });
      for (const [command, args, options] of runGit.mock.calls) {
        expect(command).toBe('git');
        expect(options.cwd).toBe(join(repo.poolDir, 'lane-1'));
        expect(options.env).toEqual(args[0] === 'index-pack'
          ? { ...env, GIT_OBJECT_DIRECTORY: join(backup.dir, 'stash-0.verify-objects') } : env);
        expect(options.env.GIT_DIR).toBeUndefined();
        expect(options.env.GIT_EXTERNAL_DIFF).toBeUndefined();
        expect(options.env.GIT_CONFIG_COUNT).toBe(String(LANE_GIT_CONFIG_PINS.length));
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('recoverPool salvage push before recovery', () => {
  const unpushed = (files = []) => ({ preserved: false, unpreservedFiles: files,
    unpreservedCommitShas: ['a'.repeat(40)], reason: 'local commits never pushed' });
  const ref = 'salvage/lane-1-20261024-1200';

  it('always exposes an empty salvaged list when nothing needed pushing', async () => {
    expect((await harness().run({ lanes: [1] })).salvaged).toEqual([]);
  });

  it.each(['pushed', 'matched'])('re-proofs after %s, then backs up and reclaims using the refreshed proof', async status => {
    const h = harness();
    h.io.proof = vi.fn().mockReturnValueOnce(unpushed()).mockReturnValueOnce(preserved());
    h.io.salvage = vi.fn(() => ({ status, ...(status === 'pushed' ? { ref } : {}) }));
    const result = await h.run({ lanes: [1] });
    expect(h.io.salvage).toHaveBeenCalledTimes(1); expect(h.io.salvage).toHaveBeenCalledWith(1);
    expect(h.io.proof).toHaveBeenCalledTimes(2);
    expect(result.reclaimed).toEqual([1]);
    expect(result.keptUnpushed).toEqual([]);
    expect(result.salvaged).toEqual(status === 'pushed' ? [{ lane: 1, ref }] : []);
    expect(h.calls).toEqual([['backup', 1], ['reclaim', 1, { override: false }]]);
  });

  it('orders initial proof, salvage, refreshed proof, backup, reclaim for commits plus qualifying cards', async () => {
    const h = harness();
    let proofs = 0;
    h.io.proof = n => { h.calls.push(['proof', n]); return proofs++ === 0 ? unpushed(['backlog/42-card.md']) : cards(); };
    h.io.salvage = n => { h.calls.push(['salvage', n]); return { status: 'pushed', ref }; };
    const result = await h.run({ lanes: [1] });
    expect(h.calls).toEqual([['proof', 1], ['salvage', 1], ['proof', 1], ['backup', 1], ['reclaim', 1, { override: true }]]);
    expect(result.backedUp).toEqual([1]);
    expect(result.reclaimed).toEqual([1]);
    expect(result.salvaged).toEqual([{ lane: 1, ref }]);
  });

  it('keeps a matched lane when the real-shaped re-proof still reports unpreserved commits', async () => {
    const h = harness({
      proof: vi.fn().mockReturnValueOnce(unpushed()).mockReturnValueOnce({
        ...unpushed(), reason: '1 unpreserved commit(s)',
      }),
      salvage: vi.fn(() => ({ status: 'matched', unmatched: [] })),
    });
    const result = await h.run({ lanes: [1] });
    expect(h.io.proof).toHaveBeenCalledTimes(2);
    expect(h.io.salvage).toHaveBeenCalledTimes(1);
    expect(h.io.salvage).toHaveBeenCalledWith(1);
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringMatching(/salvage|unpreserved/i) }]);
    expect(result.reclaimed).toEqual([]);
    expect(result.backedUp).toEqual([]);
    expect(result.salvaged).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('keeps a failed salvage in keptUnpushed with a salvage reason and no backup or reclaim', async () => {
    const h = harness({ proof: vi.fn(() => unpushed()), salvage: vi.fn(() => ({ status: 'failed', reason: 'origin unavailable' })) });
    const result = await h.run({ lanes: [1] });
    expect(h.io.salvage).toHaveBeenCalledTimes(1); expect(h.io.salvage).toHaveBeenCalledWith(1);
    expect(h.io.proof).toHaveBeenCalledTimes(1);
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringMatching(/salvage/i) }]);
    expect(result.reclaimed).toEqual([]);
    expect(result.salvaged).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it.each(['src/tracked.ts', 'backlog/nested/card.md', 'backlog/not-a-card.txt'])('never salvages or reclaims unpreserved non-card files: %s', async file => {
    const h = harness({ proof: () => unpushed(['backlog/42-card.md', file]), salvage: vi.fn(() => ({ status: 'pushed', ref })) });
    const result = await h.run({ lanes: [1] });
    expect(h.io.salvage).not.toHaveBeenCalled();
    expect(result.reclaimed).toEqual([]);
    expect(result.keptUnpushed.map(row => row.lane)).toEqual([1]);
    expect(result.salvaged).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('never salvages a leased lane', async () => {
    const h = harness({ isLeased: () => true, proof: vi.fn(() => unpushed()), salvage: vi.fn() });
    const result = await h.run({ lanes: [1] });
    expect(h.io.proof).not.toHaveBeenCalled();
    expect(h.io.salvage).not.toHaveBeenCalled();
    expect(result.keptLeased).toEqual([1]);
    expect(result.salvaged).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['still unpushed', () => unpushed()],
    ['new tracked edits', () => ({ ...unpushed(['src/new.ts']), unpreservedCommitShas: [] })],
    ['unreadable', () => ({ error: 'cannot read refreshed refs' })],
  ])('refuses backup and reclaim when refreshed proof is %s despite successful salvage', async (_label, refreshed) => {
    const h = harness({ proof: vi.fn().mockReturnValueOnce(unpushed()).mockImplementationOnce(refreshed), salvage: vi.fn(() => ({ status: 'pushed', ref })) });
    const result = await h.run({ lanes: [1] });
    expect(h.io.salvage).toHaveBeenCalledTimes(1); expect(h.io.salvage).toHaveBeenCalledWith(1);
    expect(h.io.proof).toHaveBeenCalledTimes(2);
    expect(result.reclaimed).toEqual([]);
    expect(result.keptUnpushed.map(row => row.lane)).toEqual([1]);
    expect(h.calls).toEqual([]);
  });
});

// A salvage transport exception must not abort recovery of independent lanes.
describe('recoverPool salvage exception isolation', () => {
  it('keeps the failed lane with a salvage reason and continues to the next lane', async () => {
    const h = harness({
      proof: n => n === 1
        ? { preserved: false, unpreservedFiles: [], unpreservedCommitShas: ['a'.repeat(40)], reason: 'unpushed' }
        : preserved(),
      salvage: vi.fn(() => { throw new Error('origin unavailable'); }),
    });
    const result = await h.run();
    expect(h.io.salvage).toHaveBeenCalledTimes(1); expect(h.io.salvage).toHaveBeenCalledWith(1);
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringMatching(/salvage/i) }]);
    expect(result.reclaimed).toEqual([2]);
    expect(result.salvaged).toEqual([]);
    expect(h.calls).toEqual([['backup', 2], ['reclaim', 2, { override: false }]]);
  });
});
