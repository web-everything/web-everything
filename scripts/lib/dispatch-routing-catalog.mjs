/** Independent, IO-free routing catalog shared by policy validation and rotation. */
import { CODEX_EFFORT_MAP, CODEX_MODEL_CATALOGUE } from './codex-model-routing.mjs';

export const ROUTING_MODEL_CATALOG = Object.freeze({
  claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
  // Historical ids remain valid for persisted runs; aliases select the current family.
  antigravity: ['claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-4-argon-high', 'gemini-4-carbon-high'],
  // Card 84 — agy 1.3.0 serves the 5.5 family with the effort baked into the id (`agy models`, 2026-10-06).
  'agy-claude': ['claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
    'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low'],
  'agy-gemini': ['gemini-4-carbon', 'gemini-4-flash', 'gemini-4-hydrogen', 'gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-4-argon-high', 'gemini-4-carbon-high'],
});
export const ROUTING_EFFORTS = { codex: Object.keys(CODEX_EFFORT_MAP), claude: ['low', 'medium', 'high', 'xhigh', 'max'], antigravity: ['low', 'medium', 'high'], 'agy-claude': ['low', 'medium', 'high'], 'agy-gemini': ['low', 'medium', 'high'] };
// Rotation accepts these short identities, but the independent catalog owns entitlement.
const aliases = { codex: { sol: 'gpt-6.1-sol', luna: 'gpt-6-luna' },
  claude: { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5' },
  'agy-gemini': { carbon: 'gemini-4-carbon', flash: 'gemini-4-flash', hydrogen: 'gemini-4-hydrogen' } };
export function routingArmSupported(arm) {
  const provider = ({ openai: 'codex', anthropic: 'claude' })[arm?.provider] ?? arm?.provider;
  const model = aliases[provider]?.[arm?.model] ?? arm?.model;
  return ROUTING_MODEL_CATALOG[provider]?.includes(model) === true &&
    ROUTING_EFFORTS[provider]?.includes(arm?.effort) === true &&
    (provider !== 'codex' || CODEX_MODEL_CATALOGUE[model]?.includes(arm.effort) === true);
}
