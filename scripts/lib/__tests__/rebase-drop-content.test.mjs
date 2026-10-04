/**
 * @file rebase-drop-content.test.mjs — proof of #2371, the "safe-content" rebase-drop that widens #2198 beyond
 *   the manifest-only case: auto-resolve a `git merge-tree` conflict whose every hunk is non-overlapping
 *   (disjoint base-line ranges), still skip a genuinely overlapping hunk for `/finish`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFixClaim } from '../../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot } from '../../conveyor/fix-claim-store.mjs';
import {
  LANE_MANIFEST,
  splitLinesKeepEnds,
  diffLines,
  hunksOverlap,
  unionMerge,
  threeWayMergeLines,
  mergeTextThreeWay,
  decodeBlobTextStrict,
  parseConflictStages,
  planContentMerges,
  rebaseDropContent,
  checkMergeSanity,
  MAX_DIFF_LINES,
} from '../rebase-drop-content.mjs';
import { gitRun, gitBlobOid, EMPTY_BLOB_OID } from '../git-run.mjs';

describe('splitLinesKeepEnds', () => {
  it('keeps trailing newlines so join("") reproduces the original bytes', () => {
    const text = 'a\nb\nc\n';
    const lines = splitLinesKeepEnds(text);
    expect(lines).toEqual(['a\n', 'b\n', 'c\n']);
    expect(lines.join('')).toBe(text);
  });
  it('a final line with no trailing newline is kept bare', () => {
    const text = 'a\nb';
    expect(splitLinesKeepEnds(text)).toEqual(['a\n', 'b']);
  });
  it('empty text → []', () => {
    expect(splitLinesKeepEnds('')).toEqual([]);
  });
});

const L = (...s) => s.map((x) => `${x}\n`); // helper: build "line\n" arrays

describe('diffLines', () => {
  it('identical arrays → no hunks', () => {
    expect(diffLines(L('a', 'b', 'c'), L('a', 'b', 'c'))).toEqual([]);
  });
  it('a pure append → one INSERT hunk at the end (aStart===aEnd===n)', () => {
    const base = L('a', 'b', 'c');
    const hunks = diffLines(base, L('a', 'b', 'c', 'd'));
    expect(hunks).toEqual([{ aStart: 3, aEnd: 3, bStart: 3, bEnd: 4 }]);
  });
  it('a mid-file replace → one hunk spanning the changed range', () => {
    const hunks = diffLines(L('a', 'b', 'c'), L('a', 'X', 'c'));
    expect(hunks).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  });
  it('a deletion → bStart===bEnd', () => {
    const hunks = diffLines(L('a', 'b', 'c'), L('a', 'c'));
    expect(hunks).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
  });
  it('too large to diff safely → null', () => {
    const big = new Array(MAX_DIFF_LINES + 1).fill('x\n');
    expect(diffLines(big, ['y\n'])).toBeNull();
    expect(diffLines(['y\n'], big)).toBeNull();
  });
});

describe('hunksOverlap', () => {
  it('two zero-width insertions at the SAME position do not overlap (the append/append case)', () => {
    expect(hunksOverlap({ aStart: 5, aEnd: 5 }, { aStart: 5, aEnd: 5 })).toBe(false);
  });
  it('disjoint ranges do not overlap', () => {
    expect(hunksOverlap({ aStart: 0, aEnd: 2 }, { aStart: 4, aEnd: 6 })).toBe(false);
  });
  it('an insertion immediately after a replaced range does not overlap (adjacent, not intersecting)', () => {
    expect(hunksOverlap({ aStart: 1, aEnd: 3 }, { aStart: 3, aEnd: 3 })).toBe(false);
  });
  it('overlapping ranges DO overlap', () => {
    expect(hunksOverlap({ aStart: 1, aEnd: 4 }, { aStart: 3, aEnd: 5 })).toBe(true);
  });
  it('an identical replaced range overlaps (conservative — same-content edits still flagged)', () => {
    expect(hunksOverlap({ aStart: 1, aEnd: 2 }, { aStart: 1, aEnd: 2 })).toBe(true);
  });
});

describe('unionMerge', () => {
  it('append/append: both appended lines are kept, ours before theirs', () => {
    const base = L('a', 'b', 'c');
    const ours = L('a', 'b', 'c', 'OURS');
    const theirs = L('a', 'b', 'c', 'THEIRS');
    const oursHunks = diffLines(base, ours);
    const theirsHunks = diffLines(base, theirs);
    const merged = unionMerge(base, oursHunks, theirsHunks, ours, theirs);
    expect(merged.join('')).toBe('a\nb\nc\nOURS\nTHEIRS\n');
  });
  it('disjoint mid-file edits both land in their own positions', () => {
    const base = L('a', 'b', 'c', 'd', 'e');
    const ours = L('a', 'X', 'c', 'd', 'e'); // edits line 2
    const theirs = L('a', 'b', 'c', 'd', 'Y'); // edits line 5
    const merged = unionMerge(base, diffLines(base, ours), diffLines(base, theirs), ours, theirs);
    expect(merged.join('')).toBe('a\nX\nc\nd\nY\n');
  });
});

describe('threeWayMergeLines', () => {
  it('non-overlapping append/append → ok, union', () => {
    const base = L('a', 'b');
    const r = threeWayMergeLines(base, L('a', 'b', 'OURS'), L('a', 'b', 'THEIRS'));
    expect(r.ok).toBe(true);
    expect(r.lines.join('')).toBe('a\nb\nOURS\nTHEIRS\n');
  });
  it('overlapping edits to the same line → unsafe', () => {
    const base = L('a', 'b', 'c');
    const r = threeWayMergeLines(base, L('a', 'X', 'c'), L('a', 'Y', 'c'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/overlapping/);
  });
  it('too large on either side → unsafe', () => {
    const big = new Array(MAX_DIFF_LINES + 1).fill('x\n');
    const r = threeWayMergeLines(big, big, big);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too large/);
  });
});

describe('mergeTextThreeWay', () => {
  it('happy path: text in, merged text out', () => {
    const r = mergeTextThreeWay('a\nb\n', 'a\nb\nOURS\n', 'a\nb\nTHEIRS\n');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('a\nb\nOURS\nTHEIRS\n');
  });
  it('binary content (NUL byte) → refused outright', () => {
    const r = mergeTextThreeWay('a\0b', 'a\0b\nx', 'a\0b\ny');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('binary content');
  });
});

describe('decodeBlobTextStrict (byte-exactness guard)', () => {
  it('valid UTF-8 bytes round-trip to the exact text', () => {
    const buf = Buffer.from('héllo — café\n', 'utf8'); // multi-byte UTF-8, still lossless
    expect(decodeBlobTextStrict(buf)).toBe('héllo — café\n');
  });
  it('a plain string (already-safe text) is passed through', () => {
    expect(decodeBlobTextStrict('a\nb\n')).toBe('a\nb\n');
  });
  it('a NUL-free but NON-UTF-8 blob (latin-1 byte) → null, NOT lossily decoded to U+FFFD', () => {
    const buf = Buffer.from([0x61, 0xe9, 0x0a]); // 'a', lone 0xE9 (latin-1 'é' / invalid UTF-8), '\n'
    expect(buf.includes(0)).toBe(false); // NUL-free: the old NUL-only guard would have let this through
    expect(buf.toString('utf8')).toContain('�'); // proof the utf8 decode is lossy
    expect(decodeBlobTextStrict(buf)).toBeNull();
  });
  it('a NUL byte is caught even though NUL itself is valid UTF-8', () => {
    expect(decodeBlobTextStrict(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
  });
  it('null in → null out', () => {
    expect(decodeBlobTextStrict(null)).toBeNull();
  });
});

// A `git merge-tree --write-tree` conflict block WITH stage mode/oid info (unlike the manifest test's simpler
// helper, this carries distinct per-stage OIDs so `cat-file` can be scripted per-blob).
function conflictOutStages(entries) {
  const lines = ['t'.repeat(40)];
  for (const e of entries) {
    for (const stage of [1, 2, 3]) {
      const st = e.stages[stage];
      if (st) lines.push(`${st.mode} ${st.oid} ${stage}\t${e.path}`);
    }
  }
  lines.push('', 'Auto-merging …', `CONFLICT (content): Merge conflict in ${entries[0].path}`);
  return lines.join('\n');
}
// `git merge-tree`'s conflict-info oids must be VALID HEX for `parseMergeTree`'s regex to recognize the line —
// map each short tag to a stable hex string (a literal word like "base" fails the [0-9a-f]+ hex check).
const OID_HEX = { base: 'aaaa1', ours: 'bbbb2', thr: 'cccc3', mb: 'dddd4', mo: 'eeee5', mt: 'ffff6', b1: 'aaaa7', o1: 'bbbb8', t1: 'cccc9' };
const oid = (tag) => (OID_HEX[tag] || tag).padEnd(40, '0');

describe('parseConflictStages', () => {
  it('clean merge (exit 0) → {}', () => {
    expect(parseConflictStages('tree\n', 0)).toEqual({});
  });
  it('collects mode/oid per stage per path', () => {
    const out = conflictOutStages([
      { path: 'reports/x.md', stages: { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    const parsed = parseConflictStages(out, 1);
    expect(parsed['reports/x.md']).toEqual({
      1: { mode: '100644', oid: oid('base') },
      2: { mode: '100644', oid: oid('ours') },
      3: { mode: '100644', oid: oid('thr') },
    });
  });
  it('a stage missing on one side (add/add) is simply absent', () => {
    const out = conflictOutStages([
      { path: 'new.md', stages: { 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    const parsed = parseConflictStages(out, 1);
    expect(parsed['new.md'][1]).toBeUndefined();
  });
});

describe('planContentMerges', () => {
  const blobs = { [oid('base')]: 'a\nb\n', [oid('ours')]: 'a\nb\nOURS\n', [oid('thr')]: 'a\nb\nTHEIRS\n' };
  const readBlob = (o) => (o in blobs ? blobs[o] : null);
  const stages100644 = { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } };

  it('every path safe → ok with merged text per path', () => {
    const r = planContentMerges(['reports/x.md'], { 'reports/x.md': stages100644 }, readBlob);
    expect(r.ok).toBe(true);
    expect(r.merges['reports/x.md']).toBe('a\nb\nOURS\nTHEIRS\n');
  });
  it('missing a common-ancestor stage (add/add) → unsafe, names the path', () => {
    const stages = { 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } };
    const r = planContentMerges(['new.md'], { 'new.md': stages }, readBlob);
    expect(r.ok).toBe(false);
    expect(r.path).toBe('new.md');
    expect(r.reason).toMatch(/no common-ancestor/);
  });
  it('a non-100644 mode conflict → unsafe', () => {
    const stages = { ...stages100644, 3: { mode: '100755', oid: oid('thr') } };
    const r = planContentMerges(['x.sh'], { 'x.sh': stages }, readBlob);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mode conflict/);
  });
  it('an overlapping hunk in the content itself → unsafe', () => {
    const overlapBlobs = { [oid('base')]: 'a\nb\nc\n', [oid('ours')]: 'a\nX\nc\n', [oid('thr')]: 'a\nY\nc\n' };
    const rb = (o) => overlapBlobs[o] ?? null;
    const r = planContentMerges(['x.md'], { 'x.md': stages100644 }, rb);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/overlapping/);
  });
  it('short-circuits on the FIRST unsafe path', () => {
    const stagesBad = { 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } }; // missing stage 1
    const r = planContentMerges(['bad.md', 'reports/x.md'], { 'bad.md': stagesBad, 'reports/x.md': stages100644 }, readBlob);
    expect(r.ok).toBe(false);
    expect(r.path).toBe('bad.md');
  });
});

// A scripted `run` that returns canned results per git subcommand and records the call sequence — mirrors
// rebase-drop-manifest.test.mjs's `scriptedRun`.
function scriptedRun(script) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, cwd: opts?.cwd, input: opts?.input });
    const key = args[0];
    const handler = script[key];
    const res = typeof handler === 'function' ? handler(args, opts) : handler;
    return { status: 0, stdout: '', stderr: '', ...(res || {}) };
  };
  return { run, calls };
}

const MERGE_TREE_CLEAN = { 'merge-tree': { status: 0, stdout: 'cleanTree'.padEnd(40, '0') + '\n' } };

/**
 * #2923 — an HONEST write-back double. The old fixtures answered `hash-object` with a fixed fake oid
 * (`'mergedBlob'.padEnd(40,'0')`) no matter what — a double that rubber-stamps the write it is supposed to be
 * proving, which is precisely why the real bug (stdin dropped → git's EMPTY blob at exit 0) shipped green.
 * This double behaves like git: it hashes the stdin it actually receives, remembers what `update-index`
 * staged, and answers `ls-tree` from that record. Feed it a runner that loses the content and it reports the
 * empty blob, exactly as git does.
 */
