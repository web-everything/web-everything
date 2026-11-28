/** OVERLAY-SHA-PIN — tests select the overlay audited-tip mode through a caller-owned prefs file.
 * `readFile` may be injected to test shipped defaults using only temp fixtures. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, PLATFORM_PREFERENCES_ENV } from '../../policy-cascade.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (UNSAFE.has(k) || k.startsWith('$')) continue;
    out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v) : v;
  }
  return out;
};
const readJson = (p, readFile) => { try { const v = JSON.parse(readFile(p, 'utf8')); return isObj(v) ? v : {}; } catch { return {}; } };

function write(env, dir, extra, name, readFile) {
  if (typeof dir !== 'string' || !dir) throw new Error('overlay-audit-off: pass a caller-owned { dir }');
  const own = String(env?.[PLATFORM_PREFERENCES_ENV] ?? '').trim();
  const bases = own ? [own] : [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH];
  const prefs = merge(bases.reduce((acc, p) => merge(acc, readJson(p, readFile)), {}), extra);
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(prefs));
  const { WE_DAEMON_OVERLAY_FOLLOW_TIP: _dropped, ...rest } = env ?? {};
  return { ...rest, [PLATFORM_PREFERENCES_ENV]: file };
}

export const withShippedPrefs = (env, { dir, readFile = readFileSync } = {}) => write(env, dir, {}, 'platform-shipped.json', readFile);
export const withOverlayAuditOff = (env, { dir, readFile = readFileSync } = {}) => write(env, dir, { overlay: { followTip: 'follow' } }, 'platform-audit-off.json', readFile);
