/** S1 read-only delivery capacity. Assessment and rendering perform no IO. */
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { CAPACITY_LEAVES, OVERRIDE_MAX_HOURS } from './operator-override-reader.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
export { renderCapacityLine } from './delivery-capacity-render.mjs';
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
  openPrCapMode: 'hard', softOverCapStarts: 2, loadReducerMaxLoad: 60,
  weights: { cards: 0.5, S: 1, M: 2.5, L: 4 }, sizeLines: { S: 150, M: 600 },
  acceptedWeight: 0, careMultiplier: { none: 1, low: 1, elevated: 1.25, high: 1.5 },
  roundPenalty: { after: 2, per: 0.25, max: 2 },
  startUnits: { byCardPoints: { 1: 'S', 2: 'S', 3: 'S', 5: 'M', 8: 'L', 13: 'L' }, unknown: 'M' },
  holdLabels: ['review:human', 'status:needs-you', 'review-status:needs-human',
    'status:escalated', 'blocked', 'advisory:ruling-needed'],
  autoTune: { mode: 'shadow', everyMin: 60, windowH: 6, minMerges: 10, ttmTargetH: 6,
    backoffFactor: 1.5, roundsTarget: 2.0, increase: 2, decrease: 0.8,
    minUnits: 12, maxUnits: 48, raiseOnlyIfBinding: true,
    heavyWaitMaxMin: 10, lanesFreeMin: 3, activeHighRatio: 0.6, activeLowRatio: 0.3,
    sessionUnits: 1, minutesPerUnit: 30, laneUnits: 0.5, rebaseUnits: 0.25 },
  heldWeight: 0, heldCap: 4, heldStaleH: 72, idleMinPct: 15, memMinGb: 4, maxStartsPerCheck: 8,
});
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = value => nonnegative(value) && value > 0;
const size = value => ['S', 'M', 'L'].includes(value);
const valid = {
  'autoTune.mode': value => ['off', 'shadow', 'on'].includes(value),
  'autoTune.everyMin': positive, 'autoTune.windowH': positive,
  'autoTune.minMerges': value => Number.isSafeInteger(value) && value > 0,
  'autoTune.ttmTargetH': positive, 'autoTune.backoffFactor': positive,
  'autoTune.roundsTarget': positive, 'autoTune.increase': positive,
  'autoTune.decrease': value => positive(value) && value < 1,
  'autoTune.minUnits': positive, 'autoTune.maxUnits': positive,
  'autoTune.raiseOnlyIfBinding': value => typeof value === 'boolean',
  'autoTune.heavyWaitMaxMin': nonnegative, 'autoTune.lanesFreeMin': nonnegative,
  'autoTune.activeHighRatio': value => positive(value) && value <= 1,
  'autoTune.activeLowRatio': value => nonnegative(value) && value <= 1,
  'autoTune.sessionUnits': nonnegative, 'autoTune.minutesPerUnit': positive,
  'autoTune.laneUnits': nonnegative, 'autoTune.rebaseUnits': nonnegative,
  mode: value => ['count', 'units'].includes(value),
  population: value => ['all', 'builder'].includes(value),
  openPrCap: value => Number.isSafeInteger(value) && value > 0,
  openPrCapMode: value => ['hard', 'soft'].includes(value),
  softOverCapStarts: value => Number.isSafeInteger(value) && value >= 0,
  loadReducerMaxLoad: nonnegative,
  unitCap: positive, weights: nonnegative, sizeLines: positive,
  acceptedWeight: nonnegative, careMultiplier: nonnegative, roundPenalty: nonnegative,
  'startUnits.unknown': size, 'startUnits.byCardPoints': size, startUnits: size,
  holdLabels: value => Array.isArray(value) && value.every(label => typeof label === 'string' && label.length > 0),
  heldWeight: nonnegative, heldCap: value => Number.isSafeInteger(value) && value >= 0,
  heldStaleH: positive, idleMinPct: value => nonnegative(value) && value <= 100,
  memMinGb: nonnegative, maxStartsPerCheck: value => Number.isSafeInteger(value) && value >= 0,
};

for (const key of ['openPrCap', 'maxStartsPerCheck', 'softOverCapStarts'])
  valid[key] = CAPACITY_LEAVES[`deliveryCapacity.${key}`].validate;

