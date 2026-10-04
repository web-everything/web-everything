/**
 * @file record-verdict-integration.test.mjs — the transport sink against REAL git (#3264, PR #1544).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────────────
 *
 * `./record-verdict.test.mjs` drives the same sink with an injected `run` stub, and it is a good suite: 46
 * tests, every argv asserted. It also went green over the defect that took the transport down. The sink ran
 *
 *     run(['fetch', '--quiet', 'origin', TRANSPORT_BRANCH], { cwd: board });
 *     run(['worktree', 'add', '--force', '--detach', wt, `origin/${TRANSPORT_BRANCH}`], { cwd: board });
 *
 * and production answered `fatal: invalid reference: origin/ops/review-requests`. A stub cannot answer that,
 * because the answer is not a function of the argv — it is a function of the CLONE'S `remote.origin.fetch`.
 * Asserting the argv pins the spelling; it never asks whether the spelling works.
 *
 * So every test below drives the REAL sink (`run` left at its `execFileSync` default, `mkdir`/`write`/`rm` at
 * their `fs` defaults) against a REAL bare origin and a REAL clone, built by
 * `we:scripts/operations/__tests__/helpers/real-repo.mjs`. Nothing here is stubbed except the clock, which is
 * a counter only so two stages in the same millisecond get distinct worktree directories.
 *
 * ── THE LOAD-BEARING TEST ───────────────────────────────────────────────────────────────────────────────
 *
 * `stages and pushes a verdict from a NARROW clone` is the one that reproduces #3264. Reverting
 * `trackingRefspec` to a bare `fetch origin <branch>` must turn it red. Verified by doing exactly that: the
 * revert reddens it (and only the narrow-clone tests) while the stub suite stays fully green — which is the
 * whole claim this harness makes about the two layers.
 *
 * ── WHY THESE ARE FAST ENOUGH FOR THE NORMAL SUITE ──────────────────────────────────────────────────────
 *
 * Each fixture is `git init --bare` + two small clones over local paths — no network, no packfile of any
 * size, no `npm`. The file measures well under a second in total. The one thing that would change that is a
 * fixture that clones THIS repo; nothing here does, and nothing here should.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  APPLIER_WORKFLOW,
  TRANSPORT_BRANCH,
  createRecordVerdictSinks,
  defaultOriginRepo,
  resolveTransportRoot,
  trackingRefspec,
} from '../record-verdict-io.mjs';
import { STAGE_REQUEST_EFFECT } from '../record-verdict.mjs';
import { DEFAULT_BRANCH, FIXTURE_SLUG, withBareOrigin, withNarrowClone } from './helpers/real-repo.mjs';

/** A plausible applier definition. Only its PRESENCE is read (`ls-tree`), never its content. */
const APPLIER = 'name: apply-review-request\non:\n  push:\n    branches: [ops/review-requests]\njobs:\n  apply:\n    runs-on: ubuntu-latest\n    steps: [{ run: "echo apply" }]\n';

const PR = 1496;
const REQUEST_PATH = `ops/review-requests/${PR}-review-accepted.json`;
const REQUEST = JSON.stringify({ pr: PR, repo: FIXTURE_SLUG, to: 'review:accepted', actor: 'operator' }, null, 2);

/**
 * Drive the REAL sink once. `run`/`mkdir`/`write`/`rm` are left at their production defaults on purpose —
 * a partially-injected sink is #1497's lesson and the reason this file exists at all.
 *
 * `now` IS injected, and only because two stages inside one millisecond would otherwise pick the same
 * worktree directory. That is a clock collision, not a git fact, so faking it removes noise rather than
 * removing the subject.
 */
function stage(ctx, over = {}) {
  let tick = 0;
  // `root` (the DRIVER's checkout) is deliberately a DIFFERENT directory from `repoRoot` (the board's). In
  // production those genuinely differ — that is #3261's whole point, one board per repo — and a fixture that
  // collapsed them would make the sink's `board`-versus-`root` distinctions untestable. It cost exactly that
  // once: with the two equal, moving the `worktree prune` from the board to the driver changed nothing and
  // the mutation survived. Here `root` is a real checkout of a DIFFERENT origin, so pruning it is a
  // no-op on the board — which is the damage.
  const sinks = createRecordVerdictSinks({ root: driverRootFor(ctx), repoRoot: ctx.clone, now: () => ++tick + 1_000 });
  return sinks[STAGE_REQUEST_EFFECT]({
    repo: FIXTURE_SLUG, path: REQUEST_PATH, content: REQUEST, pr: PR, to: 'review:accepted', ...over,
  });
}

