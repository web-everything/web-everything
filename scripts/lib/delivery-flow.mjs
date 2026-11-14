/** Delivery stage policy. PR1 has no dispatch consumer; all IO is on explicit reads. */
import { readSettings } from './settings-files.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { scopeEntriesOverlap, globsMayIntersect } from '../readiness/scope-lease.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';

export const STAGES = Object.freeze({
  design: Object.freeze({ order: 0, role: 'design', settings: ['model', 'effort', 'timeoutMin', 'approve'], approve: false }),
  build: Object.freeze({ order: 1, role: 'build', required: true, settings: [] }),
  audit: Object.freeze({ order: 2, role: 'judge', settings: [] }),
  review: Object.freeze({ order: 3, role: 'review', required: true, settings: [] }),
  'red-team': Object.freeze({ order: 4, role: 'red-team', settings: [] }),
});

const classOrder = ['guard', 'merge', 'review', 'label', 'daemon', 'ordinary'];
const spine = () => [{ stage: 'build' }, { stage: 'review' }];
const designed = () => [{ stage: 'design', model: 'opus', effort: 'high', timeoutMin: 20 }, ...spine()];
export const STANDARD_DELIVERY_FLOW = Object.freeze({
  classOrder,
  classes: {
    guard: ['we:scripts/hooks/**', 'we:scripts/guard-*', 'we:.claude/**', 'we:.githooks/**'],
    merge: ['we:scripts/merge-ai-prs*', 'we:scripts/lib/drain-*', 'we:scripts/**/merge-queue-*', 'we:scripts/lane-drain.mjs', 'we:scripts/pr-land*', 'plateau-app:tools/drain-daemon/**'],
    review: ['we:scripts/**/review-*', 'we:scripts/**/jury-*', 'we:scripts/**/red-team-*', 'we:skills-src/**/review-*'],
    label: ['we:scripts/**/*label*', 'we:skills-src/**/*label*'],
    daemon: ['we:scripts/conveyor/**', 'we:scripts/lib/daemon-rebuild/**', 'we:skills-src/conveyor/*-daemon.mjs'],
    ordinary: [],
  },
  flows: Object.fromEntries(classOrder.map(name => [name, name === 'ordinary' ? spine() : designed()])),
});

/** Production readers of the choke point. Tests pin the actual import sites. */
export const DELIVERY_FLOW_READERS = Object.freeze([
  'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/deliver-item-wrapper.mjs',
  'scripts/operations/delivery-flow-io.mjs',
]);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownStage = name => Object.hasOwn(STAGES, name);
const knownClass = name => classOrder.includes(name);
const warnInvalid = log => log('delivery-flow: ignored invalid stage or policy entry');

// cascadePolicy merges object leaves. Wrap the two atomic object-valued schema keys as array
// leaves so THEIR replacement is also performed by the shared cascade, never a second cascade.
function atomic(layer) {
  if (!object(layer)) return undefined;
  return Object.fromEntries(Object.entries(layer).filter(([key]) => ['classOrder', 'classes', 'flows'].includes(key))
    .map(([key, value]) => [key, key === 'classOrder' ? value : [value]]));
}

function stagesFor(raw, fallback, log) {
  if (!Array.isArray(raw)) { warnInvalid(log); raw = fallback; }
  const seen = new Set();
  const stages = [];
  for (const entry of raw) {
    const table = object(entry) && ownStage(entry.stage) ? STAGES[entry.stage] : null;
    const valid = table && !seen.has(entry.stage)
      && Object.keys(entry).every(key => key === 'stage' || table.settings.includes(key))
      && (entry.model === undefined || (typeof entry.model === 'string' && /^[\w.-]+$/.test(entry.model)))
      && (entry.effort === undefined || ['low', 'medium', 'high', 'max'].includes(entry.effort))
      && (entry.timeoutMin === undefined || (Number.isFinite(entry.timeoutMin) && entry.timeoutMin > 0))
      && (entry.approve === undefined || entry.approve === false);
    if (!valid) {
      warnInvalid(log);
      return fallback.map(stage => ({ ...stage }));
    }
    seen.add(entry.stage);
    stages.push({ ...entry });
  }
  for (const [stage, table] of Object.entries(STAGES)) {
    if (table.required && !seen.has(stage)) { warnInvalid(log); stages.push({ stage }); }
  }
  return stages.sort((a, b) => STAGES[a.stage].order - STAGES[b.stage].order);
}

