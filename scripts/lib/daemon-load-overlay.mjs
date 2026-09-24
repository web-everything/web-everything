#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-load-overlay.mjs
 * @description #3383 — the operator's own manual "load this early" CLI for a daemon clone, routed through the
 *   EXACT SAME merge → live-smoke → adopt/rollback code path `we:scripts/lib/daemon-self-sync.mjs#withSelfSync`
 *   runs on every automatic tick ({@link mergeOverlayRef} for the merge, `we:scripts/lib/daemon-live-smoke.mjs
 *   #gateMergedCommit` for the gate) — so a hand-triggered early load can never bypass the gate the daemon's
 *   own self-sync is held to. Operator: "Also give ME a CLI for my manual early loads."
 *
 * BUG FOUND IN LIVE USE (2026-09-24, follow-up on #3383/PR #2601): the first cut reused
 * `daemon-self-sync.mjs#selfSyncCheckout` verbatim, which conflates TWO things that must stay separate for an
 * OVERLAY (as opposed to a same-branch self-sync): the HOME branch the clone must already be on (`main`, so
 * `decideSelfSync`'s dirty/clean checks mean what they say) and the REF being merged IN (an arbitrary lane
 * branch, e.g. `lane/xkse05k-...`, almost never `main` itself). Passing `--ref` straight through as
 * `selfSyncCheckout`'s own `base` made it check "is HEAD on `lane/xkse05k-...`?" — false, since the clone is
 * correctly on `main` — and refuse with `not-on-main` BEFORE ever fetching or merging anything. The operator
 * then loaded the overlay by hand, hit a real merge conflict, and their own manual rollback didn't fire — the
 * clone sat mid-merge for ~1 minute. {@link mergeOverlayRef} below fixes this: `homeBranch` (must already be
 * checked out, default `main`) and `ref` (what gets fetched from `origin` and merged in) are two separate
 * parameters, never the same slot.
 *
 * USAGE:
 *   node scripts/lib/daemon-load-overlay.mjs --clone=<path to a daemon's dedicated clone> --ref=<branch to overlay> [--base=<home branch, default main>] [--dry-run] [--json]
 *
 * WHAT IT DOES: verifies `--clone` is on `--base` (default `main`) and clean, fetches `origin/<--ref>`, and
 * merges it in — same merge-commit-never-rebase contract as `daemon-self-sync.mjs#selfSyncCheckout`, and the
 * SAME fail-closed reads (an unreadable HEAD/status/count is never coerced into a green light). A CONFLICT is
 * ALWAYS `git merge --abort`ed before this function returns — the tree is never left mid-merge, whatever calls
 * it. Then {@link gateMergedCommit} runs on a successful merge:
 *   - nothing to merge (already up to date / dirty / not on `--base` / a fetch or merge failure) → reported,
 *     nothing else happens (a conflict is reported AS `conflict`, already aborted — see above);
 *   - merged + smoke PASS → adopted, left merged;
 *   - merged + smoke FAIL → `git reset --hard` back to the pre-merge HEAD, and the merged sha is recorded so a
 *     re-run against the SAME broken sha short-circuits instead of re-running the live smoke (same reject-cache
 *     `daemon-self-sync.mjs`'s own gate uses — this CLI does not keep a second one).
 * `--dry-run` (real, read-only): fetches `origin/<--ref>` and reports whether a merge WOULD happen and what
 * it would bring in — no `git merge` is ever run, so the clone's tree is untouched either way.
 * This is a ONE-SHOT CLI, not a daemon — there is no process to restart. It leaves the clone's checkout in the
 * adopted or rolled-back state and reports which, exiting non-zero only when a merge was attempted and
 * rejected (so a caller scripting this can tell "nothing to do" apart from "rejected").
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHeadSha, readOriginRefSha, isSafeBranchName } from './daemon-self-sync.mjs';
import { gateMergedCommit } from './daemon-live-smoke.mjs';
import { gitRun } from './main-staleness.mjs';

/** Throw unless `ref` passes {@link isSafeBranchName} — same argv-injection defense
 *  `daemon-self-sync.mjs#assertSafeBranchName` applies to a POC branch; `--ref` is operator input here, but
 *  never trust operator input over a git argv either (defense in depth, not paranoia-for-its-own-sake). */
function assertSafeRef(ref, source) {
  if (!isSafeBranchName(ref)) {
    throw new TypeError(`daemon-load-overlay: ${source} ${JSON.stringify(ref)} is not a safe branch name — refusing to pass it to git`);
  }
  return ref;
}

/**
 * The IO: verify the clone is on `homeBranch` and clean, fetch `origin/<ref>`, and merge it in. Never leaves
 * the tree mid-merge — a conflicting merge is ALWAYS aborted before this returns. Mirrors
 * `daemon-self-sync.mjs#selfSyncCheckout`'s fail-closed shape (an unreadable HEAD/status/count is `*-failed`,
 * never coerced into "clean"/"up to date"/"on branch"), but with `homeBranch` (what the clone must already be
 * ON) and `ref` (what gets fetched and merged IN) as two independent parameters — see the file header for why
 * conflating them was the live bug this fixes.
 * @param {{root:string, ref:string, homeBranch?:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {{merged:boolean, commits:number, reason:string}}
 */
export function mergeOverlayRef({ root, ref, homeBranch = 'main', run = gitRun, timeoutMs = 60_000 }) {
  assertSafeRef(ref, '--ref');
  assertSafeRef(homeBranch, '--base');
  const git = (args) => run(args, { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });

  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const onHome = head.status === 0 ? String(head.stdout ?? '').trim() === homeBranch : null;
  if (onHome === null) return { merged: false, commits: 0, reason: 'head-failed' };
  if (!onHome) return { merged: false, commits: 0, reason: 'not-on-base' };

  const status = git(['status', '--porcelain']);
  const dirty = status.status === 0 ? !!String(status.stdout ?? '').trim() : null;
  if (dirty === null) return { merged: false, commits: 0, reason: 'status-failed' };
  if (dirty) return { merged: false, commits: 0, reason: 'dirty' };

  // `--` ends option parsing (same defense-in-depth as daemon-self-sync.mjs's POC fetch): even a `ref` that
  // slipped past assertSafeRef somehow is never read as a git OPTION.
  const fetched = git(['fetch', '--quiet', '--', 'origin', ref]).status === 0;
  if (!fetched) return { merged: false, commits: 0, reason: 'fetch-failed' };

  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    const out = String(r.stdout ?? '').trim();
    return r.status === 0 && /^\d+$/.test(out) ? Number(out) : null;
  };
  const behind = count(`HEAD..origin/${ref}`);
  if (behind === null) return { merged: false, commits: 0, reason: 'count-failed' };
  if (!behind) return { merged: false, commits: 0, reason: 'up-to-date' };

  const merge = git(['merge', `origin/${ref}`, '--no-edit', '-m', `overlay: merge origin/${ref} (daemon-load-overlay)`]);
  if (merge.status !== 0) {
    // NEVER leave the tree mid-merge — this is the exact failure mode the live incident hit by hand.
    git(['merge', '--abort']);
    return { merged: false, commits: 0, reason: 'conflict' };
  }
  return { merged: true, commits: behind, reason: 'merged' };
}

