/**
 * @file external-check-apps.mjs — which GitHub App posts which non-workflow check (e.g. `red-team`), read from
 * `fix.externalCheckApps` in scripts/settings/fix.json. A pending check from such an app never defers the one-time
 * CI rerun, but only when BOTH its name and its check-suite app (id or slug) match an entry. Unreadable or
 * malformed settings give an empty list: nothing is exempt (fail closed).
 */
import { readFileSync } from 'node:fs';
import { REPO_FIX_SETTINGS_PATH as SETTINGS_PATH } from './takeover-budget.mjs';

/** @returns {{name:string, appSlug:string|null, appId:number|null}[]} */
export function loadExternalCheckApps({ read = (f) => readFileSync(f, 'utf8'), path = SETTINGS_PATH } = {}) {
  try {
    const list = JSON.parse(read(path))?.fix?.externalCheckApps;
    if (!Array.isArray(list)) return [];
    return list.filter((e) => e && typeof e.name === 'string' && e.name
      && (typeof e.appSlug === 'string' && e.appSlug || Number.isInteger(e.appId)))
      .map((e) => ({ name: e.name, appSlug: e.appSlug || null, appId: Number.isInteger(e.appId) ? e.appId : null }));
  } catch { return []; }
}

/** True when the check row is posted by a configured external app: name matches and the app id (preferred) or slug matches. */
export function isExternalAppCheck(check, apps) {
  if (!check || !Array.isArray(apps)) return false;
  return apps.some((a) => a.name === check.name
    && (a.appId !== null ? check.appId === a.appId : check.appSlug === a.appSlug));
}
