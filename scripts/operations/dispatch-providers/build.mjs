/**
 * @file scripts/operations/dispatch-providers/build.mjs
 * @description THE `build` LAUNCH KIND'S MECHANICAL DISPATCH PROVIDER (#3645) — and THE TEMPLATE every sibling
 *   kind copies. Moved here VERBATIM from {@link ../dispatch-lane-io.mjs}; not one line of its behaviour
 *   changed in the move.
 *
 * ── THE PORT CONTRACT THIS FILE IMPLEMENTS ──────────────────────────────────────────────────────────────────
 *
 *     (request, io?) => string
 *
 * `request` is the `#3579` dispatch port's request — `{ num, lane, scope, sessionSlug, launchKind, prompt,
 * cwd, ... }`, assembled by {@link ../dispatch-lane-io.mjs#createDispatchSinks} from the effect payload. The
 * return value is a DURABLE HANDLE: a string that a LATER, SEPARATE process — one that never parented the
 * thing it names — can resolve back to a live/gone answer. For every detached provider that handle is
 * `pid:<n>` ({@link ../detached-dispatch.mjs#DETACHED_HANDLE_PREFIX}) and the kernel answers it
 * ({@link ../detached-dispatch.mjs#defaultIsPidAlive}). Durability is the whole contract: the run store
 * persists the handle, and the double-dispatch guard is only as good as a restarted runner's ability to ask
 * about it. Returning a handle that only the dispatching process could have resolved is the one way to break
 * this port while passing every local test.
 *
 * A provider REFUSES rather than guesses. `notApplied` (thrown before any process exists) lands the entry
 * `failed` and it is retried; a plain `throw` after something may have started lands it `in-flight` with a
 * null handle, which is INDETERMINATE and visible under `inFlightEntries().unknown`. Both shapes are used
 * below, and which one is used where is the interesting part of the code.
 *
 * ── REGISTERING A NEW KIND: COPY THIS FILE ──────────────────────────────────────────────────────────────────
 *
 * A sibling kind (`prepare` #3641, `prepare-decision` #3644, `fix` #3640, `ci-heal` #3642) is a new
 * `we:scripts/operations/dispatch-providers/<kind>.mjs` shaped exactly like this one: it imports its
 * primitives from {@link ../detached-dispatch.mjs}, validates the fields its own wrapper needs, builds its
 * argv, spawns detached, and returns the `pid:<n>` handle. Then ONE entry in
 * {@link ../dispatch-provider-registry.mjs}. Nothing in {@link ../dispatch-lane-io.mjs} is touched — which is
 * the point of the registry, because five lanes each adding an `if (kind === ...)` arm to one router all
 * collide on the same handful of lines.
 */

import { normNum } from '../../conveyor/queue-store.mjs';
import { sessionSlugAttemptTag } from '../../conveyor/lease-reaper.mjs';
import { notApplied } from '../effect-executor.mjs';
import {
  DETACHED_HANDLE_PREFIX,
  REPO_ROOT,
  defaultSpawnDetached,
  deliveryDispatchLogPath,
  wrapperExecutorFor,
} from '../detached-dispatch.mjs';
// mechanical-dispatcher (epic #3383) Part 2 — the per-item `deliveryAgent:` frontmatter opt-in. See that
// module's own header for why this is read here (an explicit human marker), never decided by this provider.
import { readItemDeliveryAgentMarker } from '../delivery-agent-marker.mjs';
import { join } from 'node:path';

/** The per-dispatch process `deliverItemDetachedProvider` starts. Resolved by SCRIPT LOCATION, never cwd —
 *  same reason {@link REPO_ROOT} is. */
export const DELIVER_ITEM_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'deliver-item-run.mjs');

/**
 * THE `build` PROVIDER (`#3645`) — one implementation of the SAME `#3579` port {@link defaultClaudeProvider}
 * implements, answering the same request shape with the same thing: a durable handle for later liveness polling.
 *
 * ── WHY DETACHED, WHERE THE REVIEW WRAPPER IS NOT ───────────────────────────────────────────────────────────
 *
 * `review-dispatch.mjs` could call its wrapper INLINE and simply block, because its caller
 * (`we:skills-src/conveyor/runner.mjs`'s review-reconcile pass) was moved onto the heartbeating async spawner in
 * the same change. A BUILD cannot take that trade. `deliverItem`'s single `provider.spawn` is budgeted at 60
 * minutes (`deliver-item-wrapper.mjs#DELIVERY_AGENT_SPAWN_TIMEOUT_MS`) and the gate + converge that follow add
 * more; the dispatch path it sits on is `makeCliDispatchPass`'s SYNCHRONOUS `execFileSync` of
 * `run.mjs dispatch-lane --num=<N>`, once per surfaced item, inside the runner's own tick. Blocking there would
 * starve every other item in the tick, stop the singleton lease being heartbeated, and — the acceptance
 * criterion this item was filed with — make a `restart-runner` kill a half-finished build: a claimed item, a
 * held lane, no PR, no record of how far it got.
 *
 * So the wrapper runs in its OWN process ({@link DELIVER_ITEM_RUN_SCRIPT}), detached and unref'd, and this
 * provider returns in milliseconds exactly as the `claude --bg` path did. THE DISPATCH SINK'S CONTRACT IS
 * UNCHANGED: same `inFlight({handle, expectedBy})`, same run-store record, same observer. The only difference is
 * the handle's SHAPE (`pid:<n>`, see {@link DETACHED_HANDLE_PREFIX}) and therefore which question answers its
 * liveness — {@link isDispatchHandleLive} owns that, and both readers go through it.
 *
 * WHAT A KILLED SINK STILL COSTS, stated rather than papered over: exactly what it cost before. `dispatch: true`
 * means the executor writes `in-flight` BEFORE this runs (#3073), so a sink killed between `spawn` returning and
 * this function returning leaves an entry with a null handle in `inFlightEntries().unknown` — visible, and
 * closable with `resolveInFlight`. That window is not widened here; it is, if anything, shorter, because there
 * is no CLI confirmation line to parse before the handle is known.
 *
 * @param {{sessionSlug?: string, num?: string|number, lane?: string|number, scope?: string, cwd?: string}} request
 * @param {{spawnDetached?: Function, logPathFor?: Function, attemptTagFor?: Function,
 *   readDeliveryAgentMarker?: Function}} [io]
 * @returns {string} the `pid:<n>` handle.
 */