/**
 * A separate, real git checkout standing in for the DRIVER's own repo — the checkout the operation was
 * invoked from, which under #3261 is routinely not the board's. Created lazily, once per fixture.
 */
function driverRootFor(ctx) {
  if (!ctx.driverRoot) {
    const dir = join(ctx.tmp, 'driver');
    mkdirSync(dir, { recursive: true });
    ctx.git(['init', '--quiet', '-b', DEFAULT_BRANCH, '.'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# driver checkout\n');
    ctx.git(['add', '--', 'README.md'], { cwd: dir });
    ctx.git(['commit', '--quiet', '-m', 'driver: initial'], { cwd: dir });
    ctx.driverRoot = dir;
  }
  return ctx.driverRoot;
}

/** Put the applier on the origin's `main`, so a board cut from it is one that can actually apply. */
function seedApplierOnMain(ctx) {
  ctx.seedOriginBranch(DEFAULT_BRANCH, { [APPLIER_WORKFLOW]: APPLIER });
}

describe('the fixtures themselves — asserted, never assumed', () => {
  /**
   * THE FIXTURE IS THE SUBJECT HERE. `--single-branch` is a flag, and a flag is a promise about behaviour
   * that a future git could keep differently. If it ever stops narrowing `remote.origin.fetch`, every
   * "narrow clone" test below silently becomes a second copy of the full-clone tests and the reproduction
   * evaporates with nothing going red. So the geometry is read out of the clone's own config and asserted.
   */
  it('withNarrowClone produces a clone whose fetch refspec has NO wildcard', async () => {
    await withNarrowClone(async (ctx) => {
      expect(ctx.fetchRefspecs()).toEqual([`+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}`]);
      expect(ctx.fetchRefspecs().join(' ')).not.toContain('*');
    });
  });

  it('withBareOrigin produces a full clone whose fetch refspec DOES carry the wildcard', async () => {
    await withBareOrigin(async (ctx) => {
      expect(ctx.fetchRefspecs()).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
    });
  });

  /**
   * THE BUG ITSELF, isolated from the sink — the one fact no stub can hold. A bare `fetch origin <branch>`
   * in a narrow clone SUCCEEDS, writes `FETCH_HEAD`, and creates no `refs/remotes/origin/<branch>`. This
   * test is what makes every "and therefore the sink must use `trackingRefspec`" claim below checkable
   * rather than asserted, and it is why reverting the refspec is a real revert and not a cosmetic one.
   */
  it('a bare `fetch origin <branch>` leaves NO origin/<branch> in a narrow clone — with an explicit refspec it appears', async () => {
    await withNarrowClone(async (ctx) => {
      ctx.seedOriginBranch(TRANSPORT_BRANCH, { [APPLIER_WORKFLOW]: APPLIER });

      ctx.git(['fetch', '--quiet', 'origin', TRANSPORT_BRANCH]);
      expect(() => ctx.git(['rev-parse', '--verify', `origin/${TRANSPORT_BRANCH}`])).toThrow();

      ctx.git(['fetch', '--quiet', 'origin', trackingRefspec(TRANSPORT_BRANCH)]);
      expect(ctx.git(['rev-parse', '--verify', `origin/${TRANSPORT_BRANCH}`]).trim()).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  /** The same fetch in a FULL clone works — which is precisely why #3264 hid for months. `we:` is cloned
   *  this way, so every developer machine and every CI run took the path that happens to be fine. */
  it('the same bare fetch DOES create origin/<branch> in a full clone — the geometry that hid #3264', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(TRANSPORT_BRANCH, { [APPLIER_WORKFLOW]: APPLIER });
      ctx.git(['fetch', '--quiet', 'origin', TRANSPORT_BRANCH]);
      expect(ctx.git(['rev-parse', '--verify', `origin/${TRANSPORT_BRANCH}`]).trim()).toMatch(/^[0-9a-f]{40}$/);
    });
  });
});

describe('the sink against a NARROW clone — the #3264 reproduction', () => {
  /**
   * ★ THE LOAD-BEARING TEST. Reverting `trackingRefspec(TRANSPORT_BRANCH)` to a bare `TRANSPORT_BRANCH` in
   * `record-verdict-io.mjs`'s stage effect makes this fail with the production error verbatim:
   * `fatal: invalid reference: origin/ops/review-requests`. Verified by running the revert.
   *
   * It asserts the OUTCOME on the origin, not the argv: the request's bytes have to be readable off the bare
   * repo's `ops/review-requests` afterwards. A test that asserted the fetch's arguments would pass under the
   * revert-and-respell, which is the failure mode this whole file is a correction for.
   */
  it('stages and pushes a verdict from a NARROW clone', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(TRANSPORT_BRANCH);

      const result = await stage(ctx);

      expect(result).toEqual({ path: REQUEST_PATH, pushed: true });
      expect(ctx.showOnOrigin(TRANSPORT_BRANCH, REQUEST_PATH)).toBe(REQUEST);
    });
  });

  /**
   * THE SEPARATE-WORKTREE PROPERTY, stated as the damage it prevents: the caller is standing in a lane with
   * uncommitted work, and checking the transport branch out over it would take that work with it. The
   * module's header records that this was done BY HAND once and disrupted a running juror.
   *
   * A stub cannot witness this — "did a checkout move the caller's HEAD" is a property of a real working
   * tree. Moving the `checkout -B` from `{ cwd: wt }` to `{ cwd: board }` reddens it.
   */
  it('never touches the caller\'s checkout — its branch, its HEAD and its uncommitted work all survive', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(TRANSPORT_BRANCH);

      ctx.git(['checkout', '--quiet', '-b', 'lane/some-work']);
      ctx.commit({ 'src/thing.txt': 'committed lane work\n' }, 'lane: work in progress');
      writeFileSync(join(ctx.clone, 'src', 'thing.txt'), 'UNCOMMITTED EDIT\n');
      const headBefore = ctx.git(['rev-parse', 'HEAD']).trim();

      await stage(ctx);

      expect(ctx.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('lane/some-work');
      expect(ctx.git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
      expect(readFileSync(join(ctx.clone, 'src', 'thing.txt'), 'utf8')).toBe('UNCOMMITTED EDIT\n');
    });
  });

  /**
   * `idempotent: true` has to mean something on the transport, not only in the engine's bookkeeping. The
   * second stage of an IDENTICAL request finds nothing staged, commits nothing and pushes nothing — and
   * that is a SUCCESS, because the transport already holds exactly what the caller asked for.
   *
   * Deleting the `if (!staged) return …` guard makes real `git commit` die with `nothing to commit`, so
   * this reddens. The stub suite can only check that the guard is reached; it cannot check that removing it
   * breaks, because a stubbed `commit` never refuses an empty index.
   */
  it('a second IDENTICAL stage pushes nothing and reports why — not a failed commit', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(TRANSPORT_BRANCH);

      await stage(ctx);
      const tipAfterFirst = ctx.git(['rev-parse', `${TRANSPORT_BRANCH}`], { cwd: ctx.origin }).trim();

      const second = await stage(ctx);

      expect(second).toEqual({ path: REQUEST_PATH, pushed: false, reason: 'identical request already staged' });
      expect(ctx.git(['rev-parse', `${TRANSPORT_BRANCH}`], { cwd: ctx.origin }).trim()).toBe(tipAfterFirst);
    });
  });

  /**
   * THE STRANDED-WORKTREE FAILURE, which only exists in a real `.git`. The sink's `finally` removes the
   * worktree directory and then prunes its registration IN THE BOARD. Skip either and the NEXT stage's
   * `checkout -B ops/review-requests` is refused by git with `already used by worktree at …` — one bad run
   * turning every subsequent run into a failure, which is exactly what that `finally` is written to prevent.
   *
   * Three consecutive stages of DIFFERENT requests is the smallest shape that catches it, and it also
   * proves the registrations do not accumulate.
   */
  it('three consecutive stages all succeed — no worktree registration is left stranded', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(TRANSPORT_BRANCH);

      for (const pr of [101, 102, 103]) {
        const path = `ops/review-requests/${pr}-review-accepted.json`;
        const result = await stage(ctx, { pr, path, content: `{"pr":${pr}}` });
        expect(result).toEqual({ path, pushed: true });
      }

      expect(ctx.git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(1);
      expect(existsSync(join(ctx.clone, '.operations', 'transport', 'wt-1001'))).toBe(false);
      for (const pr of [101, 102, 103]) {
        expect(ctx.showOnOrigin(TRANSPORT_BRANCH, `ops/review-requests/${pr}-review-accepted.json`)).toBe(`{"pr":${pr}}`);
      }
    });
  });
});

