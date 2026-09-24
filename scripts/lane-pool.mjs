#!/usr/bin/env node
/**
 * lane-pool.mjs — provision & refresh the persistent lane-clone pool for the #1933 clone-based
 * parallel batch orchestrator (slice 2).
 *
 * The #1933 model replaces guard-blocked `git worktree` isolation with N independent CLONES: each lane
 * is a full clone with its OWN HEAD (so the user-global git-branch guard, which protects the shared
 * checkout's HEAD, never fires on it), and convergence happens through the remote — a lane pushes its
 * work to a throwaway `lane/*` ref (allowed by the #1934 guard carve-out) and the central integrator
 * merges those into `main`. This script owns the *pool*: it creates/refreshes the clones the
 * orchestrator dispatches into; it does NOT dispatch, push, or merge (that's slice 3).
 *
 * Why a PERSISTENT pool (per #1933 design choice 1): re-cloning a large repo every batch is slow, so the
 * lanes are long-lived under `~/workspace/.lanes/<repo>/lane-<n>` and merely fetch + hard-reset to
 * origin/main between batches. Git OBJECTS are shared with the primary checkout via `git clone
 * --reference`, so a lane costs little disk and clones fast (objects come from the local primary, not the
 * network). Node deps (`node_modules`) are NOT shared — `ensureDeps` runs `npm ci` per lane on a fresh
 * clone or when the lockfile changes, so each lane can run its own gate.
 *
 * Repo-parameterized: the pool is keyed by repo NAME, so cross-repo slice 4 (lanes of
 * frontierui / plateau-app — the constellation) reuses this unchanged via `--repo=<checkout-path>`.
 *
 * Usage:
 *   node scripts/lane-pool.mjs provision --count=N [--acquirable] [--no-install] [--force]   # ensure N lanes exist (clone missing) + refresh all + ensure deps + ensure the WE pool's FUI render-sibling (#2166); --acquirable grows PAST foreign-leased lanes so N ACQUIRABLE ones result (#2426)
 *   node scripts/lane-pool.mjs refresh           [--no-install] [--force]     # fetch + hard-reset existing lanes to origin/main (no creation)
 *   node scripts/lane-pool.mjs status  [--json]                     # per-lane: path / head / clean / behind origin/main / deps / lease
 *   node scripts/lane-pool.mjs list    [--json] [--acquirable [--limit=N] [--no-cache] [--cache-ttl-ms=N] [--scan-timeout-ms=N]]  # existing lane paths (for the orchestrator to dispatch into); --acquirable filters out foreign-leased / busy lanes (#2426); #xn432dz: lease-first (no git in a live-leased lane), SINGLE-FLIGHT + cached for --cache-ttl-ms (env LANE_POOL_LIST_CACHE_TTL_MS, default 30000; 0 disables) so concurrent callers share one scan, --no-cache forces a fresh one, --limit=N stops at N (never cached), and the scan fails cleanly past --scan-timeout-ms (env LANE_POOL_LIST_SCAN_TIMEOUT_MS, default 120000)
 *   node scripts/lane-pool.mjs path    --lane=N                     # print one lane's absolute path
 *   node scripts/lane-pool.mjs acquire [--purpose=<slug>] [--session=<slug>] [--lane=N] [--item=NNN[,NNN…]] [--ttl-minutes=N] [--no-reset] [--no-reap] [--base=<ref>] [--scope=<repo:path,...>] [--reserve] [--wait-ms=N] [--json]  # #2275 lease a free lane (exclusive) + reset to origin/main (or, with #2386 --base=<ref>, to a predecessor lane's pushed tip); stdout = its path. #x3jmao3: auto-pick (no --lane) OPT-IN bounded retry — --wait-ms=<total> polls (ACQUIRE_POLL_MS spacing, no busy-wait) for up to that many ms before the "no free lane" failure, instead of failing on the very first full-pool reading (omitted ⇒ today's instant-fail, unchanged); a genuinely-exhausted pool still fails with the identical message once the bound elapses. #2748: BEFORE selecting, a reaper backstop reclaims any PROVABLY-DEAD ghost lease in the pool (item resolved on main, or PR merged/closed) so a finished-but-unreleased lane never blocks a fresh dispatch — the pool ACTS on the ghost the board only flags; --no-reap opts out. #2413: --purpose=workflow-lane MARKS the lease (workflowLane:true) → the guard requires a sibling to assert its minted slug before a destructive op. #2560: --scope=<repo:path,...> declares this lane's ADVISORY predicted file-scope — persisted into the marker (the live scope-lease collector reads it) + warns on overlap, but NEVER gates the acquire (the whole-clone lease is the real lock). #2616: --item=NNN records this lane's item → lane in the lane-ports registry (same as `map`) so conveyor-state's health-stall scan can flag a genuinely stalled lane — the self-serve population a conveyor delivery agent needs (nothing else calls `map` for it). #2350: --reserve (requires --lane=N) mints a PERMANENT reserved lane — no TTL, never stale, off-limits to acquire/refresh/provision (even --force); dropped only by `release --release-reserved`. #2997: EVERY acquire now mints a per-holder `holder` slug into the lease and prints it (stderr + --json `holder`) — the one signal that separates this holder from a SIBLING agent of the same session, which `ownerSession` cannot; assert it as `--session=<slug>` (release) or `LANE_SESSION=<slug>` (a destructive git op) whenever a sibling of your session also holds a live lane. #2997 r2: --adopt also stamps YOU as the lane's OCCUPANT (`workerSession`) — pass it when the process running this acquire is the one that will work in the lane, omit it when you are leasing on someone else's behalf (they run `adopt` instead).
 *   node scripts/lane-pool.mjs adopt   --lane=N [--force] [--json]   # #2997 r2 the dispatcher → worker OCCUPANCY hand-off: declare the CALLING session the agent working in lane-N (stamps `workerSession`), which is what arms guard-lane.mjs's Edit/Write refusal against every OTHER session. `ownerSession` cannot do this job — it records whoever RAN `acquire`, which for a dispatched lane is the dispatcher, not the worker. Idempotent; a lane already declared-occupied by a different LIVE session needs --force (a deliberate takeover, which names who is displaced).
 *   node scripts/lane-pool.mjs release (--lane=N | --all | --all-pools (--session=<slug> | --item=<num>)) [--session=<slug>] [--pool=<name>] [--force] [--release-reserved]   # #2275 hand a leased lane back to the pool (own lease, or --force); #2350 --release-reserved is the deliberate un-reserve for a PERMANENT reserved lane (--force alone never drops one); #2667 --all-pools --session sweeps EVERY pool under POOL_ROOT and releases that session's leases (cross-locus couple cleanup in one call), and --pool=<name> selects a pool by dir-name (no checkout path needed); #2748 --all-pools --item=<num> is the by-ITEM sweep the drain's release-on-land uses (matches every lease whose session encodes that item number — needs no exact slug); #2997 a CONTESTED lease (another live lease — in ANY pool under POOL_ROOT, per r2 — shares its ownerSession, i.e. a sibling agent of yours holds a lane) is never released on the ownerSession match alone — pass `--session=<the holder slug acquire printed>` or `--force`. A STALE lease is never contested (r2): a dead holder has nothing to prove, so an expired lease releases without --force exactly as on main.
 *   node scripts/lane-pool.mjs remove  (--lane=N | --all)           # tear down lane(s); #2350 REFUSES a reserved lane (even --all/--force) — deliberate teardown is `remove --lane=N --release-reserved`
 *   node scripts/lane-pool.mjs trim    [--max=N] [--dry-run] [--json]  # #4025 shrink the pool toward a cap (default per-repo, `LANE_POOL_TRIM_MAX` overridable): deletes HIGHEST-numbered lane dirs first among those with no live (or provably dead) lease, never reserved, nothing uncommitted beyond the scratch allowlist, and every ahead commit provably pushed — a lane with real unpushed/uncommitted work is reported, never removed. Crash-safe (rename to `.trash-<n>` then delete). Wired into `scripts/conveyor/lane-pool-health-watch.mjs`'s periodic pass.
 *   node scripts/lane-pool.mjs map     --lane=N --item=NNN[,NNN…]   # register item(s) → lane page-port (#2139 proxy)
 *   node scripts/lane-pool.mjs unmap   (--item=NNN[,…] | --lane=N | --all)   # drop lane-ports registry entries
 *
 * Repo / pool overrides (apply to any command):
 *   --repo=<path>        a checkout to derive the lane repo from (default: the cwd's git toplevel)
 *   --pool=<name>        (#2667) select a pool DIRECTLY by its dir-name under POOL_ROOT — the read/release
 *                        selector (status / list / path / release) that needs only the poolDir, no checkout path
 *                        or origin URL (e.g. release a plateau-app-pool lease from the WE checkout)
 *   --origin=<url>       clone source (default: that checkout's `origin` remote URL)
 *   --reference=<path>   object-sharing reference repo for `git clone --reference` (default: --repo path)
 *   --name=<slug>        pool key under the root (default: derived from the origin URL basename)
 *   --branch=<ref>       integration branch (default: detected origin/HEAD, else `main`)
 *   env LANE_POOL_ROOT   pool root (default: ~/workspace/.lanes)
 *
 * SAFETY (#2267): a lane is safe scratch ONLY for work that is clean-and-up-to-date, or that this guard
 * has skipped. `refresh`/`provision` never silently discard a lane that is DIRTY (uncommitted edits) or
 * AHEAD of origin/<branch> (locally-committed-but-unpushed commits) — such a lane is SKIPPED (left
 * untouched) and reported, because `reset --hard` + `clean -fd` would otherwise destroy that work with no
 * recovery. Pass --force to restore the old unconditional reset-everything behavior for a dirty/ahead lane.
 * The only state a lane can rely on surviving a concurrent refresh/provision is what has ALREADY been
 * pushed to origin (i.e. landed via `pr-land` onto its `lane/*` ref, per #1934) — treat anything else as
 * ephemeral and push early.
 *
 * SAFETY (#2275/#2337): a LIVE lease (an exclusive hold stamped by `acquire`, presumed alive within TTL) is
 * a STRONGER guard than dirty/ahead — it protects an active consumer, not just tree residue. `--force`
 * overrides the dirty/ahead staleness guard but NEVER a live lease: `refresh --force` / `provision --force`
 * SKIP a live-leased lane with a loud log (never reset it); `acquire --lane=N --force` on a live-leased lane
 * HARD-FAILS, pointing at the deliberate override — `release --force` (drop the lease), then re-acquire. No
 * separate `--force-lease` flag exists; `release --force` is the one escape hatch for a live lease.
 *
 * SAFETY (#2350): a RESERVED lease (`acquire --reserve --lane=N`) is STRONGER still than a live lease — it is a
 * PERMANENT hold with no TTL that never goes stale, so it is off-limits to acquire (auto-pick skips it; an
 * explicit `acquire --lane=N` HARD-FAILS on it, even with `--force`) AND to `refresh`/`provision` `reset --hard`
 * (skipped forever, even with `--force`). It is the dedicated persistent memory-lane primitive (#2301/#2350):
 * a durable slot the running session can write through without a lane→PR round-trip, kept off the primary
 * checkout and off the recyclable pool. `--force` NEVER drops it; the ONE deliberate un-reserve is
 * `release --lane=N --release-reserved`. (NOTE: this script only PROVISIONS the reserved lane; the live repoint
 * of the machine-global `~/.claude/…/memory` symlink at it is the SUPERVISED, human-gated half of #2350.)
 */
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, lstatSync, statSync, renameSync, readdirSync, linkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join, basename, resolve, dirname, sep } from 'node:path';
import { resolveReal } from './guard-lane.mjs';
import { guardedPoolRoot, referenceArgs } from './lib/lane-pool-paths.mjs';
import {
  LEASE_FILENAME,
  DEFAULT_LEASE_TTL_MINUTES,
  WORKFLOW_LANE_PURPOSE,
  isLeaseStale,
  isReservedLease,
  isLaneAcquirable,
  leaseDisqualifiesAcquire,
  chooseFreeLane,
  ownLaneNumber,
  leaseBody,
  describeLease,
  leaseOwnedBy,
  leaseOwnedByCaller,
  laneHolderSlug,
  laneWorkerSession,
  isContestedLease,
  isTransientRefLockError,
} from './lib/lane-lease.mjs';
// #2560 — lane-pool may freely import readiness (confirmed no circular import): the advisory scope-lease check
// at acquire. normScope normalizes the declared `--scope`; candidateLaunch is the pure overlap-at-launch query.
import { normScope } from './readiness/scope-lease.mjs';
import { candidateLaunch } from './readiness/scope-lease-live.mjs';
// #x3jmao3 — the SAME non-busy-wait spin-poll primitive `withNumberingLock` already uses to space its own
// spin-acquire (`we:scripts/readiness/drain-lock.mjs`), reused rather than re-implemented, for `acquire`'s
// own optional `--wait-ms` full-pool retry/backoff below. No cycle: drain-lock.mjs never imports lane-pool.
import { sleepSyncMs } from './readiness/drain-lock.mjs';
// #2748 — REUSE the standalone reaper's PURE core so the "provably-dead lease" verdict is SINGLE-SOURCED with
// `scripts/conveyor/lease-reaper.mjs` (the acquire-native backstop must agree with the periodic reaper, never
// fork its logic). Importing lease-reaper is side-effect-free — its IO shell is gated on the main-module check —
// and forms no cycle (lease-reaper imports only `lib/lane-lease.mjs`, never lane-pool). `readField` reads the
// frontmatter-strict `status:` for the offline item-resolved reap axis (#2603 spoof-safe reader).
import { classifyReap, reapPlan, prStatesFromList, itemNumFromSession } from './conveyor/lease-reaper.mjs';
import { readField } from './backlog/frontmatter.mjs';
// #3383 — the lane-history ledger (`<lane>/.git/lane-history.jsonl`): one line per acquire/adopt/release/reap,
// so a lane can be traced back to the session/card/PR that used it AFTER its lease is released (today nothing
// records that — see `scripts/lane-whois.mjs`, the reader). Lives in its OWN module (another worker owns this
// file for PR #2606 concurrently) — the four call sites below are the only hook points.
import { appendLaneHistory, laneHistoryEntry } from './lib/lane-history.mjs';
// #3568 — the shared known-safe-scratch-litter allowlist + cleanup core, reused verbatim by the periodic
// `we:scripts/conveyor/lane-pool-health-watch.mjs` pass so the two never diverge into two separately-maintained
// lists. Side-effect-free at import (no top-level dispatch), like every other `./lib/*.mjs` import above.
// #3383 — `planLitterCleanup` (PURE) is ALSO reused directly by this file's own `litterAdjustedDirty` below,
// the acquire-time twin of `cleanLaneLitter`'s release-time cleanup — same allowlist, same verdict, never a
// second hand-rolled classifier.
import { cleanLaneLitter, planLitterCleanup } from './lib/lane-litter.mjs';
// #x5n4zn3 — the SAME shared budget policy `we:scripts/lib/bounded-child.mjs`'s async `runBounded` rollout
// uses elsewhere (dispatch-plan.mjs's collectors), reused here for its CONSTANTS only (`resolveChildTimeoutMs`
// / the `WE_CHILD_TIMEOUT_MS` env knob), NOT its async primitive — see the `git`/`gitQuiet` header comment
// below for why this file deliberately stays synchronous.
import {
  resolveChildTimeoutMs, NPM_INSTALL_TIMEOUT_MS, NETWORK_GIT_TIMEOUT_MS as SHARED_NETWORK_GIT_TIMEOUT_MS,
} from './lib/bounded-child.mjs';

// #2560 — `--scope=a,b,c` → a normalized, repo-qualified array (empty when the flag is absent/blank).
const parseScopeFlag = (v) => (typeof v === 'string' && v ? normScope(v.split(',')) : []);

// ── tiny arg parsing ──────────────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
const flags = {};
const positionals = [];
for (const a of rest) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  } else positionals.push(a);
}

// ── git helpers (throw-on-error wrappers) ───────────────────────────────────────────────────────────
// `opts` merges into execFileSync's options (e.g. `{ timeout: 20_000 }`) — needed by callers that must
// never let a slow/hung git call stall a dispatch acquire, matching the adjacent `gh` call's timeout. 20s,
// not the original 8s: under real concurrent host load a trivial child (even one that ultimately errors
// fast, like `gh` against a non-GitHub origin) can take multiple seconds just to be scheduled, and an
// 8s bound fired with no hang present — silently degrading the reap axis and flaking
// lane-pool-reap-on-acquire.test.mjs red twice on 2026-08-30 (#x01b2gj, mirrors #3011's precedent exactly).
// #xn432dz — READ-ONLY git calls run with `GIT_OPTIONAL_LOCKS=0`. Without it `git status` opportunistically
// takes `index.lock` and REWRITES `.git/index` to refresh stat info — a write per lane per scan, which (with 14
// concurrent `list --acquirable` scans over ~129 lanes, 2026-09-23) fed fseventsd enough events to pin it at
// ~100% CPU. The allowlist is by subcommand so a MUTATING call (fetch/reset/clean/checkout/clone) never gets
// it — optional locks are exactly what a mutating command must keep. `remote` only counts for `get-url`.
const READ_ONLY_GIT = new Set(['status', 'rev-list', 'rev-parse', 'for-each-ref', 'ls-remote', 'cherry', 'ls-tree', 'show', 'symbolic-ref', 'merge-base', 'log', 'cat-file']);
const isReadOnlyGit = (args) => READ_ONLY_GIT.has(args[0]) || (args[0] === 'remote' && args[1] === 'get-url');
const readOnlyGitEnv = (args) => (isReadOnlyGit(args) ? { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } } : {});
// #xn432dz — while a bounded `list --acquirable` scan runs, every git child is capped at the scan's REMAINING
// budget, so one hung git can't outlive the overall timeout. A killed child reads as `null` through `tryGit`,
// which some probes read fail-OPEN (e.g. porcelain null ⇒ "clean") — so the scan loop re-checks the deadline
// after every lane and FAILS the whole scan rather than trusting a result produced past it. An explicit
// per-call `timeout` (ls-remote's 20s) still wins. Null outside a scan ⇒ no cap, today's behaviour.
let scanDeadlineMs = null;
const scanTimeoutOpt = () => (scanDeadlineMs === null ? {} : { timeout: Math.max(1, scanDeadlineMs - Date.now()) });
// #x5n4zn3 — the 2026-09-23 incident (#3383): `list --acquirable` (and, worse, `acquire`/`refresh`/`provision`,
// none of which ever set `scanDeadlineMs`) could shell a `git` call with NO timeout at all outside an explicit
// scan, and a stuck one (typically the network transport underneath `fetch`/`ls-remote`, never plain local
// plumbing) ran for up to an hour, burning a whole 45-minute drain pass. EVERY `git()`/`gitQuiet()` call now
// gets a hard DEFAULT ceiling — `resolveChildTimeoutMs()` (5 min, env `WE_CHILD_TIMEOUT_MS`) for the fast local
// plumbing this file mostly does, `NETWORK_GIT_TIMEOUT_MS` (10 min) for the few genuinely network-bound calls
// (fetch/clone) that pass it explicitly — so a hung child fails FAST instead of eating the caller's whole pass.
// `scanTimeoutOpt()`'s shrinking scan-remaining budget and any caller-supplied `opts.timeout` still win when
// smaller (spread last), so this never widens `list --acquirable`'s existing bound, only backstops every OTHER
// command that had none.
//
// DELIBERATELY NOT the async `runBounded` rollout `we:scripts/lib/bounded-child.mjs` also ships (used verbatim
// in `we:scripts/readiness/dispatch-plan.mjs`): `git`/`tryGit`/`gitQuiet` are called from ~40 sites across
// nearly every command in this 2000+ line file (acquire/release/provision/refresh/status/list), so switching
// them to async would ripple `async`/`await` through almost the whole file — exactly the "keep the diff to the
// spawn call sites only" scope #x5n4zn3 was told to respect, since #x3xz8qp is concurrently adding spawn-COUNT
// regression tests over these SAME loops (`aheadIsProvablyPushed`, `cherryAllPatchEquivalent`,
// `otherRemoteHeadsPatchEquivalentBatched`) and a whole-file rewrite here would collide with that work for no
// gain (this file's callers are direct CLI invocations, not a hung-child-inside-a-bigger-async-pass the way
// `dispatch-plan.mjs`'s collectors are).
//
// ACCEPTED RESIDUAL, stated rather than hidden: `execFileSync`'s native `timeout`/`killSignal` kills only the
// immediate `git` pid, not a whole process GROUP the way `runBounded`'s `detached: true` + negative-pid kill
// does — a `git-remote-https`/`ssh` transport helper `git` itself forked could in principle survive past the
// timeout. Every OUTER caller that shells THIS whole script as a child (`we:scripts/readiness/dispatch-plan.mjs`
// via `runBounded`, itself `detached: true`) still reaps that residual case at the process-group level, because
// this script's own `git` children land in the SAME group as the outer `node lane-pool.mjs` process.
// Shared with `resolveLaneAcquireTimeoutMs`, so an outer wrapper around `acquire` is never tighter than this.
const NETWORK_GIT_TIMEOUT_MS = SHARED_NETWORK_GIT_TIMEOUT_MS;
const defaultGitTimeoutOpt = () => ({ timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
const git = (args, cwd, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...defaultGitTimeoutOpt(), ...readOnlyGitEnv(args), ...scanTimeoutOpt(), ...opts }).trim();
const gitQuiet = (args, cwd, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'], timeout: NETWORK_GIT_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts });
const tryGit = (args, cwd, opts = {}) => {
  try {
    return git(args, cwd, opts);
  } catch {
    return null;
  }
};

// Live-fire dispatch test, 2026-08-29: `git fetch origin --prune` crashed `provision`/`acquire` outright —
// "error: cannot lock ref '<ref>': is at X but expected Y" — a transient race over the SHARED object store
// every lane clones `--reference` (two lanes' fetches touching the same `refs/remotes/origin/*` at once).
// On a host running several concurrent sessions this is ORDINARY contention, not a real failure, yet it was
// an uncaught throw that aborted the whole batch — and `acquire`'s OWN fetch (this same call) is the very
// FIRST git command a dispatched delivery agent's brief runs, so an unlucky race there crashed the agent
// before it ever reached `lane-pool acquire`'s own retry-free call. Retry a FEW times with a short backoff,
// matching only this specific ref-lock signature — any other fetch failure (network down, bad remote) still
// throws immediately, unretried, exactly as before.
const FETCH_LOCK_RETRY_ATTEMPTS = 4;
const FETCH_LOCK_RETRY_BASE_MS = 250;
function blockingSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); } catch { /* env without SAB — skip the wait */ }
}
function fetchOriginPruneWithRetry(dir) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return git(['fetch', 'origin', '--prune', '--quiet'], dir, { timeout: NETWORK_GIT_TIMEOUT_MS });
    } catch (e) {
      const msg = String(e?.stderr || e?.message || e);
      if (!isTransientRefLockError(msg) || attempt >= FETCH_LOCK_RETRY_ATTEMPTS) throw e;
      blockingSleep(FETCH_LOCK_RETRY_BASE_MS * attempt);
    }
  }
}

