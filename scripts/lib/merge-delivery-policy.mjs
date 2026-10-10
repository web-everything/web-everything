/**
 * @file scripts/lib/merge-delivery-policy.mjs
 * @description THE merge-delivery policy (how a ready PR reaches main) resolved through the policy cascade
 *   (agent-memory 151 "policy cascade = team practice"; card x5wnfcg #5600):
 *
 *     1. STANDARD default (Ship Evermore, the delivery protocol) — names the policy, its allowed values and a
 *        safe default: `strategy: 'drain-direct'` (the drain merges itself, exactly today's behaviour).
 *     2. PLATFORM preference (Platform Forever, team level) — `we:scripts/lib/delivery-platform-preferences.json`,
 *        key `mergeDelivery`: the team's chosen practice, shared by every tool. Same home as the existing
 *        `delivery-priority-settings.json` platform layer until Platform Forever has its own store.
 *     3. TOOL / project override (Longshore settings, per repo) — the `mergeDelivery` block of the declared
 *        settings files (`we:scripts/settings/*.json`, merged by `settings-files.mjs`). Only when this project
 *        deliberately differs from the team.
 *
 *   Each KEY resolves independently: the tool layer's value when it is set AND valid, else the platform's, else
 *   the standard default. An invalid value (a typo'd strategy, a batch size of 0) never overrides a lower layer
 *   and never fails the whole policy closed to something unexpected — it is reported in `invalid` and the next
 *   layer down answers. `sources` names which layer set every effective value; callers log it once per pass
 *   (`formatMergeDeliverySourcesLine`).
 *
 *   PURE except `loadMergeDeliveryPolicy` (reads the two files; never throws).
 *
 *   The knobs:
 *     - `strategy`            'drain-direct' | 'github-merge-queue'. github-merge-queue = the drain ENQUEUES a
 *                             ready PR (GraphQL `enqueuePullRequest`) and GitHub's merge queue re-tests and merges;
 *                             the drain's gates move into the required `merge-gate` CI check.
 *     - `batchSize`           GitHub merge-queue group size (max entries to build per group). Suggestion only
 *                             for the ruleset — GitHub reads it from the ruleset, not from here.
 *     - `maxGroupWaitMinutes` GitHub "wait time to meet minimum group size". Ruleset suggestion, same as above.
 *     - `mergeMethod`         'merge' only — the queue's merge method (the drain merges `--merge` too). The
 *                             merge_group gate pins each PR to the SECOND PARENT of its queue merge commit
 *                             (`groupHeadsOf` in merge-gate-check.mjs); a squash or rebase queue leaves no such
 *                             parent, so every PR would fail closed and nothing would ever merge. 'squash' /
 *                             'rebase' are refused (ignored → the standard 'merge') until non-merge-commit
 *                             pinning exists; a test ties every accepted method to a pinnable group head.
 *     - `redMainFreezeBranch` the shared `ops/*` git branch the red-main freeze is PUBLISHED to (card xyd06qo):
 *                             `we:scripts/readiness/red-main-remediation.mjs` freeze/unfreeze writes it next to the
 *                             local marker, and the `merge-gate` check reads it (CI cannot see the drain host's
 *                             marker). Must be `ops/<slug>`. Default `ops/red-main-freeze`.
 *     - `gatePlacement`       { <gate id>: 'merge-gate' | 'drain' | 'both' } — where a merge-time gate runs.
 *                             A placement may only drop the NON-merging side: under drain-direct the drain must
 *                             keep every gate (it is the merger), under github-merge-queue the merge-gate check
 *                             must keep every gate (GitHub is the merger). A placement that would leave the
 *                             merger without a gate is invalid → ignored (never a weakening). Default 'both'.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MERGE_DELIVERY_POLICY = 'mergeDelivery';
export const MERGE_DELIVERY_STRATEGIES = Object.freeze(['drain-direct', 'github-merge-queue']);
export const MERGE_METHODS = Object.freeze(['merge']);
export const GATE_PLACEMENTS = Object.freeze(['merge-gate', 'drain', 'both']);

/** Ship Evermore's declaration: the safe default for every knob. */
export const STANDARD_MERGE_DELIVERY = Object.freeze({
  strategy: 'drain-direct',
  batchSize: 1,
  maxGroupWaitMinutes: 5,
  mergeMethod: 'merge',
  redMainFreezeBranch: 'ops/red-main-freeze',
  gatePlacement: Object.freeze({}),
});

export const PLATFORM_PREFERENCES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'delivery-platform-preferences.json');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;

const VALIDATORS = Object.freeze({
  strategy: (v) => MERGE_DELIVERY_STRATEGIES.includes(v),
  batchSize: intIn(1, 100),
  maxGroupWaitMinutes: intIn(0, 360),
  mergeMethod: (v) => MERGE_METHODS.includes(v),
  // Only an `ops/` transport branch: the writer pushes here, so it must never be able to name `main` or a lane.
  redMainFreezeBranch: (v) => typeof v === 'string' && /^ops\/[a-z0-9][a-z0-9-]{0,63}$/.test(v),
});

