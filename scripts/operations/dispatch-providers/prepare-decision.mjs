import { withRuntimeAdmission } from '../../lib/runtime-admission.mjs';
/**
 * @file scripts/operations/dispatch-providers/prepare-decision.mjs
 * @description THE `prepare-decision` LAUNCH KIND'S MECHANICAL DISPATCH PROVIDER (#3644). Copied from
 *   {@link ./build.mjs}, the template the registry's own "REGISTERING A NEW KIND" section points every sibling
 *   kind at — same port, same detached primitives, same durable handle shape.
 *
 * ── THE PORT CONTRACT THIS FILE IMPLEMENTS ──────────────────────────────────────────────────────────────────
 *
 *     (request, io) => 'pid:<n>'
 *
 * `request` is the `#3579` dispatch port's request — `{ num, lane, scope, sessionSlug, launchKind, prompt,
 * cwd, ... }`, assembled by {@link ../dispatch-lane-io.mjs#createDispatchSinks} from the effect payload. The
 * return value is a DURABLE HANDLE: a string a LATER, SEPARATE process — one that never parented the thing it
 * names — can resolve back to a live/gone answer. Here that is `pid:<n>`
 * ({@link ../detached-dispatch.mjs#DETACHED_HANDLE_PREFIX}), and the KERNEL answers it
 * ({@link ../detached-dispatch.mjs#defaultIsPidAlive}). Durability is the whole contract: the run store
 * persists the handle, and the double-dispatch guard is only as good as a RESTARTED runner's ability to ask
 * about it — which is this item's own acceptance clause, not a nicety.
 *
 * NO `process.env` READ ANYWHERE IN THIS FILE, deliberately. The REGISTRY owns mode selection: the operator's
 * opt-out (`WE_PREPARE_DECISION_DISPATCH_MODE`) is DECLARED as this kind's `modeEnv` in
 * {@link ../dispatch-provider-registry.mjs} and resolved ONCE, at sink-construction time, by
 * `dispatchModesFromEnv`. A provider that read the environment itself would be a second, per-dispatch read of
 * the same knob — exactly the thing `dispatchModesFromEnv`'s docblock exists to prevent (one tick must not be
 * able to straddle two modes), and it would make the registry's declaration a decoration rather than the
 * source of truth. By the time this function runs, the mode question is already settled.
 *
 * A PROVIDER REFUSES RATHER THAN GUESSES, in the two shapes {@link ./build.mjs} establishes: `notApplied`
 * (thrown BEFORE any process exists) lands the entry `failed` and it is retried; a plain `throw` after
 * something may have started lands it `in-flight` with a null handle, which is INDETERMINATE and visible under
 * `inFlightEntries().unknown`. Both appear below, and which is used where is the interesting part.
 */

import { normNum } from '../../conveyor/queue-store.mjs';
import { sessionSlugAttemptTag } from '../../conveyor/lease-reaper.mjs';
import { notApplied } from '../effect-executor.mjs';
import {
  DETACHED_HANDLE_PREFIX,
  REPO_ROOT,
  defaultSpawnDetached,
  deliveryDispatchLogPath,
} from '../detached-dispatch.mjs';
import { join } from 'node:path';

/** The per-dispatch process {@link prepareDecisionDetachedProvider} starts. Resolved by SCRIPT LOCATION,
 *  never cwd — same reason {@link REPO_ROOT} is. */
export const PREPARE_DECISION_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'prepare-decision-run.mjs');

/**
 * THE `prepare-decision` PROVIDER (#3644) — one implementation of the SAME `#3579` port
 * `dispatch-lane-io.mjs#defaultClaudeProvider` implements, answering the same request with the same thing: a
 * durable handle for later liveness polling.
 *
 * ── WHY DETACHED ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `we:scripts/operations/prepare-decision-wrapper.mjs#prepareDecision` blocks for up to an hour on its single
 * agent spawn and for minutes more on the gate and the converge loop, and the dispatch path it sits on is
 * `runner.mjs#makeCliDispatchPass`'s SYNCHRONOUS `execFileSync` of `run.mjs dispatch-lane --num=<N>`, once per
 * surfaced item, inside the resident runner's OWN TICK. Blocking there would starve every other item in the
 * tick, stop the singleton lease being heartbeated, and make `run.mjs restart-runner` kill a half-finished
 * prepare — a held decision, a lane lease nobody owns, no PR, and a decision left half-authored.
 *
 * So the wrapper runs in its own process ({@link PREPARE_DECISION_RUN_SCRIPT}), detached and unref'd, and this
 * provider returns in milliseconds exactly as the `claude --bg` path did. THE DISPATCH SINK'S CONTRACT IS
 * UNCHANGED: same `inFlight({handle, expectedBy})`, same run-store record, same observer. The only difference
 * is the handle's SHAPE (`pid:<n>`) and therefore which question answers its liveness — `isDispatchHandleLive`
 * owns that, and both readers go through it.
 *
 * WHAT A KILLED SINK STILL COSTS, stated rather than papered over: exactly what it cost before. `dispatch:
 * true` means the executor writes `in-flight` BEFORE this runs (#3073), so a sink killed between `spawn`
 * returning and this function returning leaves an entry with a null handle in `inFlightEntries().unknown` —
 * visible, and closable with `resolveInFlight`.
 *
 * @param {{sessionSlug?: string, num?: string|number, lane?: string|number, scope?: string, cwd?: string}} request
 * @param {{spawnDetached?: Function, logPathFor?: Function, attemptTagFor?: Function, runScript?: string}} [io]
 * @returns {string} the `pid:<n>` handle.
 */
export function prepareDecisionDetachedProvider(request, {
  spawnDetached = defaultSpawnDetached,
  logPathFor = deliveryDispatchLogPath,
  attemptTagFor = sessionSlugAttemptTag,
  runScript = PREPARE_DECISION_RUN_SCRIPT,
} = {}) {
  const sessionSlug = String(request?.sessionSlug ?? '').trim();
  const num = normNum(request?.num);
  const lane = String(request?.lane ?? '').trim();
  // REFUSED BEFORE ANY PROCESS EXISTS, and `notApplied` so the entry lands `failed` rather than INDETERMINATE:
  // nothing was started, so nothing is ambiguous. A prepare with no decision, lane or session has nothing to
  // acquire or hold.
  if (!num) throw notApplied('dispatch-lane: refusing a mechanical prepare-decision dispatch with no item id');
  if (!lane) throw notApplied(`dispatch-lane: refusing a mechanical prepare-decision dispatch for #${num} with no lane`);
  if (!sessionSlug) throw notApplied(`dispatch-lane: refusing a mechanical prepare-decision dispatch for #${num} with no session slug`);

  // `''` for a first attempt — recovered from the slug rather than added to the effect payload, the SAME way
  // `createDispatchObservers` already recovers it, so no new field crosses the seam.
  const attemptTag = attemptTagFor(sessionSlug) || '';
  const argv = [
    String(runScript),
    `--num=${num}`,
    `--lane=${lane}`,
    `--session=${sessionSlug}`,
    `--scope=${String(request?.scope ?? '')}`,
    `--attempt=${attemptTag}`,
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
      `dispatch-lane: started the prepare-decision wrapper for #${num} but node reported no pid — whether it is `
      + 'running cannot be told from here',
    );
  }
  return `${DETACHED_HANDLE_PREFIX}${pid}`;
}
