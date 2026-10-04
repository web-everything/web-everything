/**
 * @file breaks/already-landed-pr-gets-fixer.mjs — live break, 2026-09-26 (backlog card #4034, epic #4075). A PR
 * whose own content ALREADY LANDED on `main` through a different PR kept getting a mechanical conflict-fix
 * session dispatched at it by the fix-dispatch daemon.
 *
 * LIVE INCIDENT: web-everything/web-everything PR #2752 (`lane/4034-critical-work-gate`). PR #2759 was stacked on
 * #2752's branch and merged first, carrying every one of #2752's commits onto `main`; `main` then refined those
 * files further. #2752's own branch was separately rebased afterward, drifted to `mergeable: CONFLICTING`, and
 * was labelled `merge-status:conflicting` (+ `review:changes`, with findings). The reconcile planner
 * (`we:scripts/conveyor/reconcile-pass.mjs` → `we:scripts/conveyor/reconcile-core.mjs#planReconcile`, run every
 * tick by the fix-dispatch daemon via `we:scripts/conveyor/reconcile-fix-dispatch.mjs`) matched it on the
 * `isConflictBounce` route and dispatched `fix` ("bounced with N finding(s) via a mechanical conflict-resolution
 * route") — wasted work at best, and at worst a fixer "resolving" the apparent conflict by reverting the carrier
 * PR's later refinements.
 *
 * FIX: PR #2769 (`lane/already-landed-pr-watch` — first written against c796444b3; after the rebase and the
 * review:changes round the fix is 3edeb54b4 (detection) + ff7b78b19 (review fixes), and the soak's fake GitHub
 * mirrors `refs/pull/<n>/head` for the fetch-by-PR-number read, b37558909).
 *   - `scripts/lib/already-landed-content.mjs` (pure): a PR is already landed when, for EVERY file it touches
 *     (mode + blob, renames split into delete + add), the PR head's version equals one some commit in
 *     `<merge-base>..main` held for it, and `main`'s tip still carries the change (blob identity survives the
 *     rebase; matching anywhere in that window survives `main`'s later refinement — a plain `merge-tree` or tip
 *     diff false-negatives on both).
 *   - `reconcile-pass.mjs#enrichPrsWithAlreadyLandedFacts` computes that verdict with real `git`/`gh` reads,
 *     ONLY for PRs carrying `merge-status:conflicting`, and attaches `alreadyLandedInMain: {carrierPr}`.
 *   - `reconcile-core.mjs` refuses `already-landed` ahead of every dispatch branch once that fact is present.
 *
 * SCENARIO (fix-dispatch daemon only, no default fleet — this break needs exactly one PR):
 *   1. a victim branch `lane/soak-already-landed` is cut from `main` adding `soak/already-landed.txt` (blob B1);
 *   2. a "carrier" commit lands the SAME B1 content on `main` (via `api.moveMain`, so the behind/lag invariants
 *      track it), then a second `main` commit refines the file to B2 — `main`'s tip no longer equals the PR's
 *      blob, exactly like the live case;
 *   3. the victim's merge-base predates the file on both sides, so the fake GitHub's real `git merge-tree`
 *      reports add/add → `mergeable: CONFLICTING` (`we:scripts/conveyor/__tests__/helpers/fake-gh.mjs#
 *      computeMergeStatus`), and the PR is opened `review:changes` + `merge-status:conflicting` with a reviewer
 *      finding — the live PR's state.
 *   The daemon runs in the sim clone (cwd), whose `origin` is the world's bare remote, so the fix's
 *   `git fetch origin refs/pull/<n>/head` / `git rev-parse <sha>:<path>` / `git log origin/main -- <path>` resolve
 *   against real git. Carrier attribution (`gh api repos/.../commits/<sha>/pulls`) is NOT supported by the
 *   fake gh — it exits 1, `defaultReadPullsForCommit` degrades to `[]`, and the refusal still fires with
 *   `carrierPr: null` (the containment verdict alone refuses; attribution is best-effort by design).
 *
 * JUDGE: a `perRound` hook scans the fake claude's sessions (live or finished) for a `fix-…<victim PR>` session
 * and reports it once as a `fix-at-landed-pr` violation. Other invariants' noise is filtered out.
 * RED  = pre-fix: the conflict-fix route dispatches a `fix-<pr>` session within the first tick.
 * GREEN = with the fix: reconcile refuses `already-landed` every tick and no fix session is ever spawned.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';
import { sessionMatches } from '../invariants.mjs';

/** Pre-fix, the first fix-dispatch tick already dispatches. `perRound` runs BEFORE its round's tick, so a
 *  dispatch is seen (and reported, on the next tick's line) one round later: 3 rounds = 3 ticks, the first two
 *  inspected — enough to show GREEN holds past the first tick, as short as reproduces RED. */
