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
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeGit, verifyRev, OVERLAY_EDGE_RESOLVE_ENV } from './shared.mjs';
import { candidateSmokeEnv, materializeCandidate, removeCandidate } from './candidate.mjs';
import { hostname } from 'node:os';
import { pinnedStatus, planRebuild } from './plan.mjs';

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
 */
export async function smokeAndAdopt({
  root, env, stEnv, log, run, runSmoke, stateOpts, now, plan, prevHead, lease, overlaysBefore, prepAlerts, mainOnly,
  finalLockOpts, finalizeLockOpts = finalLockOpts,
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
  const adoptedHead = readRebuildState(root, stEnv).adopted?.head ?? null;

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
  const smokeSha = async (sha, changedFiles, label) => {
    // Every smoke of this build (A, then B / C) reuses the lease's own unique path, one after another.
    const candidate = materializeCandidate({
      root, sha, run, env, path: lease.path,
    });
    if (!candidate.ok) return { worktreeFailed: candidate.reason };
    let smokeResult = null;
    let threw = null;
    const t0 = now();
    try {
      smokeResult = await runSmoke({ root: candidate.path, env: smokeEnv, changedFiles });
    } catch (e) {
      threw = e;
    }
    const ms = now() - t0;
    removeCandidate({
      root, path: candidate.path, run, env,
    });
    if (ms >= SLOW_SMOKE_ALERT_MS) {
      alert('smoke-slow', {
        ms,
        ...(label ? { candidate: label } : {}),
        checks: (smokeResult?.smoke?.results || []).map((r) => `${r.name}:${r.skipped ? 'skipped' : `${r.ms}ms`}`).join(' '),
      });
    }
    if (!threw && smokeResult?.verdict === 'pass' && changedFiles === null
      && !smokeResult.cached && !busyPoolSkippedChecks(smokeResult).length && label !== 'confirm') {
      const identity = smokePassIdentity(git, sha);
      if (identity) await locked((st) => {
        const prior = Array.isArray(st.smokePassed) ? st.smokePassed : [];
        st.smokePassed = [{ ...identity, passedAt: nowIso() }, ...prior.filter((entry) => entry?.key !== identity.key)].slice(0, 5);
      });
    }
    return { smokeResult, threw, ms };
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
    const fin = await withWriteLock(root, () => finalizeRebuild({
      root, env, log, run, stateOpts, now, plan: p, prevHead, lease, onAdopted,
    }), finalizeLockOpts);
    if (!fin.ok) {
      if (fin.reason === 'tick-in-progress') {
        log.error?.(`daemon-rebuild: could not take the write lock to finalize ${p.finalSha} after a passing smoke (reader ${fin.heldBy ?? '?'} still ticking) — kept as the ready candidate; the next write-lock holder adopts it without re-smoking`);
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
    return finalize(plan, undefined, undefined, { verdict: 'pass', cached: true, smoke: { results: [] } });
  }
  const a = await smokeSha(plan.finalSha, changedSince(plan.finalSha), null);
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
  if (a.smokeResult.verdict === 'pass') return finalize(plan, undefined, undefined, a.smokeResult);

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
      const b = await smokeSha(planB.finalSha, loadOnly ? null : changedSince(planB.finalSha), 'plain-main');
      const bPassed = !b.worktreeFailed && !b.threw && b.smokeResult?.verdict === 'pass';
      if (bPassed && loadOnly) {
        // Same-run differential, second half: re-smoke A now that plain main passed.
        const a2 = await smokeSha(plan.finalSha, null, 'confirm');
        if (!a2.worktreeFailed && !a2.threw && a2.smokeResult?.verdict === 'pass') {
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
          envLoadAlert({ plainMain: 'passed', confirm: failedA2.map((r) => r.name).join(',') || (a2.worktreeFailed ? `worktree: ${a2.worktreeFailed}` : 'threw') });
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
      alert('fallback-plain-main-failed', {
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
  const c = await smokeSha(prevHead, null, 'last-good');
  const cFailed = c.smokeResult ? failedRows(c.smokeResult) : null;
  const harnessBroken = !!(cFailed && failsSameChecks(failedA, cFailed));
  if (harnessBroken) {
    if (env[HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV] !== '0') {
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
  if (!c.smokeResult) alert('last-good-control-unavailable', { reason: c.worktreeFailed ?? String(c.threw?.message || c.threw) });
  await hold('smoke-rejected', failedA, { controlPassed: !!(c.smokeResult && c.smokeResult.verdict === 'pass') });
  return { moved: false, reason: 'smoke-rejected', plan, alerts: [...prepAlerts, ...alertsList] };
}
