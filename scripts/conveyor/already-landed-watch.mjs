#!/usr/bin/env node
/**
 * @file scripts/conveyor/already-landed-watch.mjs
 * @description THE ALREADY-LANDED WATCH — the ACT half of the live incident closed by
 *   `we:scripts/lib/already-landed-content.mjs` / `we:scripts/conveyor/reconcile-core.mjs`'s `already-landed`
 *   refusal (web-everything/web-everything PR #2752, #4034/#2748). `reconcile-core.mjs` already stops the planner
 *   from dispatching a fix/review/ci-heal at a PR whose content is already, file-by-file, on `main` — this pass
 *   is what actually CLOSES that PR and resolves its backlog card, since a refusal alone leaves the PR sitting
 *   open forever with nothing coming to clear it (mirrors why `we:scripts/conveyor/parked-pr-conflict-watch.mjs`
 *   needs its own comment/label step beyond the reconciler's refusal, and why `we:scripts/backlog-stranded-sweep.mjs`
 *   needs its own `--apply` beyond its own report).
 *
 * REUSES THE RECONCILE PASS'S OWN VERDICT, NEVER A SECOND DETECTOR. This file calls
 * `we:scripts/conveyor/reconcile-pass.mjs#runReconcilePass` and filters its `refusals` for
 * `kind: 'already-landed'` — the SAME per-file blob-identity check `reconcile-core.mjs`'s own dispatch decision
 * already ran, computed by `enrichPrsWithAlreadyLandedFacts`. Building a parallel detector here would risk the
 * two ever disagreeing about which PRs are already-landed; there is exactly one place that decides.
 *
 * WHAT "CLOSE" MEANS, PRECISELY:
 *   1. Post one comment on the PR naming the carrier PR (`refusal.carrierPr`), or — when attribution could not
 *      be confirmed (`we:scripts/lib/already-landed-content.mjs#attributeCarrierPr`'s own "never guess" rule) —
 *      a comment that still states the containment fact without naming a PR it cannot back up.
 *   2. `gh pr close` the PR. Never a merge — there is nothing left for this PR's OWN branch to contribute.
 *   3. Resolve the backlog item the CLOSED PR's OWN lane ref names (`laneRefItemNum(pr.headRefName)`,
 *      `we:scripts/conveyor/lease-reaper.mjs`) through the drain's own `resolveLandedItem`
 *      (`we:scripts/lane-drain.mjs`, #2748) — THE ONE resolve-on-land home, never a second resolver (mirrors
 *      `we:scripts/backlog-stranded-sweep.mjs`'s own reuse of it). This is a STRONGER, more direct signal than
 *      that sweep's own cross-referencing of an unrelated merged PR's ref/title: the PR THIS pass is closing
 *      names its own item directly, and its content has already been confirmed (by the SAME per-file check) to
 *      be on `main`. A PR whose ref names no item (`laneRefItemNum` returns `null`) simply skips step 3 — no
 *      guess is made about which card, if any, it was for. Step 3 also runs ONLY when step 2 succeeded: a PR
 *      that failed to close is still open, so its card must stay open with it.
 *
 * DRY-RUN BY DEFAULT, LIKE EVERY SIBLING WATCH IN THIS FILE'S FAMILY (`parked-pr-conflict-watch.mjs`,
 * `duplicate-pr-watch.mjs`). `--apply` performs the three actions above; without it, this only reports what it
 * WOULD do — the read-only proof this item's own live case required.
 *
 * PURE-CORE / IO-SHELL SPLIT: {@link buildAlreadyLandedComment} and {@link planAlreadyLandedCloses} are PURE —
 * no fs/git/gh/clock. The IO shell ({@link defaultPostComment}, {@link defaultClosePr}, {@link runAlreadyLandedWatch},
 * the CLI) owns every `gh`/`git`/backlog-mutating call.
 */
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { runReconcilePass } from './reconcile-pass.mjs';
import { laneRefItemNum } from './lease-reaper.mjs';
import { resolveLandedItem } from '../lane-drain.mjs';
// #4268 — the SAME dispatch-chokepoint staleness guard `reconcile-fix-dispatch.mjs` runs before it will act:
// this watch reads main PURELY LOCALLY (via `reconcile-pass.mjs#enrichPrsWithAlreadyLandedFacts`, no fetch of
// its own) and is invoked as its OWN standalone CLI/watch, never through `reconcile-fix-dispatch.mjs`, so it
// never inherited that guard. A stale local `origin/main` here can find a PR "already landed" against a main
// that has since moved on; `--apply` then closes a still-needed PR and resolves its card out from under it.
import { assertMainNotStale } from '../operations/review-dispatch.mjs';
import { REPO_ROOT } from '../operations/dispatch-lane-io.mjs';

