/**
 * Open-PR landing-cap scope — operator ruling 2026-10-09: the builder's freeze
 * should not count accepted or story-only PRs. Other open-PR guards retain every PR.
 * Pure resolution/counting, with a never-throwing settings IO shell.
 */
// Pure cap readers accept already-resolved pr.realFiles; they do not fetch on the admission hot path.
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { hasLabel } from './ai-pr-authorship.mjs';
import { readSettings } from './settings-files.mjs';
import { platformPreference, logCascadeSources, cascadePolicy } from './policy-cascade.mjs';

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
    const files = Object.hasOwn(pr, 'realFiles') ? pr.realFiles : pr.files;
    if (scope.excludeCardOnly && isCardOnlyDiff(Array.isArray(files) ? files.map((f) => f?.path ?? f) : null)) cardOnlyPrs.push(id);
    else if (scope.excludeAccepted && hasLabel(pr, ACCEPTED_LABEL)) acceptedPrs.push(id);
    else countedPrs.push(id);
  }
  return { total: openPrs.length, counted: countedPrs.length, cardOnly: cardOnlyPrs.length, accepted: acceptedPrs.length, countedPrs, cardOnlyPrs, acceptedPrs,
    excludeCardOnly: scope.excludeCardOnly, excludeAccepted: scope.excludeAccepted };
}

export function formatOpenPrCap(c) {
  const excluded = c.nonBuilder > 0 ? [`${c.nonBuilder} non-builder`] : [];
  const included = [];
  for (const [flag, count, label] of [['excludeCardOnly', 'cardOnly', 'card-only'], ['excludeAccepted', 'accepted', ACCEPTED_LABEL]]) {
    if (c[flag]) excluded.push(`${c[count]} ${label}`);
    else included.push(`${label} counted (openPrCap.${flag}=false)`);
  }
  const details = [excluded.length ? `not counted: ${excluded.join(', ')}` : '', included.join(', ')].filter(Boolean).join('; ');
  const multiRepo = new Set(c.countedPrs.map((id) => id.slice(0, id.lastIndexOf('#')))).size > 1;
  const listed = c.countedPrs.slice(0, 15).map((id) => multiRepo ? id : id.slice(id.lastIndexOf('#'))).join(' ');
  const remaining = c.countedPrs.length - 15;
  const counted = listed ? ` — counted: ${listed}${remaining > 0 ? ` … (+${remaining} more)` : ''}` : '';
  return `${c.counted} of ${c.total} open PRs counted (${details})${counted}`;
}

/** Builder landing-cap population. Keep unrelated build leaves out of this cascade. */
export function readBuilderPrCapSettings({ env = process.env, read = readSettings, platform, log } = {}) {
  let tool;
  try { tool = read()?.build; } catch { /* retain lower layers */ }
  const layer = value => ['builder', 'all'].includes(value?.maxOpenPrsCounts)
    ? { maxOpenPrsCounts: value.maxOpenPrsCounts } : {};
  const resolved = cascadePolicy('build', layer(tool), {
    standard: { maxOpenPrsCounts: 'builder' },
    platform: layer(platform ?? platformPreference('build', { env })), env, log,
    envValues: layer({ maxOpenPrsCounts: env.WE_BUILD_MAX_OPEN_PRS_COUNTS }),
  });
  return { maxOpenPrsCounts: resolved.value.maxOpenPrsCounts,
    maxOpenPrsCountsSource: resolved.sources.maxOpenPrsCounts };
}

/** Positive launch provenance; a generic lane ref or an author identity is insufficient. */
export function isBuilderPr(pr) {
  return /^lane\/prepare-batch-(?:[0-9]+|x[0-9a-z]{6})-[1-9][0-9]*$/i.test(pr.headRefName ?? '')
    || /^lane\/(?:[0-9]+|x[0-9a-z]{6})[a-z]?-(?:prepare|build)(?:-|$)/i.test(pr.headRefName ?? '')
    || /Delivered by the #3627 minimal delivery-agent pipeline/.test(pr.body ?? '');
}
