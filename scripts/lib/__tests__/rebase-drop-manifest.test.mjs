/**
 * @file rebase-drop-manifest.test.mjs — proof of the #2198 shared "rebase onto main, drop the transient
 *   `.lane-manifest.json`" plumbing used by the label lander (`scripts/merge-ai-prs.mjs`) and the resume
 *   finisher (`scripts/lane-resume.mjs land`). The git process calls are the I/O boundary (injected `run`);
 *   the merge-tree parse + the manifest-only-vs-real disposition + the plumbing SEQUENCE are decided here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobOid } from '../git-run.mjs';
import {
  LANE_MANIFEST,
  parseMergeTree,
  manifestConflictDisposition,
  rebaseDropManifest,
} from '../rebase-drop-manifest.mjs';
import { acquireFixClaim } from '../../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot } from '../../conveyor/fix-claim-store.mjs';

// A `git merge-tree --write-tree` conflict block: line 1 = tree OID, then `<mode> <oid> <stage>\t<path>`
// lines (one per unmerged stage), a blank line, then informational messages.
const conflictOut = (paths) => {
  const info = paths.flatMap((p) => [1, 2, 3].map((stage) => `100644 ${'a'.repeat(40)} ${stage}\t${p}`));
  return ['t'.repeat(40), ...info, '', 'Auto-merging …', `CONFLICT (content): Merge conflict in ${paths[0]}`].join('\n');
};

describe('parseMergeTree', () => {
  it('a clean merge (exit 0): tree OID, no conflicts', () => {
    const r = parseMergeTree('deadbeef'.padEnd(40, '0') + '\n', 0);
    expect(r.clean).toBe(true);
    expect(r.conflictPaths).toEqual([]);
    expect(r.tree).toMatch(/^deadbeef/);
  });
  it('a conflict (exit 1): collects de-duplicated conflicted paths, stops at the blank line', () => {
    const r = parseMergeTree(conflictOut([LANE_MANIFEST]), 1);
    expect(r.clean).toBe(false);
    expect(r.conflictPaths).toEqual([LANE_MANIFEST]); // de-duped across the 3 stage lines
    expect(r.tree).toBe('t'.repeat(40));
  });
  it('collects multiple distinct conflicted paths', () => {
    const r = parseMergeTree(conflictOut([LANE_MANIFEST, 'src/app.ts']), 1);
    expect(r.conflictPaths.sort()).toEqual([LANE_MANIFEST, 'src/app.ts'].sort());
  });
});

describe('manifestConflictDisposition', () => {
  it("clean → 'clean'", () => {
    expect(manifestConflictDisposition({ clean: true, conflictPaths: [] })).toBe('clean');
  });
  it("only the manifest conflicts → 'manifest-only'", () => {
    expect(manifestConflictDisposition({ clean: false, conflictPaths: [LANE_MANIFEST] })).toBe('manifest-only');
  });
  it("a non-manifest path conflicts → 'real' (even alongside the manifest)", () => {
    expect(manifestConflictDisposition({ clean: false, conflictPaths: [LANE_MANIFEST, 'src/app.ts'] })).toBe('real');
    expect(manifestConflictDisposition({ clean: false, conflictPaths: ['src/app.ts'] })).toBe('real');
  });
  it('exit≠0 but no parseable paths → treated as no-op clean', () => {
    expect(manifestConflictDisposition({ clean: false, conflictPaths: [] })).toBe('clean');
  });
});

// A scripted `run` that returns canned results per git subcommand and records the call sequence.
function scriptedRun(script) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, cwd: opts?.cwd });
    const key = args[0]; // git subcommand
    const handler = script[key];
    const res = typeof handler === 'function' ? handler(args, opts) : handler;
    return { status: 0, stdout: '', stderr: '', ...(res || {}) };
  };
  return { run, calls };
}

const MERGE_TREE_CLEAN = { 'merge-tree': { status: 0, stdout: 'cleanTree'.padEnd(40, '0') + '\n' } };
const RESOLVED_PLUMBING = {
  'read-tree': { status: 0 },
  rm: { status: 0 },
  'write-tree': { status: 0, stdout: 'resolvedTree'.padEnd(40, '0') + '\n' },
  'commit-tree': { status: 0, stdout: 'newCommitSha'.padEnd(40, '0') + '\n' },
  push: { status: 0 },
};

describe('rebaseDropManifest', () => {
  it('a manifest-only conflict → resolves and pushes a rebuilt tip (dropped=true)', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST]) },
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-2198', run });
    expect(r.action).toBe('rebased');
    expect(r.dropped).toBe(true);
    expect(r.newCommit).toBe('newCommitSha'.padEnd(40, '0'));
    // commit-tree makes base the FIRST parent (so GitHub sees the branch up-to-date); the second parent is the
    // RESOLVED remote-tracking ref (#2231 — the bare `lane/x-2198` does not resolve in a fresh clone).
    const ct = calls.find((c) => c.args[0] === 'commit-tree');
    expect(ct.args).toEqual(['commit-tree', 'resolvedTree'.padEnd(40, '0'), '-p', 'origin/main', '-p', 'origin/lane/x-2198', '-m', expect.any(String)]);
    // the manifest is dropped from a TEMP index (GIT_INDEX_FILE set), never the working tree.
    const rm = calls.find((c) => c.args[0] === 'rm');
    expect(rm.args).toEqual(['rm', '--cached', '--ignore-unmatch', LANE_MANIFEST]);
    expect(rm.env?.GIT_INDEX_FILE).toBeTruthy();
    // push is a fast-forward of the lane/* ref (no checkout).
    const push = calls.find((c) => c.args[0] === 'push');
    expect(push.args).toEqual(['push', 'origin', `newCommitSha`.padEnd(40, '0') + ':refs/heads/lane/x-2198']);
  });

  it('#2263 — a given `cwd` routes EVERY git invocation through a sibling clone, not process.cwd()', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST]) },
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-2263', run, cwd: '/repos/frontierui' });
    expect(r.action).toBe('rebased');
    // fetch, merge-tree, read-tree, rm, write-tree, commit-tree, push — every step honours the sibling cwd.
    for (const subcmd of ['fetch', 'merge-tree', 'read-tree', 'rm', 'write-tree', 'commit-tree', 'push']) {
      expect(calls.find((c) => c.args[0] === subcmd)?.cwd).toBe('/repos/frontierui');
    }
  });

  it('a clean merge (behind only) → still rebuilds to fast-forward, dropped=false', () => {
    const { run } = scriptedRun({ ...MERGE_TREE_CLEAN, ...RESOLVED_PLUMBING });
    const r = rebaseDropManifest({ laneRef: 'lane/x-2199', run });
    expect(r.action).toBe('rebased');
    expect(r.dropped).toBe(false);
  });

  it('a real (non-manifest) conflict → skip, no commit-tree/push', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST, 'src/app.ts']) },
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-real', run });
    expect(r.action).toBe('skip');
    expect(r.conflictPaths).toContain('src/app.ts');
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('a failed plumbing step (write-tree) → error, no push', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST]) },
      'read-tree': { status: 0 },
      rm: { status: 0 },
      'write-tree': { status: 1, stderr: 'fatal: bad index' },
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-err', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/write-tree/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('no laneRef → error', () => {
    expect(rebaseDropManifest({ run: () => ({ status: 0, stdout: '' }) }).action).toBe('error');
  });

  // #2231 — in a fresh clone the lane branch is only the remote-tracking ref `origin/<laneRef>`; the bare name
  // does not resolve. The merge INPUTS (merge-tree, commit-tree) must read the resolved ref; the PUSH stays bare.
  it('feeds the RESOLVED remote-tracking ref to merge-tree/commit-tree, pushes to the BARE lane ref', () => {
    const { run, calls } = scriptedRun({ ...MERGE_TREE_CLEAN, ...RESOLVED_PLUMBING });
    const r = rebaseDropManifest({ laneRef: 'lane/x-2231', run });
    expect(r.action).toBe('rebased');
    // merge-tree reads origin/lane/x-2231, NOT the bare lane/x-2231.
    const mt = calls.find((c) => c.args[0] === 'merge-tree');
    expect(mt.args).toEqual(['merge-tree', '--write-tree', 'origin/main', 'origin/lane/x-2231']);
    // commit-tree's second parent is likewise the resolved ref.
    const ct = calls.find((c) => c.args[0] === 'commit-tree');
    expect(ct.args[5]).toBe('origin/lane/x-2231');
    // but the push target is the BARE ref (that half was always correct).
    const push = calls.find((c) => c.args[0] === 'push');
    expect(push.args[2]).toMatch(/:refs\/heads\/lane\/x-2231$/);
  });

  it('fetches the lane ref before reading it (so the remote-tracking ref is current in a fresh clone)', () => {
    const { run, calls } = scriptedRun({ ...MERGE_TREE_CLEAN, ...RESOLVED_PLUMBING });
    rebaseDropManifest({ laneRef: 'lane/x-2231', run });
    const fetch = calls.find((c) => c.args[0] === 'fetch');
    expect(fetch.args).toEqual(['fetch', 'origin', 'lane/x-2231']);
    // fetch happens BEFORE the merge-tree read.
    expect(calls.findIndex((c) => c.args[0] === 'fetch')).toBeLessThan(calls.findIndex((c) => c.args[0] === 'merge-tree'));
  });

  it('a failed fetch → error, no merge-tree/push (the lane ref never resolved)', () => {
    const { run, calls } = scriptedRun({ fetch: { status: 1, stderr: 'fatal: couldn’t find remote ref' }, ...MERGE_TREE_CLEAN, ...RESOLVED_PLUMBING });
    const r = rebaseDropManifest({ laneRef: 'lane/x-gone', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/fetch/);
    expect(calls.some((c) => c.args[0] === 'merge-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('fetch:false skips the fetch (caller already fetched) but still reads the resolved ref', () => {
    const { run, calls } = scriptedRun({ ...MERGE_TREE_CLEAN, ...RESOLVED_PLUMBING });
    rebaseDropManifest({ laneRef: 'lane/x-2231', fetch: false, run });
    expect(calls.some((c) => c.args[0] === 'fetch')).toBe(false);
    expect(calls.find((c) => c.args[0] === 'merge-tree').args[3]).toBe('origin/lane/x-2231');
  });

  // #2276 — the rebuild ALSO renumbers a colliding new item in the same tip (healCollision), so it clears the
  // manifest AND the id dup in one commit-tree, instead of shedding the manifest but staying red on `ids unique`.
  it('healCollision:true renumbers a base-colliding new item inside the rebuilt tree', () => {
    const { run, calls } = scriptedRun({
      ...MERGE_TREE_CLEAN,
      ...RESOLVED_PLUMBING,
      // base has #2219 (a different item) + a 2220 hole; the merged tree carries the lane's own #2219.
      'ls-tree': (args) => ({ status: 0, stdout: args.includes('origin/main')
        ? 'backlog/2218-a.md\nbacklog/2219-existing.md\nbacklog/2221-c.md\n'
        : 'backlog/2219-drain-finding.md\n' }),
      'cat-file': { status: 0, stdout: '---\nkind: story\n---\n# drain-finding\n' },
      // #2923 — hash the stdin we ACTUALLY receive, like git does. A canned oid here is what let the
      // renumber path stage git's empty blob (`adf2d758`, repaired by `14432ba9`) with every test green.
      'hash-object': (_a, o) => ({ status: 0, stdout: gitBlobOid(o?.input ?? '') + '\n' }),
      'update-index': { status: 0 },
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-2276', healCollision: true, run });
    expect(r.action).toBe('rebased');
    expect(r.healed).toEqual([{ oldNum: '2219', newNum: '2220', oldName: '2219-drain-finding.md', newName: '2220-drain-finding.md' }]);
    // the renumbered blob was staged into the SAME temp index the rebuild write-trees.
    const up = calls.find((c) => c.args[0] === 'update-index');
    expect(up.env?.GIT_INDEX_FILE).toBeTruthy();
    // exactly ONE commit-tree / push (a single rebuilt tip), not a second rebuild.
    expect(calls.filter((c) => c.args[0] === 'commit-tree')).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(1);
  });

  it('healCollision:true with no collision leaves the tip untouched (healed:[])', () => {
    const { run } = scriptedRun({
      ...MERGE_TREE_CLEAN,
      ...RESOLVED_PLUMBING,
      'ls-tree': (args) => ({ status: 0, stdout: args.includes('origin/main')
        ? 'backlog/2218-a.md\nbacklog/2219-b.md\n'
        : 'backlog/2230-fresh.md\n' }), // fresh id, no clash
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-nofix', healCollision: true, run });
    expect(r.action).toBe('rebased');
    expect(r.healed).toEqual([]);
  });

  it('healCollision defaults OFF — no ls-tree/cat-file heal probing on the legacy path', () => {
    const { run, calls } = scriptedRun({ ...MERGE_TREE_CLEAN, ...RESOLVED_PLUMBING });
    const r = rebaseDropManifest({ laneRef: 'lane/x-legacy', run });
    expect(r.action).toBe('rebased');
    expect(r.healed).toEqual([]);
    expect(calls.some((c) => c.args[0] === 'ls-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'cat-file')).toBe(false);
  });

  // IDEMPOTENCY (drain re-push churn bug). When the tip is ALREADY rebased on `base` AND already manifest-free, the rebuild is a
  // semantic no-op; minting a fresh commit + force-push churns the head SHA, restarts CI, and a green PR never
  // stays green long enough to merge. Short-circuit to `action:'current'` — commit-tree/push NOT invoked.
  const RESOLVED_TREE_OID = 'resolvedTree'.padEnd(40, '0');
  const TIP_COMMIT_OID = 'tipCommitSha'.padEnd(40, '0');
  // A rev-parse handler: `<ref>^{tree}` returns the given tree oid; the bare `<ref>` returns the tip commit oid.
  const revParse = (treeOid) => (args) =>
    String(args[1]).endsWith('^{tree}')
      ? { status: 0, stdout: treeOid + '\n' }
      : { status: 0, stdout: TIP_COMMIT_OID + '\n' };

  it('an already-rebased, manifest-free tip → action:current, NO commit-tree/push (no head churn)', () => {
    const { run, calls } = scriptedRun({
      ...MERGE_TREE_CLEAN,
      ...RESOLVED_PLUMBING,
      'merge-base': { status: 0 }, // base IS an ancestor of the tip → not behind
      'rev-parse': revParse(RESOLVED_TREE_OID), // tip's current tree already == the manifest-free resolvedTree
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-current', run });
    expect(r.action).toBe('current');
    expect(r.newCommit).toBe(TIP_COMMIT_OID);
    expect(r.base).toBe('origin/main');
    expect(r.laneRef).toBe('lane/x-current');
    // the ancestry probe must ask "is BASE an ancestor of the TIP" — arg order is `base` then `mergeRef`. A
    // flipped direction (`mergeRef base`) would answer the opposite question and mis-classify a behind tip as
    // current; the mock ignores args, so pin the order explicitly to catch that regression.
    const mb = calls.find((c) => c.args[0] === 'merge-base');
    expect(mb.args).toEqual(['merge-base', '--is-ancestor', 'origin/main', 'origin/lane/x-current']);
    // the whole point: nothing was minted and nothing was pushed.
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('a BEHIND tip (base is NOT an ancestor) still rebuilds + pushes → action:rebased', () => {
    const { run, calls } = scriptedRun({
      ...MERGE_TREE_CLEAN,
      ...RESOLVED_PLUMBING,
      'merge-base': { status: 1 }, // base is NOT an ancestor of the tip → the tip is behind
      'rev-parse': revParse(RESOLVED_TREE_OID), // even a matching tree must NOT short-circuit a behind tip
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-behind', run });
    expect(r.action).toBe('rebased');
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
  });

  it('a tip whose tree still carries the manifest (curTree ≠ resolvedTree) still rebuilds to drop it', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST]) }, // manifest-only conflict
      ...RESOLVED_PLUMBING,
      'merge-base': { status: 0 }, // on base…
      'rev-parse': revParse('staleTreeHasManifest'.padEnd(40, '0')), // …but the tip's tree still has the manifest
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-hasmanifest', run });
    expect(r.action).toBe('rebased');
    expect(r.dropped).toBe(true);
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
  });
});

// #x8pcbf3 — LIVE INCIDENT, PR #2752 (`lane/4034-critical-work-gate`, head `8e1f0c23d`). Read-only, reproduced
// against the real branch in `wev-review-daemon`: `.git/shallow` named that exact head sha as a shallow
// boundary (zero recorded parents) while `origin/main` in the SAME checkout was fully deepened, so
// `git merge-tree --write-tree origin/main origin/lane/4034-critical-work-gate` failed `fatal: refusing to
// merge unrelated histories` — a checkout defect (this newly-fetched ref inherited the checkout's shallow
// boundary), not a real conflict. `we:scripts/lib/git-run.mjs#ensureFullHistory` closes it: ONLY on a
// merge-tree failure that says "unrelated histories" does this pay for an `--is-shallow-repository` probe and
// — when shallow — a `fetch <remote> --unshallow`, then RETRIES the identical merge-tree call once. The
// ordinary happy path (a clean merge, or a real conflict) never runs the extra probe at all.
describe('rebaseDropManifest — shallow-checkout recovery (#x8pcbf3, PR #2752)', () => {
  // A `merge-tree` handler that fails "unrelated histories" on the FIRST call and answers `resolution` on every
  // call after — proving the SAME merge-tree call is retried, not merely logged.
  const unrelatedThenResolves = (resolution) => {
    let n = 0;
    return () => (n++ === 0 ? { status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' } : resolution);
  };

  it('merge-tree failing "unrelated histories" is fixed (unshallow) and RETRIED, then the rebuild proceeds normally', () => {
    const { run, calls } = scriptedRun({
      'rev-parse': { stdout: 'true\n' },
      fetch: { status: 0 },
      'merge-tree': unrelatedThenResolves({ status: 1, stdout: conflictOut([LANE_MANIFEST]) }),
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-shallow', run });
    expect(r.action).toBe('rebased');
    const order = calls.map((c) => c.args[0]);
    expect(order.filter((c) => c === 'merge-tree')).toHaveLength(2); // really retried, not just logged
    // the FIRST merge-tree call fails, THEN is-shallow is probed, THEN unshallowed, THEN merge-tree runs again.
    const firstMergeTree = order.indexOf('merge-tree');
    const revParseIdx = order.indexOf('rev-parse');
    const unshallowIdx = calls.findIndex((c) => c.args.includes('--unshallow'));
    const secondMergeTree = order.indexOf('merge-tree', firstMergeTree + 1);
    expect(revParseIdx).toBeGreaterThan(firstMergeTree);
    expect(unshallowIdx).toBeGreaterThan(revParseIdx);
    expect(secondMergeTree).toBeGreaterThan(unshallowIdx);
    expect(calls[unshallowIdx].args).toEqual(['fetch', 'origin', '--unshallow', '--quiet']);
  });

  it('an ORDINARY conflict never triggers the shallow-checkout recovery at all (no rev-parse, no retry)', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST, 'src/app.ts']) },
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-notshallow', run });
    expect(r.action).toBe('skip'); // a real conflict, untouched
    expect(calls.filter((c) => c.args[0] === 'merge-tree')).toHaveLength(1);
    expect(calls.some((c) => c.args[0] === 'rev-parse')).toBe(false);
    expect(calls.filter((c) => c.args[0] === 'fetch')).toHaveLength(1); // only the ordinary laneRef fetch
  });

  it('merge-tree STILL fails "unrelated histories" after a successful unshallow → reported as a checkout defect, not treated as a real conflict', () => {
    const { run } = scriptedRun({
      'rev-parse': { stdout: 'true\n' },
      fetch: { status: 0 },
      'merge-tree': { status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' },
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-still-shallow', run });
    expect(r.action).toBe('error'); // NOT 'skip' — never burns the caller's real-conflict handling
    expect(r.reason).toMatch(/checkout was shallow, was unshallowed, and the merge STILL failed/);
    expect(r.reason).toMatch(/genuinely unrelated-history pair/);
  });

  it('a checkout that is not shallow at all, with a genuine "unrelated histories" failure, is reported plainly (no unshallow attempted)', () => {
    const { run, calls } = scriptedRun({
      'rev-parse': { stdout: 'false\n' },
      'merge-tree': { status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' },
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-genuinely-unrelated', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/checkout is not shallow/);
    expect(calls.some((c) => c.args.includes('--unshallow'))).toBe(false);
  });

  it('the unshallow fetch itself fails → the failure reason is preserved in the surfaced error', () => {
    const { run } = scriptedRun({
      'rev-parse': { stdout: 'true\n' },
      fetch: (args) => (args.includes('--unshallow') ? { status: 1, stderr: 'fatal: could not read from remote repository\n' } : { status: 0 }),
      'merge-tree': { status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' },
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-unshallow-failed', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/could not be unshallowed \(fetch --unshallow failed \(fatal: could not read from remote repository\)\)/);
  });

  it('a merge-tree failure unrelated to history (a real error) is NOT given the shallow-checkout treatment', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: '', stderr: 'error: some other merge-tree failure\n' },
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-other-error', run });
    expect(r.action).toBe('error');
    expect(r.reason).not.toMatch(/checkout/);
    expect(calls.some((c) => c.args[0] === 'rev-parse')).toBe(false);
  });
});

// ── #4293 — the mechanical push refuses a branch another fixer holds the LIVE fix claim on ─────────────────
describe('rebaseDropManifest refuses to push onto a branch a fixer holds the LIVE fix claim on (#4293)', () => {
  let root;
  const priorRoot = process.env.WE_COORDINATION_ROOT;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'we-fix-claim-')); process.env.WE_COORDINATION_ROOT = root; });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (priorRoot === undefined) delete process.env.WE_COORDINATION_ROOT; else process.env.WE_COORDINATION_ROOT = priorRoot;
  });

  const REMOTE_URL = { status: 0, stdout: 'git@github.com:web-everything/web-everything.git\n' };

  it('a manifest-only conflict on a claimed lane is refused BEFORE the push — the invariant holds even though the PR is not draft', () => {
    acquireFixClaim({ repo: 'we', pr: 4293, who: 'fixer-4293', why: 'repairing a review finding', branch: 'lane/x-claimed', lockRoot: fixDispatchClaimRoot() });
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST]) },
      remote: REMOTE_URL,
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-claimed', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/holds the fix claim on PR #4293/);
    expect(r.reason).toMatch(/fixer-4293/);
    // the refusal sits AFTER commit-tree (pure, local, git-object-only — no remote effect) but BEFORE push (the
    // one call with a remote effect) — so commit-tree still runs, and that is fine; push must not.
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('the SAME lane, with no live claim, still rebases and pushes as before (no regression)', () => {
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST]) },
      remote: REMOTE_URL,
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-unclaimed', run });
    expect(r.action).toBe('rebased');
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
  });

  it('a DIFFERENT repo\'s branch of the same name is unaffected by a WE claim', () => {
    acquireFixClaim({ repo: 'we', pr: 4293, who: 'fixer-4293', branch: 'lane/x-shared-name', lockRoot: fixDispatchClaimRoot() });
    const { run, calls } = scriptedRun({
      'merge-tree': { status: 1, stdout: conflictOut([LANE_MANIFEST]) },
      remote: { status: 0, stdout: 'git@github.com:frontier-ui/frontierui.git\n' },
      ...RESOLVED_PLUMBING,
    });
    const r = rebaseDropManifest({ laneRef: 'lane/x-shared-name', run });
    expect(r.action).toBe('rebased');
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
  });
});
