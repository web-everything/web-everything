import { createHash } from 'node:crypto';

const families = ['openai', 'google', 'anthropic'];
const keyLenses = ['correctness', 'security', 'red-team'];
const requiredStrongShapes = ['security', 'merge-path'];
const armId = arm => `${arm.provider}/${arm.model}/${arm.effort}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(s => typeof s === 'string' && s.length);
// Freeze copies only: callers retain ownership of every argument (including legacy routes).
const frozen = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const copyArm = arm => ({ provider: arm.provider, model: arm.model, effort: arm.effort });
// Vendor identity comes from the provider and model, never a roster's family label.
const providerFamilies = { codex: 'openai', openai: 'openai', claude: 'anthropic',
  anthropic: 'anthropic', 'agy-gemini': 'google', gemini: 'google', google: 'google' };
const familyFor = arm => {
  if (!object(arm) || !Object.hasOwn(providerFamilies, arm.provider) || typeof arm.model !== 'string') return null;
  const modelFamily = /^(?:claude-|sonnet(?:-|$)|opus(?:-|$)|haiku(?:-|$))/.test(arm.model) ? 'anthropic'
    : /^(?:gpt-|sol(?:-|$)|luna(?:-|$)|terra(?:-|$)|astra(?:-|$))/.test(arm.model) ? 'openai'
    : /^(?:gemini-|carbon(?:-|$)|hydrogen(?:-|$)|flash(?:-|$))/.test(arm.model) ? 'google' : null;
  const providerFamily = providerFamilies[arm.provider];
  return modelFamily === providerFamily ? providerFamily : null;
};
const validArm = (arm, policy) => object(arm) && ['provider', 'model', 'effort'].every(k =>
  typeof arm[k] === 'string' && arm[k].length && !arm[k].includes('/')) &&
  familyFor(arm) !== null && catalogHas(arm, policy?.catalog);
// Flat triples keep dotted model names as values in settings; injected callers may use a lookup map.
const catalogHas = (arm, catalog) => Array.isArray(catalog)
  ? catalog.some(a => object(a) && a.provider === arm.provider && a.model === arm.model && a.effort === arm.effort)
  : object(catalog) && Object.hasOwn(catalog, arm.provider) && object(catalog[arm.provider]) &&
    Object.hasOwn(catalog[arm.provider], arm.model) && strings(catalog[arm.provider][arm.model]) &&
    catalog[arm.provider][arm.model].includes(arm.effort);
const validKind = (kind, policy) => object(kind) && Array.isArray(kind.arms) && kind.arms.length > 0 &&
  kind.arms.every(a => object(a) && validArm(a.arm, policy) &&
    ['small', 'standard', 'strong'].includes(a.tier) && Number.isFinite(a.share) && a.share > 0) &&
  new Set(kind.arms.map(a => armId(a.arm))).size === kind.arms.length;
const validBounds = policy => object(policy) &&
  Number.isFinite(policy.exhaustedPercent) && policy.exhaustedPercent > 0 && policy.exhaustedPercent <= 100 &&
  Number.isFinite(policy.reserveReleaseHours) && policy.reserveReleaseHours >= 0 &&
  Number.isFinite(policy.reservePercent) && policy.reservePercent >= 0 && policy.reservePercent <= 100;
const validPolicy = policy => object(policy) && ['off', 'shadow', 'on'].includes(policy.mode) &&
  Number.isInteger(policy.minPanelFamilies) && policy.minPanelFamilies >= 2 && policy.minPanelFamilies <= 3 &&
  strings(policy.strongArms) && policy.strongArms.length > 0 && strings(policy.smallTiers) &&
  policy.smallTiers.includes('small') && strings(policy.smallArms) && strings(policy.keyLenses) &&
  keyLenses.every(l => policy.keyLenses.includes(l)) && strings(policy.strongShapes) &&
  requiredStrongShapes.every(s => policy.strongShapes.includes(s)) && validBounds(policy) && object(policy.kinds) &&
  Object.values(policy.kinds).length > 0 && Object.values(policy.kinds).every(k => validKind(k, policy));

// Spare quota per hour, reset floor 15 minutes; each held manual reset adds 25%.
// Unknown, incomplete, unavailable or exhausted capacity contributes zero, never full quota.
const spare = (cap, policy) => {
  if (!object(cap) || cap.available !== true || !Number.isFinite(cap.usedPct) ||
    cap.usedPct < 0 || cap.usedPct >= policy.exhaustedPercent ||
    ['reserve', 'reserved', 'reserveOnly', 'held'].some(k => cap[k] !== undefined && cap[k] !== false) ||
    ['reserve-only', 'exhausted', 'held'].includes(cap.label) || !Number.isFinite(cap.hoursToReset) || cap.hoursToReset < 0 ||
    !Number.isInteger(cap.manualResetsHeld) || cap.manualResetsHeld < 0) return 0;
  const reserve = cap.reservePercent ?? policy.reservePercent;
  if (!Number.isFinite(reserve) || reserve < 0 || reserve > 100) return 0;
  const effectiveUsed = cap.usedPct + (cap.hoursToReset > policy.reserveReleaseHours ? reserve : 0);
  if (effectiveUsed >= 100) return 0;
  const rate = (100 - effectiveUsed) / Math.max(cap.hoursToReset, .25) * (1 + .25 * cap.manualResetsHeld);
  return Number.isFinite(rate) ? rate : 0;
};
export function effectiveShares(kindPolicy, capacity, policy) {
  if (!validBounds(policy) || !validKind(kindPolicy, policy) || !object(capacity)) return frozen([]);
  const weighted = kindPolicy.arms.map(a => ({ ...a, arm: copyArm(a.arm), family: familyFor(a.arm),
    share: a.share * spare(capacity[a.arm.provider], policy) }));
  const total = weighted.reduce((sum, a) => sum + a.share, 0);
  return frozen(weighted.map(a => ({ ...a, share: Number.isFinite(total) && total > 0 ? a.share / total : 0 })));
}
const bucketFor = (kind, subject) => Number(createHash('sha256')
  .update(`rot:${kind}:${subject}`).digest().readBigUInt64BE(0) >> 11n) / 2 ** 53;
const pick = (arms, bucket) => {
  const total = arms.reduce((sum, a) => sum + a.share, 0);
  let edge = 0;
  return arms.find(a => (edge += a.share / total) > bucket) ?? arms.at(-1);
};
export function drawArm({ kind, subject, policy, capacity, exclude = [] } = {}) {
  const result = { arm: null, bucket: null, redrawn: [], mode: policy?.mode ?? null, ineligible: [] };
  const refuse = refusal => frozen({ ...result, refusal });
  if (!validPolicy(policy)) return refuse('invalid-policy');
  if (!Object.hasOwn(policy.kinds, kind)) return refuse('unknown-kind');
  if (typeof subject !== 'string' || !subject.length || !strings(exclude)) return refuse('invalid-input');
  if (!object(capacity)) return refuse('missing-capacity');
  result.bucket = bucketFor(kind, subject);
  let choices = effectiveShares(policy.kinds[kind], capacity, policy);
  result.ineligible = choices.filter(a => !a.share || exclude.includes(armId(a.arm))).map(a => armId(a.arm));
  choices = choices.filter(a => a.share > 0);
  // Re-walk the same bucket after each rejected arm. The finite roster bounds redraws.
  while (choices.length) {
    const chosen = pick(choices, result.bucket);
    const id = armId(chosen.arm);
    if (!exclude.includes(id)) return frozen({ ...result, arm: copyArm(chosen.arm) });
    result.redrawn.push(id);
    choices = choices.filter(a => armId(a.arm) !== id);
  }
  return refuse('no-eligible-arm');
}
const strong = (entry, policy) => {
  const model = entry.arm.model;
  const short = model.replace(/^(?:claude-|gpt-[\d.]+-|gemini-4-)/, '');
  return entry.tier === 'strong' && [armId(entry.arm), model, short,
    `${model}-${entry.arm.effort}`, `${short}-${entry.arm.effort}`].some(id => policy.strongArms.includes(id));
};
const small = (entry, policy) => policy.smallTiers.includes(entry.tier) ||
  /hydrogen|luna|haiku|flash/i.test(entry.arm.model) ||
  policy.smallArms.some(id => id === armId(entry.arm) || id === entry.arm.model ||
    id === entry.arm.model.replace(/^(?:claude-|gpt-[\d.]+-|gemini-4-)/, ''));
const seatKind = lens => lens === 'red-team' ? 'red-team' :
  ['correctness', 'security'].includes(lens) ? `review-${lens}` : 'review-lens';

export function composePanel({ seats, builder, policy, capacity, subject, shape } = {}) {
  const refuse = refusal => frozen({ ok: false, panel: [], refusal });
  if (!validPolicy(policy)) return refuse('invalid-policy');
  if (!object(capacity)) return refuse('missing-capacity');
  // S1.1 has one ordinary shape and the two explicit strong shapes. Unknown shapes wait.
  if (!['normal', ...policy.strongShapes].includes(shape)) return refuse('unknown-shape');
  // Refusal means the PR waits for corrected evidence/operator action; never use a partial panel.
  if (Array.isArray(seats) && seats.length > 16) return refuse('panel-too-large');
  if (!Array.isArray(seats) || !seats.length || !seats.every(s =>
    object(s) && typeof s.lens === 'string' && s.lens.length && typeof s.counting === 'boolean') ||
    !validArm(builder, policy) || typeof subject !== 'string' || !subject.length) return refuse('invalid-input');
  const builderFamily = familyFor(builder);
  if (!builderFamily) return refuse('unknown-builder-family');
  const needsStrong = policy.strongShapes.includes(shape);
  // An explicit malformed/false flag cannot fall through to another true source.
  const carbonPromoted = (policy.carbonPromoted === undefined ? capacity.carbonPromoted : policy.carbonPromoted) === true;
  const candidates = [];
  for (const seat of seats) {
    const kind = seatKind(seat.lens);
    if (!Object.hasOwn(policy.kinds, kind)) return refuse('unknown-kind');
    let eligible = effectiveShares(policy.kinds[kind], capacity, policy).filter(a => a.share > 0);
    if (policy.keyLenses.includes(seat.lens)) {
      eligible = eligible.filter(a => a.family !== builderFamily);
      if (!eligible.length) return refuse('no-cross-vendor-seat');
    }
    if (seat.counting && !carbonPromoted) eligible = eligible.filter(a => !/carbon/i.test(a.arm.model));
    // Security seats and strong shapes admit strong arms only (including excluding Flash).
    if (needsStrong || seat.lens === 'security') {
      eligible = eligible.filter(a => !small(a, policy) && strong(a, policy));
      if (!eligible.length) return refuse('no-strong-seat');
    }
    if (policy.keyLenses.includes(seat.lens)) eligible = eligible.filter(a => !small(a, policy));
    if (!eligible.length) return refuse('no-eligible-arm');
    candidates.push(eligible);
  }
  const counting = seats.filter(s => s.counting).length;
  if (counting < policy.minPanelFamilies) return refuse('single-family-panel');
  // Dynamic programming keeps at most 8 family masks x 2 strong states per seat.
  // Weighted order makes the preferred feasible panel deterministic without exponential search.
  let states = [{ selected: [], mask: 0, hasStrong: false }];
  for (let i = 0; i < seats.length; i++) {
    let remaining = [...candidates[i]];
    const order = [];
    const bucket = bucketFor(seatKind(seats[i].lens), `${subject}:seat:${i}:${seats[i].lens}`);
    while (remaining.length) {
      const chosen = pick(remaining, bucket);
      order.push(chosen);
      remaining = remaining.filter(a => armId(a.arm) !== armId(chosen.arm));
    }
    const next = new Map();
    for (const state of states) for (const a of order) {
      const mask = state.mask | (seats[i].counting ? 1 << families.indexOf(a.family) : 0);
      const hasStrong = state.hasStrong || strong(a, policy);
      const key = `${mask}:${hasStrong}`;
      if (!next.has(key)) next.set(key, { selected: [...state.selected, a], mask, hasStrong });
    }
    states = [...next.values()];
  }
  const winner = states.find(s => s.mask.toString(2).replaceAll('0', '').length >= policy.minPanelFamilies &&
    (!needsStrong || s.hasStrong));
  if (!winner) return refuse('single-family-panel');
  return frozen({ ok: true, panel: winner.selected.map((a, i) =>
    ({ lens: seats[i].lens, arm: copyArm(a.arm) })), refusal: null });
}

export function routeFor({ kind, subject, policy, capacity, legacyRoute } = {}) {
  if (policy?.mode === 'off') return legacyRoute;
  const shadow = drawArm({ kind, subject, policy, capacity });
  // Do not recursively freeze legacyRoute: it must remain caller-owned and byte-identical.
  if (policy?.mode === 'shadow') return Object.freeze({ route: legacyRoute, shadow });
  if (policy?.mode === 'on') return frozen({ route: shadow.arm, shadow: null,
    ...(shadow.refusal ? { refusal: shadow.refusal } : {}) });
  return frozen({ route: null, shadow: null, refusal: 'invalid-policy' });
}
