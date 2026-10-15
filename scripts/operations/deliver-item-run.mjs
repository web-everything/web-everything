#!/usr/bin/env node
/**
 * @file scripts/operations/deliver-item-run.mjs
 * @description `#3645` — ONE DELIVERY, IN ITS OWN PROCESS. The restartable per-dispatch entry point that
 * `we:scripts/operations/dispatch-lane-io.mjs#deliverItemDetachedProvider` spawns DETACHED, and the only
 * production caller of `we:scripts/operations/deliver-item-wrapper.mjs#deliverItem`.
 *
 *   node scripts/operations/deliver-item-run.mjs --num=3645 --lane=2 --session=conveyor-3645 \
 *     --scope='we:scripts/...' --attempt=b [--provider=claude-restricted|codex]
 *
 * `--provider=` (#3580, optional) picks which CLI runs the delivery AGENT — `claude-restricted` by default,
 * `codex` to run it under Codex CLI instead. The flag wins, then the default (#3840: no environment variable
 * selects a provider any more — the per-item `deliveryAgent:` marker, with its required `deliveryAgentReason:`, is
 * the one override, and the dispatcher turns it into this flag); see `selectDeliveryAgentProvider` below, and
 * `we:scripts/operations/codex-delivery-provider.mjs` for what the Codex side actually does.
 *
 * ── WHY THIS FILE EXISTS AT ALL, AND NOT JUST A DIRECT `deliverItem(...)` CALL IN THE SINK ──────────────────
 *
 * THE RESTART-SURVIVAL REQUIREMENT (`we:backlog/3645-*.md` "Done when" clause 2, and the parent epic's own
 * cross-cutting acceptance criterion). `deliverItem` is a BLOCKING arc: its one `provider.spawn` call is an
 * `execFileSync` budgeted at `DELIVERY_AGENT_SPAWN_TIMEOUT_MS` (60 minutes), and the gate + converge steps that
 * follow it block for minutes more. Every other launch kind's dispatch instead fires `claude --bg` and returns
 * in seconds.
 *
 * That difference is load-bearing, because of WHERE a dispatch runs. `we:skills-src/conveyor/runner.mjs`'s
 * `makeCliDispatchPass` shells `run.mjs dispatch-lane --num=<N>` with a SYNCHRONOUS `execFileSync`, once per
 * surfaced item, inside the resident runner's own tick. Calling `deliverItem` inline anywhere under that call
 * would put a 60-minute block inside the runner's tick loop: the singleton lease would go un-heartbeated, every
 * other item this tick would starve, and — the actual acceptance criterion — a `run.mjs restart-runner`
 * (`we:scripts/operations/restart-runner-io.mjs`, landed the same day) would SIGTERM the supervisor, take the
 * runner's whole process tree down with it, and kill a half-finished build mid-flight: a claimed item, a lane
 * lease held by nobody, an unreleased claim, and no PR.
 *
 * SO THE BLOCK MOVES OUT OF THE RUNNER. This script is that separate process. It is spawned `detached: true`
 * (Node calls `setsid`, making it a new session LEADER, so it is not in the runner's process group and a group
 * signal never reaches it), `.unref()`'d, with stdout/stderr redirected to a durable log file — the identical
 * shape `we:scripts/operations/restart-runner-io.mjs#startSupervisor` uses for exactly the same reason, and the
 * one `we:scripts/drain-push-at-close.mjs` documents in full. The dispatch sink therefore still returns in
 * milliseconds, exactly as the `claude --bg` path did, and the delivery outlives any restart of the thing that
 * started it.
 *
 * WHAT THE DISPATCHER KEEPS TO FIND IT AGAIN. The sink records `pid:<pid>` as the effect's durable handle (see
 * `deliverItemDetachedProvider`), which the run store persists exactly as it persisted a `claude --bg` short id.
 * After a restart the guard re-reads that record off disk and answers liveness with a pid probe
 * (`dispatch-lane-io.mjs#isDispatchHandleLive`) instead of a `claude agents` listing — so a restarted runner
 * still sees the in-flight delivery as ALIVE and refuses to double-dispatch it. Nothing about that read depends
 * on the process that wrote it still existing.
 *
 * IT PRINTS ITS RESULT AND EXITS. There is no polling and no callback: the durable evidence a delivery produces
 * is the PR it opens, the delivery report sidecar (`we:scripts/operations/delivery-report-store.mjs`) and this
 * process's own log file. The dispatch observer (`dispatch-lane-io.mjs#createDispatchObservers`) resolves the
 * effect off the merged PR exactly as it already did for the agent path — unchanged by this wiring.
 */
import { parseGroupMembers } from './dispatch-lane.mjs';
import { assertCodexModel } from '../lib/codex-model-routing.mjs';
import { settleDispatchEffect } from './deliver-item-settle.mjs';
import { resolvePolicyEffort } from '../lib/dispatch-routing-policy.mjs';
import { resolveOperationEffort, resolveOperationRoute, resolvePolicyModel, readRoutingPolicy } from '../lib/dispatch-routing-policy-io.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deliverItem, resolveDeliveryAgentProvider, DELIVERY_AGENT_PROVIDER_NAMES,
  DEFAULT_DELIVERY_AGENT_PROVIDER_NAME,
} from './deliver-item-wrapper.mjs';

