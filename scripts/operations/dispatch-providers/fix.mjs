/**
 * @file scripts/operations/dispatch-providers/fix.mjs
 * @description THE `fix` LAUNCH KIND'S MECHANICAL DISPATCH PROVIDER (#3640) — copied from the template
 *   {@link ./build.mjs} names itself as, with the differences a PR-KEYED repair kind forces stated inline.
 *
 * ── THE PORT CONTRACT ───────────────────────────────────────────────────────────────────────────────────────
 *
 *     (request, io?) => 'pid:<n>'
 *
 * Identical to `build`'s, and read from {@link ./build.mjs}'s own docblock rather than restated: `request` is
 * the `#3579` dispatch port's request assembled by `../dispatch-lane-io.mjs#createDispatchSinks`, and the
 * return value is a DURABLE handle a LATER, SEPARATE process — one that never parented the thing it names —
 * can resolve back to live/gone. The kernel answers it ({@link ../detached-dispatch.mjs#defaultIsPidAlive}),
 * which is what makes a restarted runner's double-dispatch guard hold.
 *
 * NO `process.env` READ ANYWHERE IN HERE. Whether this provider runs at all is the REGISTRY's decision
 * (`WE_FIX_DISPATCH_MODE`, resolved once at sink-construction time by
 * `../dispatch-provider-registry.mjs#dispatchModesFromEnv`); a provider that re-read the environment could
 * disagree with the router that chose it, inside one tick.
 *
 * ── WHAT DIFFERS FROM `build`, AND WHY EACH DIFFERENCE IS REAL ──────────────────────────────────────────────
 *
 *   * THE REQUIRED FIELDS ARE `pr` AND `sessionSlug`, NOT `num` AND `lane`. A repair targets an existing PR;
 *     `dispatch-lane.mjs#sessionSlugFor` keys its session on the PR (`fix-<PR>`) and `BRIEF_REQUIRED_BY_KIND`
 *     lists `PR_NUM`/`LANE_REF` for this kind and no `ITEM_SPEC_PATH`. So `pr` is refused when absent, exactly
 *     as `build` refuses a missing `num`.
 *   * THE PLANNED LANE NUMBER IS DELIBERATELY NOT FORWARDED. `fix-dispatch-wrapper.mjs` acquires its own lane
 *     through the UNNUMBERED `lane-pool.mjs acquire --base=<the PR's headRefName>` path
 *     (`minimal-context-provider.mjs#acquireLane`), because a repair has to land on the bounced PR's own pushed
 *     ref rather than on whatever free clone a tick pre-assigned. Passing `--lane=<N>` would be passing a
 *     number the wrapper cannot honour. (`we:backlog/3542-*.md` tracks the tick-side half of this — that a fix
 *     dispatch consumes a lane number it never uses — and is NOT resolved here.)
 *   * THERE IS NO ATTEMPT TAG. `dispatch-lane.mjs` mints one only for `build` (`attemptTagFor` is called under
 *     `launchKind === 'build'`), because a repair reconstitutes the SAME ref every attempt and has no
 *     retry-attribution problem to solve. `fix-dispatch-wrapper.mjs#dispatchFix` handles the consequence — a
 *     session slug identical across attempts — by deleting any stale report for the slug before it spawns (its
 *     own bug-#xu2pp2m/2 note), which is the existing, tested answer; nothing here needs to add to it.
 *
 * `ci-heal` (#3642) COPIES THIS FILE, not `build.mjs`: it is the other PR-keyed repair kind, it takes the same
 * `pr`/`sessionSlug` fields, and it has the same no-lane-number and no-attempt-tag shape. What it must change
 * is the run script it points at and the one extra field its own wrapper needs (`reason` — already carried on
 * the port request, see `createDispatchSinks`).
 */

import { normNum } from '../../conveyor/queue-store.mjs';
import { notApplied } from '../effect-executor.mjs';
import {
  DETACHED_HANDLE_PREFIX,
  REPO_ROOT,
  defaultSpawnDetached,
  deliveryDispatchLogPath,
  wrapperExecutorFor,
} from '../detached-dispatch.mjs';
// mechanical-dispatcher (epic #3383) Part 2 — see `build.mjs`'s own note; identical use here, keyed on the
// repair's OPTIONAL `num` (the item, when known — see the "ITEM is optional" note below).
import { readItemDeliveryAgentMarker } from '../delivery-agent-marker.mjs';
import { FIX_RUN_EXECUTORS } from '../fix-run.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The per-dispatch process {@link fixDetachedProvider} starts. Resolved by SCRIPT LOCATION, never cwd — same
 *  reason {@link REPO_ROOT} is. */
export const FIX_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'fix-run.mjs');

/** Card 87 follow-up — can a borrowed fix launch on `executor` from this checkout? Claude never needs the run script. */
export function fixLauncherAvailable(executor, { exists = existsSync, runScript = FIX_RUN_SCRIPT } = {}) {
  return executor === 'claude' || (FIX_RUN_EXECUTORS.includes(executor) && exists(runScript));
}

