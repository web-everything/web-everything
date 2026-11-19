import { withRuntimeAdmission } from '../../lib/runtime-admission.mjs';
/**
 * @file scripts/operations/dispatch-providers/ci-heal.mjs
 * @description THE `ci-heal` LAUNCH KIND'S MECHANICAL DISPATCH PROVIDER (#3642) — copied from
 *   {@link ./fix.mjs}, NOT from {@link ./build.mjs}, because `ci-heal` is the OTHER PR-keyed repair kind:
 *   same `pr`/`sessionSlug` required fields, same no-lane-number shape, same no-attempt-tag shape. That file
 *   names this one as its copier and lists exactly what must change; this is that change.
 *
 * ── THE PORT CONTRACT ───────────────────────────────────────────────────────────────────────────────────────
 *
 *     (request, io?) => 'pid:<n>'
 *
 * Identical to `fix`'s and `build`'s, and read from {@link ./build.mjs}'s own docblock rather than restated:
 * `request` is the `#3579` dispatch port's request assembled by `../dispatch-lane-io.mjs#createDispatchSinks`,
 * and the return value is a DURABLE handle a LATER, SEPARATE process — one that never parented the thing it
 * names — can resolve back to live/gone. The kernel answers it
 * ({@link ../detached-dispatch.mjs#defaultIsPidAlive}), which is what makes a restarted runner's
 * double-dispatch guard hold.
 *
 * NO `process.env` READ ANYWHERE IN HERE. Whether this provider runs at all is the REGISTRY's decision
 * (`WE_CI_HEAL_DISPATCH_MODE`, resolved once at sink-construction time by
 * `../dispatch-provider-registry.mjs#dispatchModesFromEnv`); a provider that re-read the environment could
 * disagree with the router that chose it, inside one tick.
 *
 * ── THE ONE THING THIS FORWARDS THAT `fix` DOES NOT ─────────────────────────────────────────────────────────
 *
 * `--reason`. `dispatch-lane.mjs#BRIEF_REQUIRED_BY_KIND['ci-heal']` is the only kind whose brief requires a
 * `REASON` (`red-ci` — a required check went red after open — or `behind` — BEHIND `main` and parked), and
 * the durable comment the wrapper posts branches on it
 * (`we:scripts/conveyor/ci-heal-mark.mjs#buildCiHealComment`). It is ALREADY on the port request: #3640
 * forwarded `pr` AND `reason` onto it together, specifically so this item would add a registry ROW and a
 * provider and change nothing in the io shell. Passed only when there is one, rather than as an empty flag
 * the wrapper would have to re-normalise — the same rule `fix.mjs` applies to its optional `--num`.
 *
 * Everything else is `fix.mjs`'s, unchanged: `pr` and `sessionSlug` are refused when absent (a repair targets
 * an existing PR and keys its report by slug), the planned LANE NUMBER is deliberately NOT forwarded (the
 * wrapper acquires its own lane through the UNNUMBERED `lane-pool.mjs acquire --base=<the PR's headRefName>`
 * path, so a pre-assigned number is one it cannot honour — `we:backlog/3542-*.md` tracks the tick-side half),
 * and there is NO attempt tag (`dispatch-lane.mjs#attemptTagFor` is called under `launchKind === 'build'`
 * only, because a repair reconstitutes the SAME ref every attempt).
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
// heal's OPTIONAL `num` (the item, when known), same as `fix.mjs`.
import { readItemDeliveryAgentMarker } from '../delivery-agent-marker.mjs';
import { join } from 'node:path';

/** The per-dispatch process {@link ciHealDetachedProvider} starts. Resolved by SCRIPT LOCATION, never cwd —
 *  same reason {@link REPO_ROOT} is. */
export const CI_HEAL_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'ci-heal-run.mjs');