function honestWriteBack({ tree = 'resolvedTree'.padEnd(40, '0'), commit = 'newCommitSha'.padEnd(40, '0') } = {}) {
  const staged = new Map();
  return {
    staged,
    script: {
      'read-tree': { status: 0 },
      rm: { status: 0 },
      'hash-object': (_args, opts) => ({ status: 0, stdout: gitBlobOid(opts?.input ?? '') + '\n' }),
      'update-index': (args) => {
        const m = String(args[args.indexOf('--cacheinfo') + 1] || '').match(/^(\d{6}),([0-9a-f]+),(.+)$/);
        if (m) staged.set(m[3], { mode: m[1], oid: m[2] });
        return { status: 0 };
      },
      'ls-tree': (args) => {
        const path = args[args.length - 1];
        const e = staged.get(path);
        return { status: 0, stdout: e ? `${e.mode} blob ${e.oid}\t${path}\0` : '' };
      },
      'write-tree': { status: 0, stdout: tree + '\n' },
      'commit-tree': { status: 0, stdout: commit + '\n' },
      push: { status: 0 },
    },
  };
}

/** The runner `merge-ai-prs.mjs` used to inject (#2923): it names neither `input` nor `encoding`, so stdin is
 *  silently discarded on the way to `git hash-object --stdin`. Wrapping an honest double in this reproduces
 *  the live data loss end-to-end. */
