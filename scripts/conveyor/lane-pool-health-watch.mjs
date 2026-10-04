#!/usr/bin/env node
/**
 * @file scripts/conveyor/lane-pool-health-watch.mjs
 * @description THE STANDING PERIODIC HALF of `we:backlog/3568-*.md`. Every tick: read the live lane-pool
 *   status, and for every UNLEASED lane whose ENTIRE `git status --porcelain` output matches only the shared
 *   `we:scripts/lib/lane-litter.mjs#LANE_RELEASE_LITTER_ALLOWLIST`, reap it (the identical cleanup
 *   `we:scripts/lane-pool.mjs#cmdRelease` runs at release time — the SAME imported function, never a second
 *   implementation). Also reports current pool health (acquirable / dirty / leased counts) as its own
 *   `--dry-run` output.
 *
 * WHY A PERIODIC PASS IS NEEDED BESIDE THE RELEASE-TIME FIX. A release-time-only fix does nothing for litter
 * that predates the fix, or that accumulates through any path other than a normal `release` (an aborted
 * session, a killed agent, a manual abandonment leaving a leased lane's marker stranded and later TTL-reaped
 * by a path that never runs the litter cleanup). This pass reclaims that litter on the next tick instead of
 * leaving it inert until someone happens to re-release that exact lane.
 *
 * THIS PASS IS ACTION (auto-reap), NOT DETECT-ONLY — unlike `we:scripts/conveyor/duplicate-pr-watch.mjs`'s
 * alert-only stance. "Does this lane's ENTIRE dirty state match only the named allowlist" is a deterministic,
 * allowlist-scoped classification with no content judgment involved (the same reasoning
 * `we:backlog/3562-*.md` point 4 already uses to justify its own pass being action rather than alert-only) — a
 * LEASED lane, or any lane carrying so much as ONE non-allowlisted dirty path, is never touched.
 *
 * PURE CORE / IO SHELL SPLIT (mirrors `we:scripts/conveyor/duplicate-pr-watch.mjs`):
 *   • {@link planLaneReap} is PURE — no fs/git/gh/clock/process (built on top of
 *     `we:scripts/lib/lane-litter.mjs#planLitterCleanup`, itself pure).
 *   • The IO shell ({@link defaultListLaneStatus}, {@link defaultReadPorcelain}, {@link watchLanePoolHealth},
 *     {@link runLanePoolHealthWatch}, the CLI) owns every subprocess/git call.
 *
 * CONFIG KNOB. `WE_LANE_POOL_HEALTH_WATCH_DISABLED` (presence-checked, any value) — mirrors
 * `we:scripts/conveyor/queue.mjs`'s `CONVEYOR_NO_KIND_CHECK` convention — makes {@link runLanePoolHealthWatch}
 * a true no-op: no status read, no reap, no report. Checked first, inside the entrypoint itself, so
 * `we:skills-src/conveyor/runner.mjs#makeCliMechanicalPasses` needs no change to disable this pass.
 *
 * THE CADENCE. Wired into `we:skills-src/conveyor/runner.mjs#makeCliMechanicalPasses`, beside the
 * `we:scripts/conveyor/duplicate-pr-watch.mjs` / `we:scripts/conveyor/parked-pr-conflict-watch.mjs` lines — the
 * same "piggyback on a pass the headless runner already ticks" shape, so pool litter is reclaimed every tick
 * with no new cron/daemon.
 */
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { planLitterCleanup, cleanLaneLitter, LANE_RELEASE_LITTER_ALLOWLIST } from '../lib/lane-litter.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';
// #3568 — the pure decision core only, reused rather than re-derived (the SAME `isLeaseStale`
// `we:scripts/lane-pool.mjs` itself calls). See `defaultIsLeasedNow` below.
import { LEASE_FILENAME, isLeaseStale } from '../lib/lane-lease.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
// #4122 — publish the FREE-LANE LIST this pass already has the ingredients for (see {@link writeFreeLaneListForTick}
// below): `we:scripts/lane-pool.mjs acquire` reads it as a fast pre-filter instead of paying for its own
// full-pool scan on the common path (live incident, 2026-09-25: acquire measured 240s / list 66s under load,
// against acquire's 180s wait, while 30+ lanes sat free). This file already shells the exact `list
// --acquirable` scan the list is built from (`defaultListAcquirable` below) — publishing it here is additive,
// no extra git/gh calls.
import { buildFreeLaneList, resolveFreeLaneListPath, writeFreeLaneListAtomic } from '../lib/free-lane-list.mjs';
// Salvage retention + pool leftovers (2026-09-27): the salvage index is refreshed (landed / 14-day expiry), hand-made
// salvage dirs are backfilled into it, and non-lane litter in the pool dir is classified and cleaned every tick.
import { refreshSalvageIndex, backfillSalvageDir } from '../lib/salvage-index.mjs';
import { sweepPoolLeftovers } from '../lib/pool-leftovers.mjs';
import { resolveSalvageRoot, readAgentsStrict, laneLivenessGate } from '../lib/lane-salvage.mjs';
import { readLaneHistory, lastLaneHistoryEntry, journalLaneEvent, laneStateSnapshot, LANE_JOURNAL_ACTOR_ENV } from '../lib/lane-history.mjs';
import { timestampedStderr } from '../lib/log-timestamp.mjs';
// #4344 — the PURE predicate that tells "already at the pool branch tip, nothing to reclaim" apart from
// "clean, but still behind it" (reclaim must still run for the latter — see that function's own docblock).
import { isLaneAlreadyClean } from '../lib/lane-whois-core.mjs';
import { readdirSync as readdirSyncFs } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo root, resolved from this file's own location — same derivation as
 *  `we:scripts/conveyor/duplicate-pr-watch.mjs#REPO_ROOT`. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** The env var that makes {@link runLanePoolHealthWatch} a true no-op — presence-checked, any value. */
export const DISABLE_ENV_VAR = 'WE_LANE_POOL_HEALTH_WATCH_DISABLED';

// ── PURE CORE (no fs / git / gh / clock / process — every input is injected) ───────────────────────────────

/**
 * THE WHOLE DECISION: given the pool's lane rows (each carrying its raw `porcelain` — `null` for a leased lane
 * or a failed status read), classify each unleased lane as `reap` / `already-clean` / `leave-dirty` /
 * `read-error`. Pure — reuses `planLitterCleanup` verbatim rather than re-deriving the allowlist match.
 *
 * DELIBERATELY STRICTER than `cmdRelease`: reaps a lane only when its ENTIRE porcelain is litter (never a
 * partial reap alongside real dirt), unlike `cmdRelease`'s unconditional per-file strip on a lane its own
 * occupant just released. This pass scans lanes with no live owner to ask, so a lane mixing litter with real
 * abandoned work is left untouched for a human/agent to inspect — matching this backlog item's Done-when spec.
 * @param {Array<{lane:number, path:string, exists?:boolean, leased?:boolean, porcelain?:string|null}>} lanes
 * @param {string[]} [allowlist]
 * @returns {Array<{lane:number, path:string,
 *   action:'skip-leased'|'reap'|'already-clean'|'leave-dirty'|'read-error', toRemove?:string[],
 *   leaveDirty?:string[]}>}
 */