/**
 * THE `ci-heal` PROVIDER (#3642). Spawns {@link CI_HEAL_RUN_SCRIPT} detached and unref'd, and returns its
 * `pid:<n>` handle in milliseconds — see that script's own header for why the wrapper's blocking arc must not
 * run inside the runner's synchronous dispatch tick.
 *
 * A PROVIDER REFUSES RATHER THAN GUESSES, and which refusal shape is used where is the interesting part (the
 * rule is `build.mjs`'s, unchanged): `notApplied` is thrown BEFORE any process exists, so the entry lands
 * `failed` and is retried; a plain `throw` AFTER something may have started lands it `in-flight` with a null
 * handle, which is INDETERMINATE, visible under `inFlightEntries().unknown`, and closable with
 * `resolveInFlight`.
 *
 * @param {{sessionSlug?: string, pr?: string|number, num?: string|number, reason?: string|null, cwd?: string}} request
 * @param {{spawnDetached?: Function, logPathFor?: Function, runScript?: string,
 *   readDeliveryAgentMarker?: Function}} [io]
 * @returns {string} the `pid:<n>` handle.
 */
export function ciHealDetachedProvider(request, {
  spawnDetached = defaultSpawnDetached,
  logPathFor = deliveryDispatchLogPath,
  runScript = CI_HEAL_RUN_SCRIPT,
  readDeliveryAgentMarker = readItemDeliveryAgentMarker,
} = {}) {
  const sessionSlug = String(request?.sessionSlug ?? '').trim();
  const pr = normNum(request?.pr);
  const num = normNum(request?.num);
  const reason = String(request?.reason ?? '').trim();
  // REFUSED BEFORE ANY PROCESS EXISTS — `notApplied`, so the entry lands `failed` rather than INDETERMINATE.
  if (!pr) throw notApplied('dispatch-lane: refusing a mechanical ci-heal dispatch with no PR number');
  if (!sessionSlug) throw notApplied(`dispatch-lane: refusing a mechanical ci-heal dispatch for PR #${pr} with no session slug`);

  const argv = [String(runScript), `--pr=${pr}`, `--session=${sessionSlug}`];
  if (num) argv.push(`--num=${num}`);
  if (reason) argv.push(`--reason=${reason}`);
  // mechanical-dispatcher (epic #3383) Part 2 — honour the TARGET ITEM's own `deliveryAgent:` marker, when
  // there is a known item to read one from.
  const deliveryAgent = request.policyRoute?.provider ?? readDeliveryAgentMarker(num);
  if (deliveryAgent) argv.push(`--provider=${deliveryAgent === 'claude' ? 'claude-restricted' : deliveryAgent}`);
  if (request.policyRoute?.effort) argv.push(`--effort=${request.policyRoute.effort}`);
  if (request.policyRoute?.model) argv.push(`--model=${request.policyRoute.model}`);
  // build-path-codex-isolation — the run record's ONE executor field comes from here: the vendor this wrapper
  // is actually told to run, never the router's recommendation (see dispatch-lane-io.mjs#dispatchExecutorFor).
  request?.reportExecutor?.(wrapperExecutorFor(deliveryAgent));

  // #landing-freeze-2779 (the live incident this closes — ci-heal-2779, 2026-09-26 ~20:55 ET: "the GitHub
  // token (GH_TOKEN) stopped working partway through, so I couldn't post the CI-heal tally comment (HTTP
  // 401)") — forward the request's already-computed gh-App-shim env (fresh-cache PATH override, never a
  // static token) into the wrapper's OWN process env, so a long-lived ci-heal wrapper (and whatever it later
  // spawns) never falls back to a static, expiring `GH_TOKEN` inherited from whoever dispatched it. See
  // `detached-dispatch.mjs#defaultSpawnDetached`'s own docblock for the full mechanism.
  const spawnOptions = { cwd: request?.cwd ?? REPO_ROOT, logPath: logPathFor(sessionSlug), settingsEnv: request?.settingsEnv, card: request };
  const child = withRuntimeAdmission(request, request?.launchKind ?? 'build', () => spawnDetached(argv, spawnOptions));
  if (child?.outcome === 'runtime-refused') return child;
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    // SAME indeterminate shape as an unparseable `claude --bg` confirmation: something may be running and its
    // identity is unknown. Returning a handle known to be wrong would key every later liveness read on
    // nothing.
    throw new Error(
      `dispatch-lane: started the ci-heal wrapper for PR #${pr} but node reported no pid — whether it is `
      + 'running cannot be told from here',
    );
  }
  return `${DETACHED_HANDLE_PREFIX}${pid}`;
}
