/** Grouped-build policy and deterministic planning; no dispatch or claim side effects. */
import { resolveCascade, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { firstScopeOverlap, parseScopeEntry } from '../readiness/overlap-chain.mjs';

const standard = Object.freeze({
  groupSmallFindings: true, groupMin: 3, groupMax: 6, groupMaxSize: 2, groupMaxLoc: 150,
  groupKinds: ['task', 'story'], groupRelatedBy: ['pathPrefix', 'parent', 'disjointFiles'],
  groupPathPrefixDepth: 2, groupRequireSameLocus: true, groupAllowBlockedBy: false,
  groupPrepare: 'per-group', groupMemberFailure: 'requeue-alone',
});
const signals = new Set(['pathPrefix', 'parent', 'tag', 'disjointFiles', 'locus']);
const bool = v => typeof v === 'boolean';
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const int = minimum => v => Number.isSafeInteger(v) && v >= minimum;
const strings = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim().length > 0);
const valid = {
  groupSmallFindings: bool, groupMin: int(2), groupMax: int(2), groupMaxSize: positive,
  groupMaxLoc: int(1), groupKinds: strings, groupRelatedBy: v => strings(v) && v.every(x => signals.has(x)),
  groupPathPrefixDepth: int(1), groupRequireSameLocus: bool, groupAllowBlockedBy: bool,
  groupPrepare: v => ['per-group', 'per-card'].includes(v),
  groupMemberFailure: v => ['requeue-alone', 'fail-group'].includes(v),
};
const envNames = Object.fromEntries(Object.keys(standard).map(key => [key,
  `WE_BUILD_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`]));
// Pick only owned leaves; wrap invalid objects so the cascade diagnoses the whole leaf.
const block = value => Object.fromEntries(Object.keys(standard).filter(key => value?.[key] !== undefined)
  .map(key => [key, value[key] !== null && typeof value[key] === 'object' && !Array.isArray(value[key]) ? [value[key]] : value[key]]));
function envBlock(env) {
  const values = {};
  for (const [key, name] of Object.entries(envNames)) {
    const raw = env?.[name];
    if (raw === undefined) continue;
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (typeof standard[key] === 'boolean') {
      values[key] = typeof text === 'boolean' ? text
        : ['true', '1'].includes(String(text).toLowerCase()) ? true
          : ['false', '0'].includes(String(text).toLowerCase()) ? false : raw;
    } else if (typeof standard[key] === 'number') {
      values[key] = text === '' ? raw : Number(text);
    } else if (Array.isArray(standard[key])) {
      values[key] = typeof text === 'string' ? (text ? text.split(',').map(x => x.trim()) : []) : raw;
    } else values[key] = text;
  }
  return values;
}

/** PURE: each owned key cascades standard → platform build → tool build → env. */
export function resolveBuildGroupingSettings({ platform, tool, env = {} } = {}) {
  const layers = { platform: block(platform), tool: block(tool), envValues: envBlock(env) };
  const extraInvalid = [];
  // If no layer can supply a maximum at least as large as the resolved minimum, ignore that minimum
  // override and try its lower layer. Never invent a maximum or emit an impossible configuration.
  let resolved;
  for (;;) {
    resolved = resolveCascade({ standard, ...layers, valid });
    const min = resolved.value.groupMin;
    if ([standard, layers.platform, layers.tool, layers.envValues].some(layer => valid.groupMax(layer.groupMax) && layer.groupMax >= min)) break;
    const source = resolved.sources.groupMin;
    const layer = source === 'env' ? layers.envValues : layers[source];
    extraInvalid.push(`${source}.groupMin=${JSON.stringify(layer.groupMin)} (no groupMax >= groupMin)`);
    delete layer.groupMin;
  }
  const min = resolved.value.groupMin;
  const maxResolved = resolveCascade({ standard: { groupMax: standard.groupMax },
    platform: { groupMax: layers.platform.groupMax }, tool: { groupMax: layers.tool.groupMax },
    envValues: { groupMax: layers.envValues.groupMax }, valid: { groupMax: v => valid.groupMax(v) && v >= min } });
  return { ...resolved.value, groupKinds: [...resolved.value.groupKinds],
    groupRelatedBy: [...resolved.value.groupRelatedBy], groupMax: maxResolved.value.groupMax,
    sources: { ...resolved.sources, groupMax: maxResolved.sources.groupMax },
    invalid: [...new Set([...resolved.invalid, ...maxResolved.invalid, ...extraInvalid])] };
}

/** IO only: missing/unreadable layers fall back; tick callers log formatBuildGroupingLine each tick. */
export function readBuildGroupingSettings({ env = process.env, read = readSettings } = {}) {
  let tool, platform;
  try { tool = read()?.build; } catch { /* absent tool layer */ }
  try { platform = platformPreference('build', { env }); } catch { /* absent platform layer */ }
  return resolveBuildGroupingSettings({ platform, tool, env });
}

/** Full effective values and source layers, without once-per-process logging suppression. */
export function formatBuildGroupingLine(settings) {
  return `build-grouping: ${Object.keys(standard).map(key => {
    const label = key === 'groupRelatedBy' ? 'relatedBy' : key;
    const value = Array.isArray(settings[key]) ? settings[key].join(',') : String(settings[key]);
    return `${label}=${value} (${settings.sources?.[key] ?? 'standard'})`;
  }).join(', ')}`;
}