export function planLaneReap(lanes, allowlist = LANE_RELEASE_LITTER_ALLOWLIST) {
  const results = [];
  for (const l of Array.isArray(lanes) ? lanes : []) {
    if (!l || l.exists === false) continue; // a lane index with no clone on disk — nothing to reap
    if (l.leased) { results.push({ lane: l.lane, path: l.path, action: 'skip-leased' }); continue; }
    // A `git status --porcelain` read that itself FAILED (e.g. the lane dir vanished mid-tick) must never
    // silently read as "clean" — that would report an unverified lane as safely acquirable. `null` is the
    // read-failure sentinel `defaultReadPorcelain` returns; an EMPTY STRING (genuinely clean) still falls
    // through to the ordinary already-clean branch below.
    if (l.porcelain === null) { results.push({ lane: l.lane, path: l.path, action: 'read-error' }); continue; }
    const { toRemove, leaveDirty } = planLitterCleanup(l.porcelain, allowlist);
    if (toRemove.length > 0 && leaveDirty.length === 0) {
      results.push({ lane: l.lane, path: l.path, action: 'reap', toRemove });
    } else if (toRemove.length === 0 && leaveDirty.length === 0) {
      results.push({ lane: l.lane, path: l.path, action: 'already-clean' });
    } else {
      // leaveDirty is non-empty — real (or unknown) dirty state present, whether or not litter is ALSO
      // present alongside it. Never partially reaped — see this function's own docblock for why that is a
      // deliberate divergence from `cmdRelease`, not a bug.
      results.push({ lane: l.lane, path: l.path, action: 'leave-dirty', leaveDirty });
    }
  }
  return results;
}

/**
 * Current pool health counts from the plan + the raw lane rows — acquirable / dirty(unleased) / leased —
 * the plain status line this pass reports every tick (not the historical rolling-window artifact
 * `we:backlog/3569-*.md` covers — see that card's own cross-reference to this one). Pure.
 *
 * `reaped` is the list of lanes a `reap` action ACTUALLY succeeded for (empty on a `--dry-run`, or when a
 * lane's reap call threw). A lane whose plan action is `'reap'` counts as acquirable ONLY when it is in this
 * list — never on the pre-execution plan action alone, which would optimistically report a lane "acquirable"
 * even when its reap call failed and left the litter (and hence the dirty tree) exactly where it was, or when
 * a `--dry-run` never touched it at all.
 * #3383 — live-caught 2026-09-24: this porcelain/litter plan alone is NOT the real eligibility answer. It
 * classifies a lane from `git status --porcelain` (working-tree dirt vs the shared litter allowlist) ALONE,
 * and never checks whether the lane is ahead of origin/<branch> — but `we:scripts/lane-pool.mjs`'s own real
 * gate (`acquire`'s auto-pick, and `list --acquirable`) ALWAYS also checks ahead (`effectiveDirtyOrAhead`,
 * litter-adjusted AND ahead-adjusted). Live-verified against the real WE pool: this file's own plan-only
 * classification read 14 lanes "acquirable" while `list --acquirable --json` — the exact function `acquire`
 * is built on — answered only 3; the 11 false positives were all clean-porcelain but 1-2 commits ahead of
 * origin/main (real, unpushed, correctly-protected work `acquire` would have refused, exactly the
 * "acquire's view disagrees with the health watch's" symptom this closes). `acquirableLaneNumbers`, when
 * given, is cross-referenced so a lane only counts as acquirable here when BOTH this plan AND the real
 * `list --acquirable` answer agree — the ONE shared eligibility function, reused rather than re-derived, so
 * this read-only report and `acquire`'s own auto-pick can never diverge again. `null` (the real read was
 * unavailable this tick, or the caller passed none — every existing caller/test) falls back to the
 * plan-only answer UNCHANGED, so this is purely additive.
 * @param {Array<{lane:number, exists?:boolean, leased?:boolean}>} lanes
 * @param {Array<{lane:number, action:string}>} plan
 * @param {number[]} [reaped]
 * @param {Set<number>|null} [acquirableLaneNumbers]
 * @returns {{total:number, leased:number, acquirable:number, dirtyUnleased:number}}
 */
export function summarizeHealth(lanes, plan, reaped = [], acquirableLaneNumbers = null) {
  const existing = (Array.isArray(lanes) ? lanes : []).filter((l) => l && l.exists !== false);
  const leased = existing.filter((l) => l.leased).length;
  const reapedSet = new Set(reaped);
  const planAcquirableLanes = new Set(
    plan
      .filter((p) => p.action === 'already-clean' || (p.action === 'reap' && reapedSet.has(p.lane)))
      .map((p) => p.lane),
  );
  const acquirableLanes = acquirableLaneNumbers === null
    ? planAcquirableLanes
    : new Set([...planAcquirableLanes].filter((n) => acquirableLaneNumbers.has(n)));
  const acquirable = existing.filter((l) => !l.leased && acquirableLanes.has(l.lane)).length;
  const dirtyUnleased = existing.filter((l) => !l.leased && !acquirableLanes.has(l.lane)).length;
  return { total: existing.length, leased, acquirable, dirtyUnleased };
}

/**
 * #4122 — the rows {@link buildFreeLaneList} needs, derived from this SAME tick's already-computed facts: the
 * live `lanes` snapshot (for each acquirable lane's `path`/`head`/`branch`) cross-referenced against
 * `acquirableLaneNumbers` — the REAL `list --acquirable` verdict, never the plan-only estimate (see
 * `summarizeHealth`'s own docblock for why the two can diverge: a live-caught false-positive rate of 14 vs 3
 * on the real pool). Pure. `acquirableLaneNumbers === null` (the real read was unavailable this tick) always
 * yields an EMPTY list — publishing a plan-only guess as the free-lane list would let `acquire` skip its own
 * scan on exactly the unsound answer #3383 already found and fixed for this file's own health report.
 * @param {Array<{lane:number, path:string, exists?:boolean, leased?:boolean, head?:string, branch?:string}>} lanes
 * @param {Set<number>|null} acquirableLaneNumbers
 * @returns {Array<{lane:number, path:string, head:(string|null), branch:(string|null)}>}
 */
export function freeLaneRows(lanes, acquirableLaneNumbers) {
  if (!acquirableLaneNumbers) return [];
  return (Array.isArray(lanes) ? lanes : [])
    .filter((l) => l && l.exists !== false && !l.leased && acquirableLaneNumbers.has(l.lane))
    .map((l) => ({ lane: l.lane, path: l.path, head: l.head ?? null, branch: l.branch ?? null }));
}

// ── IO SHELL (subprocess/git only past this point — the CLI, gated on the main-module check) ────────────────

