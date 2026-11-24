/** Configurable repair escalation rungs; launcher availability is supplied by the caller. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeclaredSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { ROUTED_CODEX_MAX_UNPRODUCTIVE } from './fix-slot-borrow.mjs';
import { capacityEligibility } from './provider-capacity.mjs';
import { effectiveBuilder } from './routing-settings.mjs';

const rung = (id, executor, policyRoute) => Object.freeze({ id, executor,
  ...(policyRoute ? { policyRoute: Object.freeze(policyRoute) } : {}) });
export const FIX_EXECUTOR_RUNGS = Object.freeze({
  codex: rung('codex', 'codex', { provider: 'codex' }),
  'codex-alt': rung('codex-alt', 'codex', { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }),
  'agy-claude': rung('agy-claude', 'antigravity', { provider: 'agy-claude', model: 'claude-sonnet-5-5-high' }),
  argon: rung('argon', 'antigravity', { provider: 'antigravity', model: 'gemini-4-argon-high' }),
  claude: rung('claude', 'claude'),
});
const defaults = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../settings/fix-executor.json'), 'utf8'))?.fixExecutor ?? {}; }
  catch { return {}; }
})();
const normalize = value => Array.isArray(value) ? value.map(id => id === 'gemini' ? 'argon' : id) : value;
const valid = value => Array.isArray(value) && value.length > 0 && value.at(-1) === 'claude'
  && new Set(value).size === value.length && value.every(id => typeof id === 'string' && Object.hasOwn(FIX_EXECUTOR_RUNGS, id));
const fallbackSeatMix = Object.freeze(['codex', 'codex-alt', 'gemini', 'claude']);
export const FIX_EXECUTOR_CHAIN_DEFAULT = Object.freeze(normalize(valid(normalize(defaults.fixSeatMix)) ? defaults.fixSeatMix : fallbackSeatMix));
const validCriticalGlobs = value => Array.isArray(value) && value.length > 0
  && value.every(glob => typeof glob === 'string' && !!glob.trim());
// Unavailable policy must still require review: conservatively treat every path as critical.
const fallbackCriticalGlobs = Object.freeze(['**']);
const defaultCriticalGlobs = validCriticalGlobs(defaults.criticalGlobs) ? defaults.criticalGlobs : fallbackCriticalGlobs;
const platformPreferences = () => {
  try { return JSON.parse(readFileSync(new URL('./delivery-platform-preferences.json', import.meta.url), 'utf8')); }
  catch { return {}; }
};
/** Resolve each repair kind independently; a fix-filtered suffix cannot be reused for CI-heal. */
export function resolveRepairExecutorChains(options = {}) {
  return Object.fromEntries(['fix', 'ci-heal'].map(kind => [kind, resolveFixExecutorChain({ ...options, kind })]));
}

/** One invocation-mode resolver for both repair roles; cascade logging includes effective sources. */
export function resolveFixExecutionMode({ env = process.env, platform = platformPreferences(), repo = readDeclaredSettings().settings, kind = 'fix' } = {}) {
  const valid = value => ['direct', 'wrapped'].includes(value);
  const base = cascadePolicy('fixExecutor.executionMode', repo?.fixExecutor?.executionMode, { standard:'direct', platform:platform?.fixExecutor?.executionMode, env, envValues:{'':env.WE_FIX_EXECUTOR_EXECUTION_MODE}, valid });
  const role = cascadePolicy(`fixExecutor.executionModeByRole.${kind}`, repo?.fixExecutor?.executionModeByRole?.[kind], { standard:base.value, platform:platform?.fixExecutor?.executionModeByRole?.[kind], env, valid });
  return { mode:role.value, modeSource:role.sources[''] === 'standard' ? base.sources[''] : role.sources[''] };
}
export function resolveFixCriticalGlobs({ env = process.env, platform = platformPreferences(), repo = readDeclaredSettings().settings } = {}) {
  return cascadePolicy('fixExecutor.criticalGlobs', repo?.fixExecutor?.criticalGlobs, { standard:defaultCriticalGlobs, platform:platform?.fixExecutor?.criticalGlobs, env,
    valid:validCriticalGlobs }).value;
}