/**
 * Real, read-only preview: fetches `origin/<ref>` and reports what a real run would do — no `git merge` ever
 * runs, so the clone's tree is untouched regardless of what this reports.
 * @param {{root:string, ref:string, homeBranch?:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {{onHome:boolean|null, dirty:boolean|null, fetched:boolean, behind:number|null, headSha:string|null, wouldMerge:boolean}}
 */
export function dryRunOverlay({ root, ref, homeBranch = 'main', run = gitRun, timeoutMs = 60_000 }) {
  assertSafeRef(ref, '--ref');
  assertSafeRef(homeBranch, '--base');
  const git = (args) => run(args, { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });

  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const onHome = head.status === 0 ? String(head.stdout ?? '').trim() === homeBranch : null;
  const status = git(['status', '--porcelain']);
  const dirty = status.status === 0 ? !!String(status.stdout ?? '').trim() : null;
  const fetched = git(['fetch', '--quiet', '--', 'origin', ref]).status === 0;
  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    const out = String(r.stdout ?? '').trim();
    return r.status === 0 && /^\d+$/.test(out) ? Number(out) : null;
  };
  const behind = fetched ? count(`HEAD..origin/${ref}`) : null;
  const headSha = readHeadSha({ root, run, timeoutMs });
  return {
    onHome, dirty, fetched, behind, headSha,
    wouldMerge: onHome === true && dirty === false && fetched && Number.isFinite(behind) && behind > 0,
  };
}

