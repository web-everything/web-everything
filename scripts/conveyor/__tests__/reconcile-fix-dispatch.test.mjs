/**
 * @file scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs — #3438: dispatch the fix agent
 *   `reconcile-pass.mjs` decides is owed for a bounced PR nothing live is working.
 *
 * NOTHING HERE SPAWNS A REAL PROCESS OR TOUCHES `gh`/`git`: every IO seam is injected (`spawnAgent`, `readBrief`,
 * `mintSessionId`, `pickFreeLanes`, `loadItems`, `checkStaleness`, `reconcile`), mirroring
 * `we:scripts/operations/__tests__/review-dispatch.test.mjs`'s own style for the sibling operation this file's
 * `dispatchFix` composition was mirrored from.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dispatchFix, fetchCardScopeAtRef, fetchPrDiffPaths, fetchPrDiffScope, fixBriefPath, freeLaneNumbers, isSafeFallbackScopeEntry, planFixesFromReconcile, runReconcileFixDispatch,
  findResumeCandidate, buildResumePrompt, tryResumeFix,
} from '../reconcile-fix-dispatch.mjs';
import { CONFLICT_LABEL } from '../parked-pr-conflict-watch.mjs';
import { DISPATCHED_AGENT_SYSTEM_PROMPT_FILE } from '../../operations/dispatch-lane-io.mjs';
import { buildAuthorActorMarker } from '../../lib/review-independence.mjs';

// A `checkStaleness` stub that never touches git — every test below injects one.
const FRESH = () => ({ fresh: true, behind: 0 });

const REAL_TEMPLATE_STUB = [
  '# fix brief for {{PR_NUM}} (item {{ITEM_NUM}})',
  'acquire: node scripts/lane-pool.mjs acquire --lane={{LANE}} --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}',
  'this brief documents {{LIKE_THIS}} as an example convention, not a real token',
].join('\n');

const item3438 = { num: '3438', slug: 'wire-reconcile-pass', specPath: 'backlog/3438-wire-reconcile-pass.md', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'] };
const findItemStub = (key, _loadItems) => (key === '3438' ? item3438 : null);

describe('planFixesFromReconcile', () => {
  it('narrows to `kind:\'fix\'` entries and plans one per dispatchable PR', () => {
    const entries = [
      { kind: 'review', prNumber: 1, headRefName: 'lane/1-x' },
      { kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass' },
    ];
    const { planned, refusals } = planFixesFromReconcile(entries, findItemStub, () => []);
    expect(refusals).toEqual([]);
    expect(planned).toEqual([{
      itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: item3438.scope, scopeSource: 'item',
      isConflict: false, body: null, headRefOid: null,
    }]);
  });

  it('#xu2krte — a `fix` entry still carrying the conflict-watch label plans `isConflict: true` and threads `body`/`headRefOid`', () => {
    const entries = [{
      kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass',
      labels: [CONFLICT_LABEL, 'review:pending'], body: 'a PR body', headRefOid: 'deadbeef'.repeat(5),
    }];
    const { planned } = planFixesFromReconcile(entries, findItemStub, () => []);
    expect(planned).toEqual([{
      itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: item3438.scope, scopeSource: 'item',
      isConflict: true, body: 'a PR body', headRefOid: 'deadbeef'.repeat(5),
    }]);
  });

  // #xmtbdgs multi-repo slice 6 — `no-item-num` is GONE: a PR whose head ref carries no conveyor item number is
  // now attributed to the PR itself (ratified `#conveyor-multi-repo-model` clause 3), scoped by its own diff.
  it('a PR whose head ref carries no conveyor item number is attributed to the PR itself, scoped by its own diff (no longer refused)', () => {
    const entries = [{ kind: 'fix', prNumber: 42, headRefName: 'some-hand-opened-branch' }];
    const diffCalls = [];
    const fetchItemlessDiffPaths = (pr) => { diffCalls.push(pr); return ['src/x.ts', 'src/y.ts']; };
    const { planned, refusals } = planFixesFromReconcile(entries, findItemStub, () => [], () => [], 'we', fetchItemlessDiffPaths);
    expect(diffCalls).toEqual([42]);
    expect(refusals).toEqual([]);
    expect(planned).toEqual([{
      itemNum: null, pr: 42, laneRef: 'some-hand-opened-branch',
      scope: ['we:src/x.ts', 'we:src/y.ts'], scopeSource: 'pr-diff',
      isConflict: false, body: null, headRefOid: null,
    }]);
  });

  it('an item-less PR whose own diff is ALSO empty still refuses `no-scope` — no fence at all is undispatchable', () => {
    const entries = [{ kind: 'fix', prNumber: 42, headRefName: 'some-hand-opened-branch' }];
    const { planned, refusals } = planFixesFromReconcile(entries, findItemStub, () => [], () => [], 'we', () => []);
    expect(planned).toEqual([]);
    expect(refusals).toEqual([{ pr: 42, kind: 'no-scope', why: expect.stringContaining('names no backlog item') }]);
  });

  it('an item-less PR never calls `findItemFn` at all — the resolver\'s own `laneRefItemNum` re-check finds nothing to look up', () => {
    const findCalls = [];
    const findItemSpy = (key) => { findCalls.push(key); return null; };
    const entries = [{ kind: 'fix', prNumber: 42, headRefName: 'some-hand-opened-branch' }];
    planFixesFromReconcile(entries, findItemSpy, () => [], () => [], 'we', () => ['src/x.ts']);
    expect(findCalls).toEqual([]);
  });

  it('refuses `no-scope` for an item the loader cannot resolve, or one with an empty scope, when the fallback ALSO finds nothing', () => {
    const entries = [{ kind: 'fix', prNumber: 99, headRefName: 'lane/9999-ghost' }];
    const { planned, refusals } = planFixesFromReconcile(entries, () => null, () => [], () => []);
    expect(planned).toEqual([]);
    expect(refusals).toEqual([{ pr: 99, kind: 'no-scope', why: expect.stringContaining('no declared scope') }]);
  });

  it('ignores non-`fix` entries entirely (a `review` entry is someone else\'s job)', () => {
    const { planned, refusals } = planFixesFromReconcile([{ kind: 'review', prNumber: 1, headRefName: 'lane/1-x' }], findItemStub, () => []);
    expect(planned).toEqual([]);
    expect(refusals).toEqual([]);
  });

  // #3634 — real root-cause fixtures: two PRs (#2210, #2220 on `lane/mechanical-dispatcher`) reported as
  // silently refused by reconcile-fix-dispatch despite clearly needing a fix. Both were independently
  // re-verified live on 2026-09-14 (see the function's own docblock for the full evidence) and turned out to be
  // TWO GENUINELY DIFFERENT shapes, not one shared regex bug:
  describe('#3634 — PR #2220-shaped: item number resolves to an epic with no scope of its own', () => {
    const epic3383 = { num: '3383', slug: 'a-background-mechanical-dispatcher-replaces-the-interactive', specPath: 'backlog/3383-x.md', scope: [] };
    const findEpicStub = (key) => (key === '3383' ? epic3383 : null);

    it('falls back to the PR\'s own changed files (we:-prefixed) instead of refusing `no-scope`', () => {
      const entries = [{ kind: 'fix', prNumber: 2220, headRefName: 'lane/3383-host-process-granularity', labels: ['review:changes', 'checking', 'merge-status:conflicting'] }];
      const calls = [];
      const resolveFallbackScope = (pr, itemNum) => {
        calls.push({ pr, itemNum });
        return ['we:scripts/operations/host-process-sample.mjs', 'we:scripts/operations/telemetry.mjs'];
      };
      const { planned, refusals } = planFixesFromReconcile(entries, findEpicStub, () => [], resolveFallbackScope);
      expect(refusals).toEqual([]);
      expect(calls).toEqual([{ pr: 2220, itemNum: '3383' }]);
      expect(planned).toEqual([{
        itemNum: '3383', pr: 2220, laneRef: 'lane/3383-host-process-granularity',
        scope: ['we:scripts/operations/host-process-sample.mjs', 'we:scripts/operations/telemetry.mjs'],
        scopeSource: 'pr-diff', isConflict: true, body: null, headRefOid: null,
      }]);
    });

    it('still refuses `no-scope` when the epic has no scope AND the PR-diff fallback also comes back empty', () => {
      const entries = [{ kind: 'fix', prNumber: 2220, headRefName: 'lane/3383-host-process-granularity' }];
      const { planned, refusals } = planFixesFromReconcile(entries, findEpicStub, () => [], () => []);
      expect(planned).toEqual([]);
      expect(refusals).toEqual([{ pr: 2220, kind: 'no-scope', why: expect.stringContaining('changed-file fallback found nothing') }]);
    });

    it('never even calls the fallback when the item already carries a real scope (no wasted IO)', () => {
      const calls = [];
      const entries = [{ kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass' }];
      planFixesFromReconcile(entries, findItemStub, () => [], () => { calls.push(1); return ['we:should/not/be/used.mjs']; });
      expect(calls).toEqual([]);
    });

    it('isolates a THROWING fallback to a `no-scope` refusal, not a crash of the whole pass', () => {
      const entries = [{ kind: 'fix', prNumber: 2220, headRefName: 'lane/3383-host-process-granularity' }];
      const { planned, refusals } = planFixesFromReconcile(entries, findEpicStub, () => [], () => { throw new Error('gh unreachable'); });
      expect(planned).toEqual([]);
      expect(refusals).toEqual([{ pr: 2220, kind: 'no-scope', why: expect.stringContaining('changed-file fallback found nothing') }]);
    });
  });

  describe('#3634 review — fallback is gated on a RESOLVED item and filters hostile filenames', () => {
    const epic3383 = { num: '3383', slug: 's', specPath: 'backlog/3383-x.md', scope: [] };
    const findEpicStub = (key) => (key === '3383' ? epic3383 : null);

    it('refuses `no-scope` for an UNRESOLVABLE item even when the fallback has files, and never calls the fallback', () => {
      const calls = [];
      const entries = [{ kind: 'fix', prNumber: 99, headRefName: 'lane/9999-ghost' }];
      const { planned, refusals } = planFixesFromReconcile(entries, () => null, () => [], () => { calls.push(1); return ['we:some/file.mjs']; });
      expect(calls).toEqual([]);
      expect(planned).toEqual([]);
      expect(refusals).toEqual([{ pr: 99, kind: 'no-scope', why: expect.stringContaining('no declared scope') }]);
    });

    it('drops hostile PR-diff filenames from the fence instead of passing them into the brief', () => {
      const entries = [{ kind: 'fix', prNumber: 2220, headRefName: 'lane/3383-host-process-granularity' }];
      const fallback = () => ['we:ok/file.mjs', 'we:x,we:scripts', 'we:a b.md', 'we:../escape.mjs', 'we:dir/*.mjs', 'we:bad\nname.md', 'we:/abs.mjs'];
      const { planned, refusals } = planFixesFromReconcile(entries, findEpicStub, () => [], fallback);
      expect(refusals).toEqual([]);
      expect(planned[0].scope).toEqual(['we:ok/file.mjs']);
      expect(planned[0].scopeSource).toBe('pr-diff');
    });

    it('refuses `no-scope` when EVERY fallback filename is hostile', () => {
      const entries = [{ kind: 'fix', prNumber: 2220, headRefName: 'lane/3383-host-process-granularity' }];
      const { planned, refusals } = planFixesFromReconcile(entries, findEpicStub, () => [], () => ['we:x,we:scripts']);
      expect(planned).toEqual([]);
      expect(refusals).toEqual([{ pr: 2220, kind: 'no-scope', why: expect.stringContaining('changed-file fallback found nothing') }]);
    });

    it('isSafeFallbackScopeEntry accepts ordinary repo paths and rejects comma/space/control/`..`/glob/leading-slash', () => {
      for (const ok of ['we:scripts/conveyor/a-b_c.mjs', 'we:docs/x.v2.md', 'we:.github/workflows/ci.yml']) expect(isSafeFallbackScopeEntry(ok)).toBe(true);
      for (const bad of ['we:x,we:scripts', 'we:a b', 'we:a\tb', 'we:a\u0000b', 'we:a/../b', 'we:a/*.js', 'we:a/{b,c}', 'we:a/[b]', 'we:/abs', 'we:', '', null]) expect(isSafeFallbackScopeEntry(bad)).toBe(false);
    });
  });

  describe('#3634 — PR #2210-shaped: a `lane/file-<PR-reviewed>-...` branch — CONFIRMED NOT the same bug as #2220', () => {
    // #xmtbdgs multi-repo slice 6 — `no-item-num` is gone, so this shape is no longer hard-refused either; it
    // is item-less (2206 is never extracted as an item number — `lane/file-...` doesn't match the lane-ref
    // grammar at all) and now goes through the SAME PR-attribution path as any other item-less PR. The
    // #3634 lesson survives in a stronger form: `findItemFn` is STILL never consulted with "2206" (or anything
    // else) for this shape, so it can never be fooled into stamping the wrong item's number — there is simply
    // no item-number extraction attempted here at all any more.
    it('`lane/file-2206-review-findings` is attributed to the PR itself, never to backlog item #2206 (a real, unrelated card)', () => {
      const entries = [{ kind: 'fix', prNumber: 2210, headRefName: 'lane/file-2206-review-findings', labels: ['review:changes', 'checking', 'merge-status:conflicting'] }];
      const findCalls = [];
      const findItemSpy = (key) => { findCalls.push(key); return null; };
      const { planned, refusals } = planFixesFromReconcile(entries, findItemSpy, () => [], () => ['we:should/not/be/used.mjs'], 'we', () => ['scripts/file-review-findings.mjs']);
      expect(findCalls).toEqual([]); // never looked up "2206" — no item-number extraction is attempted at all
      expect(refusals).toEqual([]);
      expect(planned).toEqual([{
        itemNum: null, pr: 2210, laneRef: 'lane/file-2206-review-findings',
        scope: ['we:scripts/file-review-findings.mjs'], scopeSource: 'pr-diff',
        isConflict: true, body: null, headRefOid: null,
      }]);
    });
  });

  // #xcla4iv — the standard file-item-in-PR workflow: the card and the code that delivers it land in the SAME
  // PR, so `findItemFn` (which reads only `main`) misses it, but the PR's own diff carries the card. Live case:
  // `chalbert/web-everything` PR #2553 (branch `lane/xzi292i-stuck-pr-watch`) — the daemon refused it `no-scope`
  // on every tick despite the card's own real `scope:` frontmatter sitting right there in the diff.
  describe('#xcla4iv — an item whose card is filed IN this PR, not yet on `main`', () => {
    it('is dispatched with the card\'s own scope (read at the PR head), never refused `no-scope`', () => {
      const entries = [{ kind: 'fix', prNumber: 2553, headRefName: 'lane/xzi292i-stuck-pr-watch', headRefOid: 'deadbeef'.repeat(5) }];
      const diffCalls = [];
      const cardCalls = [];
      const fetchItemlessDiffPaths = (pr) => {
        diffCalls.push(pr);
        // the real PR #2553's full diff carries both files; this fixture lists both so the containment guard
        // (review findings, chalbert/web-everything#2573) doesn't spuriously drop a real, legitimately-in-diff
        // card-scope entry.
        return ['backlog/xzi292i-stuck-pr-watch-launch-a-diagnosis-only-inspection-agent-when.md', 'scripts/conveyor/stuck-pr-watch-core.mjs', 'scripts/conveyor/stuck-pr-watch.mjs'];
      };
      const resolveCardScopeAtRef = (path, ref) => {
        cardCalls.push({ path, ref });
        return ['we:scripts/conveyor/stuck-pr-watch-core.mjs', 'we:scripts/conveyor/stuck-pr-watch.mjs'];
      };
      const { planned, refusals } = planFixesFromReconcile(
        entries, () => null, () => [], () => [], 'we', fetchItemlessDiffPaths, resolveCardScopeAtRef,
      );
      expect(diffCalls).toEqual([2553]);
      expect(cardCalls).toEqual([{
        path: 'backlog/xzi292i-stuck-pr-watch-launch-a-diagnosis-only-inspection-agent-when.md',
        ref: 'deadbeef'.repeat(5),
      }]);
      expect(refusals).toEqual([]);
      expect(planned).toEqual([{
        itemNum: 'xzi292i', pr: 2553, laneRef: 'lane/xzi292i-stuck-pr-watch',
        scope: ['we:scripts/conveyor/stuck-pr-watch-core.mjs', 'we:scripts/conveyor/stuck-pr-watch.mjs'],
        scopeSource: 'item', isConflict: false, body: null, headRefOid: 'deadbeef'.repeat(5),
      }]);
    });

    it('falls back to the PR\'s own (filtered) diff paths when the card itself declares no `scope:`', () => {
      const entries = [{ kind: 'fix', prNumber: 61, headRefName: 'lane/xabc123-new-thing', headRefOid: 'cafe'.repeat(10) }];
      const fetchItemlessDiffPaths = () => ['backlog/xabc123-new-thing.md', 'src/Thing.tsx', 'we:x,we:scripts'];
      const { planned, refusals } = planFixesFromReconcile(
        entries, () => null, () => [], () => [], 'we', fetchItemlessDiffPaths, () => [],
      );
      expect(refusals).toEqual([]);
      // the raw `we:x,we:scripts`-shaped hostile entry is dropped by `isSafeFallbackScopeEntry` here — the
      // SAME filtering the pre-existing item-with-empty-scope fallback already gets.
      expect(planned).toEqual([{
        itemNum: 'xabc123', pr: 61, laneRef: 'lane/xabc123-new-thing',
        scope: ['we:backlog/xabc123-new-thing.md', 'we:src/Thing.tsx'],
        scopeSource: 'pr-diff', isConflict: false, body: null, headRefOid: 'cafe'.repeat(10),
      }]);
    });

    // Review findings (correctness + security, chalbert/web-everything#2573, at this file's own
    // `planFixesFromReconcile`:226/229) — the malicious-shaped repro from the security finding: a PR author
    // opens `lane/xevil01-innocuous-thing` and files a card in that SAME PR's diff whose OWN `scope:`
    // frontmatter declares a path-traversal entry. Before the fix, `item.scopeSource === 'card'` skipped
    // `isSafeFallbackScopeEntry` entirely (only `'diff'` was filtered), so both traversal entries reached
    // `planned[0].scope` untouched.
    it('SECURITY: a hostile card-scope entry (path traversal) filed in the PR\'s own diff is filtered, never reaches planned.scope', () => {
      const entries = [{ kind: 'fix', prNumber: 2222, headRefName: 'lane/xevil01-innocuous-thing', headRefOid: 'cafe'.repeat(10) }];
      const fetchItemlessDiffPaths = () => ['backlog/xevil01-innocuous-thing.md', 'scripts/legit.mjs'];
      const resolveCardScopeAtRef = () => ['we:../../.ssh/authorized_keys', 'we:../../../etc/passwd'];
      const { planned, refusals } = planFixesFromReconcile(
        entries, () => null, () => [], () => [], 'we', fetchItemlessDiffPaths, resolveCardScopeAtRef,
      );
      expect(refusals).toEqual([]);
      expect(planned).toHaveLength(1);
      expect(planned[0].scope).not.toContain('we:../../.ssh/authorized_keys');
      expect(planned[0].scope).not.toContain('we:../../../etc/passwd');
      // nothing safe survives the card, so it falls through to the PR's own (already-touched) diff paths —
      // never a looser fence than the PR's own footprint.
      expect(planned[0].scope).toEqual(['we:backlog/xevil01-innocuous-thing.md', 'we:scripts/legit.mjs']);
      expect(planned[0].scopeSource).toBe('pr-diff');
    });

    it('CORRECTNESS: a comma-smuggled card-scope entry is dropped, never widens the fence past what the PR actually touches', () => {
      const entries = [{ kind: 'fix', prNumber: 2223, headRefName: 'lane/xevil02-innocuous-thing', headRefOid: 'cafe'.repeat(10) }];
      const fetchItemlessDiffPaths = () => ['backlog/xevil02-innocuous-thing.md', 'scripts/legit.mjs'];
      const resolveCardScopeAtRef = () => ['we:scripts/legit.mjs', 'we:x,we:evil/anything'];
      const { planned, refusals } = planFixesFromReconcile(
        entries, () => null, () => [], () => [], 'we', fetchItemlessDiffPaths, resolveCardScopeAtRef,
      );
      expect(refusals).toEqual([]);
      expect(planned[0].scope).toEqual(['we:scripts/legit.mjs']);
    });

    it('a GENUINE ghost item number — no matching card anywhere in the diff — is still refused `no-scope`, unaffected', () => {
      const entries = [{ kind: 'fix', prNumber: 99, headRefName: 'lane/9999-ghost' }];
      const cardCalls = [];
      const { planned, refusals } = planFixesFromReconcile(
        entries, () => null, () => [], () => [], 'we',
        () => ['scripts/unrelated.mjs'], // some diff, but no `backlog/9999-*.md` in it
        (path, ref) => { cardCalls.push({ path, ref }); return ['we:should/not/be/used.mjs']; },
      );
      expect(cardCalls).toEqual([]); // never even attempted — no candidate card path found
      expect(planned).toEqual([]);
      expect(refusals).toEqual([{ pr: 99, kind: 'no-scope', why: expect.stringContaining('no declared scope') }]);
    });
  });
});

describe('fetchPrDiffScope — #3634\'s real fallback-scope reader', () => {
  it('reduces `gh pr diff <pr> --name-only` to a `we:`-prefixed path list', () => {
    const calls = [];
    const exec = (file, argv, opts) => {
      calls.push({ file, argv, cwd: opts?.cwd });
      return 'scripts/operations/host-process-sample.mjs\nscripts/operations/telemetry.mjs\n';
    };
    expect(fetchPrDiffScope(2220, { exec, root: '/repo' })).toEqual([
      'we:scripts/operations/host-process-sample.mjs', 'we:scripts/operations/telemetry.mjs',
    ]);
    expect(calls).toEqual([{ file: 'gh', argv: ['pr', 'diff', '2220', '--name-only'], cwd: '/repo' }]);
  });

  it('pins the `gh` call to the given repo with `--repo` (the multi-repo guard requires it)', () => {
    const calls = [];
    const exec = (file, argv) => { calls.push(argv); return 'a.mjs\n'; };
    fetchPrDiffScope(7, { exec, root: '/repo', repo: 'owner/name' });
    expect(calls).toEqual([['pr', 'diff', '7', '--name-only', '--repo', 'owner/name']]);
  });

  it('drops blank lines (a trailing newline must not become an empty `we:` path)', () => {
    const exec = () => 'one/file.mjs\n\n\n';
    expect(fetchPrDiffScope(1, { exec, root: '/repo' })).toEqual(['we:one/file.mjs']);
  });

  it('fails soft to `[]` on any `gh` failure — never throws the whole pass over one bad read', () => {
    const exec = () => { throw new Error('gh: PR not found'); };
    expect(fetchPrDiffScope(404, { exec, root: '/repo' })).toEqual([]);
  });
});

// #xmtbdgs multi-repo slice 6 — `fetchPrDiffScope` is now a one-line wrapper over this un-prefixed read.
describe('fetchPrDiffPaths — the un-prefixed read `resolvePrWorkUnit`\'s own `fetchDiffPaths` contract wants', () => {
  it('returns raw, un-prefixed paths (no repo tag added)', () => {
    const exec = () => 'src/a.ts\nsrc/b.ts\n';
    expect(fetchPrDiffPaths(49, { exec, root: '/repo' })).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('fails soft to `[]` on any `gh` failure', () => {
    const exec = () => { throw new Error('gh: PR not found'); };
    expect(fetchPrDiffPaths(404, { exec, root: '/repo' })).toEqual([]);
  });
});

// #xcla4iv — reads one backlog card's own committed `scope:` frontmatter at a specific ref (a PR's head),
// for the "card filed IN this PR" population `resolvePrWorkUnit`'s own docblock describes.
describe('fetchCardScopeAtRef — #xcla4iv\'s real card-scope reader', () => {
  const toBase64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  it('decodes the `gh api .../contents` response and reads the card\'s `scope:` frontmatter', () => {
    const calls = [];
    const exec = (file, argv, opts) => {
      calls.push({ file, argv, cwd: opts?.cwd });
      return toBase64('---\nscope: ["we:a.mjs", "we:b.mjs"]\n---\nbody text');
    };
    const scope = fetchCardScopeAtRef('backlog/xzi292i-x.md', 'deadbeef'.repeat(5), { exec, root: '/repo' });
    expect(scope).toEqual(['we:a.mjs', 'we:b.mjs']);
    expect(calls).toEqual([{
      file: 'gh',
      argv: ['api', '--method', 'GET', `repos/{owner}/{repo}/contents/backlog/xzi292i-x.md?ref=${'deadbeef'.repeat(5)}`, '--jq', '.content'],
      cwd: '/repo',
    }]);
  });

  it('embeds an explicit `owner/name` repo slug directly (no `--repo` flag exists for `gh api`)', () => {
    const calls = [];
    const exec = (file, argv) => { calls.push(argv); return toBase64('---\nscope: ["plateau:x.tsx"]\n---\n'); };
    fetchCardScopeAtRef('backlog/xabc-x.md', 'sha1', { exec, root: '/repo', repo: 'chalbert/plateau-app' });
    expect(calls).toEqual([['api', '--method', 'GET', 'repos/chalbert/plateau-app/contents/backlog/xabc-x.md?ref=sha1', '--jq', '.content']]);
  });

  it('returns `[]` when the card declares no `scope:` at all (falls back to the diff, one level up)', () => {
    const exec = () => toBase64('---\nkind: story\n---\nno scope here');
    expect(fetchCardScopeAtRef('backlog/x.md', 'sha', { exec, root: '/repo' })).toEqual([]);
  });

  it('fails soft to `[]` on any `gh` failure — never throws the whole pass over one bad read', () => {
    const exec = () => { throw new Error('gh: not found'); };
    expect(fetchCardScopeAtRef('backlog/x.md', 'sha', { exec, root: '/repo' })).toEqual([]);
  });

  it('fails soft to `[]` on malformed base64/frontmatter rather than throwing', () => {
    const exec = () => 'not-valid-base64!!!';
    expect(fetchCardScopeAtRef('backlog/x.md', 'sha', { exec, root: '/repo' })).toEqual([]);
  });
});

describe('freeLaneNumbers', () => {
  it('parses lane ids out of `lane-pool.mjs list --acquirable --json` path output', () => {
    const calls = [];
    const exec = (file, argv) => {
      calls.push({ file, argv });
      return JSON.stringify(['/lanes/web-everything/lane-9', '/lanes/web-everything/lane-2', '/lanes/web-everything/lane-14']);
    };
    expect(freeLaneNumbers({ exec, root: '/repo' })).toEqual([2, 9, 14]);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('node');
    expect(calls[0].argv).toEqual(['/repo/scripts/lane-pool.mjs', 'list', '--acquirable', '--json']);
  });

  it('fails soft to an empty list rather than throwing (a `gh`/pool hiccup must not crash the whole pass)', () => {
    const exec = () => { throw new Error('pool unreachable'); };
    expect(freeLaneNumbers({ exec, root: '/repo' })).toEqual([]);
  });

  // #x33jgwt multi-repo slice 5 — a sibling repo's fix dispatch must pop lanes from ITS OWN pool, never WE's.
  it('passes `--repo=<lanePoolRepo>` through to lane-pool.mjs when given a sibling repo\'s lane pool', () => {
    const calls = [];
    const exec = (file, argv) => { calls.push({ file, argv }); return JSON.stringify(['/lanes/plateau-app/lane-3']); };
    expect(freeLaneNumbers({ exec, root: '/repo', lanePoolRepo: '/home/test/workspace/plateau-app' })).toEqual([3]);
    expect(calls[0].argv).toEqual([
      '/repo/scripts/lane-pool.mjs', 'list', '--acquirable', '--json', '--repo=/home/test/workspace/plateau-app',
    ]);
  });
});

describe('dispatchFix — the composition: plan → fill → mint → spawn', () => {
  it('spawns exactly once, with a freshly minted session id, the assigned lane, and the filled brief as the prompt', () => {
    const calls = [];
    const result = dispatchFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'], lane: 9 },
      {
        root: '/repo',
        readBrief: () => REAL_TEMPLATE_STUB,
        mintSessionId: () => '11111111-1111-4111-8111-111111111111',
        spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ cwd: '/repo' });
    expect(calls[0].argv).toEqual([
      // #3331 — no `--session-id`: `claude --bg` discards it and assigns its own id.
      '--bg',
      '-n', 'fix-1764',
      // #3606 — the standing-identity system prompt, without which a correctly-filled brief reads as an
      // unfilled template and the agent self-aborts (live 3/3: fix-2127/fix-2130/fix-2003).
      '--append-system-prompt-file', DISPATCHED_AGENT_SYSTEM_PROMPT_FILE,
      '# fix brief for 1764 (item 3438)\n'
      + 'acquire: node scripts/lane-pool.mjs acquire --lane=9 --session=fix-1764 '
      + '--scope=we:scripts/conveyor/reconcile-fix-dispatch.mjs --base=lane/3438-wire-reconcile-pass\n'
      + 'this brief documents {{LIKE_THIS}} as an example convention, not a real token',
    ]);

    expect(result.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.sessionSlug).toBe('fix-1764');
    expect(result.pr).toBe(1764);
    expect(result.itemNum).toBe('3438');
    expect(result.lane).toBe(9);
    expect(result.unknownTokens).toEqual(['{{LIKE_THIS}}']);
    expect(result.resumed).toBe(false);
  });

  it('#x8mpubm — resolveSettingsEnv is called once, WITH root, and its result folds into the argv as --settings', () => {
    const calls = [];
    const resolveSettingsEnv = vi.fn(() => ({ PATH: '/shim:/usr/bin' }));
    dispatchFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'], lane: 9 },
      {
        root: '/repo', readBrief: () => REAL_TEMPLATE_STUB, mintSessionId: () => 'sid',
        spawnAgent: (argv) => { calls.push(argv); return ''; },
        resolveSettingsEnv,
      },
    );
    // #x8mpubm follow-up (live-caught 2026-09-24) — `root` must reach the resolver so the durable
    // `.claude/settings.local.json` delivery (`gh-app-shim.mjs#ensureSettingsFileEnv`) targets the SAME
    // checkout this dispatch actually starts in.
    expect(resolveSettingsEnv).toHaveBeenCalledWith('/repo');
    expect(calls[0]).toContain('--settings');
    expect(calls[0][calls[0].indexOf('--settings') + 1]).toBe(JSON.stringify({ env: { PATH: '/shim:/usr/bin' } }));
  });

  it('#x8mpubm — the REAL default resolveSettingsEnv (unconfigured host) emits no --settings at all', () => {
    const calls = [];
    dispatchFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'], lane: 9 },
      {
        root: '/repo', readBrief: () => REAL_TEMPLATE_STUB, mintSessionId: () => 'sid',
        spawnAgent: (argv) => { calls.push(argv); return ''; },
        // no `resolveSettingsEnv` override — exercises the REAL `resolveGhShimSettingsEnv` default, which is
        // opt-in gated on WE_GITHUB_APP_* and must stay a safe no-op on this (unconfigured) test host.
      },
    );
    expect(calls[0]).not.toContain('--settings');
  });

  it('attaches a carried-forward `resumeAttempt` (from a prior tryResumeFix call) to the reported result, without re-attempting anything itself', () => {
    const result = dispatchFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'], lane: 9 },
      {
        root: '/repo', readBrief: () => REAL_TEMPLATE_STUB, mintSessionId: () => 'sid', spawnAgent: () => '',
        resumeAttempt: { attempted: true, candidate: 'cand', forked: true },
      },
    );
    expect(result.resumeAttempt).toEqual({ attempted: true, candidate: 'cand', forked: true });
    expect(result.resumed).toBe(false);
  });

  it('refuses to dispatch from inside a lane checkout, same guard dispatch-lane-io.mjs uses', () => {
    expect(() => dispatchFix(
      { itemNum: '3438', pr: 1, laneRef: 'lane/3438-x', scope: ['we:x'], lane: 1 },
      { root: '/some/path/.lanes/web-everything/lane-3', readBrief: () => REAL_TEMPLATE_STUB, spawnAgent: () => { throw new Error('must not be called'); } },
    )).toThrow(/lane/i);
  });

  // #xmtbdgs multi-repo slice 6 — an item-less PR (`planned.itemNum: null`) fills `{{ITEM_NUM}}` blank and
  // `{{ATTRIBUTION}}` as `PR #<n>` — never a fabricated number, never a throw for a "missing" required token.
  it('fills an item-less fix\'s `{{ITEM_NUM}}` blank and `{{ATTRIBUTION}}` as `PR #<n>` (no backlog item)', () => {
    const calls = [];
    const template = [
      '# fix brief for {{PR_NUM}} (item [{{ITEM_NUM}}])',
      '{{ATTRIBUTION}}: address review:changes on PR #{{PR_NUM}}',
      'acquire: node scripts/lane-pool.mjs acquire --lane={{LANE}} --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}',
    ].join('\n');
    const result = dispatchFix(
      { itemNum: null, pr: 49, laneRef: 'some-hand-opened-branch', scope: ['we:src/x.ts'], lane: 9 },
      {
        root: '/repo', readBrief: () => template, mintSessionId: () => 'session',
        spawnAgent: (argv) => { calls.push(argv); return ''; },
      },
    );
    const prompt = calls[0][calls[0].length - 1];
    expect(prompt).toContain('item []'); // {{ITEM_NUM}} substituted blank, never "undefined"/"null"
    expect(prompt).toContain('PR #49: address review:changes on PR #49'); // {{ATTRIBUTION}} = `PR #49`
    expect(result.itemNum).toBeNull();
  });
});

describe('tryResumeFix — #xu2krte Fork 1, and #xazl9u3\'s whole reason to exist: this runs with NO lane involved at all', () => {
  it('a non-conflict planned entry never consults `claude agents` at all, and reports `resumed: false`/no attempt', () => {
    let listAgentsAllCalls = 0;
    const result = tryResumeFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'], isConflict: false, body: null },
      { root: '/repo', listAgentsAll: () => { listAgentsAllCalls += 1; return []; } },
    );
    expect(listAgentsAllCalls).toBe(0);
    expect(result).toEqual({ resumed: false, resumeAttempt: null });
  });

  it('a conflict entry with no resume candidate at all reports `resumed: false`/no attempt (straight to a fresh dispatch, per the ratified default)', () => {
    const result = tryResumeFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'], isConflict: true, body: 'no stamp here', headRefOid: null },
      { root: '/repo', listAgentsAll: () => [] },
    );
    expect(result).toEqual({ resumed: false, resumeAttempt: null });
  });

  const MATCHING_HEAD = 'deadbeef'.repeat(5);

  it('#xu2krte Fork 1 — a conflict-caused entry with a listed, OWNERSHIP-CONFIRMED resume candidate attempts a bare resume first, and returns `resumed: true` with NO lane on success', () => {
    const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
    const spawnCalls = [];
    const result = tryResumeFix(
      {
        itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
        isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
      },
      {
        root: '/repo',
        spawnAgent: (argv) => { spawnCalls.push(argv); return 'backgrounded · candxxxx\n'; },
        listAgentsAll: () => [{ sessionId: 'cand-0000-0000-0000-000000000000', id: 'candxxxx', cwd: '/lanes/lane-4', name: 'conveyor-3438' }],
        resolveHead: (cwd) => (cwd === '/lanes/lane-4' ? MATCHING_HEAD : null),
      },
    );
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(['--bg', '--resume', 'cand-0000-0000-0000-000000000000', expect.stringContaining('PR #1764')]);
    expect(result).toEqual({
      resumed: true,
      result: {
        sessionId: 'cand-0000-0000-0000-000000000000', sessionSlug: null, pr: 1764, itemNum: '3438', lane: null,
        unknownTokens: [], resumed: true,
      },
    });
  });

  it('#xu2krte security hardening — a candidate whose checkout HEAD does NOT match the PR is refused, never resumed', () => {
    const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
    const spawnCalls = [];
    const result = tryResumeFix(
      {
        itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
        isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
      },
      {
        root: '/repo',
        spawnAgent: (argv) => { spawnCalls.push(argv); return 'backgrounded · x\n'; },
        // The candidate IS listed under the stamped id, but its checkout sits on a DIFFERENT commit — an
        // editable PR-body stamp alone is not enough to trust it (the security finding from PR #1966's review).
        listAgentsAll: () => [{ sessionId: 'cand-0000-0000-0000-000000000000', id: 'candxxxx', cwd: '/lanes/lane-4', name: 'conveyor-3438' }],
        resolveHead: () => 'a-totally-different-sha',
      },
    );
    // No resume attempt was ever made — no spawn call at all.
    expect(spawnCalls).toHaveLength(0);
    expect(result.resumed).toBe(false);
    expect(result.resumeAttempt).toEqual({
      attempted: false, candidate: 'cand-0000-0000-0000-000000000000', forked: false,
      refused: 'ownership-unconfirmed', why: expect.stringContaining('head match: false'),
    });
  });

  it('#xu2krte security hardening — a candidate with the RIGHT head but a name that could not legitimately be this pr\'s builder is also refused', () => {
    const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
    const spawnCalls = [];
    const result = tryResumeFix(
      {
        itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
        isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
      },
      {
        root: '/repo',
        spawnAgent: (argv) => { spawnCalls.push(argv); return 'backgrounded · x\n'; },
        // Same HEAD as the pr (a coincidence PR #1966's review named explicitly: two lanes CAN share a commit),
        // but a name that is neither `conveyor-3438` nor `fix-1764` — an unrelated session, not this pr's own.
        listAgentsAll: () => [{ sessionId: 'cand-0000-0000-0000-000000000000', id: 'candxxxx', cwd: '/lanes/lane-4', name: 'conveyor-9999' }],
        resolveHead: () => MATCHING_HEAD,
      },
    );
    expect(spawnCalls).toHaveLength(0);
    expect(result.resumeAttempt).toEqual({
      attempted: false, candidate: 'cand-0000-0000-0000-000000000000', forked: false,
      refused: 'ownership-unconfirmed', why: expect.stringContaining('name match: false'),
    });
  });

  it('#xu2krte Fork 1 — a fork (mismatched id) is stopped and reports `resumed: false`/`attempted: true`, leaving the fresh dispatch to the caller', () => {
    const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
    const spawnCalls = [];
    const stopCalls = [];
    let listCall = 0;
    const result = tryResumeFix(
      {
        itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
        isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
      },
      {
        root: '/repo',
        spawnAgent: (argv) => { spawnCalls.push(argv); return 'backgrounded · forkedid\n'; },
        // Row 1 (before the resume attempt): the candidate is listed, so a resume is attempted.
        // Every read AFTER: only a DIFFERENT id ("forkedid") is listed — the CLI forked a copy. The retry
        // loop (hardening 2) reads this same wrong answer every time, so it correctly exhausts, not stalls.
        listAgentsAll: () => {
          listCall += 1;
          return listCall === 1
            ? [{ sessionId: 'cand-0000-0000-0000-000000000000', id: 'candxxxx', cwd: '/lanes/lane-4', name: 'conveyor-3438' }]
            : [{ sessionId: 'a-different-session-id', id: 'forkedid', cwd: '/lanes/lane-9' }];
        },
        resolveHead: (cwd) => (cwd === '/lanes/lane-4' ? MATCHING_HEAD : null),
        stop: ({ handle }) => stopCalls.push(handle),
        wait: () => {}, // no real sleeping in a unit test
      },
    );
    expect(stopCalls).toEqual(['forkedid']);
    // Only the one resume-attempt spawn — this function never performs the fresh dispatch itself.
    expect(spawnCalls).toHaveLength(1);
    expect(result.resumed).toBe(false);
    expect(result.resumeAttempt).toEqual({ attempted: true, candidate: 'cand-0000-0000-0000-000000000000', forked: true });
  });

  it('#xu2krte hardening (2) — a listing that lags by ONE read still resolves as a genuine resume, not a fork', () => {
    const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
    let listCall = 0;
    let waitCalls = 0;
    const result = tryResumeFix(
      {
        itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
        isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
      },
      {
        root: '/repo',
        spawnAgent: () => 'backgrounded · candxxxx\n',
        // Call 1: the pre-spawn candidate lookup. Call 2 (the FIRST post-spawn confirm read): the listing has
        // not caught up yet — no row at all, simulating exactly the propagation lag #3331 documents. Call 3
        // onward: caught up.
        listAgentsAll: () => {
          listCall += 1;
          if (listCall === 2) return [];
          return [{ sessionId: 'cand-0000-0000-0000-000000000000', id: 'candxxxx', cwd: '/lanes/lane-4', name: 'conveyor-3438' }];
        },
        resolveHead: () => MATCHING_HEAD,
        wait: () => { waitCalls += 1; },
      },
    );
    expect(result.resumed).toBe(true);
    expect(waitCalls).toBe(1); // exactly one retry was needed
  });

  it('#3541 — a post-resume row MISSING `id` entirely resolves `resumed:false` (the safe direction) and the anomaly rides onto `resumeAttempt`', () => {
    // Two positive fallbacks for this exact shape were tried and rejected by independent review (see
    // `resumeSucceeded`'s own docblock) — the landed behavior is the pre-#3541 one: an id-match failure means
    // `stop(printedId)` and a fresh dispatch (which the caller performs), never a claimed resume. What's new is
    // visibility: the never-yet-observed missing-`id` shape now names itself on `resumeAttempt.anomaly` instead
    // of being silently indistinguishable from an ordinary fork.
    const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
    const stopCalls = [];
    const result = tryResumeFix(
      {
        itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
        isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
      },
      {
        root: '/repo',
        spawnAgent: () => 'backgrounded · candxxxx\n',
        // Call 1 (the pre-resume ownership check): the candidate is listed with its `id`, as always. Every
        // call AFTER: the SAME session, still listed by `sessionId` — but this time its `id` is gone, the
        // exact `#x3gdu12` scenario this item was filed to worry about.
        listAgentsAll: () => [{
          sessionId: 'cand-0000-0000-0000-000000000000', cwd: '/lanes/lane-4', name: 'conveyor-3438', kind: 'background',
        }],
        resolveHead: () => MATCHING_HEAD,
        stop: ({ handle }) => stopCalls.push(handle),
        wait: () => {},
      },
    );
    expect(result.resumed).toBe(false);
    expect(stopCalls).toEqual(['candxxxx']);
    expect(result.resumeAttempt).toEqual({
      attempted: true, candidate: 'cand-0000-0000-0000-000000000000', forked: true,
      anomaly: 'requested-session-listed-without-id',
    });
  });

  it('#3541 — a fork whose row has NOT propagated into the listing at all is still safely read as not-resumed, no anomaly reported (it is an ordinary fork, not the missing-`id` shape)', () => {
    // Rounds 1-2 of this item's own build tried to read this shape as a confirmed resume from
    // absence-of-a-new-session, and both were found unsafe by independent review — a live measurement showed
    // listing propagation lag of 26+ seconds, far past any retry budget this call site can afford. The landed
    // function does not attempt it at all: this shape (candidate still listed, its own row DOES carry `id`,
    // nothing new visible yet) resolves via the id-match branch failing to find `forkedid`, exactly like any
    // other unmatched id.
    const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
    const stopCalls = [];
    const result = tryResumeFix(
      {
        itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
        isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
      },
      {
        root: '/repo',
        // The CLI actually forked a copy under `forkedid`, but that fork's row never shows up within this
        // dispatch's retry budget — every read looks identical (candidate still listed, id present, nothing new).
        spawnAgent: () => 'backgrounded · forkedid\n',
        listAgentsAll: () => [{
          sessionId: 'cand-0000-0000-0000-000000000000', cwd: '/lanes/lane-4', name: 'conveyor-3438', id: 'candxxxx', kind: 'background',
        }],
        resolveHead: (cwd) => (cwd === '/lanes/lane-4' ? MATCHING_HEAD : null),
        stop: ({ handle }) => stopCalls.push(handle),
        wait: () => {},
      },
    );
    expect(result.resumed).toBe(false);
    expect(stopCalls).toEqual(['forkedid']);
    expect(result.resumeAttempt).toEqual({ attempted: true, candidate: 'cand-0000-0000-0000-000000000000', forked: true });
  });

  it('refuses to run from inside a lane checkout, same guard dispatch-lane-io.mjs uses — even for a conflict entry', () => {
    expect(() => tryResumeFix(
      { itemNum: '3438', pr: 1, laneRef: 'lane/3438-x', scope: ['we:x'], isConflict: true, body: null },
      { root: '/some/path/.lanes/web-everything/lane-3', spawnAgent: () => { throw new Error('must not be called'); } },
    )).toThrow(/lane/i);
  });
});

describe('runReconcileFixDispatch — read reconcile-pass, plan, assign a lane, dispatch', () => {
  const reconcileStub = (dispatchEntries) => () => ({ dispatch: dispatchEntries, refusals: [], notes: [], prs: dispatchEntries.length, agents: 0 });

  it('dispatches every dispatchable fix entry and assigns each its own free lane, in order', () => {
    const entries = [
      { kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass' },
      { kind: 'fix', prNumber: 1765, headRefName: 'lane/3438-wire-reconcile-pass-b' },
    ];
    const dispatched = [];
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: reconcileStub(entries),
      findItemFn: findItemStub,
      loadItems: () => [],
      pickFreeLanes: () => [2, 9],
      dispatch: (planned) => { dispatched.push(planned); return { sessionId: `s-${planned.pr}`, sessionSlug: `fix-${planned.pr}`, pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [] }; },
      checkStaleness: FRESH,
    });
    expect(dispatched).toEqual([
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: item3438.scope, scopeSource: 'item', isConflict: false, body: null, headRefOid: null, lane: 2 },
      { itemNum: '3438', pr: 1765, laneRef: 'lane/3438-wire-reconcile-pass-b', scope: item3438.scope, scopeSource: 'item', isConflict: false, body: null, headRefOid: null, lane: 9 },
    ]);
    expect(result.dispatched).toHaveLength(2);
    expect(result.refusals).toEqual([]);
  });

  it('refuses `no-lane` for a planned fix once the free lanes run out, rather than dispatching two agents onto one lane', () => {
    const entries = [
      { kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass' },
      { kind: 'fix', prNumber: 1765, headRefName: 'lane/3438-wire-reconcile-pass-b' },
    ];
    const dispatched = [];
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: reconcileStub(entries),
      findItemFn: findItemStub,
      loadItems: () => [],
      pickFreeLanes: () => [2],
      dispatch: (planned) => { dispatched.push(planned); return { sessionId: 's', sessionSlug: 'fix', pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [] }; },
      checkStaleness: FRESH,
    });
    expect(dispatched).toHaveLength(1);
    expect(result.refusals).toEqual([{ pr: 1765, kind: 'no-lane', why: expect.stringContaining('no free lane') }]);
  });

  it('reports a `dispatch-failed` refusal (never throws the whole pass) when one dispatch throws — e.g. a lost lane race', () => {
    const entries = [{ kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass' }];
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: reconcileStub(entries),
      findItemFn: findItemStub,
      loadItems: () => [],
      pickFreeLanes: () => [2],
      dispatch: () => { throw new Error('lane-9 lost its race to a sibling'); },
      checkStaleness: FRESH,
    });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([{ pr: 1764, kind: 'dispatch-failed', why: 'lane-9 lost its race to a sibling' }]);
  });

  it('PR #1972 review finding — a THROWING `tryResume` is isolated to a per-entry `dispatch-failed` refusal, and does not abort the rest of the tick', () => {
    const entries = [
      // Entry 1: conflict-caused; its `tryResume` call throws (e.g. a transient `claude agents --json` read).
      { kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass', labels: [CONFLICT_LABEL], body: 'stamped', headRefOid: 'sha' },
      // Entry 2: an unrelated ordinary bounce that must still be processed in the SAME tick.
      { kind: 'fix', prNumber: 1765, headRefName: 'lane/3438-wire-reconcile-pass-b' },
    ];
    const dispatchCalls = [];
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: reconcileStub(entries),
      findItemFn: findItemStub,
      loadItems: () => [],
      pickFreeLanes: () => [2],
      tryResume: (entry) => {
        if (entry.pr === 1764) throw new Error('claude agents --json --all: transient listing failure');
        return { resumed: false, resumeAttempt: null };
      },
      dispatch: (planned) => { dispatchCalls.push(planned.pr); return { sessionId: `s-${planned.pr}`, sessionSlug: `fix-${planned.pr}`, pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [], resumed: false }; },
      checkStaleness: FRESH,
    });
    // Entry 1 is refused individually; entry 2 still dispatches — the whole pass did NOT abort.
    expect(dispatchCalls).toEqual([1765]);
    expect(result.dispatched).toEqual([
      { sessionId: 's-1765', sessionSlug: 'fix-1765', pr: 1765, itemNum: '3438', lane: 2, unknownTokens: [], resumed: false },
    ]);
    expect(result.refusals).toEqual([
      { pr: 1764, kind: 'dispatch-failed', why: 'claude agents --json --all: transient listing failure' },
    ]);
  });

  it('#xazl9u3 — a conflict entry whose resume attempt SUCCEEDS never touches the lane pool at all: the free lane it never needed is still there for the very next entry', () => {
    const entries = [
      // Entry 1: conflict-caused, and (per the injected `tryResume` stub below) resumes successfully.
      { kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass', labels: [CONFLICT_LABEL], body: 'stamped', headRefOid: 'sha' },
      // Entry 2: an ordinary bounce that DOES need a lane.
      { kind: 'fix', prNumber: 1765, headRefName: 'lane/3438-wire-reconcile-pass-b' },
    ];
    const tryResumeCalls = [];
    const dispatchCalls = [];
    // Only ONE free lane in the whole pool. If entry 1's successful resume consumed it, entry 2 would starve
    // with a `no-lane` refusal — the exact waste #xazl9u3 was filed against.
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: reconcileStub(entries),
      findItemFn: findItemStub,
      loadItems: () => [],
      pickFreeLanes: () => [7],
      tryResume: (entry) => {
        tryResumeCalls.push(entry.pr);
        if (entry.pr === 1764) {
          return { resumed: true, result: { sessionId: 'cand', sessionSlug: null, pr: 1764, itemNum: '3438', lane: null, unknownTokens: [], resumed: true } };
        }
        return { resumed: false, resumeAttempt: null };
      },
      dispatch: (planned) => { dispatchCalls.push(planned); return { sessionId: `s-${planned.pr}`, sessionSlug: `fix-${planned.pr}`, pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [], resumed: false }; },
      checkStaleness: FRESH,
    });

    // tryResume was consulted for the conflict entry only (entry 2 carries no CONFLICT_LABEL, so isConflict is
    // false and the loop never even calls tryResume for it).
    expect(tryResumeCalls).toEqual([1764]);
    // The resumed entry never reached `dispatch` at all, and the ONE free lane went to entry 2 — proof the
    // pool was left untouched by the resume.
    expect(dispatchCalls).toEqual([
      expect.objectContaining({ pr: 1765, lane: 7 }),
    ]);
    expect(result.dispatched).toEqual([
      { sessionId: 'cand', sessionSlug: null, pr: 1764, itemNum: '3438', lane: null, unknownTokens: [], resumed: true },
      { sessionId: 's-1765', sessionSlug: 'fix-1765', pr: 1765, itemNum: '3438', lane: 7, unknownTokens: [], resumed: false },
    ]);
    expect(result.refusals).toEqual([]); // no `no-lane` refusal — the pool never actually ran dry
  });

  it('#xazl9u3 — a conflict entry whose resume attempt is REFUSED/forked still falls through to a real lane-consuming dispatch, carrying the resumeAttempt along for reporting', () => {
    const entries = [{ kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-wire-reconcile-pass', labels: [CONFLICT_LABEL], body: 'stamped', headRefOid: 'sha' }];
    const dispatchCalls = [];
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: reconcileStub(entries),
      findItemFn: findItemStub,
      loadItems: () => [],
      pickFreeLanes: () => [7],
      tryResume: () => ({ resumed: false, resumeAttempt: { attempted: true, candidate: 'cand', forked: true } }),
      dispatch: (planned, opts) => { dispatchCalls.push({ planned, resumeAttempt: opts.resumeAttempt }); return { sessionId: 's', sessionSlug: 'fix', pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [], resumed: false }; },
      checkStaleness: FRESH,
    });
    expect(dispatchCalls).toEqual([{
      planned: expect.objectContaining({ pr: 1764, lane: 7 }),
      resumeAttempt: { attempted: true, candidate: 'cand', forked: true },
    }]);
    expect(result.dispatched).toHaveLength(1);
  });

  it('refuses to run at all from a stale checkout (#3439), never reading reconcile-pass\'s plan', () => {
    let reconcileCalls = 0;
    expect(() => runReconcileFixDispatch({
      root: '/repo',
      reconcile: () => { reconcileCalls += 1; return { dispatch: [], refusals: [], notes: [] }; },
      checkStaleness: () => ({ action: 'warn', behind: 3 }),
    })).toThrow(/behind origin\/main/);
    expect(reconcileCalls).toBe(0);
  });

  // #x1rr9rh (multi-repo slice 2) — this check used to run ONLY when `repoKey === 'we'`, which was the wrong
  // condition: the fix pass always runs WE's own code from THIS checkout, whatever repo it targets (even when,
  // as for a foreign repo today, all it does with the result is record an `unsupported-repo` refusal). A stale
  // WE checkout must be refused for every repo, not just `we`.
  it('the staleness check now runs for a non-WE repo too (#x1rr9rh) — refuses before even reaching reconcile', () => {
    let reconcileCalls = 0;
    expect(() => runReconcileFixDispatch({
      root: '/repo',
      repo: 'chalbert/plateau-app',
      reconcile: () => { reconcileCalls += 1; return { dispatch: [], refusals: [], notes: [] }; },
      checkStaleness: () => ({ action: 'warn', behind: 5 }),
    })).toThrow(/behind origin\/main/);
    expect(reconcileCalls).toBe(0);
  });

  it('a FRESH non-WE repo still proceeds past the staleness check into the ordinary plan/dispatch path', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fix-staleness-fresh-'));
    const unsupportedPath = join(dir, 'rows.json');
    try {
      const result = runReconcileFixDispatch({
        root: '/repo',
        repo: 'chalbert/frontierui',
        unsupportedPath,
        reconcile: () => ({ dispatch: [], refusals: [] }),
        checkStaleness: FRESH,
      });
      expect(result).toEqual({ dispatched: [], refusals: [], reconcileRefusals: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('fixBriefPath', () => {
  it('points at the SAME brief dispatch-lane.mjs\'s own tick-core-driven fix dispatch fills', () => {
    expect(fixBriefPath('/repo')).toBe('/repo/skills-src/conveyor/fix-agent-brief.md');
  });
});

describe('findResumeCandidate — #xu2krte Fork 1', () => {
  it('returns the stamped session id when it is still listed', () => {
    const marker = buildAuthorActorMarker('11111111-1111-4111-8111-111111111111');
    const id = findResumeCandidate({
      body: `some body\n\n${marker}\n`,
      agentsAll: [{ sessionId: '11111111-1111-4111-8111-111111111111' }],
    });
    expect(id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('returns null when the body carries no stamp at all', () => {
    expect(findResumeCandidate({ body: 'no stamp here', agentsAll: [{ sessionId: 'x' }] })).toBeNull();
  });

  it('returns null when the stamped session is no longer listed (fully exited and reaped)', () => {
    const marker = buildAuthorActorMarker('11111111-1111-4111-8111-111111111111');
    const id = findResumeCandidate({ body: marker, agentsAll: [{ sessionId: 'some-other-session' }] });
    expect(id).toBeNull();
  });

  it('returns null on a conflicting (ambiguous) stamp — agreement-or-nothing, never a guess', () => {
    const two = `${buildAuthorActorMarker('aaaa')}\n${buildAuthorActorMarker('bbbb')}`;
    expect(findResumeCandidate({ body: two, agentsAll: [{ sessionId: 'aaaa' }, { sessionId: 'bbbb' }] })).toBeNull();
  });
});

describe('buildResumePrompt — #xu2krte Fork 1', () => {
  it('names the PR, the item, and the escalation stand-down command — never a literal undefined', () => {
    const prompt = buildResumePrompt({ pr: 1764, itemNum: '3438', cwd: '/lanes/lane-4' });
    expect(prompt).toContain('PR #1764');
    expect(prompt).toContain('item #3438');
    expect(prompt).toContain('/lanes/lane-4');
    expect(prompt).toContain('stand-down.mjs 1764 --reason=conflict');
    expect(prompt).not.toContain('undefined');
    expect(prompt.trimStart().startsWith('-')).toBe(false);
  });

  it('still renders sensibly with no known cwd', () => {
    const prompt = buildResumePrompt({ pr: 1, itemNum: '1' });
    expect(prompt).not.toContain('undefined');
    expect(prompt).not.toContain('null');
  });

  // #xmtbdgs multi-repo slice 6 — an item-less PR's resume prompt must never print a literal `item #null`.
  it('says "no backlog item" rather than `item #null` when itemNum is null (item-less PR, slice 6)', () => {
    const prompt = buildResumePrompt({ pr: 49, itemNum: null });
    expect(prompt).toContain('no backlog item');
    expect(prompt).not.toContain('null');
    expect(prompt).not.toContain('undefined');
  });
});

// ── #3331 — a fresh fix dispatch reports the id `claude --bg` assigned, not the minted one ────────────────────

describe('#3331 — dispatchFix reads its handle back off stdout', () => {
  /** Verbatim the first line CLI 2.1.269 prints on stdout for a `--bg` spawn. */
  const BANNER = (id) => `backgrounded · ${id} · fix-1764\n  claude agents             list sessions\n`;

  const dispatch = (spawnAgent) => dispatchFix(
    { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'], lane: 9 },
    {
      root: '/repo',
      readBrief: () => '# fix brief for {{PR_NUM}} (item {{ITEM_NUM}})\n'
        + 'acquire: node scripts/lane-pool.mjs acquire --lane={{LANE}} --session={{SESSION_SLUG}} '
        + '--scope={{SCOPE}} --base={{LANE_REF}}',
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent,
    },
  );

  it('returns `agentId` from the banner — the minted uuid addresses no session', () => {
    // Same defect, same blast radius as the review side: `buildAgentArgv` used to pass `--session-id` and
    // `claude --bg` used to ignore it, so the id this pass printed could never be found by `claude
    // agents`/`logs`/`stop`, and `stampLiveness` read every fix dispatch as gone.
    const result = dispatch(() => BANNER('9356543a'));
    expect(result.agentId).toBe('9356543a');
    expect(result.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('and `agentId: null` when the banner cannot be read, rather than a handle that will not be found', () => {
    expect(dispatch(() => '').agentId).toBeNull();
  });
});

// ── #3606 — the fix agent must be TOLD its brief is real, or it self-aborts ───────────────────────────────────

describe('#3606 — dispatchFix always passes the dispatched-agent system prompt', () => {
  it('emits --append-system-prompt-file, ahead of any extraArgs and the prompt', () => {
    // THE DEFECT THIS PINS, live-confirmed 3/3 on 2026-09-11. `fix-agent-brief.md` opens with "**This is a
    // TEMPLATE, not a runnable skill.**" and keeps `{{PLACEHOLDERS}}`/`{{LIKE_THIS}}` in its own explanatory
    // prose (legitimately unsubstituted — `fillBrief` reports them as non-fatal unknown tokens by design), so a
    // CORRECTLY filled brief still reads as an unfilled template. `fix-2127`, `fix-2130` and `fix-2003` each
    // received a fully substituted 16.5 KB brief naming their real PR and each replied "I don't see an actual
    // task or question in your message — just the fix-agent brief template (#2630) itself", doing no work.
    //
    // This was the ONE dispatch path missing the remedy: `createDispatchSinks` has always passed this file, and
    // `review-dispatch.mjs` passes its review-side twin (#xy8di3v), but this function passed nothing.
    const calls = [];
    dispatchFix(
      { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-x', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'], lane: 9 },
      {
        root: '/repo',
        readBrief: () => '# fix brief for {{PR_NUM}} (item {{ITEM_NUM}}) lane {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{LANE_REF}}',
        mintSessionId: () => '11111111-1111-4111-8111-111111111111',
        spawnAgent: (argv) => { calls.push(argv); return ''; },
        extraArgs: ['--model', 'sonnet'],
      },
    );
    const argv = calls[0];
    const at = argv.indexOf('--append-system-prompt-file');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe(DISPATCHED_AGENT_SYSTEM_PROMPT_FILE);
    // Order matters the same way it does for every other dispatch: identity, then operator flags, then prompt.
    expect(at).toBeLessThan(argv.indexOf('--model'));
    expect(argv[argv.length - 1]).toContain('fix brief for 1764');
  });
});

// #x33jgwt multi-repo slice 5 — `dispatchFix`/`tryResumeFix` no longer gate on repo identity themselves; the
// capability gate moved up to `runReconcileFixDispatch` (see its own docblock). These two primitives are now
// repo-generic, and both pin the ONE thing that must still hold: a sibling repo's dispatch is never confusable
// with WE's for the same PR number.

it('dispatches for a sibling repo, filling the brief from THAT repo\'s own profile (never WE\'s)', () => {
  const calls = [];
  const result = dispatchFix(
    { itemNum: '3438', pr: 49, laneRef: 'lane/3438-x', scope: ['plateau:src/x.ts'], lane: 9 },
    {
      root: '/repo', repo: 'plateau-app', readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => 'session', spawnAgent: (argv) => { calls.push(argv); return ''; },
      home: '/home/test', checkoutExists: () => true,
      readPackageJson: () => JSON.stringify({ scripts: { test: 'vitest run' } }),
    },
  );
  expect(calls).toHaveLength(1);
  // #x33jgwt — the session slug carries the repo tag (`fix-pa-<pr>`), never bare `fix-<pr>` — see the
  // "distinct sessions" test below for why this is the collision-safety property that matters.
  expect(result.sessionSlug).toBe('fix-pa-49');
  const argv = calls[0];
  expect(argv[argv.indexOf('-n') + 1]).toBe('fix-pa-49');
});

it('same PR number in two different repos mints distinct session slugs — plateau-app PR #49 never collides with WE PR #49', () => {
  const weResult = dispatchFix(
    { itemNum: '3438', pr: 49, laneRef: 'lane/3438-x', scope: ['we:x'], lane: 2 },
    { root: '/repo', readBrief: () => REAL_TEMPLATE_STUB, mintSessionId: () => 'we-session', spawnAgent: () => '' },
  );
  const plateauResult = dispatchFix(
    { itemNum: '3438', pr: 49, laneRef: 'lane/3438-x', scope: ['plateau:x'], lane: 3 },
    {
      root: '/repo', repo: 'plateau-app', readBrief: () => REAL_TEMPLATE_STUB, mintSessionId: () => 'pa-session', spawnAgent: () => '',
      home: '/home/test', checkoutExists: () => true, readPackageJson: () => JSON.stringify({ scripts: { test: 'vitest run' } }),
    },
  );
  expect(weResult.sessionSlug).toBe('fix-49');
  expect(plateauResult.sessionSlug).toBe('fix-pa-49');
  expect(weResult.sessionSlug).not.toBe(plateauResult.sessionSlug);
});

it('tryResumeFix no longer throws for a sibling repo — a non-conflict entry still short-circuits at no IO cost', () => {
  const calls = [];
  const result = tryResumeFix({ pr: 49, isConflict: false }, {
    repo: 'frontierui', root: '/repo',
    listAgentsAll: () => { calls.push('list'); return []; }, spawnAgent: () => calls.push('spawn'),
  });
  expect(result).toEqual({ resumed: false, resumeAttempt: null });
  expect(calls).toEqual([]); // isConflict:false returns before ever touching `claude agents`
});

describe('runReconcileFixDispatch — repo capability gate (#x33jgwt multi-repo slice 5)', () => {
  it('a repo whose profile has `fix:false` still refuses `unsupported-repo`, never touching a lane or dispatch sink', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { recordUnsupported, readUnsupported } = await import('../unsupported-repo.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'fix-refusals-'));
    const unsupportedPath = join(dir, 'rows.json');
    const calls = [];
    try {
      recordUnsupported({ repo: 'plateau-app', rows: [{ action: 'review', prNumber: 9 }], path: unsupportedPath });
      const options = {
        root: '/repo', repo: 'chalbert/plateau-app', unsupportedPath,
        reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 49, headRefName: 'lane/3438-wire-reconcile-pass', labels: ['review:changes'] }, { kind: 'ci-heal', prNumber: 50 }], refusals: [] }),
        findItemFn: findItemStub, loadItems: () => [], pickFreeLanes: () => { calls.push('pool'); return [2]; },
        tryResume: () => calls.push('resume'), dispatch: () => calls.push('dispatch'),
        // #x33jgwt — every REAL constellation repo now has `fix:true` (this slice's own point); inject a
        // profile resolver reporting `fix:false` to exercise the refusal branch, which stays capability-shaped
        // for whatever repo the constellation grows next with the capability genuinely off.
        resolveProfile: () => ({ capabilities: { fix: false, ciHeal: false }, lanePoolRepo: '/nonexistent' }),
      };
      const result = runReconcileFixDispatch(options);
      expect(result.dispatched).toEqual([]);
      expect(result.refusals).toEqual(['fix', 'ci-heal'].map((action, i) => ({ kind: 'unsupported-repo', repo: 'plateau-app', prNumber: 49 + i, action, why: expect.any(String) })));
      expect(calls).toEqual([]);
      expect(readUnsupported({ path: unsupportedPath })).toHaveLength(3);
      runReconcileFixDispatch({ ...options, reconcile: () => ({ dispatch: [], refusals: [] }) });
      expect(readUnsupported({ path: unsupportedPath })).toEqual([expect.objectContaining({ action: 'review', prNumber: 9 })]);
      expect(() => runReconcileFixDispatch({ repo: 'unknown/repo' })).toThrow(/not a constellation repo/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a plateau-app PR with a backlog item is dispatched into a plateau lane (real profile: fix AND ci-heal are both on, #3967)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fix-plateau-dispatch-'));
    const unsupportedPath = join(dir, 'rows.json');
    const dispatchCalls = [];
    try {
      // Real `resolveProfile` (the default) — plateau-app's own profile now has `capabilities.fix: true`.
      const result = runReconcileFixDispatch({
        root: '/repo', repo: 'chalbert/plateau-app', unsupportedPath,
        reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 177, headRefName: 'lane/3438-wire-reconcile-pass' }, { kind: 'ci-heal', prNumber: 50 }], refusals: [] }),
        findItemFn: findItemStub, loadItems: () => [],
        pickFreeLanes: () => [4],
        dispatch: (planned, opts) => { dispatchCalls.push({ planned, opts }); return { sessionId: 's', sessionSlug: `fix-pa-${planned.pr}`, pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [] }; },
        checkStaleness: FRESH,
      });
      // The fix entry is dispatched — NOT refused `unsupported-repo` — with `repo: 'plateau-app'` threaded to
      // `dispatch`, which is what lets `dispatchFix` resolve the plateau-app lane pool + gate for it.
      expect(dispatchCalls).toEqual([{
        planned: expect.objectContaining({ pr: 177, itemNum: '3438', lane: 4 }),
        opts: expect.objectContaining({ repo: 'plateau-app' }),
      }]);
      expect(result.dispatched).toEqual([{ sessionId: 's', sessionSlug: 'fix-pa-177', pr: 177, itemNum: '3438', lane: 4, unknownTokens: [] }]);
      // ci-heal is a SEPARATE capability, now ALSO on for plateau-app (#3967 multi-repo slice 7) — this file
      // (`runReconcileFixDispatch`) still dispatches no `ci-heal` itself either way (that is
      // `ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch`'s own job, reading the SAME `reconcile-pass`
      // reading), so the `kind:'ci-heal'` entry is silently absent from BOTH `dispatched` and `refusals` here —
      // no `unsupported-repo` row, because the capability is genuinely on.
      expect(result.refusals).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it('tryResumeFix no longer throws for a sibling repo\'s conflict-caused entry either — no candidate found falls through cleanly', () => {
  const calls = [];
  const result = tryResumeFix({ pr: 49, isConflict: true, body: null }, {
    repo: 'frontierui', root: '/repo',
    listAgentsAll: () => { calls.push('list'); return []; }, spawnAgent: () => calls.push('spawn'),
  });
  expect(result).toEqual({ resumed: false, resumeAttempt: null });
  expect(calls).toEqual(['list']); // isConflict:true DOES consult the listing; no stamped body → no candidate
});

// #xmtbdgs multi-repo slice 6 — end-to-end: an item-less PR is dispatched with PR attribution and diff scope,
// for WE and for a sibling repo alike.
describe('runReconcileFixDispatch — item-less PRs (#xmtbdgs multi-repo slice 6)', () => {
  it('an item-less WE PR (branch like `lane/dispatcher-daemon-ready`) is dispatched with PR attribution and diff scope', () => {
    const dispatchCalls = [];
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 900, headRefName: 'lane/dispatcher-daemon-ready' }], refusals: [] }),
      findItemFn: findItemStub, loadItems: () => [],
      pickFreeLanes: () => [5],
      fetchItemlessDiffPaths: (pr) => { expect(pr).toBe(900); return ['scripts/conveyor/runner.mjs']; },
      dispatch: (planned, opts) => { dispatchCalls.push({ planned, opts }); return { sessionId: 's', sessionSlug: 'fix-900', pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [] }; },
      checkStaleness: FRESH,
    });
    expect(dispatchCalls).toEqual([{
      planned: expect.objectContaining({ pr: 900, itemNum: null, scope: ['we:scripts/conveyor/runner.mjs'], scopeSource: 'pr-diff', lane: 5 }),
      opts: expect.objectContaining({ repo: 'we' }),
    }]);
    expect(result.dispatched).toEqual([{ sessionId: 's', sessionSlug: 'fix-900', pr: 900, itemNum: null, lane: 5, unknownTokens: [] }]);
    expect(result.refusals).toEqual([]);
  });

  it('an item-less plateau-app PR (branch like `lane/wip-fix`) is dispatched with a `plateau:`-prefixed scope', () => {
    const dispatchCalls = [];
    const result = runReconcileFixDispatch({
      root: '/repo', repo: 'chalbert/plateau-app',
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 171, headRefName: 'lane/wip-fix' }], refusals: [] }),
      findItemFn: findItemStub, loadItems: () => [],
      pickFreeLanes: () => [6],
      fetchItemlessDiffPaths: () => ['src/components/Loan.tsx'],
      dispatch: (planned, opts) => { dispatchCalls.push({ planned, opts }); return { sessionId: 's', sessionSlug: 'fix-pa-171', pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [] }; },
      checkStaleness: FRESH,
    });
    expect(dispatchCalls).toEqual([{
      planned: expect.objectContaining({ pr: 171, itemNum: null, scope: ['plateau:src/components/Loan.tsx'], scopeSource: 'pr-diff', lane: 6 }),
      opts: expect.objectContaining({ repo: 'plateau-app' }),
    }]);
    expect(result.dispatched).toEqual([{ sessionId: 's', sessionSlug: 'fix-pa-171', pr: 171, itemNum: null, lane: 6, unknownTokens: [] }]);
    expect(result.refusals).toEqual([]);
  });

  it('an item WITH no scope and an empty diff is still refused `no-scope` (this behaviour is unchanged by slice 6)', () => {
    const entries = [{ kind: 'fix', prNumber: 2220, headRefName: 'lane/3383-host-process-granularity' }];
    const epic3383 = { num: '3383', slug: 's', specPath: 'backlog/3383-x.md', scope: [] };
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: () => ({ dispatch: entries, refusals: [] }),
      findItemFn: (key) => (key === '3383' ? epic3383 : null), loadItems: () => [],
      pickFreeLanes: () => [7],
      resolveFallbackScope: () => [],
      dispatch: () => { throw new Error('must not be called'); },
      checkStaleness: FRESH,
    });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([{ pr: 2220, kind: 'no-scope', why: expect.any(String) }]);
  });
});