/**
 * Resolve a caller-supplied `--repo` into what `we:scripts/lane-pool.mjs --repo=` actually needs: a
 * filesystem path. Live-caught 2026-09-22, first real (non-dry-run, non-fixture) run under a standalone
 * daemon: every OTHER repo-generic conveyor pass (`we:scripts/conveyor/reconcile-pass.mjs`,
 * `we:scripts/operations/review-dispatch.mjs`, …) accepts a constellation SLUG (`plateauapp/plateau-app`) and
 * resolves it internally; this file forwarded whatever it was given UNCHANGED straight into
 * `lane-pool.mjs status --repo=<value>`, which has ALWAYS been, and stays, path-only (confirmed by direct
 * read of `we:scripts/lane-pool.mjs#resolveRepo` — no slug resolution exists there, and giving it one now
 * would be a much bigger, riskier change than fixing the one caller that got the contract backwards). A
 * daemon wired with `--repo=plateauapp/plateau-app` (matching its own manifest entry's sibling convention)
 * crashed every run: `lane-pool.mjs` tried to resolve a literal `./plateauapp/plateau-app` directory.
 *
 * Accepts EITHER form so an existing caller already passing a raw path (this file's own tests, an operator's
 * `--dry-run` from the command line) is unaffected: a recognized slug resolves to that repo's real checkout
 * path; anything else (already a path, or `null`) passes through UNCHANGED. WE's own `CONSTELLATION_REPOS`
 * entry has an EMPTY `path` (it answers to the caller's cwd, not a fixed location, same as every other
 * repo-generic pass's own `'.'`/`null` convention for WE) — resolving it here would be wrong, so a `we` slug
 * maps to `null`, the same "let `lane-pool.mjs` default to the cwd's own git toplevel" every other caller
 * already relies on, and exactly today's real default behavior when this runs from a WE checkout.
 * @param {string|null} repo
 * @param {string} [home]
 * @returns {string|null}
 */
export function resolveLanePoolRepoPath(repo, home = homedir()) {
  if (!repo) return null;
  const key = repoKeyForSlug(repo);
  if (key === null) return repo; // not a recognized slug — treat it as already a path, unchanged
  if (key === 'we') return null; // WE has no fixed path; let lane-pool.mjs default to the cwd's own toplevel
  return CONSTELLATION_REPOS[key].path.replace(/^\$HOME(?=\/|$)/, home);
}

/**
 * The live pool-status query — shells `node lane-pool.mjs status --json`, the SAME data
 * `we:scripts/lane-pool.mjs#printStatus --json` reports (never a re-derived reader). `exec` is injectable so
 * the argv is assertable with no real subprocess.
 * @param {{exec?:Function, repo?:string|null, root?:string}} [o]
 * @returns {{repo?:string, root?:string, lanes:Array<object>}}
 */
export function defaultListLaneStatus({ exec = execFileSync, repo = null, root = REPO_ROOT } = {}) {
  const argv = [join(root, 'scripts', 'lane-pool.mjs'), 'status', '--json'];
  const repoPath = resolveLanePoolRepoPath(repo);
  if (repoPath) argv.push(`--repo=${repoPath}`);
  // #x5n4zn3 — was bare (no timeout): the exact `lane-pool.mjs status`-shaped hang class #3383 filed this
  // rollout for.
  const out = exec('node', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: resolveChildTimeoutMs() * 4, killSignal: 'SIGKILL' });
  const parsed = JSON.parse(String(out || '{}'));
  return { repo: parsed.repo, root: parsed.root, lanes: Array.isArray(parsed.lanes) ? parsed.lanes : [] };
}

/**
 * #3383 — the REAL eligibility read, shelling `node lane-pool.mjs list --acquirable --json`, the SAME
 * single-flight, cached, shared-with-`acquire` answer this file's own {@link summarizeHealth} cross-checks
 * its plan-only classification against (see that function's own docblock for why the plan alone diverges).
 * Best-effort like {@link defaultTrimPool}: any failure (a crashed child, unparsable JSON, no lanes provisioned
 * yet) returns `null` — "real read unavailable this tick" — never throws, so a bad tick degrades to the
 * pre-#3383 plan-only answer instead of crashing the whole health-watch pass.
 * @param {{exec?:Function, repo?:string|null, root?:string}} [o]
 * @returns {Set<number>|null}
 */
export function defaultListAcquirable({ exec = execFileSync, repo = null, root = REPO_ROOT } = {}) {
  const argv = [join(root, 'scripts', 'lane-pool.mjs'), 'list', '--acquirable', '--json'];
  const repoPath = resolveLanePoolRepoPath(repo);
  if (repoPath) argv.push(`--repo=${repoPath}`);
  try {
    // #x5n4zn3-style bound, matching this file's other real spawned CLI children.
    const out = exec('node', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: resolveChildTimeoutMs() * 4, killSignal: 'SIGKILL' });
    const paths = JSON.parse(String(out || '[]'));
    if (!Array.isArray(paths)) return null;
    return new Set(paths.map((p) => Number(String(p).match(/lane-(\d+)$/)?.[1])).filter((n) => Number.isInteger(n)));
  } catch {
    return null;
  }
}

/**
 * #4122 — publish this tick's {@link freeLaneRows} as the free-lane list `we:scripts/lane-pool.mjs acquire`
 * reads (via `we:scripts/lib/free-lane-list.mjs`). `write`/`resolvePath`/`build` are injectable so a test can
 * assert on the object written without touching a real file. Best-effort, like every other write in this
 * file's IO shell: any failure (an unwritable path, a bad `CONVEYOR_STATE_ROOT`) returns `null` — "not
 * published this tick" — never throws, so one bad write never fails the whole health-watch pass.
 * @param {{repoName:string, poolDir:string, rows:Array<object>, writtenAt?:number,
 *   build?:Function, resolvePath?:Function, write?:Function}} o
 * @returns {{path:string, count:number}|null}
 */
export function defaultWriteFreeLaneList({
  repoName, poolDir, rows, writtenAt = Date.now(),
  build = buildFreeLaneList, resolvePath = resolveFreeLaneListPath, write = writeFreeLaneListAtomic,
} = {}) {
  try {
    const list = build({ repoName, poolDir, writtenAt, lanes: rows });
    const path = resolvePath({ repoName, poolDir });
    write(path, list);
    return { path, count: list.lanes.length };
  } catch {
    return null;
  }
}

/**
 * Raw `git status --porcelain` for one lane's tree. `exec` is injectable. Never throws — a read failure
 * (e.g. the lane dir vanished mid-tick) reads as `null`, which {@link planLaneReap} reports explicitly as
 * `action: 'read-error'` (never silently treated as clean, and never silently reaped).
 * @param {string} dir
 * @param {Function} [exec]
 * @returns {string|null}
 */
/** Env knob: `1` makes every pass re-read porcelain even for a lane `status` just reported clean (pre-2026-10-04). */
export const REREAD_CLEAN_PORCELAIN_ENV = 'WE_HEALTH_WATCH_REREAD_CLEAN_PORCELAIN';

