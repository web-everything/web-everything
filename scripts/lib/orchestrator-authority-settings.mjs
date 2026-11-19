/** Explicit authority grants: platform policy takes precedence over repo policy. */
import { resolveCascade, readPlatformPreferences, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export function resolveOrchestratorAuthority({ env = process.env, platform, tool = readSettings(), log } = {}) {
  const preferences = platform === undefined ? readPlatformPreferences({ env }) : null;
  const team = platform === undefined
    ? preferences.errors.length ? { authority: { redMainQuarantine: false } } : preferences.prefs.orchestrator
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
  logCascadeSources('orchestrator.authority', resolved, { env, ...(log ? { log } : {}) });
  return resolved.value;
}