const id = num => String(num);
const exclusionSet = values => new Set([...values ?? []].map(id));
const scopes = card => (Array.isArray(card?.scope) ? card.scope : []).map(parseScopeEntry).filter(Boolean);

/** PURE: a measured, scoped finding in an allowed kind, excluding previously dropped members. */
export function groupEligible(card, settings, groupDropped = settings.groupDropped ?? []) {
  if (exclusionSet(groupDropped).has(id(card?.num))) return { ok: false, why: 'group-dropped' };
  if (!settings.groupKinds.includes(card?.kind)) return { ok: false, why: 'kind' };
  if (card?.size != null) {
    if (!positive(card.size) || card.size > settings.groupMaxSize) return { ok: false, why: 'size' };
  } else if (!positive(card?.estimatedLoc) || card.estimatedLoc > settings.groupMaxLoc) return { ok: false, why: 'estimated-loc' };
  if (!scopes(card).length) return { ok: false, why: 'scope' };
  return { ok: true, why: null };
}

const repoSet = card => [...new Set(scopes(card).map(s => s.repo))].sort();
function sameLocus(a, b) {
  if (a.locus && b.locus && a.locus !== b.locus) return false;
  const ar = repoSet(a), br = repoSet(b);
  return ar.length === 1 && br.length === 1 && ar[0] === br[0];
}
function prefix(scope, depth) {
  // A file name is not a directory segment. A trailing slash explicitly declares a directory.
  const parts = scope.path.replace(/\/+$/, '').split('/');
  if (!scope.path.endsWith('/')) parts.pop();
  return parts.length >= depth ? parts.slice(0, depth).join('/') : null;
}
function relatedSignal(lead, candidate, members, settings) {
  for (const signal of settings.groupRelatedBy) {
    if (signal === 'pathPrefix' && scopes(lead).some(a => scopes(candidate).some(b => {
      const p = prefix(a, settings.groupPathPrefixDepth);
      return p !== null && p === prefix(b, settings.groupPathPrefixDepth);
    }))) return signal;
    if (signal === 'parent' && lead.parent != null && String(lead.parent).trim() && String(lead.parent) === String(candidate.parent)) return signal;
    if (signal === 'tag' && Array.isArray(lead.tags) && lead.tags.some(tag => candidate.tags?.includes(tag))) return signal;
    if (signal === 'disjointFiles' && members.every(member => !firstScopeOverlap(member.scope, candidate.scope))) return signal;
    if (signal === 'locus' && lead.locus && lead.locus === candidate.locus) return signal;
  }
  return null;
}
const blocked = (a, b) => Array.isArray(a.blockedBy) && a.blockedBy.some(num => id(num) === id(b.num));

/** PURE: picks take precedence over the extra ready pool; group members exclude the lead. */
export function planBuildGroups({ picks = [], pool = [], rowsByNum = new Map(), settings, exclude = [] }) {
  const groups = [], singles = [], absorbed = new Set();
  const used = new Set();
  const dropped = exclusionSet([...(settings.groupDropped ?? []), ...exclude]);
  const row = pick => {
    const value = typeof pick === 'object' ? pick : { num: pick };
    const stored = rowsByNum instanceof Map ? (rowsByNum.get(id(value.num)) ?? rowsByNum.get(value.num)) : rowsByNum?.[value.num];
    return { ...stored, ...value };
  };
  for (let index = 0; index < picks.length; index++) {
    const pick = picks[index], lead = row(pick), leadId = id(lead.num);
    if (used.has(leadId)) continue;
    used.add(leadId);
    if (!settings.groupSmallFindings || !groupEligible(lead, settings, dropped).ok) { singles.push(pick); continue; }
    const members = [lead], related = {}, seen = new Set([leadId]);
    for (const entry of [...picks.slice(index + 1), ...pool]) {
      if (members.length >= settings.groupMax) break;
      const candidate = row(entry), key = id(candidate.num);
      if (seen.has(key) || used.has(key)) continue;
      seen.add(key);
      if (!groupEligible(candidate, settings, dropped).ok) continue;
      if (settings.groupRequireSameLocus && !sameLocus(lead, candidate)) continue;
      if (!settings.groupAllowBlockedBy && members.some(member => blocked(member, candidate) || blocked(candidate, member))) continue;
      const signal = relatedSignal(lead, candidate, members, settings);
      if (!signal) continue;
      members.push(candidate);
      related[candidate.num] = signal;
    }
    if (members.length < settings.groupMin) { singles.push(pick); continue; }
    const memberNums = members.slice(1).map(member => member.num);
    groups.push({ lead: lead.num, members: memberNums, related });
    for (const num of memberNums) { used.add(id(num)); absorbed.add(num); }
  }
  return { groups, absorbed, singles };
}

/** PURE: both failure policies release orphan claims. Drop/fail-group settlement is a daemon concern. */
export function retireMemberWhy({ member, leadAlive, leadDelivered, memberStillQueued, groupMemberFailure }) {
  if (leadAlive || leadDelivered) return null;
  return memberStillQueued ? 'group-lead-gone' : 'not-queued';
}
