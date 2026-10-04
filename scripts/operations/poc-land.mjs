#!/usr/bin/env node
/**
 * @file scripts/operations/poc-land.mjs
 * @description THE POC FAST-LANDER (#3637, transport **A′**) — land a lane's commits onto a registered POC
 *   branch with NO review tax: lock-serialized, fast-forward-only, rebase-and-retry on a moved tip, bounded,
 *   and gated by the item's own tests alone.
 *
 * WHAT THE RULING SETTLED, so this file does not re-derive it. `#3637`'s operator ruling: "I do want N POC as
 * new feature. then goal is to be able to delivery quickly into a POC, so we must not be slow by the same slow
 * PR process, otherwise there is not benefit. real review will happen when the POC graduate." Three
 * consequences this file implements literally:
 *
 *   1. **No PR, no judge panel, no `converge` pass, no escalation label.** A landing INTO a POC branch pays no
 *      per-landing review of ANY shape — including an automated one, which is still real wall-clock time on
 *      every landing and is exactly the latency the ruling exists to remove. The ONLY gate is the item's own
 *      tests/build (`we:scripts/verify-lane.mjs`, reached through `we:scripts/operations/verify-io.mjs`'s
 *      runner — never a second implementation of it, see that file's own header for why).
 *   2. **Real review happens ONCE, at graduation.** Moving a POC branch to `main` goes through the FULL
 *      existing process, undiluted. Nothing here touches graduation.
 *   3. **Only a DECLARED branch is landable.** Doctrine rule 10(c) as amended. The target must resolve in
 *      `we:scripts/lib/poc-branches.json`; an unregistered branch is a refusal, not a surprise at push time.
 *
 * WHY A′ AND NOT "AGENTS JUST PUSH" (option A, rejected — twice). The original rejection of direct pushes was
 * right about the PROBLEMS and wrong about their KIND: concurrent writers racing one ref, and colliding with
 * the live `we:scripts/conveyor/branch-sync.mjs` loop, are ENGINEERING problems with known solutions, not
 * review-process problems. A′ solves them:
 *
 *   · **Concurrency.** Only this lander writes, and only inside the PER-BRANCH lock
 *     (`we:scripts/readiness/drain-lock.mjs`'s `withPocLandLock` — the existing `O_EXCL`+TTL lease primitive,
 *     never a new one). Two landers targeting the SAME branch serialize; two targeting DIFFERENT branches
 *     never block each other.
 *   · **The loser of a race does not fail.** It rebases onto the fresh tip, RE-RUNS the tests, and retries —
 *     bounded at {@link MAX_LAND_ATTEMPTS}, then stops and surfaces rather than resolving a conflict
 *     unattended or reaching for `--force`.
 *
 * THE WHOLE ATTEMPT LOOP RUNS INSIDE THE LOCK, not just the push. The card's requirement is that the PUSH be
 * serialized; holding the lock across fetch→rebase→verify→push is strictly stronger and materially simpler to
 * reason about: inside the lock nothing else can move the tip, so a rebase can never be invalidated between
 * the verify that blessed it and the push that publishes it. The cost is that a slow verify holds the branch —
 * paid for by running the FIRST verify OUTSIDE the lock (the common case is a clean fast-forward, where the
 * in-lock work is one fetch and one push).
 *
 * NO NEW RESIDENT DAEMON, DELIBERATELY. This lander is a SHORT-LIVED step at the end of a dispatch, not a
 * standing process. `#3467` records that `we:skills-src/conveyor/runner-lock.mjs`'s holder registers no
 * `SIGTERM`/`SIGINT` handler, so its lease survives a `kill` until the TTL and operators have been deleting
 * lock directories by hand. A resident lander would inherit that defect; a short-lived one cannot.
 *
 * SHAPE — a PLAIN MODULE with injected IO plus a CLI block, the shape
 * `we:scripts/operations/dispatch-abort.mjs` and `we:scripts/operations/review-dispatch.mjs` already use, NOT
 * the declarative `op()` engine. Same reasoning `review-dispatch.mjs` applied to itself: this is one
 * imperative git sequence with a retry loop, not a read→plan→write transaction with a resumable suspend.
 * Everything above the "IO SHELL" banner is pure and unit-tested in `__tests__/poc-land.test.mjs`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitRun } from '../lib/git-run.mjs';
import { readRegistry, findPocBranch, normalizeBranchRef, branchesForRepo, DEFAULT_POC_REPO } from '../lib/poc-branches.mjs';
import { withPocLandLock, localRepoSlug } from '../readiness/drain-lock.mjs';
import { createChecksRunner } from './verify-io.mjs';
import { LEASE_FILENAME, renewedLease } from '../lib/lane-lease.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';

/** The bound the ruling names: three attempts, then STOP and surface. Not a forever loop, and never a
 *  `--force` — a pathological conflict is an operator's call, not a lander's. */