/**
 * THE `fix` PROVIDER (#3640). Spawns {@link FIX_RUN_SCRIPT} detached and unref'd, and returns its `pid:<n>`
 * handle in milliseconds — see that script's own header for why the wrapper's blocking arc must not run inside
 * the runner's synchronous dispatch tick, and why this diverges from #3629's foreground proposal.
 *
 * A PROVIDER REFUSES RATHER THAN GUESSES, and which refusal shape is used where is the interesting part (the
 * rule is `build.mjs`'s, unchanged): `notApplied` is thrown BEFORE any process exists, so the entry lands
 * `failed` and is retried; a plain `throw` AFTER something may have started lands it `in-flight` with a null
 * handle, which is INDETERMINATE, visible under `inFlightEntries().unknown`, and closable with
 * `resolveInFlight`.
 *
 * @param {{sessionSlug?: string, pr?: string|number, num?: string|number, cwd?: string}} request
 * @param {{spawnDetached?: Function, logPathFor?: Function, runScript?: string,
 *   readDeliveryAgentMarker?: Function}} [io]
 * @returns {string} the `pid:<n>` handle.
 */
export function fixDetachedProvider(request, {
  spawnDetached = defaultSpawnDetached,
  logPathFor = deliveryDispatchLogPath,
  runScript = FIX_RUN_SCRIPT,
  readDeliveryAgentMarker = readItemDeliveryAgentMarker,
} = {}) {
  const sessionSlug = String(request?.sessionSlug ?? '').trim();
  const pr = normNum(request?.pr);
  const num = normNum(request?.num);
  // REFUSED BEFORE ANY PROCESS EXISTS — `notApplied`, so the entry lands `failed` rather than INDETERMINATE.
  // Nothing was started, so nothing is ambiguous.
  if (!pr) throw notApplied('dispatch-lane: refusing a mechanical fix dispatch with no PR number');
  if (!sessionSlug) throw notApplied(`dispatch-lane: refusing a mechanical fix dispatch for PR #${pr} with no session slug`);

  const argv = [String(runScript), `--pr=${pr}`, `--session=${sessionSlug}`];
  // The ITEM is optional for a repair (`planFixDispatchWrapper` takes `item: null`, and the brief documents
  // `$FIX_ITEM` as "when known"), so it is passed only when there is one rather than as an empty flag the
  // wrapper would have to re-normalise.
  if (num) argv.push(`--num=${num}`);
  // mechanical-dispatcher (epic #3383) Part 2 — honour the TARGET ITEM's own `deliveryAgent:` marker, when
  // there is a known item to read one from (a repair with no `num` has no backlog card to carry a marker on).
  const deliveryAgent = request.policyRoute?.provider ?? readDeliveryAgentMarker(num);
  if (deliveryAgent) argv.push(`--provider=${deliveryAgent === 'claude' ? 'claude-restricted' : deliveryAgent}`);
  if (request.policyRoute?.effort) argv.push(`--effort=${request.policyRoute.effort}`);
  if (request.policyRoute?.model) argv.push(`--model=${request.policyRoute.model}`);
  // Card 87 follow-up — a BORROWED fix hands its already-filled brief and lane facts to the launcher (see `fix-run.mjs`).
  if (request.promptFile) argv.push(`--prompt-file=${request.promptFile}`);
  if (request.ref) argv.push(`--ref=${request.ref}`);
  if (request.repo) argv.push(`--repo=${request.repo}`);
  if (request.laneRepo) argv.push(`--lane-repo=${request.laneRepo}`);
  if (request.scope) argv.push(`--scope=${request.scope}`);
  // build-path-codex-isolation — the run record's ONE executor field comes from here: the vendor this wrapper
  // is actually told to run, never the router's recommendation (see dispatch-lane-io.mjs#dispatchExecutorFor).
  request?.reportExecutor?.(wrapperExecutorFor(deliveryAgent));

  // #landing-freeze-2779 — forward the request's already-computed gh-App-shim env (fresh-cache PATH override,
  // never a static token) into the wrapper's OWN process env — see `detached-dispatch.mjs#defaultSpawnDetached`'s
  // own docblock for the full incident and mechanism this closes.
  const child = spawnDetached(argv, { cwd: request?.cwd ?? REPO_ROOT, logPath: logPathFor(sessionSlug), settingsEnv: request?.settingsEnv });
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    // SAME indeterminate shape as an unparseable `claude --bg` confirmation: something may be running and its
    // identity is unknown. Returning a handle known to be wrong would key every later liveness read on nothing.
    throw new Error(
      `dispatch-lane: started the fix wrapper for PR #${pr} but node reported no pid — whether it is running `
      + 'cannot be told from here',
    );
  }
  return `${DETACHED_HANDLE_PREFIX}${pid}`;
}
