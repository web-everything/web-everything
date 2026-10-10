/**
 * @file scripts/lib/daemon-self-sync.mjs
 * @description xv6fciw (narrow slice of decision #3681) — keep a daemon's DEDICATED clone on `origin/main`
 *   without a human re-syncing it, and restart the daemon onto new code between ticks.
 *
 * WHY. The review and fix-dispatch daemons run from a dedicated clone. `main` lands PRs every few minutes, so
 * within minutes the clone is behind and every tick refuses every dispatch (`assertMainNotStale`) until someone
 * fetches and merges by hand — done 5+ times on 2026-09-23 alone. The clone is usually also AHEAD (unmerged
 * fixes merged in to run ahead of `main`), so `checkMainStaleness`'s fast-forward never applies; it needs a real
 * merge.
 *
 * WHAT IT DOES, before each tick:
 *   1. fetch `origin/main`;
 *   2. behind + clean tree → `git merge origin/main` (a merge commit); a conflict is aborted, leaving the tree
 *      exactly as it was, and the tick proceeds (it will refuse as it does today — never worse);
 *   3. a dirty tree, or a checkout not on `main`, is never touched;
 *   4. if the merge brought in commits, the daemon's in-memory code is now older than its checkout: the wrapper
 *      calls `onRestart` INSTEAD of ticking — the caller releases its lease and exits 0, and launchd's KeepAlive
 *      starts it again on the new code. That happens between ticks, never mid-dispatch.
 *
 * PURE CORE / IO SHELL: {@link decideSelfSync} is pure; {@link selfSyncCheckout} does the git IO through an
 * injected runner (defaults to `main-staleness.mjs#gitRun`); {@link withSelfSync} wraps a daemon's
 * `runDaemonLoop` effects.
 *
 * #3383 — TWO LIVE BUGS FOUND 2026-09-23, BOTH FIXED HERE, BOTH ADDITIVE (every existing caller's behavior is
 * unchanged unless it opts in / the new drift check below is the one exception, see its own note). Both apply
 * only to the DEFAULT (non-POC) path below — see the POC MODE paragraph for why that path stays untouched.
 *
 *   BUG 1 — a multi-repo tick takes long enough (several `gh` calls per repo, several repos) that
 *   `origin/main` moves again AFTER this file's own tick-start sync ran but BEFORE the tick finishes — the
 *   real dispatch chokepoint (`main-staleness.mjs#assertMainNotStale`, called once per repo deep inside the
 *   tick) then refuses that repo outright ("refusing to dispatch... STALE code..."). Before this fix, that
 *   refusal was just absorbed as an ordinary per-repo tick failure and the daemon slept the FULL interval
 *   before trying again — losing the same race next tick too, since main moves every few minutes, well within
 *   a 3-repo tick's own duration (confirmed live: 345 refusal lines, ALL 3 repos on the latest tick). The fix:
 *   `withSelfSync` now accepts an optional `hasStaleRefusal(tickResult)` predicate; when a tick's own result
 *   is flagged, it re-syncs IMMEDIATELY (not waiting for the next scheduled tick) and restarts if that finds
 *   new commits — the same `onRestart` path the tick-start sync already uses. Omitting `hasStaleRefusal`
 *   (every caller that existed before this fix) is byte-identical to today.
 *
 *   BUG 2 — the review-daemon and reconcile-fix-dispatch-daemon run from ONE shared dedicated clone.
 *   Whichever self-syncs first performs the merge and restarts (via the branch above); the OTHER then calls
 *   `selfSyncCheckout` itself, finds `behind: 0` (someone else already brought the checkout current) and,
 *   before this fix, just ticked on — forever, on its own now-stale in-memory module cache, since nothing
 *   about "up-to-date" told it the code underneath it had changed. Confirmed live: the fix-dispatch daemon ran
 *   from 18:09 to ~19:17 on stale code before a human noticed and restarted it by hand. The fix: `withSelfSync`
 *   now records the on-disk HEAD sha once, when the daemon BOOTS (i.e., once, when this function itself is
 *   called to build the effects — before the loop's first tick), and every tick re-reads HEAD and restarts
 *   whenever it no longer matches — regardless of WHICH process (this one, or a sibling sharing the same
 *   clone) moved it. This is unconditional (not behind an option) because it changes nothing for a daemon
 *   running from its OWN clone (its own merges already restart it via the existing branch; nothing else ever
 *   moves its HEAD) and only ever ADDS a restart, never removes one — never a regression, by construction.
 *
 * POC MODE (epic #3383's daemon POC, `we:docs/agent/platform-decisions.md#poc-branch-declared-delivery-mode`,
 * `we:scripts/lib/poc-branches.json`'s `lane/daemon-poc` entry). Setting {@link DAEMON_SELF_SYNC_BRANCH_ENV}
 * (`DAEMON_SELF_SYNC_BRANCH=lane/daemon-poc`) switches a clone's "home" branch from `main` to the named POC
 * branch and, each tick, fetches BOTH `origin/main` AND `origin/<poc>`, merging whichever has commits the
 * clone lacks — same merge-commit-never-rebase-never-push contract as the default path used to have, just
 * against two upstreams instead of one, and the SAME fail-closed/timeout posture the default path already
 * carries (a failed/timed-out probe is never silently read as clean/up-to-date). {@link decidePocSelfSync} /
 * {@link selfSyncCheckoutPoc} carry this and are UNCHANGED by everything below — deliberately not
 * generalized onto the rebuild flow, so the already-shipped POC daemon behavior stays byte-identical rather
 * than riding on a generalization it never asked for. Neither review-daemon.mjs nor
 * reconcile-fix-dispatch-daemon.mjs opt into POC mode today.
 *
 * #4044 MODULE E — THE DEFAULT PATH NOW REBUILDS, IT NEVER MERGES. Everything above (bugs 1/2, the live-smoke
 * gate) described the FIRST cut of self-sync: fetch + `git merge origin/main` on top of whatever the clone
 * already had, gated by a live smoke check bolted onto `withSelfSync` itself. That could drift a clone into a
 * tree no commit on GitHub ever represented (an overlay merged last week, main merged on top THIS week, in an
 * order nobody could reconstruct from `origin` alone) — `we:scripts/lib/daemon-rebuild.mjs` (Module C) replaces
 * it: every tick, the clone is rebuilt FRESH from `origin/main` plus its registered overlay list
 * (`we:scripts/lib/daemon-overlays.mjs`, Module B), in the object database, gated by the SAME live smoke
 * (now owned by `rebuildClone` itself, not this wrapper), under the clone's own reader/writer lock
 * (`we:scripts/lib/daemon-clone-lock.mjs`, Module A). `withSelfSync`'s DEFAULT (non-POC) path is now:
 *   1. `rebuild()` (injectable, defaults to `rebuildClone`) — it takes the WRITE lock itself, so nothing here
 *      needs to. `moved && adopted` ⇒ `onRestart` immediately; the read lock below is never even acquired.
 *   2. Otherwise, acquire the clone's READ lock (`acquireRead`, Module A). Refused (a writer — i.e. a rebuild,
 *      possibly a SIBLING process's — is active) ⇒ log and return `{skipped:true, reason}`: skip this tick
 *      entirely rather than ever read a tree mid-move.
 *   3. Under the read lock: if the rebuild state (`readState`, defaults to `readRebuildState`) shows the clone
 *      quarantined ⇒ release the lock and skip the tick (never run children off a rejected tree, never
 *      restart onto it). Else if `HEAD` has moved since this process's own boot (#3383 bug 2's drift check,
 *      unchanged in spirit) ⇒ release the lock FIRST, then `onRestart({reason:'head-moved'})` — safe because
 *      any HEAD change visible under the read lock is always an ADOPTED build — xa4qo7n: the writer only ever
 *      moves `root`'s HEAD (`git reset --hard`) AFTER the candidate's live smoke has already passed (run
 *      unlocked, against a disposable worktree, never against `root` itself — see `daemon-rebuild.mjs`'s file
 *      header), so a rejected build never reaches `root` at all and there is nothing to restore.
 *   4. Run the real tick under the read lock (try/finally — the lock is released whether the tick returns or
 *      throws), and release it before doing anything else.
 *   5. `hasStaleRefusal(result)` (#3383 bug 1, unchanged in spirit) ⇒ AFTER the read lock is released, call
 *      `rebuild()` again (the SAME gated path, never a raw merge). Adoption with imported changes restarts
 *      immediately, without the normal debounce. Otherwise re-discover under a fresh read lock once in this
 *      pass; do not sleep away the opportunity the successful rebuild just created.
 * x44lnnt (live 2026-10-09: no fix-daemon tick for 68 min behind 10-24 min smokes) → x0m7a8x (card 5691): the
 * build + smoke now runs as the DETACHED REBUILD JOB (#4126, we:scripts/lib/daemon-rebuild/rebuild-job.mjs), so
 * step 1 is the job's fast tick side (adopt a smoke-passed candidate, else queue / watch the job) — never a smoke.
 * The older detached BUILDER process (x44lnnt) is retired: it only launched that job and adopted its result,
 * coalesced to one start per 5 min, which delayed every swap by up to 5 min. Its two rules stay, here: the swap
 * spacing (`swapMinIntervalMs`, we:scripts/lib/daemon-background-build-settings.json, for the daemons listed
 * there) and the re-clone fail-closed rule (a re-cloned checkout runs no children until a rebuild on it has
 * concluded — {@link recloneConcluded}, persisted per clone so it survives a restart).
 * `selfSyncCheckout` (the old merge-based IO) is no longer called anywhere on this path — kept exported only
 * because nothing else in this codebase imports it privately, and removing a public export for no functional
 * reason is its own kind of breakage. `sync`/`gate` stay ACCEPTED options (runner.mjs forwards them) but are
 * unused on the default path now — the live smoke gate they used to wire moved inside `rebuildClone` itself.
 * At construction, `withSelfSync` also sets `process.env.WE_DAEMON_MANAGED_CLONE = '1'` and
 * `process.env.GIT_OPTIONAL_LOCKS = '0'` — every child process this daemon spawns inherits both, so a plain
 * `git status` a dispatched session runs never itself takes `.git/index.lock`, and
 * `we:scripts/lib/main-staleness.mjs#assertMainNotStale`'s own default checker sees the managed-clone flag and
 * refuses to fast-forward a managed clone by itself (a dispatch chokepoint auto-ff-ing past the live-smoke
 * gate would defeat the whole point of gating rebuilds in the first place).
 */