describe('board genesis against a REAL origin (#3264)', () => {
  /**
   * The onboarding path #3261 turned from a curiosity into the normal case: every repo now owns its own
   * board, so the FIRST verdict for a repo meets an origin that has no `ops/review-requests` at all. Before
   * `ensureBoardBranch` that failed on a raw `couldn't find remote ref`, and plateau-app was onboarded by
   * hand with a command that lived only in a backlog paragraph.
   */
  it('cuts the board from main on a repo that has never carried a verdict, then stages onto it', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      expect(ctx.originBranches()).toEqual([DEFAULT_BRANCH]);

      const result = await stage(ctx);

      expect(result).toEqual({ path: REQUEST_PATH, pushed: true });
      expect(ctx.originBranches().sort()).toEqual([DEFAULT_BRANCH, TRANSPORT_BRANCH]);
      expect(ctx.showOnOrigin(TRANSPORT_BRANCH, REQUEST_PATH)).toBe(REQUEST);
      // Cut from `main`, so the applier rides it — see APPLIER_WORKFLOW's own docblock.
      expect(ctx.showOnOrigin(TRANSPORT_BRANCH, APPLIER_WORKFLOW)).toBe(APPLIER);
    });
  });

  /**
   * GENESIS PUSHES FROM `refs/remotes/origin/main`, NEVER THE LOCAL BRANCH — and this is the test that can
   * tell the two apart, because it makes them differ. The applier lands on the origin's `main` AFTER the
   * clone exists, so the clone's local `main` is a commit behind and does NOT carry it.
   *
   * Cutting from the local branch would produce a board without the applier, which
   * `assertApplierRidesBoard` then refuses — so the mutation `refs/remotes/origin/main` → `main` reddens
   * here with that refusal. Dropping the preparatory `fetch trackingRefspec(sourceBranch)` reddens it the
   * same way, one ref over: a stale `origin/main` is stale in exactly the way a local branch is.
   */
  it('cuts from the REMOTE tip, not the checkout\'s stale local main', async () => {
    await withNarrowClone(async (ctx) => {
      // The clone already exists at this point; the applier arrives on the origin afterwards.
      seedApplierOnMain(ctx);
      expect(ctx.git(['ls-tree', '--name-only', 'HEAD', '--', APPLIER_WORKFLOW]).trim()).toBe('');

      await stage(ctx);

      expect(ctx.showOnOrigin(TRANSPORT_BRANCH, APPLIER_WORKFLOW)).toBe(APPLIER);
    });
  });

  /**
   * A BOARD THAT EXISTS MUST NOT BE RE-CUT. Re-cutting is a force-push, and the module's own refusal text
   * spells out what it costs: any request sitting on the board that was never applied is discarded with no
   * other record.
   *
   * The seeded board carries a marker file that a cut from `main` would not have, so "was it re-cut" is a
   * fact about the tree rather than about a call count.
   */
  it('does not re-cut a board that already exists — the existing history survives', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(TRANSPORT_BRANCH, { 'ops/review-requests/PRIOR.json': '{"prior":true}' });

      await stage(ctx);

      expect(ctx.showOnOrigin(TRANSPORT_BRANCH, 'ops/review-requests/PRIOR.json')).toBe('{"prior":true}');
      expect(ctx.showOnOrigin(TRANSPORT_BRANCH, REQUEST_PATH)).toBe(REQUEST);
    });
  });

  /**
   * `ls-remote`'s patterns match a ref's TAIL, so `ops/review-requests` also answers for
   * `refs/heads/legacy/ops/review-requests`. `ensureBoardBranch` therefore reads the output as a SET OF
   * EXACT REF NAMES, and this is the origin that tells the two readings apart: a decoy whose tail matches
   * and no real board.
   *
   * Reverting the set-membership check to a substring test on the raw output (`listed.includes(...)`, or
   * the even looser `if (listed) return`) makes genesis conclude the board exists, skip it, and hand the
   * caller the raw `fatal: couldn't find remote ref` this function was written to prevent. Verified.
   */
  it('a decoy ref whose TAIL matches the board is not the board — genesis still runs', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(`legacy/${TRANSPORT_BRANCH}`, { 'DECOY.md': 'not the board\n' });
      expect(ctx.originBranches()).not.toContain(TRANSPORT_BRANCH);

      const result = await stage(ctx);

      expect(result).toEqual({ path: REQUEST_PATH, pushed: true });
      expect(ctx.originBranches()).toContain(TRANSPORT_BRANCH);
      // The decoy is untouched — genesis cut from `main`, not from the thing that merely matched.
      expect(() => ctx.showOnOrigin(TRANSPORT_BRANCH, 'DECOY.md')).toThrow();
    });
  });

  /** No board and no `main` to cut one from is an ONBOARDING refusal that names the hand step, never a raw
   *  git error. Reached here with a real origin carrying neither ref. */
  it('refuses with the onboarding instruction when the origin has neither the board nor main', async () => {
    await withNarrowClone(async (ctx) => {
      // A bare repo refuses to delete the branch its own HEAD names, so HEAD is moved aside first. The
      // resulting origin — reachable, with no refs at all — is what a repo looks like before its first push.
      ctx.setOriginHead('nothing-here');
      ctx.git(['push', '--quiet', 'origin', `:refs/heads/${DEFAULT_BRANCH}`]);
      expect(ctx.originBranches()).toEqual([]);

      await expect(stage(ctx)).rejects.toThrow(/carries no `ops\/review-requests` board and no `main` to cut one from/);
    });
  });
});

