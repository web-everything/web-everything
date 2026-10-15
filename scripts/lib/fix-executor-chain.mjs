/** Configurable repair escalation rungs; launcher availability is supplied by the caller. */
import { readFileSync } from 'node:fs';
import { readSettings } from './settings-files.mjs';
import { ROUTED_CODEX_MAX_UNPRODUCTIVE } from './fix-slot-borrow.mjs';

const rung = (id, executor, policyRoute) => Object.freeze({ id, executor,
  ...(policyRoute ? { policyRoute: Object.freeze(policyRoute) } : {}) });
export const FIX_EXECUTOR_RUNGS = Object.freeze({
  codex: rung('codex', 'codex', { provider: 'codex' }),
  'codex-alt': rung('codex-alt', 'codex', { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }),
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
export function resolveFixExecutorChain({ env = process.env, platform = platformPreferences(), repo = readSettings() } = {}) {
  let rawEnv;
  const raw = env?.WE_FIX_EXECUTOR_FALLBACK_CHAIN;
  if (typeof raw === 'string') {
    try { rawEnv = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',').map(id => id.trim()); }
    catch { /* invalid env leaves the previous layer intact */ }
  }
  let result = { value: [...FIX_EXECUTOR_CHAIN_DEFAULT], source: 'default' };
  for (const [source, value] of [['platform', platform?.fixExecutor?.fallbackChain], ['repo', repo?.fixExecutor?.fallbackChain], ['env', rawEnv]]) {
    if (valid(value)) result = { value: [...value], source };
  }
  return result;
}

export function pickChainRung({ chain = FIX_EXECUTOR_CHAIN_DEFAULT, trigger = null, codexUnproductive = 0,
  critical = false, launcherAvailable = () => true }) {
  const unproductive = codexUnproductive >= ROUTED_CODEX_MAX_UNPRODUCTIVE;
  // Triggers and failure history describe the same progress: take their floor, never add them.
  let index = Math.min(Math.max(trigger ? 1 : 0, unproductive ? codexUnproductive - 1 : 0), chain.length - 1);
  const prefix = trigger === 'takeover' ? 'takeover round' : trigger === 'ruling-not-addressed' ? 'ruling-not-addressed send-back'
    : unproductive ? `codex unproductive on this head (${codexUnproductive} unproductive runs)`
      : trigger === 'stronger-model' ? 'stronger-model rung' : 'codex-first ordinary repair';
  const skips = [];
  while (chain[index] !== 'claude' && !launcherAvailable(FIX_EXECUTOR_RUNGS[chain[index]].executor)) {
    skips.push(`${chain[index]} launcher unavailable, fallback`);
    index++;
  }
  if (critical && index > 0) return { executor: 'claude', rung: 'claude', reason: 'critical work never leaves Claude', source: 'default' };
  const selected = FIX_EXECUTOR_RUNGS[chain[index]];
  const reason = `${prefix} → ${selected.id === 'claude' ? 'falls back to Claude (chain exhausted)' : `chain rung ${index + 1}/${chain.length} ${selected.id}`}${skips.length ? `; ${skips.join('; ')}` : ''}`;
  return { executor: selected.executor, rung: selected.id, ...(selected.policyRoute ? { policyRoute: selected.policyRoute } : {}), reason, source: 'default' };
}