export const MAX_LAND_ATTEMPTS = 3;

/** The statuses {@link landOnPocBranch} can report. `landed`/`noop` are the only successes. */
export const LAND_STATUSES = Object.freeze([
  'landed', // the branch now contains the lane's commits
  'noop', // HEAD was already the branch tip — nothing to land
  'not-registered', // the target is not in the POC-branch registry (doctrine rule 10(c))
  'verify-failed', // the item's own tests/build did not pass — the ONLY gate, and it said no
  'conflict', // a rebase onto the fresh tip conflicted; stopped rather than resolving it unattended
  'exhausted', // MAX_LAND_ATTEMPTS rounds of "the tip moved again" — stopped rather than looping
  'locked', // another lander holds this branch's write lock past the wait budget
  'error', // git itself failed (offline, no such remote, …)
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE CORE — no git, no fs, no clock
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Decide what ONE attempt should do, given the three shas an attempt has just read. PURE — this is the whole
 * fast-forward-vs-rebase decision, separated so every branch is testable with three strings.
 *
 *   · `headSha === tipSha`            → `noop`          nothing to land (a re-run, or someone landed it already)
 *   · `mergeBase === tipSha`          → `fast-forward`  the tip has NOT moved since the lane forked: the lane's
 *                                                       commits sit directly on top of it, so the push is a
 *                                                       genuine fast-forward with no merge commit.
 *   · otherwise                       → `rebase`        the tip moved; replay the lane's commits onto it and
 *                                                       re-verify before trying again.
 *
 * `mergeBase` is `git merge-base HEAD origin/<branch>`, i.e. where the lane actually diverged — NOT the base
 * recorded at acquire time. Reading it fresh is what makes this correct after a rebase the loop itself did.
 *
 * @param {{headSha: string, tipSha: string, mergeBase: string}} o
 * @returns {{action: 'noop'|'fast-forward'|'rebase', reason: string}}
 */
export function planLanding({ headSha, tipSha, mergeBase } = {}) {
  const head = String(headSha ?? '').trim();
  const tip = String(tipSha ?? '').trim();
  const base = String(mergeBase ?? '').trim();
  if (!head || !tip || !base) throw new TypeError('poc-land: planLanding needs headSha, tipSha and mergeBase');
  if (head === tip) return { action: 'noop', reason: 'HEAD is already the branch tip — nothing to land' };
  if (base === tip) return { action: 'fast-forward', reason: 'the branch tip has not moved since this lane forked — a clean fast-forward' };
  return { action: 'rebase', reason: 'the branch tip moved since this lane forked — replay onto it and re-verify' };
}

/**
 * The exact push refspec, as an argv. PURE and exported so a test can assert the command with no subprocess —
 * the same discipline `we:scripts/operations/verify-io.mjs#verifyArgv` applies to its own spawn.
 *
 * NO `--force`, NO `+` refspec prefix, EVER. The whole safety property of A′ is that a push which is not a
 * fast-forward is REJECTED by the remote; forcing it would silently discard whatever landed in between — the
 * failure mode the lock plus the bounded rebase-retry exist to make impossible. A rejected push is a
 * legitimate, expected outcome here (the tip moved between the fetch and the push), and the loop handles it.
 *
 * The destination is spelled `refs/heads/<branch>` in full so a remote that also carries a TAG of that name
 * can never be the thing this updates.
 * @param {string} branch
 * @returns {string[]}
 */
export function pushArgv(branch) {
  const name = normalizeBranchRef(branch);
  if (!name) throw new TypeError('poc-land: pushArgv needs a branch name');
  return ['push', 'origin', `HEAD:refs/heads/${name}`];
}

/**
 * The fetch refspec for reading the branch's CURRENT tip into a local tracking ref. PURE.
 *
 * FORCE-prefixed on the DESTINATION only (`+<branch>:refs/remotes/origin/<branch>`) — the same shape
 * `we:scripts/conveyor/branch-sync.mjs` and `we:scripts/conveyor/branch-drift.mjs` both already use, and for
 * the identical reason: it works regardless of the checkout's own configured fetch refspec (a lane clone's
 * `origin` may not track `lane/*` at all), and the local tracking ref is scratch bookkeeping this process
 * owns, never a branch anyone advances by hand. Forcing a REMOTE-TRACKING ref is not the same act as forcing a
 * push — see {@link pushArgv}, which must never force.
 * @param {string} branch
 * @returns {string[]}
 */
export function fetchArgv(branch) {
  const name = normalizeBranchRef(branch);
  if (!name) throw new TypeError('poc-land: fetchArgv needs a branch name');
  return ['fetch', 'origin', '--quiet', `+${name}:refs/remotes/origin/${name}`];
}

/**
 * Does a failed `git push` look like the remote REJECTED a non-fast-forward (the expected race), as opposed to
 * a real error (auth, network, no such remote)? PURE — matched against git's own wording, and deliberately
 * generous: misreading a network failure as a race costs one wasted retry, while misreading a race as a hard
 * error would abandon a landing that would have succeeded on the next pass.
 * @param {string} stderr
 * @returns {boolean}
 */
export function isNonFastForwardRejection(stderr) {
  const t = String(stderr ?? '');
  return /non-fast-forward|fetch first|rejected|behind its remote counterpart|stale info/i.test(t);
}

/**
 * Render one landing result as a single operator-facing line. PURE, so the CLI's output is unit-testable and
 * every status has exactly one phrasing.
 * @param {object} r - a {@link landOnPocBranch} result.
 * @returns {string}
 */
export function describeLanding(r) {
  const at = r?.attempts != null ? ` after ${r.attempts} attempt(s)` : '';
  switch (r?.status) {
    case 'landed': return `poc-land: landed ${String(r.sha ?? '').slice(0, 9)} on ${r.branch}${at}`;
    case 'noop': return `poc-land: nothing to land — HEAD is already the tip of ${r.branch}`;
    case 'not-registered': return `poc-land: ${r.error}`;
    case 'verify-failed': return `poc-land: REFUSED — the item's own tests/build did not pass${at}. That is the only gate a POC landing has, so nothing was pushed. ${r.error ?? ''}`.trim();
    case 'conflict': return `poc-land: STOPPED — rebasing onto the fresh tip of ${r.branch} conflicted${at}. Nothing was pushed and the rebase was aborted; resolve it by hand in this lane, then re-run. ${r.error ?? ''}`.trim();
    case 'exhausted': return `poc-land: STOPPED — the tip of ${r.branch} moved on every one of ${r.attempts} attempt(s). Nothing was pushed (a POC landing never forces). Re-run to try again.`;
    case 'locked': return `poc-land: another lander holds ${r.branch}'s write lock${r.heldBy ? ` (${r.heldBy})` : ''} and did not release it within the wait budget — nothing was pushed. Re-run once it finishes.`;
    default: {
      // An UNRECOGNISED status is named as such rather than rendered as if it were a known outcome — the
      // reader who sees a status this file never defined needs to know the vocabulary drifted, not to read a
      // confident sentence about it.
      const tag = LAND_STATUSES.includes(r?.status) ? '' : ' (unrecognised status)';
      return `poc-land: ${r?.status ?? 'error'}${tag} — ${r?.error ?? 'unknown failure'}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// IO SHELL — git, the test runner, the lock
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `git` bound to one checkout, returning `{ok, stdout, stderr}`. Thin over the repo's ONE git runner
 *  (`we:scripts/lib/git-run.mjs`), never a fourth same-named local variant — that duplication is what #2923
 *  cost this repo a silent data loss over. */
function gitIn(cwd, run) {
  return (args) => {
    const r = run('git', args, { cwd });
    return { ok: r.status === 0, stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').trim() };
  };
}

/**
 * The default lease renewal (#3383): rewrite this lane's `.lane-lease` with `renewedAt = now`
 * (`we:scripts/lib/lane-lease.mjs#renewedLease`), so a landing whose gate waits in the heavy-command queue for
 * hours is not reclaimed and reset under it. A checkout that is not a lane (no lease file) is left alone.
 * Best-effort: a renewal failure never fails the landing. Returns whether a lease was renewed. `fs` is injected
 * only so a test can kill the write midway.
 */
export function defaultRenewLease({ cwd, run = gitRun, now = () => new Date(), fs = { writeFileSync, renameSync, rmSync } } = {}) {
  try {
    const gd = run('git', ['rev-parse', '--absolute-git-dir'], { cwd });
    if (gd.status !== 0) return false;
    const file = join(String(gd.stdout).trim(), LEASE_FILENAME);
    if (!existsSync(file)) return false;
    const next = renewedLease(JSON.parse(readFileSync(file, 'utf8')), now().toISOString());
    if (!next) return false;
    // Atomic temp+rename, the same shape as `we:scripts/lane-pool.mjs#writeLeaseAtomic`: a plain overwrite killed
    // between its truncate and its write leaves a torn lease, which every reader treats as NO lease — making this
    // lane reclaimable mid-landing, the very incident this renewal exists to prevent.
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch { return false; }
}

/** The default gate: the item's own tests/build via the SINGLE home, reached through the runner
 *  `we:scripts/operations/verify.mjs` is itself injected with. Returns `{ok, detail}`. */
export function defaultVerify({ cwd, gate = '' } = {}) {
  const runChecks = createChecksRunner();
  const finding = runChecks({ cwd, mode: 'run', gate });
  const check = finding?.checks?.[0] ?? {};
  return { ok: check.outcome === 'pass', detail: check.outcome ? `verify-lane reported ${check.outcome}` : 'verify-lane produced no verdict' };
}

/**
 * LAND this lane's commits onto one registered POC branch.
 *
 * The sequence, and where the lock sits:
 *   0. resolve the target in the registry            (refuse an undeclared branch — rule 10(c))
 *   1. verify ONCE, OUTSIDE the lock                 (the only gate; the common case never rebases)
 *   2. take the branch's own write lock              (`withPocLandLock` — per branch, per repo)
 *   3. loop, bounded by `maxAttempts`:
 *        fetch the tip → plan → fast-forward push, or rebase + RE-verify and go round again
 *   4. release the lock (always — `withPocLandLock`'s `finally`)
 *
 * Every effect is injected (`run` for git, `verify` for the gate, `withLock` for the lock) so the whole thing
 * is testable with no network, no suites and no real lock directory.
 *
 * @param {object} o
 * @param {string} o.branch - the POC branch to land on (with or without `origin/`).
 * @param {string} [o.cwd] - the lane clone holding the commits. Defaults to the process cwd.
 * @param {number} [o.maxAttempts] - defaults to {@link MAX_LAND_ATTEMPTS}.
 * @param {string} [o.gate] - an explicit suite command forwarded to `verify-lane.mjs`.
 * @param {boolean} [o.skipVerify] - run NO gate at all. Exists for the one legitimate case (a caller that has
 *   just run `verify` itself and holds the green marker), and is loud in the result so it can never be
 *   mistaken for "it passed".
 * @param {object} [o.registry] - an already-read registry (injected in tests).
 * @param {Function} [o.run] - the git runner (`we:scripts/lib/git-run.mjs#gitRun` shape).
 * @param {Function} [o.verify] - `({cwd, gate}) => {ok, detail}`.
 * @param {Function} [o.withLock] - `withPocLandLock`'s shape.
 * @param {string|null} [o.repoKey] - the lock's repo key; read from the checkout's own origin by default.
 * @returns {{status: string, branch: string, attempts: number, sha?: string, error?: string, verified: boolean, rebased: boolean}}
 */
export function landOnPocBranch({
  branch,
  cwd = process.cwd(),
  maxAttempts = MAX_LAND_ATTEMPTS,
  gate = '',
  skipVerify = false,
  registry = null,
  run = gitRun,
  verify = defaultVerify,
  withLock = withPocLandLock,
  renewLease = defaultRenewLease,
  repoKey,
} = {}) {
  const name = normalizeBranchRef(branch);
  if (!name) throw new Error('poc-land: needs a --branch to land on');
  const attempts = Math.max(1, Number(maxAttempts) || MAX_LAND_ATTEMPTS);

  // 0. Rule 10(c) — only a DECLARED branch is landable. Fail closed: an unreadable registry means "no POC
  //    branch is declared" and every target is refused, rather than a push to an unvetted ref.
  // The lane's own repo picks which registry entries apply (`repo` field; no origin ⇒ Web Everything, the
  // pre-`repo` behaviour), so a sibling repo's registered POC branch is landable from that repo's lane only.
  const key = repoKey === undefined ? localRepoSlug({ cwd }) : repoKey;
  const reg = registry ?? readRegistry();
  const entry = findPocBranch(reg, name, key || DEFAULT_POC_REPO);
  if (!entry) {
    const known = branchesForRepo(reg, key || DEFAULT_POC_REPO).map((b) => b.branch);
    return {
      status: 'not-registered',
      branch: name,
      attempts: 0,
      verified: false,
      rebased: false,
      error: `"${name}" is not a registered POC branch (known: ${known.length ? known.join(', ') : 'none'}). `
        + `${key && key !== DEFAULT_POC_REPO ? `(repo ${key}) ` : ''}Doctrine rule 10(c): a POC branch must NAME what it is for and who graduates it — register it in `
        + 'we:scripts/lib/poc-branches.json before landing on it.',
    };
  }

  const git = gitIn(cwd, run);

  // 1. THE ONLY GATE, run once outside the lock. No judge panel, no converge pass, no escalation label — the
  //    ruling removed all of those for a landing INSIDE a POC branch. This is what is left.
  // The gate can wait hours in the heavy-command queue: renew the lane's lease before it and after it (#3383).
  if (!skipVerify) {
    renewLease({ cwd });
    const v = verify({ cwd, gate });
    renewLease({ cwd });
    if (!v?.ok) return { status: 'verify-failed', branch: name, attempts: 0, verified: false, rebased: false, error: v?.detail ?? 'verify reported no verdict' };
  }

  let rebased = false;

  const locked = withLock(() => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const fetched = git(fetchArgv(name));
      if (!fetched.ok) return { status: 'error', attempts: attempt, error: `fetching origin/${name} failed: ${fetched.stderr || fetched.stdout}` };

      const head = git(['rev-parse', 'HEAD']);
      const tip = git(['rev-parse', `refs/remotes/origin/${name}`]);
      if (!head.ok || !tip.ok) return { status: 'error', attempts: attempt, error: `could not read HEAD / origin/${name}: ${head.stderr || tip.stderr}` };

      const mb = git(['merge-base', 'HEAD', `refs/remotes/origin/${name}`]);
      if (!mb.ok) return { status: 'error', attempts: attempt, error: `could not compute the merge-base with origin/${name}: ${mb.stderr}` };

      const plan = planLanding({ headSha: head.stdout, tipSha: tip.stdout, mergeBase: mb.stdout });
      if (plan.action === 'noop') return { status: 'noop', attempts: attempt, sha: head.stdout };

      if (plan.action === 'fast-forward') {
        const pushed = git(pushArgv(name));
        if (pushed.ok) return { status: 'landed', attempts: attempt, sha: head.stdout };
        // The tip moved between this fetch and this push. That is the race the loop exists for — go round
        // again (which will rebase this time). Anything else is a real failure and stops now.
        if (!isNonFastForwardRejection(pushed.stderr)) return { status: 'error', attempts: attempt, error: `push to ${name} failed: ${pushed.stderr || pushed.stdout}` };
        continue;
      }

      // plan.action === 'rebase' — replay the lane's commits onto the fresh tip, then RE-RUN the gate. A
      // conflict STOPS: it is resolved by a human in this lane, never unattended by a lander.
      const rb = git(['rebase', `refs/remotes/origin/${name}`]);
      if (!rb.ok) {
        git(['rebase', '--abort']);
        return { status: 'conflict', attempts: attempt, error: (rb.stderr || rb.stdout || '').split('\n').slice(0, 3).join(' ') };
      }
      rebased = true;
      if (!skipVerify) {
        renewLease({ cwd });
        const v = verify({ cwd, gate });
        renewLease({ cwd });
        if (!v?.ok) return { status: 'verify-failed', attempts: attempt, error: `after rebasing onto the fresh tip of ${name}: ${v?.detail ?? 'verify reported no verdict'}` };
      }
      // Fall through to the next attempt, which fast-forwards from the tip we just rebased onto.
    }
    return { status: 'exhausted', attempts };
  }, { branch: name, repoKey: key });

  // The lock refused (a live holder past the wait budget). `withPocLandLock` deliberately does NOT degrade to
  // running unlocked — see its doc: an unserialized push to a shared ref is the exact failure this prevents.
  if (locked.ran === false) {
    return { status: 'locked', branch: name, attempts: 0, verified: !skipVerify, rebased: false, heldBy: locked.heldBy ?? null };
  }

  return { ...locked.result, branch: name, verified: !skipVerify, rebased };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `--name=value` / `--name` reader, the same shape `we:scripts/operations/wake.mjs#flagValue` uses. PURE. */
export function flagOf(argv, name) {
  const hit = (argv ?? []).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (n) => flagOf(argv, n);
  try {
    const branch = flag('branch');
    if (!branch) throw new Error('usage: poc-land.mjs --branch=<registered POC branch> [--cwd=<lane>] [--max-attempts=N] [--gate=<cmd>] [--skip-verify] [--json]');
    const result = landOnPocBranch({
      branch,
      cwd: flag('cwd') ? resolve(flag('cwd')) : process.cwd(),
      maxAttempts: flag('max-attempts') ? Number(flag('max-attempts')) : MAX_LAND_ATTEMPTS,
      gate: flag('gate') || '',
      skipVerify: flag('skip-verify') !== undefined,
    });
    if (flag('json') !== undefined) writeAllSync(1, `${JSON.stringify(result, null, 2)}\n`);
    else writeAllSync(1, `${describeLanding(result)}\n`);
    if (result.status !== 'landed' && result.status !== 'noop') process.exitCode = 1;
  } catch (e) {
    writeLineSync(2, `error: ${String(e?.message ?? e)}`);
    process.exitCode = 1;
  }
}
