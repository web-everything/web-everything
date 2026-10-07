/**
 * @file scripts/lib/daemon-live-smoke.mjs
 * @description #3383 — THE LIVE SMOKE GATE. `we:scripts/lib/daemon-self-sync.mjs#withSelfSync` merges
 *   `origin/main` into a daemon's dedicated clone and restarts the daemon onto it — historically UNCONDITIONALLY,
 *   the moment the merge lands, with no check that the merged code actually works. Operator, 2026-09-24: "didnt I
 *   say nothing get merge on daemon without being tested live and confirmed?" — a merged PR that day shipped a
 *   lane-pool regression this way and broke every review-daemon session (401s / lane crashes) because nothing
 *   ever ran the new code before the daemon restarted onto it.
 *
 * WHAT THIS FILE ADDS: a live smoke — real child processes, real lane-pool lease/release, a real `gh` read, a
 * real reconcile dry-run — run from the UPDATED tree, in the WINDOW `withSelfSync` already has between "merge
 * succeeded" and "restart onto it". {@link gateMergedCommit} is the one entry point both the daemon wrapper
 * (`daemon-self-sync.mjs`) and the operator's own manual CLI (`we:scripts/lib/daemon-load-overlay.mjs`) call —
 * SAME code path, so a hand-triggered early load is gated exactly like an automatic tick. Pass → adopt (the
 * caller restarts/keeps the merge). Fail → {@link rollbackToSha} (`git reset --hard` to the pre-merge HEAD,
 * allowed only because the clone is verified clean first — never resets a tree we could not confirm was safe to
 * discard) and the merged sha is recorded ({@link recordRejectedSha}) so the SAME broken sha is never
 * re-smoke-tested every tick until `origin/main` actually moves — {@link gateMergedCommit} short-circuits on a
 * repeat instead of re-running the (real, live-touching) checks.
 *
 * THE CHECKS ({@link SMOKE_CHECKS}), one list, one row per check — budgets read from env (see
 * {@link resolveSmokeBudgets}), never hard-coded twice:
 *   (a) `lane-pool.mjs list --acquirable --no-cache --limit=1` for the WE pool, then a REAL `acquire` of one
 *       lane (`--purpose=smoke`, a unique per-run session slug) and an immediate `release` — proves the pool
 *       machinery a dispatch would actually use still works, not just that the file parses.
 *   (b) one GitHub read the way a DISPATCHED session does it: through {@link ghDispatchedSessionEnv} — the
 *       calling process's own ambient `GH_TOKEN`/`GITHUB_TOKEN` stripped (`we:scripts/lib/gh-app-shim.mjs#sanitizeSpawnEnv`,
 *       #4072) THEN the gh App shim's `PATH` override folded on top (`#buildGhShimSettingsEnv` — opt-in,
 *       contributes nothing when the calling process hasn't configured App auth, in which case the check runs
 *       `gh` sanitized-but-unshimmed rather than skip) — `gh api --method GET repos/<repo>` plus `gh pr list
 *       --limit 1`. A 401 here is the gate WORKING: it means the merged code would have dispatched sessions
 *       that get the exact 401 real sessions saw 2026-09-24, and the gate keeps them off it instead of
 *       reporting it after the fact. #4072: BEFORE the sanitize step existed, this check ran with the RAW
 *       calling env, so the daemon's own continuously-refreshed `GH_TOKEN` rode along under the shim's PATH
 *       override and masked exactly the fallback failure real (properly-sanitized) dispatched sessions hit —
 *       the gate passed the same day every bot session got a real 401.
 *   (c) one `we:scripts/conveyor/reconcile-pass.mjs` dry-run per configured constellation repo (`we`,
 *       `frontierui`, `plateau-app` — {@link CONSTELLATION_REPOS}) — read-only (`runReconcilePass` only reads
 *       PRs/agents and plans; it dispatches nothing), run via its own CLI so it exercises the ACTUAL updated
 *       file on disk, not an in-process import of code that might itself be part of what broke.
 * Every check runs through `we:scripts/lib/bounded-child.mjs#runBounded` (spawned, detached, hard-timeout,
 * process-group-killed on timeout) so a hung child can never block a tick forever; every check is run (not
 * fail-fast) so one failure never hides the rest of the diagnostic picture, and the gate's overall verdict is
 * simply "did every check pass".
 *
 * KILL SWITCH: {@link SMOKE_KILL_SWITCH_ENV} (`WE_DAEMON_SMOKE_DISABLE=1`) — this is the ONE place in this
 * module that fails OPEN (adopt unconditionally) rather than closed, by explicit design: a kill switch that
 * itself refuses to work when something is already on fire is not a kill switch.
 *
 * PURE CORE / IO SHELL: {@link decideSmokeVerdict} is pure (given a results array, is the gate a pass?);
 * everything else here does real IO (child processes, fs reads for the reject-cache) through injectable
 * `runChild`/`run` params, same convention as `daemon-self-sync.mjs`'s own `run` injection.
 *
 * TRANSIENT vs. CODE (Module D, card 4041 follow-up) — {@link classifySmokeFailure} is the second, finer-grained
 * verdict on top of {@link decideSmokeVerdict}'s plain pass/fail: a FAILED check can still mean two very
 * different things, and treating them the same was itself a bug. A 401 from `gh`, a flaky 5xx, a DNS hiccup, or
 * a momentarily-exhausted lane pool (every worker lane busy for a few seconds under load) is an
 * ENVIRONMENT/INFRA fault that the OLD code would have hit exactly as hard as the NEW code — it says nothing
 * about whether the merged commit is safe. {@link recordRejectedSha}-ing a merge for a fault like that freezes
 * the daemon on a code-independent problem until a human notices and clears the cache by hand. So every failed
 * check's `detail` string is matched against {@link TRANSIENT_FAILURE_PATTERNS}; the verdict is `'transient'`
 * ONLY when every single failure matches — one genuine code-shaped failure (a thrown SyntaxError, an assertion
 * mismatch, anything not on the list) pulls the whole verdict to `'code'`, because a mix means at least one
 * failure IS evidence the merge broke something, and that must never be laundered through the transient path.
 * {@link runLiveSmokeWithRetry} is what actually uses the classification: on `'transient'` it retries the WHOLE
 * smoke (a fresh run, not just the failed check) up to a small RETRY CAP
 * (`WE_DAEMON_SMOKE_TRANSIENT_RETRIES`, default 2 — i.e. 3 attempts total) with a backoff between attempts
 * (`WE_DAEMON_SMOKE_RETRY_BACKOFF_MS`, default 15s), because most env noise (a rate limit, a busy pool) clears
 * within seconds. The cap exists so a GENUINELY down environment (origin unreachable for the whole window)
 * still gives up in bounded time rather than retrying forever; when the cap is reached the verdict stays
 * `'transient'` (never silently promoted to `'code'`) and {@link gateMergedCommit} rolls the clone back WITHOUT
 * writing a reject record — an env fault must never poison the reject-cache and permanently block a later,
 * healthy re-check of the SAME sha once the environment recovers.
 */

import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBounded, resolveChildTimeoutMs, resolveLaneAcquireTimeoutMs } from './bounded-child.mjs';
import { buildGhShimSettingsEnv, sanitizeSpawnEnv } from './gh-app-shim.mjs';
import { ensureFreshGithubAppEnv } from './github-app-auth-env.mjs';
import { collectImportClosure, closureHits } from './import-closure.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { gitRun } from './main-staleness.mjs';
import { DAEMON_BOOT_SMOKE_CHECK, DEFAULT_DAEMON_BOOT_MS } from './daemon-boot-smoke.mjs';

/** Set to `1`/`true`/`yes` to disable the whole gate — every merge is adopted unconditionally, exactly like
 *  before this file existed. The one intentionally fail-OPEN switch in this module. */
export const SMOKE_KILL_SWITCH_ENV = 'WE_DAEMON_SMOKE_DISABLE';