/** The name of THIS pass, for attribution on anything it posts (mirrors `duplicate-pr-watch.mjs#AGENT_NAME`). */
export const AGENT_NAME = 'already-landed-watch';

// ── PURE CORE (no fs / git / gh / clock / process — every input is injected) ───────────────────────────────

/**
 * we:scripts/conveyor/already-landed-watch.mjs#buildAlreadyLandedComment — the comment posted on a PR this
 * pass is about to close. Pure string builder. Names the carrier PR when attribution was confirmed; otherwise
 * states the containment fact alone (never invents a carrier — see `attributeCarrierPr`'s own "never guess"
 * rule).
 * @param {{carrierPr:(number|null)}} refusal
 * @returns {string}
 */
export function buildAlreadyLandedComment({ carrierPr = null } = {}) {
  const lines = ['🔒 **already landed — closing as redundant**', ''];
  lines.push(
    carrierPr
      ? `Every file this PR touches is already, byte-for-byte, present on \`main\` — carried there by #${carrierPr}, ` +
        'which stacked on (or otherwise carried) this branch\'s commits and merged first, while this PR\'s own ' +
        'branch was separately rebased and drifted into an apparent conflict.'
      : 'Every file this PR touches is already, byte-for-byte, present on `main` (verified file-by-file against ' +
        'main\'s own commit history), though the PR that carried it there could not be attributed with confidence.',
  );
  lines.push('', 'There is nothing left here to fix or review, so this closes it rather than dispatching either.');
  lines.push('', `(mechanical pass: ${AGENT_NAME}, live incident #4034/#2748)`);
  return lines.join('\n');
}

/**
 * we:scripts/conveyor/already-landed-watch.mjs#planAlreadyLandedCloses — narrow a `runReconcilePass` plan's own
 * `refusals` to the `already-landed` ones and turn each into a concrete action plan: which PR to close, the
 * comment to post, and which backlog item (if any) its own lane ref names. Pure.
 * @param {{refusals:Array<object>}} reconcilePlan
 * @returns {Array<{prNumber:number, carrierPr:(number|null), headRefName:(string|null), itemNum:(string|null),
 *   comment:string}>}
 */
export function planAlreadyLandedCloses(reconcilePlan) {
  const refusals = Array.isArray(reconcilePlan?.refusals) ? reconcilePlan.refusals : [];
  return refusals
    .filter((r) => r?.kind === 'already-landed')
    .map((r) => {
      const headRefName = r?.headRefName ?? null;
      return {
        prNumber: r.prNumber,
        carrierPr: r.carrierPr ?? null,
        headRefName,
        itemNum: headRefName ? laneRefItemNum(headRefName) : null,
        comment: buildAlreadyLandedComment({ carrierPr: r.carrierPr ?? null }),
      };
    });
}

// ── IO SHELL ─────────────────────────────────────────────────────────────────────────────────────────────

