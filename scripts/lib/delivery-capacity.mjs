/** S1 read-only delivery capacity. Assessment and rendering perform no IO. */
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { ACCEPTED_LABEL, isBuilderPr } from './open-pr-cap-scope.mjs';

const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export const DELIVERY_CAPACITY_DEFAULTS = freeze({
  mode: 'count', population: 'all', openPrCap: 18, unitCap: 30,
  weights: { cards: 0.5, S: 1, M: 2.5, L: 4 }, sizeLines: { S: 150, M: 600 },
  acceptedWeight: 0, careMultiplier: { none: 1, low: 1, elevated: 1.25, high: 1.5 },
  roundPenalty: { after: 2, per: 0.25, max: 2 },
  startUnits: { byCardPoints: { 1: 'S', 2: 'S', 3: 'S', 5: 'M', 8: 'L', 13: 'L' }, unknown: 'M' },
  holdLabels: ['review:human', 'status:needs-you', 'review-status:needs-human',
    'status:escalated', 'blocked', 'advisory:ruling-needed'],
  heldWeight: 0, heldCap: 4, heldStaleH: 72, idleMinPct: 15, memMinGb: 4, maxStartsPerCheck: 8,
});
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = value => nonnegative(value) && value > 0;
const size = value => ['S', 'M', 'L'].includes(value);
const valid = {
  mode: value => ['count', 'units'].includes(value),
  population: value => ['all', 'builder'].includes(value),
  openPrCap: value => Number.isSafeInteger(value) && value > 0,
  unitCap: positive, weights: nonnegative, sizeLines: positive,
  acceptedWeight: nonnegative, careMultiplier: nonnegative, roundPenalty: nonnegative,
  'startUnits.unknown': size, 'startUnits.byCardPoints': size, startUnits: size,
  holdLabels: value => Array.isArray(value) && value.every(label => typeof label === 'string' && label.length > 0),
  heldWeight: nonnegative, heldCap: value => Number.isSafeInteger(value) && value >= 0,
  heldStaleH: positive, idleMinPct: value => nonnegative(value) && value <= 100,
  memMinGb: nonnegative, maxStartsPerCheck: value => Number.isSafeInteger(value) && value >= 0,
};

/** Settings IO shell: invalid leaves retain their valid lower layer. */
export function resolveDeliveryCapacity(options = {}) {
  try {
    const { env = process.env, platform, read = readSettings, log } = options;
    let tool;
    try { tool = read()?.deliveryCapacity; } catch { /* retain lower layers */ }
    return cascadePolicy('deliveryCapacity', tool, {
      standard: DELIVERY_CAPACITY_DEFAULTS, platform, env, log, valid,
      envValues: { mode: env?.WE_DELIVERY_CAPACITY_MODE },
    });
  } catch {
    return { value: structuredClone(DELIVERY_CAPACITY_DEFAULTS), sources: standardSources() };
  }
}

function standardSources(value = DELIVERY_CAPACITY_DEFAULTS, prefix = '', out = {}) {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) standardSources(item, path, out);
    else out[path] = 'standard';
  }
  return out;
}
// Assessment accepts a policy value or the resolver's provenance-bearing result.
function policyValue(input) {
  const raw = input?.value ?? input ?? {};
  const merge = (defaults, layer, prefix = '') => Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const candidate = layer?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return [key, merge(value, candidate, path)];
    const check = valid[path] ?? valid[path.split('.')[0]];
    return [key, check?.(candidate) ? candidate : value];
  }));
  return merge(DELIVERY_CAPACITY_DEFAULTS, raw);
}

function baseWeight(pr, policy) {
  let kind = 'M';
  try {
    const files = Array.isArray(pr?.files) ? pr.files.map(file => typeof file === 'string' ? file : file?.path) : [];
    if (isCardOnlyDiff(files)) kind = 'cards';
    else if (nonnegative(pr?.additions) && nonnegative(pr?.deletions)
      && Number.isFinite(pr.additions + pr.deletions)) {
      const lines = pr.additions + pr.deletions;
      kind = lines < policy.sizeLines.S ? 'S' : lines < policy.sizeLines.M ? 'M' : 'L';
    }
  } catch { /* unknown size counts as M */ }
  return { units: policy.weights[kind], kind, held: false, accepted: false };
}