describe('the applier must ride the board (#3264)', () => {
  /**
   * THE FAIL-SILENT this refusal closes: GitHub runs a push-triggered workflow from the definition ON THE
   * PUSHED REF. A board without the applier accepts every push and applies nothing — the run reports
   * `pushed: true`, and no label ever moves.
   *
   * The board here is a real orphan branch carrying no workflow, which is the shape a hand-cut
   * `git checkout --orphan` produces and the shape the module's header records as the original accident.
   */
  it('refuses to stage onto a board whose tree does not carry the applier', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      // A REAL orphan board: no history from main, therefore no applier.
      const orphan = join(ctx.tmp, 'orphan');
      mkdirSync(orphan, { recursive: true });
      ctx.git(['init', '--quiet', '-b', TRANSPORT_BRANCH, '.'], { cwd: orphan });
      ctx.git(['config', 'user.email', 'harness@example.invalid'], { cwd: orphan });
      ctx.git(['config', 'user.name', 'Ops Harness'], { cwd: orphan });
      ctx.git(['config', 'commit.gpgsign', 'false'], { cwd: orphan });
      writeFileSync(join(orphan, 'README.md'), '# orphan board\n');
      ctx.git(['add', '--', 'README.md'], { cwd: orphan });
      ctx.git(['commit', '--quiet', '-m', 'orphan board'], { cwd: orphan });
      ctx.git(['push', '--quiet', ctx.origin, `HEAD:refs/heads/${TRANSPORT_BRANCH}`], { cwd: orphan });
      rmSync(orphan, { recursive: true, force: true });

      await expect(stage(ctx)).rejects.toThrow(/does not carry\s+`\.github\/workflows\/apply-review-request\.yml`/);
    });
  });

  /**
   * REFUSED BEFORE THE WRITE, and the origin is the witness. A board that cannot apply must not receive a
   * commit it can never act on — otherwise the transport accumulates requests that look staged forever.
   */
  it('the refusal leaves the board\'s tip exactly where it was — nothing is committed to a dead board', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      // A board cut from a `main` that PREDATES the applier — the ordering hazard `ensureBoardBranch`'s
      // docblock names, reproduced by cutting the board from the clone's stale local main.
      ctx.git(['push', '--quiet', 'origin', `refs/heads/${DEFAULT_BRANCH}:refs/heads/${TRANSPORT_BRANCH}`]);
      const tipBefore = ctx.git(['rev-parse', TRANSPORT_BRANCH], { cwd: ctx.origin }).trim();

      await expect(stage(ctx)).rejects.toThrow(/refusing to stage onto/);

      expect(ctx.git(['rev-parse', TRANSPORT_BRANCH], { cwd: ctx.origin }).trim()).toBe(tipBefore);
    });
  });

  /**
   * THE APPLIER IS READ FROM THE BOARD'S OWN TREE, never the driver's checkout. Here the driver's `main`
   * carries the applier and the board does not, so the two disagree — and conflating them is the exact
   * assumption the module's header names as what made this silent.
   *
   * Moving `assertApplierRidesBoard`'s `ls-tree` from `{ cwd: wt }` to `{ cwd: board }` makes it read the
   * driver's checkout, find the applier there, and pass. This test is the one that goes red.
   */
  it('reads the applier from the BOARD tree even when the driver\'s own checkout has it', async () => {
    await withNarrowClone(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.git(['fetch', '--quiet', 'origin', DEFAULT_BRANCH]);
      ctx.git(['reset', '--hard', '--quiet', 'FETCH_HEAD']);
      expect(ctx.git(['ls-tree', '--name-only', 'HEAD', '--', APPLIER_WORKFLOW]).trim()).toBe(APPLIER_WORKFLOW);

      // The board, meanwhile, is cut from the commit BEFORE the applier landed.
      ctx.git(['push', '--quiet', 'origin', `${ctx.git(['rev-parse', 'HEAD~1']).trim()}:refs/heads/${TRANSPORT_BRANCH}`]);

      await expect(stage(ctx)).rejects.toThrow(/refusing to stage onto/);
    });
  });
});