export function resolveFixExecutorChain({ env = process.env, platform = platformPreferences(), repo, aiRouting, kind = 'fix', capacity, now = Date.now(), quota, records, record } = {}) {
  // Read through the declared reader so a malformed routing.json surfaces and fails closed to claude.
  const declared = repo === undefined ? readDeclaredSettings() : null;
  if (declared) repo = declared.settings;
  let rawEnv;
  const raw = env?.WE_FIX_EXECUTOR_FALLBACK_CHAIN;
  if (typeof raw === 'string') {
    try { rawEnv = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',').map(id => id.trim()); }
    catch { /* invalid env leaves the previous layer intact */ }
  }
  let result = { value: [...FIX_EXECUTOR_CHAIN_DEFAULT], source: 'default' };
  for (const [source, value] of [['platform', platform?.fixExecutor?.fallbackChain ?? platform?.fixExecutor?.fixSeatMix], ['repo', repo?.fixExecutor?.fallbackChain ?? repo?.fixExecutor?.fixSeatMix], ['aiRouting', aiRouting], ['env', rawEnv]]) {
    if (valid(normalize(value))) result = { value: [...normalize(value)], source };
  }
  // routing.builder=claude (or auto over the quota threshold) drops the codex rungs from every layer, env included.
  // To use Codex again set routing.builder=codex (or WE_ROUTING_BUILDER=codex); a chain alone cannot override it.
  const chosen = effectiveBuilder({ env, ...(declared ? { declared } : { repo }), kind, capacity, now, quota, records, record });
  if (chosen.decision) {
    let winner = chosen.decision.provider === 'agy-gemini' ? 'argon' : chosen.decision.provider;
    const configured = chosen.settings.capacity.providers.find(p => p.id === chosen.decision.provider);
    const rungs = { ...FIX_EXECUTOR_RUNGS };
    // Model/account identifiers are not launcher names. Project a configured
    // winner onto a local rung, retaining the existing escalation suffix.
    if (chosen.decision.reason === 'capacity-score' && configured && !Object.hasOwn(rungs, winner)
      && ['codex', 'claude', 'antigravity'].includes(configured.launcher)) {
      if (configured.launcher === 'claude') winner = 'claude';
      rungs[winner] = rung(winner, configured.launcher, { provider: configured.launcher,
        ...(chosen.decision.model ? { model: chosen.decision.model } : {}),
        ...(configured.effort ? { effort: configured.effort } : {}) });
      result.rungs = { [winner]: rungs[winner] };
      if (!result.value.includes(winner)) {
        const at = result.value.findIndex(id => rungs[id].executor === configured.launcher || id === 'claude');
        result.value.splice(at < 0 ? result.value.length : at, 0, winner);
      }
    }
    // Unknown usage preserves preference, not eligibility: filter every decision.
    // Remove ineligible rungs, then start at the scored winner. A suffix preserves
    // escalation direction and cannot send a Claude-started repair back to Codex.
    const kept = [];
    for (const id of result.value) {
      const provider = result.rungs?.[id] ? configured.id : id === 'argon' ? 'agy-gemini' : id;
      const definition = chosen.settings.capacity.providers.find(p => p.id === provider);
      const observations = chosen.capacities.filter(c => c.provider === provider
        || (provider === 'codex-alt' && c.provider === 'codex' && !chosen.capacities.some(c => c.provider === provider)));
      const eligible = observations.map(c => ({ ...c, ...definition, provider, windows: c.windows, held: c.held,
        active: c.active === false ? false : definition?.active, tier: c.tier ?? definition?.tier,
        allowedKinds: c.allowedKinds ?? definition?.allowedKinds }));
      if (eligible.some(c => capacityEligibility(c, kind, { ...chosen.settings.capacity, now }).eligible)) kept.push(id);
    }
    const start = chosen.decision.reason === 'capacity-score' ? kept.indexOf(winner) : -1;
    result.value = start < 0 ? kept : kept.slice(start);
    result.source += '+capacity';
  }
  if (chosen.builder === 'claude' && (!chosen.decision || chosen.decision.reason === 'all-readers-unknown')) {
    const kept = result.value.filter(id => FIX_EXECUTOR_RUNGS[id].executor !== 'codex');
    result = { value: kept, source: `${result.source}+routing.builder` };
  }
  return { ...result, ...resolveFixExecutionMode({env,platform,repo,kind}), criticalGlobs:resolveFixCriticalGlobs({env,platform,repo}) };
}

export function pickChainRung({ chain = FIX_EXECUTOR_CHAIN_DEFAULT, rungs = {}, trigger = null, codexUnproductive = 0,
  critical = false, launcherAvailable = () => true }) {
  if (!chain.length) return { executor: null, rung: null, reason: 'no eligible capacity; wait for quota reset or clear provider hold', source: 'capacity' };
  const unproductive = codexUnproductive >= ROUTED_CODEX_MAX_UNPRODUCTIVE;
  // Triggers and failure history describe the same progress: take their floor, never add them.
  const progress = Math.max(trigger ? 1 : 0, unproductive ? codexUnproductive - 1 : 0);
  if (unproductive && progress >= chain.length && !chain.includes('claude')) {
    return { executor: null, rung: null, reason: 'unproductive escalation requires Claude; Claude filtered out — wait for quota reset or clear provider hold', source: 'capacity' };
  }
  let index = Math.min(progress, chain.length - 1);
  const prefix = trigger === 'takeover' ? 'takeover round' : trigger === 'ruling-not-addressed' ? 'ruling-not-addressed send-back'
    : unproductive ? `codex unproductive on this head (${codexUnproductive} unproductive runs)`
      : trigger === 'stronger-model' ? 'stronger-model rung' : 'codex-first ordinary repair';
  const definition = id => Object.hasOwn(rungs, id) ? rungs[id] : FIX_EXECUTOR_RUNGS[id];
  const skips = chain.slice(0,index).filter(id=>definition(id).executor === 'antigravity' && !launcherAvailable('antigravity')).map(()=> 'gemini skipped: no admitted fix path');
  while (index < chain.length && chain[index] !== 'claude' && !launcherAvailable(definition(chain[index]).executor)) {
    skips.push(`${chain[index]} launcher unavailable, fallback${chain[index] === 'argon' ? '; gemini skipped: no admitted fix path' : ''}`);
    index++;
  }
  if (index >= chain.length) return { executor: null, rung: null, reason: 'no available executor', source: 'capacity' };
  const selected = definition(chain[index]);
  const reason = `${prefix} → ${selected.id === 'claude' ? 'falls back to Claude (chain exhausted)' : `chain rung ${index + 1}/${chain.length} ${selected.id}`}${skips.length ? `; ${skips.join('; ')}` : ''}`;
  // Claude escalation uses its policy model even when its terminal capacity rung
  // was projected from an alias. Only ordinary work carries that alias's model.
  const policyRoute = selected.executor === 'claude' && progress > 0 ? null : selected.policyRoute;
  return { executor: selected.executor, rung: selected.id, ...(critical ? {requiresReview:true} : {}), ...(policyRoute ? { policyRoute } : {}), reason, source: 'default' };
}
