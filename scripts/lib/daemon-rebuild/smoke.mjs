/** @file scripts/lib/daemon-rebuild/smoke.mjs — Smoke checks and the smoke-and-adopt ladder.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import {
  SMOKE_ENVIRONMENT_VERDICTS, loadDifferentialEnabled, envLoadRetryDelayMs, isLoadShapedRow, busyPoolSkippedChecks,
  redactDetail,
} from './smoke-classify/index.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import { readRebuildState, writeRebuildState, alertsFilePath, writeReadyCandidate } from './state.mjs';
import { releaseBuildLease } from './lease.mjs';
import { finalizeRebuild, staleAlertDetail, dropSuspectOverlays } from './adopt.mjs';
import { removeOverlay, appendOverlayEvent } from '../daemon-overlays.mjs';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeGit, verifyRev, OVERLAY_EDGE_RESOLVE_ENV } from './shared.mjs';
import { candidateSmokeEnv, materializeCandidate, removeCandidate } from './candidate.mjs';
import { hostname } from 'node:os';
import { pinnedStatus, planRebuild } from './plan.mjs';
import { runBounded } from '../bounded-child.mjs';
import { cascadePolicy } from '../policy-cascade.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Identity of a proven tree and the dependencies of its full smoke. */
export function smokePassKey({ tree, lockHash, nodeVersion, harnessHash }) {
  return sha256(JSON.stringify({ tree, lockHash, nodeVersion, harnessHash }));
}

/** Lifetime of a full smoke proof; invalid settings retain the two-hour default. */
export function smokePassTtlMs(env = process.env) {
  const ttl = Number(env.WE_DAEMON_SMOKE_PASS_TTL_MS ?? 2 * 60 * 60_000);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : 2 * 60 * 60_000;
}

