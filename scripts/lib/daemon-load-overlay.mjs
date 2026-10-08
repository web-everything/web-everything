#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-load-overlay.mjs
 * @description #4044 Module E — the operator's own manual "load this early" CLI for a daemon clone. `--ref` now
 *   REGISTERS the ref as a standing overlay (`we:scripts/lib/daemon-overlays.mjs#addOverlay`, Module B) and
 *   then runs a gated rebuild (`we:scripts/lib/daemon-rebuild.mjs#rebuildClone`, Module C) — the EXACT SAME
 *   rebuild-fresh-from-`origin/main`-plus-overlays → live-smoke → adopt/rollback path a daemon's own
 *   `we:scripts/lib/daemon-self-sync.mjs#withSelfSync` runs every tick, so a hand-triggered early load can
 *   never bypass the gate the daemon's own self-sync is held to, and (unlike the old one-shot merge) the ref
 *   STAYS registered — every later tick keeps rebuilding it in, auto-dropped only once `main`/its PR state make
 *   it moot (Module B/C's own clause-5 auto-drop rules), never silently forgotten after this one CLI run exits.
 *
 * HISTORY (#3383, PR #2601 follow-up, 2026-09-24): the FIRST cut called
 * `we:scripts/lib/daemon-self-sync.mjs#selfSyncCheckout` directly with `--ref` spliced in as its own `base` —
 * conflating the HOME branch (`main`) with the ref being merged IN, which made it refuse `not-on-main` before
 * ever fetching anything. That standalone merge path ({@link mergeOverlayRef}/{@link dryRunOverlay} below) is
 * KEPT, exported, for whatever still imports it directly — but `runDaemonLoadOverlay` no longer calls it: a
 * one-shot merge-then-gate never left a durable record of what was loaded, so the very next automatic rebuild
 * (which rebuilds fresh from `origin/main` + the REGISTERED overlay list, nothing else) would silently drop it
 * again. Registering it as a real overlay is the only way a manual early load survives past this one CLI run.
 *
 * USAGE:
 *   node scripts/lib/daemon-load-overlay.mjs --clone=<path to a daemon's dedicated clone> --ref=<branch to overlay> [--pr=N] [--base=<home branch, default main>] [--dry-run] [--wait [--wait-ms=N]] [--json]
 *   (versioned clones, card 89 S5: queues a request file for the in-tick updater; --wait blocks on its result)
 *
 * WHAT IT DOES (real run): `addOverlay(root, {ref, pr, addedBy, reason})` (Module B — validates `ref` with
 * `isSafeBranchName`, updates an existing entry in place rather than duplicating it), THEN `rebuildClone(...)`
 * (Module C) under the clone's own write lock — same object-DB rebuild, same live-smoke gate, same
 * adopt/rollback/quarantine handling every automatic tick gets. `mainOnly` is always `false` here: a manual
 * overlay load is never the main-only case (`we:skills-src/conveyor/pass-daemon.mjs`'s `drain`/
 * `merge-orphan-sweep` passes) that refuses overlays altogether.
 * `--dry-run` is STRICTLY read-only: the ref is NEVER written to the overlay list (no `addOverlay` call at
 * all) — instead {@link dryRunRebuild} (Module C) previews the plan with the ref appended AFTER the stored
 * list, VIRTUALLY, via its own `extraOverlays` option, so "what would registering this ref do" can be checked
 * before committing to it.
 * This is a ONE-SHOT CLI, not a daemon — there is no process to restart. It leaves the clone's checkout in the
 * adopted or rolled-back state and reports which, exiting non-zero only when a rebuild moved nothing because
 * it was refused/rejected (so a caller scripting this can tell "nothing to do" apart from "rejected").
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHeadSha, isSafeBranchName } from './daemon-self-sync.mjs';
import { gitRun } from './main-staleness.mjs';
import { repairCloneRefs } from './lane-repair.mjs';
import { addOverlay } from './daemon-overlays.mjs';
import { rebuildClone, dryRunRebuild } from './daemon-rebuild.mjs';
import { resolveVersionedContext, submitRequest, waitForResult } from './daemon-version-runtime.mjs';

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
  repairCloneRefs(root, { log: (m) => console.error(m) }); // heal dangling remote-tracking refs before any fetch
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
 * REGISTER `--ref` as a standing overlay (Module B) and run a gated rebuild (Module C) — the real-run path.
 * `--dry-run` never calls `addOverlay` at all; it previews the plan with `ref` appended VIRTUALLY via
 * {@link dryRunRebuild}'s own `extraOverlays` option, so nothing is ever written to the overlay list on a
 * preview.
 * @param {{clone:string, ref:string, pr?:number|null, base?:string, dryRun?:boolean, env?:NodeJS.ProcessEnv,
 *   log?:Console, addedBy?:string|null, reason?:string|null, now?:string,
 *   addOverlayFn?:typeof addOverlay, rebuild?:typeof rebuildClone, dryRunRebuildFn?:typeof dryRunRebuild}} o
 * @returns {Promise<object>}
 */
export async function runDaemonLoadOverlay({
  clone, ref, pr = null, base = 'main', dryRun = false, env = process.env, log = console,
  addedBy, reason = null, now,
  addOverlayFn = addOverlay, rebuild = rebuildClone, dryRunRebuildFn = dryRunRebuild,
  wait = false, waitMs, versions, submit = submitRequest, waitFor = waitForResult,
}) {
  if (!clone || typeof clone !== 'string') throw new TypeError('daemon-load-overlay: --clone=<path> is required');
  if (!ref || typeof ref !== 'string') throw new TypeError('daemon-load-overlay: --ref=<branch to overlay> is required');
  const root = resolve(clone);
  const by = addedBy ?? (typeof env?.USER === 'string' && env.USER ? env.USER : null);

  if (dryRun) {
    const preview = await dryRunRebuildFn({ root, env, extraOverlays: [{ ref, pr }] });
    return { root, ref, homeBranch: base, dryRun: true, ...preview };
  }

  addOverlayFn(root, {
    ref, pr, addedBy: by, reason, now,
  }, { env });
  // Card 89 S5: a versioned clone has no lock to take and is never rebuilt from this CLI. The request file is
  // the daemon's in-tick updater's input; `--wait` blocks on its result file instead of on a clone lock.
  const vctx = versions === undefined ? resolveVersionedContext({ root, env }) : versions;
  if (vctx) {
    const requestId = submit(vctx, { ref, pr, by });
    if (!wait) return { root, ref, homeBranch: base, registered: true, versioned: true, requestId, pending: true };
    const result = await waitFor(vctx, requestId, waitMs != null ? { timeoutMs: waitMs } : {});
    return {
      root, ref, homeBranch: base, registered: true, versioned: true, requestId, request: result,
      mergedAnything: !!result.moved, adopted: !!result.adopted, reason: result.reason ?? result.status, head: result.head,
      timedOut: result.status === 'timeout',
    };
  }
  const rebuildResult = await rebuild({
    root, env, log, mainOnly: false,
  });
  return {
    root, ref, homeBranch: base, registered: true, mergedAnything: !!rebuildResult.moved,
    adopted: !!rebuildResult.adopted, reason: rebuildResult.reason, alerts: rebuildResult.alerts, head: rebuildResult.head,
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
  const pr = flags.pr !== undefined ? Number(flags.pr) : null;
  const reason = typeof flags.reason === 'string' ? flags.reason : null;
  const addedBy = typeof flags.by === 'string' ? flags.by : (process.env.USER || null);
  const dryRun = !!flags['dry-run'];
  const wait = !!flags.wait;
  const waitMs = flags['wait-ms'] !== undefined && Number(flags['wait-ms']) > 0 ? Number(flags['wait-ms']) : undefined;
  runDaemonLoadOverlay({
    clone, ref, pr, base, dryRun, addedBy, reason, wait, waitMs,
  })
    .then((result) => {
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (result.dryRun) {
        process.stdout.write(
          `daemon-load-overlay --dry-run: ${result.root} onMain=${result.onMain} safe=${result.unsafe?.safe} `
          + `wouldDo=${result.wouldDo} finalSha=${result.plan?.finalSha ?? 'n/a'}\n`,
        );
      } else if (result.versioned) {
        process.stdout.write(result.pending
          ? `daemon-load-overlay: registered ${ref} — versioned clone, request ${result.requestId} queued for the in-tick updater (use --wait to block on its result) (${result.root})\n`
          : `daemon-load-overlay: registered ${ref} — versioned request ${result.requestId} ${result.timedOut ? 'TIMED OUT' : `answered: ${result.reason}`} (${result.root})\n`);
      } else if (!result.mergedAnything) {
        process.stdout.write(`daemon-load-overlay: registered ${ref} — nothing adopted this pass (${result.reason}) (${result.root})\n`);
      } else if (result.adopted) {
        process.stdout.write(`daemon-load-overlay: registered ${ref} and ADOPTED onto ${result.head} at ${result.root} (${result.reason})\n`);
      } else {
        process.stdout.write(`daemon-load-overlay: registered ${ref} but the rebuild was REJECTED (${result.reason}) at ${result.root}\n`);
      }
      for (const a of result.alerts || []) process.stdout.write(`  ! ${a.kind}\n`);
      process.exitCode = (result.mergedAnything && !result.adopted) || result.timedOut ? 1 : 0;
    })
    .catch((e) => {
      process.stderr.write(`daemon-load-overlay: fatal: ${String((e && e.message) || e)}\n`);
      process.exitCode = 1;
    });
}
