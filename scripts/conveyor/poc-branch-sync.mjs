#!/usr/bin/env node
/**
 * @file scripts/conveyor/poc-branch-sync.mjs
 * @description THE GENERALIZED POC-BRANCH ↔ TARGET SYNC (epic #3383) — keeps EVERY registered POC branch
 *   (`we:scripts/lib/poc-branches.json`) mechanically merged with its own graduation target (normally `main`),
 *   gated by the branch's own `autoSync` knob (`we:scripts/lib/poc-branches.mjs#resolveAutoSyncEnabled`),
 *   reusing `branch-sync.mjs`'s existing clean-merge-tree-probe / bounded-retry / durable-escalate discipline
 *   instead of a second implementation of it.
 *
 * WHY A NEW FILE AND NOT JUST RE-POINTING `branch-sync.mjs` ITSELF. `branch-sync.mjs` is built to merge ONE
 *   upstream INTO THIS CHECKOUT'S OWN CHECKED-OUT BRANCH — `runSyncOnce` calls a real `git merge`, which
 *   requires the target branch to be HEAD and mutates the working tree/index. That is exactly right for the
 *   one scratch checkout it was built for (`~/workspace/wev-scratch-dispatcher-4`, permanently on one branch),
 *   and it is exactly wrong for this item's actual ask: sync EVERY registered POC branch (today one,
 *   `lane/mechanical-dispatcher`; tomorrow N), from ONE process that has exactly ONE branch checked out at a
 *   time and must never `git checkout` a different one mid-tick (that would yank the working tree out from
 *   under whatever this checkout is really doing). So this module updates branch refs the way `poc-land.mjs`
 *   already does for a landing — bare git plumbing, no checkout, no working-tree mutation — while REUSING, not
 *   reimplementing, `branch-sync.mjs`'s conflict-probe-then-decide shape and its pure retry/escalate core:
 *   {@link conflictSignature}, {@link decideEscalation}, `backoffMs`/`retryDecision` (via `infra-blocked.mjs`,
 *   the same primitives `branch-sync.mjs` itself imports rather than re-deriving), `notifyDesktop` and
 *   `defaultAppendLog`. NONE of that decision logic is copied here; it is imported.
 *
 * THE MECHANISM, per registered + enabled branch, entirely with git plumbing (no `git checkout`, ever):
 *   1. `git fetch origin` both the branch and its target into their `refs/remotes/origin/*` tracking refs.
 *   2. If the target has nothing the branch lacks, clear any stale retry/alert state and stop — up to date.
 *   3. A WORKING-TREE-FREE conflict probe: `git merge-tree --write-tree <branchTip> <targetTip>` (the exact
 *      plumbing `branch-sync.mjs` and `branch-drift.mjs` already use for the same reason). A conflict here
 *      NEVER touches disk — there is no working tree to leave dirty in the first place.
 *   4. CLEAN ⇒ `git commit-tree <tree> -p <branchTip> -p <targetTip>` builds the merge commit object directly
 *      (no index, no checkout), then a PLAIN, NEVER-FORCED push
 *      (`git push origin <mergeSha>:refs/heads/<branch>`) publishes it. This is a genuine fast-forward from the
 *      remote's own point of view (the new tip's first parent IS the branch's current tip) — no `--force`,
 *      ever, matching `poc-land.mjs`'s own discipline exactly.
 *   5. CONFLICT ⇒ the SAME bounded-backoff-then-durably-escalate state machine `branch-sync.mjs#runSyncOnce`
 *      already implements, applied per branch (its own state/alert/log files under
 *      `<cwd>/.git/poc-branch-sync/<branch>/`) — never an unattended resolve.
 *
 * SERIALIZED AGAINST A REAL LANE LANDING, ON THE SAME LOCK. A `poc-land.mjs` landing and this mechanical sync
 *   both write to the SAME branch ref, so both go through `we:scripts/readiness/drain-lock.mjs#withPocLandLock`
 *   — the identical per-branch write lock `poc-land.mjs` already takes, keyed the same way (branch + repo
 *   slug). Two POC branches never block each other (independent lock keys); a real landing and this sync
 *   contending for the SAME branch serialize. UNLIKE `poc-land.mjs`'s own use of this lock (which is content to
 *   spin for the lock's full 20-minute lease TTL — a landing is a foreground, one-shot CLI call), this pass
 *   runs inside a background TICK LOOP and must return quickly either way: {@link DEFAULT_LOCK_WAIT_MS}
 *   overrides `waitMs` down to a few seconds, so a contended branch is simply SKIPPED this tick (never
 *   force-pushed around the lock) and picked back up on the next one — no different, in effect, than the
 *   bounded-retry path already takes for a real conflict.
 *
 * NO TEST GATE, DELIBERATELY, MATCHING `branch-sync.mjs`'s OWN DESIGN. Unlike `poc-land.mjs` (which gates a
 *   NEW landing on the item's own tests — the only thing standing between an agent's diff and `main`), this
 *   pass only ever merges the branch's OWN graduation target INTO it — content the branch is going to have to
 *   reconcile with eventually regardless, and the exact thing `branch-sync.mjs` already does with no test gate
 *   of its own. Running the full suite on every tick for every registered branch would be expensive and was
 *   never the ask; the conflict-free probe is the whole safety contract, exactly as documented in
 *   `branch-sync.mjs`'s own header and in this item's own brief ("clean-merge automatically, escalate/skip on
 *   real conflict, never auto-resolve").
 *
 * NAMED RESIDUAL, stated rather than hidden (mirrors `main-ref-sync.mjs`'s own "what this does NOT do"
 *   section): this keeps the REMOTE branch ref fresh. It does NOT also fast-forward a LOCAL checkout that
 *   happens to have the branch checked out (e.g. this very driver, parked on `lane/mechanical-dispatcher`) —
 *   that is `main-ref-sync.mjs`'s own narrow job for `main`, and doing the analogous thing for an arbitrary POC
 *   branch while it may be the checked-out HEAD of the very process running this pass is a genuinely
 *   different, riskier operation (a working-tree-touching fast-forward of the running checkout's own HEAD),
 *   deliberately left out of this item's scope. The driver's own checkout still needs a `git pull`/equivalent
 *   to see the freshly-synced remote content locally.
 *
 * PURE-CORE / IO-SHELL SPLIT, the house shape: {@link safeBranchDirName} and {@link mergeCommitMessage} are
 *   pure. Everything else is IO by necessity (git plumbing + the lock), unit-tested against a FAKE `git`
 *   effect (the state-machine shape) and, at the CLI layer, a REAL throwaway git fixture with two remotes
 *   whose commits collide once merged — the same two-track proof `branch-sync.test.mjs` already uses.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { backoffMs, retryDecision } from './infra-blocked.mjs';
import {
  gitRun, conflictSignature, decideEscalation, notifyDesktop, defaultAppendLog,
  DEFAULT_RENAG_MS, DEFAULT_BASE_MS, DEFAULT_FACTOR, DEFAULT_CAP_MS, DEFAULT_MAX_ATTEMPTS,
  runDriftSweepBestEffort,
} from './branch-sync.mjs';
import { readRegistry, findPocBranch, resolveAutoSyncEnabled, branchesForRepo } from '../lib/poc-branches.mjs';
import { withPocLandLock, localRepoSlug } from '../readiness/drain-lock.mjs';
import { isNonFastForwardRejection } from '../operations/poc-land.mjs';

// ── TUNING ───────────────────────────────────────────────────────────────────────────────────────────────────

/** How long ONE branch's sync attempt spins for the per-branch write lock before giving up THIS TICK — see the
 *  file header's "SERIALIZED AGAINST A REAL LANE LANDING" section for why this is seconds, not
 *  `POC_LAND_LEASE_MINUTES`: a mechanical tick-loop pass must return promptly, and a skipped tick is picked up
 *  again on the very next one. */
