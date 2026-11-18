// Light module on purpose: prepare.mjs is imported by CLIs that run from a copied scripts/ tree, so this setting
// resolver must not pull the heavy overlay-main-sync import chain (which reads repo files at module load).
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, platformPreference } from '../policy-cascade.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../daemon-rebuild-settings.json');

/** Zero disables escalation from an established-overlay hold to a parked registration. */
export function resolveEstablishedOverlayParkMinutes(env = process.env, { settingsPath = SETTINGS } = {}) {
  let tool;
  try { tool = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).overlay; } catch { /* standard */ }
  const raw = env.WE_DAEMON_ESTABLISHED_OVERLAY_PARK_MINUTES;
  const r = cascadePolicy('overlay', tool, { env,
    platform: platformPreference('overlay', { env }) ?? {},
    standard: { establishedParkMinutes: 30 },
    envValues: { establishedParkMinutes: typeof raw === 'string' && raw.trim() ? Number(raw) : undefined },
    valid: { establishedParkMinutes: n => typeof n === 'number' && Number.isFinite(n)
      && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 60_000 } });
  return { value: r.value.establishedParkMinutes, source: r.sources.establishedParkMinutes };
}
