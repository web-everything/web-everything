/**
 * @file scripts/conveyor/fixer-ladder.mjs
 * @description The IO edge of the fixer-escalation ladder (`we:scripts/lib/fixer-escalation-policy.mjs`): read the
 *   local override, resolve each rung's MODEL through the existing routing policy, and answer which rungs can run
 *   right now. Nothing here picks a model by hand: a rung names a routing-policy task type and gets whatever the
 *   routing policy (and its critical-work gate) says; a rung whose route is not the provider it needs, or whose
 *   provider has no wired fix launcher, is unavailable and the ladder skips FORWARD.
 *
 * `externalFixProviders`: providers other than Claude that have a wired launcher for a `fix` dispatch from
 * `reconcile-fix-dispatch.mjs`. Empty today (the fix dispatch spawns `claude --bg`; the Codex fix wrapper is
 * reached through the dispatch-lane sink only), so the cross-provider rung is configured but dormant and the
 * ladder goes resend -> stronger model -> operator. Wiring a provider in is one entry here, not a policy change.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FIXER_ESCALATION, humanAtMisses, resolveFixerEscalation } from '../lib/fixer-escalation-policy.mjs';
import { readRoutingPolicy, resolveOperationRoute } from '../lib/dispatch-routing-policy-io.mjs';

export const FIXER_ESCALATION_CONFIG_PATH = process.env.FIXER_ESCALATION_CONFIG
  || join(homedir(), 'workspace/.operations/fixer-escalation.json');
export const EXTERNAL_FIX_PROVIDERS = Object.freeze(new Set());

/** Read the override: `null` when absent, `{ error }` when unreadable or not JSON (the default then stands). */
export function readFixerEscalationOverride({ path = FIXER_ESCALATION_CONFIG_PATH, read = readFileSync } = {}) {
  let text;
  try { text = read(path, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { override: null } : { override: null, error: `unreadable: ${e.message}` }; }
  try { return { override: JSON.parse(text) }; } catch (e) { return { override: null, error: `not JSON: ${e.message}` }; }
}

/**
 * @returns {{policy:object, error:?string, routes:Record<string,?object>, available:(rung:object)=>boolean, humanAt:number}}
 *   `routes[rungId]` is the routing-policy route (`{provider, model, effort}`) a dispatch rung resolves to, or null
 *   (the ordinary `fix` route: no model override).
 */
export function loadFixerLadder({
  path, read, routingPolicy = readRoutingPolicy(), externalFixProviders = EXTERNAL_FIX_PROVIDERS,
  override, // injectable: skip the file
} = {}) {
  const fromFile = override === undefined ? readFixerEscalationOverride({ path, read }) : { override };
  const { policy, error } = resolveFixerEscalation(fromFile.override, DEFAULT_FIXER_ESCALATION);
  const gateClosed = routingPolicy.criticalWorkGate.kinds.includes('fix');
  const providers = ['claude', ...externalFixProviders];
  const routes = {};
  for (const rung of policy.rungs) {
    if (rung.action !== 'dispatch') continue;
    if (!rung.taskType) { routes[rung.id] = null; continue; }
    try { routes[rung.id] = resolveOperationRoute({ operation: 'fix', taskType: rung.taskType, available: providers, gateClosed, policy: routingPolicy }); }
    catch { routes[rung.id] = undefined; } // no route at all: unavailable
  }
  const available = (rung) => rung.action !== 'dispatch' || (!rung.taskType
    ? true : routes[rung.id] != null && routes[rung.id].provider === rung.provider);
  return { policy, error: error ?? fromFile.error ?? null, routes, available, humanAt: humanAtMisses(policy, { available }) };
}
