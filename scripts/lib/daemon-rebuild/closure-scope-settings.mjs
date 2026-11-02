/** Shared closure-scope policy for planning and boot smoke, without a smoke import cycle. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, logCascadeSources } from '../policy-cascade.mjs';

export function daemonRebuildSettingsPath() {
  // Resolve on the filesystem: Vite rewrites static new URL expressions as browser assets.
  return join(dirname(fileURLToPath(import.meta.url)), '../daemon-rebuild-settings.json');
}

let onModeLockLogged = false;
/** R284 Route B: every on request uses the full unscoped path until the allowlist lands. */
export function lockClosureScopeMode(mode, { log = message => console.error(message) } = {}) {
  if (mode !== 'on') return mode;
  if (!onModeLockLogged) {
    onModeLockLogged = true;
    try { log('closure-scope on-mode locked until allowlist card 7540 (xfgw4ro) lands'); }
    catch { /* diagnostics must never interrupt the unscoped fallback */ }
  }
  return 'off';
}

/** Keep the requesting layer's provenance while applying the on-mode lock after the cascade. */
export function resolveClosureScopeMode(env = process.env, { settingsPath = daemonRebuildSettingsPath() } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8')).closureScope; } catch { /* unset */ }
  const r = cascadePolicy('closureScope', tool, {
    env, standard: { mode: 'shadow' },
    envValues: { mode: env?.WE_DAEMON_CLOSURE_SCOPE?.trim() || undefined },
    valid: { mode: v => ['off', 'shadow', 'on'].includes(v) },
  });
  const mode = lockClosureScopeMode(r.value.mode), source = r.sources.mode;
  logCascadeSources('closureScope.effective', { value: { mode }, sources: { mode: source } }, { env });
  return { mode, source };
}