/** Does `placement` keep the gate on the side that merges under `strategy`? */
export function placementKeepsMerger(placement, strategy) {
  if (placement === 'both') return true;
  return strategy === 'github-merge-queue' ? placement === 'merge-gate' : placement === 'drain';
}

/**
 * Resolve the policy. Pure.
 * @param {{platform?:object, tool?:object, knownGates?:string[]}} layers  raw `mergeDelivery` blocks
 * @returns {{strategy:string, batchSize:number, maxGroupWaitMinutes:number, mergeMethod:string,
 *   gatePlacement:Object<string,string>, sources:Object<string,string>, invalid:string[]}}
 */
export function resolveMergeDeliveryPolicy({ platform, tool, knownGates = null } = {}) {
  const out = { ...STANDARD_MERGE_DELIVERY, gatePlacement: {} };
  const sources = { strategy: 'standard', batchSize: 'standard', maxGroupWaitMinutes: 'standard', mergeMethod: 'standard', redMainFreezeBranch: 'standard' };
  const invalid = [];
  const layers = [['platform', platform], ['tool', tool]];
  for (const [name, layer] of layers) {
    if (layer === undefined || layer === null) continue;
    if (!isObj(layer)) { invalid.push(`${name}: not an object`); continue; }
    for (const [key, ok] of Object.entries(VALIDATORS)) {
      if (!Object.hasOwn(layer, key)) continue;
      if (!ok(layer[key])) { invalid.push(`${name}.${key}=${JSON.stringify(layer[key])}`); continue; }
      out[key] = layer[key];
      sources[key] = name;
    }
  }
  // Placement is judged against the FINAL strategy, so a tool flip of the strategy re-validates platform placements.
  for (const [name, layer] of layers) {
    if (!isObj(layer) || layer.gatePlacement === undefined) continue;
    if (!isObj(layer.gatePlacement)) { invalid.push(`${name}.gatePlacement: not an object`); continue; }
    for (const [gate, placement] of Object.entries(layer.gatePlacement)) {
      if (Array.isArray(knownGates) && !knownGates.includes(gate)) { invalid.push(`${name}.gatePlacement.${gate}: unknown gate`); continue; }
      if (!GATE_PLACEMENTS.includes(placement)) { invalid.push(`${name}.gatePlacement.${gate}=${JSON.stringify(placement)}`); continue; }
      if (!placementKeepsMerger(placement, out.strategy)) {
        invalid.push(`${name}.gatePlacement.${gate}=${placement}: would leave the merger (${out.strategy}) without this gate`);
        continue;
      }
      out.gatePlacement[gate] = placement;
      sources[`gatePlacement.${gate}`] = name;
    }
  }
  return { ...out, sources, invalid };
}

/** Where a gate runs under the resolved policy (default 'both'). */
export function placementOf(policy, gateId) {
  return policy?.gatePlacement?.[gateId] ?? 'both';
}

/** One log line naming every effective value and the layer that set it. */
export function formatMergeDeliverySourcesLine(policy) {
  const keys = ['strategy', 'batchSize', 'maxGroupWaitMinutes', 'mergeMethod', 'redMainFreezeBranch'];
  const parts = keys.map((k) => `${k}=${policy[k]} (${policy.sources?.[k] ?? 'standard'})`);
  for (const [g, p] of Object.entries(policy.gatePlacement || {})) parts.push(`gatePlacement.${g}=${p} (${policy.sources?.[`gatePlacement.${g}`]})`);
  const bad = policy.invalid?.length ? ` · ignored invalid: ${policy.invalid.join('; ')}` : '';
  return `merge-delivery policy: ${parts.join(', ')}${bad}`;
}

/**
 * IO: read the platform preference file and the tool layer (declared settings' `mergeDelivery` block). Never
 * throws; a missing file is "layer not set", an unreadable one is reported in `invalid` and skipped.
 * @param {{platformPath?:string, toolSettings?:object, readFile?:Function, knownGates?:string[]}} [o]
 */
export function loadMergeDeliveryPolicy({ platformPath = PLATFORM_PREFERENCES_PATH, toolSettings, readFile = readFileSync, knownGates = null } = {}) {
  const readErrors = [];
  let platform;
  try { platform = JSON.parse(readFile(platformPath, 'utf8'))?.[MERGE_DELIVERY_POLICY]; }
  catch (e) { if (e?.code !== 'ENOENT') readErrors.push(`platform file unreadable: ${String(e?.message ?? e).split('\n')[0]}`); }
  const tool = isObj(toolSettings) ? toolSettings[MERGE_DELIVERY_POLICY] : undefined;
  const policy = resolveMergeDeliveryPolicy({ platform, tool, knownGates });
  return { ...policy, invalid: [...readErrors, ...policy.invalid] };
}