const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// #3265 — the pool root is DERIVED from the checkout, not assumed from `$HOME`. Pure core + its
// rationale live in `./lib/lane-pool-paths.mjs` (this file runs its CLI at import, so nothing here is
// unit-testable by importing it).
// The checkout ROOT, not the cwd: `defaultPoolRoot` is pure and cannot tell `<checkout>/scripts` from
// `<checkout>`, so handing it a subdirectory would put the pool INSIDE the repo (#1539 reviewer, round 2).
// A lane needs no normalising — `workspaceFor` strips at `.lanes` from any depth — but this is the honest
// input either way. Falls back to the cwd outside a git repo, where there is nothing better to say.
// #x5n4zn3 — a purely-local read (no network) that runs on EVERY invocation, before any command dispatch: a
// short, tight budget (not the generic 5-min default) so a wedged git config/index never stalls the CLI at
// startup. `Math.min` with `resolveChildTimeoutMs()` so the SAME `WE_CHILD_TIMEOUT_MS` env override that tunes
// every other call in this file (and a test wanting a fast bounded-hang proof) also tunes this one, while a
// production run with no override still gets the tighter 15s ceiling, not the generic 5-minute default.
const LOCAL_GIT_TIMEOUT_MS = Math.min(resolveChildTimeoutMs(), 15_000);
const CHECKOUT_ROOT = tryGit(['rev-parse', '--show-toplevel'], process.cwd(), { timeout: LOCAL_GIT_TIMEOUT_MS }) || process.cwd();
// #3383 — `guardedPoolRoot` (not the bare `defaultPoolRoot`) so a vitest run that spawns this CLI for real with
// no pool-root override fails LOUDLY and immediately, instead of quietly hammering the shared real pool (see
// that function's own header for the incident this closes). `fail` is a hoisted function declaration further
// down this file, so it's callable here.
let POOL_ROOT;
try {
  POOL_ROOT = guardedPoolRoot(CHECKOUT_ROOT);
} catch (e) {
  // `fail` calls `process.exit(1)`, which does not itself unwind JS execution — the `throw` right after is a
  // belt-and-suspenders stop so nothing below this line ever runs against an undefined POOL_ROOT in the window
  // before the process actually terminates.
  fail(String(e.message || e));
  throw e;
}

// ── repo descriptor resolution ──────────────────────────────────────────────────────────────────────
function resolveRepo() {
  const repoPath = resolve(expandHome(flags.repo) || process.cwd());
  const referencePath = resolve(expandHome(flags.reference) || repoPath);
  const topLevel = tryGit(['rev-parse', '--show-toplevel'], referencePath, { timeout: LOCAL_GIT_TIMEOUT_MS }) || referencePath;
  const originUrl = flags.origin || tryGit(['remote', 'get-url', 'origin'], topLevel, { timeout: LOCAL_GIT_TIMEOUT_MS });
  // #2667 — `--pool=<name>` selects a pool DIRECTLY by its directory name under POOL_ROOT, bypassing origin-URL
  // derivation. It is the pool selector for the READ / RELEASE ops (status / list / path / release) that need
  // only `poolDir` — e.g. the main session releasing a cross-locus couple's lingering lease in the `plateau-app`
  // pool from the WE checkout, without needing a plateau-app checkout path. When `--pool` names the pool an
  // undeterminable origin URL is NOT fatal (these ops never clone). `acquire`/`provision`/`refresh` still need a
  // real origin, and hit the same guard at use (`cloneLane` throws on a null origin) — so the fail just moves
  // from resolve-time to the op that actually needs it, keeping the read/release selector usable without one.
  const explicitPool = typeof flags.pool === 'string' && flags.pool ? flags.pool : null;
  if (!originUrl && !explicitPool) {
    fail(`could not determine an origin URL — pass --origin=<url> (looked in ${topLevel})`);
  }
  const name = explicitPool || flags.name || basename(originUrl).replace(/\.git$/, '');
  // Default integration branch: the reference's origin/HEAD if known, else `main`.
  const head = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], topLevel, { timeout: LOCAL_GIT_TIMEOUT_MS });
  const branch = flags.branch || (head ? head.replace(/^origin\//, '') : 'main');
  return { name, originUrl: originUrl || null, referencePath: topLevel, branch, poolDir: join(POOL_ROOT, name) };
}

const laneDir = (repo, n) => join(repo.poolDir, `lane-${n}`);

/**
 * Is this checkout a shallow clone? Returns `null` when the probe itself fails, which `referenceArgs` reads as
 * "not proven shallow" — degrading to today's behaviour rather than dropping object sharing on a failed `git`.
 */
const isShallowRepo = (dir) => {
  const out = tryGit(['rev-parse', '--is-shallow-repository'], dir);
  return out === null ? null : out === 'true';
};

/** #3265 — the DECISION is pure and lives in `./lib/lane-pool-paths.mjs`; this just supplies the probe. */
const cloneReferenceArgs = (p) => referenceArgs(p, isShallowRepo(p));

// ── per-lane dev-server ports (#1997, per #1996 Fork 2) ──────────────────────────────────────────────
// A lane boots its own `npm run dev` on a deterministic per-index port pair, so N clones never collide.
// The formula is a PURE function of the lane index (no free-port scan, no registry — the pool index IS
// the allocator, #1996 Fork 2(a)): index N → BAND_BASE + 100 + N*10. The primary checkout keeps the band
// base (e.g. WE's 3000/8080 — the human's `npm start`). Config reads these via `.env.local` (vite.config
// reads `process.env`, the dev script reads `${WE_*_PORT:-default}`), with `strictPort` so a squatted
// port fails loud rather than silently binding the next one (which would desync the 11ty proxy target).
//
// Per-repo bands (#1996): WE `3000`/`8080`; plateau-app `4000`; FUI `6000`/`6080`. Only repos whose dev
// servers are env-driven need an entry here; a repo with no band writes no `.env.local` (harmless no-op).
const PORT_BANDS = {
  'web-everything': { WE_VITE_PORT: 3000, WE_ELEVENTY_PORT: 8080 },
  webeverything: { WE_VITE_PORT: 3000, WE_ELEVENTY_PORT: 8080 },
};
function laneEnvLocal(repo, n) {
  const band = PORT_BANDS[repo.name];
  if (!band) return null; // repo has no env-driven dev band → nothing to generate
  const body = Object.entries(band)
    .map(([key, base]) => `${key}=${base + 100 + n * 10}`)
    .join('\n');
  return (
    `# Generated by scripts/lane-pool.mjs (#1997) — deterministic per-lane dev-server ports.\n` +
    `# Lane ${n} of pool "${repo.name}"; regenerated on provision/refresh, do not edit by hand.\n` +
    body +
    '\n'
  );
}
// Write AFTER refreshLane's `git clean -fd` (which would otherwise remove this untracked file). `.env.local`
// is git-ignored so a lane never commits it.
function writeLaneEnv(repo, n) {
  const contents = laneEnvLocal(repo, n);
  if (contents === null) return;
  writeFileSync(join(laneDir(repo, n), '.env.local'), contents);
}

// ── constellation sibling clones for the WE pool (#2166 → #2282 → #2349) ─────────────────────────────
// Every WE grid page SSRs through the pinned FUI build-artifact, resolved by
// `scripts/lib/component-render-build-hook.cjs` at the FIXED relative path `../frontierui/dist/tools/
// component-render/cli.mjs` — i.e. a `frontierui` checkout SIBLING of the WE repo root. In the primary
// checkout that sibling is `~/workspace/frontierui`; but a lane clone lives at `<poolDir>/lane-N`, whose
// parent (`<poolDir>`) has no `frontierui` — so `build:docs` / `eleventy --serve` / any rendered
// verification HARD-FAILS in a solo/interactive WE lane ("pinned FUI artifact missing"). The #1943
// orchestrator only provisions per-repo pools for items whose *impl* spans FUI; this render dependency is
// UNCONDITIONAL (independent of whether the edited item touches FUI), so it can't be gated behind that
// affected-repo detection — the pool itself must carry the sibling. A plain `plateau-app` sibling similarly
// un-breaks a lane's Vite dev-panel import (`vite.config.mts` → `../plateau-app/…`).
//
// Original fix (#2166): a SYMLINK at `<poolDir>/frontierui` to the primary checkout's real `frontierui`
// sibling. Ratified in #2282 (docs/agent/platform-decisions.md#pool-siblings-real-built-clones) and
// generalized here (#2349): the pool-root sibling is now a REAL, PUSHABLE git clone, not a symlink — one
// clone per sibling repo serves BOTH consumers at the same `../<name>` path a lane resolves — WE-lane
// render reads its BUILT `dist/`, and the drain's cross-repo rebase-drop (`merge-ai-prs.mjs`
// `siblingCloneDir`, unchanged — it already resolves `../<name>`) fetches/pushes its `origin`. Safe to
// share: rebase-drop is pure git plumbing (merge-tree → commit-tree → push, no checkout), so it only
// mutates git objects/refs — disjoint from render's `dist/` reads. The symlink's one lost behavior: render
// no longer reflects the primary checkout's uncommitted FUI WIP, only its committed `main` — freshness
// ownership moves to this provisioner, which rebuilds `dist/` (via the sibling's own `build:tools`, where
// it has one — frontierui does, plateau-app doesn't) on every provision/refresh.
//
// Idempotent: a clean, up-to-date clone is fetched + fast-forwarded + rebuilt (cheap — ~1.2s for FUI); a
// missing clone is created (`--reference` the primary sibling for fast local object-sharing, same pattern
// as `cloneLane`); a legacy pre-#2282 symlink is replaced with a real clone; a DIRTY or AHEAD clone (like a
// lane, #2267) is left untouched rather than reset-away, since it is now real, pushable, mutable state.
// Only the WE pool (identified by a PORT_BANDS entry — the same signal that marks the env-driven dev band)
// provisions siblings; other pools no-op. If the primary sibling is absent (no local checkout to derive an
// origin URL from) we WARN (not fail) — the pool is still usable for non-render work.
const SIBLING_REPO_NAMES = ['frontierui', 'plateau-app'];

function primarySiblingPath(repo, name) {
  // A sibling repo is the sibling of the PRIMARY WE checkout (the pool's reference repo), e.g.
  // ~/workspace/webeverything → ~/workspace/frontierui / ~/workspace/plateau-app.
  return join(dirname(repo.referencePath), name);
}

function siblingHasBuildTools(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return !!(pkg && pkg.scripts && pkg.scripts['build:tools']);
  } catch {
    return false;
  }
}