import { gitRun, isCodePath } from './main-staleness.mjs';
import { collectImportClosure, closureHits } from './import-closure.mjs';

export { collectImportClosure };
import { gateMergedCommit } from './daemon-live-smoke.mjs';
import { rebuildClone, readRebuildState } from './daemon-rebuild.mjs';
import { resolveVersionedContext, isInsideVersions, currentVersion } from './daemon-version-runtime.mjs';
import { pin as pinVersion, unpin as unpinVersion } from './daemon-version-switch.mjs';
import {
  acquireRead as acquireReadLock, releaseRead as releaseReadLock, resolveReaderPriorityAfter,
} from './daemon-clone-lock.mjs';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { repairCloneRefs } from './lane-repair.mjs';
import {
  loadBackgroundBuildSettings, resolveBackgroundBuild, tickStarvedSmell, BACKGROUND_BUILD_ENV,
  BUILT_IN_BACKGROUND_BUILD_SETTINGS, makeTickProgressStore, readCloneIdentity,
} from './daemon-background-build.mjs';
import { resolveRebuildAsJob } from './daemon-rebuild/rebuild-job.mjs';
import { cloneKey } from './daemon-overlays.mjs';
import { daemonStateDir } from './daemon-last-good.mjs';

/** Setting: how long a STARVED reader (see `daemon-clone-lock.mjs` "reader fairness") waits, within the same
 *  tick, for draining writers to back off before it skips. Default 30s; a writer that already holds the clone
 *  is never interrupted, so this only has to outlast a fast locked step. */
export const READER_PRIORITY_WAIT_ENV = 'WE_DAEMON_CLONE_LOCK_PRIORITY_WAIT_MS';
export const DEFAULT_READER_PRIORITY_WAIT_MS = 30_000;
const PRIORITY_POLL_MS = 1000;

/** Setting: the "clone stuck" smell — the clone has not moved for this long while `origin/main` moved past what
 *  it last adopted (live 2026-10-06: 5.5 h of writer starvation went unnoticed). Default 30 min; 0 = off. */
export const CLONE_STUCK_SMELL_ENV = 'WE_DAEMON_CLONE_STUCK_SMELL_MS';
export const DEFAULT_CLONE_STUCK_SMELL_MS = 30 * 60_000;

/** PURE: the clone-stuck smell threshold from env (non-negative number, else the default; 0 = off). */
export function resolveCloneStuckSmellMs(env = process.env) {
  const raw = env?.[CLONE_STUCK_SMELL_ENV];
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CLONE_STUCK_SMELL_MS;
}

/** PURE: is the clone stuck? `adopted` is `state.adopted` ({at, mainSha}); `originMain` the current
 *  `origin/main` sha. Stuck = main moved past the adopted main AND the last adoption is older than `thresholdMs`.
 *  @returns {{stuck:false}|{stuck:true, ageMs:number}} */
export function cloneStuckSmell({ adopted, originMain, nowMs, thresholdMs }) {
  if (!(thresholdMs > 0) || !adopted || !originMain) return { stuck: false };
  const at = Date.parse(adopted.at || '');
  if (!Number.isFinite(at)) return { stuck: false };
  const ageMs = nowMs - at;
  if (adopted.mainSha === originMain || ageMs < thresholdMs) return { stuck: false };
  return { stuck: true, ageMs };
}

/** PURE: the starved-reader wait from env — a non-negative integer, else the default. */
export function resolvePriorityWaitMs(env = process.env) {
  const raw = env?.[READER_PRIORITY_WAIT_ENV];
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_READER_PRIORITY_WAIT_MS;
}

/**
 * Pure: what should a daemon's clone do, given where it stands against `origin/main`?
 * `dirty: null` means the tree state is UNKNOWN (the `git status` itself failed or timed out) — that fails
 * CLOSED (`status-failed`), never as clean: merging a tree we could not inspect could restart the daemon over
 * uncommitted work. The same fail-closed rule covers every other probe: `behind: null` (the `rev-list --count`
 * failed, timed out, or printed no number) is `count-failed`, NEVER `up-to-date` — reading an unknown distance
 * as 0 would let the clone silently fall behind `origin/main` forever with no signal; `onBase: null` (the
 * `symbolic-ref` failed) is `head-failed`, not a misleading `not-on-main`.
 * @param {{fetched:boolean, behind:number|null, dirty:boolean|null, onBase:boolean|null}} s
 * @returns {{action:'none'|'merge'|'skip', reason:string}}
 */
export function decideSelfSync({ fetched, behind, dirty, onBase }) {
  if (!fetched) return { action: 'skip', reason: 'fetch-failed' };
  if (behind === null) return { action: 'skip', reason: 'count-failed' };
  if (!behind) return { action: 'none', reason: 'up-to-date' };
  if (onBase === null) return { action: 'skip', reason: 'head-failed' };
  if (!onBase) return { action: 'skip', reason: 'not-on-main' };
  if (dirty === null) return { action: 'skip', reason: 'status-failed' };
  if (dirty) return { action: 'skip', reason: 'dirty' };
  return { action: 'merge', reason: 'behind' };
}

/**
 * The git IO: fetch, measure, and merge when {@link decideSelfSync} says so. Never throws; never leaves a
 * half-merged tree (a failed merge is aborted).
 *
 * Every git command carries a per-command `timeout` (default 60s, overridable via `timeoutMs`) + `killSignal:
 * 'SIGKILL'`, spread straight into `spawnSync` by `gitRun` (or any injected `run` that does the same) — so a
 * hung `fetch`/`merge` (network stall, credential prompt) can NEVER freeze the caller indefinitely. `gitRun`
 * already treats a null/non-zero `status` as failure, so a timed-out command falls through the existing
 * fetch-failed / merge-abort paths unchanged: a timed-out fetch → `fetch-failed` (never reaches merge); a
 * timed-out merge → aborted (itself under the same timeout) and reported as `conflict`; a failed/timed-out
 * `status` → `status-failed` (fail closed — an uninspected tree is never treated as clean); a failed/timed-out
 * (or non-numeric) `rev-list --count` → `count-failed` (never coerced to 0 / `up-to-date`); a failed/timed-out
 * `symbolic-ref` → `head-failed`.
 * @param {{root:string, base?:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {{merged:boolean, commits:number, reason:string}}
 */
export function selfSyncCheckout({ root, base = 'main', run = gitRun, timeoutMs = 60_000 }) {
  const git = (args) => run(args, { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });
  repairCloneRefs(root, { log: (m) => console.error(m) }); // prune dangling remote-tracking refs before any fetch (no re-clone: this tick does not hold the clone write lock)
  const fetched = git(['fetch', 'origin', base, '--quiet']).status === 0;
  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    const out = String(r.stdout ?? '').trim();
    return r.status === 0 && /^\d+$/.test(out) ? Number(out) : null;
  };
  const behind = fetched ? count(`HEAD..origin/${base}`) : 0;
  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const onBase = head.status === 0 ? String(head.stdout ?? '').trim() === base : null;
  const status = git(['status', '--porcelain']);
  const dirty = status.status === 0 ? !!String(status.stdout ?? '').trim() : null;

  const decision = decideSelfSync({ fetched, behind, dirty, onBase });
  if (decision.action !== 'merge') return { merged: false, commits: 0, reason: decision.reason };

  const merge = git(['merge', `origin/${base}`, '--no-edit', '-m', `sync: catch up with origin/${base} (daemon self-sync)`]);
  if (merge.status !== 0) {
    git(['merge', '--abort']);
    return { merged: false, commits: 0, reason: 'conflict' };
  }
  return { merged: true, commits: behind, reason: 'merged' };
}

