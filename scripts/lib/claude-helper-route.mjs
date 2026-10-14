/** Claude helper defaults share the standard → platform → tool → env cascade. */
import { resolveCascade, platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export const CLAUDE_HELPER_MODEL_DEFAULT = 'claude-sonnet-5-5';
const validModel = model => ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'sonnet', 'haiku', 'opus'].includes(model);

export function resolveClaudeHelperRoute({
  env = process.env, tool = readSettings().claudeHelper,
  platform = platformPreference('claudeHelper', { env }), log,
} = {}) {
  const resolved = resolveCascade({ standard: { model: CLAUDE_HELPER_MODEL_DEFAULT }, platform, tool,
    envValues: { model: env?.WE_CLAUDE_HELPER_MODEL }, valid: { model: validModel } });
  logCascadeSources('claudeHelper', resolved, { env, log: log === false ? () => {} : log });
  return { model: resolved.value.model, sources: resolved.sources };
}