function buildSibling(dir, name) {
  if (!siblingHasBuildTools(dir)) return; // e.g. plateau-app — a plain clone is enough (#2282)
  // A sibling with a `build:tools` needs its OWN `node_modules` first: the clone is `--reference`d
  // (shared git objects, NOT node_modules) and FUI's build-tools.mjs statically `import esbuild` + runs
  // `npx tsc`, so on a fresh clone it throws ERR_MODULE_NOT_FOUND before it can emit `dist/`. Install deps
  // exactly as WE lanes do (idempotent via the .git deps marker → no reinstall on a warm refresh, #2349).
  try {
    ensureDeps(dir);
  } catch (e) {
    log(`  ⚠ ${name} sibling deps install failed — build:tools will likely fail too (${e.message})`);
  }
  log(`  building ${name} sibling (npm run build:tools) …`);
  try {
    // #x5n4zn3 — generous (a real build), but never unbounded: a wedged build must fail this ONE sibling, not
    // hang the whole `provision`/`refresh` pass.
    execFileSync('npm', ['run', 'build:tools'], { cwd: dir, stdio: 'inherit', timeout: NPM_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch (e) {
    log(`  ⚠ ${name} sibling build:tools failed — WE-lane render may see a stale/missing dist/ (${e.message})`);
  }
}

function ensureOneSibling(repo, name, { force = false } = {}) {
  const dest = join(repo.poolDir, name);
  const primary = primarySiblingPath(repo, name);

  // Replace a pre-#2282 render-only symlink (or any other symlink) with a real clone.
  let existing = null;
  try {
    existing = lstatSync(dest);
  } catch {
    existing = null;
  }
  if (existing && existing.isSymbolicLink()) {
    rmSync(dest, { force: true });
    existing = null;
    log(`  replacing legacy ${dest} symlink with a real pushable clone (#2282)`);
  }

  if (existing && !existsSync(join(dest, '.git'))) {
    // A real dir/file squats the sibling path that isn't a git repo — don't clobber it.
    log(`  ⚠ ${dest} exists and is not a git clone — leaving it; ${name} sibling not (re)provisioned.`);
    return;
  }

  if (!existing) {
    const originUrl = existsSync(primary) ? tryGit(['remote', 'get-url', 'origin'], primary) : null;
    if (!originUrl) {
      log(
        `  ⚠ ${name} sibling source ${primary} not found/has no origin — WE lane build:docs/dev-serve or ` +
          `the drain's cross-repo rebase-drop will skip ${name} until it is present.`,
      );
      return;
    }
    const ref = cloneReferenceArgs(primary);
    log(`  clone ${name} sibling ← ${originUrl} ${ref.length ? `(--reference ${primary})` : '(no --reference: shallow)'} …`);
    try {
      gitQuiet(['clone', '--quiet', ...ref, originUrl, dest]);
    } catch (e) {
      // Unlike the old symlink (pure filesystem, no network), this is a real `git clone` of `originUrl` —
      // best-effort: a network blip / auth failure / moved remote must WARN and move on, not crash the
      // whole provision/refresh (which would otherwise abort AFTER every WE lane already succeeded, #2349).
      log(`  ⚠ ${name} sibling clone failed — WE lane build:docs/dev-serve or the drain's cross-repo ` + `rebase-drop will skip ${name} until it is provisioned (${e.message})`);
      rmSync(dest, { recursive: true, force: true }); // don't leave a partial/broken clone behind
      return;
    }
  }

  const branchRef = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dest);
  const branch = branchRef ? branchRef.replace(/^origin\//, '') : 'main';
  tryGit(['fetch', 'origin', '--prune', '--quiet'], dest, { timeout: NETWORK_GIT_TIMEOUT_MS });

  if (!force) {
    // #2267-style data-loss guard, now load-bearing here too: this clone is real & pushable (unlike the
    // #2166 symlink it replaces), so an unconditional reset/clean could destroy in-flight local state.
    const { dirty, ahead } = laneDirtyOrAhead(dest, branch);
    if (dirty || ahead > 0) {
      log(`  ${name} sibling: SKIPPED reset (dirty/ahead) — use --force to override; skipping rebuild too`);
      return;
    }
  }

  tryGit(['checkout', '--quiet', '-B', branch, `origin/${branch}`], dest);
  tryGit(['reset', '--hard', `origin/${branch}`, '--quiet'], dest);
  tryGit(['clean', '-fd', '--quiet'], dest);
  buildSibling(dest, name);
}

function ensureRepoSiblings(repo, opts = {}) {
  if (!PORT_BANDS[repo.name]) return; // not the WE pool → no unconditional sibling dependency
  for (const name of SIBLING_REPO_NAMES) ensureOneSibling(repo, name, opts);
}

// ── lane-ports registry (#2139) — item → lane page-port mapping for the main-checkout proxy ─────────
// The primary checkout's Vite server (vite.config.mts `lanePageProxy`) keeps `:3000` the single review
// URL by forwarding a lane-claimed item's `/backlog/<NNN>…/` page to the owning lane's dev server. The
// mapping lives in `.claude/lane-ports.json` in the PRIMARY checkout (the pool's reference repo): the
// dispatcher `map`s an item when it assigns it to a lane, and entries are cleared on `unmap`, lane
// `remove`, and `refresh` (a reset lane no longer renders the item). Only pools with a PORT_BANDS entry
// have page ports; `map` on a band-less pool fails loud.
const registryPath = (repo) => join(repo.referencePath, '.claude', 'lane-ports.json');
function lanePagePort(repo, n) {
  const band = PORT_BANDS[repo.name];
  if (!band) return null;
  const [, base] = Object.entries(band)[0]; // first band key is the repo's front-door (Vite) port
  return base + 100 + n * 10;
}
function readPortRegistry(repo) {
  const file = registryPath(repo);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function writePortRegistry(repo, entries) {
  const file = registryPath(repo);
  mkdirSync(join(repo.referencePath, '.claude'), { recursive: true });
  writeFileSync(file, JSON.stringify(entries, null, 2) + '\n');
}
function unmapLanes(repo, lanes) {
  const entries = readPortRegistry(repo);
  // #3466 round 2 — match by lane NUMBER **and** the entry's own `repo` field, never lane number alone: two
  // different pools sharing a lane number (a pool's index space is per-pool, #1996) are NOT the same lane, and
  // `registerItemsToLane` always stamps `repo: repo.name` on every entry it writes, so this is available on
  // every entry an unmap can legitimately be asked to drop. Without this, an unmap scoped to one pool (a reset,
  // a release, an acquire's pre-clear) could silently delete a DIFFERENT, still-live item's entry in another
  // pool purely because both happen to reuse the same lane number — reproduced live via the acquire-time
  // pre-clear path in lane-pool-release-item-map.test.mjs.
  const dropped = Object.keys(entries).filter((num) => lanes.includes(entries[num].lane) && entries[num].repo === repo.name);
  if (dropped.length === 0) return;
  for (const num of dropped) delete entries[num];
  writePortRegistry(repo, entries);
  log(`  unmapped item(s) ${dropped.join(', ')} (lane ${lanes.join(', ')}) from ${registryPath(repo)}`);
}

// #2616 — the SHARED registry writer both `map` (the #2139 review-proxy) and acquire-time population use: record
// item(s) → this lane in the PRIMARY checkout's lane-ports registry. `port` is the lane's page-port when the pool
// has a PORT_BANDS entry (what the #2139 proxy forwards on); it is OMITTED for a band-less pool, because the #2616
// health-stall scan reverse-derives lane→num from `{ lane }` alone and needs no port. Each item id is normalized
// so the key matches the `#num` forms conveyor-state's `itemNumFromRef` / transcript scan recognize: a numeric run
// via `String(Number())` (drops leading zeros); a JIT `x…` slug LOWER-CASED (the scan's `#num` match is
// case-sensitive and generated slugs are lowercase, so an upper/mixed-case `--item` must fold to lowercase or it
// would key an entry no transcript ever matches). Returns the resolved port (or null) for the caller's log line.
function registerItemsToLane(repo, n, items) {
  const port = lanePagePort(repo, n);
  const entries = readPortRegistry(repo);
  for (const raw of items) {
    const key = /^\d+$/.test(raw) ? String(Number(raw)) : raw.toLowerCase();
    entries[key] = port === null ? { lane: n, repo: repo.name } : { port, lane: n, repo: repo.name };
  }
  writePortRegistry(repo, entries);
  return port;
}

// Lane indices on disk under a pool DIR, sorted by index (the primitive both the repo-scoped `existingLanes`
// and the #2667 cross-pool sweep share, so "what counts as a lane" is defined in exactly one place).
// #x5n4zn3 — a local directory listing: practically instant, but still bounded (a wedged network mount is the
// one realistic way this hangs, and it must not take the whole pool status/list with it).
const LS_TIMEOUT_MS = 15_000;
// #x5n4zn3 — a real `npm ci`/`install`, generous like the sibling build above: bounded so a stuck npm registry
// fails ONE lane's dep install, not the whole acquire/provision/refresh pass. Shared with every OUTER wrapper
// around an `acquire` (`resolveLaneAcquireTimeoutMs`), so the wrapper is never tighter than this.
const NPM_TIMEOUT_MS = NPM_INSTALL_TIMEOUT_MS;
function laneIndicesIn(poolDir) {
  if (!existsSync(poolDir)) return [];
  return execFileSync('ls', ['-1', poolDir], { encoding: 'utf8', timeout: LS_TIMEOUT_MS, killSignal: 'SIGKILL' })
    .split('\n')
    .map((d) => d.trim())
    .filter((d) => /^lane-\d+$/.test(d))
    .map((d) => Number(d.slice(5)))
    .sort((a, b) => a - b);
}

// Lanes currently on disk for a repo's pool, sorted by index.
function existingLanes(repo) {
  return laneIndicesIn(repo.poolDir);
}

// #2667 — pool NAMES under POOL_ROOT that actually hold lanes (have at least one `lane-N` child). Skips the
// one-off scratch clones that also live under POOL_ROOT (drain / heal / pipeline checkouts) and the
// constellation sibling clones (`frontierui` / `plateau-app` render siblings) — none of those have `lane-N`
// children, so they never match. This is the set the cross-pool release-by-session sweep walks.
function existingPools() {
  if (!existsSync(POOL_ROOT)) return [];
  return execFileSync('ls', ['-1', POOL_ROOT], { encoding: 'utf8', timeout: LS_TIMEOUT_MS, killSignal: 'SIGKILL' })
    .split('\n')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((name) => laneIndicesIn(join(POOL_ROOT, name)).length > 0)
    .sort();
}

// ── deps (node_modules) — not shared by --reference, so installed per lane on fresh-clone / lockfile change ──
const DEPS_MARKER = (dir) => join(dir, '.git', '.lane-pool-deps'); // inside .git ⇒ never tracked or git-cleaned
function lockHash(dir) {
  const lock = join(dir, 'package-lock.json');
  const pkg = join(dir, 'package.json');
  const file = existsSync(lock) ? lock : existsSync(pkg) ? pkg : null;
  if (!file) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function depsReady(dir) {
  const want = lockHash(dir);
  if (want === null) return 'n/a'; // no package.json → nothing to install
  if (!existsSync(join(dir, 'node_modules'))) return 'missing';
  const have = existsSync(DEPS_MARKER(dir)) ? readFileSync(DEPS_MARKER(dir), 'utf8').trim() : null;
  return have === want ? 'ok' : 'stale';
}
// #3461 — `npm ci`/`npm install` here is a DELIBERATE, NAMED EXCEPTION to the heavy-command admission queue
// (`scripts/readiness/heavy-admission.mjs`), not an oversight. #3456's own ruling is explicit that the cap
// applies at heavy-command-INVOCATION time, never at lane-ACQUIRE time — "a lane may always be acquired
// freely" — and `ensureDeps` runs INSIDE `acquire`/`provision`/`refresh` (see the three call sites below), so
// routing it through the semaphore would violate that guarantee directly: a lane trying to acquire could queue
// behind check:standards/test:unit runs in OTHER lanes, which is exactly the coupling #3456 ruled out. Passing
// `--no-install` at every dispatched-agent acquire call site and gating `npm ci` as its own explicit
// post-acquire step was the alternative #3461 considered and rejected — it would touch every acquire call
// site (including `delivery-agent-brief.md` and every skill/workflow that provisions a lane), for a command
// that is comparatively cheap and already deduped by `depsReady`'s lockfile-hash skip (most acquires do
// nothing here at all). This function stays ungated.
function ensureDeps(dir) {
  const state = depsReady(dir);
  if (state === 'n/a' || state === 'ok') return state;
  const useCi = existsSync(join(dir, 'package-lock.json'));
  log(`  deps ${state} → npm ${useCi ? 'ci' : 'install'} in ${dir} …`);
  // #x5n4zn3 review — npm's stdout goes to OUR stderr (fd 2), never our stdout: `acquire --json` prints its
  // result on stdout, and a caller that captures it (`orphan-claim-release.mjs`'s `acquireLane`) must parse
  // pure JSON even on the acquires that actually install. Stays visible on a terminal either way.
  execFileSync('npm', [useCi ? 'ci' : 'install'], { cwd: dir, stdio: ['inherit', 2, 'inherit'], timeout: NPM_TIMEOUT_MS, killSignal: 'SIGKILL' });
  writeFileSync(DEPS_MARKER(dir), lockHash(dir));
  return 'installed';
}

// ── lease (#2275) — an exclusive hold so a lane is never recycled or double-acquired while in use ─────
// The marker lives INSIDE `.git` (like DEPS_MARKER) so it is never tracked, never `git clean`-ed, and
// never seen by `git status --porcelain` (so it doesn't itself make a lane look dirty). A held lane is
// off-limits to `refresh`/`provision`'s `reset --hard` AND to another session's `acquire`, until `release`
// (or TTL-reclaim). See scripts/lib/lane-lease.mjs for the pure decision logic.
const LEASE_MARKER = (dir) => join(dir, '.git', LEASE_FILENAME);
function readLease(dir, onReadError = () => {}) {
  const file = LEASE_MARKER(dir);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('lease marker must contain a JSON object');
    return parsed;
  } catch (error) {
    // Status must distinguish absent markers from unreadable evidence. Other callers retain
    // their existing lease semantics; the diagnostic is not a synthetic lease.
    if (error.code !== 'ENOENT') onReadError(error);
    return null; // a corrupt marker is treated as no live lease (isLeaseStale also fails-open)
  }
}
const ttlMinutesFromFlags = () =>
  flags['ttl-minutes'] !== undefined && Number.isFinite(Number(flags['ttl-minutes']))
    ? Number(flags['ttl-minutes'])
    : DEFAULT_LEASE_TTL_MINUTES;
const ttlMsFromFlags = () => ttlMinutesFromFlags() * 60_000;
// #x3jmao3 — the poll spacing for `acquire --wait-ms=<total>`'s bounded full-pool retry (see cmdAcquire's
// auto-pick branch). Short enough that a several-second capacity flicker resolves within one or two polls;
// long enough not to hammer the filesystem on a genuinely-exhausted pool for the whole wait window.
const ACQUIRE_POLL_MS = 1000;
// A lane holds a LIVE lease when a marker exists and hasn't outlived its TTL (owner presumed alive).
function liveLease(dir, nowMs, ttlMs) {
  const lease = readLease(dir);
  return lease && !isLeaseStale(lease, nowMs, ttlMs) ? lease : null;
}
// #2997 — every OTHER lane's LIVE lease the caller could be confused with. The input to `isContestedLease`,
// i.e. "is a sibling agent of this lease's session holding a lane right now?". Best-effort: any read failure
// just yields a shorter list, which can only make a lease read as UNcontested (today's behaviour) — never a
// spurious refusal.
// #2997 r2 (review F3) — the scan is CROSS-POOL, not this pool only. A session's sibling agents routinely hold
// lanes in different pools (a cross-locus couple leases one lane in the web-everything pool and one in the
// plateau-app pool), and a same-pool-only scan read those as uncontested — the ambient id is exactly as
// ambiguous there, so the refusal must arm there too. The cost is a readdir per pool, paid only on release.
function liveLeasesInPoolExcept(repo, lane, nowMs, ttlMs) {
  const here = laneDir(repo, lane);
  const out = [];
  for (const name of existingPools()) {
    const poolDir = join(POOL_ROOT, name);
    for (const n of laneIndicesIn(poolDir)) {
      const dir = join(poolDir, `lane-${n}`);
      if (dir === here) continue; // never the subject lane itself
      const lease = liveLease(dir, nowMs, ttlMs);
      if (lease) out.push(lease);
    }
  }
  return out;
}
// Session identity must be STABLE across a consumer's separate `acquire` then `release` invocations, yet
// DISTINCT between concurrent sessions on one host (the whole point — session B must not release session A's
// lane). A per-process pid is unstable (each CLI call is a new pid); a bare hostname collides across
// sessions. So: an explicit `--session` (what every flow should pass) wins; else `LANE_SESSION` env; else
// the parent shell's pid (`ppid` — the same shell drives a flow's acquire+release, and differs per session).
const defaultSession = () => flags.session || process.env.LANE_SESSION || `${hostname()}:${process.ppid}`;

// #2997 — mint the PER-HOLDER slug stamped into every lease's `holder` field. This is the ownership signal that
// `ownerSession` structurally cannot be: two sibling agents of one session inherit the SAME
// `CLAUDE_CODE_SESSION_ID` verbatim (#2413's ratified statute), so ANY ambient env/process property reads
// identically for both — which is exactly how a 2026-08-14 `release --lane=5` dropped a concurrent holder's
// lease. A random component is what makes the slug un-shareable by accident; it is handed to the acquirer (and
// only the acquirer) on stdout, so re-asserting it is proof of holding, not of belonging to the session.
// Shaped `<purpose>-<lane>-<rand>` so a human/agent reading a deny message can tell whose it is, and restricted
// to `assertedLaneSlug`'s charset so it survives an inline `LANE_SESSION=<slug>` assertion unchanged.
function mintHolderSlug(dir, purpose) {
  const tag = String(purpose || 'lane').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'lane';
  return `${tag}-${basename(dir)}-${randomBytes(4).toString('hex')}`;
}

// ── core ops ──────────────────────────────────────────────────────────────────────────────────────
function cloneLane(repo, n) {
  const dest = laneDir(repo, n);
  // #2667 — `--pool=<name>` makes a null origin non-fatal at resolve (for read/release ops), so a CLONE path
  // must fail CLEANLY here rather than passing null to `git clone` (a raw TypeError). --pool selects an EXISTING
  // pool for read/release; to clone/acquire a new lane, pass --repo or --origin so an origin URL is derivable.
  if (!repo.originUrl) {
    fail(`could not determine an origin URL for pool "${repo.name}" — --pool selects an existing pool for read/release only; to clone/acquire a lane pass --repo=<checkout> or --origin=<url>`);
  }
  const ref = cloneReferenceArgs(repo.referencePath);
  log(`  clone lane-${n} ← ${repo.originUrl} ${ref.length ? `(--reference ${repo.referencePath})` : '(no --reference: shallow)'} …`);
  gitQuiet(['clone', '--quiet', ...ref, repo.originUrl, dest]);
  // Pin a stable local default branch so refresh's hard-reset target is unambiguous.
  tryGit(['checkout', '--quiet', '-B', repo.branch, `origin/${repo.branch}`], dest);
}

// Dirty-or-ahead guard (#2267 — data-loss guard): a lane's ONLY durable state is what has already been
// PUSHED to origin (i.e. landed via pr-land); anything else (uncommitted edits, or commits made locally
// but not yet pushed to its `lane/*` ref) lives nowhere else and is destroyed by `reset --hard` + `clean
// -fd`. Compute this AFTER the fetch (so "ahead" reflects the latest origin/<branch>) but BEFORE any
// destructive git call.
function laneDirtyOrAhead(dir, branch) {
  const porcelain = tryGit(['status', '--porcelain'], dir);
  const uncommitted = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  const aheadRaw = tryGit(['rev-list', '--count', `origin/${branch}..HEAD`], dir);
  const ahead = aheadRaw === null ? 0 : Number(aheadRaw);
  // #2452 review — this predicate reports the FACT only ("how many commits ahead of the local origin ref").
  // The Gap-1 relaxation used to live here, which silently changed reset/skip semantics for every caller
  // (`refreshLane`'s hard-reset decision, `status`, the board) even though it is justified only for acquire's
  // auto-pick. Policy now lives at that one call site — see `aheadIsProvablyPushed`.
  return { dirty: uncommitted > 0, uncommitted, ahead };
}

/**
 * #2452 (Gap 1, hardened in review) — is this lane's HEAD PROVABLY already on origin, so acquire's auto-pick
 * may treat an "ahead" lane as recyclable rather than firing the #2267 never-recycle-unpushed-work guard?
 *
 * The first cut answered this from LOCAL remote-tracking refs alone (`for-each-ref --contains=HEAD
 * refs/remotes`). That is unsound: a local `refs/remotes/origin/lane/*` ref is exactly as stale as the
 * `origin/<branch>` ref the check exists to distrust. A `lane/*` branch deleted on origin after landing (the
 * normal end of a lane's life) leaves its remote-tracking ref behind locally, so HEAD still "contains" into
 * it and the guard clears — handing a hard `reset --hard` to a lane whose commits exist NOWHERE on the
 * remote. The failure mode of a wrong answer here is destroyed work, so it must be checked against the live
 * remote, not a cache.
 *
 * `remoteShas` is the live `ls-remote` snapshot (taken ONCE per acquire pass, and only when some lane looks
 * ahead — so the no-per-lane-fetch cost profile is preserved in the common case). HEAD counts as pushed only
 * if it is a live remote tip or an ancestor of one. Fails CLOSED on any git fault: no proof ⇒ stay protected.
 *
 * #2920 — this used to be a per-remote-head `merge-base --is-ancestor` fan-out (one spawn per live remote
 * head, per ahead lane): on the real 38-lane pool with 29 remote heads that was 677 git spawns / ~30s for
 * one acquire pass. Containment is answerable in ONE spawn: `rev-list HEAD --not <shas...>` walks HEAD's
 * ancestry once, excluding everything reachable from ANY of the given shas — empty output means HEAD (and
 * everything under it) is already reachable from some remote head, i.e. exactly the OR-across-heads the old
 * loop computed. `--ignore-missing` tolerates a remoteShas entry whose object isn't present in this lane's
 * local object DB (e.g. a branch this lane never fetched) by dropping it from the exclusion set rather than
 * failing the whole spawn — the same fail-open-per-candidate behavior the old per-sha loop had (a missing
 * object just couldn't prove anything, but didn't stop OTHER candidates from proving it). Verified against
 * the live pool + synthetic cases (fully pushed / one unpushed commit / deleted remote ref / detached HEAD /
 * no remotes / empty repo / unresolvable sha mixed with a valid one) — zero verdict flips vs. the old loop.
 */
function aheadIsProvablyPushed(dir, remoteShas, branch) {
  if (!remoteShas || remoteShas.size === 0) return false;
  const headRaw = tryGit(['rev-parse', 'HEAD'], dir);
  if (!headRaw) return false;
  const head = headRaw.trim();
  if (remoteShas.has(head)) return true;
  const out = tryGit(['rev-list', '--ignore-missing', '--max-count=1', 'HEAD', '--not', ...remoteShas], dir);
  if (out !== null && out.trim() === '') return true;
  // #3383 — ancestry alone MISSES the squash/rebase-merge case, live-observed on the plateau-app pool: a
  // squash (or rebase) merge lands origin/<branch> on a brand-new commit carrying the SAME patch as the
  // lane's own commit(s), but built on top of whatever else landed first — never on top of the lane's commit
  // itself. No ancestry walk will ever find it (the lane's commit is simply not an ancestor of anything on
  // origin), yet a manual `git cherry origin/<branch> HEAD` shows `-` (patch already applied) for every one.
  return aheadIsPatchEquivalent(dir, head, remoteShas, branch);
}

/**
 * #3383-perf — live-caught the morning after #3383 landed: the FIRST cut of this fallback ran one full `git
 * cherry <head> HEAD` PER live remote head, per ahead lane (an OR-across-every-head fan-out, mirroring
 * #2920's already-fixed ancestry check). On the real web-everything pool (83 lanes, 160 remote heads) that
 * stalled a single `list --acquirable` pass for 20+ minutes — `git cherry` itself does a bidirectional
 * patch-id walk over the ENTIRE divergent history on both sides, so one call against an unrelated, long-lived
 * branch can be arbitrarily expensive, and #2920's own one-spawn ancestry trick doesn't apply here (there is
 * no single command that answers "patch-equivalent to ANY of these" the way `rev-list --not` answers ancestry
 * for containment). The fix daemon's WE tick calls this on every tick, so it hung too.
 *
 * Two-tier fix, cheapest and most common case first — total git-spawn count is now BOUNDED (does not scale
 * with remote-head count):
 *  1. PRIMARY — ONE bounded `git cherry origin/<branch> HEAD`, exactly the manual diagnosis this item's own
 *     postmortem used. Cost is proportional to that ONE branch's own divergence, never to how many OTHER
 *     branches exist — covers the overwhelmingly common case (a lane's work lands on its own integration
 *     branch) with the full ancestry-aware precision `git cherry` gives (catches a match buried several
 *     commits back, not just at the tip).
 *  2. FALLBACK, only if (1) finds no match — a single O(1)-git-spawn-PAIR batched patch-id comparison
 *     (`git diff-tree --stdin -p | git patch-id --stable`, once for "our" ahead commit(s), once for every
 *     OTHER remote head) instead of one `git cherry` per head. This is a narrower heuristic than `git cherry`
 *     (it compares each commit's OWN introduced diff against its immediate parent — it can miss a squash that
 *     COMBINES several of the lane's commits into one, or a match buried behind a merge commit on the other
 *     branch), in exchange for NEVER spawning more than a handful of git processes regardless of how many
 *     remote heads exist. Acceptable: a case this narrower heuristic misses (e.g. lane-11's PR #176 branch,
 *     if it doesn't hit) simply stays protected — fails closed, same as any other unproven candidate, never a
 *     false positive.
 */
function aheadIsPatchEquivalent(dir, head, remoteShas, branch) {
  if (branch && cherryAllPatchEquivalent(dir, `origin/${branch}`, head)) return true;
  return otherRemoteHeadsPatchEquivalentBatched(dir, head, remoteShas, branch);
}

/** ONE `git cherry <upstream> <head>` call. `true` iff every commit `<head>` has that `<upstream>` lacks is
 *  patch-equivalent to something already in `<upstream>` (or there are none — already ancestor-contained). */
function cherryAllPatchEquivalent(dir, upstream, head) {
  const out = tryGit(['cherry', upstream, head], dir);
  if (out === null) return false; // unresolvable (e.g. `branch` not fetched here) — try the batched fallback
  const lines = out.split('\n').filter(Boolean);
  return lines.length === 0 || lines.every((l) => l.startsWith('-'));
}

/**
 * #3383-perf — the bounded fallback: compares the lane's OWN ahead-commit patch-id(s) against EVERY OTHER
 * live remote head's patch-id, computed in exactly TWO `diff-tree --stdin -p | patch-id --stable` pipelines
 * total (one for "ours", one for "theirs — all of them at once"), never one pipeline per head. `--stdin`
 * (rather than one positional arg per commit) is what makes this a single spawn regardless of list length.
 * Fails CLOSED throughout: any git-call failure, or an empty/unresolvable diff, just means no match found —
 * never a thrown error, never a false positive.
 * @param {string} dir
 * @param {string} head
 * @param {Set<string>} remoteShas
 * @param {string} [branch] - excluded from "other" heads (already tried, above, via the precise `git cherry`)
 * @returns {boolean}
 */
function otherRemoteHeadsPatchEquivalentBatched(dir, head, remoteShas, branch) {
  const branchSha = branch ? tryGit(['rev-parse', '--verify', '--quiet', `origin/${branch}`], dir) : null;
  const others = [...remoteShas].filter((sha) => sha !== branchSha);
  if (others.length === 0) return false;
  // "Ours": every ahead commit (origin/<branch>..HEAD when resolvable — matches what `laneDirtyOrAhead` itself
  // already counts as "ahead" — else just HEAD alone, so this still degrades gracefully with no branch known).
  const aheadRange = branch ? tryGit(['rev-list', `origin/${branch}..HEAD`], dir) : null;
  const ourShas = aheadRange ? aheadRange.split('\n').filter(Boolean) : [head];
  const ourPatchIds = batchPatchIds(dir, ourShas);
  if (ourPatchIds.size === 0) return false;
  // `batchPatchIds` maps commitSha → patchId — the match test is on the PATCH ID (the value), never the
  // commit sha (the key). Compare the VALUE sets, not `Map#has` against a key.
  const ourPatchIdValues = new Set(ourPatchIds.values());
  const theirPatchIds = batchPatchIds(dir, others);
  for (const id of theirPatchIds.values()) {
    if (ourPatchIdValues.has(id)) return true;
  }
  return false;
}

// A large-but-bounded buffer: this pipes a POTENTIALLY large batch of commit patches through in one call
// (never one call per commit), so the default 1MB execFileSync ceiling is too tight for a big pool.
const PATCH_ID_MAX_BUFFER = 32 * 1024 * 1024;

/** `shas` (newline-fed via `--stdin`, ONE spawn pair regardless of how many) → Map<commitSha, patchId>. Skips
 *  a merge commit's diff by default (bare `diff-tree`, no `-m`/`-c`) — exactly like `git cherry` itself, so a
 *  remote head that is a merge commit (e.g. a landed PR's own merge commit) contributes no id, never a
 *  spurious one. Returns an empty Map on any failure — never throws. */
function batchPatchIds(dir, shas) {
  if (!shas.length) return new Map();
  // `git`/`tryGit`'s own base options hardcode `stdio: ['ignore', 'pipe', 'pipe']` (no caller has ever needed
  // to WRITE to a spawned git's stdin before this) — passing `input` alone here would silently merge UNDER
  // that `stdio` key (the object-spread order in `git()` puts `stdio` before `...opts`, so `opts.input` never
  // overrides `stdio[0]`), and execFileSync then just as silently feeds the child NO stdin at all rather than
  // erroring — `diff-tree --stdin` with an empty stdin exits 0 with empty output, which every caller here
  // reads as "no match found" instead of "input was never delivered". Caught by this file's OWN new test
  // (the fallback case) failing even though a byte-for-byte manual repro of the same two commands proved the
  // patch-ids DO match — the bug was never the patch-id logic, only this option-merge order. `stdio: ['pipe',
  // 'pipe', 'pipe']` here is what actually lets `input` reach the child.
  const withInput = (input) => ({ input, maxBuffer: PATCH_ID_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
  const diff = tryGit(['diff-tree', '--stdin', '-p'], dir, withInput(shas.join('\n') + '\n'));
  if (diff === null || diff.trim() === '') return new Map();
  const idsOut = tryGit(['patch-id', '--stable'], dir, withInput(diff));
  if (idsOut === null) return new Map();
  const map = new Map();
  for (const line of idsOut.split('\n').filter(Boolean)) {
    const [patchId, commit] = line.trim().split(/\s+/);
    if (patchId && commit) map.set(commit, patchId);
  }
  return map;
}

/**
 * #3383 — is this lane ACTUALLY dirty once known-safe agent-scratch litter (the shared
 * `we:scripts/lib/lane-litter.mjs` allowlist — `.pr-body.md`, `.converge-*`, …) is set aside? Re-reads
 * porcelain itself (`laneDirtyOrAhead` doesn't expose the raw text, and its OWN contract must stay the raw
 * fact for every other caller — `refreshLane`/`laneStatus`/the board — per the #2452 review this mirrors:
 * the relaxation lives at the acquire-time call sites that opt into it, never inside the shared primitive).
 * On any read failure, returns `rawDirty` UNCHANGED — an inconclusive read must never be reported as clean.
 * @param {string} dir
 * @param {boolean} rawDirty
 * @returns {boolean}
 */
function litterAdjustedDirty(dir, rawDirty) {
  if (!rawDirty) return false;
  const porcelain = tryGit(['status', '--porcelain'], dir);
  if (porcelain === null) return rawDirty;
  const { leaveDirty } = planLitterCleanup(porcelain);
  return leaveDirty.length > 0;
}

/**
 * #3383 — the EFFECTIVE dirty/ahead verdict a picker should act on: `laneDirtyOrAhead`'s raw fact, adjusted by
 * the two acquire-time-only relaxations above (litter-only dirt counts as clean; a squash/rebase-merged or
 * ancestor-contained "ahead" commit counts as pushed). `getRemoteShas` is a caller-supplied lazy getter (NOT
 * called unless some candidate actually looks ahead) so a whole listing/auto-pick pass pays at most ONE
 * `ls-remote`, shared across every lane it considers — never one network call per lane.
 * @param {string} dir
 * @param {string} branch
 * @param {() => Set<string>} getRemoteShas
 * @returns {{dirty: boolean, uncommitted: number, ahead: number, aheadPushed?: boolean}}
 */
function effectiveDirtyOrAhead(dir, branch, getRemoteShas) {
  const raw = laneDirtyOrAhead(dir, branch);
  const dirty = litterAdjustedDirty(dir, raw.dirty);
  let ahead = raw.ahead;
  let aheadPushed = false;
  if (ahead > 0) {
    const remoteShas = getRemoteShas();
    if (aheadIsProvablyPushed(dir, remoteShas, branch)) {
      ahead = 0;
      aheadPushed = true;
    }
  }
  return { ...raw, dirty, ahead, aheadPushed };
}

/**
 * #4025 — like `liveRemoteShas`, but tells an outright PROBE FAILURE (timeout / unreachable / any git error —
 * `tryGit` returned null) apart from a genuinely empty remote (no heads at all). The two read identically
 * through the plain `liveRemoteShas` wrapper below (both "no SHAs"), which is exactly what let a 2026-09-23
 * `list --acquirable` slowdown/timeout get silently misread as "nothing on this pool is provably pushed,
 * therefore nothing is acquirable, therefore GROW" — `cmdProvision`'s `--acquirable` branch cloned 31 new
 * lanes chasing a headroom that a live probe would never have needed. Any caller that must react differently
 * to "we don't know" than to "we checked and there is genuinely nothing" needs `ok`, not just `shas`.
 */
function liveRemoteShasProbe(dir) {
  const out = tryGit(['ls-remote', '--heads', 'origin'], dir, { timeout: 20_000 });
  if (out === null) return { ok: false, shas: new Set() };
  return { ok: true, shas: new Set(out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]).filter(Boolean)) };
}

/** Live remote tip SHAs (one network call, `timeout` guarded like the adjacent `gh` call — #2920). Returns
 *  an EMPTY set on any failure/timeout, so callers fail closed. Thin wrapper over `liveRemoteShasProbe` —
 *  every caller that only ever needs "what's out there" (never "did the probe itself fail") keeps this. */
function liveRemoteShas(dir) {
  return liveRemoteShasProbe(dir).shas;
}

/** #2924 — the LOCAL equivalent of `liveRemoteShas`, network-free. Sound ONLY immediately after a fetch: a
 *  local `refs/remotes/origin/*` tip is exactly as fresh as the remote it was just fetched from, unlike the
 *  stale-cache case `aheadIsProvablyPushed`'s own docblock warns against (a ref deleted on origin AFTER
 *  landing, whose local remote-tracking ref lingers). Used to re-verify containment right before the
 *  destructive reset, on data no older than the fetch that immediately precedes it — no second network call. */
function localRemoteShas(dir) {
  const out = tryGit(['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin'], dir);
  if (out === null) return new Set();
  return new Set(out.split('\n').filter(Boolean));
}

// Returns { skipped: boolean, dirty, uncommitted, ahead } so callers can tell an actually-reset lane
// (safe to unmap its stale item mapping, #2139) from a skipped one (still serving its in-flight item).
function refreshLane(repo, n, { force = false } = {}) {
  const dir = laneDir(repo, n);
  fetchOriginPruneWithRetry(dir);
  // #2337(b) — a LIVE lease is an ownership hold (a process is presumed alive within TTL), distinct from the
  // dirty/ahead STALENESS guard below. `--force` exists to recycle stale residue, not to stomp an active
  // consumer, so the lease check runs REGARDLESS of `--force`: a leased lane is always skipped (loud), never
  // reset. The deliberate override is `release --force` (drop the lease), not this flag.
  const lease = liveLease(dir, Date.now(), ttlMsFromFlags());
  if (lease) {
    // #2350 — a RESERVED (permanent) lane is skipped forever; the un-reserve is `release --release-reserved`,
    // never `release --force` (which drops an ordinary hold but leaves a reserved one in place).
    const escape = isReservedLease(lease)
      ? `a PERMANENT reserved lane; --force never resets it (#2350); use \`release --lane=${n} --release-reserved\` to deliberately un-reserve`
      : `LIVE lease; --force does not override it (#2337); use \`release --lane=${n} --force\` first`;
    log(`  lane-${n}: SKIPPED (${describeLease(lease)}) — ${escape}`);
    return { skipped: true, leased: true, dirty: false, uncommitted: 0, ahead: 0 };
  }
  if (!force) {
    // #2267 — dirty/ahead is a property of the TREE (possibly abandoned residue from a dead session), which
    // `--force` exists to recycle. Skippable by `--force`, unlike the lease check above.
    const { dirty, uncommitted, ahead } = laneDirtyOrAhead(dir, repo.branch);
    if (dirty || ahead > 0) {
      log(`  lane-${n}: SKIPPED (dirty/ahead — ${uncommitted} uncommitted, ${ahead} ahead) — use --force to override`);
      return { skipped: true, dirty, uncommitted, ahead };
    }
  }
  git(['reset', '--hard', `origin/${repo.branch}`, '--quiet'], dir);
  git(['clean', '-fd', '--quiet'], dir); // remove untracked, KEEP ignored (node_modules) — no -x
  return { skipped: false, dirty: false, uncommitted: 0, ahead: 0 };
}

function laneStatus(repo, n) {
  const dir = laneDir(repo, n);
  if (!existsSync(dir)) return { lane: n, path: dir, exists: false };
  const head = tryGit(['rev-parse', '--short', 'HEAD'], dir);
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const porcelain = tryGit(['status', '--porcelain'], dir);
  const behind = tryGit(['rev-list', '--count', `HEAD..origin/${repo.branch}`], dir);
  let readError;
  const lease = readLease(dir, (error) => { readError = error.message; });
  return {
    lane: n,
    path: dir,
    exists: true,
    head,
    branch,
    clean: porcelain === '',
    behind: behind === null ? '?' : Number(behind),
    deps: depsReady(dir),
    // #2275 — surface the hold so a picker can filter (and a human sees who owns a lane). `leased` is only
    // true for a LIVE lease; a stale marker reads as free (reclaimable), matching acquire's own logic.
    lease: lease || null,
    ...(readError ? { readError } : {}),
    leased: lease ? !isLeaseStale(lease, Date.now(), ttlMsFromFlags()) : false,
  };
}

// #2426 — the lease/dirty snapshot a lease-aware picker (`list --acquirable`, `provision --acquirable`) needs to
// decide whether a lane is safe to couple an item onto. Shape matches `isLaneAcquirable(info, now, ttl)` in
// lane-lease.mjs: `exists`, the raw `lease` marker, and `dirtyOrAhead` (someone's un-pushed work).
// #3383 — applies the SAME two acquire-time relaxations `cmdAcquire`'s own `infoFor` applies
// (`effectiveDirtyOrAhead`: litter-only dirt counts as clean, a squash/rebase-merged or ancestor-contained
// "ahead" commit counts as pushed), via the SAME shared, lazy `remoteShasBox` — so this read-only picker and
// `acquire`'s actual auto-pick can never diverge (a lane reported acquirable here is exactly one `acquire`
// will take). `remoteShasBox` is optional and OMITTED means "no ls-remote" (a getter that always returns an
// empty set, so `aheadIsProvablyPushed` short-circuits `false`) — preserving the original no-network-call
// cost for any caller that doesn't pass one; every caller in THIS file always passes one (see `cmdList`/
// `cmdProvision`), one shared `ls-remote` per whole listing/provision pass, never one per lane.
// #xn432dz — LEASE-FIRST: the marker is read BEFORE any git, and a lane whose LIVE lease already disqualifies it
// (`leaseDisqualifiesAcquire`) is returned with `dirtyOrAhead: null` and no git spawned at all. That is exactly
// verdict-preserving — `isLaneAcquirable` is false for a live lease whatever the tree holds (proved over every
// dirtyOrAhead shape in lane-lease.test.mjs) — and it is where the cost was: on the real pool most lanes are
// leased, yet every scan ran `status --porcelain` + `rev-list` (+ a second porcelain for litter) in each one.
// `nowMs`/`ttlMs` must be the SAME values the caller hands `isLaneAcquirable`, so both reads agree on staleness.
function laneAcquirableInfo(repo, n, remoteShasBox = null, nowMs = Date.now(), ttlMs = ttlMsFromFlags()) {
  const dir = laneDir(repo, n);
  if (!existsSync(dir)) return { lane: n, exists: false };
  const lease = readLease(dir);
  if (leaseDisqualifiesAcquire(lease, nowMs, ttlMs)) return { lane: n, exists: true, lease, dirtyOrAhead: null };
  const getRemoteShas = () => {
    if (!remoteShasBox) return new Set();
    if (remoteShasBox.value === null) {
      // #4025 — record an outright probe FAILURE on the box itself (never on the returned Set, which stays
      // "no SHAs" either way) so a caller deciding whether to GROW the pool (`cmdProvision`'s `--acquirable`
      // branch) can tell "genuinely nothing pushed" from "we couldn't check" and refuse to grow on the latter.
      const probe = liveRemoteShasProbe(dir);
      remoteShasBox.value = probe.shas;
      if (!probe.ok) remoteShasBox.failed = true;
    }
    return remoteShasBox.value;
  };
  return {
    lane: n,
    exists: true,
    lease,
    dirtyOrAhead: effectiveDirtyOrAhead(dir, repo.branch, getRemoteShas),
  };
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────
const log = (m) => process.stderr.write(m + '\n');
function fail(m) {
  process.stderr.write(`✗ ${m}\n`);
  process.exit(1);
}

// ── commands ──────────────────────────────────────────────────────────────────────────────────────
// Provision one lane (clone if missing, refresh, write env, ensure deps). Returns refreshLane's result so the
// caller can tell an actually-reset lane (safe to unmap its stale item mapping) from a skipped/leased one.
function provisionLane(repo, n, force) {
  if (!existsSync(laneDir(repo, n))) cloneLane(repo, n);
  else log(`  lane-${n} exists`);
  const result = refreshLane(repo, n, { force });
  writeLaneEnv(repo, n);
  if (!flags['no-install']) ensureDeps(laneDir(repo, n));
  return result;
}

// #2426 — headroom past --count when growing to N ACQUIRABLE lanes, so a run with many foreign-leased lanes can
// still cover N usable ones without cloning unboundedly (a corrupt lease that never reads acquirable would loop).
// #4025 — this stays as the ABSOLUTE safety ceiling (belt-and-suspenders), but is no longer the practical bound:
// see ACQUIRABLE_PROVISION_MAX_NEW below, which is what actually limits how many BRAND-NEW lanes one call clones.
const ACQUIRABLE_PROVISION_HEADROOM = 32;

// #4025 — live-traced root cause of the 2026-09-23 growth burst (lanes 84-114, 31 new lanes in ~4 minutes): a
// `list --acquirable`-style acquirability probe failed/timed out under load, was read fail-safe as "0
// acquirable", and this branch then cloned all the way to ACQUIRABLE_PROVISION_HEADROOM (32) chasing a count
// that was never really missing. Two independent guards now bound that: (1) a small per-call cap on brand-new
// clones — reaching it just means "ask again" for more capacity, never "clone dozens in one shot"; (2) an
// outright remote-reachability PROBE FAILURE (see `liveRemoteShasProbe`) stops growth entirely rather than
// treating "we don't know" as "grow" — see the loop below. `--max-new=N` overrides the default per call;
// `LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW` overrides the default globally (e.g. for a daemon that wants a
// different steady-state cap without touching every call site).
const ACQUIRABLE_PROVISION_MAX_NEW_DEFAULT = 4;

function cmdProvision(repo) {
  const count = Number(flags.count);
  if (!Number.isInteger(count) || count < 1) fail('provision needs --count=<positive integer>');
  mkdirSync(repo.poolDir, { recursive: true });
  const force = !!flags.force;
  const resetLanes = []; // only lanes actually reset lose their stale mapping — a skipped lane still serves it

  // #2426 — `--acquirable` provisions until `count` lanes are ACQUIRABLE (not foreign-leased / busy), growing the
  // pool PAST held lanes rather than stopping at lane-<count>. This is what lets the parallel /workflow couple N
  // items to N usable lanes even when a sibling session holds some of the low-index ones: without it, provision
  // clones lane-1..N, a leased lane among them is skipped (correctly, never clobbered) but still occupies a
  // coupling slot, so its item is carried with zero work.
  if (flags.acquirable) {
    const nowMs = Date.now();
    const ttlMs = ttlMsFromFlags();
    const existingCount = existingLanes(repo).length; // #4025 — snapshot BEFORE this call clones anything: any
    // lane numbered past this is a BRAND-NEW clone this call is responsible for, never a pre-existing one.
    const cap = count + ACQUIRABLE_PROVISION_HEADROOM;
    // An explicit 0 (flag or env) is honored — it pauses new-lane cloning — so parse with the same
    // non-negative-integer guard as `trimCapFor`, never `Number(x) || DEFAULT` (which reads "0" as unset).
    const asNonNegInt = (raw) => {
      if (raw === undefined || raw === '' || raw === true) return null;
      const v = Number(raw);
      return Number.isInteger(v) && v >= 0 ? v : null;
    };
    const maxNew = asNonNegInt(flags['max-new'])
      ?? asNonNegInt(process.env.LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW)
      ?? ACQUIRABLE_PROVISION_MAX_NEW_DEFAULT;
    log(`provisioning up to ${count} ACQUIRABLE lane(s) for "${repo.name}" under ${repo.poolDir} (branch ${repo.branch}; cap lane-${cap}; new-lane cap ${maxNew} this call)`);
    let acquirable = 0;
    let n = 0;
    let newLanesCloned = 0;
    let growthStoppedReason = null;
    // #3383 — ONE shared lazy `ls-remote` for this whole provisioning pass (see `laneAcquirableInfo`), not one
    // per lane checked. #4025 — `.failed` (see `laneAcquirableInfo`) records an outright probe failure the
    // FIRST time this pass actually needs to check remote reachability (an existing lane read "ahead"); since
    // existing lanes are always evaluated before any brand-new clone (the loop counts up from 1), a failure
    // here is always known BEFORE growth would begin.
    const remoteShasBox = { value: null, failed: false };
    while (acquirable < count && n < cap) {
      const next = n + 1;
      const isNewLane = next > existingCount;
      if (isNewLane) {
        if (remoteShasBox.failed) { growthStoppedReason = 'remote-probe-failed'; break; }
        if (newLanesCloned >= maxNew) { growthStoppedReason = 'new-lane-cap'; break; }
      }
      n = next;
      const result = provisionLane(repo, n, force);
      if (!result.skipped) resetLanes.push(n);
      if (isNewLane) newLanesCloned++;
      if (isLaneAcquirable(laneAcquirableInfo(repo, n, remoteShasBox, nowMs, ttlMs), nowMs, ttlMs)) acquirable++;
    }
    if (growthStoppedReason === 'remote-probe-failed') {
      log(
        `⚠ #4025 remote reachability probe (git ls-remote) failed while checking an existing lane — refusing to ` +
        `clone MORE new lanes this call (cloned ${newLanesCloned} before stopping, through lane-${n}). This is a ` +
        `deliberate fail-SAFE STOP, never a fail-safe GROW: investigate connectivity/timeouts, then re-run ` +
        `provision --acquirable once the probe can actually answer.`,
      );
    } else if (growthStoppedReason === 'new-lane-cap') {
      log(
        `⚠ reached the per-call new-lane cap (${maxNew}; override with --max-new=N or LANE_POOL_ACQUIRABLE_PROVISION_MAX_NEW) ` +
        `— stopped at lane-${n} having cloned ${newLanesCloned} new lane(s) this call; re-run provision --acquirable ` +
        `again for more capacity rather than cloning dozens in one shot (#4025).`,
      );
    }
    if (acquirable < count) {
      log(`⚠ only ${acquirable}/${count} lane(s) acquirable after provisioning through lane-${n} (rest hold a foreign lease / un-pushed work${growthStoppedReason ? ', or growth was deliberately stopped early — see above' : ''}) — the orchestrator will log the contention and carry the overflow, never double up a lane.`);
    } else {
      log(`ensured ${count} acquirable lane(s) (provisioned through lane-${n}; skipped foreign-leased/busy lanes)`);
    }
  } else {
    log(`provisioning ${count} lane(s) for "${repo.name}" under ${repo.poolDir} (branch ${repo.branch})`);
    for (let n = 1; n <= count; n++) {
      const result = provisionLane(repo, n, force);
      if (!result.skipped) resetLanes.push(n);
    }
  }
  unmapLanes(repo, resetLanes); // refreshed lanes lose stale mappings (#2139); skipped lanes keep theirs
  invalidateListCache(repo); // #xn432dz — reset lanes may have gone dirty→clean with no lease change
  ensureRepoSiblings(repo, { force }); // pushable+built constellation siblings at the pool root (#2166/#2282/#2349)
  printStatus(repo);
}

function cmdRefresh(repo) {
  const lanes = existingLanes(repo);
  if (lanes.length === 0) fail(`no lanes to refresh under ${repo.poolDir} (run provision first)`);
  log(`refreshing ${lanes.length} lane(s) for "${repo.name}" → origin/${repo.branch}`);
  const force = !!flags.force;
  const resetLanes = []; // only lanes actually reset lose their stale mapping — a skipped lane still serves it
  for (const n of lanes) {
    const result = refreshLane(repo, n, { force });
    if (!result.skipped) resetLanes.push(n);
    writeLaneEnv(repo, n);
    if (!flags['no-install']) ensureDeps(laneDir(repo, n));
  }
  unmapLanes(repo, resetLanes); // a reset lane no longer renders its old item (#2139); a skipped one still does
  invalidateListCache(repo); // #xn432dz — see cmdProvision
  ensureRepoSiblings(repo, { force }); // keep the WE pool's constellation siblings current on refresh too
  printStatus(repo);
}

// ── acquire / release (#2275) — the exclusive-lease allocator any flow consumes ─────────────────────
// A consumer (`/drain`, `/merge`, `/batch`, solo `#2123`, `/prepare`, `/decision`) does:
//   export LANE_SESSION=<slug>                                                  # ties acquire↔release together
//   LANE=$(node scripts/lane-pool.mjs acquire --purpose=drain) && cd "$LANE"    # leased, reset to origin/main
//   …work, land its PR…
//   node scripts/lane-pool.mjs release --lane=<n>                              # hand it back to the pool
// The lease is what lets a use-agnostic pool lane safely stand in for the hand-rolled `../we-drain-clean`
// clone: held ⇒ refresh/provision won't reset it out from under the drain (item 2's "a lane may sit on main"
// is just the reset-to-origin/main state below, now protected by the hold).

// Try to claim a specific lane's marker atomically (O_EXCL). Returns the claim's minted HOLDER SLUG (a truthy
// string, #2997) iff THIS call created the marker, else null. A live lease owned by someone else ⇒ null (taken
// — #2337(b), NOT overridable by `--force`; the deliberate override is `release --force` then re-acquire, per
// the ruling's "no new flag" contract). A stale marker ⇒ reclaimed (rm + retry, the small documented race).
// Own live lease ⇒ claimed (idempotent re-acquire) — and that path PRESERVES the existing `holder` slug, so an
// idempotent re-acquire never invalidates the slug the current holder is already asserting.
function tryClaimLane(dir, session, nowMs, ttlMs) {
  // #2367 — stamp a DURABLE session identity (`CLAUDE_CODE_SESSION_ID`, exposed to this subprocess) so a later
  // guard can tell "my own lease" from another live session's AUTHORITATIVELY — it is stable across a session's
  // separate Bash-tool calls yet distinct between concurrent sessions, and does NOT false-match two independent
  // sessions that merely share an upper process ancestor (terminal / a parallel-lane orchestrator). This is the
  // SOLE ownership signal (r2 removed the pid-ancestry fallback, whose chain overlap over-matched exactly that
  // shared-ancestor topology and so failed open while looking protective — see `isForeignLease`, lane-lease.mjs).
  // `pid` stays as an informational-only field (human-readable `status`/debug), never used for ownership.
  const mintedHolder = mintHolderSlug(dir, flags.purpose);
  const bodyFor = (holder, workerSession) => JSON.stringify(
    leaseBody({
      session, purpose: flags.purpose, acquiredAt: new Date(nowMs).toISOString(), ttlMinutes: ttlMinutesFromFlags(),
      host: hostname(), pid: process.pid,
      ownerSession: process.env.CLAUDE_CODE_SESSION_ID || null,
      // #2997 — the minted PER-HOLDER slug, stamped on EVERY acquire rather than only on a `workflowLane` one.
      // #2413 built this exact channel but gated it on that marker, so every other concurrent topology (ad-hoc
      // subagents, the conveyor's `conveyor-*` dispatch) kept falling back to the `ownerSession` compare that
      // cannot separate siblings. Minting it universally is what lets the guards and `release` demand proof of
      // HOLDING (not merely of belonging to the same session) wherever that compare is provably ambiguous.
      holder,
      // #2997 r2 — the DECLARED OCCUPANT. `ownerSession` above records whoever RAN this acquire, which is the
      // DISPATCHER whenever a lane is leased on an agent's behalf — so it can never answer "who is working
      // here". `--adopt` is how the acquirer says "and I am the one who will work in it"; a dispatcher simply
      // omits it and the worker claims the lane later with `adopt --lane=N`. Omitted unless claimed.
      workerSession,
      // #2413 — `--purpose=workflow-lane` MARKS the lease: it stamps the dedicated `workflowLane: true` field
      // (not free-text purpose) that switches the destructive-op guard fail-closed for this lane, requiring a
      // sibling parallel lane to assert this lease's own minted `session` slug before it can clobber the clone.
      workflowLane: flags.purpose === WORKFLOW_LANE_PURPOSE,
      // #2560 — persist the ADVISORY predicted file-scope declared via `acquire --scope=` (omitted when empty,
      // so a scope-less acquire's marker is unchanged). This is the real predicted-scope source the live
      // scope-lease collector/observer reads; it NEVER gates the claim (the O_EXCL marker below is the lock).
      predictedScope: parseScopeFlag(flags.scope),
      // #2350 — `acquire --reserve` stamps a PERMANENT reserved lease: `isLeaseStale` short-circuits it to
      // never-stale, so refresh/provision (even --force) never reset it and auto-pick never couples onto it.
      reserved: !!flags.reserve,
      // #3637 — persist `--base=<ref>` (omitted when absent, so an ordinary acquire's marker is unchanged).
      // Before this the base survived acquire ONLY in the `--json` payload and one stderr line, so a lane
      // forked from a POC branch had nothing durable saying so — and the local branch name cannot say it
      // either, because `checkout -B <repo.branch> <baseRef>` below leaves the lane on a branch named `main`
      // whatever it was based on. `laneBaseRef` is the reader.
      base: typeof flags.base === 'string' ? flags.base : undefined,
    }),
    null, 2,
  ) + '\n';
  // #2997 r2 — `--adopt` means "I am also the agent that will WORK this lane", so stamp the occupant now. A
  // dispatcher acquiring on someone else's behalf omits it and the worker runs `adopt --lane=N` at hand-off.
  const adopted = flags.adopt ? (process.env.CLAUDE_CODE_SESSION_ID || null) : null;
  const file = LEASE_MARKER(dir);
  try {
    writeFileSync(file, bodyFor(mintedHolder, adopted), { flag: 'wx' }); // atomic create-or-fail — the race-free happy path
    return mintedHolder;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const existing = readLease(dir);
  if (leaseOwnedBy(existing, session)) {
    // #2997 — an IDEMPOTENT re-acquire of our own hold KEEPS the existing `holder` slug. Re-minting here would
    // silently invalidate the slug the current holder is already asserting in its commands, turning its next
    // legitimate destructive op into a mismatch deny — a self-inflicted false refusal.
    const holder = laneHolderSlug(existing) || mintedHolder;
    // …and it KEEPS the declared occupant for the same reason: dropping it would silently un-protect a lane an
    // agent is working in. `--adopt` on the re-acquire is the deliberate way to (re-)claim it.
    writeFileSync(file, bodyFor(holder, adopted || laneWorkerSession(existing)));
    return holder;
  }
  if (isLeaseStale(existing, nowMs, ttlMs)) {
    rmSync(file, { force: true });                 // reclaim a stale lease (unlink→create race: acceptable)
    // A reclaim is a NEW hold by a NEW holder, so it mints a fresh slug — the dead owner's slug must not carry
    // over, or a returning zombie would still assert its way past the guard. The dead owner's declared
    // OCCUPANCY is dropped for the same reason (only `--adopt` re-declares it for the new holder).
    try { writeFileSync(file, bodyFor(mintedHolder, adopted), { flag: 'wx' }); return mintedHolder; } catch { return null; }
  }
  return null; // a LIVE lease held by another session — this lane is taken, even with --force
}

// #2748 — the acquire-native reaper pass. Reclaims a PROVABLY-DEAD lease in `repo`'s pool before a fresh
// acquire selects a lane. "Provably dead" = a POSITIVE death signal, never absence-of-activity (the #2267
// data-loss hazard): the lease's item PR is merged/closed (the live gh axis), OR the item card reads
// `status: resolved` on origin/main (the offline axis — resolution is MONOTONIC, so a stale local read only
// MISSES a reap, never wrongly reaps) — AND, #3283, the lease is TTL-stale, because a terminal signal about
// the ITEM says nothing about whether anyone is HOLDING the lane (see `signalsFor` below for the full why).
// The reap VERDICT is the standalone reaper's own pure `classifyReap`
// (via `reapPlan`), so this backstop and the periodic reaper can never disagree — and reserved (permanent
// memory) leases are excluded by `classifyReap` on every axis. TTL-stale reclamation is deliberately LEFT to
// acquire's existing path (`tryClaimLane` reclaims a >TTL lease for THIS session, unchanged) — this pass only
// acts on the NEW terminal axes, so it never changes TTL semantics. Everything is best-effort: a gh/git/fs
// hiccup degrades the axis and leaves the lease in place, never blocks the acquire. Returns the reaped indices.
/**
 * #4025 — the PURE-ISH planning half of the acquire-time ghost-lease backstop, extracted so `cmdTrim` (below)
 * can reuse the EXACT SAME dead-lease liveness logic — never a second, separately-maintained "is this lease
 * really dead" check. Computes the full {@link reapPlan} (`reap`/`keep`, each candidate carrying its `reason`)
 * over every HELD lane in the pool, via the same two death signals `reapDeadLeasesInPool` always has: a
 * best-effort `gh pr list` (PR-terminal) and an offline backlog-frontmatter read (item-resolved-on-main).
 * Read-only — never mutates a lease or a lane. `reapDeadLeasesInPool` (the acquire-time MUTATING backstop)
 * calls this and acts on `pr-merged`/`pr-closed` only, leaving `ttl-stale` to acquire's own reclaim; `cmdTrim`
 * instead treats ANY `reap`-classified lease (ttl-stale included) as "no live holder", because a lane trim is
 * about to physically delete has no "acquire falls through to the next lane" recovery path the way a
 * lease-drop does.
 * @param {object} repo
 * @param {number} nowMs
 * @param {number} ttlMs
 * @returns {{reap: Array<{lane:number, dir:string, lease:object, reason:string}>, keep: Array}}
 */
function deadLeasePlan(repo, nowMs, ttlMs) {
  const candidates = [];
  for (const n of existingLanes(repo)) {
    const dir = laneDir(repo, n);
    const lease = readLease(dir);
    if (lease) candidates.push({ lane: n, dir, lease });
  }
  if (candidates.length === 0) return { reap: [], keep: [] };
  // PR-terminal axis (best-effort, one `gh pr list`): a merged/closed PR whose head ref `lane/<num>-*` maps
  // to a lease's item is a positive death signal. Degrades to OFF (null) if gh is absent / not a GitHub repo.
  let prStates = null;
  try {
    // `timeout` bounds the worst case: a slow/hung/unauthenticated gh must NEVER stall a dispatch acquire —
    // it degrades the PR axis to OFF (the offline item-resolved axis + TTL still apply), never blocks.
    // #x5n4zn3 — already had `timeout` (reconciled, not double-wrapped); added `killSignal` for the same
    // fail-fast certainty every other call site here now gets.
    const out = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '400', '--json', 'number,state,mergedAt,headRefName'], { cwd: repo.referencePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, killSignal: 'SIGKILL' });
    prStates = prStatesFromList(JSON.parse(out));
  } catch { prStates = null; }
  // Item-resolved axis (OFFLINE): read the pool's origin/<branch> backlog listing ONCE, then answer
  // "is item <num>'s card status:resolved?" frontmatter-strict. No fetch — a stale read is safe (monotonic).
  const backlogListing = (tryGit(['ls-tree', '-r', '--name-only', `origin/${repo.branch}`, '--', 'backlog/'], repo.referencePath) || '').split('\n').filter(Boolean);
  const itemResolvedOnMain = (num) => {
    if (!num) return false;
    const path = backlogListing.find((p) => new RegExp(`^backlog/0*${num}-`).test(p));
    if (!path) return false;
    const body = tryGit(['show', `origin/${repo.branch}:${path}`], repo.referencePath);
    return body != null && readField(body, 'status') === 'resolved';
  };
  const signalsFor = (c) => {
    const num = itemNumFromSession(c.lease?.session);
    // #3283 — A TERMINAL SIGNAL ABOUT THE ITEM IS NECESSARY BUT NOT SUFFICIENT. "This lane's item is finished"
    // — its PR merged, or its card resolved on main — answers *is there unlanded work here?* It never answers
    // *is anyone holding this lease?*, and this pass used the first as a proxy for the second. The proxy is
    // sound only once the holder has exited; for every lease whose holder is still working it is simply wrong,
    // so a lane handed out SECONDS ago was reclaimed by the very next acquire — which then returned that same
    // lane. Concurrency collapsed to one lane, and where nothing downstream checks, two agents share a clone.
    //
    // So both axes below are gated on the lease itself looking dead. The one trustworthy liveness signal in
    // today's schema is TTL: `pid` records the short-lived `lane-pool acquire` CLI, not the delivery agent
    // (an LLM has no unix pid — see `lease-reaper.pidAliveForLease`, still the plug-in point for a durable
    // `agentPid`), and `leaseOwnedByCaller` is string equality on every branch, an ownership proof and never
    // a liveness test. This NARROWS #2748 rather than undoing it: a TTL-stale lease whose item is terminal is
    // still reaped HERE, pre-TTL-reclaim and pool-wide, which is the ghost #2748 was built for.
    const holderPresumedGone = isLeaseStale(c.lease, nowMs, ttlMs);
    let prState = holderPresumedGone && prStates && num ? (prStates.get(num) ?? null) : null;
    // Item-resolved is a terminal death signal too — but NEVER override a live (open) PR, mirroring the
    // reaper's "open wins" safety (a same-number retry PR still in flight must not be reaped, #2267).
    if (holderPresumedGone && prState !== 'open' && prState !== 'merged' && prState !== 'closed' && itemResolvedOnMain(num)) prState = 'merged';
    return { prState, pidAlive: null }; // the pid axis is dormant under today's lease schema (see lease-reaper.pidAliveForLease)
  };
  return reapPlan(candidates, { nowMs, ttlMs, signalsFor });
}

function reapDeadLeasesInPool(repo, nowMs, ttlMs) {
  if (flags['no-reap']) return [];
  const { reap } = deadLeasePlan(repo, nowMs, ttlMs);
  const reaped = [];
  for (const c of reap) {
    // Only the NEW terminal axes here — leave 'ttl-stale' to acquire's existing reclaim path. 'reserved' can
    // never appear in `reap` (classifyReap short-circuits it), so no memory lane is ever collected.
    if (c.reason !== 'pr-merged' && c.reason !== 'pr-closed') continue;
    try {
      // #3383 — record the reap in the lane-history ledger BEFORE the marker is dropped (best-effort).
      appendLaneHistory(c.dir, laneHistoryEntry({
        event: 'reap', session: c.lease?.session, ownerSession: c.lease?.ownerSession || null,
        holder: laneHolderSlug(c.lease), item: itemNumFromSession(c.lease?.session), reason: c.reason,
      }));
      rmSync(LEASE_MARKER(c.dir), { force: true });
      unmapLanes(repo, [c.lane]); // a reaped ghost no longer renders its dead item (#2139)
      log(`  reaped lane-${c.lane} before acquire (${c.reason}; was ${describeLease(c.lease)}) — ghost lease reclaimed (#2748)`);
      reaped.push(c.lane);
    } catch { /* best-effort — a failed reclaim just leaves the lane held (acquire falls through to the next free lane) */ }
  }
  return reaped;
}

function cmdAcquire(repo) {
  // #2386 — `--base` and `--no-reset` are mutually exclusive: `--base=<ref>` means "reset this clone to <ref>",
  // and `--no-reset` skips the reset entirely. Honoring both would skip the reset yet still report the base as
  // applied (log line + JSON `base`), so an orchestrator stacking a serial batch would believe the lane sits on
  // the predecessor tip when HEAD was never moved. Reject the combo BEFORE claiming any lane (touches nothing) —
  // failing loud beats silently misreporting for a primitive other automation trusts.
  if (flags.base && flags['no-reset']) {
    fail(`--base=${flags.base} and --no-reset are mutually exclusive: --base resets the clone to that ref, which --no-reset would skip. Pass one or the other.`);
  }
  // #2350 — `--reserve` mints a PERMANENT reserved lane, which must be a SPECIFIC, known slot (the dedicated
  // memory-lane), never an auto-picked one — permanently reserving whichever lane happens to be free would be
  // a footgun. Require an explicit `--lane=N` (and a `--session` so the reserved hold has a stable, human-named
  // owner) before anything is claimed.
  if (flags.reserve && flags.lane === undefined) {
    fail('--reserve requires an explicit --lane=N (a permanent reserved lane is a specific, known slot — never auto-picked)');
  }
  const session = defaultSession();
  const nowMs = Date.now();
  const ttlMs = ttlMsFromFlags();
  // #2748 — REAPER BACKSTOP, native to acquire. BEFORE selecting a lane, reclaim any PROVABLY-DEAD ghost lease
  // in this pool — a lease whose item has merged/resolved, or whose PR is merged/closed — so a finished-but-
  // -unreleased lane (a dead agent's lingering lease that the drain's release-on-land could NOT clear, because
  // no land event ever fired for it) never blocks a fresh dispatch. This makes the pool ACT on the exact ghost
  // the conveyor board's health scan only FLAGS (#2616/#2700). Best-effort; `--no-reap` opts out (tests).
  reapDeadLeasesInPool(repo, nowMs, ttlMs);
  // #2560 — the ADVISORY predicted file-scope this acquire declares (empty when no `--scope`). Persisted into the
  // marker (via tryClaimLane) AND used for the strictly-non-blocking overlap warning below. It NEVER gates.
  const declaredScope = parseScopeFlag(flags.scope);
  const lanes = existingLanes(repo);
  // #3627 follow-up (secondary finding) — name the RESOLVED pool root in the failure: a caller whose cwd sits
  // outside the expected workspace root (e.g. a scratch clone) silently resolves `repo.poolDir` to an empty or
  // wrong location, and "no lanes provisioned" alone gives no way to tell "never provisioned" apart from
  // "looking in the wrong place" (the latter is fixed with `LANE_POOL_ROOT`, but only once it's diagnosable).
  if (lanes.length === 0) fail(`no lanes provisioned for "${repo.name}" under ${repo.poolDir} — run \`provision --count=N\` first (if this pool root looks wrong, see LANE_POOL_ROOT)`);

  // Candidate infos from LOCAL refs (no per-lane fetch): `dirty` is live (working tree), `ahead` is vs the
  // last-known origin — conservative (over-protects an ahead lane). We fetch+reset only the winner.
  // #2452 (Gap 1) — the live-remote snapshot backing `aheadIsProvablyPushed`, taken LAZILY: only the first
  // lane that actually looks ahead pays the single `ls-remote`, so a pool with no ahead lanes still makes
  // zero network calls (the no-per-lane-fetch property this design is built around).
  let remoteShas = null;
  // #3383 — track an outright PROBE FAILURE (not merely "no SHAs"), the same distinction `cmdProvision`'s
  // `remoteShasBox` makes (#4025): a `ls-remote` that fails/times out must never be misread by this acquire's
  // own growth-on-empty fallback (below) as "genuinely nothing pushed, therefore safe/needed to grow".
  let remoteProbeFailed = false;
  const getRemoteShas = (dir) => {
    if (remoteShas === null) {
      const probe = liveRemoteShasProbe(dir);
      remoteShas = probe.shas;
      if (!probe.ok) remoteProbeFailed = true;
    }
    return remoteShas;
  };
  const infoFor = (n, pickNowMs) => {
    const dir = laneDir(repo, n);
    if (!existsSync(dir)) return { lane: n, exists: false };
    // #xn432dz — lease-first, same as `laneAcquirableInfo`: a LIVE lease already makes `chooseFreeLane`'s
    // `isLaneAcquirable` false, so skip the git probe for it. `pickNowMs` is the same clock `chooseFreeLane`
    // reads below, so the two staleness reads agree. (The explicit `--lane=N` path never calls this.)
    const lease = readLease(dir);
    if (leaseDisqualifiesAcquire(lease, pickNowMs, ttlMs)) return { lane: n, exists: true, dirtyOrAhead: null, lease };
    // #3383 — `effectiveDirtyOrAhead` applies BOTH acquire-time-only relaxations (ancestor-OR-patch-equivalent
    // "ahead", litter-only "dirty"); `refreshLane`/`laneStatus` keep reading `laneDirtyOrAhead`'s raw fact.
    // Fails closed either way: unproven ⇒ stays protected (#2267).
    const dirtyOrAhead = effectiveDirtyOrAhead(dir, repo.branch, () => getRemoteShas(dir));
    return { lane: n, exists: true, dirtyOrAhead, lease };
  };

  let chosen = null;
  // #2350 — was the explicitly-targeted lane ALREADY reserved before this acquire? Captured pre-claim so the
  // reset path below can be skipped for an idempotent re-reserve (never `reset --hard` an already-populated
  // memory lane out from under itself).
  let targetWasReserved = false;
  // #2997 — the per-holder slug this acquire minted, reported back to the acquirer below. It is the ONLY thing
  // that distinguishes this holder from a sibling agent of the same session, so the acquirer must receive it.
  let holderSlug = null;
  if (flags.lane !== undefined) {
    // Explicit lane: honor it or fail loudly (don't silently divert to another).
    const n = Number(flags.lane);
    const dir = laneDir(repo, n);
    if (!existsSync(dir)) fail(`lane-${n} does not exist (${dir})`);
    // #2350 — a RESERVED lane is off-limits to an ordinary acquire, INCLUDING the OWNING session's own plain
    // re-acquire. Without this pre-claim guard, `tryClaimLane`'s `leaseOwnedBy` self-refresh would rewrite the
    // marker as an ordinary (non-reserved) lease and then the reset path below would `reset --hard` the lane —
    // silently un-reserving it and WIPING the memory it exists to hold (the exact footgun #2350 prevents).
    // Only `--reserve` may touch a reserved lane (an idempotent re-reserve, which keeps `reserved:true`).
    const preExisting = readLease(dir);
    if (isReservedLease(preExisting)) {
      if (!flags.reserve) {
        fail(
          `lane-${n} holds a ${describeLease(preExisting)} lease — a PERMANENT reserved lane, off-limits to acquire. ` +
            `Un-reserve it first (\`release --lane=${n} --release-reserved\`) if you truly mean to reclaim it, or pick another lane.`,
        );
      }
      targetWasReserved = true; // an idempotent re-reserve — skip the reset so accrued content survives
    }
    holderSlug = tryClaimLane(dir, session, nowMs, ttlMs);
    if (!holderSlug) {
      const lease = readLease(dir);
      // #2350 — a RESERVED (permanent) lane is off-limits to an ordinary acquire; point at the deliberate
      // un-reserve (`release --release-reserved`), NOT `release --force` (which never drops a reserved lease).
      if (isReservedLease(lease)) {
        fail(
          `lane-${n} holds a ${describeLease(lease)} lease — a PERMANENT reserved lane, off-limits to acquire. ` +
            `Un-reserve it first (\`release --lane=${n} --release-reserved\`) if you truly mean to reclaim it, or pick another lane.`,
        );
      }
      // #2337(b) — a LIVE lease hard-fails `acquire --lane=N --force` too (force never overrides a live
      // lease); point at the deliberate override (`release --force`) instead of implying --force helps.
      if (lease && !isLeaseStale(lease, nowMs, ttlMs)) {
        fail(
          `lane-${n} is ${describeLease(lease)} — a LIVE lease; --force does not override it (#2337). ` +
            `Release it first (\`release --lane=${n} --force\`), then acquire, or pick another lane.`,
        );
      }
      fail(`lane-${n} is ${describeLease(lease) || 'held'} — pick another lane`);
    }
    // #3390 — the explicit-lane path is the ONLY claim route that reaches the destructive reset below with no
    // #2267 dirty/ahead check at all: auto-pick's `chooseFreeLane` never selects a dirty/ahead candidate to
    // begin with, and `refreshLane` calls `laneDirtyOrAhead` explicitly, but a TTL-stale reclaim just above
    // (`tryClaimLane`'s `isLeaseStale` branch) unlinks the old marker and lets this path fall straight through
    // to `checkout -B --force` + `clean -fd`. A lease going stale (a long session, a slow multi-hour task) is
    // NOT evidence the tree holds abandoned garbage. Real incident: lane-11's lease went TTL-stale mid-epic
    // with 4 built-and-tested files sitting as uncommitted/untracked edits; this exact path silently destroyed
    // them (recovered only from Claude Code's own session transcripts, not from anything git-recoverable).
    // Skipped when the reset itself would be skipped (`--no-reset`, or the reserved-lane re-reserve path,
    // which never resets either) so this never blocks an acquire that was never going to touch the tree.
    if (!flags.force && !targetWasReserved && !flags['no-reset']) {
      const { uncommitted, ahead } = laneDirtyOrAhead(dir, repo.branch);
      // #3383 — litter-only "dirty" (known-safe agent scratch, `we:scripts/lib/lane-litter.mjs`'s allowlist)
      // must not force an explicit `--lane=N` acquire into `--force` any more than it forces auto-pick to
      // skip the lane (`infoFor` applies the identical relaxation). `ahead` deliberately stays the RAW fact
      // here — #2452's provably-pushed relaxation is scoped to auto-pick only; an explicit target that is
      // genuinely ahead still needs `--force`.
      const dirty = litterAdjustedDirty(dir, uncommitted > 0);
      if (dirty || ahead > 0) {
        fail(
          `lane-${n} has ${uncommitted} uncommitted change(s) and is ${ahead} commit(s) ahead of origin/${repo.branch} ` +
            `— acquire --lane=${n} would destroy that work via its reset-to-origin step. Use --force to reclaim it ` +
            `anyway (mirrors every other destructive override in this file), or investigate/salvage the tree first.`,
        );
      }
    }
    chosen = n;
  } else {
    // Auto-pick: lowest acquirable, then atomically claim; on a lost race retry the next candidate.
    //
    // #x3jmao3 — a full pool used to hard-fail on the VERY FIRST reading, no matter how momentary: live-caught
    // 2026-09-04 (PR #1908's independent review) when a background review session's own `acquire` read "42 all
    // held/dirty" and gave up instantly, even though the pool freed up again within minutes under real
    // concurrent load. `--wait-ms=<total>` is the OPT-IN fix: poll for up to that long (spaced by
    // ACQUIRE_POLL_MS, no busy-wait) before failing, so a momentary capacity flicker self-heals. Omitted
    // (the default) reproduces today's instant-fail exactly — no behavior change for any existing caller
    // that doesn't ask for this. A pool with genuinely zero capacity for the whole window still fails with
    // the IDENTICAL message, just after the bound elapses rather than on the first read.
    const waitMs = flags['wait-ms'] !== undefined && Number.isFinite(Number(flags['wait-ms'])) ? Math.max(0, Number(flags['wait-ms'])) : 0;
    const deadline = nowMs + waitMs;
    const excluded = new Set();
    // The caller's OWN lane, if they are standing in one. Auto-pick skips it: acquiring resets the lane to
    // the integration branch, so returning the lane the caller is working in changes their checkout out from
    // under them (observed 2026-09-06 — a bare `acquire --purpose=review-juror` returned the driving lane).
    // A preference, not a refusal, and only for auto-pick: an explicit `--lane=N` is honoured as asked.
    // Pool-SCOPED (#1961 finding 3): a lane number only counts as "mine" when the cwd is inside the pool
    // being acquired from. Pure helper so the parsing is under test, not an inline regex nothing exercises.
    const selfLane = ownLaneNumber(resolveReal(process.cwd()), resolveReal(repo.poolDir), sep);
    // #3383 — live incident 2026-09-24: EVERY review dispatch failed with "no free lane" on a 60-lane pool
    // where only ~3-4 lanes were actually acquirable (the rest held real work or sat ahead-of-origin) — acquire
    // itself never grows the pool, it only waits then fails. `grownOnce` bounds this to ONE growth attempt per
    // `acquire` call (never a second round in the same call, however many times the loop above re-polls).
    let grownOnce = false;
    while (chosen === null) {
      const pickNowMs = Date.now();
      const infos = lanes.filter((n) => !excluded.has(n)).map((n) => infoFor(n, pickNowMs));
      const pick = chooseFreeLane(infos, pickNowMs, ttlMs, { excludeLane: selfLane });
      if (pick === null) {
        if (Date.now() < deadline) {
          sleepSyncMs(ACQUIRE_POLL_MS);
          excluded.clear(); // a lane held/dirty a moment ago may have freed (or gone TTL-stale) since
          continue;
        }
        // #3383 — before failing outright, let the pool GROW A LITTLE rather than block every dispatch on a
        // human running `provision` by hand. Bounded two ways, mirroring #4025's provision --acquirable guards
        // exactly: a small per-call cap on brand-new clones (reaching it just means "ask again"), and a hard
        // ceiling well above the trim target that growth may never cross. A live remote-probe failure disables
        // growth entirely (fail-SAFE STOP, never fail-safe GROW) — same rationale as #4025.
        if (!grownOnce) {
          grownOnce = true;
          const added = growPoolOnEmpty(repo, lanes, remoteProbeFailed);
          if (added > 0) {
            excluded.clear();
            continue;
          }
        }
        fail(`no free lane in pool "${repo.name}" (${lanes.length} all held/dirty) — release one or \`provision\` more`);
      }
      const claimed = tryClaimLane(laneDir(repo, pick), session, Date.now(), ttlMs);
      if (claimed) { chosen = pick; holderSlug = claimed; }
      else excluded.add(pick); // a concurrent acquire won this one — try the next
    }
  }

  // #2560 (§3i-A4 Fork 1) — ADVISORY, STRICTLY NON-BLOCKING scope-overlap check. Runs AFTER the atomic O_EXCL
  // claim above (the whole-clone lease is the REAL lock): this only WARNS to stderr if the declared scope
  // overlaps a sibling lane's predicted scope. It does NOT gate, block, delay, or change which lane won — the
  // lane is already claimed. Wrapped so a scope-check failure can NEVER throw into the acquire path.
  if (declaredScope.length) {
    const others = existingLanes(repo)
      .filter((n) => n !== chosen)
      .map((n) => ({ n, lease: liveLease(laneDir(repo, n), nowMs, ttlMs) }))
      .filter((x) => x.lease)
      .map((x) => ({ lane: x.n, predictedScope: x.lease.predictedScope ?? [], observedScope: [] }));
    try {
      const res = candidateLaunch({ candidateScope: declaredScope, leases: others });
      if (res.outcome !== 'launch') {
        log(`  ⚠ advisory (non-blocking): lane-${chosen} declared scope overlaps lane(s) ${res.waitOn?.length ? res.waitOn.join(', ') : '(see picture)'} — the whole-clone lease is the real lock; proceeding.`);
      }
    } catch { /* advisory only — never let a scope-check failure affect the acquire */ }
  }

  // Ready the leased lane: land on origin/<branch> (item 2 — a lane may sit on main), regen env + deps so it
  // is immediately gate-able, exactly like a provisioned lane. `--no-reset` keeps HEAD.
  // #2386 — `--base=<ref>` lands the clone at a PREDECESSOR LANE'S TIP instead, the building block for
  // overlap-stacked serial batches (a later lane's work builds on an earlier lane's not-yet-merged commits).
  // Still a pool clone — this never touches the primary checkout (#2219/#104): the ref is resolved and reset
  // to INSIDE this lane's own clone, same as the origin/<branch> default path it replaces.
  // #2350 — an idempotent re-reserve (`acquire --reserve --lane=N` on an already-reserved lane) NEVER resets:
  // resetting would `reset --hard` + `clean -fd` the reserved lane's accrued content (the memory it holds).
  // A FIRST reserve of a not-yet-reserved lane still resets (clean-populate to origin/main), like any acquire.
  const dir = laneDir(repo, chosen);
  if (!flags['no-reset'] && !targetWasReserved) {
    fetchOriginPruneWithRetry(dir);
    // #2924 — re-verify containment on FRESH post-fetch remote-tracking refs, immediately before the
    // destructive reset below. Whatever proved this lane safe to reset — auto-pick's `infoFor()` snapshot, or
    // nothing at all before #3390's own explicit-lane guard — is up to ~30s stale by the time this line runs
    // (the merge-base fan-out, the O_EXCL claim, the fetch just above). A `lane/*` ref deleted or force-pushed
    // on origin inside that window means the earlier proof no longer holds. Network-free: the fetch above
    // already refreshed every remote-tracking ref, so `localRemoteShas` answers from local state alone.
    if (!flags.force) {
      const { uncommitted, ahead } = laneDirtyOrAhead(dir, repo.branch);
      // #3383 — re-apply the SAME litter relaxation `infoFor`'s earlier auto-pick snapshot already granted
      // this lane (or that an explicit `--lane=N` acquire's own pre-claim check just granted it, just above):
      // without this, a litter-only-dirty lane picked exactly because it looked acquirable would immediately
      // fail this re-verify, one line later, on the identical litter it was already cleared for.
      const dirty = litterAdjustedDirty(dir, uncommitted > 0);
      const provablyPushed = ahead === 0 || aheadIsProvablyPushed(dir, localRemoteShas(dir), repo.branch);
      if (dirty || !provablyPushed) {
        fail(
          `lane-${chosen} is no longer provably safe to reset as of this fetch (${uncommitted} uncommitted, ` +
            `${ahead} ahead, provably-pushed=${provablyPushed}) — a ref its earlier containment proof relied on ` +
            `may have been deleted or force-pushed in the window since (#2924). Use --force to proceed anyway, ` +
            `or investigate/salvage the tree first.`,
        );
      }
    }
    const baseRef = flags.base ? resolveBaseRef(dir, flags.base, chosen) : `origin/${repo.branch}`;
    // #2419 — `checkout -B <branch> <baseRef>`, NOT `reset --hard <baseRef>`. A bare reset moves whatever
    // branch HEAD happens to be attached to (it does not touch which branch that is), so a lane left
    // attached to a STRAY `lane/*` tip (a leftover from an earlier rebase-drop or a manual checkout — #2419's
    // primary cause) stayed attached to that stray branch forever after, just with fresher content. Every
    // downstream reader that assumes a lane sits on `repo.branch` (e.g. the drain's post-land `pull --ff-only`,
    // which needs an attached branch WITH an upstream) then silently no-ops or numbers off the wrong parent.
    // `checkout -B` creates-or-resets `repo.branch` (e.g. `main`) to `baseRef` AND checks it out in the same
    // atomic step, so every reset/acquire always leaves the lane on its own well-known local branch — never a
    // stray one — closing the strand at its source rather than only papering over it downstream. `--force` is
    // REQUIRED here (pre-PR review catch, #2419): unlike `reset --hard`, a bare `checkout -B` still runs the
    // ordinary safe-checkout tree-merge and REFUSES ("local changes would be overwritten by checkout") on a
    // dirty tracked-file conflict — reproduced live against a scratch repo. `acquire` has never gated this
    // reset on tree cleanliness (unlike `refreshLane`'s explicit `laneDirtyOrAhead` guard) — it must
    // unconditionally reclaim a lane regardless of stray edits left by a prior crashed/interrupted session, so
    // `--force` restores that same never-refuses guarantee `reset --hard` always gave it.
    git(['checkout', '-B', repo.branch, baseRef, '--quiet', '--force'], dir);
    git(['clean', '-fd', '--quiet'], dir);
    unmapLanes(repo, [chosen]); // a reset lane no longer renders its old item (#2139)
  }
  writeLaneEnv(repo, chosen);
  if (!flags['no-install']) ensureDeps(dir);
  // #2616 — record this lane's item → lane mapping in the PRIMARY checkout's lane-ports registry (the SAME
  // registry #2139's `map` writes and conveyor-state's health-stall scan reverse-derives lane→num from). A
  // conveyor delivery agent acquires its OWN lane and claims its OWN item, so nothing else calls `map` for it —
  // without this the registry stays `{}`, no lane carries a num, and the stall scan is permanently INERT
  // (`assessHealth` always `ok`, a stalled lane never surfaced). Runs HERE, after the reset's
  // `unmapLanes(chosen)`, so the fresh entry is never immediately cleared; the pre-map `unmapLanes` drops any
  // stale item still pointing at this lane (needed on the `--no-reset` path, where the reset's unmap did not run)
  // so lane→num stays 1:1. A band-less pool records `{ lane }` (no page port) — all the health scan needs.
  // Wrapped so a registry-write hiccup can NEVER fail the acquire (advisory, like the scope-overlap check above),
  // and the map log rides stderr so `--json`-less stdout stays the clean lane path (the `LANE=$(…)` contract).
  if (flags.item !== undefined) {
    const items = String(flags.item)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s) || /^x[a-z0-9]{5,7}$/i.test(s));
    if (items.length) {
      try {
        unmapLanes(repo, [chosen]); // drop any stale item→this-lane entry first (a no-op right after a reset unmap)
        registerItemsToLane(repo, chosen, items);
        log(`  mapped item(s) ${items.join(', ')} → lane-${chosen} in ${registryPath(repo)} (#2616 health-stall map)`);
      } catch (e) {
        log(`  ⚠ could not record item→lane map (#2616) — the health-stall scan may stay inert for lane-${chosen} (${e.message})`);
      }
    }
  }
  // NOTE: do NOT re-run ensureRepoSiblings here. It resolves each sibling's primary from the *reference*
  // checkout's parent — correct only when run from the primary; run from INSIDE a lane (a consumer's cwd) it
  // mis-points the shared pool-root sibling clones at itself. The pool-root siblings are a provision/refresh
  // concern; a leased lane borrows a pool those already set up. (Regressed a live acquire until caught — #2275.)
  log(`${flags.reserve ? 'RESERVED' : 'acquired'} lane-${chosen} for ${session}${flags.purpose ? ` (${flags.purpose})` : ''}${flags.base ? ` @ base=${flags.base}` : ''}${flags.reserve ? ' — PERMANENT, off-limits to acquire/refresh/provision (#2350)' : ''} → ${dir}`);
  // #2997 — hand the acquirer its minted holder slug. This is the one signal that separates THIS holder from a
  // sibling agent of the same session, so it must reach the acquirer and nowhere else. It is needed only in the
  // CONTESTED topology (another live lease shares this session id), which is exactly when the guards and
  // `release` ask for it — hence "keep it if a sibling is live", not "prefix everything from now on".
  // Rides stderr (`log`) so `--json`-less stdout stays the clean lane path the `LANE=$(…)` contract depends on.
  log(`  holder slug: ${holderSlug} — if a SIBLING agent of your session also holds a lane, prove this one is yours:`);
  log(`    release:        node scripts/lane-pool.mjs release --lane=${chosen} --session=${holderSlug}`);
  log(`    destructive op: LANE_SESSION=${holderSlug} git reset --hard origin/${repo.branch}`);
  // #2997 r2 — OCCUPANCY is a separate declaration from the lease, because `ownerSession` records whoever ran
  // THIS process, which for a dispatched lane is not the agent that will work in it. Say so at the seam.
  const occupant = laneWorkerSession(readLease(dir));
  // #3383 — record this acquire in the lane-history ledger (best-effort; never fails the acquire itself).
  appendLaneHistory(dir, laneHistoryEntry({
    event: flags.reserve ? 'reserve' : 'acquire',
    session,
    ownerSession: process.env.CLAUDE_CODE_SESSION_ID || null,
    workerSession: occupant,
    purpose: flags.purpose,
    item: flags.item,
    holder: holderSlug,
  }));
  if (occupant) log(`  occupant: ${occupant} (--adopt) — Edit/Write from any OTHER session is now refused (#2997)`);
  else log(`  occupant: NOT declared — hand this lane off with \`node scripts/lane-pool.mjs adopt --lane=${chosen}\` run BY the agent that will work in it (or re-run acquire with --adopt if that is you); until then the Edit/Write guard stays fail-open for this lane`);
  if (flags.json) process.stdout.write(JSON.stringify({ lane: chosen, path: dir, session, holder: holderSlug, workerSession: occupant, purpose: flags.purpose || null, branch: repo.branch, base: flags.base || null, reserved: !!flags.reserve }, null, 2) + '\n');
  else process.stdout.write(dir + '\n'); // stdout = path only, so `LANE=$(… acquire)` captures it clean
}

// #2386 — resolve `--base=<ref>` inside a lane's own clone, AFTER its `fetch origin` so a predecessor lane's
// pushed `lane/*` tip is visible as `origin/<ref>`. Tries `origin/<ref>` FIRST — this is the freshly-fetched,
// authoritative source for "a predecessor lane's PUSHED tip" — falling back to the ref as literally given only
// if that doesn't resolve (a raw SHA, or a ref the caller already fully qualified, e.g. `origin/lane/…`).
// Order matters: trying the bare ref first would resolve `--base=main` to THIS LANE'S OWN stale local `main`
// branch (wherever it was left by the last reset, e.g. a prior `--base` acquire) instead of the origin tip this
// `fetch` just pulled — `fetch` only updates remote-tracking refs, never a checked-out local branch of the same
// name, so a same-named local ref silently shadowing the fresh origin one would be a hard-to-notice stale-data
// bug, not a loud failure. Caught live: acquiring with `--base=main` after origin/main advanced past the lane's
// last reset returned the OLD content with no error until this ordering was flipped.
function resolveBaseRef(dir, ref, laneNum) {
  const withOrigin = `origin/${ref}`;
  if (tryGit(['rev-parse', '--verify', '--quiet', withOrigin], dir)) return withOrigin;
  if (tryGit(['rev-parse', '--verify', '--quiet', ref], dir)) return ref;
  fail(
    `--base=${ref} does not resolve in lane-${laneNum}'s clone (tried "${withOrigin}" and "${ref}") — ` +
      `push it to origin first (a local-only ref on another checkout is not visible here), or pass a ref ` +
      `that already exists on origin.`,
  );
}

// #2350 (review:changes on #745) — `--release-reserved` is the ONE deliberate un-reserve, and it is
// single-lane BY CONTRACT: un-reserving (or removing) the memory lane is a specific, named act, never a side
// effect of a bulk `--all` sweep. Reject the combination so `release --all --release-reserved` (and, with the
// remove-guard escape hatch, `remove --all --release-reserved`) can never set `bypassOwnership` for EVERY
// reserved lease and silently drop the memory lane — require an explicit single `--lane=N`.
function assertReleaseReservedScoped() {
  if (flags['release-reserved'] && flags.all) {
    fail('--release-reserved may not be combined with --all — it is the deliberate single-lane un-reserve; pass an explicit --lane=N');
  }
}

// #2667 — cross-pool release-by-session. `release --all-pools --session=<slug>` sweeps EVERY pool under
// POOL_ROOT and hands back every lane that `<slug>` leases — clearing a cross-locus couple's lease in the WE
// pool AND the plateau-app pool in ONE call (the exact toil the auto-release + this selector remove). It is BY
// SESSION on purpose: the lease markers themselves record the owning session at acquire (dispatch) time, so a
// by-session sweep needs no separate `(pool, lane)` ledger — the markers ARE that record. A blanket cross-pool
// `--all` would nuke every session's leases everywhere, so `--all-pools` REQUIRES `--session` and refuses
// `--all`. Reserved (permanent memory) leases are always skipped — a sweep never un-reserves.
function cmdReleaseAllPools(repo) {
  const session = flags.session || process.env.LANE_SESSION || null;
  // #2748 — a by-ITEM selector generalizes the #2667 by-session sweep so the DRAIN can release an item's lease
  // across every pool at LAND WITHOUT knowing the exact session slug: it matches every lease whose session
  // ENCODES this item number (`conveyor-<num>` / `fix-<num>` / `prepare-<num>` — the same trailing-number rule
  // the reaper's `itemNumFromSession` uses), compared NUMERICALLY so `--item=99` matches `conveyor-99`. This is
  // the universal cleanup key the drain owns: it already has the item number at land (from the queued manifest),
  // for every land path (conveyor / solo /pr / /finish), whereas the exact session slug it does not.
  const itemFlag = flags.item !== undefined ? String(flags.item).trim() : null;
  const wantItem = itemFlag != null && itemFlag !== '' ? Number(itemFlag) : null;
  if (!session && wantItem == null) {
    fail('release --all-pools requires --session=<slug> or --item=<num> — it releases THAT session\'s (or item\'s) leases in every pool; a blanket cross-pool release is deliberately not offered');
  }
  if (session && wantItem != null) {
    fail('release --all-pools takes --session OR --item, not both — pick the one selector for the targeted cross-pool release');
  }
  if (flags.all) {
    fail('release --all-pools --all is not allowed — cross-pool release is BY SESSION / BY ITEM (targeted); pass --session=<slug> or --item=<num> alone');
  }
  // The selector predicate: by exact session (#2667) or by encoded item number (#2748).
  const selects = (lease) => {
    if (session) return leaseOwnedBy(lease, session); // only THIS session's leases — never a foreign one
    const n = itemNumFromSession(lease.session);       // by-item: the lease's session encodes this item number
    return n != null && Number(n) === wantItem;
  };
  const selectorLabel = session ? `session "${session}"` : `item #${wantItem}`;
  // #3466 — same registry-must-mirror-reality contract `cmdRelease` was just fixed to keep: `--all-pools` does
  // the identical mutating thing (`rmSync(LEASE_MARKER(dir))`) via a SEPARATE code path, and it is the one the
  // drain's land-time cleanup (`lane-drain.mjs`'s `releaseItemLeases`) and pr-watch's merge-time auto-release
  // (`pr-watch.mjs`'s `releaseSessionAcrossPools`) actually call — the dominant real-world release triggers, not
  // just the reaper's reclaim. `referencePath` REUSES `repo.referencePath` from `resolveRepo()` (already
  // git-toplevel-normalized) rather than a raw `resolve(process.cwd())` — round-2 review caught that the raw
  // form computes a WRONG registry path (and so silently no-ops) whenever the caller's cwd is a subdirectory
  // of the checkout, exactly `pr-watch.mjs`'s `releaseSessionAcrossPools` call shape (no `cwd` override on its
  // `execFileSync`, so it inherits whatever directory that process happens to be running from).
  const pools = existingPools();
  const perPool = [];
  let released = 0;
  for (const name of pools) {
    const poolDir = join(POOL_ROOT, name);
    const lanes = [];
    for (const n of laneIndicesIn(poolDir)) {
      const dir = join(poolDir, `lane-${n}`);
      const lease = readLease(dir);
      if (!lease) continue;
      if (!selects(lease)) continue; // only the selected session's / item's leases — never a foreign one
      if (isReservedLease(lease)) {
        // A reserved lane owned by this session is still off-limits to a bulk sweep (its whole point is to
        // survive routine release); un-reserving stays the deliberate single-lane `--release-reserved` act.
        log(`  ${name}/lane-${n}: ${describeLease(lease)} — reserved; skipped (un-reserve is single-lane --release-reserved)`);
        continue;
      }
      rmSync(LEASE_MARKER(dir), { force: true });
      log(`  released ${name}/lane-${n} (was ${describeLease(lease)})`);
      lanes.push(n);
      released++;
    }
    if (lanes.length) {
      perPool.push({ pool: name, lanes });
      // #3466 — drop THIS pool's released lanes from the shared item→lane registry. `name` (not `repo.name`)
      // is the pool this iteration actually released from — round-2 review caught that `unmapLanes` matches
      // by `repo` field as well as lane number (see its own comment), so passing the wrong pool name here
      // would silently fail to clear this pool's own entries.
      unmapLanes({ referencePath: repo.referencePath, name }, lanes);
    }
  }
  if (released === 0) log(`  no leases held by ${selectorLabel} in any pool (${pools.length} pool(s) scanned)`);
  if (flags.json) process.stdout.write(JSON.stringify({ session: session || null, item: wantItem, released, pools: perPool }, null, 2) + '\n');
}

function cmdRelease(repo) {
  assertReleaseReservedScoped();
  if (flags['all-pools']) return cmdReleaseAllPools(repo); // #2667 — cross-pool release-by-session
  const session = defaultSession();
  const force = !!flags.force;
  const nowMs = Date.now();
  const ttlMs = ttlMsFromFlags();
  let targets;
  // #2452 review — `targeted` is load-bearing for ownership, not cosmetic: only a release that NAMES one lane
  // may use the durable-`ownerSession` fallback below. A `--all` sweep keeps the exact-`session` rule.
  let targeted;
  if (flags.all) { targets = existingLanes(repo).filter((n) => readLease(laneDir(repo, n))); targeted = false; } // every held lane
  else if (flags.lane !== undefined) { targets = [Number(flags.lane)]; targeted = true; }
  else return fail('release needs --lane=N or --all');
  let released = 0;
  for (const n of targets) {
    const dir = laneDir(repo, n);
    const lease = readLease(dir);
    if (!lease) { log(`  lane-${n}: no lease to release`); continue; }
    // #2350 — a RESERVED (permanent) lane is NEVER handed back by an ordinary `release` (not even `--force`):
    // its whole point is to be a durable, off-limits slot. Only the deliberate `--release-reserved` un-reserve
    // drops it. This keeps a stray `release --all` / `--force` from silently un-reserving the memory-lane.
    if (isReservedLease(lease) && !flags['release-reserved']) {
      log(`  lane-${n}: ${describeLease(lease)} — a PERMANENT reserved lane; --force does not release it. Pass --release-reserved to deliberately un-reserve.`);
      continue;
    }
    // #2350 — `--release-reserved` bypasses the ownership check ONLY for a RESERVED lease (its reserving owner
    // is a fixed slug, so the human un-reserving is typically a different session). It must NOT double as a
    // `--force` for an ordinary FOREIGN lease — that still requires the explicit `--force`.
    const bypassOwnership = force || (flags['release-reserved'] && isReservedLease(lease));
    // #2452 (Gap 2) — ownership is decided by `leaseOwnedByCaller`, NOT the bare `leaseOwnedBy(lease, session)`
    // exact-string match: `session` here is `defaultSession()`, which falls back to `${hostname()}:${process.ppid}`
    // when no `--session`/`LANE_SESSION` is given, and a shell's ppid differs across separate invocations — so
    // the very session that ACQUIRED a lease read as foreign on a later `release` call and had to `--force`.
    // `leaseOwnedByCaller` still honors an exact `session` match FIRST (the minted slug a MARKED workflow-lane
    // lease requires), then — ONLY for a `--lane=N`-targeted release — falls back to the durable `ownerSession`
    // (`CLAUDE_CODE_SESSION_ID`) signal #2367 already uses for foreign-lease detection, stable across a
    // session's separate Bash-tool calls. #2452 review — the `--all` SWEEP is deliberately excluded: sibling
    // conveyor lanes are UNMARKED yet share one `ownerSession`, so a bare `release --all` would otherwise drop
    // a sibling's live hold with no `--force`. Naming the lane is what makes the intent unambiguous.
    // #2997 — …and `targeted` alone was NOT enough. On 2026-08-14 a subagent ran `release --lane=5` meaning
    // its OWN lease and released a DIFFERENT concurrent holder's: both leases carried the same parent
    // `CLAUDE_CODE_SESSION_ID`, so the step-2 fallback resolved to "same session, therefore mine". Naming a
    // lane proves the caller MEANT that lane, never that it HOLDS it. So when the lease is CONTESTED — another
    // LIVE lease in this pool shares its `ownerSession`, i.e. a sibling agent of mine is holding a lane right
    // now — the ambient id is provably ambiguous and the fallback is refused; ownership must come from the
    // minted `holder` slug (passed as `--session=`/`LANE_SESSION=`) or the explicit `--force`. Nothing was lost
    // in that incident only because the other holder had already finished; a released lane is immediately
    // re-issuable and the next `acquire` resets it, so `release` alone is a data-loss path, not a bookkeeping one.
    const mySessionId = process.env.CLAUDE_CODE_SESSION_ID || null;
    // #2997 r2 (review F2) — staleness-check the SUBJECT lease too, not only the siblings. Without this an
    // EXPIRED lease sharing its `ownerSession` with a live sibling read as CONTESTED and became unreleasable
    // without `--force` — a regression against main, and a direct contradiction of this item's own ruling that
    // "a stale lease reads as no lease, EVERYWHERE" (true in guard-bash.mjs and guard-lane.mjs, false here).
    // A dead holder has nothing to protect: there is no one to be confused with, so nothing to prove.
    const contested = !isLeaseStale(lease, nowMs, ttlMs)
      && isContestedLease({ lease, siblingLeases: liveLeasesInPoolExcept(repo, n, nowMs, ttlMs) });
    if (!bypassOwnership && !leaseOwnedByCaller({ lease, session, mySessionId, targeted, contested })) {
      const holder = laneHolderSlug(lease);
      log(
        `  lane-${n}: ${describeLease(lease)} — not yours; pass --force to break` +
        (!targeted && leaseOwnedByCaller({ lease, session, mySessionId, targeted: true, contested })
          ? ` (a --all sweep never releases on the ownerSession match alone — re-run as \`release --lane=${n}\` to release just this one)`
          : '') +
        (contested && holder
          ? `\n    This lease is CONTESTED (#2997): a SIBLING agent of your own session holds another lane right now,` +
            ` so the session id reads "mine" for BOTH of you and cannot tell your lane from theirs — which is how a` +
            ` release meant for one lane dropped another holder's lease on 2026-08-14.` +
            `\n    If lane-${n} really is yours, prove it with the holder slug \`acquire\` printed for it:` +
            `\n      node scripts/lane-pool.mjs release --lane=${n} --session=${holder}` +
            `\n    If it is not, you probably meant the lane YOU acquired — check \`lane-pool.mjs status\` first.`
          : ''),
      );
      continue;
    }
    // #3568 — before dropping the lease, reap the KNOWN-SAFE scratch litter `delivery-agent-brief.md` tells
    // every delivery agent to write inside its lane (`.commit-msg.txt`, `.pr-body.md`, …). This is what makes
    // the released lane immediately re-acquirable rather than reading DIRTY on the very next `status`/auto-pick
    // — the root cause of the 2026-09-07 incident this card documents (46 of 48 lanes DIRTY with only this
    // litter, the other 2 clean-but-ahead — the whole pool read 0 of 48 acquirable at once). Any
    // non-allowlisted dirty state (real uncommitted work) is left completely untouched by this call.
    cleanLaneLitter(dir);
    // #3383 — record the release in the lane-history ledger BEFORE the marker is dropped (best-effort; the
    // ledger lives in `.git/`, never touched by the marker unlink above it).
    appendLaneHistory(dir, laneHistoryEntry({
      event: 'release', session, ownerSession: lease.ownerSession || null, workerSession: lease.workerSession || null,
      purpose: lease.purpose, item: itemNumFromSession(lease.session), holder: laneHolderSlug(lease),
    }));
    rmSync(LEASE_MARKER(dir), { force: true });
    // #3466 — mirror acquire's write: a released lane must stop claiming the item it was working, the same way
    // cmdRefresh/cmdRemove/the acquire-time reset already clear it. Without this a release (or the reaper's
    // `release --force` reclaim, which delegates here) leaves the registry pointing at a lane that is free
    // again, and conveyor-state.mjs's health-stall scan overcounts `building` forever.
    unmapLanes(repo, [n]);
    log(`  released lane-${n} (was ${describeLease(lease)})`);
    released++;
  }
  if (flags.json) process.stdout.write(JSON.stringify({ released, targets }, null, 2) + '\n');
}

function printStatus(repo) {
  const rows = existingLanes(repo).map((n) => laneStatus(repo, n));
  if (flags.json) {
    process.stdout.write(JSON.stringify({ repo: repo.name, root: repo.poolDir, lanes: rows }, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    log(`(no lanes provisioned for "${repo.name}" under ${repo.poolDir})`);
    return;
  }
  log(`pool "${repo.name}" @ ${repo.poolDir} (integration branch: origin/${repo.branch})`);
  for (const r of rows) {
    log(
      `  lane-${r.lane}: ${r.head} [${r.branch}] ${r.clean ? 'clean' : 'DIRTY'}` +
        ` · ${r.behind === 0 ? 'up-to-date' : `${r.behind} behind`} · deps ${r.deps}` +
        (r.leased ? ` · ${describeLease(r.lease)}` : ''),
    );
  }
}

// ── list --acquirable: single-flight + short result cache (#xn432dz) ─────────────────────────────────
// WHY. Observed live 2026-09-23: fseventsd at ~100% CPU / ~25% RAM because 14 `list --acquirable --json`
// processes (dispatch-plan / the conveyor tick poll it) were scanning the ~129-lane pool AT ONCE, some for 10–71
// minutes — each ran git in every lane, and N concurrent scans made every one of them slower, so they piled up.
// Lease-first (`laneAcquirableInfo`) and GIT_OPTIONAL_LOCKS=0 cut the per-scan cost; this cuts the NUMBER of
// scans: the first caller takes an atomic mkdir lock under the pool dir, scans, and writes the result with a
// timestamp; every caller inside the TTL reuses it, and a caller that arrives mid-scan WAITS for that scan
// instead of starting its own.
//
// CORRECTNESS OF A STALE ANSWER. A cached "acquirable" can be up to TTL old (a lane may since have been leased
// or dirtied). That is acceptable ONLY because nothing trusts this list to CLAIM a lane: `acquire` re-derives
// every candidate itself (auto-pick recomputes `infoFor`, never reads this cache), claims with `tryClaimLane`'s
// atomic O_EXCL create (a live lease held by anyone else ⇒ refused), and re-verifies dirty/ahead on the claimed
// lane right before its destructive reset — #3390 for an explicit `--lane=N`, #2924 post-fetch for both paths.
// So a stale entry costs at most a lost race / a retry, never a clobbered lane. `list --acquirable` is a
// CAPACITY read (an optimistic upper bound — conveyor-state.mjs already documents it as such), not a lock.
//
// The cache is also invalidated early by (a) a FINGERPRINT of every lane's lease marker (existence + mtime,
// stat-only — no git, no FS events) so any acquire/release/adopt/hand-written lease misses immediately, and
// (b) `invalidateListCache` from the commands that reset trees WITHOUT touching a lease (provision/refresh) —
// acquire/release/adopt/remove all change the fingerprint on their own.
const LIST_CACHE_FILE = (repo) => join(repo.poolDir, '.list-acquirable-cache.json');
const LIST_LOCK_DIR = (repo) => join(repo.poolDir, '.list-acquirable.lock');
const DEFAULT_LIST_CACHE_TTL_MS = 30_000;
const DEFAULT_LIST_SCAN_TIMEOUT_MS = 120_000;
const LIST_LOCK_POLL_MS = 200;
// A lock whose owner record is missing/unreadable (holder died between mkdir and the owner write) is treated as
// stale once the dir itself is this old — long enough that a live holder has certainly written its record.
const LIST_LOCK_ORPHAN_GRACE_MS = 10_000;
const numFlagOrEnv = (flag, env, dflt) => {
  const raw = flags[flag] !== undefined ? flags[flag] : process.env[env];
  const n = Number(raw);
  return raw !== undefined && raw !== true && raw !== '' && Number.isFinite(n) && n >= 0 ? n : dflt;
};
const listCacheTtlMs = () => numFlagOrEnv('cache-ttl-ms', 'LANE_POOL_LIST_CACHE_TTL_MS', DEFAULT_LIST_CACHE_TTL_MS);
const listScanTimeoutMs = () => numFlagOrEnv('scan-timeout-ms', 'LANE_POOL_LIST_SCAN_TIMEOUT_MS', DEFAULT_LIST_SCAN_TIMEOUT_MS);

function invalidateListCache(repo) {
  try { rmSync(LIST_CACHE_FILE(repo), { force: true }); } catch { /* best-effort — the fingerprint still guards */ }
}
// Stat-only fingerprint of the pool's lease state: which lanes exist + each marker's mtime (0 = no marker).
function leaseFingerprint(repo) {
  return existingLanes(repo)
    .map((n) => {
      let m = 0;
      try { m = statSync(LEASE_MARKER(laneDir(repo, n))).mtimeMs; } catch { /* no marker */ }
      return `${n}:${m}`;
    })
    .join(',');
}
// Inputs that change the ANSWER (not just its freshness) — a cache written under a different reader TTL, branch
// or reap setting is a miss, never reused.
const listCacheKey = (repo) => `${repo.branch}|ttl=${ttlMsFromFlags()}|reap=${flags['no-reap'] ? 0 : 1}`;

function readListCache(repo, nowMs, cacheTtlMs) {
  let c;
  try { c = JSON.parse(readFileSync(LIST_CACHE_FILE(repo), 'utf8')); } catch { return null; }
  if (!c || c.v !== 1 || !Array.isArray(c.paths) || typeof c.writtenAt !== 'number') return null;
  if (c.key !== listCacheKey(repo)) return null;
  if (nowMs - c.writtenAt >= cacheTtlMs || c.writtenAt > nowMs + 1000) return null; // expired (or clock-skewed)
  if (c.fingerprint !== leaseFingerprint(repo)) return null; // a lease changed since the scan
  return c.paths;
}
function writeListCache(repo, paths) {
  const file = LIST_CACHE_FILE(repo);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Fingerprint taken AFTER the scan (the reap may have removed markers during it), then tmp+rename so a
    // concurrent reader never sees a half-written file.
    writeFileSync(tmp, JSON.stringify({ v: 1, writtenAt: Date.now(), key: listCacheKey(repo), fingerprint: leaseFingerprint(repo), paths }) + '\n');
    renameSync(tmp, file);
  } catch { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
function readLockOwner(repo) {
  try { return JSON.parse(readFileSync(join(LIST_LOCK_DIR(repo), 'owner.json'), 'utf8')); } catch { return null; }
}
// Stale = the holder is provably gone (same host, pid dead) OR it has held longer than a scan may run at all
// (the scan timeout makes a live holder give up by then), OR its owner record never appeared.
function listLockIsStale(repo, owner, nowMs, scanTimeoutMs) {
  if (!owner) {
    try { return nowMs - statSync(LIST_LOCK_DIR(repo)).mtimeMs > LIST_LOCK_ORPHAN_GRACE_MS; } catch { return false; }
  }
  if (owner.host === hostname() && !pidAlive(owner.pid)) return true;
  const started = Number(owner.startedAt);
  return !Number.isFinite(started) || nowMs - started > scanTimeoutMs + LIST_LOCK_ORPHAN_GRACE_MS;
}
function tryTakeListLock(repo) {
  try {
    mkdirSync(LIST_LOCK_DIR(repo)); // atomic create-or-fail — exactly one winner
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try { writeFileSync(join(LIST_LOCK_DIR(repo), 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }) + '\n'); } catch { /* orphan grace covers it */ }
  return true;
}
function releaseListLock(repo) {
  // Only remove a lock that is still OURS — a waiter may have taken over a lock it judged stale.
  const owner = readLockOwner(repo);
  if (owner && (owner.pid !== process.pid || owner.host !== hostname())) return;
  try { rmSync(LIST_LOCK_DIR(repo), { recursive: true, force: true }); } catch { /* best-effort */ }
}
// Take over a stale lock: re-read the owner right before removing, and only remove it if it is still the SAME
// stale owner — narrows (does not close) the window where two waiters both judge it stale. Losing that race just
// means two scans run; the answer is still correct.
function takeOverStaleListLock(repo, staleOwner) {
  const now = readLockOwner(repo);
  if (JSON.stringify(now) !== JSON.stringify(staleOwner)) return false;
  try { rmSync(LIST_LOCK_DIR(repo), { recursive: true, force: true }); } catch { return false; }
  log(`  list --acquirable: took over a stale scan lock (${staleOwner ? `pid ${staleOwner.pid}@${staleOwner.host}` : 'no owner record'}) (#xn432dz)`);
  return tryTakeListLock(repo);
}

// The actual scan. `limit` stops at N acquirable lanes (a truncated answer — never cached). Fails the whole scan,
// cleanly, if it overruns `scanTimeoutMs` (see `scanDeadlineMs`: a result produced past the deadline may rest on
// a killed git probe, so it is discarded rather than returned).
function scanAcquirable(repo, { limit = null, scanTimeoutMs }) {
  const startedMs = Date.now();
  scanDeadlineMs = scanTimeoutMs > 0 ? startedMs + scanTimeoutMs : null;
  const overrun = () => scanDeadlineMs !== null && Date.now() > scanDeadlineMs;
  const overrunFail = (where) => {
    scanDeadlineMs = null;
    throw Object.assign(new Error(`list --acquirable scan exceeded its ${scanTimeoutMs}ms budget ${where} (pool "${repo.name}" under ${repo.poolDir}) — refusing to return a partial/unsound answer. Raise --scan-timeout-ms / LANE_POOL_LIST_SCAN_TIMEOUT_MS, or check for a hung git (#xn432dz)`), { scanTimeout: true });
  };
  try {
    const nowMs = startedMs;
    const ttlMs = ttlMsFromFlags();
    // #3449 — run the SAME provably-dead-ghost reap `acquire` runs (`reapDeadLeasesInPool`, #2748) before
    // filtering. Previously only a fresh `acquire` triggered it, so `dispatch-plan.mjs`'s read-only capacity
    // check (`list --acquirable`) could under-report a pool saturated with ghost leases forever: nothing ever
    // called `acquire` to clear them, because the low-capacity reading is exactly what makes nothing call it.
    // `--no-reap` (tests) opts out identically to `acquire`'s own flag. (#xn432dz: with the cache this now runs
    // at most once per cache TTL per pool, not once per caller.)
    reapDeadLeasesInPool(repo, nowMs, ttlMs);
    if (overrun()) overrunFail('during the ghost-lease reap');
    // #3383 — ONE shared lazy `ls-remote` for this whole `list --acquirable` pass (see `laneAcquirableInfo`),
    // not one per lane — keeps this a cheap, at-most-one-network-call read, same cost shape as `cmdAcquire`'s
    // own auto-pick.
    const remoteShasBox = { value: null };
    const out = [];
    for (const n of existingLanes(repo)) {
      const ok = isLaneAcquirable(laneAcquirableInfo(repo, n, remoteShasBox, nowMs, ttlMs), nowMs, ttlMs);
      if (overrun()) overrunFail(`at lane-${n}`);
      if (ok) {
        out.push(n);
        if (limit !== null && out.length >= limit) break; // #xn432dz --limit: stop once N are found
      }
    }
    return out.map((n) => laneDir(repo, n));
  } finally {
    scanDeadlineMs = null;
  }
}

// Single-flight wrapper: cache hit ⇒ no scan; else take the lock and scan, or wait (bounded) for the holder's
// result. Waiting is bounded by the scan timeout + grace — past that the lock is stale by definition and taken
// over, so a waiter can never outlive a holder that is itself bounded.
function acquirableListCached(repo, { limit, scanTimeoutMs, cacheTtlMs }) {
  const slice = (paths) => (limit !== null ? paths.slice(0, limit) : paths);
  const hit = readListCache(repo, Date.now(), cacheTtlMs);
  if (hit) return slice(hit);
  // A --limit caller never scans on the cache's behalf (its answer is truncated); it takes a hit if there is
  // one, else runs its own short early-stopping scan uncached.
  if (limit !== null) return scanAcquirable(repo, { limit, scanTimeoutMs });
  const waitDeadline = Date.now() + (scanTimeoutMs > 0 ? scanTimeoutMs : DEFAULT_LIST_SCAN_TIMEOUT_MS) + LIST_LOCK_ORPHAN_GRACE_MS;
  for (;;) {
    let mine = tryTakeListLock(repo);
    if (!mine) {
      const owner = readLockOwner(repo);
      if (listLockIsStale(repo, owner, Date.now(), scanTimeoutMs)) mine = takeOverStaleListLock(repo, owner);
    }
    if (mine) {
      try {
        // Re-check under the lock: the previous holder may have just written a fresh result.
        const again = readListCache(repo, Date.now(), cacheTtlMs);
        if (again) return again;
        const paths = scanAcquirable(repo, { limit: null, scanTimeoutMs });
        writeListCache(repo, paths);
        return paths;
      } finally {
        releaseListLock(repo);
      }
    }
    sleepSyncMs(LIST_LOCK_POLL_MS);
    const fresh = readListCache(repo, Date.now(), cacheTtlMs);
    if (fresh) return fresh;
    if (Date.now() > waitDeadline) {
      // Should be unreachable (the lock goes stale first), but never hang: scan ourselves, uncached.
      log(`  list --acquirable: gave up waiting for the scan lock after ${scanTimeoutMs}ms+grace — scanning uncached (#xn432dz)`);
      return scanAcquirable(repo, { limit: null, scanTimeoutMs });
    }
  }
}

function cmdList(repo) {
  let paths = existingLanes(repo).map((n) => laneDir(repo, n));
  // #2426 — `--acquirable` drops any lane a picker must not couple an item onto: one holding a LIVE (foreign)
  // lease or someone's un-pushed work. The parallel /workflow dispatch used the bare list and assigned items to
  // held lanes by position, so a foreign-leased lane's item was carried with zero work. Filtering here (same
  // decision core `acquire` uses) is the throughput fix — the batch holds no leases, so every live lease it sees
  // is foreign; `isLaneAcquirable` excludes all live leases, which is exactly the set to skip.
  // An empty/unprovisioned pool has nothing to scan (and maybe no pool dir to hold a lock) — skip straight out.
  if (flags.acquirable && paths.length) {
    let limit = null;
    if (flags.limit !== undefined) {
      limit = Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 1) fail('--limit needs a positive integer (--limit=N)');
    }
    const scanTimeoutMs = listScanTimeoutMs();
    const cacheTtlMs = listCacheTtlMs();
    try {
      if (flags['no-cache'] || cacheTtlMs === 0) {
        // --no-cache forces a fresh scan (no read, no wait). A full fresh scan is still written back — it IS the
        // freshest answer — unless caching is disabled outright (TTL 0) or the answer is --limit-truncated.
        paths = scanAcquirable(repo, { limit, scanTimeoutMs });
        if (limit === null && cacheTtlMs > 0) writeListCache(repo, paths);
      } else {
        paths = acquirableListCached(repo, { limit, scanTimeoutMs, cacheTtlMs });
      }
    } catch (e) {
      if (e && e.scanTimeout) fail(e.message);
      throw e;
    }
  }
  if (flags.json) process.stdout.write(JSON.stringify(paths, null, 2) + '\n');
  else paths.forEach((p) => process.stdout.write(p + '\n'));
}

function cmdPath(repo) {
  const n = Number(flags.lane);
  if (!Number.isInteger(n) || n < 1) fail('path needs --lane=<positive integer>');
  const dir = laneDir(repo, n);
  if (!existsSync(dir)) fail(`lane-${n} does not exist (${dir})`);
  process.stdout.write(dir + '\n');
}

function cmdRemove(repo) {
  assertReleaseReservedScoped();
  let targets;
  if (flags.all) targets = existingLanes(repo);
  else if (flags.lane !== undefined) targets = [Number(flags.lane)];
  else return fail('remove needs --lane=N or --all');
  // #2350 (review:changes on #745) — `remove` does an unconditional `rmSync(dir, {recursive,force})`, which
  // would destroy a RESERVED memory lane, its `agent-memory-src`, and all accrued memory — the exact wipe
  // #2350 exists to prevent. So a reserved lane is off-limits to `remove` the same way it is to
  // `refresh`/`release`: skipped (loud), never torn down. The ONE escape hatch is the deliberate
  // `--release-reserved` (single-lane; see assertReleaseReservedScoped). This runs REGARDLESS of any --force:
  // a reserved lane's whole point is to survive routine `remove --all` pool teardown.
  const removable = targets.filter((n) => {
    const lease = readLease(laneDir(repo, n));
    if (isReservedLease(lease) && !flags['release-reserved']) {
      log(`  lane-${n}: ${describeLease(lease)} — a PERMANENT reserved lane; remove refuses it. Pass --release-reserved --lane=${n} to deliberately tear it down.`);
      return false;
    }
    return true;
  });
  unmapLanes(repo, removable); // a torn-down lane must stop receiving proxied page requests (#2139); a skipped reserved lane still serves
  for (const n of removable) {
    const dir = laneDir(repo, n);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      log(`removed lane-${n} (${dir})`);
    }
  }
}

// ── trim (#4025) — shrink a pool that only ever grows toward a cap ──────────────────────────────────
//
// WHY. `provision --acquirable` grows the pool (via ACQUIRABLE_PROVISION_HEADROOM, see above) whenever nothing
// looks free, but nothing ever shrinks it back — the real WE pool grew to 118 lanes / 87GB, and
// `list --acquirable`'s own per-lane scan (bounded per #2547, but still O(pool size)) slowed from ~45s at 83
// lanes to ~90s at 118. `trim` is the missing other half: delete lane directories, oldest-numbered-kept-first
// (i.e. HIGHEST numbers removed first), down toward a cap — SAFE direction always wins, so a lane is only ever
// removed when every one of these holds:
//   • no live lease, or a lease `deadLeasePlan` (this file's shared reaper core, see above) classifies as
//     provably dead — never a bare "no lease" check alone, so a lane whose session died mid-build without
//     releasing is still eligible, exactly like the acquire-time ghost-lease backstop;
//   • never a RESERVED (permanent) lease — no flag overrides this, unlike `remove --release-reserved`; trim's
//     whole point is unattended, periodic, automatic capacity management, so it gets no deliberate-teardown
//     escape hatch;
//   • nothing uncommitted beyond the shared `we:scripts/lib/lane-litter.mjs` scratch allowlist;
//   • every commit ahead of `origin/<branch>` is provably pushed or patch-equivalent (the SAME bounded
//     `aheadIsProvablyPushed`/`effectiveDirtyOrAhead` machinery `list --acquirable` and `provision --acquirable`
//     already use — never a second, unbounded check).
// A lane failing any of these is left in place and reported — "N lanes hold unpushed/uncommitted work: lane-X…"
// — never silently skipped with no trace.
//
// Wired into `we:scripts/conveyor/lane-pool-health-watch.mjs`'s periodic pass so pools shrink automatically; see
// that file for the per-repo cap and cadence.

/** #4025 — the default lane-count CAP per pool, keyed by `repo.name` (the same key `PORT_BANDS` uses). An
 *  env override (`LANE_POOL_TRIM_MAX`) or an explicit `--max=N` both win over this; unknown pools fall back to
 *  {@link TRIM_DEFAULT_CAP_FALLBACK}. WE's default (60) leaves real headroom over its current live size; the
 *  constellation siblings' (20) leaves headroom over their real live sizes (16 / 13 when this was written) —
 *  see {@link trimCapFor}'s own docblock for how to re-derive these if the live pools grow past them again. */
const TRIM_DEFAULT_CAP = {
  'web-everything': 60,
  webeverything: 60,
  frontierui: 20,
  'plateau-app': 20,
};
const TRIM_DEFAULT_CAP_FALLBACK = 20;

/** `--max=N` > `LANE_POOL_TRIM_MAX` env > {@link TRIM_DEFAULT_CAP}[repo.name] > {@link TRIM_DEFAULT_CAP_FALLBACK}. */
function trimCapFor(repo) {
  if (flags.max !== undefined) {
    const n = Number(flags.max);
    if (!Number.isInteger(n) || n < 0) fail('trim needs --max=<non-negative integer>');
    return n;
  }
  const envRaw = process.env.LANE_POOL_TRIM_MAX;
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return TRIM_DEFAULT_CAP[repo.name] ?? TRIM_DEFAULT_CAP_FALLBACK;
}

// ── acquire growth-on-empty (#3383) ──────────────────────────────────────────────────────────────────
// Live incident 2026-09-24: `trim`'s cap (above) shrinks the pool TOWARD a target, but `acquire`'s auto-pick
// had no corresponding ability to grow PAST it when genuinely starved — a 60-lane pool with only ~3-4
// acquirable lanes (the rest holding real uncommitted work or sitting un-provably-ahead of origin) made every
// single dispatch fail with "no free lane", however long `--wait-ms` waited, because nothing in that path ever
// considered cloning more capacity. This is the separate CEILING growth may push up to — always above the trim
// target, so trim and growth don't fight each other on every tick.
//
// Bounded the same two ways #4025 already bounds `provision --acquirable`'s growth (deliberately reusing that
// design, not inventing a third): a small per-call cap on brand-new clones (reaching it just means "ask
// again", never "clone dozens in one shot"), and an outright live remote-probe FAILURE stops growth entirely
// (fail-SAFE STOP, never fail-safe GROW) rather than risk misreading "we don't know" as "starved, so grow".

/** #3383 — the HARD ceiling `acquire`'s auto-pick may grow a pool up to, keyed by `repo.name` like
 *  {@link TRIM_DEFAULT_CAP}. Deliberately ABOVE the matching trim target (60→90, 20→30) — real headroom for a
 *  burst of concurrent dispatch to self-heal into, without racing trim's own shrink-back-down pass. `--hard-
 *  max=N` or the `LANE_POOL_HARD_MAX` env both override this per pool; unknown pools fall back to
 *  {@link ACQUIRE_HARD_MAX_FALLBACK}. */
const ACQUIRE_HARD_MAX = {
  'web-everything': 90,
  webeverything: 90,
  frontierui: 30,
  'plateau-app': 30,
};
const ACQUIRE_HARD_MAX_FALLBACK = 30;

/** `--hard-max=N` > `LANE_POOL_HARD_MAX` env > {@link ACQUIRE_HARD_MAX}[repo.name] > {@link ACQUIRE_HARD_MAX_FALLBACK}. */
function acquireHardMaxFor(repo) {
  if (flags['hard-max'] !== undefined) {
    const n = Number(flags['hard-max']);
    if (Number.isInteger(n) && n >= 0) return n;
    fail('acquire needs --hard-max=<non-negative integer>');
  }
  const envRaw = process.env.LANE_POOL_HARD_MAX;
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return ACQUIRE_HARD_MAX[repo.name] ?? ACQUIRE_HARD_MAX_FALLBACK;
}

// #3383 — mirrors #4025's `ACQUIRABLE_PROVISION_MAX_NEW_DEFAULT` exactly (same small per-call cap, same
// rationale), but kept as its OWN constant/flag/env rather than shared: `provision --acquirable`'s cap tunes a
// human/orchestrator-driven bulk-provisioning call, this one tunes a single starved `acquire`'s own emergency
// growth — two different callers that happen to want the same default today should stay independently tunable.
const ACQUIRE_GROWTH_MAX_NEW_DEFAULT = 4;

/** `--growth-max-new=N` > `LANE_POOL_ACQUIRE_GROWTH_MAX_NEW` env > {@link ACQUIRE_GROWTH_MAX_NEW_DEFAULT}. An
 *  explicit 0 (flag or env) is honored — it disables acquire's own growth — so this parses like
 *  `trimCapFor`/`acquireHardMaxFor`, never `Number(x) || DEFAULT` (which reads "0" as unset). */
function acquireGrowthMaxNew() {
  const asNonNegInt = (raw) => {
    if (raw === undefined || raw === '' || raw === true) return null;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 0 ? v : null;
  };
  return asNonNegInt(flags['growth-max-new'])
    ?? asNonNegInt(process.env.LANE_POOL_ACQUIRE_GROWTH_MAX_NEW)
    ?? ACQUIRE_GROWTH_MAX_NEW_DEFAULT;
}

/**
 * #3383 — called ONLY from `cmdAcquire`'s auto-pick path, ONLY once the wait/poll window (if any) is exhausted
 * with genuinely no free lane. Clones a bounded number of brand-new lanes (never past `acquireHardMaxFor`,
 * never more than `acquireGrowthMaxNew()` in this one call) and appends their numbers to `lanes` IN PLACE so
 * the caller's very next `chooseFreeLane` pass sees them. Numbers from `highest(lanes) + 1` up — trim always
 * removes the HIGHEST-numbered lanes first (see this file's `trim` section), so a live pool's numbering stays
 * contiguous from 1 in practice; basing growth on the highest existing number (not `lanes.length`) still fails
 * safe if a gap ever exists, since it can only make growth start a little higher than strictly necessary,
 * never collide with an existing lane directory.
 * Returns the number of lanes actually added (0 ⇒ the caller's existing "no free lane" failure stands).
 */
function growPoolOnEmpty(repo, lanes, remoteProbeFailed) {
  if (remoteProbeFailed) {
    log(
      `  ⚠ #3383 a live remote-reachability probe (git ls-remote) failed while evaluating this pool's lanes — ` +
        `refusing to grow it (deliberate fail-SAFE STOP, never fail-safe GROW, mirrors #4025). Investigate ` +
        `connectivity/timeouts, then retry \`acquire\` once the probe can actually answer.`,
    );
    return 0;
  }
  const hardMax = acquireHardMaxFor(repo);
  const highest = lanes.length ? Math.max(...lanes) : 0;
  if (highest >= hardMax) {
    log(
      `  ⚠ pool "${repo.name}" is already at its hard cap (lane-${highest} ≥ ${hardMax}; override with ` +
        `--hard-max=N or LANE_POOL_HARD_MAX) — acquire cannot grow it further; release a lane or raise the cap.`,
    );
    return 0;
  }
  const maxNew = acquireGrowthMaxNew();
  const toAdd = Math.min(maxNew, hardMax - highest);
  if (toAdd <= 0) {
    log(`  ⚠ acquire's per-call growth cap is 0 (--growth-max-new=0 or LANE_POOL_ACQUIRE_GROWTH_MAX_NEW=0) — not growing.`);
    return 0;
  }
  log(
    `  no free lane in pool "${repo.name}" (${lanes.length} all held/dirty) — growing by up to ${toAdd} new ` +
      `lane(s) (hard cap ${hardMax}; per-call growth cap ${maxNew}; override with --hard-max/--growth-max-new ` +
      `or LANE_POOL_HARD_MAX/LANE_POOL_ACQUIRE_GROWTH_MAX_NEW)`,
  );
  let added = 0;
  for (let i = 0; i < toAdd; i++) {
    const n = highest + i + 1;
    try {
      provisionLane(repo, n, false);
      lanes.push(n);
      added++;
    } catch (e) {
      log(`  ⚠ growth: failed to provision lane-${n} (${e?.message || e}) — stopping growth this call`);
      break;
    }
  }
  if (added > 0) {
    lanes.sort((a, b) => a - b);
    invalidateListCache(repo); // #xn432dz — the pool's composition just changed
    log(`  grew pool "${repo.name}" by ${added} lane(s) (through lane-${highest + added})`);
  }
  return added;
}

/**
 * Is lane `n` safe to physically remove right now? See the `trim` section header above for the full rule.
 * Returns a `kind` alongside `eligible`/`reason` so `cmdTrim` can bucket its report (reserved / leased / work /
 * ok) without re-deriving the classification from the prose reason string.
 * @returns {{eligible:boolean, kind:'reserved'|'leased'|'work'|'ok', reason:string}}
 */
function laneRemovalEligibility(repo, n, { remoteShasBox, nowMs, ttlMs, deadReasonByLane }) {
  const dir = laneDir(repo, n);
  const lease = readLease(dir);
  if (isReservedLease(lease)) {
    return { eligible: false, kind: 'reserved', reason: `${describeLease(lease)} — a PERMANENT reserved lane; trim never removes it` };
  }
  if (lease) {
    const deadReason = deadReasonByLane.get(n);
    if (!deadReason) {
      return { eligible: false, kind: 'leased', reason: `held (${describeLease(lease)}) — live lease, not provably dead` };
    }
    // Provably dead (ttl-stale / pr-merged / pr-closed / session-gone, per deadLeasePlan) — fall through to the
    // tree check below rather than trusting the death signal alone: a merged PR proves the PUSHED commits
    // landed, never that the lane's own working tree has no separate uncommitted residue.
  }
  const getRemoteShas = () => {
    if (!remoteShasBox) return new Set();
    if (remoteShasBox.value === null) remoteShasBox.value = liveRemoteShas(dir);
    return remoteShasBox.value;
  };
  const { dirty, ahead } = effectiveDirtyOrAhead(dir, repo.branch, getRemoteShas);
  if (dirty) return { eligible: false, kind: 'work', reason: 'uncommitted changes beyond the scratch allowlist' };
  if (ahead > 0) return { eligible: false, kind: 'work', reason: `${ahead} commit(s) ahead of origin/${repo.branch}, not provably pushed` };
  return {
    eligible: true,
    kind: 'ok',
    reason: lease ? `lease provably dead (${deadReasonByLane.get(n)}) — safe to remove` : 'idle, clean, up to date with origin',
    lease, // the exact (dead) lease judged here — `claimLaneForRemoval` re-checks it is still the one on disk
  };
}

/** Same lease? A re-acquire always rewrites `acquiredAt` (and a reclaim mints a fresh `holder`), so these three
 *  fields tell "the dead lease we judged" apart from "a new hold written since". */
const sameLease = (a, b) => !!a && !!b && a.acquiredAt === b.acquiredAt && a.session === b.session && a.holder === b.holder;

const TRIM_REACQUIRED = { kind: 'leased', reason: 're-leased after trim evaluated it — a live hold now owns it, kept' };

/** Move lane `dir`'s lease marker aside atomically (only one renamer wins) and keep it gone ONLY if `isMine`
 *  accepts what was moved; otherwise put it back without clobbering a marker written meanwhile (`link` fails if
 *  the name exists). Returns true iff the marker was taken. */
function takeMarkerIf(dir, isMine, n) {
  const file = LEASE_MARKER(dir);
  const aside = `${file}.trim-${process.pid}`;
  try { renameSync(file, aside); } catch { return false; } // gone or replaced since — don't guess
  let moved = null;
  try { moved = JSON.parse(readFileSync(aside, 'utf8')); } catch { /* unreadable ⇒ not provably ours */ }
  if (isMine(moved)) { rmSync(aside, { force: true }); return true; }
  try {
    linkSync(aside, file);
  } catch {
    log(`  ⚠ lane-${n}: could not restore a lease trim moved aside (another marker appeared) — ${describeLease(moved || {})} lost its marker; check this lane`);
  }
  rmSync(aside, { force: true });
  return false;
}

/**
 * #4025 r2 — the per-lane TOCTOU guard, run right before each deletion. `cmdTrim` judges the whole pool in one
 * pass and only then deletes, so a real `acquire` (or fresh work) can land on a lane in between. Like
 * `cleanLaneLitter`'s #3568 re-check, this re-verifies from inside the mutation: trim TAKES the lane through the
 * same O_EXCL lease marker `tryClaimLane` uses — an acquire that already won makes our create fail, and one that
 * comes later is refused by our live marker — then re-checks the tree under that hold. A lease judged dead is
 * first compared, then moved aside atomically, and kept unless it is still the SAME lease. {@link
 * removeClaimedLane} then re-confirms the marker is still trim's own after the directory is out of reach, since
 * `tryClaimLane`'s stale-reclaim and own-lease rewrite paths can replace a marker without O_EXCL.
 * A trim killed after claiming leaves only an ordinary TTL lease, which expires like any other.
 * @returns {{session:string} | {keep:{kind:'leased'|'work', reason:string}}}
 */
function claimLaneForRemoval(repo, n, evaluatedLease, remoteShasBox) {
  const dir = laneDir(repo, n);
  const file = LEASE_MARKER(dir);
  if (evaluatedLease) {
    if (!sameLease(readLease(dir), evaluatedLease)) return { keep: TRIM_REACQUIRED }; // cheap pre-check
    if (!takeMarkerIf(dir, (moved) => sameLease(moved, evaluatedLease), n)) return { keep: TRIM_REACQUIRED };
  }
  const session = `lane-pool-trim-${process.pid}-${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(leaseBody({
    session, purpose: 'lane-pool-trim', acquiredAt: new Date().toISOString(),
    host: hostname(), pid: process.pid, ownerSession: process.env.CLAUDE_CODE_SESSION_ID || null,
  }), null, 2) + '\n';
  try {
    writeFileSync(file, body, { flag: 'wx' });
  } catch {
    return { keep: TRIM_REACQUIRED };
  }
  const getRemoteShas = () => {
    if (remoteShasBox.value === null) remoteShasBox.value = liveRemoteShas(dir);
    return remoteShasBox.value;
  };
  const { dirty, ahead } = effectiveDirtyOrAhead(dir, repo.branch, getRemoteShas);
  if (dirty || ahead > 0) {
    // Hand the lane back as it was — no lease, its new work intact — dropping only a marker that is still ours.
    takeMarkerIf(dir, (moved) => moved?.session === session, n);
    return { keep: { kind: 'work', reason: 'work appeared after trim evaluated it (uncommitted or unpushed), kept' } };
  }
  return { session };
}

/** Crash-safe, race-safe removal (#4025): rename the lane dir to a `.trash-<n>-<ts>` SIBLING first (an atomic
 *  rename on the same filesystem). Once renamed, nothing can reach it as `lane-N`, so the lease read inside it is
 *  final: if it is no longer trim's own claim (`session`), a concurrent acquire replaced it and the lane is
 *  renamed back and kept. A process killed mid-`rmSync` leaves an inert `.trash-*` directory — never a
 *  half-deleted `lane-N` that `laneIndicesIn`'s `/^lane-\d+$/` match could misread — which the next trim run's
 *  {@link sweepLeftoverTrash} finishes. Returns the trash dir to delete, or `{keep}`. */
function moveClaimedLaneToTrash(repo, n, session) {
  const dir = laneDir(repo, n);
  const trashDir = join(repo.poolDir, `.trash-${n}-${Date.now()}`);
  try {
    renameSync(dir, trashDir);
  } catch (e) {
    takeMarkerIf(dir, (moved) => moved?.session === session, n);
    return { keep: { kind: 'leased', reason: `rename-to-trash failed (${e.message}), kept` } };
  }
  if (readLease(trashDir)?.session === session) return { trashDir };
  try {
    renameSync(trashDir, dir);
  } catch (e) {
    // Never leave a live lane under a `.trash-*` name the next sweep would delete.
    const parked = join(repo.poolDir, `.kept-lane-${n}-${Date.now()}`);
    try { renameSync(trashDir, parked); } catch { /* best-effort */ }
    log(`  ⚠ lane-${n}: re-leased mid-trim but could not be moved back (${e.message}) — parked intact at ${parked}`);
  }
  return { keep: TRIM_REACQUIRED };
}

/** Finish any `.trash-*` directory an earlier trim left behind (killed mid-delete). Real (non-dry-run) only —
 *  a dry-run must never delete anything, including inert trash from a PRIOR run. */
function sweepLeftoverTrash(repo) {
  if (!existsSync(repo.poolDir)) return 0;
  // `readdirSync`, not a shelled `ls -1` (which hides dot-prefixed entries by default and would silently never
  // see a `.trash-*` leftover at all) — this needs to see hidden entries.
  const entries = readdirSync(repo.poolDir).filter((e) => e.startsWith('.trash-'));
  for (const e of entries) {
    try {
      rmSync(join(repo.poolDir, e), { recursive: true, force: true });
      log(`  swept leftover ${e} (an interrupted earlier trim)`);
    } catch { /* best-effort — a stuck leftover just waits for the next run */ }
  }
  return entries.length;
}

/** Test-only seam: `LANE_POOL_TRIM_TEST_BARRIER=<path>` makes a real trim write `<path>.ready` at `stage`, then
 *  wait (≤30s) for `<path>.go` — so a test can land a real `acquire` exactly inside a race window. `stage` is
 *  `evaluated` (after the batch verdict, before any claim — the default) or `claimed` (after a lane is claimed,
 *  before it is moved to trash), picked by `LANE_POOL_TRIM_TEST_BARRIER_AT`. Unset (production) ⇒ a no-op. */
function trimTestBarrier(stage) {
  const p = process.env.LANE_POOL_TRIM_TEST_BARRIER;
  if (!p || (process.env.LANE_POOL_TRIM_TEST_BARRIER_AT || 'evaluated') !== stage) return;
  writeFileSync(`${p}.ready`, '');
  const deadline = Date.now() + 30_000;
  while (!existsSync(`${p}.go`) && Date.now() < deadline) sleepSyncMs(50);
}

function cmdTrim(repo) {
  const dryRun = !!flags['dry-run'];
  const max = trimCapFor(repo);
  const laneNums = existingLanes(repo); // ascending
  const total = laneNums.length;

  if (!dryRun) sweepLeftoverTrash(repo);

  if (total <= max) {
    log(`lane-pool trim "${repo.name}": ${total} lane(s), at/under the cap of ${max} — nothing to trim`);
    // Same key set as the compute path below, so a consumer never reads `remaining`/`overCap` as undefined.
    if (flags.json) process.stdout.write(JSON.stringify({ repo: repo.name, root: repo.poolDir, total, max, dryRun, removed: [], kept: [], remaining: total, overCap: 0 }, null, 2) + '\n');
    return;
  }

  const nowMs = Date.now();
  const ttlMs = ttlMsFromFlags();
  const excess = total - max;
  const { reap: deadLeases } = deadLeasePlan(repo, nowMs, ttlMs);
  const deadReasonByLane = new Map(deadLeases.map((c) => [c.lane, c.reason]));
  const remoteShasBox = { value: null };

  // Evaluate EVERY lane, highest lane number first, so the report always reflects the true priority order —
  // then take only as many eligible ones as needed to reach the cap (highest numbers first, low numbers stay
  // stable), even when the pool's top end is mostly busy and eligible lanes turn up further down.
  const descending = [...laneNums].sort((a, b) => b - a);
  const decisions = descending.map((n) => ({ lane: n, ...laneRemovalEligibility(repo, n, { remoteShasBox, nowMs, ttlMs, deadReasonByLane }) }));
  const eligibleDesc = decisions.filter((d) => d.eligible);
  const toRemoveSet = new Set(eligibleDesc.slice(0, excess).map((d) => d.lane));

  // #4025 r2 — the batch verdict above is a snapshot; each lane is re-claimed and re-checked right before its
  // deletion (`claimLaneForRemoval` → `moveClaimedLaneToTrash`), and one that changed hands or gained work since
  // is kept instead.
  const lostRace = new Map();
  if (!dryRun) {
    trimTestBarrier('evaluated');
    const trashed = [];
    for (const d of decisions) {
      if (!toRemoveSet.has(d.lane)) continue;
      const claim = claimLaneForRemoval(repo, d.lane, d.lease, remoteShasBox);
      if (!claim.keep) trimTestBarrier('claimed');
      const moved = claim.keep ? claim : moveClaimedLaneToTrash(repo, d.lane, claim.session);
      if (moved.keep) { lostRace.set(d.lane, moved.keep); toRemoveSet.delete(d.lane); } else trashed.push(moved.trashDir);
    }
    unmapLanes(repo, [...toRemoveSet]); // stop proxying a lane before its files are deleted (#2139)
    for (const t of trashed) rmSync(t, { recursive: true, force: true });
    invalidateListCache(repo); // #xn432dz — the pool shape changed
  }

  const rows = decisions
    .map((d) => {
      const lost = lostRace.get(d.lane);
      if (lost) return { lane: d.lane, action: 'keep', kind: lost.kind, reason: lost.reason };
      return {
        lane: d.lane,
        action: toRemoveSet.has(d.lane) ? (dryRun ? 'would-remove' : 'removed') : 'keep',
        kind: d.kind,
        reason: d.eligible && !toRemoveSet.has(d.lane) ? `${d.reason} (cap already reached by higher-numbered removals)` : d.reason,
      };
    })
    .sort((a, b) => a.lane - b.lane);

  for (const r of rows) log(`  lane-${r.lane}: ${r.action} — ${r.reason}`);
  const removedCount = toRemoveSet.size;
  const remaining = total - removedCount;
  const workLanes = rows.filter((r) => r.kind === 'work');
  if (workLanes.length) {
    log(`  ${workLanes.length} lane(s) hold unpushed/uncommitted work, never removed: ${workLanes.map((r) => `lane-${r.lane}`).join(', ')}`);
  }
  log(
    `lane-pool trim "${repo.name}": ${total} lane(s), cap ${max} → ${dryRun ? 'would remove' : 'removed'} ${removedCount}/${excess} needed ` +
    `(${total} → ${remaining})${remaining > max ? ` — ⚠ still ${remaining - max} over cap, not enough safely-removable lanes found` : ''}`,
  );
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      repo: repo.name, root: repo.poolDir, total, max, dryRun,
      removed: rows.filter((r) => r.action === 'removed' || r.action === 'would-remove').map((r) => r.lane),
      kept: rows.filter((r) => r.action === 'keep').map(({ lane, kind, reason }) => ({ lane, kind, reason })),
      remaining, overCap: Math.max(0, remaining - max),
    }, null, 2) + '\n');
  }
}

// ── adopt (#2997 r2) — the dispatcher → worker OCCUPANCY hand-off ──────────────────────────────────
//
// WHY THIS EXISTS. `acquire` stamps `ownerSession` from the env of the process that RUNS it. When an operator
// (or any dispatcher) leases a lane on an agent's behalf, that field records the DISPATCHER — the agent then
// sent to work in the lane runs under a session id of its own. So `ownerSession` answers "who leased it",
// never "who is working in it", and the Edit/Write guard cannot safely deny on it (it would refuse the lane's
// own occupant — the F1 finding on PR #1234). `adopt` is the missing half: the WORKER declares itself, the
// marker records it in the dedicated `workerSession` field, and from that moment `guard-lane.mjs` refuses
// Edit/Write from any OTHER session. Idempotent; a lane already occupied by a different LIVE session needs
// `--force` (deliberate takeover), which prints who is being displaced.
function cmdAdopt(repo) {
  const n = Number(flags.lane);
  if (!Number.isInteger(n) || n < 1) fail('adopt needs --lane=<positive integer> — it declares YOU the occupant of that lane');
  const me = process.env.CLAUDE_CODE_SESSION_ID || null;
  if (!me) fail('adopt needs a durable session id (CLAUDE_CODE_SESSION_ID) to stamp — without one there is nothing to declare, and the Edit/Write guard stays fail-open for this lane');
  const dir = laneDir(repo, n);
  const lease = readLease(dir);
  if (!lease) fail(`lane-${n} holds no lease to adopt — acquire it first (\`acquire --lane=${n} --purpose=<why> --adopt\`)`);
  if (isLeaseStale(lease, Date.now(), ttlMsFromFlags())) {
    fail(`lane-${n}'s lease is STALE (${describeLease(lease)}) — a stale lease reads as no lease; re-acquire the lane rather than adopting a dead hold`);
  }
  const current = laneWorkerSession(lease);
  if (current && current !== me && !flags.force) {
    fail(
      `lane-${n} is already declared as occupied by session ${current} (${describeLease(lease)}) — adopting it would take it out from under a working agent.\n` +
      `    If that agent is gone, pass --force to take it over deliberately; otherwise acquire your own lane (\`acquire --purpose=<why> --adopt\`).`,
    );
  }
  writeFileSync(LEASE_MARKER(dir), JSON.stringify({ ...lease, workerSession: me }, null, 2) + '\n');
  // #3383 — record the occupancy hand-off in the lane-history ledger (best-effort).
  appendLaneHistory(dir, laneHistoryEntry({ event: 'adopt', ownerSession: me, workerSession: me, session: lease.session }));
  log(`  adopted lane-${n} — occupant session is now ${me}${current && current !== me ? ` (took over from ${current})` : ''}`);
  log('    Edit/Write into this lane from ANY other session is now refused by guard-lane.mjs (#2997).');
  if (flags.json) process.stdout.write(JSON.stringify({ lane: n, path: dir, workerSession: me, previousWorkerSession: current }, null, 2) + '\n');
}

// ── map / unmap (#2139) — maintain the item → lane page-port registry ───────────────────────────────
function cmdMap(repo) {
  const n = Number(flags.lane);
  if (!Number.isInteger(n) || n < 1) fail('map needs --lane=<positive integer>');
  const items = String(flags.item ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  if (items.length === 0) fail('map needs --item=NNN[,NNN…]');
  const port = lanePagePort(repo, n);
  if (port === null) fail(`pool "${repo.name}" has no PORT_BANDS entry — no page port to map`);
  registerItemsToLane(repo, n, items);
  log(`mapped ${items.join(', ')} → lane-${n} (port ${port}) in ${registryPath(repo)}`);
}

function cmdUnmap(repo) {
  if (flags.all) {
    writePortRegistry(repo, {});
    log(`cleared ${registryPath(repo)}`);
    return;
  }
  if (flags.lane !== undefined) return unmapLanes(repo, [Number(flags.lane)]);
  const items = String(flags.item ?? '')
    .split(',')
    .map((s) => String(Number(s.trim())))
    .filter((s) => s !== 'NaN');
  if (items.length === 0) fail('unmap needs --item=NNN[,NNN…], --lane=N, or --all');
  const entries = readPortRegistry(repo);
  const dropped = items.filter((num) => num in entries);
  for (const num of dropped) delete entries[num];
  writePortRegistry(repo, entries);
  log(dropped.length ? `unmapped ${dropped.join(', ')}` : '(nothing to unmap)');
}

// ── flag validation ──────────────────────────────────────────────────────────────────────────────────
// Every flag this script reads ANYWHERE, across every command (verified by grepping every `flags.x` /
// `flags['x']` read in this file). The arg parser above (`for (const a of rest) ...`) puts ANY `--foo` into
// `flags` with zero validation, so a typo or unsupported flag silently no-ops instead of erroring — on a
// destructive command like `acquire` that is a real footgun, not a cosmetic one: `acquire --help` (meant to
// print usage) was accepted as a plain `acquire` with an ignored `help` flag, auto-picked a free lane, and
// reset it — no error, no warning, the exact silent-failure shape lane-pool already goes to lengths to avoid
// elsewhere (dirty/ahead guards, live-lease guards). This is a flat, not per-command, allowlist: a command
// reading a flag meant for a different command is a much smaller, less surprising mistake than an
// unrecognized flag vanishing outright, and a flat set can't drift out of sync with which command reads what.
const KNOWN_FLAGS = new Set([
  'acquirable', 'adopt', 'all', 'all-pools', 'base', 'branch', 'count', 'force', 'item', 'json', 'lane',
  'name', 'no-install', 'no-reap', 'no-reset', 'origin', 'pool', 'purpose', 'reference', 'release-reserved',
  'repo', 'reserve', 'scope', 'session', 'ttl-minutes', 'wait-ms',
  // #xn432dz — list --acquirable's single-flight cache / early-stop / bounded-scan knobs.
  'limit', 'no-cache', 'cache-ttl-ms', 'scan-timeout-ms',
  // #4025 — provision --acquirable's per-call new-lane cap, and trim's own cap/dry-run knobs.
  'max-new', 'max', 'dry-run',
  // #3383 — acquire's own growth-on-empty knobs: hard ceiling and per-call new-lane cap.
  'hard-max', 'growth-max-new',
]);

// ── dispatch ──────────────────────────────────────────────────────────────────────────────────────
const COMMANDS = {
  provision: cmdProvision,
  refresh: cmdRefresh,
  status: printStatus,
  list: cmdList,
  path: cmdPath,
  acquire: cmdAcquire,
  adopt: cmdAdopt,
  release: cmdRelease,
  remove: cmdRemove,
  trim: cmdTrim,
  map: cmdMap,
  unmap: cmdUnmap,
};

if (!cmd || cmd === 'help' || cmd === '--help' || !COMMANDS[cmd]) {
  if (cmd && cmd !== 'help' && cmd !== '--help') process.stderr.write(`unknown command: ${cmd}\n`);
  process.stderr.write(
    'usage: lane-pool.mjs <provision|refresh|status|list|path|acquire|adopt|release|remove|trim|map|unmap> [--count=N] [--lane=N] [--all] [--all-pools] [--acquirable] [--max-new=N] ' +
      '[--item=NNN[,NNN…]] [--purpose=<slug>] [--session=<slug>] [--adopt] [--base=<ref>] [--scope=<repo:path,...>] [--reserve] [--release-reserved] [--ttl-minutes=N] [--no-reset] [--no-reap] [--limit=N] [--no-cache] [--cache-ttl-ms=N] [--scan-timeout-ms=N] [--repo=<path>] [--pool=<name>] [--origin=<url>] ' +
      '[--reference=<path>] [--name=<slug>] [--branch=<ref>] [--no-install] [--force] [--json] [--max=N] [--dry-run]  # trim: shrink a pool to --max lanes (default per-repo cap; env LANE_POOL_TRIM_MAX)\n' +
      '  # acquire (auto-pick, no --lane): on a full pool, grows it by up to --growth-max-new=N new lanes (default 4, env ' +
      'LANE_POOL_ACQUIRE_GROWTH_MAX_NEW) up to a --hard-max=N ceiling (default 90 for web-everything/30 for siblings, env LANE_POOL_HARD_MAX) ' +
      'before failing — refuses to grow on a live remote-probe failure (#3383)\n',
  );
  process.exit(cmd && COMMANDS[cmd] === undefined && cmd !== 'help' ? 1 : 0);
}

if (positionals.length) {
  fail(`unexpected extra argument(s) after "${cmd}": ${positionals.join(' ')} — every lane-pool.mjs argument past the command is a --flag`);
}
const unknownFlags = Object.keys(flags).filter((f) => !KNOWN_FLAGS.has(f));
if (unknownFlags.length) {
  fail(
    `unrecognized flag(s): ${unknownFlags.map((f) => `--${f}`).join(', ')} — run \`node scripts/lane-pool.mjs help\` for the ` +
      `full flag list. A silently-ignored flag on a destructive command like \`acquire\` is exactly the footgun this check exists to close.`,
  );
}

COMMANDS[cmd](resolveRepo());