/** Refused rather than defaulted: a delivery with no item, lane or session has nothing to acquire or claim. */
const REQUIRED_FLAGS = Object.freeze(['num', 'lane', 'session']);

/**
 * PURE. `--k=v` argv → the `launch` shape `deliverItem` takes, refusing a missing required flag by NAME.
 *
 * `attempt` and `scope` are optional: a first attempt has an empty attempt tag (`dispatch-lane.mjs#attemptTagFor`
 * returns `''`), and `scope` rides through to `lane-pool acquire --scope=` where an empty value is legal.
 *
 * @param {string[]} argv
 * `provider` (#3580) is optional too and is parsed, NOT validated, here — this function stays PURE argv→shape;
 * the name check and the env fallback belong to `selectDeliveryAgentProvider` below, which owns both.
 *
 * `--run-id=`/`--effect-key=` (#4349, both optional) identify the run-store effect this exact dispatch is —
 * threaded all the way from `effect-executor.mjs`'s per-sink `ctx` (see `dispatch-lane-io.mjs#createDispatchSinks`
 * and `dispatch-providers/build.mjs#deliverItemDetachedProvider`) so `deliverItem` can settle it on exit. Either
 * absent (an older dispatch, a hand-run CLI invocation) is a clean no-op downstream, never a guess.
 *
 * `--resume` (build-orphan-adopt, #4131/#4382 fix, optional bare flag) — this dispatch is RESUMING an attempt
 * whose own detached wrapper died before it could report anything further; threaded to `deliverItem`'s own
 * `launch.resume`, which `runAgentToCompletion` reads to skip spawning a fresh agent turn entirely (see that
 * function's own docblock). Absent for every ordinary dispatch — unchanged.
 *
 * @returns {{item: string, lane: string, scope: string, sessionSlug: string, attemptTag: string, provider: string,
 *   runId: string, effectKey: string, resume: boolean}}
 */
export function parseDeliverItemRunArgv(argv = []) {
  const flags = {};
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = 'true';
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const missing = REQUIRED_FLAGS.filter((name) => !String(flags[name] ?? '').trim());
  if (missing.length) {
    throw new TypeError(
      `deliver-item-run: missing required flag(s) ${missing.map((m) => `--${m}=`).join(', ')} — `
      + 'a delivery cannot acquire a lane or claim an item without them',
    );
  }
  return {
    item: String(flags.num).trim(),
    lane: String(flags.lane).trim(),
    scope: String(flags.scope ?? '').trim(),
    sessionSlug: String(flags.session).trim(),
    attemptTag: String(flags.attempt ?? '').trim(),
    provider: String(flags.provider ?? '').trim(),
    ...(flags.model ? { model: String(flags.model) } : {}),
    ...(flags.effort ? { effort: String(flags.effort) } : {}),
    runId: String(flags['run-id'] ?? '').trim(),
    effectKey: String(flags['effect-key'] ?? '').trim(),
    ...(flags['group-members'] !== undefined ? { groupMembers: parseGroupMembers(flags['group-members']) } : {}),
    resume: flags.resume === 'true',
  };
}

/**
 * #3580 — WHICH CLI RUNS THE DELIVERY AGENT. An explicit `--provider=` beats the default, and the default is
 * unchanged (`claude-restricted`). Codex is therefore genuinely SELECTABLE but never accidental.
 *
 * #3840 (Fork 5 of #3801): the delivery-agent environment-variable fallback is RETIRED. A process-wide
 * variable applied to every delivery that process launched, with no reason and no per-item scope; the one
 * override is the item's own `deliveryAgent:` marker with a required `deliveryAgentReason:`, which the
 * dispatcher passes here as `--provider=`.
 *
 * An unknown name is refused HERE, before a lane is acquired or an item claimed — a typo that only surfaced
 * at `provider.spawn` would leave a real claim and a real lease held by a delivery that was never going to run.
 *
 * @param {string} flagValue - the parsed `--provider=` value, `''` when absent.
 * @returns {{name: string, provider: object}}
 */
export function selectDeliveryAgentProvider(flagValue) {
  const name = String(flagValue || DEFAULT_DELIVERY_AGENT_PROVIDER_NAME).trim();
  if (!DELIVERY_AGENT_PROVIDER_NAMES.includes(name)) {
    throw new TypeError(
      `deliver-item-run: --provider must be one of ${DELIVERY_AGENT_PROVIDER_NAMES.join('|')}, `
      + `got ${JSON.stringify(name)}`,
    );
  }
  return { name, provider: resolveDeliveryAgentProvider(name) };
}

