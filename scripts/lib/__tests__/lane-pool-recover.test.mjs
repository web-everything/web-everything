import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyLaneNames, nextLaneNumbers, capState, qualifiesForCardBackup,
  recoverPool, diagnosePool, buildNeedsYouItem, backupLaneContent, realRecoverIo,
} from '../lane-pool-recover.mjs';
import { LANE_GIT_CONFIG_PINS, laneGitHardeningEnv, scrubGitRepoEnv } from '../lane-git-hardening.mjs';
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
  it.each(['untracked', 'stashCount', 'stashPatch', 'copyFile', 'writeFile', 'exists', 'size', 'mkdirp'])(
    'contains %s failures and returns ok:false instead of throwing', async method => {
      const f = fixture();
      f.io[method] = () => { throw new Error(`${method} failed`); };
      expect((await f.run()).ok).toBe(false);
    },
  );
});

describe('real recovery backup Git hardening', () => {
  it('passes a scrubbed, hardened read-only env to status, stash list and stash show', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recover-env-'));
    try {
      vi.stubEnv('GIT_DIR', '/untrusted/repo');
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'remote.origin.url');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'untrusted-origin');
      vi.stubEnv('GIT_EXTERNAL_DIFF', 'untrusted-command');
      const runGit = vi.fn((_git, args) => args[0] === 'status' ? '' : args[1] === 'list' ? 'stash@{0}\n' : 'patch\n');
      const repo = { poolDir: join(root, 'pool'), name: 'fixture' };
      const io = realRecoverIo({ repo, backupRoot: root, isLeased: () => false, runGit });
      expect(await io.backup(1)).toMatchObject({ ok: true, stashes: 1 });
      expect(runGit.mock.calls.map(([, args]) => args)).toEqual([
        ['status', '--porcelain', '--untracked-files=all', '-z'],
        ['stash', 'list', '--format=%gd'], ['stash', 'show', '-p', 'stash@{0}'],
      ]);
      const env = laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0' });
      for (const [command, , options] of runGit.mock.calls) {
        expect(command).toBe('git');
        expect(options.cwd).toBe(join(repo.poolDir, 'lane-1'));
        expect(options.env).toEqual(env);
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
