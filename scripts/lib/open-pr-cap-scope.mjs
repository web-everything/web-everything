/**
 * Open-PR landing-cap scope — operator ruling 2026-10-09: the builder's freeze
 * should not count accepted or story-only PRs. Other open-PR guards retain every PR.
 * Pure resolution/counting, with a never-throwing settings IO shell.
 */
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { hasLabel } from './ai-pr-authorship.mjs';
import { readSettings } from './settings-files.mjs';
import { platformPreference, logCascadeSources } from './policy-cascade.mjs';

export const OPEN_PR_CAP_SCOPE_DEFAULTS = Object.freeze({ excludeCardOnly: true, excludeAccepted: true });
// Keep the runtime leaf light; the test pins this to REVIEW_LABELS.accepted.
export const ACCEPTED_LABEL = 'review:accepted';

/** Pure cascade: only valid, explicitly set values override the lower layer. */
export function resolveOpenPrCapScope({ platform, tool, env } = {}) {
  const scope = { ...OPEN_PR_CAP_SCOPE_DEFAULTS, source: { excludeCardOnly: 'default', excludeAccepted: 'default' } };
  for (const [name, layer] of [['platform', platform], ['tool', tool]]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    for (const key of Object.keys(OPEN_PR_CAP_SCOPE_DEFAULTS)) {
      if (!Object.hasOwn(layer, key) || typeof layer[key] !== 'boolean') continue;
      scope[key] = layer[key];
      scope.source[key] = name;
    }
  }
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const [key, variable] of [['excludeCardOnly', 'WE_OPEN_PR_CAP_EXCLUDE_CARD_ONLY'], ['excludeAccepted', 'WE_OPEN_PR_CAP_EXCLUDE_ACCEPTED']]) {
      if (env[variable] !== 'true' && env[variable] !== 'false') continue;
      scope[key] = env[variable] === 'true';
      scope.source[key] = 'env';
    }
  }
  return scope;
}

/** Read the platform preference (shared policy cascade) + per-feature tool layer; unreadable settings leave lower
 *  layers intact. Logs each value's source once per process. */
export function readOpenPrCapScope({ env = process.env, platform = platformPreference('openPrCap', { env }), read = readSettings } = {}) {
  let tool;
  try { tool = read().openPrCap; } catch { /* Defaults/platform/env still apply. */ }
  const scope = resolveOpenPrCapScope({ platform, tool, env });
  logCascadeSources('openPrCap', {
    value: scope,
    sources: Object.fromEntries(Object.entries(scope.source).map(([k, l]) => [k, l === 'default' ? 'standard' : l])),
  }, { env });
  return scope;
}

/** Count normalized open PRs, assigning overlapping exclusions to card-only first. */
export function countOpenPrsForCap(openPrs, scope = OPEN_PR_CAP_SCOPE_DEFAULTS) {
  const countedPrs = [];
  const cardOnlyPrs = [];
  const acceptedPrs = [];
  for (const pr of openPrs) {
    const id = `${pr.repo}#${pr.number}`;
    if (scope.excludeCardOnly && isCardOnlyDiff((pr.files || []).map((f) => f?.path ?? f))) cardOnlyPrs.push(id);
    else if (scope.excludeAccepted && hasLabel(pr, ACCEPTED_LABEL)) acceptedPrs.push(id);
    else countedPrs.push(id);
  }
  return { total: openPrs.length, counted: countedPrs.length, cardOnly: cardOnlyPrs.length, accepted: acceptedPrs.length, countedPrs, cardOnlyPrs, acceptedPrs };
}

export function formatOpenPrCap(c) {
  return `${c.counted} open PRs counted (${c.cardOnly} card-only, ${c.accepted} accepted excluded)`;
}