/**
 * @param {{clone:string, ref:string, base?:string, dryRun?:boolean, env?:NodeJS.ProcessEnv, log?:Console,
 *   merge?:typeof mergeOverlayRef, gate?:typeof gateMergedCommit, run?:typeof gitRun, readHead?:typeof readHeadSha}} o
 * @returns {Promise<object>}
 */
export async function runDaemonLoadOverlay({
  clone, ref, base = 'main', dryRun = false, env = process.env, log = console,
  merge = mergeOverlayRef, gate = gateMergedCommit, run = gitRun, readHead = readHeadSha,
}) {
  if (!clone || typeof clone !== 'string') throw new TypeError('daemon-load-overlay: --clone=<path> is required');
  if (!ref || typeof ref !== 'string') throw new TypeError('daemon-load-overlay: --ref=<branch to overlay> is required');
  const root = resolve(clone);

  if (dryRun) {
    const preview = dryRunOverlay({ root, ref, homeBranch: base, run });
    return { root, ref, homeBranch: base, dryRun: true, ...preview };
  }

  const preMergeSha = readHead({ root, run });
  const r = merge({ root, ref, homeBranch: base, run });
  if (!r.merged) {
    return { root, ref, homeBranch: base, mergedAnything: false, adopted: false, commits: 0, reason: r.reason };
  }
  const mergedIdentitySha = readOriginRefSha({ root, ref: `origin/${ref}`, run });
  const verdict = await gate({ root, preMergeSha, mergedIdentitySha, env, run, log });
  return {
    root, ref, homeBranch: base, mergedAnything: true, adopted: verdict.adopt, commits: r.commits,
    reason: verdict.reason, smoke: verdict.smoke,
  };
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const flags = parseFlags(process.argv.slice(2));
  const clone = typeof flags.clone === 'string' ? flags.clone : null;
  const ref = typeof flags.ref === 'string' ? flags.ref : null;
  const base = typeof flags.base === 'string' ? flags.base : 'main';
  const dryRun = !!flags['dry-run'];
  runDaemonLoadOverlay({ clone, ref, base, dryRun })
    .then((result) => {
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (result.dryRun) {
        process.stdout.write(
          `daemon-load-overlay --dry-run: ${result.root} onHome(${base})=${result.onHome} dirty=${result.dirty} `
          + `fetched=${result.fetched} behind=${result.behind} headSha=${result.headSha} wouldMerge=${result.wouldMerge}\n`,
        );
      } else if (!result.mergedAnything) {
        process.stdout.write(`daemon-load-overlay: nothing adopted — ${result.reason} (${result.root})\n`);
      } else if (result.adopted) {
        process.stdout.write(`daemon-load-overlay: ADOPTED ${result.commits} commit(s) from origin/${ref} onto ${result.root} (${result.reason})\n`);
      } else {
        process.stdout.write(`daemon-load-overlay: REJECTED (${result.reason}) — rolled back ${result.root} to its pre-merge commit\n`);
        if (result.smoke) {
          for (const check of result.smoke.results) process.stdout.write(`  ${check.ok ? '✓' : '✗'} ${check.name} (${check.ms}ms): ${check.detail}\n`);
        }
      }
      process.exitCode = result.mergedAnything && !result.adopted ? 1 : 0;
    })
    .catch((e) => {
      process.stderr.write(`daemon-load-overlay: fatal: ${String((e && e.message) || e)}\n`);
      process.exitCode = 1;
    });
}
