/** Shared closure-scope policy for planning and boot smoke, without a smoke import cycle. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, logCascadeSources } from '../policy-cascade.mjs';

export function daemonRebuildSettingsPath() {
  // Resolve on the filesystem: Vite rewrites static new URL expressions as browser assets.
  return join(dirname(fileURLToPath(import.meta.url)), '../daemon-rebuild-settings.json');
}

/** Standard shadow never auto-graduates: enabling scoped adoption requires an explicit layer. */
export function resolveClosureScopeMode(env = process.env, { settingsPath = daemonRebuildSettingsPath() } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8')).closureScope; } catch { /* unset */ }
  const r = cascadePolicy('closureScope', tool, {
    env, standard: { mode: 'shadow' },
    envValues: { mode: env?.WE_DAEMON_CLOSURE_SCOPE?.trim() || undefined },
    valid: { mode: v => ['off', 'shadow', 'on'].includes(v) },
  });
  const mode = r.value.mode, source = r.sources.mode;
  logCascadeSources('closureScope.effective', { value: { mode }, sources: { mode: source } }, { env });
  return { mode, source };
}
