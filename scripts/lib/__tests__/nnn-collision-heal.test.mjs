/**
 * @file scripts/lib/__tests__/nnn-collision-heal.test.mjs
 * @description Proof of the shared merge-TIME NNN-collision self-heal (#2222) — the pre-check analogue of the
 *   drain's rebase-drop. The pure PLAN is decided here (collision-on-base ⇒ renumber the incoming new item to a
 *   free GAP id below the max+1 frontier, rewrite inbound refs; no-collision ⇒ untouched); the git plumbing is
 *   the injected-`run` I/O boundary, its SEQUENCE (detect cheaply, then read/rebuild only on a real collision)
 *   asserted with a scripted runner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobOid } from '../git-run.mjs';
import { allocateGapId, rewriteRefs, assertContentPreserved } from '../../backlog/renumber-collisions.mjs';
import { planBaseCollisionHeal, backlogBasenames, healNnnCollision, writePlanToIndex } from '../nnn-collision-heal.mjs';
import { acquireFixClaim } from '../../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot } from '../../conveyor/fix-claim-store.mjs';

const mk = (num, slug, body = '') => ({
  name: `${num}-${slug}.md`,
  text: `---\nkind: story\nsize: 3\nstatus: active\ndateOpened: "2026-07-04"\ntags: []\n---\n\n# ${slug}\n\n${body}\n`,
});

describe('allocateGapId (#2222 — a GAP below the max+1 frontier a concurrent scaffold owns)', () => {
  it('takes the highest free slot below max, not max+1', () => {
    // used 2218,2219,2221 → the hole nearest the frontier is 2220 (2222 is what a scaffold would grab).
    expect(allocateGapId(new Set(['2218', '2219', '2221']))).toBe('2220');
  });
  it('never re-uses a base id, and skips an already-allocated gap', () => {
    // max 2224; 2223 is the highest free slot below it (2220 base-owned, 2221/2222 used).
    expect(allocateGapId(new Set(['2218', '2221', '2222', '2224']), new Set(), new Set(['2220', '2219']))).toBe('2223');
    // 2223 is the highest free slot below max 2224 (2220 already handed out this plan).
    expect(allocateGapId(new Set(['2218', '2219', '2221', '2222', '2224']), new Set(['2220']), new Set())).toBe('2223');
  });
  it('a range dense at the top has no hole below max → falls back to the frontier (max+1)', () => {
    expect(allocateGapId(new Set(['2218', '2219', '2220']))).toBe('2221');
  });
  it('keeps zero-padding to the widest id', () => {
    expect(allocateGapId(new Set(['007', '009']))).toBe('008');
  });
});

describe('backlogBasenames', () => {
  it('extracts NNN-slug.md basenames from ls-tree output (with or without the backlog/ prefix)', () => {
    expect(backlogBasenames('backlog/2218-a.md\nbacklog/2219-b-c.md\nREADME.md')).toEqual(['2218-a.md', '2219-b-c.md']);
    expect(backlogBasenames('2218-a.md\n')).toEqual(['2218-a.md']);
    expect(backlogBasenames('')).toEqual([]);
  });
});

describe('planBaseCollisionHeal — collision on base ⇒ renumber-to-gap', () => {
  it('renumbers the incoming lane new-item to a GAP id and rewrites inbound refs; the base file is untouched', () => {
    // Base carries #2219 (a DIFFERENT item) plus a 2220 hole. The lane authored its OWN #2219 (drain finding),
    // colliding on the number, and another lane item references it via every shape.
    const laneFiles = [
      mk('2219', 'drain-finding', 'the storm-collision finding'),
      {
        name: '1800-refs.md',
        text: 'see #2219 and /backlog/2219/ and /backlog/2219-drain-finding/\nblockedBy: [2219]\n',
      },
    ];
    const plan = planBaseCollisionHeal(laneFiles, {
      baseNums: ['2218', '2219', '2221'],                 // 2220 is a free interior gap
      baseNames: ['2218-x.md', '2219-existing-item.md', '2221-z.md'],
    });
    expect(plan.collisions).toHaveLength(1);
    const mv = plan.collisions[0];
    expect(mv.oldNum).toBe('2219');
    expect(mv.newNum).toBe('2220');                       // a GAP below the 2222 frontier, not max+1
    expect(mv.oldName).toBe('2219-drain-finding.md');
    expect(mv.newName).toBe('2220-drain-finding.md');
    expect(plan.deletes).toEqual(['2219-drain-finding.md']);
    // the referencing lane file now points at the gap id
    const ref = plan.writes.find((w) => w.name === '1800-refs.md');
    expect(ref.text).toContain('#2220');
    expect(ref.text).toContain('/backlog/2220/');
    expect(ref.text).toContain('/backlog/2220-drain-finding/');
    expect(ref.text).toContain('blockedBy: [2220]');
    // the yielded file is re-filed under its new name
    expect(plan.writes.map((w) => w.name)).toContain('2220-drain-finding.md');
  });

  it('EDGE-CLOBBER GUARD (#2316): a base-owned file\'s unrelated blockedBy edge is left alone', () => {
    // The base carries #2293 (real keeper) and #2294 (an unrelated real item that legitimately
    // `blockedBy: [2293]`, authored long before this lane) — both inherited into laneFiles unmodified. The
    // lane's OWN new item also landed as #2293 and must yield to a gap id — but the sweep must never follow
    // #2294's real, pre-existing edge to the yielder's new id; that edge means the base keeper, not the lane.
    const laneFiles = [
      mk('2293', 'base-keeper', 'the real, long-standing item'),          // base-owned, unmodified
      { name: '2294-dependent.md', text: 'depends on the keeper\nblockedBy: [2293]\n' }, // base-owned, unmodified
      mk('2293', 'lane-new-item', 'the lane authored this and it collides'), // lane's own new file — yields
    ];
    const plan = planBaseCollisionHeal(laneFiles, {
      baseNums: ['2290', '2293', '2294'],
      baseNames: ['2290-x.md', '2293-base-keeper.md', '2294-dependent.md'],
    });
    expect(plan.collisions).toHaveLength(1);
    const mv = plan.collisions[0];
    expect(mv.oldNum).toBe('2293');
    expect(mv.oldName).toBe('2293-lane-new-item.md');
    // the base-owned #2294's real edge to the keeper #2293 is NOT touched at all.
    expect(plan.writes.map((w) => w.name)).not.toContain('2294-dependent.md');
  });

  it('CONTENT-PRESERVING (#2546): a base-collision renumber keeps every authored body byte, only the ref changes', () => {
    // Mirrors the renumber-collisions.test.mjs #2546 regression: the #558 land BLANKED files while rewriting
    // cross-refs — the real damage was data loss, not the collision. This module's writes must go through
    // the SAME assertContentPreserved guard so a rewrite bug here fails loudly instead of shipping an
    // empty/partial file.
    const body = 'A long authored body.\n\nSecond paragraph with detail worth keeping.\nSee #2219 for context.';
    const laneFiles = [
      mk('2219', 'drain-finding', 'the storm-collision finding'),
      { name: '1800-refs.md', text: `---\nkind: story\n---\n\n# refs\n\n${body}\n` },
    ];
    const plan = planBaseCollisionHeal(laneFiles, {
      baseNums: ['2218', '2219', '2221'],
      baseNames: ['2218-x.md', '2219-existing-item.md', '2221-z.md'],
    }); // does NOT throw — every write is content-preserving
    const ref = plan.writes.find((w) => w.name === '1800-refs.md');
    // the ONLY change is the ref swap; every other authored byte survives verbatim
    expect(ref.text).toBe(laneFiles[1].text.replace('#2219', '#2220'));
    expect(ref.text).toContain('Second paragraph with detail worth keeping.');
    // the yielded file is re-filed with its full body intact
    const yielded = plan.writes.find((w) => w.name === '2220-drain-finding.md');
    expect(yielded.text).toContain('the storm-collision finding');
    expect(yielded.text.length).toBeGreaterThan(0);
  });

  it('CONTENT-PRESERVING (#2546): a corrupted rewrite (non-ref byte altered) is refused loudly', () => {
    // Simulate a broken rewrite by hand-corrupting what the sweep would produce, then feeding it through the
    // SAME guard planBaseCollisionHeal uses, proving the guard actually catches a #558-style silent corruption
    // rather than the plan happily returning a bad write.
    const original = '---\nkind: story\n---\n\n# drain-finding\n\nAuthored body.\nSee #2219.\n';
    const good = rewriteRefs(original, '2219', '2220', 'drain-finding');
    const tampered = good.replace('Authored body.', 'Tampered body.');
    const moves = [{ oldNum: '2219', newNum: '2220', slug: 'drain-finding' }];
    // planBaseCollisionHeal itself only ever produces `good` (proved above); this asserts the SAME guard the
    // module wires in (assertContentPreserved, exercised indirectly above) would reject a corrupted variant.
    expect(() => assertContentPreserved(original, tampered, moves, '2220-drain-finding.md')).toThrow(/#2546/);
  });

  it('CONTENT-PRESERVING (#2746 review): a swept file that ALREADY references the gap id still plans cleanly', () => {
    // `allocateGapId` recycles a HOLE below the frontier — precisely the ids stale `#NNN` refs still point at
    // (88 such dangling in-range refs live in backlog/ today). With the naive mask the source side masked ONE
    // occurrence and the result side TWO, so this byte-perfect rewrite was refused as "corruption" and — via
    // the throw — took the whole drain pass down with it. It must plan, swapping ONLY the yielded ref.
    const laneFiles = [
      mk('2219', 'drain-finding', 'the storm-collision finding'),
      { name: '1800-refs.md', text: '---\nkind: story\n---\n\n# refs\n\nSee #2219 for context; supersedes #2220.\n' },
    ];
    const plan = planBaseCollisionHeal(laneFiles, {
      baseNums: ['2218', '2219', '2221'],
      baseNames: ['2218-x.md', '2219-existing.md', '2221-z.md'],
    });
    expect(plan.collisions[0].newNum).toBe('2220');                        // the gap id IS the pre-referenced one
    const ref = plan.writes.find((w) => w.name === '1800-refs.md');
    expect(ref.text).toContain('See #2220 for context; supersedes #2220.'); // only the yielded ref moved
    expect(ref.text).toBe(laneFiles[1].text.replace('#2219', '#2220'));     // every other byte survives
  });

  it('two incoming collisions get distinct gap ids (no re-collision within the plan)', () => {
    const laneFiles = [mk('2219', 'a'), mk('2221', 'b')];
    const plan = planBaseCollisionHeal(laneFiles, {
      baseNums: ['2218', '2219', '2221', '2225'],         // holes: 2220, 2222, 2223, 2224
      baseNames: ['2218-x.md', '2219-keep.md', '2221-keep.md', '2225-z.md'],
    });
    const newNums = plan.collisions.map((c) => c.newNum);
    expect(new Set(newNums).size).toBe(2);
    expect(newNums).toEqual(['2224', '2223']);            // the two highest gaps below max (distinct, no re-collision)
  });
});

describe('planBaseCollisionHeal — no collision ⇒ untouched', () => {
  it('a lane new-item with a fresh id (not on base) is left alone', () => {
    const laneFiles = [mk('2230', 'fresh-item', 'no clash')];
    const plan = planBaseCollisionHeal(laneFiles, { baseNums: ['2218', '2219'], baseNames: ['2218-x.md', '2219-y.md'] });
    expect(plan.collisions).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.summary).toMatch(/no-op/i);
  });
  it('a lane file that IS the base file (same num AND same name) is a keeper, never yielded', () => {
    const laneFiles = [mk('2219', 'existing-item', 'edited on the lane')];
    const plan = planBaseCollisionHeal(laneFiles, { baseNums: ['2219'], baseNames: ['2219-existing-item.md'] });
    expect(plan.collisions).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });
});

// A scripted `run` that returns canned results per git subcommand and records the call sequence.
function scriptedRun(script) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, input: opts?.input });
    const key = args[0];
    const handler = script[key];
    const res = typeof handler === 'function' ? handler(args, opts) : handler;
    return { status: 0, stdout: '', stderr: '', ...(res || {}) };
  };
  return { run, calls };
}

describe('healNnnCollision — git boundary sequence', () => {
  it('no collision → action:none, reads NOTHING beyond the two ls-trees (cheap common path)', () => {
    const { run, calls } = scriptedRun({
      fetch: { status: 0 },
      'ls-tree': (args) => ({ status: 0, stdout: args.includes('origin/main') ? 'backlog/2218-a.md\nbacklog/2219-b.md\n' : 'backlog/2230-fresh.md\n' }),
    });
    const r = healNnnCollision({ laneRef: 'lane/x-2222', run });
    expect(r.action).toBe('none');
    // never paid to read file contents / rebuild
    expect(calls.some((c) => c.args[0] === 'cat-file')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'commit-tree')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });

  it('collision → rebuilds a renumbered tip and pushes it to the bare lane ref', () => {
    const laneName = '2219-drain-finding.md';
    const { run, calls } = scriptedRun({
      fetch: { status: 0 },
      'ls-tree': (args) => ({ status: 0, stdout: args.includes('origin/main') ? 'backlog/2218-a.md\nbacklog/2219-existing.md\nbacklog/2221-c.md\n' : `backlog/${laneName}\n` }),
      'cat-file': { status: 0, stdout: mk('2219', 'drain-finding', 'x').text },
      'read-tree': { status: 0 },
      // #2923 — hash the stdin we ACTUALLY receive, like git does. A canned oid here is what let the
      // renumber path stage git's empty blob (`adf2d758`, repaired by `14432ba9`) with every test green.
      'hash-object': (_a, o) => ({ status: 0, stdout: gitBlobOid(o?.input ?? '') + '\n' }),
      'update-index': { status: 0 },
      rm: { status: 0 },
      'write-tree': { status: 0, stdout: 'tree'.padEnd(40, '0') + '\n' },
      'commit-tree': { status: 0, stdout: 'newCommit'.padEnd(40, '0') + '\n' },
      push: { status: 0 },
    });
    const r = healNnnCollision({ laneRef: 'lane/x-2222', run });
    expect(r.action).toBe('rebased');
    expect(r.renumbered).toEqual([{ oldNum: '2219', newNum: '2220', oldName: laneName, newName: '2220-drain-finding.md' }]);
    // commit-tree parents the lane tip (single parent → push is a fast-forward).
    const ct = calls.find((c) => c.args[0] === 'commit-tree');
    expect(ct.args.slice(0, 5)).toEqual(['commit-tree', 'tree'.padEnd(40, '0'), '-p', 'origin/lane/x-2222', '-m']);
    // pushes the rebuilt commit to the BARE lane ref (guard-safe, no checkout).
    const push = calls.find((c) => c.args[0] === 'push');
    expect(push.args).toEqual(['push', 'origin', 'newCommit'.padEnd(40, '0') + ':refs/heads/lane/x-2222']);
    // the new blob was written to a TEMP index (GIT_INDEX_FILE set on update-index), never the working tree.
    const up = calls.find((c) => c.args[0] === 'update-index');
    expect(up.env?.GIT_INDEX_FILE).toBeTruthy();
  });

  it('no laneRef → error', () => {
    expect(healNnnCollision({ run: () => ({ status: 0 }) }).action).toBe('error');
  });

  it('a failed fetch → error, no ls-tree/push', () => {
    const { run, calls } = scriptedRun({ fetch: { status: 1, stderr: 'fatal: no ref' } });
    const r = healNnnCollision({ laneRef: 'lane/gone', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/fetch/);
    expect(calls.some((c) => c.args[0] === 'ls-tree')).toBe(false);
  });
});

// ── #4293 — the mechanical push refuses a branch another fixer holds the LIVE fix claim on ─────────────────
describe('healNnnCollision refuses to push onto a branch a fixer holds the LIVE fix claim on (#4293)', () => {
  let root;
  const priorRoot = process.env.WE_COORDINATION_ROOT;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'we-fix-claim-')); process.env.WE_COORDINATION_ROOT = root; });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (priorRoot === undefined) delete process.env.WE_COORDINATION_ROOT; else process.env.WE_COORDINATION_ROOT = priorRoot;
  });

  it('a real collision on a claimed lane is refused before the push', () => {
    acquireFixClaim({ repo: 'we', pr: 4293, who: 'fixer-4293', branch: 'lane/x-2222-claimed', lockRoot: fixDispatchClaimRoot() });
    const laneName = '2219-drain-finding.md';
    const { run, calls } = scriptedRun({
      fetch: { status: 0 },
      'ls-tree': (args) => ({ status: 0, stdout: args.includes('origin/main') ? 'backlog/2218-a.md\nbacklog/2219-existing.md\nbacklog/2221-c.md\n' : `backlog/${laneName}\n` }),
      'cat-file': { status: 0, stdout: mk('2219', 'drain-finding', 'x').text },
      'read-tree': { status: 0 },
      'hash-object': (_a, o) => ({ status: 0, stdout: gitBlobOid(o?.input ?? '') + '\n' }),
      'update-index': { status: 0 },
      rm: { status: 0 },
      'write-tree': { status: 0, stdout: 'tree'.padEnd(40, '0') + '\n' },
      'commit-tree': { status: 0, stdout: 'newCommit'.padEnd(40, '0') + '\n' },
      remote: { status: 0, stdout: 'git@github.com:web-everything/web-everything.git\n' },
      push: { status: 0 },
    });
    const r = healNnnCollision({ laneRef: 'lane/x-2222-claimed', run });
    expect(r.action).toBe('error');
    expect(r.reason).toMatch(/holds the fix claim on PR #4293/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});

// ── #2923 — the renumber write-back, the instance that actually reached `main` ───────────────────────────

describe('writePlanToIndex verifies what it staged (#2923)', () => {
  const plan = { writes: [{ name: '2220-drain-finding.md', text: '---\nkind: story\n---\n# real content\n' }], deletes: [] };
  const env = { GIT_INDEX_FILE: '.git/tmp-index' };

  it('a runner that drops `input` → error naming the empty stdin, and NOTHING is staged', () => {
    // This is `adf2d758` — "drain: rebase … renumber #2362→#2309" — which staged git's empty blob for the
    // renumbered card, landed on `main`, and had to be hand-repaired by `14432ba9` ("restore #2309 story
    // content emptied by the #2362->#2309 renumber"). Same root cause as the content resolver: the injected
    // runner named neither `input` nor `encoding`, so `hash-object --stdin` read EOF and exited 0.
    const calls = [];
    const run = (cmd, args, { env: e, cwd } = {}) => { // NOTE: no `input` — the bug, verbatim
      calls.push(args[0]);
      if (args[0] === 'hash-object') return { status: 0, stdout: gitBlobOid('') + '\n' };
      return { status: 0, stdout: '' };
    };
    const err = writePlanToIndex(run, env, plan);
    expect(err).toMatch(/EMPTY stdin/);
    expect(err).toMatch(/#2923/);
    expect(calls).not.toContain('update-index');
  });

  it('a correct runner stages the real blob id of the renumbered content', () => {
    const staged = [];
    const run = (cmd, args, opts = {}) => {
      if (args[0] === 'hash-object') return { status: 0, stdout: gitBlobOid(opts.input ?? '') + '\n' };
      if (args[0] === 'update-index') staged.push(args[args.indexOf('--cacheinfo') + 1]);
      return { status: 0, stdout: '' };
    };
    expect(writePlanToIndex(run, env, plan)).toBeNull();
    expect(staged).toEqual([`100644,${gitBlobOid(plan.writes[0].text)},backlog/2220-drain-finding.md`]);
  });

  it('#2923 — a `cwd` reaches every git call, so a sibling-clone heal cannot write to the wrong repo', () => {
    const seen = new Set();
    const run = (cmd, args, opts = {}) => {
      seen.add(`${args[0]}:${opts.cwd}`);
      if (args[0] === 'hash-object') return { status: 0, stdout: gitBlobOid(opts.input ?? '') + '\n' };
      return { status: 0, stdout: '' };
    };
    writePlanToIndex(run, env, { ...plan, deletes: ['2219-drain-finding.md'] }, { cwd: '/repos/frontierui' });
    expect(seen).toContain('hash-object:/repos/frontierui');
    expect(seen).toContain('update-index:/repos/frontierui');
    expect(seen).toContain('rm:/repos/frontierui');
  });
});