describe('which board a verdict belongs on, read off a REAL remote (#3261)', () => {
  /**
   * `defaultOriginRepo` is INJECTED everywhere in the stub suite, so its actual behaviour — parsing a slug
   * out of a real `git remote get-url origin` — has never been executed by a test. It is also the function
   * that decides whether a verdict is refused, so a wrong answer here is a verdict pushed to the wrong
   * repo's board where the right applier will never see it (plateau-app#144's failure).
   *
   * The fixture origin is a DIRECTORY named `<tmp>/web-everything/web-everything.git` precisely so this can be
   * exercised without a URL that resolves off the machine — see `helpers/real-repo.mjs`, detail (2).
   */
  it('reads owner/name off a real origin remote', async () => {
    await withBareOrigin(async (ctx) => {
      expect(defaultOriginRepo(ctx.clone)).toBe(FIXTURE_SLUG);
      expect(resolveTransportRoot({ repo: FIXTURE_SLUG, root: ctx.clone })).toBe(ctx.clone);
    });
  });

  /** The 2026-10-03 org move left every clone/lane with `chalbert/<repo>` origins; they must read as the CURRENT
   *  slug or every review refuses before its read step (outage). Real git, URL never fetched. */
  it('reads a legacy chalbert/ origin as the repo\'s current slug', async () => {
    await withBareOrigin(async (ctx) => {
      execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:chalbert/web-everything.git'], { cwd: ctx.clone });
      expect(defaultOriginRepo(ctx.clone)).toBe('web-everything/web-everything');
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/chalbert/frontierui.git'], { cwd: ctx.clone });
      expect(defaultOriginRepo(ctx.clone)).toBe('frontier-ui/frontierui');
    });
  });

  /** A directory that is not a git checkout at all must read as `''` and never throw — probing is
   *  best-effort by contract, and a throw here would turn an unknown remote into a crash. */
  it('a non-repo directory reads as unknown rather than throwing', async () => {
    await withBareOrigin(async (ctx) => {
      const notARepo = join(ctx.tmp, 'not-a-repo');
      mkdirSync(notARepo, { recursive: true });
      expect(defaultOriginRepo(notARepo)).toBe('');
    });
  });

  /**
   * THE REFUSAL, driven end to end with a real remote behind it. A `plateau-app` verdict staged against a
   * `web-everything` checkout must never reach the push — and the origin proves nothing was written.
   */
  it('refuses a sibling repo\'s verdict against this checkout, and writes nothing', async () => {
    await withBareOrigin(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(TRANSPORT_BRANCH);
      const tipBefore = ctx.git(['rev-parse', TRANSPORT_BRANCH], { cwd: ctx.origin }).trim();

      await expect(stage(ctx, { repo: 'plateauapp/plateau-app' })).rejects.toThrow(/refusing to stage a verdict for plateauapp\/plateau-app on web-everything\/web-everything's transport branch/);

      expect(ctx.git(['rev-parse', TRANSPORT_BRANCH], { cwd: ctx.origin }).trim()).toBe(tipBefore);
    });
  });
});

describe('the sink against a FULL clone — the happy geometry still works', () => {
  /**
   * The full clone is not the reproduction, but it IS the geometry every developer machine and CI run has,
   * so a fix for #3264 that only worked on narrow clones would be a new outage. Kept deliberately thin: one
   * end-to-end stage, asserted on the origin.
   */
  it('stages and pushes a verdict from a full clone too', async () => {
    await withBareOrigin(async (ctx) => {
      seedApplierOnMain(ctx);
      ctx.seedOriginBranch(TRANSPORT_BRANCH);

      expect(await stage(ctx)).toEqual({ path: REQUEST_PATH, pushed: true });
      expect(ctx.showOnOrigin(TRANSPORT_BRANCH, REQUEST_PATH)).toBe(REQUEST);
    });
  });
});

/** No shared mutable state: every fixture owns its own temp root and tears it down in a `finally`. These
 *  hooks exist only to make that explicit to the next reader. */
beforeEach(() => {});
afterEach(() => {});
