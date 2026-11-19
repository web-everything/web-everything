/** Pure schema/fallback for S2. Invalid evidence asks for design review, never enables enforcement. */
import defaults from '../settings/prep-flow.json' with { type: 'json' };
export const PREP_DEFAULTS = defaults;
export function resolvePrepSettings(value) {
  const strings = v => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0);
  const valid = value && ['buildStart', 'openPr', 'audit', 'guard'].every(k => value.enforce?.[k] === 'advise')
    && Object.keys(defaults.classes).every(k => strings(value.classes?.[k]?.globs))
    && strings(value.sensitivePrefixes) && strings(value.threatModelTriggers)
    && value.threatModelTriggers.every(s => { try { new RegExp(s); return true; } catch { return false; } })
    && Number.isInteger(value.fastPath?.maxFiles) && value.fastPath.maxFiles >= 0 && value.fastPath.maxFiles <= 3
    && Number.isInteger(value.fastPath?.maxLoc) && value.fastPath.maxLoc >= 0 && value.fastPath.maxLoc <= 80
    && typeof value.storeDir === 'string' && value.storeDir.length > 0;
  return valid ? { config: value, errors: [] } : {
    config: { ...defaults, sensitivePrefixes: [''], fastPath: { maxFiles: 0, maxLoc: 0 }, threatModelTriggers: ['.*'] },
    errors: ['Invalid prep settings: design review required; restore readable valid settings. Enforcement remains advise-only.'],
  };
}
