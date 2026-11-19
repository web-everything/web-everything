/** R1082 settings: standard → platform credentialProtection → tool → environment.
 * Invalid/unreadable evidence restores the complete strict policy; restore the file to recover.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCascade, readPlatformPreferences } from './policy-cascade.mjs';
import { DEFAULT_CREDENTIAL_PROTECTION, STRICT_CREDENTIAL_PROTECTION, validProtectedPaths, withProtectedPathFloor } from './credential-protection.mjs';

export function resolveCredentialProtection({ platform = {}, tool = {}, env = {}, invalid = false, log = () => {} } = {}) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const valid = { protectedPaths: validProtectedPaths, 'gitleaks.mode': v => ['auto', 'require', 'off'].includes(v),
    gitleaks: v => object(v) && ['auto', 'require', 'off'].includes(v.mode),
    agentBashDecision: v => ['pass', 'ask', 'deny'].includes(v), readOnlyListing: v => v === 'pass' };
  const shape = v => object(v) && Object.entries(v).every(([key, value]) => key === '$comment'
    || (key === 'gitleaks' ? object(value) && Object.keys(value).every(k => k === 'mode')
      : Object.hasOwn(valid, key)));
  const r = resolveCascade({ standard: DEFAULT_CREDENTIAL_PROTECTION, platform, tool,
    envValues: { gitleaks: env.WE_GITLEAKS_MODE === 'require' ? { mode: 'require' } : undefined }, valid });
  const strict = invalid || !shape(platform) || !shape(tool) || r.invalid.length > 0;
  const settings = strict ? structuredClone(STRICT_CREDENTIAL_PROTECTION) : r.value;
  if (!strict) {
    // Keep the shared cascade's validation, then retain the strictest valid leaf.
    // Equal values keep the later layer as their provenance.
    for (const [key, order] of [['gitleaks', ['off', 'auto', 'require']], ['agentBashDecision', ['pass', 'ask', 'deny']]]) {
      let strongest = -1;
      for (const [source, layer] of [['standard', DEFAULT_CREDENTIAL_PROTECTION], ['platform', platform], ['tool', tool],
        ['env', env.WE_GITLEAKS_MODE === 'require' ? { gitleaks: { mode: 'require' } } : {}]]) {
        const value = key === 'gitleaks' ? layer[key]?.mode : layer[key];
        if (order.indexOf(value) < strongest || value === undefined) continue;
        strongest = order.indexOf(value);
        settings[key] = key === 'gitleaks' ? { mode: value } : value;
        delete r.sources['gitleaks.mode'];
        r.sources[key] = source;
      }
    }
  }
  settings.protectedPaths = withProtectedPathFloor([
    ...(validProtectedPaths(platform?.protectedPaths) ? platform.protectedPaths : []),
    ...(validProtectedPaths(tool?.protectedPaths) ? tool.protectedPaths : []),
    ...settings.protectedPaths,
  ]);
  r.sources.protectedPaths = ['standard', ...(platform?.protectedPaths ? ['platform'] : []),
    ...(tool?.protectedPaths ? ['tool'] : [])].join('+');
  delete settings.$comment;
  if (env.WE_GITLEAKS_MODE !== undefined && env.WE_GITLEAKS_MODE !== 'require') {
    log('credential-protection: ignored WE_GITLEAKS_MODE; environment may only select require.');
  }
  log(`credential-protection: ${strict ? 'INVALID evidence; strict defaults (restore settings to recover)' : Object.entries(r.sources).filter(([k]) => k !== '$comment').map(([k, source]) => `${k}=${JSON.stringify(k.split('.').reduce((v, p) => v?.[p], settings))} (${source})`).join(', ')}`);
  return { settings, sources: strict ? { fallback: 'strict-defaults' } : r.sources };
}
export function loadCredentialProtection({ env = process.env, log = console.error,
  toolPath = fileURLToPath(new URL('../settings/credential-protection.json', import.meta.url)),
  read = readFileSync, readPlatform = readPlatformPreferences } = {}) {
  let tool = {}, invalid = false;
  try { tool = JSON.parse(String(read(toolPath, 'utf8'))); } catch { invalid = true; }
  let platform = {};
  try {
    const p = readPlatform({ env });
    platform = p.prefs.credentialProtection ?? {};
    invalid ||= p.errors.length > 0;
  } catch { invalid = true; }
  return resolveCredentialProtection({ platform, tool, env, invalid, log });
}
