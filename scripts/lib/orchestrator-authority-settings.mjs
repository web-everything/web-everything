/** Explicit authority grants: platform policy takes precedence over repo policy. */
import { resolveCascade, readPlatformPreferences, logCascadeSources, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath } from './policy-cascade.mjs';
import { readFileSync } from 'node:fs';
import { readSettingsChecked } from './settings-files.mjs';

// Validate raw evidence before the shared, lenient reader collapses duplicate keys. Keep this
// authority-specific: other platform policies retain their existing preference semantics.
function checkPlatformAuthorityJson(text) {
  JSON.parse(text); // Only scan valid JSON; string punctuation is never container syntax.
  const containers = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') containers.push(new Set());
    else if (char === '[') containers.push(null);
    else if (char === '}' || char === ']') containers.pop();
    else if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] !== ':') continue;
      const key = JSON.parse(text.slice(start, i + 1));
      const keys = containers.at(-1);
      if (keys.has(key)) throw new Error('ambiguous platform authority: duplicate JSON key');
      keys.add(key);
    }
  }
}

export function resolveOrchestratorAuthority({ env = process.env, platform, tool, readFile = readFileSync, log } = {}) {
  const checked = tool === undefined ? readSettingsChecked({ namespace: 'authority' }) : null;
  if (checked) tool = { authority: checked.value };
  const requiredPlatformPaths = new Set([PLATFORM_PREFERENCES_PATH, operatorPreferencesPath({})]);
  let requiredPlatformMissing = false;
  const preferences = platform === undefined ? readPlatformPreferences({
    // Authority must always consult the default platform files, including operator revocations.
    env: {},
    readFile: (path, encoding) => {
      try {
        const text = String(readFile(path, encoding));
        checkPlatformAuthorityJson(text);
        return text;
      } catch (error) {
        // Legacy migration files may be absent; current authority evidence may not.
        if (error?.code === 'ENOENT' && requiredPlatformPaths.has(path)) requiredPlatformMissing = true;
        throw error;
      }
    },
  }) : null;
  const team = platform === undefined
    ? requiredPlatformMissing || preferences.errors.length ? { authority: { redMainQuarantine: false } } : preferences.prefs.orchestrator
    : platform;
  // Invalid grants must revoke authority rather than fall through to a lower true value.
  const grant = block => {
    if (block === undefined || (block && typeof block === 'object' && !Array.isArray(block) && block.authority === undefined)) return undefined;
    const authority = block?.authority;
    if (authority && typeof authority === 'object' && !Array.isArray(authority) && authority.redMainQuarantine === undefined) return undefined;
    return { redMainQuarantine: authority?.redMainQuarantine === true };
  };
  // resolveCascade's last configured layer wins. Authority deliberately puts platform above repo.
  const resolved = resolveCascade({ standard: { redMainQuarantine: false },
    platform: grant(tool), tool: grant(team), valid: { redMainQuarantine: v => typeof v === 'boolean' } });
  resolved.sources.redMainQuarantine = ({ platform: 'tool', tool: 'platform' })[resolved.sources.redMainQuarantine]
    ?? resolved.sources.redMainQuarantine;
  const authority = tool?.authority;
  const invalidTool = tool !== undefined && (tool === null || typeof tool !== 'object' || Array.isArray(tool)
    || (authority !== undefined && (authority === null || typeof authority !== 'object' || Array.isArray(authority)
      || (authority.redMainQuarantine !== undefined && typeof authority.redMainQuarantine !== 'boolean'))));
  // Global read taint from unrelated settings files must not revoke the grant; only this namespace's own evidence does.
  // Unreadable/invalid files still deny (they could hide a grant); a merely dotted key is structural, not evidence.
  const ownTaint = checked && (checked.duplicates.length
    || checked.taint.some(t => !/^dotted key$/.test(String(t.reason))));
  if (ownTaint || invalidTool) {
    resolved.value.redMainQuarantine = false;
    resolved.sources.redMainQuarantine = 'tool';
  }
  logCascadeSources('orchestrator.authority', resolved, { env, ...(log ? { log } : {}) });
  return resolved.value;
}