const ROUNDS = 3;
const FILE = 'soak/already-landed.txt';
const B1 = 'already-landed content, as the victim PR wrote it\n';
const B2 = 'already-landed content, as the victim PR wrote it\nrefined further on main after the carrier landed it\n';

export default {
  id: 'already-landed-pr-gets-fixer',
  title: 'fix-dispatch sends a mechanical conflict-fix at a conflicting PR whose content already landed on main via another PR',
  card: 'backlog #4034 / PR #2769 (lane/already-landed-pr-watch), live incident PR #2752 (epic #4075)',
  fixedBy: {
    sha: '3edeb54b4,ff7b78b19', // detection + its review:changes round — `red-green.mjs --revert` takes a list
    where: 'lane/already-landed-pr-watch',
    paths: ['scripts/lib/already-landed-content.mjs', 'scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-core.mjs'],
  },
  fixPresent(root) {
    try {
      if (!existsSync(join(root, 'scripts/lib/already-landed-content.mjs'))) return false;
      const core = readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8');
      const pass = readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8');
      return /refuse\('already-landed'/.test(core) && /enrichPrsWithAlreadyLandedFacts/.test(pass);
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:already-landed-pr-gets-fixer',
      rounds: ROUNDS,
      daemons: ['fix-dispatch'], // reconcile's conflict-fix route is the fix-dispatch daemon's
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      setup(w, { api }) {
        const head = 'lane/soak-already-landed';
        w.git.createBranch('we', head, { from: 'main', files: { [FILE]: B1 } });
        const carrier = api.moveMain(w, { [FILE]: B1 }, 'soak: carrier PR lands the victim PR\'s content');
        const refined = api.moveMain(w, { [FILE]: B2 }, 'soak: main refines the carried content further');
        const pr = w.gh.openPr({
          repo: 'we', head, base: 'main', title: 'soak: already landed via a carrier PR, now conflicting',
          labels: ['review:changes', 'merge-status:conflicting'], body: 'No backlog item.',
        });
        w.gh.setChecks('we', pr, [{ name: 'test', conclusion: 'SUCCESS' }]);
        w.gh.comment('we', pr, '1. soak finding: resolve the merge conflict with main', { author: 'review-bot' });
        api.say(`setup: victim PR #${pr} (${head}); carrier ${carrier.slice(0, 9)} landed its blob, ${refined.slice(0, 9)} refined it`);
        return { victimPr: pr, reported: false };
      },
      perRound(w, round, ctx, api) {
        if (ctx.reported) return;
        const hit = w.claude.sessions().find((s) => sessionMatches(s.name, 'fix', ctx.victimPr));
        if (hit) {
          ctx.reported = true;
          api.violation('fix-at-landed-pr', `PR #${ctx.victimPr} already landed on main via a carrier commit, yet fix session "${hit.name}" was dispatched at it (seen before round ${round})`);
        }
      },
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === 'fix-at-landed-pr' || v.invariant === 'crash' || v.invariant === 'isolation')
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