export function deliverItemDetachedProvider(request, {
  spawnDetached = defaultSpawnDetached,
  logPathFor = deliveryDispatchLogPath,
  attemptTagFor = sessionSlugAttemptTag,
  runScript = DELIVER_ITEM_RUN_SCRIPT,
  readDeliveryAgentMarker = readItemDeliveryAgentMarker,
} = {}) {
  const sessionSlug = String(request?.sessionSlug ?? '').trim();
  const num = normNum(request?.num);
  const lane = String(request?.lane ?? '').trim();
  // REFUSED BEFORE ANY PROCESS EXISTS, and `notApplied` so the entry lands `failed` rather than INDETERMINATE —
  // the same treatment `buildAgentArgv` gives an empty prompt, and for the same reason: nothing was started, so
  // nothing is ambiguous. A delivery with no item, lane or session has nothing to acquire or claim.
  if (!num) throw notApplied('dispatch-lane: refusing a mechanical build dispatch with no item id');
  if (!lane) throw notApplied(`dispatch-lane: refusing a mechanical build dispatch for #${num} with no lane`);
  if (!sessionSlug) throw notApplied(`dispatch-lane: refusing a mechanical build dispatch for #${num} with no session slug`);

  // `''` for a first attempt — recovered from the slug rather than added to the effect payload, the SAME way
  // `createDispatchObservers` already recovers it (`sessionSlugAttemptTag`), so no new field crosses the seam.
  const attemptTag = attemptTagFor(sessionSlug) || '';
  const argv = [
    String(runScript),
    `--num=${num}`,
    `--lane=${lane}`,
    `--session=${sessionSlug}`,
    `--scope=${String(request?.scope ?? '')}`,
    `--attempt=${attemptTag}`,
  ];
  // #4349 — forwarded so the detached child can settle its OWN run-store effect on exit
  // (`deliver-item-wrapper.mjs#deliverItem`'s `finish()`/catch, via `deliver-item-settle.mjs`). Omitted
  // entirely when the sink didn't have one to give (an older caller, a hand-built request in a test) — the
  // settle call is a documented no-op without both, never a guess.
  if (request?.groupMembers?.length) argv.push(`--group-members=${request.groupMembers.join(',')}`);
  if (request?.runId) argv.push(`--run-id=${request.runId}`);
  if (request?.effectKey) argv.push(`--effect-key=${request.effectKey}`);
  // mechanical-dispatcher (epic #3383) Part 2 — THE DRIVER'S ONLY provider-selection logic, and it is
  // deliberately not a judgment call: honour item #`num`'s own `deliveryAgent:` frontmatter marker, verbatim,
  // when it has one. No automatic "should this item use Codex" reasoning lives here — see
  // `delivery-agent-marker.mjs`'s own header for why that is a separate, later decision from this plumbing.
  const deliveryAgent = request.policyRoute?.provider ?? readDeliveryAgentMarker(num);
  if (deliveryAgent) argv.push(`--provider=${deliveryAgent === 'claude' ? 'claude-restricted' : deliveryAgent}`);
  if (request.policyRoute?.effort) argv.push(`--effort=${request.policyRoute.effort}`);
  if (request.policyRoute?.model) argv.push(`--model=${request.policyRoute.model}`);
  // build-path-codex-isolation — the run record's ONE executor field comes from here: the vendor this wrapper
  // is actually told to run, never the router's recommendation (see dispatch-lane-io.mjs#dispatchExecutorFor).
  request?.reportExecutor?.(wrapperExecutorFor(deliveryAgent));
  // #landing-freeze-2779 — forward the request's already-computed gh-App-shim env (fresh-cache PATH override,
  // never a static token) into the wrapper's OWN process env, so every child IT later spawns (which all build
  // their env off `process.env`) inherits it too. See `detached-dispatch.mjs#defaultSpawnDetached`'s own
  // docblock for the full incident and mechanism this closes.
  const child = spawnDetached(argv, { cwd: request?.cwd ?? REPO_ROOT, logPath: logPathFor(sessionSlug), settingsEnv: request?.settingsEnv });
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    // SAME indeterminate shape as an unparseable `claude --bg` confirmation: something may be running and its
    // identity is unknown. Throwing lands the entry `in-flight` with a null handle, which is visible and
    // closable; returning a handle known to be wrong would key every later liveness read on nothing.
    throw new Error(
      `dispatch-lane: started the delivery wrapper for #${num} but node reported no pid — whether it is running `
      + 'cannot be told from here',
    );
  }
  return `${DETACHED_HANDLE_PREFIX}${pid}`;
}