const stdinDroppingRunner = (inner) => (cmd, args, { env, cwd } = {}) => inner(cmd, args, { env, cwd });

describe('rebaseDropContent', () => {
  it('a clean merge → skip (nothing to do — not a candidate at all)', () => {
    const { run } = scriptedRun({ ...MERGE_TREE_CLEAN });
    const r = rebaseDropContent({ laneRef: 'lane/x-clean', run });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/no conflict/);
  });

  it('manifest-only conflict → skip, delegates to rebaseDropManifest', () => {
    const out = conflictOutStages([
      { path: LANE_MANIFEST, stages: { 1: { mode: '100644', oid: oid('b1') }, 2: { mode: '100644', oid: oid('o1') }, 3: { mode: '100644', oid: oid('t1') } } },
    ]);
    const { run } = scriptedRun({ 'merge-tree': { status: 1, stdout: out } });
    const r = rebaseDropContent({ laneRef: 'lane/x-manifest', run });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/manifest-only/);
  });

  it('a non-overlapping content conflict on ONE report file → rebased, merged content hashed + staged, pushed', () => {
    const out = conflictOutStages([
      { path: 'reports/2026-07-09-x.md', stages: {
        1: { mode: '100644', oid: oid('base') },
        2: { mode: '100644', oid: oid('ours') },
        3: { mode: '100644', oid: oid('thr') },
      } },
    ]);
    const blobs = { [oid('base')]: 'intro\n', [oid('ours')]: 'intro\nOURS verdict\n', [oid('thr')]: 'intro\nTHEIRS verdict\n' };
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: out },
      'cat-file': (args) => ({ status: 0, stdout: blobs[args[2]] ?? '' }),
      ...honestWriteBack().script,
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-2371', run });
    expect(r.action).toBe('rebased');
    expect(r.mergedPaths).toEqual(['reports/2026-07-09-x.md']);
    expect(r.droppedManifest).toBe(false);
    // the merged text (union of both appends) was hashed via stdin, not a real file.
    const ho = calls.find((c) => c.args[0] === 'hash-object');
    expect(ho.input).toBe('intro\nOURS verdict\nTHEIRS verdict\n');
    const up = calls.find((c) => c.args[0] === 'update-index');
    // the oid staged is the REAL git blob id of the merged text — not a fixture constant (#2923).
    expect(up.args).toEqual(['update-index', '--cacheinfo', `100644,${gitBlobOid('intro\nOURS verdict\nTHEIRS verdict\n')},reports/2026-07-09-x.md`]);
    // no manifest rm — it never conflicted.
    expect(calls.some((c) => c.args[0] === 'rm')).toBe(false);
    const ct = calls.find((c) => c.args[0] === 'commit-tree');
    expect(ct.args).toEqual(['commit-tree', 'resolvedTree'.padEnd(40, '0'), '-p', 'origin/main', '-p', 'origin/lane/x-2371', '-m', expect.any(String)]);
    const push = calls.find((c) => c.args[0] === 'push');
    expect(push.args).toEqual(['push', 'origin', `${'newCommitSha'.padEnd(40, '0')}:refs/heads/lane/x-2371`]);
  });

  it('a non-overlapping content conflict AND the manifest also conflicting → both dropped/merged in one rebuild', () => {
    const out = conflictOutStages([
      { path: LANE_MANIFEST, stages: { 1: { mode: '100644', oid: oid('mb') }, 2: { mode: '100644', oid: oid('mo') }, 3: { mode: '100644', oid: oid('mt') } } },
      { path: 'reports/x.md', stages: { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    const blobs = { [oid('base')]: 'intro\n', [oid('ours')]: 'intro\nOURS\n', [oid('thr')]: 'intro\nTHEIRS\n' };
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: out },
      'cat-file': (args) => ({ status: 0, stdout: blobs[args[2]] ?? '' }),
      ...honestWriteBack().script,
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-both', run });
    expect(r.action).toBe('rebased');
    expect(r.droppedManifest).toBe(true);
    const rm = calls.find((c) => c.args[0] === 'rm');
    expect(rm.args).toEqual(['rm', '--cached', '--ignore-unmatch', LANE_MANIFEST]);
  });

  it('an overlapping (real) content conflict → skip, names the path, no commit-tree/push', () => {
    const out = conflictOutStages([
      { path: 'reports/x.md', stages: { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    const blobs = { [oid('base')]: 'a\nb\nc\n', [oid('ours')]: 'a\nX\nc\n', [oid('thr')]: 'a\nY\nc\n' };
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: out },
      'cat-file': (args) => ({ status: 0, stdout: blobs[args[2]] ?? '' }),
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-overlap', run });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/reports\/x\.md/);
    expect(r.reason).toMatch(/overlapping/);
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('a NUL-free but NON-UTF-8 blob → skip (byte-exactness guard), no commit-tree/push', () => {
    const out = conflictOutStages([
      { path: 'reports/x.md', stages: { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    // stage-3 (theirs) is raw latin-1: 'a', lone 0xE9 ('é' / invalid UTF-8), '\n' — NUL-free, so the old
    // NUL-only guard would have lossily decoded it to U+FFFD and hashed the corrupted bytes back onto main.
    const blobs = {
      [oid('base')]: Buffer.from('a\n', 'utf8'),
      [oid('ours')]: Buffer.from('a\nOURS\n', 'utf8'),
      [oid('thr')]: Buffer.from([0x61, 0xe9, 0x0a]),
    };
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: out },
      'cat-file': (args) => ({ status: 0, stdout: blobs[args[2]] ?? Buffer.alloc(0) }),
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-latin1', run });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/reports\/x\.md/);
    expect(r.reason).toMatch(/non-UTF-8/);
    expect(calls.some((c) => c.args[0] === 'hash-object')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('an add/add conflict (no common-ancestor stage) → skip, not silently resolved', () => {
    const out = conflictOutStages([
      { path: 'new.md', stages: { 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    const { run } = scriptedRun({ 'merge-tree': { status: 1, stdout: out } });
    const r = rebaseDropContent({ laneRef: 'lane/x-addadd', run });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/new\.md/);
  });

  it('a failed plumbing step (write-tree) → error, no push', () => {
    const out = conflictOutStages([
      { path: 'reports/x.md', stages: { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    const blobs = { [oid('base')]: 'a\n', [oid('ours')]: 'a\nO\n', [oid('thr')]: 'a\nT\n' };
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: out },
      'cat-file': (args) => ({ status: 0, stdout: blobs[args[2]] ?? '' }),
      ...honestWriteBack().script,
      'write-tree': { status: 1, stderr: 'fatal: bad index' },
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-err', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/write-tree/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('no laneRef → error', () => {
    expect(rebaseDropContent({ run: () => ({ status: 0, stdout: '' }) }).action).toBe('error');
  });

  it('a failed fetch → error, no merge-tree/push', () => {
    const { run, calls } = scriptedRun({ fetch: { status: 1, stderr: 'fatal: not found' }, ...MERGE_TREE_CLEAN });
    const r = rebaseDropContent({ laneRef: 'lane/x-gone', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/fetch/);
    expect(calls.some((c) => c.args[0] === 'merge-tree')).toBe(false);
  });

  it('#2263 — a given `cwd` routes every git invocation through a sibling clone', () => {
    const out = conflictOutStages([
      { path: 'reports/x.md', stages: { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } },
    ]);
    const blobs = { [oid('base')]: 'a\n', [oid('ours')]: 'a\nO\n', [oid('thr')]: 'a\nT\n' };
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: out },
      'cat-file': (args) => ({ status: 0, stdout: blobs[args[2]] ?? '' }),
      ...honestWriteBack().script,
    });
    rebaseDropContent({ laneRef: 'lane/x-cwd', run, cwd: '/repos/frontierui' });
    for (const subcmd of ['fetch', 'merge-tree', 'cat-file', 'read-tree', 'hash-object', 'update-index', 'write-tree', 'commit-tree', 'push']) {
      expect(calls.find((c) => c.args[0] === subcmd)?.cwd).toBe('/repos/frontierui');
    }
  });
});

// ── #4293 — the mechanical push refuses a branch another fixer holds the LIVE fix claim on ─────────────────
describe('rebaseDropContent refuses to push onto a branch a fixer holds the LIVE fix claim on (#4293)', () => {
  let root;
  const priorRoot = process.env.WE_COORDINATION_ROOT;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'we-fix-claim-')); process.env.WE_COORDINATION_ROOT = root; });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (priorRoot === undefined) delete process.env.WE_COORDINATION_ROOT; else process.env.WE_COORDINATION_ROOT = priorRoot;
  });

  it('a non-overlapping content conflict on a claimed lane is refused before the push', () => {
    acquireFixClaim({ repo: 'we', pr: 4293, who: 'fixer-4293', branch: 'lane/x-2371-claimed', lockRoot: fixDispatchClaimRoot() });

    const out = conflictOutStages([
      { path: 'reports/2026-07-09-x.md', stages: {
        1: { mode: '100644', oid: oid('base') },
        2: { mode: '100644', oid: oid('ours') },
        3: { mode: '100644', oid: oid('thr') },
      } },
    ]);
    const blobs = { [oid('base')]: 'intro\n', [oid('ours')]: 'intro\nOURS verdict\n', [oid('thr')]: 'intro\nTHEIRS verdict\n' };
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: out },
      'cat-file': (args) => ({ status: 0, stdout: blobs[args[2]] ?? '' }),
      remote: { status: 0, stdout: 'git@github.com:web-everything/web-everything.git\n' },
      ...honestWriteBack().script,
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-2371-claimed', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/holds the fix claim on PR #4293/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});

// ── #2923 — the WRITE-BACK path, which is where the merged text actually died ────────────────────────────
//
// The pure merge library was never the culprit and every pure-library test passed while the drain was
// emptying files, so these drive the imperative git boundary instead: the write, the staging, and the
// verification that what got staged is what the merge produced.

describe('checkMergeSanity (#2923 — "auto-resolved" must mean merged, for ANY content type)', () => {
  it('a normal union merge passes', () => {
    expect(checkMergeSanity('a\n', 'a\nO\n', 'a\nT\n', 'a\nO\nT\n').ok).toBe(true);
  });
  it('an EMPTY result from non-empty inputs is refused', () => {
    const r = checkMergeSanity('a\n', 'a\nO\n', 'a\nT\n', '');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/EMPTY/);
  });
  it('a result drastically smaller than both sides is refused', () => {
    const big = 'x\n'.repeat(500);
    const r = checkMergeSanity(big, big + 'O\n', big + 'T\n', 'x\n');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/drastically smaller/);
  });
  it('all-empty inputs → an empty result is the CORRECT answer, not a refusal', () => {
    expect(checkMergeSanity('', '', '', '').ok).toBe(true);
  });
  it('a modest shrink (both sides deleted different regions) is still allowed', () => {
    const base = 'a\nb\nc\nd\n';
    expect(checkMergeSanity(base, 'a\nc\nd\n', 'a\nb\nc\n', 'a\nc\n').ok).toBe(true);
  });
});

describe('planContentMerges refuses a degenerate result (#2923)', () => {
  it('a merge that would empty the file → not ok, names the path, no merge emitted', () => {
    // Both sides delete everything the base had, in disjoint hunks — non-overlapping, so the resolver would
    // happily "auto-resolve" it to nothing. That is a data loss, not a merge; park it for /finish instead.
    const stages = { 'docs/x.md': { 1: { mode: '100644', oid: oid('base') }, 2: { mode: '100644', oid: oid('ours') }, 3: { mode: '100644', oid: oid('thr') } } };
    const blobs = { [oid('base')]: 'a\nb\n', [oid('ours')]: 'b\n', [oid('thr')]: 'a\n' };
    const r = planContentMerges(['docs/x.md'], stages, (o) => blobs[o] ?? null);
    expect(r.ok).toBe(false);
    expect(r.path).toBe('docs/x.md');
    expect(r.reason).toMatch(/EMPTY/);
  });
});

describe('rebaseDropContent write-back verification (#2923)', () => {
  const CONFLICT = conflictOutStages([
    { path: 'docs/shared.md', stages: {
      1: { mode: '100644', oid: oid('base') },
      2: { mode: '100644', oid: oid('ours') },
      3: { mode: '100644', oid: oid('thr') },
    } },
  ]);
  const BLOBS = { [oid('base')]: 'intro\n', [oid('ours')]: 'intro\nOURS\n', [oid('thr')]: 'intro\nTHEIRS\n' };
  const MERGED = 'intro\nOURS\nTHEIRS\n';

  function withRunner(wrap = (r) => r, overrides = {}) {
    const honest = honestWriteBack();
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: CONFLICT },
      'cat-file': (args) => ({ status: 0, stdout: BLOBS[args[2]] ?? '' }),
      ...honest.script,
      ...overrides,
    });
    return { honest, calls, run: wrap(run) };
  }

  it('THE BUG: a runner that drops `input` (merge-ai-prs.mjs injected exactly that) → ERROR, nothing committed', () => {
    // Regression pin for commit 836ae978. `git hash-object -w --stdin` on an EMPTY stdin exits 0 and returns
    // git's empty blob, so the old `status !== 0` check saw a clean success and the drain committed a
    // zero-byte file with a message claiming it auto-resolved the conflict. It must now ABORT.
    const { run, calls, honest } = withRunner(stdinDroppingRunner);
    const r = rebaseDropContent({ laneRef: 'lane/x-2923', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/EMPTY stdin/);
    expect(r.reason).toMatch(/#2923/);
    // and — the whole point — no commit and no push happened.
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
    // nothing was staged either: the abort happens BEFORE update-index.
    expect(honest.staged.size).toBe(0);
  });

  it('the same runner, unwrapped, stages the REAL merged blob and lands', () => {
    const { run, honest } = withRunner();
    const r = rebaseDropContent({ laneRef: 'lane/x-ok', run });
    expect(r.action).toBe('rebased');
    expect(honest.staged.get('docs/shared.md').oid).toBe(gitBlobOid(MERGED));
    expect(honest.staged.get('docs/shared.md').oid).not.toBe(EMPTY_BLOB_OID);
  });

  it('a tree that does not carry the blob we staged → ERROR, no push (update-index silently did not take)', () => {
    const { run, calls } = withRunner(undefined, { 'ls-tree': { status: 0, stdout: `100644 blob ${EMPTY_BLOB_OID}\tdocs/shared.md\0` } });
    const r = rebaseDropContent({ laneRef: 'lane/x-tree', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/EMPTY blob/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('a resolved tree missing the path entirely → ERROR (the write-back staged a different path)', () => {
    const { run, calls } = withRunner(undefined, { 'ls-tree': { status: 0, stdout: '' } });
    const r = rebaseDropContent({ laneRef: 'lane/x-path', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/no entry for docs\/shared\.md/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});

// ── #2923 — the same proof against REAL git, no doubles ──────────────────────────────────────────────────
//
// The bug survived a full suite of green unit tests because every one of them stubbed `hash-object` with a
// canned oid, so none could observe that git had received nothing. This builds an actual repository with the
// actual conflict and runs the actual plumbing. It is the test that would have caught it.

describe('rebaseDropContent against a real git repository (#2923)', () => {
  // The append/append case #2371 exists to auto-resolve: BOTH sides add a section at the SAME file tail, so
  // git's merge-tree cannot order the two insertions and reports a conflict — yet neither side touched an
  // EXISTING base line, so there is nothing to arbitrate. This is exactly the shape that emptied #2909.
  const BASE = 'title\n\nshared body\n';
  const OURS = BASE + '\n## From the main side\n';
  const THEIRS = BASE + '\n## From the lane side\n';
  const MERGED = BASE + '\n## From the main side\n' + '\n## From the lane side\n';
  const FILE = 'docs/shared.md';

  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rdc-2923-'));
    const g = (...args) => {
      const r = gitRun('git', args, { cwd: dir });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.stderr}`);
      return String(r.stdout).trim();
    };
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    // Build base/ours/theirs with pure plumbing — no checkout, no branch creation.
    const commitWith = (text, parent) => {
      const blob = String(gitRun('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text }).stdout).trim();
      const idx = { GIT_INDEX_FILE: '.git/build-index' };
      gitRun('git', ['read-tree', '--empty'], { cwd: dir, env: idx });
      gitRun('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${FILE}`], { cwd: dir, env: idx });
      const tree = String(gitRun('git', ['write-tree'], { cwd: dir, env: idx }).stdout).trim();
      const args = ['commit-tree', tree, '-m', 'c', ...(parent ? ['-p', parent] : [])];
      return String(gitRun('git', args, { cwd: dir }).stdout).trim();
    };
    const base = commitWith(BASE, null);
    const ours = commitWith(OURS, base);
    const theirs = commitWith(THEIRS, base);
    g('update-ref', 'refs/heads/main', ours);
    g('update-ref', 'refs/remotes/origin/lane/x-2923', theirs);
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  // Never push in a test — the rest is the genuine article.
  const noPush = (inner) => (cmd, args, opts) => (args[0] === 'push' ? { status: 0, stdout: '', stderr: '' } : inner(cmd, args, opts));
  const opts = () => ({
    laneRef: 'lane/x-2923', base: 'refs/heads/main', readRef: 'refs/remotes/origin/lane/x-2923',
    fetch: false, cwd: dir, tmpIndex: '.git/rdc-test-index',
  });
  const stagedIn = (commit) => {
    const ls = gitRun('git', ['ls-tree', commit, '--', FILE], { cwd: dir });
    return (String(ls.stdout).trim().split(/\s+/)[2] || '');
  };

  it('the conflict really is the non-overlapping case this resolver claims to handle', () => {
    const mt = gitRun('git', ['merge-tree', '--write-tree', 'refs/heads/main', 'refs/remotes/origin/lane/x-2923'], { cwd: dir });
    expect(mt.status).not.toBe(0); // git itself calls it a conflict
    expect(Object.keys(parseConflictStages(mt.stdout, mt.status))).toEqual([FILE]);
  });

  it('with a correct runner: the commit carries the MERGED bytes, both sides kept', () => {
    const r = rebaseDropContent({ ...opts(), run: noPush(gitRun) });
    expect(r.action).toBe('rebased');
    const blob = stagedIn(r.newCommit);
    expect(blob).toBe(gitBlobOid(MERGED));
    expect(String(gitRun('git', ['cat-file', '-p', blob], { cwd: dir }).stdout)).toBe(MERGED);
  });

  it('THE BUG, against real git: a runner that drops `input` used to stage the EMPTY blob — now it aborts', () => {
    // Proof the failure is real and not an artifact of the test double: run the exact same plumbing through
    // the exact runner shape merge-ai-prs.mjs injected, and watch git hand back e69de29b at exit 0.
    const dropped = stdinDroppingRunner(gitRun);
    const probe = dropped('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: MERGED });
    expect(probe.status).toBe(0);                                  // git is HAPPY …
    expect(String(probe.stdout).trim()).toBe(EMPTY_BLOB_OID);      // … and returned the empty blob.

    const r = rebaseDropContent({ ...opts(), run: noPush(dropped) });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/EMPTY stdin/);
    expect(r.newCommit).toBeUndefined();
  });
});

// #x8pcbf3 — the SAME live incident `rebase-drop-manifest.test.mjs` proves against `rebaseDropManifest`
// (PR #2752, `lane/4034-critical-work-gate`): this file's own `rebaseDropContent` fetches+merge-trees the
// identical way, so it carries the identical shallow-checkout exposure. See
// `we:scripts/lib/git-run.mjs#ensureFullHistory`'s own header for the full incident and live before/after.
describe('rebaseDropContent — shallow-checkout recovery (#x8pcbf3, PR #2752)', () => {
  const unrelatedThenResolves = (resolution) => {
    let n = 0;
    return () => (n++ === 0 ? { status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' } : resolution);
  };

  it('merge-tree failing "unrelated histories" is fixed (unshallow) and RETRIED', () => {
    const { run, calls } = scriptedRun({
      'rev-parse': { stdout: 'true\n' },
      fetch: { status: 0 },
      'merge-tree': unrelatedThenResolves({ status: 0, stdout: 'cleanTree'.padEnd(40, '0') + '\n' }),
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-shallow', run });
    expect(r.action).toBe('skip'); // clean on retry → nothing to do, but the ordering is what this proves
    expect(r.reason).toMatch(/no conflict/);
    const order = calls.map((c) => c.args[0]);
    expect(order.filter((c) => c === 'merge-tree')).toHaveLength(2);
    const firstMergeTree = order.indexOf('merge-tree');
    expect(order.indexOf('rev-parse')).toBeGreaterThan(firstMergeTree);
    expect(calls.some((c) => c.args.includes('--unshallow'))).toBe(true);
  });

  it('an ORDINARY clean/conflicting merge never triggers the shallow-checkout recovery at all', () => {
    const { run, calls } = scriptedRun({ ...MERGE_TREE_CLEAN });
    rebaseDropContent({ laneRef: 'lane/x-notshallow', run });
    expect(calls.filter((c) => c.args[0] === 'fetch')).toHaveLength(1);
    expect(calls.some((c) => c.args[0] === 'rev-parse')).toBe(false);
  });

  it('merge-tree STILL fails "unrelated histories" after a successful unshallow → reported as a checkout defect', () => {
    const { run } = scriptedRun({
      'rev-parse': { stdout: 'true\n' },
      fetch: { status: 0 },
      'merge-tree': { status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' },
    });
    const r = rebaseDropContent({ laneRef: 'lane/x-still-shallow', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/checkout was shallow, was unshallowed, and the merge STILL failed/);
  });
});