/** Read the candidate's content identity and the RUNNING harness; failures cannot prove a tree. */
export function smokePassIdentity(git, sha) {
  try {
    const tree = verifyRev(git, `${sha}^{tree}`);
    if (!tree) return null;
    const lock = git(['show', `${sha}:package-lock.json`]);
    // Distinguish an absent lockfile from a failed read of an existing one.
    if (lock.status !== 0) {
      const listed = git(['ls-tree', '--name-only', tree, '--', 'package-lock.json']);
      if (listed.status !== 0 || String(listed.stdout ?? '').trim()) return null;
    }
    const lockHash = lock.status === 0 ? sha256(lock.stdout ?? '') : '';
    const harnessHash = sha256(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../daemon-live-smoke.mjs')));
    return { tree, key: smokePassKey({ tree, lockHash, nodeVersion: process.version, harnessHash }) };
  } catch {
    return null;
  }
}

// ── smoke-rejection helpers ────────────────────────────────────────────────────────────────────────────────

/** Did only EXTERNAL checks fail? Every failed row is one `daemon-live-smoke.mjs#SMOKE_CHECKS` marks
 *  `mayBeTransient` (it runs `gh`, not code from the tree under test). An empty list is not external-only. */
export function isExternalOnlyFailure(failed) {
  return Array.isArray(failed) && failed.length > 0 && failed.every((r) => r && r.mayBeTransient !== false);
}

/** A live smoke at least this long raises a `smoke-slow` alert — informational only (xa4qo7n): the smoke runs
 *  against a disposable candidate worktree and holds NO lock, so a slow one no longer starves any daemon's
 *  ticks the way it did before this fix; it is still worth knowing about (it delays adopting new code). */
export const SLOW_SMOKE_ALERT_MS = 60_000;

/** Backoff before an external-only rejection is re-smoked: base * 2^(attempts-1), capped. Env-tunable. */
export function rejectRetryDelayMs(env, attempts) {
  const base = Number(env?.WE_DAEMON_REJECT_RETRY_BASE_MS) || 5 * 60_000;
  const max = Number(env?.WE_DAEMON_REJECT_RETRY_MAX_MS) || 60 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
}

/** Default ON: when last-good fails every check the candidate failed, adopt the candidate as no worse.
 *  A harness fix that lives in the candidate can only ever arrive this way when the running harness also
 *  fails last-good. Set to '0' to retain the hold-on-last-good and retry-backoff behavior. */
export const HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV = 'WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE';

/** The failed check rows of a smoke result (`[]` for a pass or a missing result). */
function failedRows(smokeResult) {
  return (smokeResult?.smoke?.results || []).filter((r) => !r.ok);
}

/** PURE: does `control` fail every check `candidate` failed (by name)? — the "the harness itself is broken"
 *  test: a failure the last-good build reproduces is not evidence against the candidate's code. */
export function failsSameChecks(candidateFailed, controlFailed) {
  const c = new Set((controlFailed || []).map((r) => r.name));
  return Array.isArray(candidateFailed) && candidateFailed.length > 0 && candidateFailed.every((r) => c.has(r.name));
}

// ── the rebuild's smoke BUDGET (live 2026-10-10) ─────────────────────────────────────────────────────────────
// The drain clone's rebuild job was killed (SIGTERM, no result) on both attempts: the overlay smoke took ~10 min,
// then the plain-main fallback ran a FULL second smoke (~22 min) and the child crossed the job's 60-min limit, so the
// clone never adopted new code. Every smoke of one build now shares ONE total budget: a fallback stage starts only if
// at least `fallbackMinMs` of it is left, each child's timeout is capped at what is left, and on plain main a check
// that A already failed stops the smoke the moment it fails again (the rest cannot change the outcome).

/** Built-in (standard-layer) budget; the cascade's platform / tool (`rebuildSmokeBudget` in
 *  daemon-rebuild-settings.json) / env layers override it per leaf. Total stays under the job's 60-min child limit. */
export const REBUILD_SMOKE_BUDGET_STANDARD = Object.freeze({ totalMs: 50 * 60_000, fallbackMinMs: 5 * 60_000, failFast: true });
export const REBUILD_SMOKE_BUDGET_ENV = Object.freeze({
  totalMs: 'WE_REBUILD_SMOKE_TOTAL_MS', fallbackMinMs: 'WE_REBUILD_SMOKE_FALLBACK_MIN_MS', failFast: 'WE_REBUILD_SMOKE_FAIL_FAST',
});
const REBUILD_SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-rebuild-settings.json');

/** IO: the rebuild smoke budget through the policy cascade, with the layer each leaf came from. Never throws. */
export function resolveRebuildSmokeBudget(env = process.env, { settingsPath = REBUILD_SETTINGS_PATH } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8'))?.rebuildSmokeBudget; } catch { tool = undefined; }
  const ms = (k) => { const n = Number(env?.[REBUILD_SMOKE_BUDGET_ENV[k]]); return env?.[REBUILD_SMOKE_BUDGET_ENV[k]] != null && n > 0 ? n : undefined; };
  const ff = env?.[REBUILD_SMOKE_BUDGET_ENV.failFast];
  const posMs = (v) => Number.isFinite(v) && v > 0;
  const r = cascadePolicy('rebuildSmokeBudget', tool, {
    env,
    standard: REBUILD_SMOKE_BUDGET_STANDARD,
    envValues: { totalMs: ms('totalMs'), fallbackMinMs: ms('fallbackMinMs'), failFast: ff === '0' ? false : ff === '1' ? true : undefined },
    valid: { totalMs: posMs, fallbackMinMs: posMs, failFast: (v) => typeof v === 'boolean' },
  });
  return { ...REBUILD_SMOKE_BUDGET_STANDARD, ...(r.value || {}), source: r.sources };
}

/** The smoke check a child process belongs to, for the two checks that dominate the smoke's time (see
 *  `daemon-live-smoke.mjs#checkReconcileDryRun` / `#checkDispatchDryRun`); `null` for every other child. */
export function smokeCheckOfChild(cmd, args = []) {
  if (cmd !== 'node' || !Array.isArray(args)) return null;
  if (String(args[0] ?? '').endsWith('scripts/conveyor/reconcile-pass.mjs')) return 'reconcile-dry-run';
  if (args[0] === '--input-type=module' && args[1] === '-e') return 'dispatch-dry-run';
  return null;
}

/**
 * The `runChild` every smoke of one build gets: each child's timeout capped at the time left before `deadline`, no
 * child started once less than `minChildMs` is left, and — when `failFast` names checks — every child after one of
 * them fails is refused at once. Exposes `deadline` / `failFast` for the caller's log and tests.
 */
export function budgetedRunChild({ runChild = runBounded, deadline, now = Date.now, failFast = [], minChildMs = 1_000 }) {
  const ff = new Set(failFast || []);
  let stopped = null;
  const run = async (cmd, args = [], opts = {}) => {
    if (stopped) throw new Error(`skipped: fail-fast — ${stopped} failed on the overlay build and again on this one`);
    const left = deadline - now();
    if (!(left >= minChildMs)) throw new Error(`skipped: rebuild smoke budget exhausted (${Math.max(0, Math.round(left))}ms left)`);
    const timeoutMs = Number.isFinite(opts?.timeoutMs) ? Math.min(opts.timeoutMs, left) : left;
    try {
      return await runChild(cmd, args, { ...opts, timeoutMs });
    } catch (e) {
      const check = smokeCheckOfChild(cmd, args);
      if (check && ff.has(check)) stopped = check;
      throw e;
    }
  };
  run.deadline = deadline;
  run.failFast = [...ff];
  return run;
}

// ── xhiqxz3 — the real DISPATCH SMOKE inside the rebuild ─────────────────────────────────────────────────────
// #4481 (xkhtg2a) made `daemon-load-overlay` launch ONE real worker when an overlay touches a dispatch-path file.
// But the daemon's own tick rebuild could adopt that overlay first and run it for minutes before any load smoked
// it (incident 2026-10-08, `lane/worker-contract-s3b`: every worker hit an approval prompt and died at step 0,
// while the live smoke — dispatch DRY-RUNS only — passed). So the candidate smoke here runs that same real worker
// launch (`runRealDispatchSmoke`, same `overlaySafety` settings) whenever the candidate carries an overlay that is
// NEW or MOVED since the adopted build and changes a dispatch-path file. A failure is never adopted: the clone
// stays on its last-good build. A definite failure (commands denied, no command ran, launch threw) also drops just
// the offending overlay(s), so the next tick builds main + every other overlay; a timeout keeps them and retries
// with backoff (it may be the environment, not the code).

/** Dispatch-smoke failures that prove the overlay's launch path is broken (vs a timeout, which may be env). */
const DISPATCH_SMOKE_DEFINITE = new Set(['commands-denied', 'no-commands-ran', 'launch-failed']);

/**
 * PURE given `git`: the overlays in `applied` that need the real dispatch smoke — every one NOT already in the
 * adopted build at the same sha (`adoptedApplied: null` = unknown ⇒ every overlay counts) whose own diff against
 * main touches `patterns`. Fails CLOSED: an overlay whose diff cannot be read is a suspect (`diff-unknown`).
 * @returns {Array<{ref:string, pr:number|null, sha:string, matched:string[], reason:string}>}
 */
export function dispatchSmokeSuspects({
  git, applied, adoptedApplied, patterns, match,
}) {
  const known = Array.isArray(adoptedApplied) ? new Map(adoptedApplied.map((a) => [a?.ref, a?.sha])) : null;
  const out = [];
  for (const ap of applied || []) {
    if (!ap?.ref || (known && ap.sha && known.get(ap.ref) === ap.sha)) continue;
    const suspect = { ref: ap.ref, pr: ap.pr ?? null, sha: ap.sha };
    const baseRes = ap.sha ? git(['merge-base', 'origin/main', ap.sha]) : { status: 1 };
    const base = baseRes.status === 0 ? String(baseRes.stdout ?? '').trim() : '';
    const diff = base ? git(['diff', '--name-only', base, ap.sha]) : null;
    if (!diff || diff.status !== 0) {
      out.push({ ...suspect, matched: [], reason: 'diff-unknown' });
      continue;
    }
    const files = String(diff.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
    const matched = match(files, patterns);
    if (matched.length) out.push({ ...suspect, matched, reason: 'touches-dispatch-path' });
  }
  return out;
}

/** Resolve the dispatch-smoke wiring: injected pieces win; the rest come from #4481's module (loaded lazily —
 *  it imports the rebuild, so a static import here would be a cycle). */
async function resolveDispatchSmoke(opt, env) {
  let mod = null;
  let loadError = null;
  if (!opt?.settings || !opt?.run || !opt?.match) {
    try { mod = await import('../daemon-load-overlay.mjs'); } catch (e) { loadError = e; }
  }
  const settings = opt?.settings ?? mod?.overlaySafetySettings?.(env) ?? null;
  const run = opt?.run ?? mod?.runRealDispatchSmoke ?? null;
  const match = opt?.match ?? mod?.matchDispatchPaths ?? null;
  return {
    on: !!(settings && run && match) && settings.dispatchSmoke === 'on',
    settings, run, match, unavailable: !(settings && run && match) ? String(loadError?.message || 'dispatch smoke module incomplete') : null,
  };
}

/**
 * Phase 2 body (x5wbsbc — the operator's fallback ruling, 2026-09-26: "fallback on last working version rather
 * than block delivery"). Smokes candidate A = `plan` (main + overlays). On a pass: adopt (phase 3), as before.
 * On a `'code'` failure, in order:
 *   (a) PLAIN MAIN: when A carries any NON-pinned overlay, build B = main + pinned overlays only and smoke it. B
 *       passes ⇒ adopt B and DROP A's non-pinned overlays from the list (they are what broke it — every one is
 *       reported, `overlay-dropped-smoke-failed`; with several, all are dropped as suspects, never bisected).
 *       When EVERY A failure is load-shaped ({@link isLoadShapedRow}), B is a full smoke and a B pass re-smokes A
 *       in the same run: A passes ⇒ adopt A; A reproduces a code-shaped failure ⇒ drop as above; otherwise
 *       `smoke-env-load` — adopt B (or hold when B failed too), keep every overlay, retry A with backoff.
 *   (b) otherwise the clone STAYS on its last-good build (`prevHead`, never touched) and `state.held` records
 *       why; `main-staleness.mjs#assertMainNotStale` keeps dispatching from that build (max-age alert, never a
 *       refusal), and the health watch's `daemon-held-on-last-good` sign notifies after 15 min.
 *   (c) to tell (b) apart from a broken HARNESS, the last-good build itself (C = `prevHead`, full smoke, no
 *       skip-unchanged) is smoked as a control: C failing every check A failed means the failure is the smoke's
 *       environment: adopt A as no worse by default so candidate harness fixes can arrive. With
 *       {@link HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV} set to '0', hold as `smoke-harness-broken` with a retry
 *       backoff (never sticky), including across main moves (see `prepareRebuild`). Never blocks.
 * `'transient'` (env noise that survived its retries) keeps today's rule — no reject record — and also holds.
 *
 * #4126 `readyOnly` (the rebuild JOB, `rebuild-job.mjs`): a passing build is recorded as the clone's ready
 * candidate exactly as before, but the job never takes the finalize lock or moves `root` — it releases its build
 * lease and returns `ready-recorded`. The daemon's next tick adopts the ready candidate through the existing
 * `prepareRebuild` ready path (no re-smoke, same match rules), so the swap stays at the daemon's own tick boundary.
 */
export async function smokeAndAdopt({
  root, env, stEnv, log, run, runSmoke, stateOpts, now, plan, prevHead, lease, overlaysBefore, prepAlerts, mainOnly,
  finalLockOpts, finalizeLockOpts = finalLockOpts, dispatchSmoke, readyOnly = false,
}) {
  /** Every state write here happens UNDER the write lock (PR #2731 review: an unlocked write could clobber a
   *  sibling's locked one). `release` also drops our build lease — done by the outcome that ENDS this build,
   *  never mid-fallback (a sibling must not start a build while B/C are still being smoked). Returns the
   *  written state, or null when the lock could not be taken (the lease then lapses; the next tick retries). */
  const locked = async (mutate, { release = false } = {}) => {
    const r = await withWriteLock(root, () => {
      const st = readRebuildState(root, stEnv);
      if (release) releaseBuildLease(st, lease);
      mutate?.(st);
      writeRebuildState(root, st, stEnv);
      return st;
    }, finalLockOpts);
    if (!r.ok) log.error?.(`daemon-rebuild: could not take the write lock to record this build's outcome (${r.reason}) — nothing recorded; the next tick retries`);
    return r.ok ? r.value : null;
  };
  const alertsList = [];
  const nowIso = () => new Date(now()).toISOString();
  const alert = (kind, detail) => {
    alertsList.push({ kind, detail });
    log.error?.(`daemon-rebuild: ${kind}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    try {
      const file = alertsFilePath(root, stEnv);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: nowIso(), kind, detail })}\n`, 'utf8');
    } catch { /* best-effort audit trail only */ }
  };
  const git = makeGit({ run, cwd: root, env });
  const smokeEnv = candidateSmokeEnv({ root, env });
  // One total budget for every smoke of this build (A, plain main, confirm, last-good) — see budgetedRunChild.
  const budget = resolveRebuildSmokeBudget(env);
  const deadline = now() + budget.totalMs;
  log.error?.(`daemon-rebuild: smoke-budget ${JSON.stringify({ totalMs: budget.totalMs, fallbackMinMs: budget.fallbackMinMs, failFast: budget.failFast, source: budget.source })}`);
  /** May a further smoke `stage` start? When not, say so (with the budget's source) — the caller skips the stage. */
  const budgetAllows = (stage) => {
    const remainingMs = deadline - now();
    if (remainingMs >= budget.fallbackMinMs) return true;
    alert('smoke-budget-exhausted', {
      stage, remainingMs: Math.max(0, remainingMs), totalMs: budget.totalMs, fallbackMinMs: budget.fallbackMinMs, source: budget.source,
      message: `not starting the ${stage} smoke: less than fallbackMinMs of the rebuild smoke budget is left`,
    });
    return false;
  };
  const adoptedState = readRebuildState(root, stEnv).adopted ?? null;
  const adoptedHead = adoptedState?.head ?? null;

  // xhiqxz3 — which overlays of a build need the real dispatch smoke (none when the setting is off).
  const dsm = await resolveDispatchSmoke(dispatchSmoke, env);
  if (dsm.unavailable) alert('dispatch-smoke-unavailable', { error: dsm.unavailable });
  const adoptedApplied = adoptedHead && adoptedHead === prevHead && Array.isArray(adoptedState?.applied) ? adoptedState.applied : null;
  const suspectsFor = (applied) => (dsm.on ? dispatchSmokeSuspects({
    git, applied, adoptedApplied, patterns: dsm.settings.dispatchPaths, match: dsm.match,
  }) : []);
  /** Launch the one real worker from the candidate worktree at `path`. Never throws. */
  const runDispatch = async (path, suspects) => {
    let result;
    try {
      result = await dsm.run({
        tree: path, env: smokeEnv, settings: dsm.settings, log,
      });
    } catch (e) {
      result = { ok: false, reason: 'launch-failed', detail: String(e?.message || e) };
    }
    return { suspects, result: result || { ok: false, reason: 'launch-failed', detail: 'no result' } };
  };
  /** The dispatch smoke on its own (a proven tree, or the adopt-as-no-worse path): materialize, launch, tear down. */
  const dispatchOnly = async (sha, suspects) => {
    const candidate = materializeCandidate({
      root, sha, run, env, path: lease.path,
    });
    if (!candidate.ok) return { suspects, result: { ok: false, reason: 'candidate-worktree-failed', detail: candidate.reason } };
    try {
      return await runDispatch(candidate.path, suspects);
    } finally {
      removeCandidate({
        root, path: candidate.path, run, env,
      });
    }
  };

  // #4044: the files changed since the LAST LIVE-VERIFIED build (HEAD before this move, when it is the adopted
  // one) — lets the smoke skip a tree-code check whose code none of them touch (see daemon-live-smoke.mjs
  // SMOKE_CHECKS). Unknown (not the adopted head, a failed diff) ⇒ null ⇒ full smoke.
  const changedSince = (sha) => {
    if (!adoptedHead || adoptedHead !== prevHead) return null;
    // A build adopted while a lane-pool probe was SKIPPED for a busy pool (`skipped: busy pool`) was never
    // live-verified on those checks, so "unchanged since the last live-verified build" does not hold for it:
    // the next smoke runs every check (null = full smoke), or a chain of busy skips would launder the pool code.
    const busyTrees = readRebuildState(root, stEnv).busySkippedTrees;
    if (Array.isArray(busyTrees) && busyTrees.length) {
      const headTree = verifyRev(git, `${prevHead}^{tree}`);
      if (!headTree || busyTrees.includes(headTree)) return null;
    }
    const d = git(['diff', '--name-only', prevHead, sha]);
    return d.status === 0 ? String(d.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean) : null;
  };

  /** Materialize `sha` as the candidate worktree, smoke it, tear it down. */
  const smokeSha = async (sha, changedFiles, label, suspects = [], { failFast = [] } = {}) => {
    // Every smoke of this build (A, then B / C) reuses the lease's own unique path, one after another.
    const candidate = materializeCandidate({
      root, sha, run, env, path: lease.path,
    });
    if (!candidate.ok) return { worktreeFailed: candidate.reason };
    let smokeResult = null;
    let threw = null;
    let dispatch = null;
    const t0 = now();
    try {
      const runChild = budgetedRunChild({ deadline, now, failFast: budget.failFast ? failFast : [] });
      smokeResult = await runSmoke({ root: candidate.path, env: smokeEnv, changedFiles, runChild });
    } catch (e) {
      threw = e;
    }
    // xhiqxz3 — only after the ordinary smoke passed (a failing build is not adopted anyway).
    if (!threw && smokeResult?.verdict === 'pass' && suspects.length) dispatch = await runDispatch(candidate.path, suspects);
    const ms = now() - t0;
    removeCandidate({
      root, path: candidate.path, run, env,
    });
    // x5059uu — per-step timings on EVERY smoke (live 2026-10-09: smokes took 421 s and 1,002 s), so a slow step is
    // visible in the log before it crosses the smoke-slow line; the dispatch smoke counts as its own step.
    const checks = [
      ...(smokeResult?.smoke?.results || []).map((r) => `${r.name}:${r.skipped ? 'skipped' : `${r.ms}ms`}`),
      ...(dispatch?.result?.ms != null ? [`dispatch-smoke:${dispatch.result.ms}ms`] : []),
    ].join(' ');
    log.error?.(`daemon-rebuild: smoke-timings ${JSON.stringify({ ms, ...(label ? { candidate: label } : {}), checks })}`);
    if (ms >= SLOW_SMOKE_ALERT_MS) {
      alert('smoke-slow', {
        ms,
        ...(label ? { candidate: label } : {}),
        checks,
      });
    }
    if (!threw && smokeResult?.verdict === 'pass' && changedFiles === null && (!dispatch || dispatch.result.ok)
      && !smokeResult.cached && !busyPoolSkippedChecks(smokeResult).length && label !== 'confirm') {
      const identity = smokePassIdentity(git, sha);
      if (identity) await locked((st) => {
        const prior = Array.isArray(st.smokePassed) ? st.smokePassed : [];
        st.smokePassed = [{ ...identity, passedAt: nowIso() }, ...prior.filter((entry) => entry?.key !== identity.key)].slice(0, 5);
      });
    }
    return {
      smokeResult, threw, ms, dispatch,
    };
  };

  /** xhiqxz3 — a passed dispatch smoke: say so (the proof line the live daemon's log carries). */
  const dispatchPassedAlert = (d) => alert('dispatch-smoke-passed', {
    suspects: d.suspects.map((s) => ({ ref: s.ref, pr: s.pr, matched: s.matched })),
    ms: d.result.ms ?? null, sessionId: d.result.sessionId ?? null,
  });
  /** xhiqxz3 — a FAILED dispatch smoke: never adopt; hold on last-good. A definite failure drops just the suspect
   *  overlay(s) (the next tick builds main + every other overlay); a timeout/unknown keeps them and backs off. */
  const dispatchFailed = async (d) => {
    const { result, suspects } = d;
    const definite = DISPATCH_SMOKE_DEFINITE.has(result.reason);
    const why = `dispatch-smoke-failed: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`;
    alert('dispatch-smoke-failed', {
      reason: result.reason, detail: redactDetail(result.detail ?? ''),
      suspects: suspects.map((s) => ({ ref: s.ref, pr: s.pr, matched: s.matched })),
      evidence: result.scratch ?? null, transcript: result.transcript ?? null,
      action: definite ? 'dropped-suspects' : 'retry-with-backoff',
      message: 'the candidate failed the REAL dispatch smoke — not adopting it; staying on the last working build (xhiqxz3)',
    });
    await hold('dispatch-smoke-failed', [{ name: 'dispatch-smoke', detail: why }], {}, (st) => {
      const prev = st.rejected?.dispatchSmoke && st.rejected?.inputsKey === plan.inputsKey ? st.rejected : null;
      st.rejected = {
        inputsKey: plan.inputsKey, reason: 'dispatch-smoke', at: nowIso(), dispatchSmoke: true,
      };
      if (!definite) {
        const attempts = (prev?.attempts || 0) + 1;
        Object.assign(st.rejected, { attempts, retryAt: new Date(now() + rejectRetryDelayMs(env, attempts)).toISOString() });
      }
    });
    if (definite && !mainOnly) {
      for (const s of suspects) {
        try {
          removeOverlay(root, s.ref, { env, why });
          appendOverlayEvent(root, {
            kind: 'dropped-dispatch-smoke-failed', ref: s.ref, pr: s.pr, reason: why,
          }, { env });
          alert('overlay-dropped-dispatch-smoke-failed', {
            ref: s.ref, pr: s.pr, matched: s.matched, suspects: suspects.length,
            message: 'this overlay broke the real worker launch — fix it, then re-add it',
          });
        } catch (e) {
          alert('overlay-drop-failed', { ref: s.ref, error: String(e?.message || e) });
        }
      }
    }
    return { moved: false, reason: 'dispatch-smoke-failed', plan, alerts: [...prepAlerts, ...alertsList] };
  };

  /** Adopt `p`, whose smoke just PASSED. fix-rebuild-finalize: the pass is recorded as the clone's ready candidate
   *  FIRST, so a lock refusal here never throws it away — the next write-lock holder (this process's next tick, or
   *  a sibling at its own tick start) adopts it without re-smoking (see prepareRebuild). */
  const finalize = async (p, onAdopted, readyMeta = { kind: 'candidate' }, smokeResult = null) => {
    // Record, BEFORE adopting, that this build's tree passed with a busy-pool skip (see `changedSince`).
    const busySkipped = busyPoolSkippedChecks(smokeResult);
    if (busySkipped.length) {
      const tree = verifyRev(git, `${p.finalSha}^{tree}`);
      alert('smoke-busy-pool-skipped', { checks: busySkipped, message: 'lane-pool probe(s) skipped under a busy pool; the next smoke re-runs every check' });
      if (tree) await locked((st) => { st.busySkippedTrees = [tree, ...(st.busySkippedTrees || []).filter((t) => t !== tree)].slice(0, 5); });
    }
    writeReadyCandidate(root, {
      ...readyMeta,
      prevHead,
      tree: verifyRev(git, `${p.finalSha}^{tree}`),
      adopt: {
        finalSha: p.finalSha, inputsKey: p.inputsKey, mainSha: p.mainSha, applied: p.applied,
      },
      token: lease.token,
      pid: process.pid,
      host: hostname(),
      passedAt: nowIso(),
    }, stEnv);
    if (readyOnly) {
      // #4126: a fallback's suspect drop rides the ready record (`dropRefs`) and runs at adoption; any other
      // post-adopt hook (the env-load backoff record) is a state note that is safe to write now.
      if (onAdopted && readyMeta?.kind !== 'fallback') {
        const r = await withWriteLock(root, () => onAdopted({ alert }), finalLockOpts);
        if (!r.ok) log.error?.(`daemon-rebuild: could not take the write lock for ${p.finalSha}'s post-pass note (${r.reason}) — skipped`);
      }
      await locked(null, { release: true });
      alert('ready-candidate-recorded', {
        target: p.finalSha, kind: readyMeta?.kind ?? 'candidate',
        message: 'smoke passed in the rebuild job — the daemon adopts it at its next tick boundary (#4126)',
      });
      return {
        moved: false, reason: 'ready-recorded', readyRecorded: true, target: p.finalSha, plan: p, alerts: [...prepAlerts, ...alertsList],
      };
    }
    const fin = await withWriteLock(root, () => finalizeRebuild({
      root, env, log, run, stateOpts, now, plan: p, prevHead, lease, onAdopted,
    }), finalizeLockOpts);
    if (!fin.ok) {
      if (fin.reason === 'tick-in-progress') {
        log.error?.(`daemon-rebuild: could not take the write lock to finalize ${p.finalSha} after a passing smoke (reader ${fin.heldBy ?? '?'} still ticking) — kept as the ready candidate; the next write-lock holder adopts it without re-smoking`);
      } else if (fin.reason === 'reader-priority') {
        log.error?.(`daemon-rebuild: backed off finalizing ${p.finalSha} — starved reader ${fin.heldBy ?? '?'} has priority; kept as the ready candidate, the next write-lock holder adopts it without re-smoking`);
      }
      return {
        moved: false, reason: fin.reason, ...(fin.heldBy ? { heldBy: fin.heldBy } : {}), plan: p, alerts: [...prepAlerts, ...alertsList],
      };
    }
    return { ...fin.value, alerts: [...prepAlerts, ...alertsList, ...fin.value.alerts] };
  };

  /** (b) — record that the clone stays on its last-good build, and why. `since` survives repeat holds. */
  const hold = async (reason, failed, extra = {}, mutateMore) => {
    let since = null;
    const state = (await locked((st) => {
      mutateMore?.(st);
      since = st.held?.since ?? nowIso();
      st.held = {
        since,
        reason,
        failed: failed.map((r) => r.name).join(','),
        details: failed.map((r) => ({ name: r.name, detail: redactDetail(r.detail) })).slice(0, 10),
        lastGood: prevHead,
        target: plan.finalSha,
        mainSha: plan.mainSha,
        updatedAt: nowIso(),
        ...extra,
      };
    }, { release: true })) ?? readRebuildState(root, stEnv);
    alert('daemon-held-on-last-good', {
      reason, failed: failed.map((r) => r.name).join(','), since: since ?? state.held?.since ?? null, lastGood: prevHead, target: plan.finalSha,
      message: 'the new build failed its live smoke — staying on the last working build and still dispatching from it (x5wbsbc)',
    });
    const staleDetail = staleAlertDetail({ moved: false, reason, plan }, state);
    if (staleDetail) alert('clone-held-stale', staleDetail);
    return state;
  };

  // ── Candidate A: main + every overlay ──────────────────────────────────────────────────────────────────
  const aSuspects = suspectsFor(plan.applied);
  const identity = smokePassIdentity(git, plan.finalSha);
  const passes = readRebuildState(root, stEnv).smokePassed;
  const proven = identity && Array.isArray(passes) && passes.find((entry) => {
    const age = now() - Date.parse(entry?.passedAt);
    return entry?.key === identity.key && age >= 0 && age <= smokePassTtlMs(env);
  });
  if (proven) {
    alert('smoke-skipped-proven-tree', {
      tree: identity.tree, provenAt: proven.passedAt,
      reason: 'tree already passed a full smoke (same lock, node, harness)',
    });
    // xhiqxz3 — a proven tree still owes the dispatch smoke for an overlay the adopted build does not carry.
    if (aSuspects.length) {
      const d = await dispatchOnly(plan.finalSha, aSuspects);
      if (!d.result.ok) return dispatchFailed(d);
      dispatchPassedAlert(d);
    }
    return finalize(plan, undefined, undefined, { verdict: 'pass', cached: true, smoke: { results: [] } });
  }
  const a = await smokeSha(plan.finalSha, changedSince(plan.finalSha), null, aSuspects);
  if (a.worktreeFailed) {
    await locked(null, { release: true });
    log.error?.(`daemon-rebuild: candidate-worktree-failed (${a.worktreeFailed}) — not adopting ${plan.finalSha}, retrying next tick`);
    return {
      moved: false, reason: 'candidate-worktree-failed', detail: a.worktreeFailed, plan, alerts: [...prepAlerts, ...alertsList],
    };
  }
  if (a.threw) {
    // `daemon-live-smoke.mjs` documents itself as never throwing — this is defense-in-depth only. Root was
    // never touched, so nothing to roll back; hold on last-good and let the next tick retry fresh.
    alert('smoke-threw', String(a.threw?.message || a.threw));
    await hold('smoke-threw', []);
    return { moved: false, reason: 'smoke-threw', plan, alerts: [...prepAlerts, ...alertsList] };
  }
  if (a.smokeResult.verdict === 'pass') {
    if (a.dispatch && !a.dispatch.result.ok) return dispatchFailed(a.dispatch);
    if (a.dispatch) dispatchPassedAlert(a.dispatch);
    return finalize(plan, undefined, undefined, a.smokeResult);
  }

  const failedA = failedRows(a.smokeResult);
  for (const verdict of SMOKE_ENVIRONMENT_VERDICTS) {
    if (verdict.matches(a.smokeResult.verdict)) return verdict.run({ a, failedA, alert, hold, plan, prepAlerts, alertsList });
  }

  // Record A's rejection exactly as before (sticky until the inputs move, or backoff for external-only).
  // `priorRejected` keeps the record this overwrites: a repeat `smoke-harness-broken` needs its attempt count
  // to grow the backoff (see step (c) below).
  let priorRejected = null;
  {
    const failedNames = failedA.map((r) => r.name).join(',');
    let rejected = null;
    await locked((st) => {
      priorRejected = st.rejected;
      const prev = st.rejected?.inputsKey === plan.inputsKey ? st.rejected : null;
      st.rejected = { inputsKey: plan.inputsKey, reason: failedNames, at: nowIso() };
      if (isExternalOnlyFailure(failedA)) {
        const attempts = (prev?.externalOnly ? (prev.attempts || 1) : 0) + 1;
        const delay = rejectRetryDelayMs(env, attempts);
        Object.assign(st.rejected, { externalOnly: true, attempts, retryAt: new Date(now() + delay).toISOString() });
      }
      rejected = st.rejected;
    });
    alert('smoke-rejected', {
      failed: failedNames,
      details: failedA.map((r) => ({ name: r.name, detail: redactDetail(r.detail) })),
      ...(rejected?.retryAt ? { retryAt: rejected.retryAt, attempts: rejected.attempts } : {}),
      ...(rejected ? {} : { recorded: false }),
    });
  }

  // ── (a) plain main: drop every NON-pinned overlay and try again ──────────────────────────────────────
  const rawByRef = new Map((overlaysBefore || []).map((o) => [o?.ref, o]));
  const withPin = plan.applied.map((ap) => ({
    ...ap, pinned: pinnedStatus(git, rawByRef.get(ap.ref) ?? {}, plan.mainSha, ap.sha).pinned,
  }));
  const suspects = withPin.filter((ap) => !ap.pinned);
  let bFailed = null;
  // See LOAD_CONTENTION_SIGNATURES' header: every A row load-shaped ⇒ the same-run differential decides.
  const loadOnly = loadDifferentialEnabled(env) && failedA.length > 0 && failedA.every((r) => isLoadShapedRow(r, env));
  const envLoadRecord = (st) => {
    const prev = st.rejected?.envLoad && st.rejected?.inputsKey === plan.inputsKey ? st.rejected
      : (priorRejected?.envLoad && priorRejected?.inputsKey === plan.inputsKey ? priorRejected : null);
    const attempts = (prev?.attempts || 0) + 1;
    st.rejected = {
      inputsKey: plan.inputsKey,
      reason: failedA.map((r) => r.name).join(','),
      at: nowIso(),
      envLoad: true,
      attempts,
      retryAt: new Date(now() + envLoadRetryDelayMs(env, attempts)).toISOString(),
    };
    return st.rejected;
  };
  const envLoadAlert = (extra) => alert('smoke-env-load', {
    failed: failedA.map((r) => r.name).join(','),
    details: failedA.map((r) => ({ name: r.name, ms: r.ms, detail: redactDetail(r.detail) })),
    suspects: suspects.map((ap) => ({ ref: ap.ref, pr: ap.pr })),
    ...extra,
    message: 'every failed check is load-shaped (timeout / lock contention) and no same-run differential pinned it on an overlay — environment, not the candidate; overlays kept, retrying with backoff',
  });
  if (!mainOnly && suspects.length > 0) {
    const pinnedOverlays = withPin.filter((ap) => ap.pinned).map((ap) => ({ ...(rawByRef.get(ap.ref) ?? {}), ref: ap.ref, pr: ap.pr }));
    const planB = await planRebuild({
      git, headSha: prevHead, mainRef: 'origin/main', overlays: pinnedOverlays,
      edgeResolve: env[OVERLAY_EDGE_RESOLVE_ENV] !== '0',
    });
    if (planB.ok) {
      const suspectInfo = suspects.map((ap) => ({ ref: ap.ref, pr: ap.pr }));
      alert('fallback-plain-main', {
        failed: failedA.map((r) => r.name).join(','), suspects: suspectInfo, target: planB.finalSha,
        message: 'main + overlays failed the live smoke — retrying plain main (pinned overlays only) (x5wbsbc)',
      });
      const failedNames = failedA.map((r) => r.name).join(',');
      const dropSuspects = ({ alert: finAlert }) => dropSuspectOverlays({
        root, env, suspects: suspectInfo, failed: failedNames, alert: finAlert,
      });
      const fallbackReady = {
        // Each suspect's failing sha rides along, so a later adoption after main moved can tell that the suspect
        // itself did not (matchReadyCandidate's `fallback-main-moved`).
        kind: 'fallback', forInputsKey: plan.inputsKey, dropRefs: suspects.map((ap) => ({ ref: ap.ref, pr: ap.pr, sha: ap.sha })), failed: failedNames,
      };
      // Plain main IS the build already running (an overlay was just added onto an otherwise-current clone) and
      // that build is the smoke-verified one: nothing to smoke, just drop the suspect(s).
      // A load-shaped failure never takes this shortcut: an earlier pass is not a SAME-RUN differential.
      if (!loadOnly && planB.finalSha === prevHead && adoptedHead === prevHead) {
        const fin = await finalize(planB, dropSuspects, fallbackReady);
        return { ...fin, reason: 'fallback-plain-main', fallback: { from: plan.finalSha, to: planB.finalSha, dropped: suspectInfo } };
      }
      // Fail fast on every check A failed: if plain main fails one of them too, the rest of B cannot change the outcome.
      const b = budgetAllows('plain-main')
        ? await smokeSha(planB.finalSha, loadOnly ? null : changedSince(planB.finalSha), 'plain-main', suspectsFor(planB.applied), { failFast: failedA.map((r) => r.name) })
        : { budgetSkipped: true };
      if (b.dispatch && !b.dispatch.result.ok) {
        alert('fallback-plain-main-dispatch-smoke-failed', { reason: b.dispatch.result.reason, suspects: b.dispatch.suspects.map((s) => s.ref) });
      }
      const bPassed = !b.worktreeFailed && !b.threw && b.smokeResult?.verdict === 'pass' && (!b.dispatch || b.dispatch.result.ok);
      if (bPassed && loadOnly) {
        // Same-run differential, second half: re-smoke A now that plain main passed.
        // No budget left for the re-smoke: no same-run differential, so treat it as load (never blame the overlay).
        const a2 = budgetAllows('confirm') ? await smokeSha(plan.finalSha, null, 'confirm', aSuspects) : { budgetSkipped: true };
        if (a2.dispatch && !a2.dispatch.result.ok) return dispatchFailed(a2.dispatch);
        if (!a2.budgetSkipped && !a2.worktreeFailed && !a2.threw && a2.smokeResult?.verdict === 'pass') {
          if (a2.dispatch) dispatchPassedAlert(a2.dispatch);
          alert('smoke-load-confirm-passed', {
            failed: failedNames, suspects: suspectInfo,
            message: 'A failed under load, plain main passed, A re-smoked passed — load, not the overlay; adopting A with every overlay kept',
          });
          const fin = await finalize(plan, undefined, undefined, a2.smokeResult);
          return { ...fin, reason: fin.adopted ? 'smoke-load-confirm-passed' : fin.reason };
        }
        const failedA2 = a2.smokeResult ? failedRows(a2.smokeResult) : [];
        const failedNamesA = new Set(failedA.map((r) => r.name));
        const reproduced = failedA2.some((r) => failedNamesA.has(r.name) && !isLoadShapedRow(r, env));
        if (!reproduced) {
          envLoadAlert({ plainMain: 'passed', confirm: failedA2.map((r) => r.name).join(',') || (a2.budgetSkipped ? 'skipped: budget' : a2.worktreeFailed ? `worktree: ${a2.worktreeFailed}` : 'threw') });
          // Plain main passed: adopt it so the clone stays current, keep every overlay, back A off.
          const recordBackoff = () => {
            const st = readRebuildState(root, stEnv);
            envLoadRecord(st);
            writeRebuildState(root, st, stEnv);
          };
          const fin = await finalize(planB, recordBackoff, { kind: 'candidate' }, b.smokeResult);
          return { ...fin, reason: fin.adopted ? 'smoke-env-load' : fin.reason };
        }
        // A reproduced a code-shaped failure on a check it already failed, while plain main passed: genuine.
      }
      if (bPassed) {
        const fin = await finalize(planB, dropSuspects, fallbackReady, b.smokeResult);
        return { ...fin, reason: 'fallback-plain-main', fallback: { from: plan.finalSha, to: planB.finalSha, dropped: suspectInfo } };
      }
      bFailed = b.smokeResult ? failedRows(b.smokeResult) : null;
      if (!b.budgetSkipped) alert('fallback-plain-main-failed', {
        failed: (bFailed || []).map((r) => r.name).join(',') || (b.worktreeFailed ? `worktree: ${b.worktreeFailed}` : 'threw'),
      });
      if (loadOnly) {
        // Plain main failed too, under the same load: environment. No last-good control (it would fail the same
        // way and read as a broken harness), no drop — hold and retry A with backoff.
        envLoadAlert({ plainMain: (bFailed || []).map((r) => r.name).join(',') || 'unavailable' });
        await hold('smoke-env-load', failedA, {}, (st) => { envLoadRecord(st); });
        return { moved: false, reason: 'smoke-env-load', plan, alerts: [...prepAlerts, ...alertsList] };
      }
    } else {
      alert('fallback-plain-main-unplannable', { reason: planB.reason });
    }
  }

  // ── (c) control: smoke the LAST-GOOD build itself — does the harness fail it the same way? ────────────
  const c = budgetAllows('last-good') ? await smokeSha(prevHead, null, 'last-good') : { budgetSkipped: true };
  const cFailed = c.smokeResult ? failedRows(c.smokeResult) : null;
  const harnessBroken = !!(cFailed && failsSameChecks(failedA, cFailed));
  if (harnessBroken) {
    if (env[HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV] !== '0') {
      // xhiqxz3 — "no worse" on the ordinary smoke says nothing about the worker launch: prove that first.
      if (aSuspects.length) {
        const d = await dispatchOnly(plan.finalSha, aSuspects);
        if (!d.result.ok) return dispatchFailed(d);
        dispatchPassedAlert(d);
      }
      alert('smoke-harness-broken-adopted-not-worse', {
        failed: failedA.map((r) => r.name).join(','),
        alsoFailedOn: bFailed ? ['plain-main', 'last-good'] : ['last-good'],
        message: 'last-good failed every check the candidate failed — adopting the candidate as no worse so a candidate harness fix can arrive',
      });
      const fin = await finalize(plan, undefined, undefined, a.smokeResult);
      return { ...fin, reason: fin.adopted ? 'harness-broken-adopted-not-worse' : fin.reason };
    }
    const prevAttempts = priorRejected?.harnessBroken ? (priorRejected.attempts || 1) : 0;
    const attempts = prevAttempts + 1;
    const retryAt = new Date(now() + rejectRetryDelayMs(env, attempts)).toISOString();
    alert('smoke-harness-broken', {
      failed: failedA.map((r) => r.name).join(','),
      details: cFailed.map((r) => ({ name: r.name, detail: redactDetail(r.detail) })),
      alsoFailedOn: bFailed ? ['plain-main', 'last-good'] : ['last-good'],
      retryAt,
      attempts,
      message: 'the smoke fails the LAST-GOOD build the same way — the smoke harness/environment is broken, not the candidate; never blocks: staying on last-good and dispatching (x5wbsbc)',
    });
    // The rejection record and the hold are written together, in the one locked write that ends this build.
    await hold('smoke-harness-broken', failedA, {}, (st) => {
      st.rejected = {
        ...(st.rejected || {}), inputsKey: plan.inputsKey, harnessBroken: true, attempts, retryAt,
      };
    });
    return { moved: false, reason: 'smoke-harness-broken', plan, alerts: [...prepAlerts, ...alertsList] };
  }
  if (!c.smokeResult && !c.budgetSkipped) alert('last-good-control-unavailable', { reason: c.worktreeFailed ?? String(c.threw?.message || c.threw) });
  await hold('smoke-rejected', failedA, { controlPassed: !!(c.smokeResult && c.smokeResult.verdict === 'pass') });
  return { moved: false, reason: 'smoke-rejected', plan, alerts: [...prepAlerts, ...alertsList] };
}