export const DEFAULT_LOCK_WAIT_MS = 5_000;
export const DEFAULT_LOCK_POLL_MS = 250;

// ── PURE CORE (no fs / git / clock / lock) ──────────────────────────────────────────────────────────────────

/** A branch name, made safe as a single path segment for this pass's own per-branch state/alert/log files.
 *  Mirrors `we:scripts/readiness/heavy-admission.mjs#lockIdSafe` (keeps the name legible for a human listing
 *  the directory, rather than hashing it away). PURE. */
export function safeBranchDirName(branch) {
  const s = String(branch ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return s || 'unknown';
}

/** The merge commit's message. PURE, so the CLI/tests can assert it without a real commit. */
export function mergeCommitMessage(branch, target) {
  return `Merge ${target} into ${branch} (#3383 mechanical POC-branch sync)`;
}

// ── IO SHELL (git / fs / lock / clock past this point) ─────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function saveJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}
function clearFile(path) {
  try { unlinkSync(path); } catch { /* already gone — fine */ }
}

function sidecarPaths(cwd, branch) {
  const dir = join(cwd, '.git', 'poc-branch-sync', safeBranchDirName(branch));
  return { state: join(dir, 'state.json'), alert: join(dir, 'alert.json'), log: join(dir, 'sync.log') };
}

/**
 * ONE branch's sync attempt, INSIDE that branch's write lock (see the file header). Every effect is injected
 * so the whole state machine is testable with a fake `git`/`withLock`/clock, mirroring
 * `branch-sync.mjs#runSyncOnce`'s own shape closely enough that a reader of one recognizes the other.
 * @param {object} o
 * @param {{branch:string, target:string}} o.entry - a normalized `poc-branches.mjs` registry entry.
 * @param {string} [o.cwd]
 * @param {(args:string[], cwd:string)=>{ok:boolean,stdout:string,stderr:string}} [o.git]
 * @param {number} [o.now]
 * @param {(e:{title:string,body:string})=>void} [o.notify]
 * @param {(logPath:string, line:string)=>void} [o.appendLog]
 * @param {number} [o.maxAttempts]
 * @param {{baseMs?:number, factor?:number, capMs?:number}} [o.backoff]
 * @param {number} [o.renagMs]
 * @param {(a:{cwd:string, branch?:string})=>void} [o.driftSweep]
 * @param {Function} [o.withLock] - `withPocLandLock`'s shape.
 * @param {string|null} [o.repoKey]
 * @param {number} [o.lockWaitMs]
 * @returns {{branch:string, status:string, [k:string]:*}}
 */
export function syncOnePocBranchOnce({
  entry,
  cwd = process.cwd(),
  git = gitRun,
  now = Date.now(),
  notify = notifyDesktop,
  appendLog = defaultAppendLog,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoff = {},
  renagMs = DEFAULT_RENAG_MS,
  driftSweep = runDriftSweepBestEffort,
  withLock = withPocLandLock,
  repoKey,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
} = {}) {
  const branch = String(entry?.branch ?? '').trim();
  const target = String(entry?.target ?? '').trim();
  if (!branch || !target) throw new TypeError('poc-branch-sync: syncOnePocBranchOnce needs entry.branch and entry.target');

  const paths = sidecarPaths(cwd, branch);
  const log = (line) => appendLog(paths.log, line);
  const backoffCfg = { baseMs: DEFAULT_BASE_MS, factor: DEFAULT_FACTOR, capMs: DEFAULT_CAP_MS, ...backoff };
  const key = repoKey === undefined ? localRepoSlug({ cwd }) : repoKey;

  const locked = withLock(() => {
    // 1. fetch both tips fresh — FORCE-prefixed destination refspecs (branch-sync.mjs's own reasoning: works
    //    regardless of this checkout's configured fetch refspec, and these tracking refs are scratch
    //    bookkeeping this pass owns alone).
    const fetched = git(['fetch', 'origin', '--quiet', `+${branch}:refs/remotes/origin/${branch}`, `+${target}:refs/remotes/origin/${target}`], cwd);
    if (!fetched.ok) {
      log(`${iso(now)} poc-branch-sync[${branch}]: fetch failed (offline or network issue) — skipping this tick: ${firstLine(fetched.stderr)}`);
      return { status: 'offline' };
    }

    const branchTipRun = git(['rev-parse', `refs/remotes/origin/${branch}`], cwd);
    const targetTipRun = git(['rev-parse', `refs/remotes/origin/${target}`], cwd);
    if (!branchTipRun.ok || !targetTipRun.ok) {
      log(`${iso(now)} poc-branch-sync[${branch}]: could not read tips (${firstLine(branchTipRun.stderr || targetTipRun.stderr)}) — skipping this tick`);
      return { status: 'error' };
    }
    const branchTip = branchTipRun.stdout.trim();
    const targetTip = targetTipRun.stdout.trim();

    // 2. is there anything to merge at all?
    const behindRun = git(['rev-list', '--count', `${branchTip}..${targetTip}`], cwd);
    const behind = behindRun.ok ? Number(behindRun.stdout.trim()) || 0 : 0;
    if (behind === 0) {
      if (existsSync(paths.state) || existsSync(paths.alert)) {
        clearFile(paths.state);
        clearFile(paths.alert);
        log(`${iso(now)} poc-branch-sync[${branch}]: up to date with ${target} — cleared prior conflict/escalation state`);
      }
      return { status: 'fresh', behind };
    }

    // 3. WORKING-TREE-FREE conflict probe — no checkout, so a conflict here never touches disk.
    const probe = git(['merge-tree', '--write-tree', branchTip, targetTip], cwd);
    if (probe.ok) {
      const tree = firstLine(probe.stdout).trim();
      // 4. CLEAN — build the merge commit object directly (no index) and push it as a plain, non-forced
      //    fast-forward (the new tip's first parent IS the branch's current remote tip).
      const commitRun = git(['commit-tree', tree, '-p', branchTip, '-p', targetTip, '-m', mergeCommitMessage(branch, target)], cwd);
      if (!commitRun.ok) {
        log(`${iso(now)} poc-branch-sync[${branch}]: commit-tree failed — skipping this tick: ${firstLine(commitRun.stderr)}`);
        return { status: 'error', behind };
      }
      const mergeSha = commitRun.stdout.trim();
      const pushed = git(['push', 'origin', `${mergeSha}:refs/heads/${branch}`], cwd);
      if (pushed.ok) {
        clearFile(paths.state);
        clearFile(paths.alert);
        log(`${iso(now)} poc-branch-sync[${branch}]: merged ${behind} commit(s) from ${target} cleanly → ${mergeSha.slice(0, 12)}`);
        return { status: 'synced', behind, sha: mergeSha };
      }
      if (isNonFastForwardRejection(pushed.stderr)) {
        // The branch tip moved between our fetch and our push — someone else (a real landing, or another sync
        // tick on a sibling process) won the race INSIDE our own lock window is not possible (the lock covers
        // exactly this section); this is the OUTSIDE-the-lock case: our own fetch was stale relative to a
        // write that landed and released the lock before we acquired it. Benign — retried next tick with a
        // fresh fetch, never forced.
        log(`${iso(now)} poc-branch-sync[${branch}]: push raced a concurrent update to ${branch} — will retry next tick`);
        return { status: 'race', behind };
      }
      log(`${iso(now)} poc-branch-sync[${branch}]: push failed — skipping this tick: ${firstLine(pushed.stderr)}`);
      return { status: 'error', behind };
    }

    // 5. CONFLICT — the SAME bounded-retry-then-escalate state machine branch-sync.mjs#runSyncOnce implements.
    const conflictText = probe.stdout || probe.stderr;
    const signature = conflictSignature(conflictText);
    let store = loadJson(paths.state);

    if (!store || typeof store !== 'object' || !Number.isFinite(Number(store.attempt))) {
      store = { attempt: 1, firstFailedAt: iso(now), lastAttemptAt: iso(now), nextRetryAt: iso(now + backoffMs(1, backoffCfg)), signature };
      saveJson(paths.state, store);
      log(`${iso(now)} poc-branch-sync[${branch}]: merge conflict detected, ${behind} commit(s) behind ${target} (attempt 1/${maxAttempts}) — next retry in ${Math.round(backoffMs(1, backoffCfg) / 1000)}s`);
      return { status: 'conflict', attempt: 1, behind };
    }

    const decision = retryDecision(store, { now, maxAttempts });

    if (decision.action === 'wait') {
      return { status: 'waiting', attempt: store.attempt, waitMs: decision.waitMs, behind };
    }

    if (decision.action === 'retry') {
      const attempt = store.attempt + 1;
      store = { ...store, attempt, lastAttemptAt: iso(now), nextRetryAt: iso(now + backoffMs(attempt, backoffCfg)), signature };
      saveJson(paths.state, store);
      log(`${iso(now)} poc-branch-sync[${branch}]: merge conflict persists, ${behind} commit(s) behind ${target} (attempt ${attempt}/${maxAttempts}) — retrying, next in ${Math.round(backoffMs(attempt, backoffCfg) / 1000)}s`);
      return { status: 'conflict', attempt, behind };
    }

    // decision.action === 'surface' — the attempt cap is hit. Stop growing the backoff; escalate (deduped).
    const lastAlert = loadJson(paths.alert);
    const escalation = decideEscalation({ signature, lastAlert, nowMs: now, renagMs });
    saveJson(paths.state, { ...store, lastAttemptAt: iso(now), signature });
    if (escalation.fire) {
      saveJson(paths.alert, escalation.record);
      notify({
        title: `POC branch ${branch} sync stuck`,
        body: `${branch}: ${behind} commit(s) behind ${target}, merge conflict unresolved after ${store.attempt} attempt(s)`,
      });
      log(
        `${iso(now)} poc-branch-sync[${branch}]: ⚠ ESCALATED — ${behind} commit(s) behind ${target}, merge conflict unresolved after `
          + `${store.attempt} attempt(s). Durable record: ${paths.alert}. A human/session should reconcile this branch by hand. `
          + `(still polling every tick — will auto-resync the moment ${target} no longer conflicts)`,
      );
      driftSweep({ cwd, branch });
    }
    return { status: 'escalated', attempt: store.attempt, alerted: escalation.fire, behind };
  }, { branch, repoKey: key, waitMs: lockWaitMs, pollMs: DEFAULT_LOCK_POLL_MS });

  if (locked.ran === false) {
    log(`${iso(now)} poc-branch-sync[${branch}]: another writer holds ${branch}'s lock (${locked.heldBy ?? 'unknown'}) — skipping this tick, will retry next tick`);
    return { branch, status: 'locked', heldBy: locked.heldBy ?? null };
  }
  return { branch, ...locked.result };
}

/**
 * THE WHOLE PASS: every registered branch whose {@link resolveAutoSyncEnabled} reads true, synced independently
 * and best-effort (one branch's failure never stops the rest — matches every other mechanical pass in
 * `we:skills-src/conveyor/runner.mjs`). Branches with the knob OFF are reported, not silently skipped, so a
 * `--json` caller can see the full registry's state at a glance.
 * @param {object} [o]
 * @param {string} [o.cwd]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {{branches: object[]}|null} [o.registry] - an already-read registry (injected in tests); defaults to
 *   {@link readRegistry}'s own on-disk read.
 * @param {number} [o.now]
 * @param {Function} [o.sync] - {@link syncOnePocBranchOnce}'s shape, injected for tests.
 * @returns {Array<{branch:string, status:string, [k:string]:*}>}
 */
export function runPocBranchSync({ cwd = process.cwd(), env = process.env, registry = null, now = Date.now(), sync = syncOnePocBranchOnce } = {}) {
  const reg = registry ?? readRegistry();
  const results = [];
  // Only Web Everything's own branches: this pass runs in a WE checkout and merges WE's `main` (a sibling
  // repo's registered POC branch — `repo` field — is landed by `poc-land` from its own lane, never synced here).
  for (const entry of branchesForRepo(reg)) {
    if (!resolveAutoSyncEnabled(entry, env)) {
      results.push({ branch: entry.branch, status: 'disabled' });
      continue;
    }
    try {
      results.push(sync({ entry, cwd, now }));
    } catch (e) {
      results.push({ branch: entry.branch, status: 'error', error: String((e && e.message) || e).split('\n')[0] });
    }
  }
  return results;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const flags = parseFlags(argv);
  const cwd = typeof flags['repo-dir'] === 'string' && flags['repo-dir'] ? flags['repo-dir'] : process.cwd();
  let registry = readRegistry();
  if (typeof flags.branch === 'string' && flags.branch) {
    const entry = findPocBranch(registry, flags.branch);
    registry = { branches: entry ? [entry] : [] };
  }

  const runOnce = () => runPocBranchSync({ cwd, registry });

  if (flags.loop) {
    const intervalMs = Number(flags['interval-ms']) > 0 ? Number(flags['interval-ms']) : 180_000;
    let stop = false;
    const onSignal = () => { stop = true; };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.stderr.write(`poc-branch-sync: loop starting (every ${Math.round(intervalMs / 1000)}s) in ${cwd}\n`);
    while (!stop) {
      try { runOnce(); } catch (e) { process.stderr.write(`poc-branch-sync: tick error — ${String((e && e.stack) || e)}\n`); }
      if (stop) break;
      await sleep(intervalMs);
    }
    process.stderr.write('poc-branch-sync: loop stopped\n');
    return;
  }

  const results = runOnce();
  if (flags.json) process.stdout.write(`${JSON.stringify(results)}\n`);
  else for (const r of results) process.stderr.write(`poc-branch-sync[${r.branch}]: ${r.status}${r.behind != null ? ` (${r.behind} behind)` : ''}\n`);
  // Never a non-zero exit for a sync failure — this is a best-effort mechanical pass, exactly like every
  // sibling pass `runQuiet` invokes from the tick loop; a bad tick here must never fail the whole tick.
  process.exitCode = 0;
}

const IS_CLI = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (IS_CLI) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`poc-branch-sync: ${String((e && e.stack) || e)}\n`);
    process.exitCode = 0; // best-effort — see above
  });
}