export function weighPr(pr, policy) {
  let p = DELIVERY_CAPACITY_DEFAULTS;
  try {
    p = policyValue(policy);
    const labels = Array.isArray(pr?.labels) ? pr.labels.map(label => typeof label === 'string' ? label : label?.name) : [];
    if (p.holdLabels.some(label => labels.includes(label))) return { units: p.heldWeight, kind: 'held', held: true, accepted: false };
    if (labels.includes(ACCEPTED_LABEL)) return { units: p.acceptedWeight, kind: 'accepted', held: false, accepted: true };
    return baseWeight(pr, p);
  } catch { return { units: p.weights.M, kind: 'M', held: false, accepted: false }; }
}

function assessment(prs, host, policy, sources, fallbackReason) {
  const breakdown = Object.fromEntries(['cards', 'S', 'M', 'L', 'accepted', 'held'].map(kind =>
    [kind, { n: 0, units: 0, ...(kind === 'held' ? { overflow: 0 } : {}) }]));
  const held = [];
  let weighted = 0;
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const weight = weighPr(pr, policy);
    if (weight.held) {
      held.push(pr.number);
      if (held.length > policy.heldCap) {
        weight.units = baseWeight(pr, policy).units;
        breakdown.held.overflow++;
      }
    }
    breakdown[weight.kind].n++;
    breakdown[weight.kind].units += weight.units;
    weighted += weight.units;
  }
  const mode = fallbackReason ? 'count' : policy.mode;
  const used = mode === 'count' ? prs.length : weighted;
  const cap = mode === 'count' ? policy.openPrCap : policy.unitCap;
  const gateOpen = !fallbackReason && nonnegative(host?.idlePct) && host.idlePct <= 100
    && nonnegative(host?.memGb) && host.idlePct >= policy.idleMinPct && host.memGb >= policy.memMinGb;
  const verdict = !gateOpen ? 'hold' : used >= cap ? 'deliver' : 'build';
  const start = mode === 'count' ? 1 : policy.weights[policy.startUnits.unknown];
  const slots = verdict === 'build' && start > 0
    ? Math.max(0, Math.min(policy.maxStartsPerCheck, Math.floor((cap - used) / start))) : 0;
  const why = [gateOpen ? `gate open (idle ${host.idlePct}% mem ${host.memGb}GB)` : 'gate closed or evidence unreadable',
    `held ${held.length}/${policy.heldCap}; stale threshold ${policy.heldStaleH}h`,
    ...(breakdown.held.overflow ? [`held overflow: ${breakdown.held.overflow} charged at full weight`] : []),
    ...(fallbackReason ? [fallbackReason] : [])];
  return { schema: 'deliveryCapacity.readout.v1', mode, used, cap, slots, verdict, breakdown, held, why,
    sources, openCount: prs.length, ...(fallbackReason ? { fallbackReason } : {}) };
}

export function assessCapacity(input = {}) {
  let policy = DELIVERY_CAPACITY_DEFAULTS;
  let sources = standardSources();
  let prs = [];
  try {
    policy = policyValue(input?.policy);
    sources = input?.policy?.sources ?? sources;
    const evidence = input?.prs;
    if (!Array.isArray(evidence)) return assessment([], input?.host, policy, sources, 'PR evidence unreadable; count-mode fallback');
    prs = evidence;
    if (policy.population === 'builder') prs = prs.filter(isBuilderPr);
    return assessment(prs, input?.host, policy, sources, input?.fallbackReason);
  } catch {
    return assessment([], null, DELIVERY_CAPACITY_DEFAULTS, standardSources(), 'Capacity evidence unreadable; count-mode fallback');
  }
}

export function renderCapacityLine(readout) {
  try {
    const detail = ['cards', 'S', 'M', 'L', 'accepted'].map(kind =>
      `${kind} ${readout.breakdown[kind].n}=${readout.breakdown[kind].units.toFixed(1)}`).join(' ');
    return `capacity ${readout.used.toFixed(1)}/${readout.cap}u${readout.mode === 'count' ? ` [mode count: ${readout.openCount}/${readout.cap} PRs]` : ''} · ${detail} · ${readout.why.join(' · ')} · cap ${readout.cap} = fixed (${readout.sources[readout.mode === 'count' ? 'openPrCap' : 'unitCap'] ?? 'standard'}) → ${readout.verdict} ${readout.slots}`
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  } catch { return 'capacity unknown · count-mode fallback · gate closed → hold 0'; }
}
