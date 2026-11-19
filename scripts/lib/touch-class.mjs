/** Pure preparation scope classification; runtime policies remain authoritative. */
import { isTrustChainPath, isPolicyCorePath, isEngineTierPath } from './gate-config.mjs';
import { isGateSelfPath, isBlastRadiusPath, isStatutePath } from './review-escalation.mjs';
import { isDaemonSoakScopePath } from './daemon-soak-scope.mjs';
import audit from '../settings/codex-audit.json' with { type: 'json' };
import defaults from '../settings/prep-flow.json' with { type: 'json' };

export const CLASS_NAMES = Object.freeze(['guard', 'daemon', 'merge', 'review', 'label']);

/** Anchored repository globs: * is one segment, ** crosses segments, trailing / is a subtree. */
export function matchesPath(path, glob) {
  if (typeof path !== 'string' || typeof glob !== 'string' || !glob) return false;
  let pattern = glob.endsWith('/') ? `${glob}**` : glob;
  pattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^(?:${pattern})$`).test(path);
}

export function classifyPath(path, cfg = defaults) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f]/.test(path)
    || path.startsWith('/') || path.split('/').includes('..')) return ['unknown-sensitive'];
  const trailingSlash = path.endsWith('/');
  path = path.split('/').filter(part => part !== '' && part !== '.').join('/');
  if (!path) return ['unknown-sensitive'];
  const found = new Set();
  // A scope glob is a promise about future paths, not a finite changed-file list.
  // Require design review until that promise is expanded to concrete files.
  if (path.includes('*') || trailingSlash) found.add('unknown-sensitive');
  for (const name of CLASS_NAMES) {
    const globs = [...defaults.classes[name].globs, ...(cfg.classes?.[name]?.globs ?? [])];
    if (globs.some(g => matchesPath(path, g))) found.add(name);
  }
  if (audit.audit.guardFloorPaths.some(g => matchesPath(path, g))) found.add('guard');
  // TRUST_CHAIN supersedes the historical GATE_SELF_PATHS; these predicates consume its live tiers.
  if (isTrustChainPath(path) || isPolicyCorePath(path) || isEngineTierPath(path)) found.add('merge');
  if (isGateSelfPath(path) || isBlastRadiusPath(path) || isStatutePath(path)) found.add('review');
  if (isDaemonSoakScopePath(path)) found.add('daemon');
  if (!found.size && [...defaults.sensitivePrefixes, ...(cfg.sensitivePrefixes ?? [])]
    .some(prefix => path.startsWith(prefix))) found.add('unknown-sensitive');
  return [...found].sort();
}

export function classifyPaths(paths, cfg = defaults) {
  return [...new Set(paths.flatMap(path => classifyPath(path, cfg)))].sort();
}
