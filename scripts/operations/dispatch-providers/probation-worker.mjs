/**
 * @file scripts/operations/dispatch-providers/probation-worker.mjs
 * @description THE PROBATION-WORKER DISPATCH PROVIDER (agy-launcher-probation, operator 2026-09-27) — runs an
 *   opened, non-critical task on the probation worker the router picked (Codex, Antigravity-Claude or
 *   Antigravity-Gemini — `we:scripts/lib/provider-routing.mjs#selectProbationWorker`), instead of a
 *   `claude --bg` session. Two launch kinds are wired today: `ci-heal` (repair an existing PR's red CI,
 *   `we:scripts/operations/probation-heal-run.mjs`) and, since #4291, `build` for an opened `doc-fix` taskType
 *   only (build a fresh backlog item to spec, `we:scripts/operations/probation-build-run.mjs`).
 *
 * SAME PORT CONTRACT AS EVERY OTHER PROVIDER — `(request, io?) => 'pid:<n>'`, read from {@link ../dispatch-providers/build.mjs}'s
 * own docblock rather than restated. It spawns the launch kind's own run script ({@link PROBATION_LAUNCHABLE_KINDS})
 * detached and returns its handle in milliseconds; the run script owns the whole arc (see its own header).
 *
 * WHEN IT RUNS. `../dispatch-lane-io.mjs#routeDispatchProvider` hands a request here only when ALL hold:
 *   1. the request carries a `probationWorker` (the router's pick — so the gate was open and the task not critical);
 *   2. the launch kind is in {@link PROBATION_LAUNCHABLE_KINDS} AND the worker's own `taskType` is the ONE
 *      taskType that kind may launch (#4291: `build` launches a `doc-fix` worker only — a `ci-heal` worker
 *      offered under a `build` request, or vice versa, is never launched, only recorded — see
 *      {@link probationLaunchDecision});
 *   3. the repo is WE (both run scripts resolve every tool through WE's own checkout);
 *   4. {@link probationLaunchFromEnv} says `on`.
 * Anything else takes the unchanged path. So the pick is always RECORDED; it is only LAUNCHED where it can run.
 *
 * WHAT IT REPORTS. `request.reportExecutor` (the #2815 `executor` field, a no-op before that lands): `antigravity`
 * or `codex` — the vendor the run script will actually spawn, never a guess.
 */

import { isUnderTest } from '../../lib/under-test.mjs';
import { beginHealAttempt, bindHealAttempt, failHealAttempt } from '../probation-heal-run.mjs';
import { join } from 'node:path';
import { normNum } from '../../conveyor/queue-store.mjs';
import { notApplied } from '../effect-executor.mjs';
import { DETACHED_HANDLE_PREFIX, REPO_ROOT, defaultSpawnDetached, deliveryDispatchLogPath } from '../detached-dispatch.mjs';

/** The per-dispatch process the `ci-heal` kind starts. Resolved by script location, never cwd. */
export const PROBATION_HEAL_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'probation-heal-run.mjs');

/** The per-dispatch process the `build` kind starts, for an opened `doc-fix` taskType only (#4291). */
export const PROBATION_BUILD_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'probation-build-run.mjs');

/**
 * Every launch kind a probation worker can be LAUNCHED for today, keyed to the ONE `taskType` that kind may
 * carry (see the file docblock point 2) and the run script that owns that kind's whole arc. A kind not listed
 * here still RECORDS a `probationWorker` pick (`selectProbationWorker` is unconditional); it just never runs
 * one — the unchanged `claude --bg` path takes it instead.
 */
export const PROBATION_LAUNCHABLE_KINDS = Object.freeze({
  'ci-heal': Object.freeze({ taskType: 'ci-heal', runScript: PROBATION_HEAL_RUN_SCRIPT }),
  'prepare-item': Object.freeze({ taskType: 'prepare', runScript: PROBATION_BUILD_RUN_SCRIPT }),
  build: Object.freeze({ taskType: 'doc-fix', runScript: PROBATION_BUILD_RUN_SCRIPT }),
});

/** The launch kinds a probation worker can be LAUNCHED for today. Kept as its own export — named in
 *  `../dispatch-lane-io.mjs`'s own docblock. */