/** Read the on-disk `HEAD` sha, fail-safe: any git failure (a bad `root`, a timeout, a detached-but-unreadable
 *  ref) returns `null` rather than throwing. Used only by {@link withSelfSync}'s boot-drift check (#3383 bug
 *  2) — a `null` (either at boot or on a later read) simply SKIPS that check for the affected read, it never
 *  reads as "moved" and never falsely restarts.
 * @param {{root:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {string|null}
 */
export function readHeadSha({ root, run = gitRun, timeoutMs = 60_000 }) {
  const r = run(['rev-parse', 'HEAD'], { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });
  const out = String(r.stdout ?? '').trim();
  return r.status === 0 && out ? out : null;
}

/** Read a ref's sha (typically `origin/<base>`, right after a fetch already updated it locally) — same
 *  fail-safe shape as {@link readHeadSha}. Used by {@link withSelfSync}'s live-smoke gate (#3383) as the
 *  stable IDENTITY of "what origin/main tip did this merge bring in" — deliberately NOT the resulting merge
 *  commit's own sha, which changes tick to tick (a fresh `--no-edit` merge commit's author/committer dates
 *  differ even when origin hasn't moved) and would defeat the reject-cache's "don't retry until main moves"
 *  contract.
 * @param {{root:string, ref:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {string|null}
 */