/** Post one comment on a PR. @returns {boolean} whether the call succeeded. */
export function defaultPostComment(prNumber, body, { exec = execFileSyncThrottled, repo = null } = {}) {
  try {
    const argv = ['pr', 'comment', String(prNumber), '--body', body];
    if (repo) argv.push('--repo', repo);
    exec('gh', argv, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

/** Close a PR (never merge — there is nothing left this PR's own branch contributes). @returns {boolean} */
export function defaultClosePr(prNumber, { exec = execFileSyncThrottled, repo = null } = {}) {
  try {
    const argv = ['pr', 'close', String(prNumber)];
    if (repo) argv.push('--repo', repo);
    exec('gh', argv, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * we:scripts/conveyor/already-landed-watch.mjs#runAlreadyLandedWatch — read (via the reconcile pass), decide
 * (via {@link planAlreadyLandedCloses}), and — only under `--apply` — act. Dry-run by default.
 * @param {{repo?:string|null, apply?:boolean, readPlan?:Function, postComment?:Function, closePr?:Function,
 *   resolveItem?:Function, cwd?:string, root?:string, checkStaleness?:Function}} [o]
 * @returns {{planned:Array<object>, applied:Array<object>}}
 */
export function runAlreadyLandedWatch({
  repo = null, apply = false, readPlan = runReconcilePass, postComment = defaultPostComment,
  closePr = defaultClosePr, resolveItem = resolveLandedItem, cwd = process.cwd(),
  root = REPO_ROOT, checkStaleness,
} = {}) {
  // #4268 — refuse (or auto-fast-forward, exactly like `reconcile-fix-dispatch.mjs`'s own dispatch chokepoint)
  // BEFORE trusting anything `readPlan` reports: `readPlan`'s already-landed containment check reads local
  // `origin/main` with no fetch/staleness guard of its own (see the import above), and this watch never runs
  // through `reconcile-fix-dispatch.mjs`, so it must run the guard itself.
  assertMainNotStale(root, checkStaleness, { label: AGENT_NAME });
  const plan = readPlan({ repo });
  const planned = planAlreadyLandedCloses(plan);
  const applied = [];
  if (apply) {
    for (const p of planned) {
      const closed = closePr(p.prNumber, { repo });
      // Comment only once the close took: a failed close leaves the PR planned again next tick, and commenting
      // anyway would repeat the same note on every `--apply` run.
      const commented = closed ? postComment(p.prNumber, p.comment, { repo }) : false;
      let resolved = null;
      // Only a PR that ACTUALLY closed gets its card resolved (PR #2769 review): if `gh pr close` failed, the PR
      // is still open and still the work's only home — flipping its card now would strand it as "done".
      if (closed && p.itemNum) {
        try { resolved = resolveItem(cwd, p.itemNum, { sync: true, publish: true }); }
        catch (e) { resolved = { flipped: false, alreadyResolved: false, reason: String(e?.message || e).split('\n')[0] }; }
      }
      applied.push({ prNumber: p.prNumber, commented, closed, itemNum: p.itemNum, resolved });
    }
  }
  return { planned, applied };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────
import { resolve } from 'node:path';
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const flags = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const result = runAlreadyLandedWatch({
    repo: typeof flags.repo === 'string' ? flags.repo : null,
    apply: !!flags.apply,
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (!result.planned.length) {
    process.stdout.write('already-landed-watch ✓ nothing to close\n');
  } else {
    process.stdout.write(`already-landed-watch — ${result.planned.length} PR(s) already landed on main:\n`);
    for (const p of result.planned) {
      process.stdout.write(`  PR #${p.prNumber}${p.carrierPr ? ` ← carried by #${p.carrierPr}` : ' (carrier unattributed)'}` +
        `${p.itemNum ? `, would resolve #${p.itemNum}` : ''}\n`);
    }
    process.stdout.write(flags.apply ? '' : '\n  DRY RUN — nothing closed, commented, or resolved. Re-run with --apply.\n');
  }
}