/** Read standard -> platform -> repo -> environment. Unreadable layers retain lower layers. */
export function resolveDeliveryFlowPolicy({ env = process.env, read = readSettings, tool, platform, log = console.error } = {}) {
  if (tool === undefined) { try { tool = read()?.deliveryFlow; } catch { /* skip unreadable repo layer */ } }
  if (platform === undefined) { try { platform = platformPreference('deliveryFlow', { env }); } catch { /* skip unreadable platform */ } }
  let envLayer;
  if (env.WE_DELIVERY_FLOW !== undefined) {
    try { envLayer = JSON.parse(env.WE_DELIVERY_FLOW); if (!object(envLayer)) warnInvalid(log); }
    catch { warnInvalid(log); }
  }
  const resolved = cascadePolicy('deliveryFlow', atomic(tool), {
    standard: atomic(STANDARD_DELIVERY_FLOW), platform: atomic(platform) ?? {}, env,
    envValues: atomic(envLayer), operatorOverride: {}, log,
    valid: {
      classOrder: value => Array.isArray(value) && value.length === classOrder.length
        && new Set(value).size === classOrder.length && value.every(knownClass),
      classes: value => Array.isArray(value) && value.length === 1 && object(value[0])
        && Object.entries(value[0]).every(([name, globs]) => knownClass(name) && Array.isArray(globs) && globs.every(g => typeof g === 'string')),
      flows: value => Array.isArray(value) && value.length === 1 && object(value[0])
        && Object.keys(value[0]).every(knownClass),
    },
  });
  if (resolved.invalid.length) warnInvalid(log);
  const value = resolved.value;
  // The winning overlay can extend classification, but cannot erase standard coverage.
  const classes = Object.fromEntries(classOrder.map(name => [name,
    [...new Set([...STANDARD_DELIVERY_FLOW.classes[name], ...(value.classes[0][name] ?? [])])]]));
  const flows = Object.fromEntries(classOrder.map(name => [name,
    stagesFor(Object.hasOwn(value.flows[0], name) ? value.flows[0][name] : STANDARD_DELIVERY_FLOW.flows[name], STANDARD_DELIVERY_FLOW.flows[name], log)]));
  return { classOrder: [...value.classOrder], classes, flows, sources: resolved.sources };
}

function normaliseScopeEntry(entry) {
  // Preserve invalid types and oversized input for the fail-closed validation below.
  if (typeof entry !== 'string' || entry.length > 4096) return entry;
  const colon = entry.indexOf(':');
  if (colon < 0) return entry;
  const path = entry.slice(colon + 1).replace(/\/+/g, '/').replace(/^(\.\/)+/, '');
  return entry.slice(0, colon + 1) + path;
}

/** Validate the scope language BEFORE overlap: unsupported evidence must select guard even in other repos.
 * Bounds fall back to guard; operators can narrow/repair the scope to recover ordinary classification. */
function supported(entry) {
  if (typeof entry !== 'string' || entry.length > 4096) return false;
  const match = /^([\w-]+):([^:\s]+)$/.exec(entry);
  if (!match || !Object.hasOwn(CONSTELLATION_REPOS, match[1])) return false;
  const path = match[2];
  return !/[\[\]{}!\\()|]/.test(path) && !path.startsWith('/')
    && path.split('/').every(part => part !== '.' && part !== '..' && (part === '**' || !part.includes('**')));
}

export function classifyTouchSet(scope, policy = STANDARD_DELIVERY_FLOW) {
  const rawEntries = typeof scope === 'string' ? scope.split(',').map(s => s.trim()) : scope;
  const entries = Array.isArray(rawEntries) ? rawEntries.map(normaliseScopeEntry) : rawEntries;
  const closed = reason => ({ class: 'guard', reason, matches: [] });
  if (!Array.isArray(entries) || !entries.length || !entries.every(supported)) return closed('unknown or unsupported scope; narrow or repair scope');
  if (!object(policy.classes) || !Object.values(policy.classes).every(globs => Array.isArray(globs) && globs.every(supported)))
    return closed('unsupported class glob; repair deliveryFlow.classes');
  const matches = [];
  for (const name of policy.classOrder) {
    for (const glob of policy.classes[name] ?? []) {
      // Lease overlap deliberately retains a literal-root ancestor fallback even for disjoint
      // file/glob pairs. Refine that conservative answer with its SAME shared glob automaton:
      // otherwise scripts/**/merge-queue-* classifies every scripts file as merge.
      for (const entry of entries) if (scopeEntriesOverlap(entry, glob)
        && globsMayIntersect(entry.slice(entry.indexOf(':') + 1), glob.slice(glob.indexOf(':') + 1)))
        matches.push({ class: name, scope: entry, glob });
    }
  }
  return { class: matches[0]?.class ?? 'ordinary', reason: matches.length ? 'strictest overlapping class' : 'no class glob overlaps', matches };
}

/** THE future dispatch choke point. A failed reader preserves today's dispatch with one bounded log. */
export function deliveryFlowFor(input = {}, { resolve = resolveDeliveryFlowPolicy, log = console.error } = {}) {
  try {
    const { scope, kind } = input;
    if (kind !== 'build') return null;
    const policy = resolve();
    const classified = classifyTouchSet(scope, policy);
    return { class: classified.class, stages: policy.flows[classified.class].map(stage => ({ ...stage })),
      reason: classified.reason, sources: policy.sources };
  } catch {
    try { log('delivery-flow-unreadable'); } catch { /* logging cannot break dispatch */ }
    return null;
  }
}