export function defaultReadPorcelain(dir, exec = execFileSync) {
  try {
    // #x5n4zn3 — was bare (no timeout); called per-lane, so a single stuck lane must not stall the whole sweep.
    // GIT_OPTIONAL_LOCKS=0 (#xn432dz, as lane-pool.mjs's own read-only git): a read must never rewrite
    // `.git/index` — that write per lane per pass also invalidated lane-status-cache's index signature.
    return exec('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  } catch {
    return null;
  }
}

/**
 * TOCTOU guard (#3568) — is this lane leased RIGHT NOW, read directly off its marker rather than the
 * `listStatus` snapshot the sweep started from? `we:scripts/lib/lane-litter.mjs#cleanLaneLitter` takes this AS
 * its own `isLeasedNow` option and calls it as the LAST gate right before the mutation (see that file for why
 * it belongs there, not earlier). Reuses `isLeaseStale` — the same rule `we:scripts/lane-pool.mjs` applies —
 * rather than re-deriving it; only the trivial marker read/parse is duplicated (`lane-lease.mjs` is documented
 * PURE/no-fs, and `lane-pool.mjs` is unsafe to import — it runs its CLI at module load). Fails OPEN to "not
 * leased" on a missing/corrupt marker, matching `lane-pool.mjs#readLease`'s own fail-open.
 * @param {string} dir
 * @returns {boolean}
 */
export function defaultIsLeasedNow(dir) {
  try {
    const file = join(dir, '.git', LEASE_FILENAME);
    if (!existsSync(file)) return false;
    const lease = JSON.parse(readFileSync(file, 'utf8'));
    return !!(lease && typeof lease === 'object' && !Array.isArray(lease) && !isLeaseStale(lease, Date.now()));
  } catch {
    return false;
  }
}

/**
 * #xl5xhmj fork 2 — `defaultIsLeasedNow`'s sibling for LIVE OWNERSHIP rather than a lease: an unleased lane
 * (its lease already dropped — #xbk2is9) can still have a live worker sitting in it. Passed as
 * `lib/lane-litter.mjs#cleanLaneLitter`'s `isLiveNow` so the litter-reap pass never deletes a live worker's own
 * scratch files (its `.pr-body.md`/`.commit-msg.txt`) just because the lane read unleased (2026-09-28 lane-18
 * evidence). Reuses the SAME `laneLivenessGate` the reclaim path (`lane-pool.mjs#cmdReclaim`) runs — one gate,
 * one place — never a third hand-rolled liveness read. Fails toward "still live" (never toward "safe to reap")
 * on any read it cannot verify, matching that gate's own fail-closed contract.
 * @param {string} dir
 * @returns {boolean}
 */
export function defaultIsLiveNow(dir) {
  try {
    return !laneLivenessGate({ dir }).eligible; // current lease identities and exact lane cwd
  } catch {
    return true;
  }
}

/**
 * #4025 — the live pool-TRIM call, shelling `node lane-pool.mjs trim --json [--repo=] [--max=N] [--dry-run]`,
 * the SAME command an operator runs by hand (see that file's own `trim` section header). `exec` is injectable
 * so the argv is assertable with no real subprocess. `provision --acquirable` grows a pool whenever nothing
 * looks free but nothing ever shrank it back — this is the periodic shrink half, piggybacking on the SAME tick
 * this file's litter-reap pass already runs on, so a pool trends back toward its cap automatically with no
 * separate cron/daemon (mirrors this file's own header rationale for the litter-reap pass).
 *
 * Best-effort, like every other read in this file's IO shell: any failure (a crashed child, unparsable JSON)
 * returns `null` rather than throwing, so one bad trim tick degrades to "trim unavailable this tick" instead
 * of crashing the whole health-watch pass (`reaped`/`plan` above still ran and are still reported).
 * @param {{exec?:Function, repo?:string|null, root?:string, max?:number|null, dryRun?:boolean}} [o]
 * @returns {{repo:string, root:string, total:number, max:number, removed:number[], kept:Array<object>,
 *   remaining:number, overCap:number, dryRun:boolean}|null}
 */
export function defaultTrimPool({ exec = execFileSync, repo = null, root = REPO_ROOT, max = null, dryRun = false } = {}) {
  const argv = [join(root, 'scripts', 'lane-pool.mjs'), 'trim', '--json'];
  const repoPath = resolveLanePoolRepoPath(repo);
  if (repoPath) argv.push(`--repo=${repoPath}`);
  if (Number.isInteger(max) && max >= 0) argv.push(`--max=${max}`);
  if (dryRun) argv.push('--dry-run');
  try {
    // #x5n4zn3-style bound, matching `defaultListLaneStatus` above — a real spawned CLI child, never unbounded.
    const out = exec('node', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: resolveChildTimeoutMs() * 4, killSignal: 'SIGKILL' });
    const parsed = JSON.parse(String(out || 'null'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Presence-checked env knob (mirrors {@link DISABLE_ENV_VAR}'s own "any value disables" contract) that turns
 *  OFF only the reclaim sub-pass below, leaving litter-reap + trim running exactly as before — an operator who
 *  wants to pause auto-reclaim specifically (without losing the rest of this file's own periodic upkeep) sets
 *  this rather than the whole-pass {@link DISABLE_ENV_VAR}. */
export const RECLAIM_DISABLE_ENV_VAR = 'WE_LANE_POOL_RECLAIM_DISABLED';

/**
 * #3383 gap 2 — the live `lane-whois.mjs --json` read, shelling the SAME command an operator runs by hand
 * (and the one `we:scripts/operations/operator-queue.mjs#laneReclaimQueue` already shells for its own
 * "needs your decision" feed). `exec` is injectable so the argv is assertable with no real subprocess.
 * Best-effort, like every other read in this file's IO shell: any failure (a crashed child, unparsable JSON)
 * returns `null` — "verdicts unavailable this tick" — never throws, so a bad tick degrades to "no reclaim this
 * tick" rather than crashing the whole health-watch pass.
 * @param {{exec?:Function, repo?:string|null, root?:string}} [o]
 * @returns {{lanes:Array<object>}|null}
 */
export function defaultListWhois({ exec = execFileSync, repo = null, root = REPO_ROOT } = {}) {
  const argv = [join(root, 'scripts', 'lane-whois.mjs'), '--json'];
  const repoPath = resolveLanePoolRepoPath(repo);
  if (repoPath) argv.push(`--repo=${repoPath}`);
  try {
    // #3383-perf made this call BOUNDED (was 9+ minutes measured live pre-fix — see that item's own PR body
    // for the before/after timing) — a generous-but-real ceiling, well above the ≤60s target so a slower-
    // than-usual tick still finishes, but never the old unbounded/20-minute shape.
    const out = exec('node', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 3 * 60_000, killSignal: 'SIGKILL' });
    const parsed = JSON.parse(String(out || 'null'));
    return parsed && Array.isArray(parsed.lanes) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * #3383 gap 2 — the live pool-RECLAIM call for ONE lane, shelling `node lane-pool.mjs reclaim --lane=N --json
 * [--dry-run]` — the MUTATION half; see that command's own header for why it re-derives the preservation
 * proof itself rather than trusting the verdict this file just read. `exec` is injectable. Best-effort: any
 * failure (a crashed child, the lane got claimed by a live `acquire` in the race window between the whois scan
 * and this call, unparsable JSON) returns `null` — "reclaim unavailable/refused this lane this tick" — never
 * throws, so one bad lane never stops the sweep from trying the rest.
 * @param {{exec?:Function, repo?:string|null, root?:string, lane:number, dryRun?:boolean}} o
 * @returns {{reclaimed:boolean, wouldReclaim?:boolean, preserved:boolean, reason:string}|null}
 */
export function defaultReclaimLane({ exec = execFileSync, repo = null, root = REPO_ROOT, lane, dryRun = false, salvage = false }) {
  const argv = [join(root, 'scripts', 'lane-pool.mjs'), 'reclaim', `--lane=${lane}`, '--json'];
  const repoPath = resolveLanePoolRepoPath(repo);
  if (repoPath) argv.push(`--repo=${repoPath}`);
  if (dryRun) argv.push('--dry-run');
  if (salvage) argv.push('--salvage');
  // #4370 — the journal line the child writes names THIS daemon and the pass that chose the lane.
  argv.push(`--reason=${salvage ? 'health-watch salvage pass (finished-needs-review/unknown-work, unleased)' : 'health-watch reclaim pass (finished-reclaimable)'}`);
  try {
    // A salvage writes + verifies a git bundle first — give it a real budget (a kill mid-salvage leaves the lane
    // untouched: the reset only ever runs after the bundle verified).
    const timeout = salvage ? Math.max(resolveChildTimeoutMs(), 5 * 60_000) : resolveChildTimeoutMs();
    const out = exec('node', argv, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout, killSignal: 'SIGKILL',
      env: { ...process.env, [LANE_JOURNAL_ACTOR_ENV]: HEALTH_WATCH_ACTOR },
    });
    const parsed = JSON.parse(String(out || 'null'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** #4370 — the actor name this daemon stamps on every journal line it causes. */
export const HEALTH_WATCH_ACTOR = 'lane-pool-health-watch';

/**
 * #4370 — journal one litter reap: which files the health watch deleted from which lane, and the lane's state
 * just before. Best-effort (never throws); injectable in {@link watchLanePoolHealth} so tests never write one.
 */
export function defaultJournalLitter({ path, before, removed }) {
  if (!removed || !removed.length) return false;
  return journalLaneEvent(path, {
    action: 'litter-delete', before, reason: `litter-only dirty state reaped: ${removed.join(', ')}`,
    // Litter is disposable by definition; what matters is whether real unpushed COMMITS sat under it.
    unpushed: Number.isFinite(before?.unpushedCommits) ? before.unpushedCommits > 0 : undefined, removed,
  }, { actor: healthWatchActor() });
}

function healthWatchActor() {
  return { name: HEALTH_WATCH_ACTOR, script: 'lane-pool-health-watch', pid: process.pid, ppid: process.ppid };
}

/**
 * #4370 — PURE: whois rows for lanes with a RUNNING worker (a `claude agents` hit by cwd or ledger session that is actually running, not merely listed — #4544) but
 * NO lease — the lane-21 shape (the reaper released it four times while its worker kept building). Lane
 * numbers only, so the health probe can lift it off this tick's JSON line with a flat regex.
 * @param {{lanes?: Array<object>}|null} whois
 * @returns {number[]}
 */
export function workersWithoutLease(whois) {
  return (whois && Array.isArray(whois.lanes) ? whois.lanes : [])
    .filter((row) => row && row.exists && !row.lease && row.liveWorker === true)
    .map((row) => row.lane);
}

/**
 * #3383 gap 2 — for every lane `lane-whois.mjs` verdicted `finished-reclaimable`, call the reclaim command
 * ({@link defaultReclaimLane}) — real when `!dryRun`, a full preservation re-check with no mutation when
 * `dryRun` (mirrors `trim`'s own `--dry-run` contract exactly). A lane whose verdict is `finished-needs-review`
 * or `unknown-work` is normally left for review. Below the low-water threshold, `reclaimPreserved` also
 * selects unleased, unowned, non-kept lanes whose content is proven preserved, regardless of card/PR state.
 * That shortage pass uses plain reclaim only; unpreserved lanes are left alone. PURE-ish shell: takes the already-computed whois report in, calls `reclaimLane` once per
 * candidate, returns the outcomes — no fs/git of its own beyond what `reclaimLane` does.
 *
 * #4344 — a `finished-reclaimable` verdict also covers a lane with NO uncommitted/ahead content at all, which
 * is trivially "nothing to lose" — but every ALREADY-clean lane (no lease, no dirt, sitting right at the pool
 * branch tip) was being handed to `reclaimLane` again on every single pass regardless, each one costing a real
 * `node` + ~10 `git` process tree for a lane that had nothing left to reset. {@link isLaneAlreadyClean} (the
 * pure predicate this now calls first, per candidate) is the NARROWER check that also confirms the checkout is
 * genuinely at rest — HEAD at the pool branch's own current tip, on the right branch — so a lane that is clean
 * but still BEHIND the tip (or on a stray branch) still gets a real reclaim, exactly as before; only the
 * provably-already-at-rest subset is skipped, recorded as `alreadyClean: true` instead of calling `reclaimLane`.
 * Not a new staleness risk — see {@link isLaneAlreadyClean}'s own docblock in `lib/lane-whois-core.mjs` for why.
 * @param {{whois:{lanes:Array<object>, branch?:string}|null, reclaimLane:Function, dryRun:boolean}} o
 * @returns {Array<{lane:number, reclaimed:boolean, wouldReclaim?:boolean, alreadyClean?:boolean, reason?:string}>}
 */
export function reclaimFinishedLanes({ whois, reclaimLane, dryRun, reclaimPreserved = false, salvageEnabled = false, salvageMax = DEFAULT_SALVAGE_MAX_PER_TICK }) {
  if (!whois || !Array.isArray(whois.lanes)) return [];
  const candidates = whois.lanes.filter((row) => row && row.exists && !row.lease && !row.liveOwner
    && !row.holderAlive && !row.kept && (row.verdict === 'finished-reclaimable'
      || (reclaimPreserved && row.preserved === true && row.verdict !== 'in-use')));
  // #4344 — the pool's own branch name (short form). Deliberately fails CLOSED here (unlike
  // `isLaneAlreadyClean`'s own optional `expectedBranch`, whose omission is a caller's on-purpose opt-out): THIS
  // call site always means to enforce the branch-name guard, so a missing/malformed `whois.branch` must never
  // silently turn that guard off — `expectedBranch === null` below means "always reclaim", never "skip anyway".
  const expectedBranch = typeof whois.branch === 'string' ? whois.branch.replace(/^origin\//, '') : null;
  const outcomes = [];
  for (const row of candidates) {
    // Sum the two dirty-path counts ONLY when both are genuinely finite numbers — `null + 5` is `5` and
    // `null + null` is `0` in JS, so a naive `?? null` sum here would silently coerce a missing sub-field back
    // into a "clean" number and defeat `isLaneAlreadyClean`'s own fail-closed guard below.
    const trackedModified = row.uncommitted?.trackedModified;
    const untracked = row.uncommitted?.untracked;
    const uncommittedCount = Number.isFinite(trackedModified) && Number.isFinite(untracked) ? trackedModified + untracked : null;
    // `isLaneAlreadyClean` already fails closed on a malformed/absent count or sha; `expectedBranch !== null`
    // is this call site's OWN fail-closed requirement (see above) — both must hold before a reclaim is skipped.
    if (expectedBranch !== null && isLaneAlreadyClean({
      uncommittedCount,
      trackedModified,
      untracked,
      aheadCount: row.ahead?.count ?? null,
      headSha: row.headSha ?? null,
      branchTipSha: row.branchTipSha ?? null,
      branch: row.branch ?? null,
      expectedBranch,
    })) {
      outcomes.push({ lane: row.lane, reclaimed: false, alreadyClean: true, reason: 'already clean at the pool branch tip — nothing to reclaim' });
      continue;
    }
    const result = reclaimLane({ lane: row.lane, dryRun });
    outcomes.push(result
      ? { lane: row.lane, ...result }
      : { lane: row.lane, reclaimed: false, reason: 'reclaim call unavailable this tick' });
  }
  // SNAPSHOT-THEN-RECLAIM (2026-09-27 pool starvation: 74 of 90 lanes unleased-but-dirty, 0 acquirable). A
  // `finished-needs-review` / `unknown-work` lane with no lease, no live owner and no operator `keep` is
  // handed to `reclaim --salvage`, which re-checks liveness itself (live agent/process in the lane, quiet
  // period), saves every unpreserved change durably (verified bundle + patch + index) and only then resets.
  // Low-water recovery must never fall back to salvage for unpreserved content.
  if (salvageEnabled && !reclaimPreserved) {
    const salvageCandidates = planSalvageCandidates(whois.lanes).slice(0, Math.max(0, salvageMax));
    for (const row of salvageCandidates) {
      const result = reclaimLane({ lane: row.lane, dryRun, salvage: true });
      outcomes.push(result
        ? { lane: row.lane, salvageCandidate: true, ...result }
        : { lane: row.lane, salvageCandidate: true, reclaimed: false, reason: 'salvage-reclaim call unavailable this tick' });
    }
  }
  return outcomes;
}

/** Env knobs for the salvage sub-pass: presence-disables, and a per-tick cap (each salvage writes a bundle). */
export const SALVAGE_DISABLE_ENV_VAR = 'WE_LANE_POOL_SALVAGE_DISABLED';
export const SALVAGE_MAX_ENV_VAR = 'WE_LANE_POOL_SALVAGE_MAX_PER_TICK';
export const DEFAULT_SALVAGE_MAX_PER_TICK = 20;
/** Below this many acquirable lanes, the tick raises a low-pool ALERT line (env override). */
export const LOW_WATER_ENV_VAR = 'WE_LANE_POOL_LOW_WATER';
export const DEFAULT_LOW_WATER = 5;

/** PURE: which whois rows the salvage sub-pass may try — unleased, not live-owned, not operator-kept, and
 *  carrying content the plain reclaim path refuses. Oldest-numbered first (deterministic). */
export function planSalvageCandidates(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.exists && !row.lease && !row.liveOwner && !row.holderAlive && !row.kept
      && !(row.lastHolder && row.lastHolder.liveOwner)
      && (row.verdict === 'finished-needs-review' || row.verdict === 'unknown-work'))
    .sort((a, b) => a.lane - b.lane);
}

/** PURE: the low-pool alert line, or `null` when the pool has at least `lowWater` acquirable lanes. */
export function lowPoolAlert(health, lowWater = DEFAULT_LOW_WATER) {
  if (!health || !(health.acquirable < lowWater)) return null;
  return `ALERT: lane pool low — ${health.acquirable} acquirable (< ${lowWater}) of ${health.total}: ` +
    `${health.leased} leased, ${health.dirtyUnleased} dirty unleased`;
}

/**
 * THE IO SHELL. Reads live pool status, reads each unleased lane's porcelain, plans the reap
 * ({@link planLaneReap}), and — unless `dryRun` — reaps every `action:'reap'` lane via the SAME
 * `we:scripts/lib/lane-litter.mjs#cleanLaneLitter` `cmdRelease` calls at release time, passing
 * {@link defaultIsLeasedNow} straight into that call so its own fresh read and lease re-check gate the
 * mutation from inside its own function body, with no separate pre-check here that could reopen the race
 * window (see `cleanLaneLitter`'s own docblock). Never throws on a per-lane reap failure — one bad lane must
 * not stop the sweep from reaping the rest.
 * #4025 — ALSO runs `trimPool` after the litter-reap above (a litter-only lane is already clean by the time
 * trim evaluates it, so trim never re-derives that decision): the periodic SHRINK half beside this pass's
 * existing periodic reap half. `trimMax` forwards to `trim`'s own `--max`; omitted, `trim` falls back to its
 * own per-repo default cap (see `scripts/lane-pool.mjs`'s `TRIM_DEFAULT_CAP`).
 * #3383 gap 2 — ALSO runs the lane-whois-driven AUTO-RECLAIM pass after trim: a fast (`lane-whois.mjs`'s own
 * #3383-perf follow-up), read-only whois scan over the whole pool, then `reclaim --lane=N` for every
 * `finished-reclaimable` verdict it finds. Gated by {@link RECLAIM_DISABLE_ENV_VAR} (checked by the caller,
 * {@link runLanePoolHealthWatch}, exactly like the whole-pass {@link DISABLE_ENV_VAR}) via the `reclaimEnabled`
 * flag here, so a disabled reclaim pass costs not even the whois scan.
 * @param {{repo?:string|null, root?:string, listStatus?:Function, readPorcelain?:Function, reap?:Function,
 *   isLeasedNow?:Function, dryRun?:boolean, trimPool?:Function, trimMax?:number|null,
 *   listAcquirable?:Function, listWhois?:Function, reclaimLane?:Function, reclaimEnabled?:boolean}} [o]
 * @returns {{health:{total:number,leased:number,acquirable:number,dirtyUnleased:number}, plan:Array<object>,
 *   reaped:number[], dryRun:boolean, trim:object|null, reclaim:{verdicts:object|null,
 *   outcomes:Array<object>}|null}}
 */
export function watchLanePoolHealth({
  repo = null, root = REPO_ROOT, listStatus = defaultListLaneStatus, readPorcelain = defaultReadPorcelain,
  reap = cleanLaneLitter, isLeasedNow = defaultIsLeasedNow, isLiveNow = defaultIsLiveNow, dryRun = false,
  trimPool = defaultTrimPool, trimMax = null, listAcquirable = defaultListAcquirable,
  listWhois = defaultListWhois, reclaimLane = defaultReclaimLane, reclaimEnabled = true,
  writeFreeLaneList = defaultWriteFreeLaneList, salvageEnabled = false, salvageMax = DEFAULT_SALVAGE_MAX_PER_TICK,
  lowWater = DEFAULT_LOW_WATER, retention = null, snapshotLane = laneStateSnapshot, journalLitter = defaultJournalLitter,
  rereadClean = process.env[REREAD_CLEAN_PORCELAIN_ENV] === '1',
} = {}) {
  const status = listStatus({ repo, root });
  // Host churn cut (2026-10-04): `status` JUST ran `git status --porcelain` on every lane, so a row it reported
  // `clean: true` has porcelain '' — re-running it here was a second full-tree stat walk per clean lane per pass
  // (~60-80 per pool per pass). A clean row plans `already-clean` (no action), so skipping the re-read can only
  // ever DEFER a reap to the next pass, never cause one. Dirty/unknown rows are still re-read fresh.
  // `rereadClean` (env WE_HEALTH_WATCH_REREAD_CLEAN_PORCELAIN=1) restores the old always-re-read behaviour.
  const lanes = status.lanes.map((l) => (
    l && l.exists !== false && !l.leased
      ? { ...l, porcelain: l.clean === true && !rereadClean ? '' : readPorcelain(l.path) }
      : l
  ));
  const plan = planLaneReap(lanes);
  const reaped = [];
  if (!dryRun) {
    for (const p of plan) {
      if (p.action !== 'reap') continue;
      try {
        const before = snapshotLane(p.path);
        const outcome = reap(p.path, { isLeasedNow, isLiveNow });
        try { journalLitter({ path: p.path, before, removed: outcome?.removed || [] }); } catch { /* best-effort */ }
        // `outcome.complete` — never a length comparison against this tick's OWN (possibly stale) `p.toRemove`
        // snapshot, which would misjudge a lane whose real litter set changed size between the snapshot and
        // this call. `cleanLaneLitter` judges completeness against its own fresh read; trust that instead.
        if (outcome && outcome.complete) reaped.push(p.lane);
      } catch { /* best-effort — one bad reap never stops the rest of the sweep */ }
    }
  }
  const trim = trimPool({ repo, root, max: trimMax, dryRun });
  // #3383 — read the REAL eligibility answer AFTER the litter-reap above (a lane just reaped to clean is
  // fresh again by the time this runs, and the real `list --acquirable` scan itself reaps dead ghost leases
  // first, #3449) — cross-checked into `summarizeHealth` so this report's "acquirable" count can never
  // diverge from what `acquire`'s own auto-pick would actually do. `null` (real read unavailable this tick)
  // degrades to the pre-#3383 plan-only answer.
  const acquirableLaneNumbers = listAcquirable({ repo, root });
  // #4122 — publish the free-lane list from this SAME real eligibility read, never the plan-only estimate
  // (see `freeLaneRows`'s own docblock). NOT gated on `--dry-run`: publishing this sidecar is a bookkeeping
  // write, not a pool-lane mutation (the same distinction `we:scripts/lane-pool.mjs`'s own
  // `.list-acquirable-cache.json` already draws — that cache is written on every `list --acquirable`, dry-run
  // or not), so a `--dry-run` health-watch pass (litter-reap/trim/reclaim all skipped) still refreshes the one
  // artifact `acquire` actually depends on. Skipped only when `acquirableLaneNumbers` is `null` (this tick's
  // real read failed) — the PREVIOUS list, if any, is left exactly as it was: a slightly-stale-but-sound file
  // beats one just overwritten with an unsound guess. `acquire`'s own freshness check (`isFreeLaneListFresh`)
  // is what retires a list nobody has refreshed in a while — this function only ever decides whether THIS
  // tick may write.
  const freeLaneList = acquirableLaneNumbers
    ? writeFreeLaneList({ repoName: status.repo, poolDir: status.root, rows: freeLaneRows(lanes, acquirableLaneNumbers) })
    : null;
  // #3383 gap 2 — run whois + reclaim LAST: a lane litter-reap or trim just acted on is a different lane from
  // any whois would call finished-reclaimable (whois only ever recommends resetting a lane with real ahead/
  // dirty content — litter-only or already-clean lanes are `lane-whois.mjs`'s own trivial "nothing to lose"
  // case, harmlessly reclaimed too), so ordering here is not load-bearing for correctness, only for keeping
  // this tick's own read of pool state as fresh as possible before the heaviest scan runs.
  const health = summarizeHealth(lanes, plan, reaped, acquirableLaneNumbers);
  const reclaimPreserved = health.acquirable < lowWater;
  let reclaim = null;
  let workerWithoutLease = null;
  if (reclaimEnabled) {
    const whois = listWhois({ repo, root });
    const outcomes = reclaimFinishedLanes({ whois, reclaimLane: (o) => reclaimLane({ repo, root, dryRun, ...o }), dryRun, reclaimPreserved, salvageEnabled, salvageMax });
    reclaim = { verdicts: whois, outcomes };
    workerWithoutLease = whois ? workersWithoutLease(whois) : null;
  }
  const retained = typeof retention === 'function' && status.root
    ? retention({ poolDir: status.root, pool: basename(status.root), dryRun })
    : null;
  // `workerWithoutLease` sits right after `health` so `health-watch.mjs#probeLanePools` finds it near the start
  // of this tick's (large) JSON line.
  return { health, workerWithoutLease, alert: lowPoolAlert(health, lowWater), plan, reaped, dryRun, trim, reclaim, freeLaneList, retention: retained };
}

/** Presence-checked env knob that turns OFF the retention sub-pass (salvage-index refresh/expiry, backfill,
 *  pool-leftover sweep). */
export const RETENTION_DISABLE_ENV_VAR = 'WE_LANE_POOL_RETENTION_DISABLED';

/**
 * The retention sub-pass. Best-effort: never throws (one bad step never stops the others or the tick).
 * @returns {{backfilled:number, salvage:object|null, leftovers:object|null, errors:string[]}}
 */
export function defaultRetention({ poolDir, pool, dryRun = false, salvageRoot = resolveSalvageRoot(), dispatchRoot = null } = {}) {
  const errors = [];
  let backfilled = 0;
  // Hand-made salvage dirs sit directly under the salvage root as `<YYYYMMDD-HHMM[SS]>/lane-N.bundle`.
  if (!dryRun && pool === 'web-everything') {
    try {
      for (const d of readdirSyncFs(salvageRoot).filter((x) => /^\d{8}-\d{4,6}$/.test(x))) {
        backfilled += backfillSalvageDir({
          dir: join(salvageRoot, d), pool, root: salvageRoot,
          laneDirFor: (n) => join(poolDir, `lane-${n}`),
          readLastHolder: (n) => { try { return lastLaneHistoryEntry(readLaneHistory(join(poolDir, `lane-${n}`))); } catch { return null; } },
        }).length;
      }
    } catch (e) { if (e?.code !== 'ENOENT') errors.push(`backfill: ${String(e?.message || e).split('\n')[0]}`); }
  }
  let salvage = null;
  try { salvage = refreshSalvageIndex({ root: salvageRoot, dryRun }); } catch (e) { errors.push(`salvage-index: ${String(e?.message || e).split('\n')[0]}`); }
  let leftovers = null;
  try {
    leftovers = sweepPoolLeftovers({ poolDir, pool, dryRun, salvageRoot, dispatchRoot, liveAgents: dispatchRoot ? readAgentsStrict() : null });
  } catch (e) { errors.push(`leftovers: ${String(e?.message || e).split('\n')[0]}`); }
  return { backfilled, salvage, leftovers, errors };
}

/**
 * THE ENTRYPOINT. Checks {@link DISABLE_ENV_VAR} FIRST — set to any value, this returns `{disabled:true}`
 * having read NOTHING (no `listStatus` call, no reap, no report), so the config knob degrades to a true no-op
 * tick with no change needed to `makeCliMechanicalPasses` itself.
 * @param {{env?:object} & Parameters<typeof watchLanePoolHealth>[0]} [o]
 * @returns {{disabled:true}|ReturnType<typeof watchLanePoolHealth>}
 */
export function runLanePoolHealthWatch({ env = process.env, ...opts } = {}) {
  // PRESENCE-checked, not truthiness-checked: `WE_LANE_POOL_HEALTH_WATCH_DISABLED=` (set to an empty string)
  // must still disable — a bare truthiness check (`if (env[DISABLE_ENV_VAR])`) treats `''` as unset and would
  // silently run anyway, contradicting the "any value" contract documented on `DISABLE_ENV_VAR` above.
  if (env[DISABLE_ENV_VAR] !== undefined) return { disabled: true };
  const reclaimEnabled = env[RECLAIM_DISABLE_ENV_VAR] === undefined && opts.reclaimEnabled !== false;
  const salvageEnabled = reclaimEnabled && env[SALVAGE_DISABLE_ENV_VAR] === undefined && opts.salvageEnabled !== false;
  const maxN = Number(env[SALVAGE_MAX_ENV_VAR]);
  const salvageMax = Number.isInteger(maxN) && maxN >= 0 ? maxN : DEFAULT_SALVAGE_MAX_PER_TICK;
  const lw = Number(env[LOW_WATER_ENV_VAR]);
  const lowWater = Number.isInteger(lw) && lw >= 0 ? lw : DEFAULT_LOW_WATER;
  // Retention is opt-in per caller (the CLI below wires the real one) so no test ever touches the real salvage store.
  const retention = env[RETENTION_DISABLE_ENV_VAR] === undefined && typeof opts.retention === 'function' ? opts.retention : null;
  return watchLanePoolHealth({ salvageMax, lowWater, ...opts, reclaimEnabled, salvageEnabled, retention });
}

/** Reason text for a kept salvage candidate in the plain CLI summary. */
export function formatSalvageKeptLine(o) {
  return o.keptReason || o.reason || 'unknown';
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const repo = flag('repo') || null;
  const dryRun = argv.includes('--dry-run');
  const maxFlag = flag('max');
  const trimMax = maxFlag !== undefined && Number.isInteger(Number(maxFlag)) ? Number(maxFlag) : null;
  try {
    const retention = (o) => defaultRetention({ ...o, dispatchRoot: join(dirname(REPO_ROOT), '.operations', 'dispatch') });
    const result = runLanePoolHealthWatch({ repo, dryRun, trimMax, retention });
    if (result.disabled) {
      timestampedStderr(`  lane-pool-health-watch: disabled (${DISABLE_ENV_VAR} set)\n`);
    } else {
      const { health, plan, reaped, trim, reclaim, freeLaneList, alert } = result;
      timestampedStderr(
        `  pool health: ${health.acquirable} acquirable · ${health.dirtyUnleased} dirty(unleased) · ` +
          `${health.leased} leased · ${health.total} total\n`,
      );
      if (alert) timestampedStderr(`  ${alert}\n`);
      // #4122 — `null` covers three different ticks (dry-run, real-read-unavailable, a write failure); this
      // report line does not need to tell them apart (each already logs its own signal above/below), only
      // whether `acquire` has a fresh list to read after this tick.
      timestampedStderr(
        freeLaneList
          ? `  free-lane list: published ${freeLaneList.count} lane(s) → ${freeLaneList.path}\n`
          : '  free-lane list: not published this tick (no real eligibility read this tick, or a write failure)\n',
      );
      for (const p of plan) {
        if (p.action === 'reap') {
          const verb = dryRun ? 'would reap' : reaped.includes(p.lane) ? 'reaped' : 'FAILED to reap';
          timestampedStderr(`  lane-${p.lane}: ${verb} litter-only dirty state (${p.toRemove.join(', ')})\n`);
        } else if (p.action === 'leave-dirty') {
          timestampedStderr(`  lane-${p.lane}: left dirty — non-allowlisted state present\n`);
        }
      }
      // #4025 — the trim call already prints its own per-lane detail to stderr (it's a real spawned CLI
      // child); this is just the tick-level summary line so a health-watch log scan sees it without having
      // to correlate the child's own separately-captured stderr.
      if (trim) {
        timestampedStderr(
          `  pool trim: ${trim.total} lane(s), cap ${trim.max} → ${dryRun ? 'would remove' : 'removed'} ` +
            `${trim.removed.length} (${trim.total} → ${trim.remaining})` +
            `${trim.overCap > 0 ? ` — ⚠ still ${trim.overCap} over cap` : ''}\n`,
        );
      } else {
        timestampedStderr('  pool trim: unavailable this tick (best-effort — see any error above)\n');
      }
      // #3383 gap 2 — the auto-reclaim summary. `reclaim === null` means the sub-pass itself was disabled
      // (`WE_LANE_POOL_RECLAIM_DISABLED`), never "ran and found nothing" — those two report differently on
      // purpose (an operator scanning logs for "is reclaim even on" needs to tell them apart).
      if (reclaim === null) {
        timestampedStderr(`  lane reclaim: disabled (${RECLAIM_DISABLE_ENV_VAR} set)\n`);
      } else if (!reclaim.verdicts) {
        timestampedStderr('  lane reclaim: whois scan unavailable this tick (best-effort — see any error above)\n');
      } else {
        const plain = reclaim.outcomes.filter((o) => !o.salvageCandidate);
        const done = plain.filter((o) => o.reclaimed);
        const would = plain.filter((o) => o.wouldReclaim);
        const refused = plain.filter((o) => !o.reclaimed && !o.wouldReclaim);
        timestampedStderr(
          `  lane reclaim: ${plain.length} reclaim candidate(s) → ` +
            `${dryRun ? `${would.length} would reclaim` : `${done.length} reclaimed`}` +
            `${refused.length ? `, ${refused.length} refused (preservation re-check failed)` : ''}\n`,
        );
        for (const o of plain) {
          if (o.reclaimed || o.wouldReclaim) {
            timestampedStderr(`    lane-${o.lane}: ${o.reclaimed ? 'reclaimed' : 'would reclaim'} — ${o.reason || 'content provably preserved'}\n`);
            continue;
          }
          timestampedStderr(`    lane-${o.lane}: NOT reclaimed — ${o.reason}\n`);
        }
        const salv = reclaim.outcomes.filter((o) => o.salvageCandidate);
        if (salv.length) {
          const ok = salv.filter((o) => (dryRun ? o.wouldSalvage || o.wouldReclaim : o.reclaimed));
          timestampedStderr(`  lane salvage: ${salv.length} candidate(s) → ${ok.length} ${dryRun ? 'would be salvaged+reset' : 'salvaged+reset'}, ${salv.length - ok.length} kept\n`);
          for (const o of salv) {
            if (o.salvaged) timestampedStderr(`    lane-${o.lane}: salvaged-to ${o.salvage?.bundle || o.salvage?.outDir || '?'} → reset\n`);
            else if (o.reclaimed) timestampedStderr(`    lane-${o.lane}: reset — content already on a remote ref, nothing to salvage (${o.reason || ''})\n`);
            else if (o.wouldSalvage) timestampedStderr(`    lane-${o.lane}: would salvage → reset (${o.reason || ''})\n`);
            else if (dryRun && o.wouldReclaim) timestampedStderr(`    lane-${o.lane}: would reset — content already on a remote ref (${o.reason || ''})\n`);
            else timestampedStderr(`    lane-${o.lane}: kept — ${formatSalvageKeptLine(o)}\n`);
          }
        }
      }
    }
    if (!result.disabled && result.retention) {
      const { backfilled, salvage, leftovers, errors } = result.retention;
      const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
      timestampedStderr(
        `  retention: ${backfilled} manual salvage(s) backfilled; salvage index ${salvage ? `${salvage.landed.length} newly landed, ${salvage.expired.length} ${dryRun ? 'would expire' : 'expired'} (${mb(salvage.bytesFreed)})` : 'unavailable'}; ` +
          `pool leftovers ${leftovers ? `${leftovers.actions.filter((a) => a.action !== 'keep').length} ${dryRun ? 'would be cleaned' : 'cleaned'} (${mb(leftovers.bytesFreed)}), ${leftovers.actions.filter((a) => a.action === 'keep').length} kept, ${leftovers.prunedLanes} lane(s) worktree-pruned, ${leftovers.dispatchRemoved} dispatch scratch dir(s)` : 'unavailable'}` +
          `${errors.length ? ` — errors: ${errors.join('; ')}` : ''}\n`,
      );
      for (const a of leftovers?.actions ?? []) {
        timestampedStderr(`    ${a.name}: ${a.action}${a.error ? ` FAILED (${a.error})` : ''} — ${a.reason}${a.bytes ? ` [${mb(a.bytes)}]` : ''}\n`);
      }
    }
    process.stdout.write(`${JSON.stringify({ checked: true, ...result })}\n`);
  } catch (e) {
    timestampedStderr(`error: ${String(e?.message ?? e)}\n`);
    process.exitCode = 1;
  }
}