/**
 * THE CLI, AS A FUNCTION — extracted from the `IS_CLI` block below for the same reason
 * `we:scripts/operations/review-dispatch.mjs#dispatchReviewCli` is: the argv parse, the exit-code mapping and
 * the failure text are all reachable from a test WITHOUT a subprocess and without a real `claude`.
 *
 * EXIT 1 MEANS THE DELIVERY THREW, never that its outcome was disappointing. `deliverItem` returns a `result`
 * string for every outcome it reasons about (`not-ready`, `blocked-mid-build`, `gate-red`, `gate-blocked`,
 * `PR #N`) and releases the lane and claim itself in each; those are exit 0, because the mechanism worked. Only
 * a wrapper-side throw — acquire refused, claim refused, the gate script itself crashed — is a non-zero exit,
 * and the wrapper attempts cleanup only for resources it acquired. This CLI also settles an identified
 * dispatch on preflight/delivery failure; an already-terminal wrapper result is preserved.
 *
 * @param {string[]} argv
 * @param {{deliver?: Function, settle?: Function, write?: Function, writeErr?: Function, selectProvider?: Function}} [io]
 * @returns {Promise<{code: number, result: object|null}>}
 */
export async function runDeliverItemCli(argv = [], {
  deliver = deliverItem,
  settle = settleDispatchEffect,
  write = (line) => process.stdout.write(line),
  writeErr = (line) => process.stderr.write(line),
  selectProvider = selectDeliveryAgentProvider,
  readPolicy = readRoutingPolicy,
} = {}) {
  let launch;
  let selected;
  const settleFailure = (e) => {
    try {
      settle({ runId: launch?.runId, key: launch?.effectKey, status: 'failed',
        error: String(e?.message ?? e), result: { outcome: 'wrapper-threw' } });
    } catch { /* best-effort; retain the original failure */ }
  };
  try {
    launch = parseDeliverItemRunArgv(argv);
    // #3580 — resolved BEFORE the delivery starts, so a bad `--provider=` exits here rather than after a lane
    // and a claim have already been taken (see `selectDeliveryAgentProvider`'s own docblock).
    const policy = readPolicy();
    const configured = launch.provider ? null : resolveOperationRoute({ operation: 'build', available: ['claude', 'codex'], gateClosed: policy.criticalWorkGate.kinds.includes('build'), policy });
    selected = selectProvider(configured ? configured.provider === 'claude' ? 'claude-restricted' : configured.provider : launch.provider);
    const providerName = selected.name === 'claude-restricted' ? 'claude' : selected.name;
    const pin = launch.model ?? configured?.model;
    // Caller-pinned Codex slugs use the shared validator; the older vendor policy catalogue can lag it.
    const model = pin ? providerName === 'codex'
      ? assertCodexModel(Object.hasOwn(policy.aliases?.codex ?? {}, pin) ? policy.aliases.codex[pin] : pin)
      : resolvePolicyModel(providerName, pin, policy) : undefined;
    // resolveOperationRoute fills in a policy effort even when the configured route omitted it.
    // Recover the selected build entry's actual pin so an inferred policy default cannot mask the task route.
    const buildEntry = policy.operations.build ?? policy.operations['*'];
    const configuredEntry = configured && providerName === 'codex'
      ? [buildEntry, ...(buildEntry?.fallback ?? [])].find(entry => entry?.provider === 'codex'
        && resolvePolicyModel('codex', entry.model, policy) === configured.model) : undefined;
    const configuredEffort = providerName === 'codex'
      ? (typeof configuredEntry?.effort === 'string' ? configuredEntry.effort : configuredEntry?.effort?.codex)
      : configured?.effort;
    const effortPin = launch.effort ?? configuredEffort;
    const effort = providerName === 'codex' && effortPin === undefined ? undefined
      : resolvePolicyEffort(providerName, effortPin ?? resolveOperationEffort('build', providerName, undefined, policy));
    launch.effort = effort;
    if (model) launch.model = model;
    const underlying = selected.provider;
    selected = { ...selected, provider: { ...underlying, ...(model ? { model } : {}), effort,
      spawn: request => underlying.spawn({ ...request, ...(providerName === 'codex' ? { taskKind: 'build' } : {}), ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }) } };

  } catch (e) {
    settleFailure(e);
    writeErr(`error: ${String(e?.message ?? e)}\n`);
    return { code: 1, result: null };
  }
  write(
    `deliver-item-run: starting delivery of #${launch.item} in lane ${launch.lane} `
    + `(session ${launch.sessionSlug}, attempt ${launch.attemptTag || '1'}, provider ${selected.name}) `
    + `— pid ${process.pid}\n`,
  );
  try {
    const result = await deliver(launch, selected.provider);
    write(`deliver-item-run: #${launch.item} finished — ${result?.result ?? '(no result reported)'}\n`);
    return { code: 0, result };
  } catch (e) {
    settleFailure(e);
    writeErr(
      `deliver-item-run: #${launch.item} FAILED: `
      + `${String(e?.message ?? e)}\n`,
    );
    return { code: 1, result: null };
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const { code } = await runDeliverItemCli(process.argv.slice(2));
  process.exitCode = code;
}
