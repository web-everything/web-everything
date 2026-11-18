// Light module on purpose: prepare.mjs is imported by CLIs that run from a copied scripts/ tree, so this setting
// resolver must not pull the heavy overlay-main-sync import chain (which reads repo files at module load).
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformPreferences } from '../policy-cascade.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../daemon-rebuild-settings.json');
const STANDARD_MINUTES = 30;
const FAIL_CLOSED = Object.freeze({ value: 0, source: 'fail-closed (invalid or unreadable park setting: hold kept)' });
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 60_000;

/**
 * Minutes an established-overlay hold lasts before a feature overlay is parked; 0 disables parking.
 * Precedence standard (30) -> platform -> tool file -> env. ONLY an absent setting falls through to the next
 * layer's default: a present but invalid, non-numeric or unreadable value at ANY layer fails closed (0 = hold kept),
 * never back to the 30-minute default, so a broken config can never turn parking on.
 */
export function resolveEstablishedOverlayParkMinutes(env = process.env, { settingsPath = SETTINGS } = {}) {
  let value = STANDARD_MINUTES;
  let source = 'standard';
  const apply = (raw, layer) => {
    if (raw === undefined) return true;
    if (!valid(raw)) return false;
    value = raw; source = layer;
    return true;
  };
  try {
    const { prefs, errors } = readPlatformPreferences({ env, warn: () => {} });
    if (errors.length > 0) return FAIL_CLOSED;
    const layer = prefs?.overlay;
    if (layer !== undefined && (layer === null || typeof layer !== 'object' || Array.isArray(layer))) return FAIL_CLOSED;
    if (!apply(layer?.establishedParkMinutes, 'platform')) return FAIL_CLOSED;
  } catch { return FAIL_CLOSED; }
  try {
    const tool = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).overlay;
    if (tool !== undefined && (tool === null || typeof tool !== 'object' || Array.isArray(tool))) return FAIL_CLOSED;
    if (!apply(tool?.establishedParkMinutes, 'tool')) return FAIL_CLOSED;
  } catch (e) {
    if (e?.code !== 'ENOENT') return FAIL_CLOSED;
  }
  const raw = env.WE_DAEMON_ESTABLISHED_OVERLAY_PARK_MINUTES;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.trim() === '' || !apply(Number(raw), 'env')) return FAIL_CLOSED;
  }
  return { value, source };
}