export function readOriginRefSha({ root, ref, run = gitRun, timeoutMs = 60_000 }) {
  const r = run(['rev-parse', ref], { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });
  const out = String(r.stdout ?? '').trim();
  return r.status === 0 && out ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// POC MODE (#3383 daemon POC) — a clone tracking a registered POC branch INSTEAD of `main` alone.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The env var that switches a clone into POC mode — mirrors `we:scripts/lib/poc-branches.mjs`'s own
 *  `WE_POC_BRANCH_SYNC` naming convention. Unset (or blank) is the DEFAULT path, unchanged. */
export const DAEMON_SELF_SYNC_BRANCH_ENV = 'DAEMON_SELF_SYNC_BRANCH';

/**
 * PURE: is `name` a plain branch name that is safe to splice into a git argv? The POC branch comes from an
 * env var or caller option — external input — so a value like `--upload-pack=<cmd>` would otherwise be parsed
 * by `git fetch` as an OPTION and run `<cmd>` (PR #2554 review, confirmed exploitable). Deliberately stricter
 * than `git check-ref-format`: a conservative character allow-list (letters, digits, `.`, `_`, `-`, `/`) plus
 * git's own structural rules — no leading `-`, no empty/`.`-leading path component, no `..`, no `//`, no
 * leading/trailing `/`, no trailing `.` or `.lock` component.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSafeBranchName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.endsWith('.') || name.includes('..')) return false;
  return name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Throw unless {@link isSafeBranchName} accepts `name` — the fail-closed gate every POC entry point shares. */
function assertSafeBranchName(name, source) {
  if (!isSafeBranchName(name)) throw new TypeError(`daemon-self-sync: ${source} ${JSON.stringify(name)} is not a safe branch name — refusing to pass it to git`);
  return name;
}

/**
 * Resolve the POC branch a clone should track, from an explicit option or {@link DAEMON_SELF_SYNC_BRANCH_ENV}.
 * Blank/whitespace-only counts as unset — the default (`main`-only) path. A non-blank value that fails
 * {@link isSafeBranchName} THROWS rather than falling back to `main`: a mis-set POC branch is an operator error
 * to surface loudly, never a silent mode change. PURE.
 * @param {{pocBranch?:string, env?:NodeJS.ProcessEnv}} [o]
 * @returns {string|null}
 */
export function resolvePocSyncBranch({ pocBranch, env = process.env } = {}) {
  const explicit = typeof pocBranch === 'string' ? pocBranch.trim() : '';
  if (explicit) return assertSafeBranchName(explicit, 'pocBranch');
  const fromEnv = typeof env?.[DAEMON_SELF_SYNC_BRANCH_ENV] === 'string' ? env[DAEMON_SELF_SYNC_BRANCH_ENV].trim() : '';
  return fromEnv ? assertSafeBranchName(fromEnv, DAEMON_SELF_SYNC_BRANCH_ENV) : null;
}

/**
 * Pure: what should a POC-mode clone do, given fetch/behind readings against BOTH `origin/main` and the POC
 * branch it now also tracks? Generalizes {@link decideSelfSync} to two independent sources — `onBranch`
 * replaces `onBase` (the clone's home branch is the POC branch itself, not `main`, once this mode is active);
 * every other gate means the same thing it always did, including the SAME fail-closed treatment of an unknown
 * probe: `onBranch: null` (symbolic-ref failed) is `head-failed`; `dirty: null` (status failed) is
 * `status-failed`; a source whose OWN `behind` is `null` despite a successful fetch (`rev-list` failed, timed
 * out, or printed no number) never counts as mergeable, and if NEITHER source has anything mergeable and at
 * least one is in that state, the tick reports `count-failed` rather than the misleading `up-to-date`. Order:
 * the two clone-wide gates (`onBranch`, `dirty`) are checked before either source's own fetch/behind, since
 * they apply regardless of what either source reports.
 * @param {{dirty:boolean|null, onBranch:boolean|null, main:{fetched:boolean, behind:number|null}, poc:{fetched:boolean, behind:number|null}}} s
 * @returns {{action:'none'|'merge'|'skip', reason:string, mergeMain:boolean, mergePoc:boolean}}
 */
export function decidePocSelfSync({ dirty, onBranch, main, poc }) {
  if (onBranch === null) return { action: 'skip', reason: 'head-failed', mergeMain: false, mergePoc: false };
  if (!onBranch) return { action: 'skip', reason: 'not-on-branch', mergeMain: false, mergePoc: false };
  if (dirty === null) return { action: 'skip', reason: 'status-failed', mergeMain: false, mergePoc: false };
  if (dirty) return { action: 'skip', reason: 'dirty', mergeMain: false, mergePoc: false };
  const mainFetched = !!main?.fetched;
  const pocFetched = !!poc?.fetched;
  if (!mainFetched && !pocFetched) return { action: 'skip', reason: 'fetch-failed', mergeMain: false, mergePoc: false };
  const mainCountFailed = mainFetched && main?.behind == null;
  const pocCountFailed = pocFetched && poc?.behind == null;
  const mergeMain = mainFetched && Number.isFinite(main?.behind) && main.behind > 0;
  const mergePoc = pocFetched && Number.isFinite(poc?.behind) && poc.behind > 0;
  if (!mergeMain && !mergePoc) {
    if (mainCountFailed || pocCountFailed) return { action: 'skip', reason: 'count-failed', mergeMain: false, mergePoc: false };
    return { action: 'none', reason: 'up-to-date', mergeMain: false, mergePoc: false };
  }
  return { action: 'merge', reason: 'behind', mergeMain, mergePoc };
}

/**
 * The git IO for POC mode: fetch BOTH `origin/<base>` and `origin/<pocBranch>`, measure each independently,
 * and merge whichever has commits the clone lacks — each its OWN merge commit, never a rebase, never a push.
 * Same per-command `timeout`/`killSignal: 'SIGKILL'` posture as {@link selfSyncCheckout} (default 60s,
 * overridable via `timeoutMs`), and the same fail-closed reads (a failed/timed-out `status` or `rev-list` is
 * never coerced into "clean" or "up to date").
 *
 * A conflict on either merge aborts THAT merge only (never leaves a half-merged tree — same contract as
 * {@link selfSyncCheckout}) and STOPS this tick's sync (the other source is not attempted once one has
 * conflicted). A merge that already landed earlier in the SAME tick (`origin/main` merged cleanly, then
 * `origin/<pocBranch>` conflicted) stays committed — real, completed progress, not a rollback candidate — and
 * is reported as `reason: 'merged-partial'` so the caller still restarts onto it while logging that the other
 * source needs a hand merge.
 * @param {{root:string, base?:string, pocBranch:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {{merged:boolean, commits:number, reason:string}}
 */
export function selfSyncCheckoutPoc({ root, base = 'main', pocBranch, run = gitRun, timeoutMs = 60_000 }) {
  if (!pocBranch) throw new TypeError('selfSyncCheckoutPoc requires a pocBranch');
  assertSafeBranchName(pocBranch, 'pocBranch');
  assertSafeBranchName(base, 'base');
  const git = (args) => run(args, { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });
  repairCloneRefs(root, { log: (m) => console.error(m) }); // prune dangling remote-tracking refs before any fetch (no re-clone: this tick does not hold the clone write lock)
  // `--` ends option parsing: defense in depth on top of the name check, so a ref is never read as a flag.
  const fetchedMain = git(['fetch', '--quiet', '--', 'origin', base]).status === 0;
  const fetchedPoc = git(['fetch', '--quiet', '--', 'origin', pocBranch]).status === 0;
  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    const out = String(r.stdout ?? '').trim();
    return r.status === 0 && /^\d+$/.test(out) ? Number(out) : null;
  };
  const behindMain = fetchedMain ? count(`HEAD..origin/${base}`) : 0;
  const behindPoc = fetchedPoc ? count(`HEAD..origin/${pocBranch}`) : 0;
  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const onBranch = head.status === 0 ? String(head.stdout ?? '').trim() === pocBranch : null;
  const status = git(['status', '--porcelain']);
  const dirty = status.status === 0 ? !!String(status.stdout ?? '').trim() : null;

  const decision = decidePocSelfSync({
    dirty,
    onBranch,
    main: { fetched: fetchedMain, behind: behindMain },
    poc: { fetched: fetchedPoc, behind: behindPoc },
  });
  if (decision.action !== 'merge') return { merged: false, commits: 0, reason: decision.reason };

  // `commits` is a DECISION-TIME estimate (behindMain + behindPoc, both measured against the pre-merge HEAD),
  // not an exact post-merge count: when origin/<pocBranch> already contains commits origin/main is also ahead
  // by, those are counted twice. It only feeds the restart log line — never depend on it for precision.
  let commits = 0;
  let mergedAny = false;
  let conflicted = false;
  const mergeRef = (ref, n) => {
    const merge = git(['merge', ref, '--no-edit', '-m', `sync: catch up with ${ref} (daemon self-sync, POC mode)`]);
    if (merge.status !== 0) { git(['merge', '--abort']); conflicted = true; return; }
    commits += n;
    mergedAny = true;
  };

  if (decision.mergeMain) mergeRef(`origin/${base}`, behindMain);
  if (!conflicted && decision.mergePoc) mergeRef(`origin/${pocBranch}`, behindPoc);

  if (mergedAny) return { merged: true, commits, reason: conflicted ? 'merged-partial' : 'merged' };
  return { merged: false, commits: 0, reason: 'conflict' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// #4044 RESTART GATE — restart only when the daemon's OWN code changed, and never more than once per window.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// LIVE BUG (2026-09-25): every rebuild that moved the clone restarted EVERY daemon running from it — on every
// main move, every few minutes during drain activity, though most moves only touch `backlog/*.md`. Each restart
// costs a boot plus a fresh tick; the fix-dispatch daemon's 120s ticks were starved. A daemon's in-memory code
// is only stale when a file it IMPORTED changed: its children (passes, dispatched sessions) are spawned fresh
// from disk every time and always see the new tree. So the restart decision is now: which files changed between
// this process's boot sha and HEAD now, and does any of them sit in this daemon's static import closure?

/** Env var: minimum time (ms) a daemon process runs before a code-change restart is taken. Default 2 min. */
export const RESTART_MIN_INTERVAL_ENV = 'WE_DAEMON_RESTART_MIN_INTERVAL_MS';
export const DEFAULT_RESTART_MIN_INTERVAL_MS = 2 * 60 * 1000;

/** PURE: the restart window from env — a non-negative integer, else the default. */
export function resolveRestartMinIntervalMs(env = process.env) {
  const raw = env?.[RESTART_MIN_INTERVAL_ENV];
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESTART_MIN_INTERVAL_MS;
}

/** Files changed between two commits (`git diff --name-only from to`), or `null` on any git failure. */
export function changedFilesBetween({ root, from, to, run = gitRun, timeoutMs = 60_000 }) {
  if (!from || !to) return null;
  const r = run(['diff', '--name-only', '--no-renames', from, to], { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (r.status !== 0) return null;
  return String(r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}


/**
 * PURE: does the move from boot sha to HEAD-now need this daemon to restart, and may it restart now?
 *   - `changedFiles: null` (the diff failed — unknown) ⇒ restart NOW, as before this gate (fail safe, never
 *     throttled: an unknown move is the one case we can't reason about).
 *   - no changed file the daemon imports ⇒ `{restart:false, reason:'no-imported-change'}` — keep ticking; the
 *     on-disk tree is current (dispatch staleness reads the checkout, not memory) and children see it anyway.
 *   - an imported file changed, but this process booted less than `minIntervalMs` ago ⇒
 *     `{restart:false, reason:'min-interval'}` — taken on a later tick, so a burst of code landings costs at
 *     most one restart per window.
 *   - else restart.
 * @param {{changedFiles:string[]|null, closure:ReturnType<typeof collectImportClosure>, uptimeMs:number, minIntervalMs:number}} s
 * @returns {{restart:boolean, reason:string, relevant?:string[]}}
 */
export function decideRestart({ changedFiles, closure, uptimeMs, minIntervalMs }) {
  if (changedFiles == null) return { restart: true, reason: 'diff-unknown' };
  let relevant;
  if (!closure || !closure.complete) {
    relevant = changedFiles.filter(isCodePath);
  } else {
    relevant = closureHits({ closure, changedFiles });
  }
  if (!relevant.length) return { restart: false, reason: 'no-imported-change', relevant };
  if (Number.isFinite(minIntervalMs) && uptimeMs < minIntervalMs) return { restart: false, reason: 'min-interval', relevant };
  return { restart: true, reason: 'imported-change', relevant };
}

/**
 * #4044 (live 2026-09-25 ~13:20Z): a skipped tick used to return a bare `{skipped, reason}` into the daemon's
 * `onTick`, which reads `result.repos.map(...)` — `review-daemon: tick failed (non-fatal): Cannot read properties
 * of undefined (reading 'map')` on every skip. A skip is now an EMPTY tick in every daemon's result shape (the
 * union of review-daemon's and reconcile-fix-dispatch-daemon's fields), plus the `skipped`/`reason` markers.
 * @param {string} reason
 */
export function skippedTick(reason) {
  return {
    skipped: true, reason, repos: [], dispatched: [], failed: [], refusals: [], reconcileFailed: [], reviewsOwed: 0,
  };
}

// ── x0m7a8x: the re-clone fail-closed rule, carried over from the retired builder record ─────────────────────
// A re-clone (`repairCloneRefs`, under the clone's write lock — run by a tick's adopt pass OR by the rebuild job's
// child) replaces the checkout with plain origin/main, never smoked. No children run on it until a rebuild on THAT
// checkout has concluded, whatever its verdict — as the pre-job inline path ticked again only after its rebuild on
// the fresh clone. The marker is per clone (shared by every daemon on it) and persisted, so a restart keeps it.

/** `<stateDir>/<cloneKey>.recloned.json` — `{identity, head, at, concluded, concludedAt?}`. */
export function recloneMarkerPath(root, env = process.env) {
  return join(daemonStateDir(env), `${cloneKey(root)}.recloned.json`);
}

/** What an unreadable (corrupt / truncated) marker file reads as: an unconcluded re-clone of an unknown checkout. */
export const UNREADABLE_RECLONE_MARKER = Object.freeze({ identity: null, head: null, concluded: false, why: 'marker-unreadable' });

/**
 * The real marker IO. Never throws. Fail closed: a MISSING file reads as null (no re-clone), but a file that exists
 * and cannot be parsed reads as {@link UNREADABLE_RECLONE_MARKER} (blocks until a rebuild concludes and overwrites
 * it). A write that fails is kept in memory and read back from there, so this process still blocks AND still
 * unblocks (never wedged by an unwritable state dir); the failure is logged, because only the file survives a restart.
 */
export function makeRecloneMarkerStore({ root, env = process.env, log = { error: () => {} } }) {
  const path = recloneMarkerPath(root, env);
  let pending; // set while the newest value exists only in memory (its file write failed)
  return {
    read: () => {
      if (pending !== undefined) return pending;
      let text;
      try { text = readFileSync(path, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? null : UNREADABLE_RECLONE_MARKER; }
      try { return JSON.parse(text); } catch { return UNREADABLE_RECLONE_MARKER; }
    },
    write: (v) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(v)}\n`, 'utf8');
        renameSync(tmp, path);
        pending = undefined;
      } catch (e) {
        pending = v;
        log.error?.(`daemon-self-sync: could not persist the re-clone marker ${path} (${String(e?.message || e).split('\n')[0]}) — this process keeps it in memory; a restart before the write succeeds loses it (x0m7a8x)`);
      }
    },
  };
}

/** An in-memory marker store (tests, and every caller that injects its own `rebuild`). */
export function memoryRecloneMarkerStore(initial = null) {
  let v = initial;
  return { read: () => v, write: (n) => { v = n; } };
}

/**
 * PURE: did this tick's rebuild result report a re-clone? Directly (the adopt pass re-cloned) or through a rebuild
 * job that finished this tick with that reason (the job child re-cloned under the write lock).
 */
export function resultReportsReclone(result) {
  if (result?.reason === 'clone-recloned') return true;
  return (result?.finishedJobs || []).some((j) => j?.reason === 'clone-recloned');
}

/**
 * A rebuild JOB that ended `failed` because its rebuild child crashed after it started ("rebuild child exited N with
 * no JSON result"). It RAN on the checkout, so — parity with the retired builder, whose record counted a rebuild that
 * threw as a finished run — it concludes a re-clone. A job that never started (`could not prepare code`, `spawn
 * failed`) or was failed by the reattach pass (dead / stalled past its attempts: the builder's deadline case) does not.
 */
export const REBUILD_JOB_CRASHED_RE = /^rebuild child exited\b/;

/**
 * Which rebuild path does this daemon run? Explicit, resolved once by {@link withSelfSync} and passed to BOTH the
 * rebuild (`rebuildClone({asJob})`) and {@link recloneConcluded}, so the re-clone rule never infers the mode from a
 * result's shape. `WE_DAEMON_REBUILD_AS_JOB` ('0'/'1') and daemon-rebuild-settings.json `rebuildAsJob.entries` decide
 * first; otherwise the retired builder's opt-in `WE_DAEMON_BACKGROUND_BUILD=1` keeps meaning what an operator set it
 * for — "build off the tick path" — so it selects the job (x0m7a8x: it used to spawn the builder).
 */
export function resolveSelfSyncRebuildAsJob({ entries, env = process.env, resolve = resolveRebuildAsJob } = {}) {
  if (resolve({ entries, env })) return true;
  if (env?.WE_DAEMON_REBUILD_AS_JOB === '0') return false;
  return env?.[BACKGROUND_BUILD_ENV] === '1';
}

/**
 * PURE: has a rebuild on the re-cloned checkout concluded (so the tick may run children again)? Yes when the clone
 * moved to an adopted build, when HEAD moved off the re-clone's own HEAD (only an adopted build moves it), or when the
 * rebuild found nothing to build (`up-to-date` — the inline path ticked on that too). Beyond that it depends on the
 * daemon's DECLARED rebuild path (`asJob`, never inferred from the result's shape):
 * - `asJob: false` (INLINE): any verdict concludes — the smoke already ran on this checkout, whatever it said; exactly
 *   the pre-job inline rule.
 * - `asJob: true`, or unknown (`undefined` fails closed to the job rule): only a rebuild JOB that RAN on this checkout
 *   concludes — `succeeded` (its child produced a verdict, a rejected smoke included) or `failed` because its rebuild
 *   crashed after starting ({@link REBUILD_JOB_CRASHED_RE}). A job that failed to launch, one that itself re-cloned
 *   again, or one the marker names in `staleJobIds` (in flight before the re-clone, so it ran on the OLD tree) does
 *   not count. Nothing else does either: a spaced / started / running / queue-failed answer keeps it blocked.
 * @param {object|null} result @param {object|null} marker @param {string|null} headNow
 * @param {{asJob?: boolean}} [mode]
 */
export function recloneConcluded(result, marker, headNow, { asJob } = {}) {
  if (!marker || marker.concluded) return true;
  if (result?.moved && result?.adopted) return true;
  if (marker.head && headNow && headNow !== marker.head) return true;
  if (result?.reason === 'up-to-date') return true;
  if (asJob === false) return !!result && typeof result === 'object'; // inline verdict
  const stale = new Set(marker.staleJobIds || []);
  return (Array.isArray(result?.finishedJobs) ? result.finishedJobs : []).some((j) => j?.reason !== 'clone-recloned' && !stale.has(j?.id)
    && (j?.status === 'succeeded' || (j?.status === 'failed' && REBUILD_JOB_CRASHED_RE.test(String(j?.reason ?? '')))));
}

/**
 * Wrap a daemon's `runDaemonLoop` effects so each tick first self-syncs the clone. When new commits arrive,
 * `onRestart` runs in place of the tick (the caller releases its lease and exits); otherwise the tick runs.
 *
 * POC mode ({@link resolvePocSyncBranch} resolves non-null, from `pocBranch` or
 * {@link DAEMON_SELF_SYNC_BRANCH_ENV}) routes through {@link selfSyncCheckoutPoc} instead of
 * {@link selfSyncCheckout} — everything else about the wrapper (restart-on-merge, tick-through otherwise,
 * `timeoutMs` forwarding) is identical in shape. The DEFAULT (unset) path below matches
 * {@link selfSyncCheckout}'s own shipped behavior verbatim (plus the two #3383 fixes next), so it stays
 * byte-identical for every daemon that does not opt in.
 *
 * #3383 bug 2 (unconditional on the DEFAULT path, see file header): the on-disk `HEAD` sha is recorded once,
 * right now, when this function builds the wrapped effects (i.e., at the daemon's own boot, before
 * `runDaemonLoop`'s first tick). Every tick re-reads it; if it no longer matches — this process's OWN merge
 * (the branch below), a SIBLING process sharing the same clone having already merged, or a human's own
 * `git merge`/`pull` — this process's in-memory code no longer matches the checkout on disk, so it restarts
 * too, regardless of who moved it.
 *
 * #3383 bug 1 (opt-in via `hasStaleRefusal`, DEFAULT path only, see file header): when the wrapped tick's OWN
 * result shows it hit the stale-main refusal mid-tick, re-sync immediately and restart if that finds new
 * commits, instead of waiting out the full `intervalMs` to lose the same race again. A caller that omits
 * `hasStaleRefusal` (every caller that existed before this option) is byte-identical to before.
 * #3383 LIVE SMOKE GATE (DEFAULT PATH ONLY — same scoping rule as bugs 1/2 above: POC mode stays untouched,
 * since neither daemon that calls this opts into it today). Operator, 2026-09-24: "didnt I say nothing get
 * merge on daemon without being tested live and confirmed?" — before this, ANY merge on the default path
 * restarted the daemon onto it unconditionally, so a broken merged PR went live with zero live check (the
 * 2026-09-24 lane-pool regression that broke every review-daemon session this way). Now, once
 * `sync(syncOpts())` reports `merged: true`, `gate(...)` ({@link gateMergedCommit} by default) runs the live
 * smoke (`we:scripts/lib/daemon-live-smoke.mjs`) from the JUST-MERGED tree before `onRestart` is ever called: a
 * pass adopts (restarts, exactly as before this fix); a fail rolls the clone back to its pre-merge HEAD and
 * this tick simply runs `tick(...args)` on the old, still-in-memory code, as if nothing had merged. This is
 * UNCONDITIONAL on the default path (not behind a new opt-in option) because both real callers
 * (`review-daemon.mjs`, `reconcile-fix-dispatch-daemon.mjs`) already call `withSelfSync` with no knowledge of
 * this option and need the fix live without a further code change on their end — {@link SMOKE_KILL_SWITCH_ENV}
 * (`WE_DAEMON_SMOKE_DISABLE=1`) is the actual escape hatch, an env var, not a code-level opt-out.
 * @param {{tickOnce:(...args:any[])=>any}} effects
 * @param {{root:string, onRestart:(info:object)=>any, sync?:typeof selfSyncCheckout, syncPoc?:typeof selfSyncCheckoutPoc,
 *   base?:string, pocBranch?:string, env?:NodeJS.ProcessEnv, log?:Console, timeoutMs?:number,
 *   readHead?:typeof readHeadSha, readOriginRef?:typeof readOriginRefSha, hasStaleRefusal?:(tickResult:any)=>boolean,
 *   gate?:typeof gateMergedCommit, mainOnly?:boolean, rebuild?:(o?:object)=>Promise<object>,
 *   acquireRead?:typeof acquireReadLock, releaseRead?:typeof releaseReadLock, readState?:typeof readRebuildState}} o
 */
export function withSelfSync(effects, {
  root, onRestart, sync = selfSyncCheckout, syncPoc = selfSyncCheckoutPoc, base = 'main', pocBranch, env = process.env,
  log = console, timeoutMs, readHead = readHeadSha, readOriginRef = readOriginRefSha, hasStaleRefusal, gate = gateMergedCommit,
  mainOnly = false, rebuild: rebuildOpt, acquireRead = acquireReadLock, releaseRead = releaseReadLock, readState = readRebuildState,
  entries = [process.argv[1]], diffFiles = changedFilesBetween, importClosure = collectImportClosure,
  minRestartIntervalMs = resolveRestartMinIntervalMs(env), now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readerPriorityAfter = resolveReaderPriorityAfter(env), priorityWaitMs = resolvePriorityWaitMs(env),
  readerKey = `reader:${basename(String(entries?.[0] || 'daemon'))}`,
  cloneStuckSmellMs = resolveCloneStuckSmellMs(env),
  // Card 89 S5. `versions`: undefined resolves from the settings (default off), null forces the legacy path.
  // `tickContext.tickRoot` is set for the duration of each versioned tick: the folder this tick's children run from.
  versions, tickContext = {}, versionApi = { currentVersion, pin: pinVersion, unpin: unpinVersion },
  // x44lnnt → x0m7a8x — `background`: undefined resolves from daemon-background-build-settings.json by this daemon's
  // entry name; an object overrides it. Since the builder process is retired it selects only the SWAP SPACING
  // (`swapMinIntervalMs`, for the daemons the file lists) and the tick-starved smell threshold. `tickProgress` /
  // `recloneMarker` are IO (injectable); they default to the real files only when `rebuild` is the real one, so a
  // test never writes real daemon state.
  background, tickProgress, recloneMarker, cloneIdentity = readCloneIdentity,
  // x0m7a8x — the declared rebuild path (see resolveSelfSyncRebuildAsJob); undefined resolves it once, here.
  rebuildAsJob: rebuildAsJobOpt,
}) {
  const tick = effects.tickOnce;
  const realIo = rebuildOpt === undefined;
  const rebuildAsJob = rebuildAsJobOpt === undefined ? resolveSelfSyncRebuildAsJob({ entries, env }) : !!rebuildAsJobOpt;
  const rebuild = rebuildOpt ?? ((o = {}) => rebuildClone({
    root, env, log, mainOnly, entries, asJob: rebuildAsJob, ...o,
  }));
  const bg = background === undefined
    ? resolveBackgroundBuild({ entry: entries?.[0], settings: loadBackgroundBuildSettings(), env })
    : (background ? { ...BUILT_IN_BACKGROUND_BUILD_SETTINGS, ...background, enabled: !!background.enabled } : null);
  // The listed daemons keep the x44lnnt swap spacing; every other daemon keeps the plain restart window.
  const swapSpaced = !!bg?.enabled;
  const progress = tickProgress ?? (realIo ? makeTickProgressStore({ root, entry: entries?.[0], env }) : null);
  const marker = recloneMarker ?? (realIo ? makeRecloneMarkerStore({ root, env, log }) : memoryRecloneMarkerStore());
  const vctx = resolvePocSyncBranch({ pocBranch, env }) ? null : (versions === undefined ? resolveVersionedContext({ root, env }) : versions);
  const resolvedPocBranch = resolvePocSyncBranch({ pocBranch, env });
  const syncOpts = () => ({ root, ...(timeoutMs != null ? { timeoutMs } : {}) });
  // #4044 Module E — every child process this daemon spawns (a dispatched session's own `git status`, `gh`,
  // whatever) inherits both: `WE_DAEMON_MANAGED_CLONE` tells `main-staleness.mjs#assertMainNotStale`'s default
  // checker never to fast-forward this clone itself (only a gated rebuild may move it), and
  // `GIT_OPTIONAL_LOCKS=0` means a plain `git status` read never takes `.git/index.lock`. Set unconditionally,
  // for BOTH the default and POC paths — a POC-mode clone is just as much a managed clone as the default one.
  process.env.WE_DAEMON_MANAGED_CLONE = '1';
  process.env.GIT_OPTIONAL_LOCKS = '0';
  // `sync`/`gate` stay ACCEPTED (runner.mjs's `wireSelfSyncAndAppAuth` forwards them unconditionally) but are
  // UNUSED on the default path now — the live smoke gate they used to wire moved inside `rebuildClone` itself
  // (Module C). Referencing them here is a no-op that only silences an unused-destructure lint, never behavior.
  void sync; void gate;
  // Boot-time HEAD — read ONCE, here, before any tick ever runs. A read failure (null) permanently disables
  // the drift check for this process's lifetime rather than risk comparing against a wrong/stale value.
  const bootSha = readHead(syncOpts());
  const bootAt = now();
  const cloneLockOpts = () => (env && env.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT } : {});
  // #4044 restart gate (see decideRestart). The closure is walked lazily, once, from the BOOT tree's files — the
  // code actually loaded in memory. (A file newly added to the closure only matters via an edit to an existing
  // closure file that now imports it, which the gate already catches.)
  let closure;
  let closureBuilt = false;
  const loggedHeads = new Set();
  let lastStuckLogAt = -Infinity;
  let lastNoMoveKey = null;
  const swapMinIntervalMs = swapSpaced ? bg.swapMinIntervalMs : minRestartIntervalMs;
  // x0m7a8x — settings source, said once (the policy-cascade convention: every resolved setting names its source).
  if (!resolvedPocBranch && !vctx && realIo) {
    const asJob = rebuildAsJob;
    log.error?.(`daemon-self-sync: rebuild path = ${asJob ? 'detached rebuild job (#4126)' : 'INLINE rebuild + smoke on the tick path'}`
      + ` (daemon-rebuild-settings.json rebuildAsJob${env?.WE_DAEMON_REBUILD_AS_JOB ? `, env WE_DAEMON_REBUILD_AS_JOB=${env.WE_DAEMON_REBUILD_AS_JOB}` : ''});`
      + ` swap spacing ${Math.round(swapMinIntervalMs / 1000)}s (${swapSpaced ? `daemon-background-build-settings.json, source ${bg.source ?? 'option'}` : 'restart window'}) (x0m7a8x)`);
    if (env?.[BACKGROUND_BUILD_ENV] !== undefined) {
      log.error?.(`daemon-self-sync: ${BACKGROUND_BUILD_ENV}=${env[BACKGROUND_BUILD_ENV]} — the background builder process is retired (x0m7a8x). '1' now selects the detached rebuild JOB (off the tick path) plus the swap spacing; '0' turns off only the swap spacing — the rebuild path is set by WE_DAEMON_REBUILD_AS_JOB / daemon-rebuild-settings.json`);
    }
  }
  const restartGate = (headNow, { urgent = false, diffRoot = root, minIntervalMs = minRestartIntervalMs } = {}) => {
    if (!closureBuilt) {
      closureBuilt = true;
      try { closure = importClosure({ root, entries }); } catch { closure = null; }
    }
    const changedFiles = diffFiles({ root: diffRoot, from: bootSha, to: headNow, ...(timeoutMs != null ? { timeoutMs } : {}) });
    const d = decideRestart({ changedFiles, closure, uptimeMs: now() - bootAt, minIntervalMs: urgent ? 0 : minIntervalMs });
    if (!d.restart && !loggedHeads.has(`${headNow}:${d.reason}`)) {
      loggedHeads.add(`${headNow}:${d.reason}`);
      log.error?.(d.reason === 'min-interval'
        ? `daemon-self-sync: clone moved to ${headNow} and ${d.relevant.length} imported file(s) changed — restart deferred until this process has run ${Math.round(minIntervalMs / 1000)}s (#4044 restart gate)`
        : `daemon-self-sync: clone moved to ${headNow} (${changedFiles.length} file(s) changed since boot, none imported by this daemon) — no restart needed, ticking on (#4044 restart gate)`);
    }
    return d;
  };
  // Card 89 S5 — the lock-free tick. A version is immutable and a switch is one atomic pointer rename, so a
  // tick never needs a read slot: it pins the version it runs from (so gc keeps it), runs its children from that
  // folder, and unpins. A switch mid-tick leaves this tick on its old folder; the next tick reads `current` again.
  // Restarting is only meaningful when this process itself runs from a version folder; a daemon still booted from
  // the plain clone just keeps ticking its children from `current` until it is migrated (S6).
  const inVersion = !!vctx && isInsideVersions(vctx, root);
  const versionedTick = async (args) => {
    const rebuildResult = await rebuild();
    if (rebuildResult && rebuildResult.moved && rebuildResult.adopted) {
      const cur = versionApi.currentVersion(vctx);
      if (inVersion && cur && restartGate(rebuildResult.head, { diffRoot: cur.dir }).restart) {
        log.error?.(`daemon-self-sync: switched to a new version ${cur.id} (${rebuildResult.head}) — restarting onto the new code (card 89)`);
        return onRestart(rebuildResult);
      }
    } else if (rebuildResult && rebuildResult.reason && rebuildResult.reason !== 'up-to-date') {
      log.error?.(`daemon-self-sync: version rebuild did not switch (${rebuildResult.reason}) — ticking on the current version`);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cur = versionApi.currentVersion(vctx);
      if (inVersion && cur && bootSha != null && cur.sha !== bootSha && restartGate(cur.sha, { urgent: attempt > 0, diffRoot: cur.dir }).restart) {
        log.error?.(`daemon-self-sync: current moved from ${bootSha} to ${cur.sha} since this process booted — restarting onto the new code (card 89)`);
        return onRestart({ merged: false, commits: 0, reason: 'head-moved', headSha: cur.sha });
      }
      let pinned = false;
      let tickResult;
      try {
        if (cur) {
          const pinResult = await versionApi.pin({ clone: vctx.clone, home: vctx.home, id: cur.id, settings: vctx.settings });
          if (pinResult?.status !== 'pinned') {
            // busy / disabled: gc could delete the folder under a running tick — never run unpinned.
            log.error?.(`daemon-self-sync: could not pin version ${cur.id} (${pinResult?.status ?? 'no-result'}) — skipping this tick, retrying next tick (card 89)`);
            return { skipped: true, reason: `pin-${pinResult?.status ?? 'failed'}` };
          }
          pinned = true;
        }
        tickContext.tickRoot = cur ? cur.dir : root;
        tickResult = await tick(...args);
      } finally {
        tickContext.tickRoot = undefined;
        if (pinned) {
          try { await versionApi.unpin({ clone: vctx.clone, home: vctx.home, id: cur.id, settings: vctx.settings }); } catch { /* an orphan pin ages out */ }
        }
      }
      if (attempt === 0 && typeof hasStaleRefusal === 'function' && hasStaleRefusal(tickResult)) {
        const r2 = await rebuild();
        if (r2 && r2.moved && r2.adopted) continue;
      }
      return tickResult;
    }
  };
  // x44lnnt — the `tick-starved` smell, for EVERY daemon. Never throws.
  let lastStarvedLogAt = -Infinity;
  const checkTickStarved = () => {
    const thresholdMs = bg?.tickStarvedSmellMs ?? 0;
    if (!progress || !(thresholdMs > 0)) return;
    try {
      const nowMs = now();
      progress.markSeen(nowMs);
      if (nowMs - lastStarvedLogAt < thresholdMs) return;
      const p = progress.read() || {};
      const adoptedAt = readState(root, env)?.adopted?.at ?? null;
      const smell = tickStarvedSmell({
        lastTickDoneAtMs: Date.parse(p.lastTickDoneAt || ''), firstSeenAtMs: Date.parse(p.firstSeenAt || ''),
        lastAdoptedAtMs: Date.parse(adoptedAt || ''), nowMs, thresholdMs,
      });
      if (!smell.starved) return;
      lastStarvedLogAt = nowMs;
      const mins = Math.round(smell.sinceTickMs / 60_000);
      const asJob = rebuildAsJob;
      log.error?.(`daemon-self-sync: SMELL tick-starved — no completed tick for ${mins} min while rebuilds keep adopting (last adoption ${adoptedAt}); `
        + (asJob === false
          ? 'the inline rebuild + smoke is running instead of the tick — add this daemon to rebuildAsJob.entries in scripts/lib/daemon-rebuild-settings.json (x0m7a8x)'
          : 'the rebuild runs as a detached job, so something else blocks the tick — check the read lock, the re-clone marker and the tick itself (x0m7a8x)'));
      progress.alert('tick-starved', { sinceTickMs: smell.sinceTickMs, lastTickDoneAt: p.lastTickDoneAt ?? null, lastAdoptedAt: adoptedAt, rebuildAsJob: asJob, entry: basename(String(entries?.[0] || '')) }, nowMs);
    } catch { /* a smell never breaks a tick */ }
  };
  const markTickDone = () => { try { progress?.markTickDone(now()); } catch { /* best-effort */ } };

  // x0m7a8x — the re-clone fail-closed rule (see recloneConcluded). `knownIdentity` is the checkout this process
  // trusts: the one it booted on, or the one a concluded rebuild was seen on. A replaced checkout (identity changed)
  // with no concluded marker for it blocks — that closes the window where the rebuild JOB re-clones between this
  // tick's rebuild call and its read lock (a replacement needs the write lock, so under the read lock it is stable).
  let knownIdentity = cloneIdentity(root);
  // The last rebuild job this process saw in flight BEFORE a re-clone. It ran on the old tree, so when it finishes
  // `succeeded` it proves nothing about the fresh checkout (`staleJobIds`, see recloneConcluded).
  let lastJobInFlight = null;
  const noteJobs = (result) => {
    if (result?.job?.id && /^rebuild-job-(started|running)$/.test(String(result.reason))) lastJobInFlight = result.job.id;
  };
  const noteReclone = (why) => {
    const idNow = cloneIdentity(root);
    const cur = marker.read();
    if (cur && !cur.concluded && cur.identity === idNow && idNow != null) return;
    marker.write({
      identity: idNow, head: readHead(syncOpts()), at: new Date(now()).toISOString(), concluded: false, why,
      staleJobIds: lastJobInFlight ? [lastJobInFlight] : [],
    });
  };
  /** Must this tick run no children because the checkout is a re-clone no rebuild has concluded on? */
  const recloneBlocks = () => {
    const idNow = cloneIdentity(root);
    const m = marker.read();
    if (m && !m.concluded && (m.identity == null || idNow == null || m.identity === idNow)) return true;
    if (knownIdentity == null || idNow == null || idNow === knownIdentity) return false;
    if (m && m.concluded && m.identity === idNow) { knownIdentity = idNow; return false; }
    noteReclone('checkout-replaced');
    return true;
  };
  const recloneSkip = () => {
    log.error?.('daemon-self-sync: the clone was re-cloned and no rebuild has concluded on it yet — skipping this tick, never running children on an unsmoked checkout (x0m7a8x)');
    return skippedTick('clone-recloned');
  };

  const synced = {
    ...effects,
    // Forwards whatever arguments the caller's own tickOnce takes (e.g. runner.mjs's per-tick bookkeeping
    // payload) straight through to the wrapped `tick` — this wrapper never needs to see them itself, and
    // dropping them would silently reset a payload-threading caller's state every tick. The daemons that
    // built this helper pass a zero-arg tickOnce, so `...args` is empty for them and nothing changes.
    tickOnce: async (...args) => {
      if (resolvedPocBranch) {
        const r = syncPoc({ root, base, pocBranch: resolvedPocBranch, ...(timeoutMs != null ? { timeoutMs } : {}) });
        if (r.merged) {
          const partial = r.reason === 'merged-partial';
          log.error?.(
            `daemon-self-sync: [POC mode: ${resolvedPocBranch}] merged ${r.commits} new commit(s) — restarting onto the new code`
            + (partial ? ` (origin/${resolvedPocBranch} still conflicts — needs a hand merge)` : ''),
          );
          return onRestart(r);
        }
        if (r.reason === 'conflict' || r.reason === 'dirty' || r.reason === 'not-on-branch') {
          log.error?.(`daemon-self-sync: [POC mode: ${resolvedPocBranch}] behind but NOT syncing (${r.reason}) — needs a hand merge`);
        } else if (r.reason === 'status-failed') {
          log.error?.(`daemon-self-sync: [POC mode: ${resolvedPocBranch}] NOT syncing (status-failed) — \`git status\` failed or timed out; retrying next tick`);
        } else if (r.reason === 'fetch-failed') {
          log.error?.(`daemon-self-sync: [POC mode: ${resolvedPocBranch}] NOT syncing (fetch-failed) — both fetches failed or timed out; retrying next tick`);
        } else if (r.reason === 'count-failed') {
          log.error?.(`daemon-self-sync: [POC mode: ${resolvedPocBranch}] NOT syncing (count-failed) — \`git rev-list --count\` failed or timed out for a fetched source; retrying next tick`);
        } else if (r.reason === 'head-failed') {
          log.error?.(`daemon-self-sync: [POC mode: ${resolvedPocBranch}] NOT syncing (head-failed) — \`git symbolic-ref HEAD\` failed or timed out; retrying next tick`);
        }
        return tick(...args);
      }

      // ---- VERSIONED path (card 89 S5) — rebuild builds a version and flips `current`; NO read/write lock ----
      if (vctx) return versionedTick(args);

      // ---- DEFAULT (non-POC) path — full clone rebuild (#4044 Module E, see file header) ----

      checkTickStarved();

      // 1. Rebuild (gated: takes the WRITE lock itself). For a job-mode daemon (#4126) this is the job's fast tick
      //    side — adopt a smoke-passed candidate, else queue or watch the detached job; it never smokes here. An
      //    adopted build restarts INSTEAD of ticking — the read lock below is never even acquired for this tick.
      const rebuildResult = await rebuild();
      if (resultReportsReclone(rebuildResult)) {
        // The checkout was replaced (plain origin/main, never smoked; this process's modules and cwd are the old
        // tree's). Run no children on it until a rebuild on it concludes (x0m7a8x: persisted, shared per clone).
        noteReclone('clone-recloned');
        noteJobs(rebuildResult); // a job queued in the same call is on the FRESH tree: never stale for this marker
        log.error?.(`daemon-self-sync: the clone was re-cloned (old one kept at ${rebuildResult?.quarantinedTo ?? '?'}) — skipping this tick; no children run until a rebuild on the fresh clone concludes`);
        return skippedTick('clone-recloned');
      }
      noteJobs(rebuildResult);
      const m = marker.read();
      if (m && !m.concluded) {
        // Compare-before-write: the marker is shared per clone, so a sibling daemon may have written a NEWER
        // unconcluded marker (a later re-clone) since `m` was read — never mark that one concluded. (The identity
        // check in recloneBlocks is the backstop: a concluded marker naming another checkout re-blocks.)
        const fresh = recloneConcluded(rebuildResult, m, readHead(syncOpts()), { asJob: rebuildAsJob }) ? marker.read() : null;
        if (fresh && !fresh.concluded && fresh.at === m.at && fresh.identity === m.identity) {
          const idNow = cloneIdentity(root);
          marker.write({ ...m, identity: m.identity ?? idNow, concluded: true, concludedAt: new Date(now()).toISOString(), concludedBy: rebuildResult?.reason ?? (rebuildResult?.adopted ? 'adopted' : null) });
          if (idNow != null && (m.identity == null || m.identity === idNow)) knownIdentity = idNow;
          log.error?.(`daemon-self-sync: a rebuild on the re-cloned checkout concluded (${rebuildResult?.reason ?? 'adopted'}) — ticking again (x0m7a8x)`);
        }
      }
      if (rebuildResult && rebuildResult.moved && rebuildResult.adopted) {
        if (restartGate(rebuildResult.head, { minIntervalMs: swapMinIntervalMs }).restart) {
          log.error?.(`daemon-self-sync: rebuilt the clone onto ${rebuildResult.head} — restarting onto the new code (#4044)`);
          return onRestart(rebuildResult);
        }
      } else if (rebuildResult && rebuildResult.reason && rebuildResult.reason !== 'up-to-date') {
        // Said once per reason (and per job), not every tick: a job in flight answers `rebuild-job-running` for the
        // whole smoke.
        const key = `${rebuildResult.reason}:${rebuildResult.job?.id ?? ''}`;
        if (key !== lastNoMoveKey) {
          lastNoMoveKey = key;
          log.error?.(`daemon-self-sync: rebuild did not move the clone (${rebuildResult.reason}${rebuildResult.job?.id ? ` ${rebuildResult.job.id}` : ''}) — ticking on the current code`);
        }
        // Smell (writer starvation, live 2026-10-06): the clone has been stuck while main moved on.
        try {
          const nowMs = now();
          if (nowMs - lastStuckLogAt >= cloneStuckSmellMs) {
            const smell = cloneStuckSmell({
              adopted: readState(root, env)?.adopted,
              originMain: readOriginRef({ ...syncOpts(), ref: `origin/${base}` }),
              nowMs,
              thresholdMs: cloneStuckSmellMs,
            });
            if (smell.stuck) {
              lastStuckLogAt = nowMs;
              log.error?.(`daemon-self-sync: SMELL clone-stuck — the clone has not moved for ${Math.round(smell.ageMs / 60_000)} min while origin/${base} moved on (last rebuild: ${rebuildResult.reason}); merged fixes and overlays are not reaching this daemon — check \`node scripts/lib/daemon-clone-lock.mjs status --clone=${root}\``);
            }
          }
        } catch { /* a smell never breaks a tick */ }
      }
      // Cheap pre-lock re-clone check; the one that counts is re-run UNDER the read lock below.
      if (recloneBlocks()) return recloneSkip();

      // A stale refusal gets one immediate re-discovery after a successful gated rebuild.
      // Never reuse the old plan (some reviews may already have started), and never loop
      // indefinitely if main moves again. Imported changes must restart without the
      // ordinary restart debounce: retrying in the old process would use stale modules.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // 2. Acquire the READ lock — refused (a writer, possibly a sibling process's rebuild, is active) means
        //    skip this tick entirely rather than ever read a tree mid-move.
        let acquired = acquireRead(root, { ...cloneLockOpts(), readerKey });
        if (!acquired.ok && readerPriorityAfter > 0 && acquired.starved >= readerPriorityAfter) {
          // Starvation smell + reader priority: every writer still draining now backs off (it has moved nothing
          // yet), so wait a bounded moment for the slot instead of losing yet another tick.
          log.error?.(`daemon-self-sync: reader starved — read refused ${acquired.starved} consecutive time(s) (writer ${acquired.heldBy ?? '?'}); claiming reader priority, waiting up to ${Math.round(priorityWaitMs / 1000)}s for draining writers to back off (#4044 never-read-mid-move kept)`);
          const until = now() + priorityWaitMs;
          while (!acquired.ok && now() < until) {
            await sleep(PRIORITY_POLL_MS);
            acquired = acquireRead(root, { ...cloneLockOpts(), readerKey, trackStarvation: false });
          }
          if (acquired.ok) log.error?.('daemon-self-sync: starved reader got its read slot — ticking (#4044 reader priority)');
        }
        if (!acquired.ok && acquired.reason === 'writer-priority') {
          log.error?.(`daemon-self-sync: yielding this tick — writer ${acquired.heldBy ?? '?'} gave up ${acquired.writerStarved ?? '?'} consecutive time(s) waiting for in-flight ticks (since ${acquired.claimSince ?? '?'}); no new tick starts until a writer moves the clone (#4044 writer fairness)`);
          return skippedTick(acquired.reason);
        }
        if (!acquired.ok) {
          log.error?.(`daemon-self-sync: read lock refused (${acquired.reason}) — skipping this tick, never reading a tree mid-move (#4044)`);
          return skippedTick(acquired.reason);
        }
        let released = false;
        const releaseOnce = () => {
          if (released) return;
          released = true;
          releaseRead(root, cloneLockOpts());
        };

        let tickResult;
        try {
          // 2b. x0m7a8x — under the read lock the checkout cannot be replaced, so this is the authoritative re-clone
          //     check: the rebuild job may have re-cloned it since this tick's rebuild call.
          if (recloneBlocks()) { releaseOnce(); return recloneSkip(); }

          // 3. Under the read lock: a quarantined clone never runs children, never restarts onto it.
          const rebuildState = readState(root, env);
          if (rebuildState.quarantine) {
            releaseOnce();
            log.error?.('daemon-self-sync: the clone is quarantined (#4044) — skipping this tick, never running children off a rejected tree');
            return skippedTick('quarantine');
          }

          // #3383 bug 2 (unchanged in spirit) — HEAD moved since THIS process's own boot even though it never
          // did the rebuilding itself (a sibling process sharing this clone did, or a deferred swap). Safe to
          // restart unconditionally here: any HEAD change visible under the read lock is always an ADOPTED build —
          // xa4qo7n: the writer only moves `root`'s HEAD after its candidate's live smoke has already passed
          // elsewhere (unlocked), so a rejected build never lands on `root` in the first place.
          const headNow = readHead(syncOpts());
          if (bootSha != null && headNow != null && headNow !== bootSha) {
            // The swap — at a tick boundary, at most once per swapMinIntervalMs for the listed daemons (x44lnnt).
            const d = restartGate(headNow, { urgent: attempt > 0, minIntervalMs: swapMinIntervalMs });
            if (d.restart) {
              releaseOnce();
              log.error?.(`daemon-self-sync: HEAD moved from ${bootSha} to ${headNow} since this process booted (an adopted rebuild) — restarting onto the new code (#4044)${swapSpaced ? ' — swap between ticks (x44lnnt)' : ''}`);
              return onRestart({ merged: false, commits: 0, reason: 'head-moved', headSha: headNow });
            }
          }

          // 4. Run the real tick under the read lock.
          tickResult = await tick(...args);
          markTickDone();
        } finally {
          releaseOnce();
        }

        // 5. #3383 bug 1 (unchanged in spirit) — this SAME tick's own result shows it hit the stale-main refusal
        //    (origin/main moved mid-tick). Rebuild IMMEDIATELY (never a raw merge) rather than wait out the rest
        //    of `intervalMs` to lose the same race again — always AFTER the read lock above is released. For a
        //    job-mode daemon this adopts a ready candidate or queues the job; it never smokes on the tick path.
        if (attempt === 0 && typeof hasStaleRefusal === 'function' && hasStaleRefusal(tickResult)) {
          const r2 = await rebuild();
          if (resultReportsReclone(r2)) { noteReclone('clone-recloned'); noteJobs(r2); return tickResult; }
          noteJobs(r2);
          if (r2 && r2.moved && r2.adopted) {
            if (restartGate(r2.head, { urgent: true }).restart) {
              log.error?.(`daemon-self-sync: tick hit the stale-main refusal — rebuild adopted ${r2.head} immediately, restarting onto the new code (#3383/#4044), instead of waiting the full interval to lose the same race again`);
              return onRestart(r2);
            }
            log.error?.('daemon-self-sync: stale-main recovery adopted a build with no imported changes — retrying discovery once in this pass');
            continue;
          }
        }
        return tickResult;
      }
    },
  };
  return synced;
}