/** Is the gate disabled? */
export function isSmokeGateDisabled(env = process.env) {
  const v = String(env?.[SMOKE_KILL_SWITCH_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Env var names for each check's budget override — see {@link resolveSmokeBudgets}. */
export const SMOKE_BUDGET_ENV = Object.freeze({
  lanePoolListMs: 'WE_SMOKE_LANE_POOL_LIST_MS',
  laneAcquireMs: 'WE_SMOKE_LANE_ACQUIRE_MS',
  laneReleaseMs: 'WE_SMOKE_LANE_RELEASE_MS',
  ghApiMs: 'WE_SMOKE_GH_API_MS',
  ghPrListMs: 'WE_SMOKE_GH_PR_LIST_MS',
  reconcileMs: 'WE_SMOKE_RECONCILE_MS',
  // #3383 Module D — how long the smoke's own `lane-pool.mjs acquire` may WAIT (`--wait-ms=`) for a busy pool
  // to free a lane, instead of failing instantly on a momentary flicker. See `checkLaneAcquireRelease`.
  laneAcquireWaitMs: 'WE_SMOKE_LANE_ACQUIRE_WAIT_MS',
  // xp4lw2v (epic #4075/#3383) — the two new checks below. `dispatchDryRunMs` covers three direct dispatch
  // fills (no IO) plus three real reconcile passes over LIVE open `we` PRs (each a `gh pr list`, plus a `gh pr
  // diff`/`gh api` per PR needing a diff-derived scope fallback) — see `checkDispatchDryRun`.
  // `treeStaysCleanMs` is one bare `git status --porcelain`, always fast.
  dispatchDryRunMs: 'WE_SMOKE_DISPATCH_DRY_RUN_MS',
  treeStaysCleanMs: 'WE_SMOKE_TREE_STAYS_CLEAN_MS',
  // #4468 — {@link checkDaemonEntriesBoot}'s own budget; see `daemon-boot-smoke.mjs`.
  daemonBootMs: 'WE_SMOKE_DAEMON_BOOT_MS',
  // The two BUSY-POOL caps (see {@link busyPoolSkip}): the most the pool probes may spend before they are SKIPPED
  // (recorded, ok) instead of holding the whole smoke. A rebuild smoke took ~1000s live (2026-10-03) because
  // `lane-pool list` ran 206s and `acquire` 181s on a loaded host.
  lanePoolBusyCapMs: 'WE_SMOKE_LANE_POOL_BUSY_CAP_MS',
  laneAcquireBusyCapMs: 'WE_SMOKE_LANE_ACQUIRE_BUSY_CAP_MS',
});

function envMs(env, key, fallback) {
  const n = Number(env?.[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SMOKE_LOAD_SCALE_ENV = 'WE_SMOKE_LOAD_SCALE';
export const SMOKE_LOAD_SCALE_MAX_ENV = 'WE_SMOKE_LOAD_SCALE_MAX';
export const DEFAULT_SMOKE_LOAD_SCALE_MAX = 4;

// Live 2026-10-04: load ~48 made dispatch-dry-run take 80–115s; smoke-env-timeout
// held PRs #3903/#3916/#3917 off wev-control and wev-review-daemon. Scale default
// check budgets with host load, keeping operator overrides absolute and busy-pool caps short.
/** Pure load factor with injected host probes; unavailable probes leave budgets unchanged. */
export function smokeLoadFactor(env, { load, cores }) {
  if (env?.[SMOKE_LOAD_SCALE_ENV] === '0') return 1;
  try {
    const maxFactor = envMs(env, SMOKE_LOAD_SCALE_MAX_ENV, DEFAULT_SMOKE_LOAD_SCALE_MAX);
    const ratio = load() / Math.max(1, cores());
    return Number.isNaN(ratio) ? 1 : Math.max(1, Math.min(ratio, maxFactor));
  } catch { return 1; }
}

/** Non-negative integer env override (unlike {@link envMs}, `0` is a valid, meaningful value — e.g. "no
 *  retries"). Falls back on anything else (missing, negative, non-numeric). */
function envNonNegInt(env, key, fallback) {
  const n = Number(env?.[key]);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Resolve every check's budget from env, falling back to a sane default (or to `bounded-child.mjs`'s own
 *  budgets, the single source for the generic/acquire timeouts). @returns {Record<string, number>} */
export function resolveSmokeBudgets(env = process.env, { load = () => loadavg()[0], cores = () => cpus().length } = {}) {
  const factor = smokeLoadFactor(env, { load, cores });
  const budgets = {
    lanePoolListMs: envMs(env, SMOKE_BUDGET_ENV.lanePoolListMs, resolveChildTimeoutMs(env)),
    laneAcquireMs: envMs(env, SMOKE_BUDGET_ENV.laneAcquireMs, resolveLaneAcquireTimeoutMs(env)),
    laneAcquireWaitMs: envMs(env, SMOKE_BUDGET_ENV.laneAcquireWaitMs, 30_000),
    lanePoolBusyCapMs: envMs(env, SMOKE_BUDGET_ENV.lanePoolBusyCapMs, 60_000),
    laneAcquireBusyCapMs: envMs(env, SMOKE_BUDGET_ENV.laneAcquireBusyCapMs, 120_000),
    laneReleaseMs: envMs(env, SMOKE_BUDGET_ENV.laneReleaseMs, resolveChildTimeoutMs(env)),
    ghApiMs: envMs(env, SMOKE_BUDGET_ENV.ghApiMs, 30_000),
    ghPrListMs: envMs(env, SMOKE_BUDGET_ENV.ghPrListMs, 30_000),
    // Live 2026-10-04: the dispatch dry-run's three LIVE passes took ~90s on a quiet host (load ~10), all of it
    // waiting on gh/git children — the cost grows with the open-PR count, not with load. 45s/60s held every
    // daemon clone off main (`smoke-env-timeout`). Generous defaults, still load-scaled below.
    reconcileMs: envMs(env, SMOKE_BUDGET_ENV.reconcileMs, 120_000),
    dispatchDryRunMs: envMs(env, SMOKE_BUDGET_ENV.dispatchDryRunMs, 180_000),
    treeStaysCleanMs: envMs(env, SMOKE_BUDGET_ENV.treeStaysCleanMs, 10_000),
    daemonBootMs: envMs(env, SMOKE_BUDGET_ENV.daemonBootMs, DEFAULT_DAEMON_BOOT_MS),
  };
  for (const key of Object.keys(budgets)) {
    if (key === 'lanePoolBusyCapMs' || key === 'laneAcquireBusyCapMs' || key === 'laneAcquireWaitMs') continue;
    if (envMs(env, SMOKE_BUDGET_ENV[key], null) === null) budgets[key] = Math.round(budgets[key] * factor);
  }
  return budgets;
}

const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
// #4044: a crashed node child's first stderr line is only the stack LOCATION (`node:internal/modules/cjs/
// loader:1227`) — the live 08:14 ET smoke-rejected alert carried nothing else, hiding that the gh shim's baked
// throttle path was missing. Keep the first line, and append the first real `…Error:` line when it differs.
const failureLine = (e) => {
  const lines = String((e && e.message) || e).split('\n');
  const err = lines.find((l) => /\b[A-Za-z]*Error\b[:\s]|Cannot find module/.test(l));
  return err && err !== lines[0] ? `${lines[0]} — ${err.trim()}` : lines[0];
};

// ── BUSY-POOL SKIP (live 2026-10-03 21:16-21:39 ET, `wev-review-daemon`) ─────────────────────────────────────────
// A rebuild smoke took ~1000s: `lane-pool list` 206s and `lane-acquire-release` 181s. Not a bug in the tree — the
// host was loaded and the pool busy: `list --acquirable` probes lanes one by one (git per lane, ~2.5s each under
// load), and `acquire --wait-ms` polls the pool scan, which queues behind other holders' scan lock ("gave up
// waiting for the shared acquirability-scan lock"). While the smoke ran, main moved every ~2 min, so the clone
// never caught up and every review dispatch was refused as stale.
//
// What the two rows prove is that THE TREE'S lane-pool code still lists, acquires and releases. That question is
// unanswerable while the pool is saturated by OTHER sessions, so a probe that spends its whole (short) cap with
// the host provably busy is reported `skipped: busy pool` (ok, recorded) rather than failing — or worse,
// triggering the widened env-timeout retry that made it longer still. A pool problem that IS the tree's fault
// still fails: a check that ends fast, fails with anything but a time-out/exhaustion signature, or ends while the
// host is idle is NOT skipped.
//
// NO LAUNDERING (the rule `mayBeTransient:false` exists for): the tree's own text can print "no free lane", and
// a hung tree can simply sleep. So a skip needs ALL of: (1) a time-out/exhaustion signature, (2) the gate's own
// clock shows the probe really spent >= 90% of its cap, and (3) evidence from OUTSIDE the tree that the host is
// busy (1-minute load average >= CPU count, `WE_SMOKE_BUSY_LOAD_RATIO` scales it). The rest of the smoke
// (reconcile, dispatch dry-run, daemon boot, tree-stays-clean) still gates adoption.
/** lane-pool's own "another acquire still held the shared scan lock" refusal (#xj2k2pp). It names a DIFFERENT
 *  caller's work, never the tree under test, so it is busy-pool on its own — no host-load check needed. Live
 *  2026-10-04: this text matched no signature, so the smoke blamed the only overlay (PR #3902/#3903, the
 *  verify-dispatch ENOTDIR fix) and dropped it twice while no gate ran host-wide. */
export const LOCK_CONTENTION_SIGNATURE = /scan was still running when this call's --wait-ms elapsed \(lock contention\)|gave up waiting for the shared acquirability-scan lock/;
export const BUSY_POOL_SIGNATURES = Object.freeze([
  /^[^:]+ failed: timed out after \d+ms \(process group killed\)$/,
  /scan exceeded its \d+ms budget/,
  /gave up waiting for the shared acquirability-scan lock/,
  /no free lane/i,
  LOCK_CONTENTION_SIGNATURE,
]);
export const SMOKE_BUSY_LOAD_RATIO_ENV = 'WE_SMOKE_BUSY_LOAD_RATIO';

/** Is the host busy, judged from outside the tree under test? Injectable via `ctx.hostBusy`. */
export function hostLooksBusy(env = process.env, { load = () => loadavg()[0], cores = () => cpus().length } = {}) {
  try {
    const ratio = envMs(env, SMOKE_BUSY_LOAD_RATIO_ENV, 1);
    return load() >= Math.max(1, cores()) * ratio;
  } catch { return false; }
}

/** PURE-ish: the `skipped: busy pool` result for a failed probe, or `null` when the failure must stand. */
export function busyPoolSkip({ what, detail, elapsedMs, capMs, ctx }) {
  const text = String(detail ?? '');
  if (!BUSY_POOL_SIGNATURES.some((re) => re.test(text))) return null;
  if (!(elapsedMs >= capMs * 0.9)) return null;
  const busy = LOCK_CONTENTION_SIGNATURE.test(text)
    || (typeof ctx.hostBusy === 'function' ? ctx.hostBusy() : hostLooksBusy(ctx.env));
  if (!busy) return null;
  return {
    ok: true, skipped: true, skipReason: 'busy-pool',
    detail: `skipped: busy pool — ${what} used its ${Math.round(capMs / 1000)}s cap (${Math.round(elapsedMs / 1000)}s) with the host busy: ${text.slice(0, 200)}`,
  };
}

async function checkLanePoolList(ctx) {
  const { root, budgets, runChild, env } = ctx;
  const capMs = Math.min(budgets.lanePoolListMs, budgets.lanePoolBusyCapMs);
  const t0 = (ctx.clock ?? Date.now)();
  try {
    // #4139 live bug (test litter reaching the real pool, card 4061 row 1 — `lane-999999` a "test-fixture id
    // reaching the real pool"): this call used to omit `env` entirely, so `runBounded`'s underlying `spawn`
    // fell back to ITS OWN calling process's ambient env rather than whatever isolated `env` (a private
    // `LANE_POOL_ROOT`, in the daemon-scenario-simulator's case — see `we:scripts/conveyor/__tests__/sim/`)
    // the caller of {@link runLiveSmoke} explicitly constructed. That silently re-targeted the REAL shared
    // `~/workspace/.lanes/web-everything` pool from inside a supposedly-isolated simulated world. Forwarding
    // `env` here is a no-op in production (the default `env = process.env` at `runLiveSmoke`'s own boundary
    // already IS the real ambient env), so this only changes behavior for a caller that deliberately passed a
    // different one — exactly the case that was silently being dropped.
    const out = await runChild('node', ['scripts/lane-pool.mjs', 'list', '--acquirable', '--no-cache', '--limit=1', '--json'], {
      cwd: root, timeoutMs: capMs, env,
    });
    JSON.parse(out);
    return { ok: true, detail: 'lane-pool list --acquirable --no-cache --limit=1 ok' };
  } catch (e) {
    const detail = `lane-pool list --acquirable failed: ${firstLine(e)}`;
    return busyPoolSkip({ what: 'lane-pool list', detail, elapsedMs: (ctx.clock ?? Date.now)() - t0, capMs, ctx })
      ?? { ok: false, detail };
  }
}

async function checkLaneAcquireRelease(ctx) {
  const { root, budgets, sessionSlug, runChild, env } = ctx;
  let laneNum = null;
  // The child must outlive its own `--wait-ms` plus the real clone/refresh work, but never past the busy cap.
  const acquireCapMs = Math.max(budgets.laneAcquireWaitMs + 30_000, Math.min(budgets.laneAcquireBusyCapMs, Math.max(budgets.laneAcquireMs, budgets.laneAcquireWaitMs + 60_000)));
  const t0 = (ctx.clock ?? Date.now)();
  try {
    // #3383 Module D — `--wait-ms=<laneAcquireWaitMs>` lets a momentarily-exhausted pool (every lane busy for
    // a few seconds under real dispatch load) self-heal instead of failing the gate on the very first read;
    // `lane-pool.mjs`'s own `cmdAcquire` polls internally up to that bound before giving up with its "no free
    // lane" message. The child's hard timeout covers that wait plus the acquire's real work, capped at
    // `laneAcquireBusyCapMs` (see {@link busyPoolSkip}); a short `--ttl-minutes` means a lease whose acquire was
    // killed mid-flight expires by itself.
    // #4139 — see {@link checkLanePoolList}'s own comment just above: `env` must reach every lane-pool child
    // this gate spawns, never just some of them, or an isolated caller's pool override is only PARTLY honored.
    const out = await runChild('node', [
      'scripts/lane-pool.mjs', 'acquire', '--purpose=smoke', `--session=${sessionSlug}`,
      `--wait-ms=${budgets.laneAcquireWaitMs}`, '--ttl-minutes=10', '--json',
    ], {
      cwd: root, timeoutMs: acquireCapMs, env,
    });
    const parsed = JSON.parse(out);
    laneNum = Number.isInteger(parsed?.lane) ? parsed.lane : null;
    if (laneNum == null) return { ok: false, detail: 'lane-pool acquire returned no lane number' };
  } catch (e) {
    const detail = `lane-pool acquire --purpose=smoke failed: ${firstLine(e)}`;
    const skip = busyPoolSkip({ what: 'lane-pool acquire', detail, elapsedMs: (ctx.clock ?? Date.now)() - t0, capMs: budgets.laneAcquireWaitMs, ctx });
    if (!skip) return { ok: false, detail };
    // A killed acquire may have written a lease just before it died: release this smoke session's leases (best-effort).
    try {
      await runChild('node', ['scripts/lane-pool.mjs', 'release', '--all-pools', `--session=${sessionSlug}`], { cwd: root, timeoutMs: budgets.laneReleaseMs, env });
    } catch { /* the 10-minute lease TTL covers it */ }
    return skip;
  }
  try {
    await runChild('node', ['scripts/lane-pool.mjs', 'release', `--lane=${laneNum}`, `--session=${sessionSlug}`], {
      cwd: root, timeoutMs: budgets.laneReleaseMs, env,
    });
    return { ok: true, detail: `acquired + released lane-${laneNum}`, lane: laneNum };
  } catch (e) {
    // A stuck release still leaves a REAL lease held against the live pool — surfacing it as a gate failure
    // (never swallowed) is deliberate: a leaked smoke lease is exactly the kind of thing that should block
    // adopting the code that caused it, not just get logged and forgotten.
    return { ok: false, detail: `acquired lane-${laneNum} but release failed (lease leaked — needs a hand release): ${firstLine(e)}`, lane: laneNum };
  }
}

/**
 * Build the env the gate's gh checks run with — the SAME composition a real dispatched `claude --bg` session
 * gets (`we:scripts/operations/dispatch-lane-io.mjs#buildSpawnOptions`/`#resolveSettingsEnv`): the CALLING
 * process's own ambient `GH_TOKEN`/`GITHUB_TOKEN` stripped FIRST ({@link sanitizeSpawnEnv} — a dispatched
 * session never inherits its spawner's token), THEN the App shim's `PATH` override folded on top when App
 * auth is configured ({@link buildGhShimSettingsEnv} — the same `--settings` env object a dispatcher hands the
 * session).
 *
 * #4072, live-caught 2026-09-24: the PRE-FIX gate instead did `{...env, ...shimEnv}` — the shim override
 * merged onto the RAW, un-sanitized env. `github-app-auth-env.mjs#ensureFreshGithubAppEnv` keeps `GH_TOKEN`
 * set and CONTINUOUSLY FRESH on the daemon's own long-running process (needed for the daemon's own gh/git
 * calls) — so that ambient token rode along underneath the PATH override every time this gate ran. The
 * generated shim script ignores an inherited `GH_TOKEN` while its OWN shared token cache is fresh, but FALLS
 * BACK to whatever `GH_TOKEN` it was invoked with (`runInherited(process.env)`) the moment that shared cache
 * is empty or stale — precisely the moment a REAL dispatched session (whose spawn env is ALWAYS sanitized,
 * never carrying the daemon's token at all) instead falls back to no token and gets a real 401. The gate's own
 * `gh` checks quietly rode the daemon's always-fresh fallback and passed, every time, while bot sessions with
 * no such fallback failed — sanitizing here first closes that gap: the gate's checks can no longer pass on a
 * fallback a dispatched session could never reach.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{pathEnv?:string, exists?:Function, writeFile?:Function, chmod?:Function, mkdir?:Function,
 *   readFile?:Function, cachePath?:string, dir?:string, cwd?:string}} [shimOpts] forwarded to
 *   {@link buildGhShimSettingsEnv} — test injection only; production callers pass none (real fs, real PATH).
 * @returns {NodeJS.ProcessEnv}
 */
export function ghDispatchedSessionEnv(env = process.env, shimOpts = {}) {
  const sanitized = sanitizeSpawnEnv(env);
  const shimEnv = buildGhShimSettingsEnv({ env, ...shimOpts });
  return shimEnv ? { ...sanitized, ...shimEnv } : sanitized;
}

async function checkGhApiRepo({ ghChildEnv, budgets, runChild }) {
  const slug = CONSTELLATION_REPOS.we.slug;
  try {
    await runChild('gh', ['api', '--method', 'GET', `repos/${slug}`], { env: ghChildEnv, timeoutMs: budgets.ghApiMs });
    return { ok: true, detail: `gh api --method GET repos/${slug} ok` };
  } catch (e) {
    return { ok: false, detail: `gh api --method GET repos/${slug} failed: ${failureLine(e)}` };
  }
}

async function checkGhPrList({ ghChildEnv, budgets, runChild }) {
  const slug = CONSTELLATION_REPOS.we.slug;
  try {
    await runChild('gh', ['pr', 'list', '--limit', '1', '--repo', slug, '--json', 'number'], { env: ghChildEnv, timeoutMs: budgets.ghPrListMs });
    return { ok: true, detail: `gh pr list --repo ${slug} --limit 1 ok` };
  } catch (e) {
    return { ok: false, detail: `gh pr list --repo ${slug} --limit 1 failed: ${failureLine(e)}` };
  }
}

async function checkReconcileDryRun({ root, repos, budgets, runChild, env }) {
  const failures = [];
  for (const slug of repos) {
    try {
      // x5wbsbc — `env` too (like every lane-pool check, #4139): a candidate smoke's env carries the LIVE
      // clone's pool root / dispatch root (`daemon-rebuild.mjs#candidateSmokeEnv`), never the candidate path's.
      await runChild('node', ['scripts/conveyor/reconcile-pass.mjs', `--repo=${slug}`, '--json'], { cwd: root, timeoutMs: budgets.reconcileMs, env });
    } catch (e) {
      failures.push(`${slug}: ${firstLine(e)}`);
    }
  }
  if (failures.length) {
    return { ok: false, detail: `reconcile-pass dry-run failed for ${failures.length}/${repos.length} repo(s): ${failures.join('; ')}` };
  }
  return { ok: true, detail: `reconcile-pass dry-run ok for ${repos.length} repo(s)` };
}

// ── xp4lw2v (epic #4075/#3383) — dispatch-dry-run: what would have caught the live crash of 2026-09-25 ──────
// (commit a6cbfced4 fixed it): `dispatchCiHeal` threw "no value for the brief placeholder {{SCOPE}}" for a PR
// with no backlog item and an empty diff-derived scope. This check dry-runs EACH dispatch kind (review, fix,
// ci-heal) from the CANDIDATE TREE (`cwd: root`), against the live repo, with a STUB spawner/sink: nothing is
// ever spawned, and every claim/lane-pool primitive is stubbed to a no-op so the real coordination sidecar and
// lane pool are never touched. Code from the tree under test runs as a CHILD process (never an in-process
// import), so this check is `mayBeTransient:false` and `codeEntries` lists the dispatch modules it runs.
//
// WHAT IT COVERS:
//   - a DIRECT call to each of `dispatchReview`/`dispatchFix`/`dispatchCiHeal` with worst-case-but-legal
//     planned entries — an item-less PR with an EMPTY diff-derived scope for ci-heal (the exact a6cbfced4
//     shape: `dispatchFix`'s own planner refuses that shape before ever calling it, so it is not a legal input
//     there) and an item-less PR with a NON-EMPTY diff-derived scope for fix/ci-heal both (the ordinary
//     item-less shape each of their planners actually produces) — using real brief files and a real repo
//     profile for `we`, and a stub sink/spawner that captures the filled prompt and spawns nothing;
//   - the PASS LEVEL, once per kind, with dispatch stubbed: `runReconcileFixDispatch`/`runReconcileCiHealDispatch`
//     (`we:scripts/conveyor/reconcile-fix-dispatch.mjs` / `we:scripts/operations/ci-heal-pr-dispatch.mjs`) and
//     the review daemon's own `runReviewTick` (`we:skills-src/conveyor/review-daemon.mjs`) — so the REAL
//     planner runs its REAL `reconcile-pass.mjs` read over the LIVE open `we` PRs (real `gh` reads) and every
//     planned entry is dispatched into a stub that spawns nothing. Lane selection is stubbed (`pickFreeLanes`),
//     the fix pass's own resume-candidate check is stubbed (`tryResume` — it would otherwise read
//     `claude agents --json` and a real lane's git HEAD for no reason this dry-run needs), and every WRITE
//     effect the review daemon's tick would otherwise perform (`holdReconcile`/`tagRound`/`tagStatus` — real
//     `gh` label writes) is stubbed to a no-op so this check touches no real PR.
//
// WHAT IT DOES NOT COVER: it never exercises the REAL `claude --bg` spawn, the REAL claim/lane-pool primitives
// (`fix-dispatch-claim.mjs`'s real `acquireFixDispatchClaim`/`releaseFixDispatchClaim`, or `lane-pool.mjs`
// itself — covered separately by `lane-pool-list`/`lane-acquire-release`), or a resume attempt
// (`tryResumeFix`) — only that a fill-and-hand-to-the-sink pass, for every dispatch kind, over live PRs,
// completes with no thrown error and no unfilled `{{...}}` placeholder left in what would have been sent.
//
// FAILS (non-zero exit from the child, caught below) on any throw from a dispatch call, OR when a filled
// prompt/brief the stub captured still contains an unfilled `{{...}}` placeholder — the error text names the
// kind and PR.
// The child resolves every module off ITS cwd (the candidate tree) through `load(...)` rather than static
// `import ... from '<path>'` lines: static specifiers inside this file's own string literals were read as THIS
// module's imports by the repo's import-graph scanner (`we:scripts/operations/__tests__/import-graph.mjs`),
// which then resolved them against `scripts/lib/` and failed.
const DISPATCH_DRY_RUN_LINES = [
  // Split so neither this file's closure scanner (`import-closure.mjs`: a non-literal dynamic import marks the
  // closure incomplete, which would disable skip-unchanged for every check) nor the import-graph scanner reads it.
  "const load = (rel) => im" + "port(new URL(rel, 'file://' + process.cwd() + '/').href);",
  "const { dispatchReview, REVIEW_BRIEF_PLACEHOLDERS, canonicalReviewPlaceholder } = await load(['scripts', 'operations', 'review-dispatch.mjs'].join('/'));",
  "const { dispatchFix, runReconcileFixDispatch } = await load(['scripts', 'conveyor', 'reconcile-fix-dispatch.mjs'].join('/'));",
  "const { dispatchCiHeal, runReconcileCiHealDispatch } = await load(['scripts', 'operations', 'ci-heal-pr-dispatch.mjs'].join('/'));",
  "const { DISPATCH_EFFECT, BRIEF_REQUIRED_BY_KIND, canonicalPlaceholder } = await load(['scripts', 'operations', 'dispatch-lane.mjs'].join('/'));",
  "const { runReviewTick } = await load(['skills-src', 'conveyor', 'review-daemon.mjs'].join('/'));",
  "const { CONSTELLATION_REPOS } = await load(['scripts', 'lib', 'constellation-repos.mjs'].join('/'));",
  "const WE_SLUG = CONSTELLATION_REPOS.we.slug; // repo-explicit, never a literal slug (multi-repo-checks)",
  "",
  "const results = [];",
  "const noopAcquire = () => ({ ok: true });",
  "const noopRelease = () => ({ released: true });",
  "const skipStaleness = () => ({ fresh: true, behind: 0 });",
  "const TOKEN_RE = /\\{\\{\\s*([^{}\\n]*?)\\s*\\}\\}/g;",
  "",
  "// Every brief's own prose legitimately says things like 'fills the {{PLACEHOLDERS}} below' as documentation",
  "// (fillBrief/fillReviewBrief both report such tokens as non-fatal 'unknown', by design — see their own",
  "// docblocks) — a bare '{{...}}' scan would flag that prose as a false positive on every healthy run. So this",
  "// only flags a leftover token whose CANONICALIZED name is one of THIS kind's own REQUIRED placeholder names:",
  "// fillBrief/fillReviewBrief already throw before returning when a required name has no value, so a required",
  "// name surviving unfilled in a prompt that was actually returned is a defense-in-depth signal that their own",
  "// throw-on-missing contract was silently bypassed, never a benign documentation string.",
  "function checkFilled(promptText, label, canonicalize, requiredNames) {",
  "  const text = String(promptText || '');",
  "  let m;",
  "  TOKEN_RE.lastIndex = 0;",
  "  while ((m = TOKEN_RE.exec(text)) !== null) {",
  "    const canon = canonicalize(m[1]);",
  "    if (canon && requiredNames.includes(canon)) {",
  "      throw new Error(label + ': required placeholder {{' + canon + '}} left unfilled in the filled prompt (matched ' + m[0] + ')');",
  "    }",
  "  }",
  "}",
  "function record(kind, pr, fn) {",
  "  try { fn(); results.push({ kind, pr: pr === undefined ? null : pr, ok: true }); }",
  "  catch (e) { results.push({ kind, pr: pr === undefined ? null : pr, ok: false, error: String((e && e.message) || e) }); }",
  "}",
  "async function recordAsync(kind, pr, fn) {",
  "  try { await fn(); results.push({ kind, pr: pr === undefined ? null : pr, ok: true }); }",
  "  catch (e) { results.push({ kind, pr: pr === undefined ? null : pr, ok: false, error: String((e && e.message) || e) }); }",
  "}",
  "",
  "// 1. review — direct dispatchReview call. review-dispatch never derives an item/scope, so any positive PR",
  "// number is legal input to it; the PR need not exist for the brief to fill (no gh read happens here).",
  "record('review', 900001, () => {",
  "  const spawn = () => 'stub-review-900001';",
  "  const r = dispatchReview({ pr: 900001, repo: WE_SLUG, spawnAgent: spawn, extraArgs: [], checkStaleness: skipStaleness, judgeProvider: 'claude' });",
  "  checkFilled(r.prompt, 'review PR #900001', canonicalReviewPlaceholder, REVIEW_BRIEF_PLACEHOLDERS);",
  "});",
  "",
  "// 2. fix — direct dispatchFix call: an item-less PR with a NON-EMPTY diff-derived scope, the one legal shape",
  "// planFixesFromReconcile ever hands dispatchFix for an item-less PR (its own planner refuses an item-less",
  "// PR with an empty scope as 'no-scope' before dispatchFix is ever called, so that shape is not legal input",
  "// here the way it is for ci-heal below).",
  "record('fix', 900002, () => {",
  "  // This is a brief-fill dry run: availability must describe the injected Claude spawner, not the host's CLIs.",
  "  let captured = null;",
  "  const spawn = (argv) => { captured = argv[argv.length - 1]; return 'stub-fix-900002'; };",
  "  dispatchFix(",
  "    { itemNum: null, pr: 900002, laneRef: 'lane/900002-smoke-fix', scope: ['we:scripts/lib/daemon-live-smoke.mjs'], lane: 90101, headRefOid: null },",
  "    { repo: 'we', spawnAgent: spawn, providerAvailable: p => p === 'claude', extraArgs: [], acquireClaim: noopAcquire, releaseClaim: noopRelease },",
  "  );",
  "  checkFilled(captured, 'fix PR #900002', canonicalPlaceholder, BRIEF_REQUIRED_BY_KIND.fix);",
  "});",
  "",
  "// 3a. ci-heal — WORST CASE, the exact a6cbfced4 live-crash shape: an item-less PR with an EMPTY",
  "// diff-derived scope. runReconcileCiHealDispatch's own plan/dispatch loop is ONE phase (unlike fix's",
  "// plan-then-dispatch split), so this shape reaches dispatchCiHeal for real — SCOPE must be optional for",
  "// ci-heal, or this throws exactly as the pre-fix code did.",
  "await recordAsync('ci-heal-worst-case', 900003, async () => {",
  "  let captured = null;",
  "  const sinks = { [DISPATCH_EFFECT]: async (payload) => { captured = payload.prompt; return { handle: 'stub-cih-a' }; } };",
  "  await dispatchCiHeal(",
  "    { itemNum: null, pr: 900003, laneRef: 'lane/900003-smoke-cih', scope: [], lane: 90102, headRefOid: null },",
  "    { repo: 'we', sinks, acquireClaim: noopAcquire, releaseClaim: noopRelease },",
  "  );",
  "  checkFilled(captured, 'ci-heal-worst-case PR #900003', canonicalPlaceholder, BRIEF_REQUIRED_BY_KIND['ci-heal']);",
  "});",
  "",
  "// 3b. ci-heal — ordinary: an item-less PR with a non-empty diff-derived scope.",
  "await recordAsync('ci-heal-ordinary', 900004, async () => {",
  "  let captured = null;",
  "  const sinks = { [DISPATCH_EFFECT]: async (payload) => { captured = payload.prompt; return { handle: 'stub-cih-b' }; } };",
  "  await dispatchCiHeal(",
  "    { itemNum: null, pr: 900004, laneRef: 'lane/900004-smoke-cih', scope: ['we:scripts/operations/ci-heal-pr-dispatch.mjs'], lane: 90103, headRefOid: null },",
  "    { repo: 'we', sinks, acquireClaim: noopAcquire, releaseClaim: noopRelease },",
  "  );",
  "  checkFilled(captured, 'ci-heal-ordinary PR #900004', canonicalPlaceholder, BRIEF_REQUIRED_BY_KIND['ci-heal']);",
  "});",
  "",
  "// 4. pass level — the REAL planner (reconcile-pass.mjs) over LIVE open 'we' PRs (real gh reads); dispatch",
  "// stubbed so nothing is ever spawned. Lane selection and (for fix) the resume-candidate check are stubbed",
  "// too — neither needs a real pool/agents read for this dry run. WE_SMOKE_DISPATCH_PASSES=0 skips this part",
  "// (a unit test with no GitHub credential runs only the direct dispatch calls above).",
  "if (process.env.WE_SMOKE_DISPATCH_PASSES !== '0') {",
  "record('reconcile-fix-pass', null, () => {",
  "  const stubDispatch = (planned) => ({ agentId: null, sessionSlug: 'stub-fix', pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [], resumed: false });",
  "  const r = runReconcileFixDispatch({",
  "    repo: WE_SLUG, dispatch: stubDispatch, tryResume: () => ({ resumed: false, resumeAttempt: null }),",
  "    pickFreeLanes: () => [90201, 90202, 90203, 90204, 90205], checkStaleness: skipStaleness,",
  "  });",
  "  if (!Array.isArray(r.dispatched) || !Array.isArray(r.refusals)) throw new Error('runReconcileFixDispatch returned an unexpected shape');",
  "});",
  "",
  "await recordAsync('reconcile-ci-heal-pass', null, async () => {",
  "  const stubDispatch = async (planned) => ({ agentId: null, sessionSlug: 'stub-ci-heal', pr: planned.pr, itemNum: planned.itemNum, lane: planned.lane, unknownTokens: [] });",
  "  const r = await runReconcileCiHealDispatch({",
  "    repo: WE_SLUG, dispatch: stubDispatch, pickFreeLanes: () => [90301, 90302, 90303, 90304, 90305], checkStaleness: skipStaleness,",
  "    // #4352 — the owed-write flush POSTS PR comments; a smoke never writes to GitHub, same as its stubbed dispatch.",
  "    flushOwed: () => ({ posted: [], cleared: [], dropped: [], kept: [] }),",
  "  });",
  "  if (!Array.isArray(r.dispatched) || !Array.isArray(r.refusals)) throw new Error('runReconcileCiHealDispatch returned an unexpected shape');",
  "});",
  "",
  "record('reconcile-review-pass', null, () => {",
  "  const stubDispatch = () => ({ agentId: null });",
  "  const r = runReviewTick({",
  "    repo: WE_SLUG, dispatch: stubDispatch,",
  "    tagRound: () => {}, tagStatus: () => {}, holdReconcile: () => [], statusCandidates: () => [],",
  "  });",
  "  if (r.reconcileError) throw new Error('reconcile failed: ' + r.reconcileError);",
  "  if (!Array.isArray(r.dispatched) || !Array.isArray(r.failed)) throw new Error('runReviewTick returned an unexpected shape');",
  "});",
  "}",
  "",
  "process.stdout.write(JSON.stringify(results));",
];
export const DISPATCH_DRY_RUN_SCRIPT = DISPATCH_DRY_RUN_LINES.join('\n');

/** The dispatch modules {@link DISPATCH_DRY_RUN_SCRIPT} runs — {@link checkCodeUnchanged}'s `codeEntries` for
 *  `dispatch-dry-run`, so skip-unchanged skips it when none of their import closure (which transitively pulls
 *  in `dispatch-lane.mjs`/`dispatch-lane-io.mjs`/`repo-profile.mjs`/`reconcile-pass.mjs`/`pr-work-unit.mjs`/
 *  `review-daemon.mjs`'s own dependencies) has changed since the last live-verified build. */
export const DISPATCH_DRY_RUN_CODE_ENTRIES = Object.freeze([
  'scripts/operations/review-dispatch.mjs',
  'scripts/conveyor/reconcile-fix-dispatch.mjs',
  'scripts/operations/ci-heal-pr-dispatch.mjs',
  'skills-src/conveyor/review-daemon.mjs',
]);

async function checkDispatchDryRun({ root, budgets, runChild, env }) {
  let out;
  // The stubbed dispatchers still reach the real fix-loop ledger append; an isolated ledger keeps the smoke's
  // stub sessions from counting as real repair attempts on live PRs (#4194: 3 stub rows => fix-loop-hold).
  const ledgerDir = mkdtempSync(join(tmpdir(), 'smoke-fix-loop-'));
  try {
    out = await runChild('node', ['--input-type=module', '-e', DISPATCH_DRY_RUN_SCRIPT], {
      cwd: root, timeoutMs: budgets.dispatchDryRunMs, env: { ...env, WE_FIX_LOOP_LEDGER: join(ledgerDir, 'ledger.jsonl') },
    });
  } catch (e) {
    return { ok: false, detail: `dispatch dry-run child failed: ${failureLine(e)}` };
  } finally {
    try { rmSync(ledgerDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    return { ok: false, detail: `dispatch dry-run produced unparsable output: ${firstLine(e)}` };
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    return { ok: false, detail: 'dispatch dry-run reported no rows — refusing to treat "nothing ran" as a pass' };
  }
  const failures = parsed.filter((r) => !r.ok);
  if (failures.length) {
    const detail = failures.map((f) => `${f.kind}${f.pr != null ? ` PR #${f.pr}` : ''}: ${f.error}`).join('; ');
    return { ok: false, detail: `dispatch dry-run failed (${failures.length}/${parsed.length}): ${detail}` };
  }
  return { ok: true, detail: `dispatch dry-run ok — ${parsed.map((r) => r.kind).join(', ')}` };
}

/**
 * xp4lw2v — LAST in {@link SMOKE_CHECKS}, and NEVER skipped (no `codeEntries`, so {@link checkCodeUnchanged}
 * always returns `false` for it): `git status --porcelain` in `root` must be empty after every other check has
 * run — they are the "one real tick of reads" (a reconcile-pass dry-run per repo, the dispatch dry-run pass)
 * this smoke's own `#4044` skip-unchanged logic still lets through even on an otherwise-unchanged move. A check
 * that leaves ANY dirt fails, with the dirty paths in `detail` — this is what would have caught a state writer
 * dirtying the candidate tree (live 2026-09-25: `.conveyor/unsupported-repo.json`,
 * `scripts/conveyor/run-scorecards.json`).
 *
 * Records the porcelain BEFORE the checks ran too ({@link runLiveSmoke}'s `beforePorcelain`, best-effort) and
 * reports pre-existing dirt DISTINCTLY from dirt newly introduced by this smoke's own checks — still fails on
 * either (a dirty tree is a real problem to the caller regardless of which ran first), but names which is
 * which so a human/daemon reading `detail` is not left guessing whether this smoke run itself is the cause.
 *
 * xa4qo7n (live 2026-09-26, `wev-review-daemon`): when `root` is a `daemon-rebuild.mjs#materializeCandidate`
 * worktree, a "pre-existing" dirty path here most often means the candidate's own setup (its `node_modules`
 * symlink) — never trust a repo's `.gitignore` to cover a symlink the same way it covers the real directory
 * (a trailing-slash pattern like `node_modules/` matches ONLY directories, confirmed empirically it does NOT
 * match a symlink of the same name). The fix belongs in candidate setup (a `node_modules`-shaped `info/exclude`
 * entry — see that function's own docblock), never in weakening this check to ignore "pre-existing" dirt: a
 * candidate that is dirty the INSTANT it is checked out is still exactly the anomaly this check exists to catch.
 */
async function checkTreeStaysClean({ root, budgets, runChild, env, beforePorcelain }) {
  let out;
  try {
    out = await runChild('git', ['status', '--porcelain'], { cwd: root, timeoutMs: budgets.treeStaysCleanMs, env });
  } catch (e) {
    return { ok: false, detail: `git status --porcelain failed: ${firstLine(e)}` };
  }
  const after = String(out || '').trim();
  if (!after) return { ok: true, detail: 'git status --porcelain empty — tree stayed clean' };
  const afterLines = after.split('\n').map((l) => l.trim()).filter(Boolean);
  const beforeLines = new Set(String(beforePorcelain || '').split('\n').map((l) => l.trim()).filter(Boolean));
  const newDirt = afterLines.filter((l) => !beforeLines.has(l));
  const preExisting = afterLines.filter((l) => beforeLines.has(l));
  const parts = [];
  if (newDirt.length) parts.push(`${newDirt.length} path(s) newly dirtied by this smoke's own checks: ${newDirt.join(' | ')}`);
  if (preExisting.length) parts.push(`${preExisting.length} pre-existing dirty path(s) (present before this smoke ran): ${preExisting.join(' | ')}`);
  return { ok: false, detail: `tree is dirty after the smoke's checks ran — ${parts.join('; ')}` };
}

/** THE ONE LIST — every live check the gate runs, in order. Each `run(ctx)` gets `{ root, budgets, repos,
 *  sessionSlug, ghChildEnv, runChild }` and must never throw (a throw is still caught by {@link runLiveSmoke},
 *  but a check should report `{ ok:false, detail }` itself so the detail is specific). */
// `mayBeTransient:false` — a failure of this check is ALWAYS `'code'` ({@link classifySmokeFailure}), whatever its
// text says. THE RULE: any check that runs code FROM THE TREE UNDER TEST (`cwd: root` — `reconcile-pass.mjs`,
// `lane-pool.mjs`) is `mayBeTransient:false`. Anything that code prints flows into `detail`; if its text could buy
// a `'transient'` verdict, a broken (or hostile) overlay could print one of {@link TRANSIENT_FAILURE_PATTERNS}
// ("no free lane", "ETIMEDOUT") and dodge the reject record every tick, re-smoking forever every tick
// (PR #2625 advisory, security/reject-cache-bypass). Only checks that run external tools (`gh`) stay eligible.
// A test in daemon-live-smoke.test.mjs enforces the rule by running every row and watching its `cwd`.
// Cost, accepted: a genuinely exhausted pool (after `--wait-ms` gave it 180s to free up) or a gh/network blip
// inside the reconcile dry-run records a rejection, as every failure did before Module D; it clears as soon as
// main or the overlay inputs move.
//
// `codeEntries` (#4044): the tree scripts a check RUNS. Live 2026-09-25 a full smoke took 209s under the clone's
// WRITE lock — lane-acquire-release 172s (waiting on a busy pool), lane-pool-list 30s — so on a main that moves
// every few minutes the clone was locked most of the time and every daemon on it skipped its ticks ("read lock
// refused (writer-active)", 13:20Z-13:33Z; #2657 never got its advisory). When the rebuild knows the files that
// changed since the LAST LIVE-VERIFIED build (`changedFiles`), a tree-code check whose script's import closure
// none of them touch ran this exact code live already and passed — it is reported `skipped` (ok), not re-run.
// Unknown diff, an incomplete closure, or any touched file ⇒ the check runs, exactly as before. The gh checks
// (external, ~1s) always run.
//
// xa4qo7n (epic #4075/#3383) follow-up: skip-unchanged above only shortens a smoke that STILL runs; it does not
// stop main moving on every drain PR from touching these checks' own import closure most of the time (both
// `reconcile-dry-run` and `dispatch-dry-run` pull in the dispatch/reconcile machinery, which changes often), so
// the 44s+17s live 2026-09-26 09:32 ET (`reconcile-dry-run`+`dispatch-dry-run`) kept dominating the smoke anyway.
// `daemon-rebuild.mjs` fixes the OTHER half of the 2026-09-25 209s incident this section describes: `runLiveSmoke`
// now always runs against a DISPOSABLE candidate worktree (`root` here is never the daemon's real clone), and
// `rebuildClone` never holds the clone's write lock for any part of it — see that file's own header. A slow
// smoke here no longer means a single daemon tick gets skipped, whatever its duration.
export const SMOKE_CHECKS = Object.freeze([
  { name: 'lane-pool-list', run: checkLanePoolList, mayBeTransient: false, codeEntries: ['scripts/lane-pool.mjs'] },
  { name: 'lane-acquire-release', run: checkLaneAcquireRelease, mayBeTransient: false, codeEntries: ['scripts/lane-pool.mjs'] },
  { name: 'gh-api-repo', run: checkGhApiRepo, mayBeTransient: true },
  { name: 'gh-pr-list', run: checkGhPrList, mayBeTransient: true },
  { name: 'reconcile-dry-run', run: checkReconcileDryRun, mayBeTransient: false, codeEntries: ['scripts/conveyor/reconcile-pass.mjs'] },
  // xp4lw2v (epic #4075/#3383) — see the two functions' own docblocks just above for what each covers.
  { name: 'dispatch-dry-run', run: checkDispatchDryRun, mayBeTransient: false, codeEntries: DISPATCH_DRY_RUN_CODE_ENTRIES },
  // #4468 — actually BOOTS (imports) every standalone daemon entry module on the candidate tree; see
  // `daemon-boot-smoke.mjs`'s own header for the live incident this closes (#2921: a smoke-passing candidate
  // that then crash-looped every daemon at startup, because nothing before this row ever imported an entry file).
  // The row itself is `DAEMON_BOOT_SMOKE_CHECK` — imported whole, never re-declared here, so `mayBeTransient`/
  // `codeEntries` have exactly one definition (a #4468 review finding: a hand-copied literal here previously
  // drifted from the exported object the tests actually assert on).
  DAEMON_BOOT_SMOKE_CHECK,
  // ALWAYS LAST, NEVER SKIPPED: no `codeEntries`, so `checkCodeUnchanged` never short-circuits it.
  { name: 'tree-stays-clean', run: checkTreeStaysClean, mayBeTransient: false },
]);

/**
 * PURE (given `closureOf`): may `check` be skipped because none of `changedFiles` touches the code it runs?
 * @param {{check:{codeEntries?:string[]}, changedFiles:string[]|null|undefined, root:string, closureOf?:Function}} o
 * @returns {boolean}
 */
export function checkCodeUnchanged({ check, changedFiles, root, closureOf = collectImportClosure }) {
  if (!Array.isArray(changedFiles) || !check.codeEntries || !check.codeEntries.length) return false;
  let closure;
  try { closure = closureOf({ root, entries: check.codeEntries }); } catch { return false; }
  const hits = closureHits({ closure, changedFiles });
  return Array.isArray(hits) && hits.length === 0;
}

/** PURE: does a completed set of check results pass the gate? Every single check must have passed. */
export function decideSmokeVerdict(results) {
  return results.length > 0 && results.every((r) => r.ok);
}

/**
 * Run every {@link SMOKE_CHECKS} row against `root` (the clone that just merged new code) and report a verdict.
 * Never throws — a check that throws is caught and recorded as a failure, exactly like an explicit `{ok:false}`.
 * @param {{root:string, env?:NodeJS.ProcessEnv, repos?:string[], runChild?:typeof runBounded, now?:number}} o
 * @returns {Promise<{pass:boolean, disabled:boolean, results:Array<object>, sessionSlug:string}>}
 */
export async function runLiveSmoke({
  root, env = process.env, repos = Object.values(CONSTELLATION_REPOS).map((r) => r.slug),
  runChild = runBounded, now = Date.now(), changedFiles = null, closureOf = collectImportClosure,
  clock = Date.now, hostBusy = undefined,
} = {}) {
  if (isSmokeGateDisabled(env)) return { pass: true, disabled: true, results: [], sessionSlug: null };
  const budgets = resolveSmokeBudgets(env);
  const sessionSlug = `smoke-${now}-${randomUUID().slice(0, 8)}`;
  const ghChildEnv = ghDispatchedSessionEnv(env);
  // xp4lw2v — the porcelain snapshot BEFORE any check below runs, best-effort (never throws, never blocks the
  // rest of the smoke on a failed read): {@link checkTreeStaysClean} uses it to report pre-existing dirt
  // distinctly from dirt its own checks introduced. `null` on any failure — the check then treats every dirty
  // path found afterward as unclassified rather than guessing.
  let beforePorcelain = null;
  try {
    beforePorcelain = await runChild('git', ['status', '--porcelain'], { cwd: root, timeoutMs: budgets.treeStaysCleanMs, env });
  } catch { /* best-effort — see comment above */ }
  // #4139 — `env` (the caller's OWN, possibly-isolated env) rides alongside `ghChildEnv` (the derived,
  // sanitized-for-gh one) so the lane-pool checks can use the former while the gh checks keep using the
  // latter; see {@link checkLanePoolList}'s comment for why dropping this here silently escaped isolation.
  const ctx = { root, budgets, repos, sessionSlug, env, ghChildEnv, runChild, beforePorcelain, clock, hostBusy };
  const results = [];
  for (const check of SMOKE_CHECKS) {
    const startedAt = clock();
    let result;
    if (checkCodeUnchanged({ check, changedFiles, root, closureOf })) {
      results.push({
        name: check.name, ms: 0, ok: true, skipped: true, mayBeTransient: check.mayBeTransient !== false,
        detail: 'code unchanged since the last live-verified build — not re-run (#4044)',
      });
      continue;
    }
    try {
      result = await check.run(ctx);
    } catch (e) {
      result = { ok: false, detail: `threw: ${firstLine(e)}` };
    }
    results.push({ name: check.name, ms: clock() - startedAt, ...result, mayBeTransient: check.mayBeTransient !== false });
  }
  return { pass: decideSmokeVerdict(results), disabled: false, results, sessionSlug };
}

// ── Transient vs. code classification (Module D) — see the file header for the full rationale. ──

/** Env/infra fault signatures a failed check's `detail` is matched against — see {@link classifySmokeFailure}.
 *  Frozen and exported so a caller/test can see exactly what counts as "environment noise, not code" without
 *  re-deriving it. Kept as one pattern per alternative (rather than one combined regex) so a single culprit
 *  substring is easy to spot/extend without fighting regex precedence. */
export const TRANSIENT_FAILURE_PATTERNS = Object.freeze([
  /\b401\b/i,
  /Bad credentials/i,
  /HTTP 5\d\d/i,
  /rate limit/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  // `bounded-child.mjs#runBounded`'s OWN hard-timeout rejection: the WHOLE detail must be `<check prefix> failed:
  // timed out after Nms (process group killed)`, anchored at both ends (no check prefix contains a `:`).
  // NOT a bare /timeout|timed out/: those match ordinary code-failure text ("timed out waiting for #submit",
  // an assertion naming a `timeout` option) and would launder a real regression through the retry path. A child
  // that merely PRINTS this text reaches `detail` as `<prefix> failed: exited N: …`, so it cannot match.
  /^[^:]+ failed: timed out after \d+ms \(process group killed\)$/,
  /no free lane/i, // lane-pool.mjs#cmdAcquire's exhausted-pool message, e.g. `no free lane in pool "we" (12 all held/dirty) — release one or \`provision\` more`
  /all lanes (are )?busy/i,
  /pool (is )?(full|exhausted)/i,
  /could not resolve host/i,
  // `gh` is a Go binary: its network failures read like Go's net/http errors, never Node's `E*` codes above
  // (live 2026-09-25 08:14 ET: both gh checks failed together and were rejected as `code`, freezing the clone).
  /error connecting to api\.github\.com/i,
  /i\/o timeout/i,
  /connection reset by peer/i,
  /broken pipe/i,
  /TLS handshake timeout/i,
  /no such host/i,
  /connection refused/i,
  /dial tcp/i,
  /HTTP 429/i,
  /HTTP 403: .*rate limit/i,
]);

function isTransientDetail(detail) {
  const s = String(detail ?? '');
  return TRANSIENT_FAILURE_PATTERNS.some((re) => re.test(s));
}

/**
 * PURE: classify a completed {@link runLiveSmoke} `results` array as one of:
 *  - `'pass'` — every check ok.
 *  - `'transient'` — at least one check failed, and EVERY failure's `detail` matches
 *    {@link TRANSIENT_FAILURE_PATTERNS} (an auth/network/pool-capacity fault the old code would hit identically)
 *    AND came from a check that may be transient (a row with `mayBeTransient:false` — see {@link SMOKE_CHECKS} —
 *    always counts as code; a row without the field is eligible).
 *  - `'code'` — at least one failure does NOT match (a genuinely code-shaped failure), OR no checks ran at all
 *    (an empty result set is never "just env noise" — same fail-closed posture as {@link decideSmokeVerdict}).
 * A single non-transient failure pulls the WHOLE verdict to `'code'`: a mix of one real bug and one flaky 401
 * is still a real bug, and must never be laundered through the transient/retry path.
 * @param {Array<{ok:boolean, detail?:string}>} results
 * @returns {'pass'|'transient'|'code'}
 */
export function classifySmokeFailure(results) {
  if (!Array.isArray(results) || results.length === 0) return 'code';
  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) return 'pass';
  return failures.every((r) => r.mayBeTransient !== false && isTransientDetail(r.detail)) ? 'transient' : 'code';
}

/** Default retry cap for {@link runLiveSmokeWithRetry} — the number of EXTRA attempts after the first, once a
 *  run classifies as `'transient'`. Overridable via `WE_DAEMON_SMOKE_TRANSIENT_RETRIES` (`0` is a valid,
 *  meaningful override: "never retry, one shot"). */
export const SMOKE_TRANSIENT_RETRIES_ENV = 'WE_DAEMON_SMOKE_TRANSIENT_RETRIES';
/** Default sleep between retries — env `WE_DAEMON_SMOKE_RETRY_BACKOFF_MS`. Most env noise (a rate limit, a
 *  momentarily-full lane pool) clears within seconds; 15s gives it real room without dragging a rebuild out. */
export const SMOKE_RETRY_BACKOFF_MS_ENV = 'WE_DAEMON_SMOKE_RETRY_BACKOFF_MS';

// Deliberately NOT `.unref()`'d: the backoff IS the work in flight. With nothing else ref'd (the write-lock
// heartbeat is unref'd, the failed attempt's child calls are done), an unref'd timer lets Node exit before it
// fires — the retry never happens and the resident daemon dies with exit 0 (the #3870 death that
// pass-daemon.mjs#realSleep documents).
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run {@link runLiveSmoke} and, on a `'transient'` verdict ONLY (see {@link classifySmokeFailure}), retry the
 * WHOLE smoke (never just the failed check — the checks share live state like a lane lease) up to `retries`
 * more times, sleeping `backoffMs` between attempts. A `'code'` verdict never retries — it is a real finding,
 * not noise. The kill switch is checked up front and short-circuits identically to {@link runLiveSmoke}'s own
 * kill-switch path, without spending an attempt.
 *
 * GITHUB AUTH (see {@link refreshSmokeGithubEnv} / {@link probeGithubAuth}): every attempt first gets a FRESH
 * App token in its env. When a failed row mentions a 401, an external `gh` probe with that same env decides
 * whose fault it is: probe OK → the tree's own failure, classified as usual; probe 401 → the environment's —
 * force a re-mint and retry once (no sleep); still 401 → verdict `'auth-broken'` (never `'code'`), which the
 * rebuild raises as a `github-auth-broken` alert and holds on, without a reject record.
 * @param {{root:string, env?:NodeJS.ProcessEnv, runChild?:typeof runBounded, sleep?:(ms:number)=>Promise<void>,
 *   retries?:number, backoffMs?:number, refreshAuth?:typeof refreshSmokeGithubEnv}} o
 *
 * ENVIRONMENT TIMEOUT (see {@link isEnvTimeoutFailureSet}): a `'code'` verdict whose failures are all "ran out of
 * time" (measured by the gate's own `clock`) is retried ONCE with every budget widened
 * ({@link widenSmokeBudgetsEnv}); still timing out → `'env-timeout'` with `envTimeout` (rows, load average).
 * @returns {Promise<{verdict:'pass'|'transient'|'code'|'auth-broken'|'env-timeout', attempts?:number, smoke?:object,
 *   disabled?:boolean, auth?:{probe:string, refresh:string|null, retried:boolean}}>}
 */
export async function runLiveSmokeWithRetry({
  root, env = process.env, runChild = runBounded, sleep = defaultSleep,
  retries = envNonNegInt(env, SMOKE_TRANSIENT_RETRIES_ENV, 2),
  backoffMs = envMs(env, SMOKE_RETRY_BACKOFF_MS_ENV, 15_000),
  changedFiles = null,
  refreshAuth = refreshSmokeGithubEnv,
  clock = Date.now,
  loadAvg = () => loadavg(),
} = {}) {
  if (isSmokeGateDisabled(env)) return { verdict: 'pass', disabled: true };
  let smoke;
  let verdict;
  let attempts = 0;
  let forceRefresh = false;
  let authRetried = false;
  let auth = null;
  let attemptEnv = env; // widened once, for the env-timeout retry below
  let envTimeout = null;
  const minElapsedMs = envMs(env, SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV, DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS);
  for (;;) {
    attempts += 1;
    // Fresh token for EVERY attempt, the same way the daemon's own tick gets one (see refreshSmokeGithubEnv).
    const { env: runEnv, refresh } = await refreshAuth({ env: attemptEnv, force: forceRefresh });
    forceRefresh = false;
    smoke = await runLiveSmoke({ root, env: runEnv, runChild, changedFiles, clock });
    verdict = classifySmokeFailure(smoke.results);
    // ENVIRONMENT TIMEOUT (live 2026-09-26 22:37Z) — see {@link isEnvTimeoutFailureSet}. Retry ONCE with every
    // budget widened; still timing out → `'env-timeout'` (held, never a reject record, never an overlay suspect).
    if (verdict === 'code' && isEnvTimeoutFailureSet(smoke.results, { minElapsedMs })) {
      const rows = smoke.results.filter((r) => !r.ok).map((r) => ({ name: r.name, ms: r.ms, detail: r.detail }));
      if (!envTimeout) {
        const factor = envMs(env, SMOKE_ENV_TIMEOUT_BUDGET_FACTOR_ENV, DEFAULT_ENV_TIMEOUT_BUDGET_FACTOR);
        envTimeout = { first: rows, budgetFactor: factor, loadAvg: safeLoadAvg(loadAvg) };
        attemptEnv = widenSmokeBudgetsEnv(env, factor);
        continue;
      }
      envTimeout.retry = rows;
      envTimeout.loadAvgAfter = safeLoadAvg(loadAvg);
      verdict = 'env-timeout';
      break;
    }
    if (verdict !== 'pass' && hasGithubAuthSignature(smoke.results)) {
      const probe = await probeGithubAuth({ env: runEnv, runChild, budgets: resolveSmokeBudgets(env) });
      auth = { probe: probe.detail, refresh: refresh?.reason ?? null, retried: authRetried };
      if (probe.authFailed) {
        // The environment's own credential is rejected by GitHub, independent of the tree's code.
        if (!authRetried) {
          authRetried = true;
          forceRefresh = true; // re-mint, never trust the cache that just handed out a rejected token
          continue;
        }
        verdict = 'auth-broken';
        break;
      }
      // The probe authenticated fine with the same env — the tree's own 401 is its own; classify as usual.
    }
    if (verdict !== 'transient' || attempts > retries + (authRetried ? 1 : 0) + (envTimeout ? 1 : 0)) break;
    await sleep(backoffMs);
  }
  return { verdict, attempts, smoke, ...(auth ? { auth } : {}), ...(envTimeout ? { envTimeout } : {}) };
}

// ── Timed out under load is ENVIRONMENT, never code (live 2026-09-26 22:36-22:37Z, `wev-review-daemon`) ─────
// Host load ~25, 133 pool entries: `lane-pool-list` spent 120905ms and failed with lane-pool's own "scan exceeded
// its 120000ms budget at lane-47 … refusing to return a partial/unsound answer". The row is `mayBeTransient:false`
// (tree code), so it read as `'code'`: a rejection was recorded, the non-pinned overlay (#2773) was named a
// suspect and DROPPED, and the clone stayed on its old build — for a fault plain main hits identically. A check
// that ran out of TIME is evidence about the host, not the tree.
//
// NO LAUNDERING (PR #2625's rule): a timeout signature counts only when the gate's OWN clock shows the row really
// spent at least `WE_SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS` (default 30s) — a tree that merely PRINTS "exceeded its
// budget" fails fast and stays `'code'`. And `'env-timeout'` never ADOPTS anything: it holds on last-good, so a
// genuine performance regression is still kept off the daemon (it is just not blamed on an overlay).

/** Signatures of "ran out of time". The first is `runBounded`'s own kill (external); the rest are lane-pool's
 *  bounded-scan give-ups (tree text — hence the elapsed-time floor in {@link isEnvTimeoutRow}). */
export const ENV_TIMEOUT_PATTERNS = Object.freeze([
  /^[^:]+ failed: timed out after \d+ms \(process group killed\)$/,
  /scan exceeded its \d+ms budget/,
  /gave up waiting for the shared acquirability-scan lock/,
]);
export const SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV = 'WE_SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS';
export const DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS = 30_000;
/** The smallest runBounded cap {@link isEnvTimeoutRow} treats as a real budget when judging a kill against its own cap. */
export const MIN_OWN_CAP_MS = 1_000;
/** How much wider every budget is on the one env-timeout retry. */
export const SMOKE_ENV_TIMEOUT_BUDGET_FACTOR_ENV = 'WE_SMOKE_ENV_TIMEOUT_BUDGET_FACTOR';
export const DEFAULT_ENV_TIMEOUT_BUDGET_FACTOR = 2.5;
const LANE_POOL_SCAN_TIMEOUT_ENV = 'LANE_POOL_LIST_SCAN_TIMEOUT_MS';
const LANE_POOL_DEFAULT_SCAN_TIMEOUT_MS = 120_000;

/** PURE: did this failed row run out of time (signature AND the gate's own measured elapsed time)? */
export function isEnvTimeoutRow(row, { minElapsedMs = DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS } = {}) {
  if (!row || row.ok) return false;
  const detail = String(row.detail ?? '');
  if (!ENV_TIMEOUT_PATTERNS.some((re) => re.test(detail))) return false;
  // `runBounded`'s OWN kill ("timed out after Nms (process group killed)") is the gate's clock, not tree text: the
  // row really spent its whole cap N. A cheap probe has a cap far under the 30s floor (live 2026-10-03 22:01 ET,
  // load 31 on 12 cores: `tree-stays-clean`'s `git status` hit its 10s cap), and the floor then read that
  // load-induced kill as a code failure and rejected a good build. Judge such a kill against its own cap — but only
  // a cap that is a real budget: one under {@link MIN_OWN_CAP_MS} is a starved harness (the soak break
  // `broken-smoke-harness-holds-last-good` sets 1ms), which load cannot explain, so it keeps the 30s floor.
  const killed = /timed out after (\d+)ms \(process group killed\)$/.exec(detail);
  if (killed && Number(killed[1]) >= MIN_OWN_CAP_MS) return Number(row.ms) >= Math.min(minElapsedMs, Number(killed[1]) * 0.9);
  return Number(row.ms) >= minElapsedMs;
}

/** PURE: is this a failure set the environment explains — at least one {@link isEnvTimeoutRow}, and every other
 *  failure is ordinary transient noise from a check allowed to be transient? One code-shaped row ⇒ false. */
export function isEnvTimeoutFailureSet(results, opts = {}) {
  const failures = (Array.isArray(results) ? results : []).filter((r) => !r.ok);
  if (!failures.some((r) => isEnvTimeoutRow(r, opts))) return false;
  return failures.every((r) => isEnvTimeoutRow(r, opts) || (r.mayBeTransient !== false && isTransientDetail(r.detail)));
}

/** A COPY of `env` with every smoke budget, and lane-pool's own scan budget, multiplied by `factor`. The
 *  lane-pool-list child budget always leaves 30s over the scan budget, so the scan's own give-up is what fires. */
export function widenSmokeBudgetsEnv(env = process.env, factor = DEFAULT_ENV_TIMEOUT_BUDGET_FACTOR) {
  const out = { ...env };
  const budgets = resolveSmokeBudgets(env);
  for (const [key, name] of Object.entries(SMOKE_BUDGET_ENV)) out[name] = String(Math.round(budgets[key] * factor));
  const scan = Math.round(envMs(env, LANE_POOL_SCAN_TIMEOUT_ENV, LANE_POOL_DEFAULT_SCAN_TIMEOUT_MS) * factor);
  out[LANE_POOL_SCAN_TIMEOUT_ENV] = String(scan);
  out[SMOKE_BUDGET_ENV.lanePoolListMs] = String(Math.max(Number(out[SMOKE_BUDGET_ENV.lanePoolListMs]), scan + 30_000));
  return out;
}

function safeLoadAvg(fn) {
  try { return fn().map((x) => Math.round(x * 100) / 100); } catch { return null; }
}

// ── GitHub auth is ENVIRONMENT, never code (live 2026-09-26 21:22Z, `wev-review-daemon`) ─────────────────────
// `rebuildClone` runs inside `withSelfSync`, which wraps `withGithubAppAuth` — so the rebuild (and this smoke)
// runs BEFORE the tick's own token refresh, on whatever `GH_TOKEN` the previous refresh left in `process.env`.
// A long tick, or a run of skipped ticks (read lock refused), leaves that token past its 1h expiry: every
// tree-code check that reads GitHub through the RAW env (`reconcile-dry-run`, `dispatch-dry-run`) got
// `HTTP 401: Bad credentials`, while `gh-api-repo`/`gh-pr-list` (sanitized env + shim, which reads the cache
// fresh) passed. Since those two rows are `mayBeTransient:false`, the 401 read as a code regression; it failed
// plain main and last-good the same way, so the clone was held as `smoke-harness-broken` and no fix was adopted.

/** `gh`'s own auth-rejection text. Used only to decide whether to PROBE, never as a verdict by itself. */
export const GITHUB_AUTH_FAILURE_RE = /HTTP 401|Bad credentials/i;

/** PURE: does any failed row mention a GitHub auth rejection? */
export function hasGithubAuthSignature(results) {
  return Array.isArray(results) && results.some((r) => !r.ok && GITHUB_AUTH_FAILURE_RE.test(String(r.detail ?? '')));
}

/**
 * Return a COPY of `env` whose `GH_TOKEN` is the fleet's current App installation token — the exact refresh a
 * daemon's own tick runs first (`github-app-auth-env.mjs#ensureFreshGithubAppEnv`), written into the copy,
 * never into `process.env`. `force` skips the cache and mints (used once, after GitHub rejected the token).
 * App auth not configured, or a failed mint, leaves `env` as it was. Never throws.
 * @param {{env?:NodeJS.ProcessEnv, force?:boolean, ensureFresh?:typeof ensureFreshGithubAppEnv, log?:Console}} [o]
 * @returns {Promise<{env:NodeJS.ProcessEnv, refresh:{applied:boolean, reason:string}|null}>}
 */
export async function refreshSmokeGithubEnv({
  env = process.env, force = false, ensureFresh = ensureFreshGithubAppEnv, log = console,
} = {}) {
  const out = { ...env };
  let refresh = null;
  try {
    refresh = await ensureFresh({
      env: out,
      setEnv: (token) => { out.GH_TOKEN = token; },
      ...(force ? { readCache: () => null } : {}),
      log,
    });
  } catch (e) {
    refresh = { applied: false, reason: `refresh-threw: ${firstLine(e)}` };
  }
  return { env: out, refresh };
}

/**
 * External probe, run with the SAME env the tree checks got: `gh api --method GET repos/<we>`. Only a 401 HERE
 * (an external tool, no tree code involved) makes a smoke's 401 an environment fault — so a tree that merely
 * PRINTS "HTTP 401" can never launder a real failure through the auth path (PR #2625's reject-cache rule).
 * @returns {Promise<{authFailed:boolean, detail:string}>}
 */
export async function probeGithubAuth({ env, runChild = runBounded, budgets = resolveSmokeBudgets(env) }) {
  const slug = CONSTELLATION_REPOS.we.slug;
  try {
    await runChild('gh', ['api', '--method', 'GET', `repos/${slug}`], { env, timeoutMs: budgets.ghApiMs });
    return { authFailed: false, detail: `gh api --method GET repos/${slug} ok with the smoke env` };
  } catch (e) {
    const text = `${String((e && e.message) || e)}\n${String(e?.stderr ?? '')}`;
    return { authFailed: GITHUB_AUTH_FAILURE_RE.test(text), detail: `gh api --method GET repos/${slug} failed with the smoke env:${failureLine(e)}` };
  }
}

// ── Reject-cache: remember the last merged sha the gate rejected, so a daemon never re-runs the (real,
// live-touching) smoke against the SAME known-bad `origin/main` every single tick until it actually moves. ──

/** Where the per-clone reject-cache lives — deliberately OUTSIDE any git checkout: a file inside `root` would
 *  show up in `git status --porcelain` and read as permanently dirty, which would make
 *  `we:scripts/lib/daemon-self-sync.mjs#decideSelfSync` fail closed (`dirty`) forever, blocking every FUTURE
 *  self-sync too. Keyed by a short hash of the checkout's own absolute path so multiple clones never collide;
 *  overridable via env for tests / a non-default machine layout. */
export const SMOKE_STATE_DIR_ENV = 'WE_DAEMON_SMOKE_STATE_DIR';

export function smokeStateDir(env = process.env) {
  return env?.[SMOKE_STATE_DIR_ENV] || join(homedir(), '.claude', 'daemon-self-sync-state');
}

export function smokeStatePath(root, env = process.env) {
  const key = createHash('sha256').update(String(root)).digest('hex').slice(0, 16);
  return join(smokeStateDir(env), `${key}.json`);
}

/** The sha the gate last rejected for this clone, or `null` (none on record, or the cache is unreadable —
 *  fails to "no cached rejection", i.e. the gate re-tests, never to a false short-circuit). */
export function readRejectedSha(root, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(smokeStatePath(root, env), 'utf8'));
    return typeof parsed?.rejectedSha === 'string' && parsed.rejectedSha ? parsed.rejectedSha : null;
  } catch {
    return null;
  }
}

/** Best-effort write; a failure to record never blocks the caller (worst case: the next tick re-tests the same
 *  sha instead of short-circuiting — extra live-touch, never a correctness problem). */
export function recordRejectedSha(root, sha, { env = process.env, reason = '', at = new Date().toISOString() } = {}) {
  try {
    mkdirSync(smokeStateDir(env), { recursive: true });
    writeFileSync(smokeStatePath(root, env), JSON.stringify({ rejectedSha: sha, reason, at }, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function clearRejectedSha(root, env = process.env) {
  try {
    mkdirSync(smokeStateDir(env), { recursive: true });
    writeFileSync(smokeStatePath(root, env), JSON.stringify({ rejectedSha: null }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Roll a clone back to `sha` — ALLOWED ONLY because the tree is verified clean first (a `git status --porcelain`
 * that fails, times out, or reports dirt fails CLOSED: never reset a tree we could not confirm was safe to
 * discard). Mirrors `daemon-self-sync.mjs#decideSelfSync`'s own fail-closed posture on an unreadable tree state.
 * @param {{root:string, sha:string|null, run?:typeof gitRun}} o
 * @returns {{ok:boolean, reason?:string}}
 */
export function rollbackToSha({ root, sha, run = gitRun }) {
  if (!sha) return { ok: false, reason: 'no-sha' };
  const status = run(['status', '--porcelain'], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL' });
  const dirty = status.status === 0 ? !!String(status.stdout ?? '').trim() : null;
  if (dirty !== false) return { ok: false, reason: dirty === null ? 'status-failed' : 'dirty' };
  const reset = run(['reset', '--hard', sha], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL' });
  if (reset.status !== 0) return { ok: false, reason: 'reset-failed' };
  return { ok: true };
}

/**
 * THE ONE GATE both `daemon-self-sync.mjs#withSelfSync` and `daemon-load-overlay.mjs` call, right after a merge
 * has already landed on disk. Decides adopt vs. roll back, and does whichever effect that implies.
 *
 * Kept for back-compat (the module-level rebuild flow — Module C — calls {@link runLiveSmokeWithRetry}
 * directly instead) but upgraded to use it internally: a `'transient'` verdict (see {@link
 * classifySmokeFailure}) rolls back WITHOUT writing a reject record and returns `reason:'smoke-transient'`,
 * distinct from `reason:'smoke-fail'` (a genuine `'code'` verdict, which DOES record the rejection). Either
 * way, a rollback that itself fails sets `quarantine:true` on the result (the clone is left on unknown code and
 * needs a hand `git reset --hard`) in addition to `rollback:{ok:false, reason}`.
 * @param {{root:string, preMergeSha:string|null, mergedIdentitySha?:string|null, env?:NodeJS.ProcessEnv,
 *   runChild?:typeof runBounded, run?:typeof gitRun, log?:Console}} o
 * @returns {Promise<{adopt:boolean, reason:'kill-switch-disabled'|'still-rejected'|'smoke-pass'|
 *   'smoke-transient'|'github-auth-broken'|'smoke-env-timeout'|'smoke-fail', smoke?:object, rollback?:object, quarantine?:true}>}
 */
export async function gateMergedCommit({
  root, preMergeSha, mergedIdentitySha = null, env = process.env, runChild = runBounded, run = gitRun, log = console,
}) {
  if (isSmokeGateDisabled(env)) return { adopt: true, reason: 'kill-switch-disabled' };

  const priorRejected = readRejectedSha(root, env);
  if (mergedIdentitySha && priorRejected && mergedIdentitySha === priorRejected) {
    const rollback = rollbackToSha({ root, sha: preMergeSha, run });
    log.error?.(
      `daemon-live-smoke: origin/main is still the previously-rejected ${mergedIdentitySha} — NOT re-running the live smoke `
      + `(#3383, retried-until-main-moves guard); ${rollback.ok ? 'rolled back' : `ROLLBACK FAILED (${rollback.reason}) — clone may be left on the rejected code, needs a hand \`git reset --hard ${preMergeSha}\``}`,
    );
    return { adopt: false, reason: 'still-rejected', rollback };
  }

  // #3383 Module D — retry-on-transient (classifySmokeFailure) wraps the single runLiveSmoke call below.
  const { verdict, smoke, disabled } = await runLiveSmokeWithRetry({ root, env, runChild });
  if (verdict === 'pass') {
    if (mergedIdentitySha) clearRejectedSha(root, env);
    return { adopt: true, reason: disabled ? 'kill-switch-disabled' : 'smoke-pass', smoke };
  }

  if (verdict === 'transient' || verdict === 'auth-broken' || verdict === 'env-timeout') {
    // 'auth-broken': GitHub rejected the environment's credential even after a forced re-mint — an
    // environment fault, handled exactly like transient noise below (never a reject record).
    // Env/infra noise (a 401, a busy lane pool, a network blip) survived every retry — roll back so the
    // daemon never restarts onto un-vetted code, but NEVER write a reject record: caching a transient fault
    // would permanently block a later, healthy re-check of this SAME sha once the environment recovers (the
    // exact freeze #3383's rationale exists to prevent).
    const rollback = rollbackToSha({ root, sha: preMergeSha, run });
    log.error?.(
      `daemon-live-smoke: TRANSIENT live smoke failure (env/infra noise, not recording a rejection — #3383 Module D) `
      + `after retry; ${rollback.ok ? `rolled back to ${preMergeSha}` : `ROLLBACK FAILED (${rollback.reason}) — clone may be left mid-move, needs a hand \`git reset --hard ${preMergeSha}\``}`,
    );
    const reason = { 'auth-broken': 'github-auth-broken', 'env-timeout': 'smoke-env-timeout' }[verdict] ?? 'smoke-transient';
    const result = { adopt: false, reason, smoke, rollback };
    if (!rollback.ok) result.quarantine = true;
    return result;
  }

  const failedNames = smoke.results.filter((r) => !r.ok).map((r) => r.name);
  const rollback = rollbackToSha({ root, sha: preMergeSha, run });
  if (mergedIdentitySha) recordRejectedSha(root, mergedIdentitySha, { env, reason: failedNames.join(',') });
  log.error?.(
    `daemon-live-smoke: REJECTED merged commit(s) — live smoke failed (${failedNames.join(', ') || 'no checks ran'}); `
    + `${rollback.ok ? `rolled back to ${preMergeSha}` : `ROLLBACK FAILED (${rollback.reason}) — clone may be left on BROKEN code, needs a hand \`git reset --hard ${preMergeSha}\``}`,
  );
  return { adopt: false, reason: 'smoke-fail', smoke, rollback };
}