export const PROBATION_LAUNCH_KINDS = Object.freeze(Object.keys(PROBATION_LAUNCHABLE_KINDS));

/** The env var that turns launching off (`off`) or on (`on`). Read ONCE per sink, like the dispatch modes. */
export const PROBATION_LAUNCH_ENV = 'WE_PROBATION_LAUNCH';

/**
 * `on` or `off`. PURE over `env`. An explicit value wins (anything but `on`/`off` THROWS, the same rule the
 * dispatch-mode knobs follow: a typo must never silently pick a side). Unset means `on` — the operator opened
 * these rows on 2026-09-27 — EXCEPT under the test runner (`VITEST`), where unset means `off`, so no unit test
 * that builds a real sink can start a real detached heal by accident.
 * @param {Record<string, string|undefined>} [env]
 * @returns {'on'|'off'}
 */
export function probationLaunchFromEnv(env = process.env) {
  const raw = String(env?.[PROBATION_LAUNCH_ENV] ?? '').trim().toLowerCase();
  if (!raw) return isUnderTest(env) ? 'off' : 'on';
  if (raw !== 'on' && raw !== 'off') {
    throw new TypeError(`operations: ${PROBATION_LAUNCH_ENV} must be \`on\` or \`off\`, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Should this request go to the probation launcher? PURE.
 * @param {object} request
 * @param {'on'|'off'} launch
 * @returns {{launch: boolean, why: string}}
 */
export function probationLaunchDecision(request, launch) {
  const kind = String(request?.launchKind ?? '');
  const worker = request?.probationWorker;
  if (!worker) return { launch: false, why: 'no probation worker on the request' };
  const entry = PROBATION_LAUNCHABLE_KINDS[kind];
  if (!entry) return { launch: false, why: `kind '${kind}' has no probation launcher yet` };
  // Each kind keeps its original taskType; both existing launchers also enforce the test-fix envelope (#4551).
  if (worker.taskType !== entry.taskType && !(kind !== 'prepare-item' && worker.taskType === 'test-fix')) {
    return { launch: false, why: `kind '${kind}' only launches a '${entry.taskType}' worker, got taskType '${worker.taskType}'` };
  }
  const repo = String(request?.repo ?? 'we');
  if (repo !== 'we') return { launch: false, why: `repo '${repo}' — the probation launcher runs WE '${entry.taskType}' work only` };
  if (launch !== 'on') return { launch: false, why: `${PROBATION_LAUNCH_ENV}=off` };
  return { launch: true, why: `probation worker ${worker.id} (${worker.provider}/${worker.model})` };
}

/**
 * THE PROVIDER. Spawns the launch kind's own run script detached and returns `pid:<n>`. Refuses with
 * `notApplied` BEFORE any process exists when the request cannot be launched (the entry then lands `failed`
 * and is retried), and throws a plain error AFTER a spawn whose pid cannot be read (INDETERMINATE — see
 * `ci-heal.mjs` for the same split).
 *
 * ARGV DIFFERS BY KIND (#4291), because the two run scripts key their work differently: `ci-heal` is PR-keyed
 * (`--pr=`, `--reason=`, an optional `--num=` only for the scorecard), `build` is ITEM-keyed (`--num=` is
 * REQUIRED — a build has no PR yet to key off — plus an optional `--attempt=` retry tag, never a `--reason=`).
 * Both always carry `--session=` and `--worker=`, and both take the same optional `--lane=`/`--scope=`.
 * @param {object} request
 * @param {{spawnDetached?: Function, logPathFor?: Function, runScript?: string}} [io]
 * @returns {string}
 */
export function probationWorkerDetachedProvider(request, {
  spawnDetached = defaultSpawnDetached,
  logPathFor = deliveryDispatchLogPath,
  runScript,
  beginAttempt = beginHealAttempt,
  bindAttempt = bindHealAttempt,
  failAttempt = failHealAttempt,
} = {}) {
  const worker = request?.probationWorker;
  const kind = String(request?.launchKind ?? '');
  const sessionSlug = String(request?.sessionSlug ?? '').trim();
  const num = normNum(request?.num);
  if (!worker?.id || !worker?.provider || !worker?.model) throw notApplied('dispatch-lane: refusing a probation launch with no probation worker');
  if (!sessionSlug) throw notApplied(`dispatch-lane: refusing a probation '${kind}' launch with no session slug`);

  // Exhaustive on purpose (#4291 plan review) — a THIRD kind registered in `PROBATION_LAUNCHABLE_KINDS` later
  // with neither shape would otherwise silently fall into the PR-keyed `ci-heal` branch below (an `else` has no
  // way to say "I don't recognise this"). Every kind this provider actually knows how to argv-build for is
  // named explicitly, and EACH branch resolves its own script off the table directly — never a shared fallback
  // default, so an unrecognised kind can never be mistaken for reading as "defaults to the heal script" (#4291
  // plan review round 2: the earlier single shared fallback made that misreading possible even though it was
  // never reachable).
  let argv;
  if (kind === 'build' || kind === 'prepare-item') {
    if (!num) throw notApplied('dispatch-lane: refusing a probation doc-fix build launch with no item number');
    const script = runScript ?? PROBATION_LAUNCHABLE_KINDS.build.runScript;
    argv = [String(script), `--num=${num}`, `--session=${sessionSlug}`, `--worker=${JSON.stringify(worker)}`];
    const attemptTag = typeof request?.attemptTag === 'string' ? request.attemptTag : '';
    if (attemptTag) argv.push(`--attempt=${attemptTag}`);
  } else if (kind === 'ci-heal') {
    const pr = normNum(request?.pr);
    const reason = String(request?.reason ?? '').trim() || 'red-ci';
    if (!pr) throw notApplied(`dispatch-lane: refusing a probation '${kind}' launch with no PR number`);
    const script = runScript ?? PROBATION_LAUNCHABLE_KINDS['ci-heal'].runScript;
    argv = [String(script), `--pr=${pr}`, `--session=${sessionSlug}`, `--reason=${reason}`, `--worker=${JSON.stringify(worker)}`];
    if (num) argv.push(`--num=${num}`);
  } else {
    throw notApplied(`dispatch-lane: refusing a probation launch for kind '${kind}' — this provider has no argv shape for it`);
  }
  if (['test-fix', 'prepare'].includes(worker.taskType)) argv.push(`--taskType=${worker.taskType}`);
  if (kind === 'prepare-item' && request?.runId && request?.effectKey) {
    argv.push(`--run-id=${request.runId}`, `--effect-key=${request.effectKey}`);
  }
  const lane = Number(request?.lane);
  if (Number.isInteger(lane) && lane > 0) argv.push(`--lane=${lane}`);
  const scope = Array.isArray(request?.scope) ? request.scope.map(String).filter(Boolean) : [];
  if (scope.length) argv.push(`--scope=${scope.join(',')}`);

  let attempt = null;
  if (kind === 'ci-heal') {
    attempt = beginAttempt(request, { logPathFor });
    argv.push(`--heal-attempt=${attempt.attemptId}`);
    request.reportAttempt?.(attempt.attemptId);
  }
  let child;
  try {
    child = spawnDetached(argv, { cwd: request?.cwd ?? REPO_ROOT, logPath: attempt?.logPath ?? logPathFor(sessionSlug), settingsEnv: request?.settingsEnv });
  } catch (error) {
    // A throw here means no wrapper exists, so the row begun above would otherwise stay handle-less and hold the
    // PR's CI-heal forever (#3577 review). Settling is best-effort: it must never mask the launch error itself.
    if (attempt) {
      try { failAttempt(attempt.attemptId, `launch failed before any wrapper started: ${error?.message ?? error}`); } catch { /* the original error wins */ }
    }
    throw error;
  }
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    const subject = kind === 'build' ? `#${num}` : `PR #${normNum(request?.pr)}`;
    throw new Error(`dispatch-lane: started the probation '${kind}' launch for ${subject} but node reported no pid — whether it is running cannot be told from here`);
  }
  if (attempt) bindAttempt(attempt.attemptId, `${DETACHED_HANDLE_PREFIX}${pid}`);
  // #2815's one `executor` field — the vendor the run script spawns. A no-op until that field lands.
  request?.reportExecutor?.(worker.executor);
  request?.reportModel?.(worker.model);
  return `${DETACHED_HANDLE_PREFIX}${pid}`;
}
