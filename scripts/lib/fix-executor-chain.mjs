/** Configurable repair escalation rungs; launcher availability is supplied by the caller. */
import { readFileSync } from 'node:fs';
import { readDeclaredSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { ROUTED_CODEX_MAX_UNPRODUCTIVE } from './fix-slot-borrow.mjs';
import { scoreProvider } from './provider-capacity.mjs';
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
export const FIX_EXECUTOR_CHAIN_DEFAULT = Object.freeze(['codex', 'codex-alt', 'claude']);
const valid = value => Array.isArray(value) && value.length > 0 && value.at(-1) === 'claude'
  && new Set(value).size === value.length && value.every(id => Object.hasOwn(FIX_EXECUTOR_RUNGS, id));
const platformPreferences = () => {
  try { return JSON.parse(readFileSync(new URL('./delivery-platform-preferences.json', import.meta.url), 'utf8')); }
  catch { return {}; }
};
export function resolveFixExecutorChain({ env = process.env, platform = platformPreferences(), repo, aiRouting, capacity, now = Date.now(), quota, records, record } = {}) {
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
  for (const [source, value] of [['platform', platform?.fixExecutor?.fallbackChain], ['repo', repo?.fixExecutor?.fallbackChain], ['aiRouting', aiRouting], ['env', rawEnv]]) {
    if (valid(value)) result = { value: [...value], source };
  }
  // routing.builder=claude (or auto over the quota threshold) drops the codex rungs from every layer, env included.
  // To use Codex again set routing.builder=codex (or WE_ROUTING_BUILDER=codex); a chain alone cannot override it.
  const chosen = effectiveBuilder({ env, ...(declared ? { declared } : { repo }), kind: 'fix', capacity, now, quota, records, record });
  if (chosen.decision && chosen.decision.reason !== 'all-readers-unknown') {
    const first = chosen.builder === 'agy-gemini' ? 'argon' : chosen.builder;
    const ordered = first ? [first, ...result.value.filter(id => id !== first)] : [];
    result.value = ordered.filter(id => {
      const provider = id === 'codex-alt' ? 'codex' : id === 'argon' ? 'agy-gemini' : id;
      const cap = chosen.capacities.find(c => c.provider === provider);
      return cap && !['held', 'exhausted'].includes(scoreProvider(cap, 'fix', { ...chosen.settings.capacity, now }).label);
    });
    result.source += '+capacity';
  } else if (chosen.builder === 'claude' && chosen.decision?.reason !== 'all-readers-unknown') {
    const kept = result.value.filter(id => FIX_EXECUTOR_RUNGS[id].executor !== 'codex');
    result = { value: kept, source: `${result.source}+routing.builder` };
  }
  const rawCritical = env?.WE_FIX_EXECUTOR_CRITICAL_CLAUDE_FROM_RUNG;
  const validCritical = value => Number.isSafeInteger(value) && value >= 1;
  const scalarCritical = value => validCritical(value) ? value : undefined;
  const critical = cascadePolicy('fixExecutor.criticalClaudeFromRung', scalarCritical(repo?.fixExecutor?.criticalClaudeFromRung), {
    standard: 2, platform: scalarCritical(platform?.fixExecutor?.criticalClaudeFromRung) ?? null, env,
    envValues: { '': typeof rawCritical === 'string' && /^\d+$/.test(rawCritical.trim()) ? Number(rawCritical) : undefined },
    valid: validCritical,
  });
  const criticalSource = { standard: 'default', tool: 'repo' }[critical.sources['']] ?? critical.sources[''];
  return { ...result, criticalClaudeFromRung: critical.value, criticalClaudeFromRungSource: criticalSource };
}

export function pickChainRung({ chain = FIX_EXECUTOR_CHAIN_DEFAULT, trigger = null, codexUnproductive = 0,
  critical = false, criticalClaudeFromRung = 2, criticalSource = 'default', launcherAvailable = () => true }) {
  if (!chain.length) return { executor: null, rung: null, reason: 'no eligible capacity; wait for quota reset or clear provider hold', source: 'capacity' };
  const unproductive = codexUnproductive >= ROUTED_CODEX_MAX_UNPRODUCTIVE;
  // Triggers and failure history describe the same progress: take their floor, never add them.
  let index = Math.min(Math.max(trigger ? 1 : 0, unproductive ? codexUnproductive - 1 : 0), chain.length - 1);
  const prefix = trigger === 'takeover' ? 'takeover round' : trigger === 'ruling-not-addressed' ? 'ruling-not-addressed send-back'
    : unproductive ? `codex unproductive on this head (${codexUnproductive} unproductive runs)`
      : trigger === 'stronger-model' ? 'stronger-model rung' : 'codex-first ordinary repair';
  const skips = [];
  while (index < chain.length && chain[index] !== 'claude' && !launcherAvailable(FIX_EXECUTOR_RUNGS[chain[index]].executor)) {
    skips.push(`${chain[index]} launcher unavailable, fallback`);
    index++;
  }
  if (index >= chain.length) return { executor: null, rung: null, reason: 'no available executor', source: 'capacity' };
  if (critical && chain.includes('claude') && index > 0 && (trigger === 'takeover' || trigger === 'ruling-not-addressed')) {
    return { executor: 'claude', rung: 'claude', reason: 'critical work never leaves Claude', source: 'default' };
  }
  if (critical && chain.includes('claude') && index >= criticalClaudeFromRung) return { executor: 'claude', rung: 'claude',
    reason: `critical work reaches Claude from rung ${criticalClaudeFromRung} (criticalClaudeFromRung=${criticalClaudeFromRung}, source=${criticalSource})`, source: 'default' };
  const selected = FIX_EXECUTOR_RUNGS[chain[index]];
  const reason = `${prefix} → ${selected.id === 'claude' ? 'falls back to Claude (chain exhausted)' : `chain rung ${index + 1}/${chain.length} ${selected.id}`}${skips.length ? `; ${skips.join('; ')}` : ''}${critical && selected.id !== 'claude' ? `; critical work stays on ${selected.id} below criticalClaudeFromRung=${criticalClaudeFromRung} (source=${criticalSource})` : ''}`;
  return { executor: selected.executor, rung: selected.id, ...(selected.policyRoute ? { policyRoute: selected.policyRoute } : {}), reason, source: 'default' };
}