/** Settings IO shell: invalid leaves retain their valid lower layer. */
export function resolveDeliveryCapacity(options = {}) {
  try {
    const { env = process.env, platform, read = readSettings, log } = options;
    let tool;
    try { tool = read()?.deliveryCapacity; } catch { /* retain lower layers */ }
    return cascadePolicy('deliveryCapacity', tool, {
      standard: DELIVERY_CAPACITY_DEFAULTS, platform, env, log, valid,
      envValues: { mode: env?.WE_DELIVERY_CAPACITY_MODE,
        ...Object.fromEntries(['openPrCap', 'maxStartsPerCheck', 'softOverCapStarts'].map(key => {
          const raw = env?.[`WE_DELIVERY_CAPACITY_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`];
          return [key, raw === undefined || raw === '' ? undefined : Number(raw)];
        })) },
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

export function weighPr(pr, policy, nowMs = Date.now()) {
  let p = DELIVERY_CAPACITY_DEFAULTS;
  try {
    p = policyValue(policy);
    const labels = Array.isArray(pr?.labels) ? pr.labels.map(label => typeof label === 'string' ? label : label?.name) : [];
    if (p.holdLabels.some(label => labels.includes(label))) {
      const updatedMs = typeof pr?.updatedAt === 'string' ? Date.parse(pr.updatedAt) : NaN;
      if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs) || nowMs - updatedMs > p.heldStaleH * 3600000) {
        return { ...baseWeight(pr, p), kind: 'held stale' };
      }
      return { units: p.heldWeight, kind: 'held', held: true, accepted: false };
    }
    if (labels.includes(ACCEPTED_LABEL)) return { units: p.acceptedWeight, kind: 'accepted', held: false, accepted: true };
    return baseWeight(pr, p);
  } catch { return { units: p.weights.M, kind: 'M', held: false, accepted: false }; }
}

const validPrRow = pr => pr !== null && typeof pr === 'object' && !Array.isArray(pr)
  && Number.isInteger(pr.number) && Number.isFinite(pr.number);

const HOLD = 'deliveryCapacity.holdUntil';
const PIN_UNITS = 'deliveryCapacity.pinUnits';
const PIN_UNTIL = 'deliveryCapacity.pinUntil';
const etTime = ms => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(ms)} ET`;
const timeLeft = ms => { const m = Math.max(1, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
/** Pure override resolution: hold > pin; expired or over-cap entries are ignored and reported; unreadable fails closed to a hold. */
export function resolveCapacityOverride(overrides, nowMs, maxHours = OVERRIDE_MAX_HOURS) {
  const notes = [];
  try {
    if (!overrides) return { kind: 'none', notes };
    const bad = !overrides.readable || overrides.invalidPolicies?.some(p => p === '*' || p === 'deliveryCapacity');
    if (bad || !Number.isFinite(nowMs)) {
      return { kind: 'hold', unreadable: true, notes: ['override store unreadable or invalid; failing closed to deliver'] };
    }
    const values = overrides.values ?? {};
    const limit = nowMs + maxHours * 3600000;
    const live = key => {
      const until = values[key];
      if (until === undefined) return undefined;
      if (until > limit) { notes.push(`override ${key} exceeds ${maxHours}h cap; refused`); return key === HOLD ? 'refused' : undefined; }
      if (until <= nowMs) { notes.push(`override expired: ${key}`); return undefined; }
      return until;
    };
    const hold = live(HOLD);
    if (hold === 'refused') return { kind: 'hold', refused: true, notes };
    if (hold !== undefined) {
      const reason = overrides.holdReason ? ` (${overrides.holdReason})` : '';
      return { kind: 'hold', until: hold, notes: [...notes, `HOLD until ${etTime(hold)}${reason}, ${timeLeft(hold - nowMs)} left`] };
    }
    const pinUntil = live(PIN_UNTIL);
    if (pinUntil !== undefined && !Number.isInteger(values[PIN_UNITS])) {
      return { kind: 'hold', refused: true, notes: [...notes, `override ${PIN_UNTIL} has no ${PIN_UNITS}; failing closed to deliver`] };
    }
    if (pinUntil !== undefined) {
      return { kind: 'pin', units: values[PIN_UNITS], until: pinUntil,
        notes: [...notes, `PIN ${values[PIN_UNITS]}u until ${etTime(pinUntil)}, ${timeLeft(pinUntil - nowMs)} left`] };
    }
    return { kind: 'none', notes };
  } catch { return { kind: 'hold', unreadable: true, notes: ['override evidence unreadable; failing closed to deliver'] }; }
}

function assessment(prs, host, policy, sources, fallbackReason, nowMs = Date.now(), override = { kind: 'none', notes: [] }) {
  const breakdown = Object.fromEntries(['cards', 'S', 'M', 'L', 'accepted', 'held'].map(kind =>
    [kind, { n: 0, units: 0, ...(kind === 'held' ? { overflow: 0 } : {}) }]));
  const held = [];
  let weighted = 0;
  for (const pr of prs.filter(validPrRow).sort((a, b) => a.number - b.number)) {
    const weight = weighPr(pr, policy, nowMs);
    if (weight.held) {
      held.push(pr.number);
      if (held.length > policy.heldCap) {
        weight.units = baseWeight(pr, policy).units;
        breakdown.held.overflow++;
      }
    }
    breakdown[weight.kind] ??= { n: 0, units: 0 };
    breakdown[weight.kind].n++;
    breakdown[weight.kind].units += weight.units;
    weighted += weight.units;
  }
  const pinned = override.kind === 'pin' && !fallbackReason;
  const mode = fallbackReason ? 'count' : pinned ? 'units' : policy.mode;
  const used = mode === 'count' ? prs.length : weighted;
  const cap = pinned ? override.units : mode === 'count' ? policy.openPrCap : policy.unitCap;
  const gateOpen = !fallbackReason && nonnegative(host?.idlePct) && host.idlePct <= 100
    && nonnegative(host?.memGb) && host.idlePct >= policy.idleMinPct && host.memGb >= policy.memMinGb;
  const hostReadable = !fallbackReason && nonnegative(host?.idlePct) && host.idlePct <= 100 && nonnegative(host?.memGb);
  // Soft caps apply only to count mode; units mode retains its existing verdict.
  const soft = mode === 'count' && policy.openPrCapMode === 'soft';
  const verdict = !gateOpen ? 'hold' : override.kind === 'hold' || (!soft && used >= cap) ? 'deliver' : 'build';
  const start = mode === 'count' ? 1 : policy.weights[policy.startUnits.unknown];
  const slots = verdict === 'build' && start > 0
    ? Math.max(0, Math.min(policy.maxStartsPerCheck, soft ? (used >= cap ? policy.softOverCapStarts : Math.max(cap - used, policy.softOverCapStarts))
      : Math.floor((cap - used) / start))) : 0;
  const why = [gateOpen ? `gate open (idle ${host.idlePct}% mem ${host.memGb}GB)`
      : hostReadable ? `gate closed (idle ${host.idlePct}% mem ${host.memGb}GB)` : 'gate closed or evidence unreadable',
    `held ${held.length}/${policy.heldCap}; stale threshold ${policy.heldStaleH}h`,
    ...(breakdown.held.overflow ? [`held overflow: ${breakdown.held.overflow} charged at full weight`] : []),
    ...(breakdown['held stale'] ? [`held stale: ${breakdown['held stale'].n} charged at full weight`] : []),
    ...(fallbackReason ? [fallbackReason] : []), ...override.notes];
  return { schema: 'deliveryCapacity.readout.v1', mode, used, cap, slots, verdict, breakdown, held, why,
    host: { idlePct: nonnegative(host?.idlePct) && host.idlePct <= 100 ? host.idlePct : null,
      memGb: nonnegative(host?.memGb) ? host.memGb : null, load1: nonnegative(host?.load1) ? host.load1 : null },
    policy: Object.fromEntries(['openPrCap', 'openPrCapMode', 'softOverCapStarts', 'maxStartsPerCheck',
      'idleMinPct', 'memMinGb', 'mode'].map(key => [key, policy[key]])),
    loadReducerSlot: nonnegative(host?.memGb) && host.memGb >= policy.memMinGb
      && nonnegative(host?.load1) && host.load1 <= policy.loadReducerMaxLoad,
    sources: Object.fromEntries(Object.entries(sources).filter(([key]) => !key.startsWith('autoTune.'))), openCount: prs.length, ...(override.kind !== 'none' ? { override: { kind: override.kind, ...(override.until ? { untilMs: override.until } : {}) } } : {}),
    ...(fallbackReason ? { fallbackReason } : {}) };
}

export function assessCapacity(input = {}) {
  let policy = DELIVERY_CAPACITY_DEFAULTS;
  let sources = standardSources();
  let prs = [];
  try {
    policy = policyValue(input?.policy);
    sources = input?.policy?.sources ?? sources;
    const evidence = input?.prs;
    const nowMs = input?.nowMs ?? Date.now();
    const override = resolveCapacityOverride(input?.overrides, nowMs);
    if (!Array.isArray(evidence)) return assessment([], input?.host, policy, sources, 'PR evidence unreadable; count-mode fallback', nowMs, override);
    prs = Array.from(evidence);
    const failures = [
      ...(prs.some(pr => !validPrRow(pr)) ? ['PR evidence malformed: each row must be an object with a finite integer number'] : []),
      ...(input?.incomplete === true ? ['PR evidence incomplete; inspect full population'] : []),
      ...(input?.discoveryIncomplete === true ? ['PR discovery incomplete; inspect full population'] : []),
      ...(prs.length >= 200 ? ['PR evidence at or above 200-PR limit; inspect full population'] : []),
      ...(input?.fallbackReason ? [input.fallbackReason] : []),
    ];
    if (failures.length) return assessment(prs, input?.host, policy, sources,
      `${failures.join('; ')}${input?.fallbackReason ? '' : '; count-mode fallback'}`, nowMs, override);
    if (policy.population === 'builder') prs = prs.filter(isBuilderPr);
    return assessment(prs, input?.host, policy, sources, undefined, nowMs, override);
  } catch {
    return assessment([], null, DELIVERY_CAPACITY_DEFAULTS, standardSources(), 'Capacity evidence unreadable; count-mode fallback');
  }
}
