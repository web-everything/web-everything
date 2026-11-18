import { withRuntimeAdmission } from '../../lib/runtime-admission.mjs';
/**
 * @file scripts/operations/dispatch-providers/prepare.mjs
 * @description `#3641` — THE `prepare` LAUNCH KIND'S DISPATCH PROVIDER. One implementation of the same `#3579`
 * provider port `defaultClaudeProvider` implements, answering the same request with the same thing: a durable
 * handle for later liveness polling.
 *
 * Instead of handing a `claude --bg` agent the 242-line `we:skills-src/conveyor/prepare-scope-agent-brief.md`
 * and trusting it to run its own lifecycle (lane-pool acquire, verify-lane request/poll, its own adversarial
 * review subagent, `git commit`, `open-pr`, `learnings-drop`), a prepare dispatch now starts
 * `we:scripts/operations/prepare-scope-run.mjs`, which runs
 * `we:scripts/operations/prepare-scope-wrapper.mjs#prepareScope` — acquire → spawn ONE minimal agent that does
 * only the judgment (predict the touch-set, write `scope:`) → gate (one retry) → check it touched only its own
 * backlog file → commit → open PR → drop learning — mechanically.
 *
 * ── WHY DETACHED ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `#3641`'s own second acceptance clause, and the parent epic `#3383`'s cross-cutting one. `prepareScope`
 * blocks for tens of minutes (one agent turn + a 150-350s gate + `open-pr --mode=label-on-green` waiting on a
 * required check), and the dispatch path it sits on is `we:skills-src/conveyor/runner.mjs`'s
 * `makeCliDispatchPass` — a SYNCHRONOUS `execFileSync` of `run.mjs dispatch-lane --num=<N>` inside the resident
 * runner's own tick. Blocking there would starve the rest of the tick, stop the singleton lease being
 * heartbeated, and make a `run.mjs restart-runner` kill a half-finished prepare: a held lane, an uncommitted
 * `scope:` edit, no PR.
 *
 * So the wrapper runs in its OWN process ({@link PREPARE_SCOPE_RUN_SCRIPT}), detached and unref'd, and this
 * provider returns in milliseconds exactly as the `claude --bg` path did. THE DISPATCH SINK'S CONTRACT IS
 * UNCHANGED: same `inFlight({handle, expectedBy})`, same run-store record, same observer. The only difference
 * is the handle's SHAPE (`pid:<n>`) and therefore which question answers its liveness — `isDispatchHandleLive`
 * owns that, and every reader goes through it.
 *
 * NO `--attempt` FLAG, unlike the `build` provider: a prepare has no retry-attempt letter
 * (`dispatch-lane.mjs#readTick` — "only a fresh `build` dispatch mints a retry-attempt letter"), so passing one
 * would invent a field the dispatcher never emits. Its session slug is `prepare-<num>` on every attempt, which
 * is exactly why `prepareScope` deletes any stale report for that slug before it spawns anything.
 */
import { join } from 'node:path';

import { normNum } from '../../conveyor/queue-store.mjs';
import { notApplied } from '../effect-executor.mjs';
import {
  REPO_ROOT, DETACHED_HANDLE_PREFIX, defaultSpawnDetached, deliveryDispatchLogPath,
} from '../detached-dispatch.mjs';

/** The per-dispatch process {@link prepareScopeDetachedProvider} starts. Resolved by SCRIPT LOCATION, never
 *  cwd — same reason `REPO_ROOT` is. */
export const PREPARE_SCOPE_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'prepare-scope-run.mjs');

/**
 * @param {{sessionSlug?: string, num?: string|number, lane?: string|number, scope?: string, cwd?: string}} request
 * @param {{spawnDetached?: Function, logPathFor?: Function, runScript?: string}} [io]
 * @returns {string} the `pid:<n>` handle.
 */
export function prepareScopeDetachedProvider(request, {
  spawnDetached = defaultSpawnDetached,
  logPathFor = deliveryDispatchLogPath,
  runScript = PREPARE_SCOPE_RUN_SCRIPT,
} = {}) {
  const sessionSlug = String(request?.sessionSlug ?? '').trim();
  const num = normNum(request?.num);
  const lane = String(request?.lane ?? '').trim();
  // REFUSED BEFORE ANY PROCESS EXISTS, and `notApplied` so the entry lands `failed` rather than INDETERMINATE —
  // the same treatment the build provider gives the same missing fields, and for the same reason: nothing was
  // started, so nothing is ambiguous.
  if (!num) throw notApplied('dispatch-lane: refusing a mechanical prepare dispatch with no item id');
  if (!lane) throw notApplied(`dispatch-lane: refusing a mechanical prepare dispatch for #${num} with no lane`);
  if (!sessionSlug) {
    throw notApplied(`dispatch-lane: refusing a mechanical prepare dispatch for #${num} with no session slug`);
  }

  const argv = [
    String(runScript),
    `--num=${num}`,
    `--lane=${lane}`,
    `--session=${sessionSlug}`,
    `--scope=${String(request?.scope ?? '')}`,
  ];
  // #landing-freeze-2779 — forward the request's already-computed gh-App-shim env (fresh-cache PATH override,
  // never a static token) into the wrapper's OWN process env — see `detached-dispatch.mjs#defaultSpawnDetached`'s
  // own docblock for the full incident and mechanism this closes.
  const spawnOptions = { cwd: request?.cwd ?? REPO_ROOT, logPath: logPathFor(sessionSlug), settingsEnv: request?.settingsEnv, card: request };
  const child = withRuntimeAdmission(request, request?.launchKind ?? 'build', () => spawnDetached(argv, spawnOptions));
  if (child?.outcome === 'runtime-refused') return child;
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    // SAME indeterminate shape as an unparseable `claude --bg` confirmation: something may be running and its
    // identity is unknown. Throwing lands the entry `in-flight` with a null handle, which is visible and
    // closable; returning a handle known to be wrong would key every later liveness read on nothing.
    throw new Error(
      `dispatch-lane: started the prepare-scope wrapper for #${num} but node reported no pid — whether it is `
      + 'running cannot be told from here',
    );
  }
  return `${DETACHED_HANDLE_PREFIX}${pid}`;
}
