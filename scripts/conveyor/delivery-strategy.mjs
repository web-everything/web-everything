/**
 * Pure S1 selector ported from ship/working-model v0.1.9 tools/strategy.mjs.
 * Rules and numeric policy values belong to the caller's table and settings.
 * `at` is the recorded decision instant (ISO or epoch seconds), never a clock read.
 * Each observation must attest `fresh: true` and be dated at or before `at`.
 * Freshness windows are evaluated by the evidence producer; S1 refuses stale evidence.
 * S2 contract/dispatch and S3 audit/load lifecycle validation are outside this module.
 */
import { createHash } from 'node:crypto';
export const canon = (x) => Array.isArray(x) ? `[${x.map(canon).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}` : JSON.stringify(x);
export const digestOf = (x) => ({ sha256: createHash('sha256').update(canon(x)).digest('hex') });
// S1 projection of the reference contracts: only their gate effects are needed.
const STRATEGY_EFFECTS = [
  { name: 'normal-pr', feedsGates: true },
  { name: 'prototype-first', feedsGates: false },
  { name: 'build-ahead', feedsGates: true },
  { name: 'stacked', feedsGates: true },
  { name: 'incident', feedsGates: false },
  { name: 'design-pass-first', feedsGates: false },
];
export const SLOT = 'delivery-strategy', CLOSED = 'unhandled', OUTCOMES = ['selected', 'hold', 'unhandled'];
export const REFERENCE = ['normal-pr', 'prototype-first', 'build-ahead', 'stacked', 'incident', 'design-pass-first'];   // examples, not a closed list (SHIP-WM-155)
export const NOT_STRATEGY = ['hold', 'unhandled'];
export const INPUT_TYPES = ['enum', 'boolean', 'count'];
export const CONDS = ['eq', 'in', 'atLeastSetting', 'belowSetting', 'atMostSetting', 'positive'];
export const REASON_CLASSES = ['strategy', 'hold', 'unhandled', 'floor'];
export const AUDIT_STATES = ['pass', 'fail', 'stale', 'delta-owed', 'none'];
// the declared inputs every table carries, with their types (SHIP-WM-158); a table MAY declare more
export const INPUTS = {
  'security-open': { type: 'boolean' }, 'step-kind': { type: 'enum' }, blocker: { type: 'enum', values: ['none', 'stage', 'hold'] },
  'hold-causer': { type: 'boolean' }, 'targets-can-adopt': { type: 'boolean' }, 'overlay-loadable': { type: 'boolean' }, 'live-overlays': { type: 'count' },
  'audit-state': { type: 'enum', values: AUDIT_STATES }, 'loaded-stage-stress': { type: 'enum', values: ['clear', 'stressed'] },
  'stress-incident': { type: 'enum', values: ['none', 'fix-not-landed', 'fix-landed'] }, 'loads-stalled-stage': { type: 'boolean' },
  'free-slots': { type: 'count' }, 'review-rounds': { type: 'count' }, 'non-convergence-evidence': { type: 'boolean' } };
const X = /^x-[a-z][a-z0-9-]*$/, SETTING = /^[a-z][a-z0-9-]*$/, CODE = /^[A-Z][A-Z0-9_]*$/;
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
const secs = (t) => (typeof t === 'number' ? t : typeof t === 'string' && t.trim() ? Date.parse(t) / 1000 : NaN);
const U = Symbol('unknown');
const numbersIn = (x, path = '', skip = []) => (typeof x === 'number' ? [path || '/'] : Array.isArray(x) ? x.flatMap((v, i) => numbersIn(v, `${path}/${i}`, skip)) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => (skip.includes(k) ? [] : numbersIn(v, `${path}/${k}`, skip))) : []);
const isStrategyName = (n) => REFERENCE.includes(n) || X.test(n ?? '');

// ---- condition evaluation over declared inputs and setting values (S1)
const valueOf = (decl, x, at) => {
  if (!x || x.fresh !== true || !Number.isFinite(secs(at)) || !Number.isFinite(secs(x.observedAt)) || secs(x.observedAt) > secs(at) || x.value === undefined || x.value === null || x.value === 'unknown') return U;
  const v = x.value;
  if (decl.type === 'boolean') return typeof v === 'boolean' ? v : U;
  if (decl.type === 'count') return Number.isInteger(v) && v >= 0 ? v : U;
  return (decl.values ?? []).includes(v) ? v : U;                     // a value outside the declared values is contradictory: unknown
};
const settingOf = (settings, n) => { const v = settings?.values?.[n]; return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : U; };
const test = (cond, v, settings) => {
  const [k, arg] = Object.entries(cond)[0];
  if (v === U) return U;
  if (k === 'eq') return v === arg;
  if (k === 'in') return arg.includes(v);
  if (k === 'positive') return v > 0 === arg;
  const s = settingOf(settings, arg); if (s === U) return U;
  return k === 'atLeastSetting' ? v >= s : k === 'belowSetting' ? v < s : v <= s;
};
const SETCMP = ['atLeastSetting', 'belowSetting', 'atMostSetting'];
const byRank = (t) => [...(t.rules ?? [])].sort((a, b) => a.rank - b.rank);

// ---- SHIP-WM-160, 161: the selector. First hit in rank order; unknown is never false; same inputs + same table + same settings => the same output
export function select({ table, settings, inputs, at, strategies = STRATEGY_EFFECTS }) {
  // Load validation is part of selection: an invalid table is unconfigured.
  // Never cache by identity: callers may mutate a table between recorded decisions.
  if (tableFindings({ table, strategies }).length) return {
    rule: 'unconfigured', strategy: CLOSED, build: false,
    reason: 'EVIDENCE_UNKNOWN', evaluated: [], unknown: [],
  };
  const decl = Object.fromEntries((table.inputs ?? []).map((i) => [i.name, i]));
  const val = (n) => (decl[n] ? valueOf(decl[n], inputs?.[n], at) : U);
  const unknown = (table.inputs ?? []).filter((i) => i.required && val(i.name) === U).map((i) => i.name).sort();
  const res = (rule, strategy, reason, evaluated, unk = unknown) => ({ rule, strategy, build: !NOT_STRATEGY.includes(strategy), reason, evaluated, unknown: unk });
  // Counts, budgets and windows must all be configured, including settings not
  // reached by this particular first hit. Invalid values never turn into passes.
  const badSettings = (table.settings ?? []).some((n) => settingOf(settings, n) === U)
    || Object.keys(settings?.values ?? {}).some((n) => settingOf(settings, n) === U);
  if (badSettings) return res(table.onUnknown.rule, CLOSED, table.onUnknown.reason, []);
  if (unknown.length) return res(table.onUnknown.rule, 'unhandled', table.onUnknown.reason, []);
  const evaluated = [];
  for (const r of byRank(table)) {
    const rs = Object.entries(r.when ?? {}).map(([n, c]) => test(c, val(n), settings));
    const result = rs.includes(false) ? 'false' : rs.includes(U) ? 'unknown' : 'match';
    evaluated.push({ rule: r.id, result });
    if (result === 'unknown') return res(table.onUnknown.rule, 'unhandled', table.onUnknown.reason, evaluated, Object.entries(r.when).filter(([n, c]) => val(n) === U || (SETCMP.some((k) => c[k] !== undefined) && settingOf(settings, SETCMP.map((k) => c[k]).find((x) => x !== undefined)) === U)).map(([n]) => n).sort());
    if (result === 'match') return res(r.id, r.output.strategy, r.output.reason, evaluated);
  }
  return res(table.onNoMatch.rule, 'unhandled', table.onNoMatch.reason, evaluated);
}
const requires = (r, n, k, v) => { const c = r.when?.[n]; return !!c && (k === 'eq' ? c.eq === v : k === 'in' ? (c.eq !== undefined ? v.includes(c.eq) : Array.isArray(c.in) && c.in.every((x) => v.includes(x))) : c[k] !== undefined); };

// ---- SHIP-WM-157..160, 164..166, 168, 170, 178: the table at load (S1)
export function tableFindings({ table: t, strategies = STRATEGY_EFFECTS }) {
  const out = [], add = (m, r) => out.push(`table ${t?.name ?? '?'}@${t?.version ?? '?'}: ${m} (SHIP-WM-${r})`);
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(t) || !['inputs', 'settings', 'reasonCodes', 'overrideReasons', 'prototypeStepKinds', 'rules'].every((k) => Array.isArray(t[k]))
    || !object(t.strategies) || !Array.isArray(t.strategies.names)
    || !t.inputs.every((i) => object(i) && nonEmpty(i.name)
      && (i.values === undefined || Array.isArray(i.values))
      && (i.type !== 'enum' || Array.isArray(i.values)))
    || !t.reasonCodes.every(object)
    || !t.rules.every((r) => object(r) && nonEmpty(r.id) && object(r.when) && object(r.output)
      && Object.values(r.when).every(object))) {
    add('incomplete or malformed table shape: refused at load', 158);
    return out;
  }
  if (t?.hitPolicy !== 'first') add(`hit policy ${t?.hitPolicy} is not first: refused at load`, 158);
  if (!nonEmpty(t?.version)) add('the table declares no version: refused at load', 158);
  const decl = Object.create(null); for (const i of t?.inputs ?? []) { if (decl[i.name]) add(`input ${i.name} declared twice: refused`, 159); decl[i.name] = i; if (!INPUT_TYPES.includes(i.type)) add(`input ${i.name} has type ${i.type}: refused`, 159); if (i.type === 'enum' && !(i.values ?? []).length) add(`enum input ${i.name} declares no values: refused`, 159); if (typeof i.required !== 'boolean') add(`input ${i.name} does not say whether it is required: refused`, 159); }
  for (const [n, d] of Object.entries(INPUTS)) { if (!decl[n]) add(`the input ${n} is not declared: refused at load`, 158); else { if (decl[n].type !== d.type) add(`input ${n} has type ${decl[n].type}, not ${d.type}: refused`, 158); for (const x of d.values ?? []) if (!decl[n].values?.includes(x)) add(`input ${n} lacks the value ${x}: refused`, 158); } }
  const settings = new Set(t?.settings ?? []); for (const s of t?.settings ?? []) if (typeof s !== 'string' || !SETTING.test(s)) add(`setting ${s} is not a setting name: refused`, 178);
  const codes = Object.create(null); for (const c of t?.reasonCodes ?? []) { if (codes[c.code]) add(`reason code ${c.code} declared twice: refused`, 159); codes[c.code] = c.class; if (!REASON_CLASSES.includes(c.class)) add(`reason code ${c.code} has class ${c.class}: refused`, 159); if (!CODE.test(c.code ?? '')) add(`reason code ${c.code} is not a code: refused`, 159); }
  if (!(t?.overrideReasons ?? []).length) add('no override reason is declared: refused', 171);
  for (const k of ['onUnknown', 'onNoMatch']) if (!t?.[k] || codes[t[k].reason] !== 'unhandled' || !nonEmpty(t[k].rule)) add(`${k} does not give unhandled with a declared unhandled reason: refused`, 160);
  const set = t?.strategies ?? {}, names = set.names ?? [], byName = Object.fromEntries(strategies.map((c) => [c.name, c]));
  if (typeof set.closed !== 'boolean') add('the strategy set does not say whether it is closed: refused', 155);
  for (const n of names) { if (!isStrategyName(n)) add(`strategy ${n} is neither a reference nor an x- strategy: refused`, 155); const c = byName[n]; if (!c) add(`strategy ${n} has no contract: refused`, 154); else if (typeof c.feedsGates !== 'boolean') add(`strategy ${n} declares no gate effect: refused`, 158); }
  for (const k of t?.prototypeStepKinds ?? []) if (!decl['step-kind']?.values?.includes(k)) add(`prototype step kind ${k} is not a declared step kind: refused`, 165);
  const ranks = Object.create(null), ids = new Set(), rows = t?.rules ?? [];
  for (const r of rows) {
    if (ids.has(r.id)) add(`rule id ${r.id} twice: refused`, 159); ids.add(r.id);
    if (!Number.isInteger(r.rank)) add(`rule ${r.id} has no integer rank: refused`, 159);
    else if (ranks[r.rank]) add(`rules ${ranks[r.rank]} and ${r.id} tie at rank ${r.rank}: refused at load`, 159); else ranks[r.rank] = r.id;
    for (const [n, c] of Object.entries(r.when ?? {})) {
      const d = decl[n], ks = Object.keys(c ?? {});
      if (!d) { add(`rule ${r.id} reads the undeclared input ${n}: refused`, 159); continue; }
      if (ks.length !== 1 || !CONDS.includes(ks[0])) { add(`rule ${r.id}: condition on ${n} is not one of ${CONDS.join(', ')}: refused`, 159); continue; }
      const [k, a] = [ks[0], c[ks[0]]];
      for (const p of numbersIn(c)) add(`rule ${r.id}: a literal number in the condition on ${n} (${p}): every number is a setting, refused`, 178);
      if (['atLeastSetting', 'belowSetting', 'atMostSetting'].includes(k)) { if (d.type !== 'count') add(`rule ${r.id}: ${k} on the non-count input ${n}: refused`, 159); if (typeof a !== 'string' || !settings.has(a)) add(`rule ${r.id}: setting ${a} is not declared: refused`, 159); }
      if (k === 'positive' && (d.type !== 'count' || typeof a !== 'boolean')) add(`rule ${r.id}: positive on ${n} needs a count and a flag: refused`, 159);
      if (k === 'eq' && d.type === 'boolean' && typeof a !== 'boolean') add(`rule ${r.id}: ${n} eq ${a} is not a flag: refused`, 159);
      if (k === 'eq' && d.type === 'enum' && !(d.values ?? []).includes(a)) add(`rule ${r.id}: ${n} eq ${a} is outside its declared values: refused`, 159);
      if (k === 'eq' && d.type === 'count' && typeof a !== 'number') add(`rule ${r.id}: eq on the count ${n}: refused`, 159);
      if (k === 'in' && (d.type !== 'enum' || !Array.isArray(a) || !a.length || a.some((x) => !(d.values ?? []).includes(x)))) add(`rule ${r.id}: ${n} in a list outside its declared values: refused`, 159);
    }
    const o = r.output ?? {};
    if (!names.includes(o.strategy) && !NOT_STRATEGY.includes(o.strategy)) add(`rule ${r.id} gives ${o.strategy}, outside the strategy set: refused`, 159);
    const cls = codes[o.reason], want = NOT_STRATEGY.includes(o.strategy) ? (o.strategy === 'hold' ? ['hold'] : ['unhandled', 'floor']) : ['strategy'];
    if (!cls) add(`rule ${r.id}: reason ${o.reason} is not declared: refused`, 159); else if (!want.includes(cls)) add(`rule ${r.id}: reason ${o.reason} of class ${cls} does not fit ${o.strategy}: refused`, 159);
  }
  const sorted = byRank(t ?? {}), rankOf = (r) => r.rank, stratRows = sorted.filter((r) => names.includes(r.output?.strategy));
  const contract = (r) => byName[r.output?.strategy];
  // 157: the security row
  const sec = sorted.find((r) => requires(r, 'security-open', 'eq', true) && r.output?.strategy === 'unhandled' && codes[r.output?.reason] === 'floor' && Object.keys(r.when ?? {}).length === 1);
  if (!sec) add('no row gives unhandled with a floor reason on an open security finding: refused', 157);
  else for (const r of stratRows) if (rankOf(r) < rankOf(sec)) add(`rule ${r.id} picks a strategy before the security row ${sec.id}: refused`, 157);
  // 164: stop feeding a stalled gate
  const st = sorted.find((r) => requires(r, 'loads-stalled-stage', 'eq', true) && r.output?.strategy === 'hold' && Object.keys(r.when ?? {}).length === 1);
  const clears = (r) => requires(r, 'blocker', 'in', ['stage', 'hold']) && requires(r, 'hold-causer', 'eq', true);
  if (!st) add('no row gives hold to a candidate that loads a stalled stage: refused', 164);
  else for (const r of stratRows) if (contract(r)?.feedsGates === true && !clears(r) && rankOf(r) < rankOf(st)) add(`rule ${r.id} feeds the gates before the stalled-gate row ${st.id}: refused`, 164);
  // 165: prototype-first only for declared kinds, adoption, the exact-revision audit, and under the overlay cap
  for (const r of stratRows.filter((x) => x.output.strategy === 'prototype-first')) {
    if (!(t.prototypeStepKinds ?? []).length || !requires(r, 'step-kind', 'in', t.prototypeStepKinds)) add(`rule ${r.id}: prototype-first not limited to the declared prototype step kinds: refused`, 165);
    if (!requires(r, 'targets-can-adopt', 'eq', true)) add(`rule ${r.id}: prototype-first without targets-can-adopt true: refused`, 165);
    if (!requires(r, 'audit-state', 'eq', 'pass')) add(`rule ${r.id}: prototype-first without audit-state pass at the exact revision: refused`, 165);
    if (!requires(r, 'overlay-loadable', 'eq', true)) add(`rule ${r.id}: prototype-first without overlay-loadable true: refused`, 165);
    if (!requires(r, 'live-overlays', 'belowSetting')) add(`rule ${r.id}: prototype-first without live-overlays below a cap setting: refused`, 165);
  }
  // 166: the incident path, conditioned on adoption (a hold) or on a red interval with its recovery
  for (const r of stratRows.filter((x) => x.output.strategy === 'incident')) {
    const forHold = requires(r, 'blocker', 'eq', 'hold') && requires(r, 'hold-causer', 'eq', true) && requires(r, 'targets-can-adopt', 'eq', false);
    const forRed = decl['red-interval-open'] && decl['red-recovery-candidate'] && requires(r, 'red-interval-open', 'eq', true) && requires(r, 'red-recovery-candidate', 'eq', true);
    if (!forHold && !forRed) add(`rule ${r.id}: incident neither for the hold-causer when the targets cannot adopt nor for a red-interval recovery: refused`, 166);
  }
  // 168: the design pass needs the round setting and evidence
  for (const r of stratRows.filter((x) => x.output.strategy === 'design-pass-first')) if (!requires(r, 'review-rounds', 'atLeastSetting') || !requires(r, 'non-convergence-evidence', 'eq', true)) add(`rule ${r.id}: design-pass-first without rounds at or above a setting and non-convergence evidence: refused`, 168);
  // 170: build-ahead only past a known incident whose fix has landed; every other gate-feeding row keeps SHIP-WM-093
  const stressHold = sorted.find((r) => requires(r, 'loaded-stage-stress', 'eq', 'stressed') && r.output?.strategy === 'hold' && Object.keys(r.when ?? {}).length === 1);
  for (const r of stratRows) {
    if (r.output.strategy === 'build-ahead') { if (!requires(r, 'loaded-stage-stress', 'eq', 'stressed') || !requires(r, 'stress-incident', 'eq', 'fix-landed')) add(`rule ${r.id}: build-ahead without a stressed stage whose incident fix has landed: refused`, 170); continue; }
    if (contract(r)?.feedsGates === true && !requires(r, 'loaded-stage-stress', 'eq', 'clear') && !(stressHold && rankOf(stressHold) < rankOf(r))) add(`rule ${r.id} feeds a stressed stage with no override and no stressed-stage hold before it: refused (SHIP-WM-093 kept)`, 170);
  }
  for (const p of numbersIn(t ?? {}, '', ['rank'])) add(`a literal number at ${p}: every number is a setting, refused`, 178);
  return out;
}

// ---- SHIP-WM-163: candidate order, hold-causer first (S1)
export const candidateOrder = (cands) => [...cands].sort((a, b) => (b.clearsHold === true) - (a.clearsHold === true) || a.planOrder - b.planOrder).map((c) => c.id);
export function orderFindings({ candidates, order }) {
  const want = candidateOrder(candidates);
  return canon(want) === canon(order) ? [] : [`candidate order ${canon(order)} is not hold-causers first then plan order, ${canon(want)}: refused (SHIP-WM-163)`];
}

// ---- SHIP-WM-161, 162, 173: the decision record and its replay (S1)
export const DECISION_FIELDS = ['decisionId', 'at', 'candidate', 'position', 'positionReason', 'inputs', 'table', 'settings', 'evaluated', 'rule', 'strategy', 'build', 'reason', 'unknown', 'actions'];
export function decisionFindings({ record: d, table, settings, strategies = STRATEGY_EFFECTS }) {
  const out = [], add = (m, r) => out.push(`decision ${d?.decisionId ?? '?'}: ${m} (SHIP-WM-${r})`);
  for (const f of DECISION_FIELDS) if (d?.[f] === undefined || d[f] === null) add(`field ${f} is absent: refused`, 162);
  for (const i of table.inputs ?? []) {
    const x = d?.inputs?.[i.name];
    if (!x) { add(`input ${i.name} is not recorded: refused`, 162); continue; }
    if (x.value === undefined) add(`input ${i.name} carries no value (unknown is written as unknown): refused`, 162);
    if (!nonEmpty(x.observedAt)) add(`input ${i.name} carries no observation time: refused`, 162);
    if (!nonEmpty(x.source?.uri) || !x.source?.digest) add(`input ${i.name} carries no source with a digest: refused`, 162);
    if (typeof x.fresh !== 'boolean') add(`input ${i.name} carries no freshness: refused`, 162);
  }
  if (d?.table && (d.table.uri !== table.id || d.table.version !== table.version || canon(d.table.digest) !== canon(digestOf(table)))) add(`pins table ${d.table.version} at a digest that is not the table supplied: replay against the pinned version only, refused`, 173);
  if (d?.settings && (d.settings.revision !== settings.revision || canon(d.settings.digest) !== canon(digestOf(settings.values)))) add('pins a settings revision or digest that is not the one supplied: refused', 162);
  if (!Number.isFinite(secs(d?.at))) add('decision time is invalid: refused', 162);
  if (d?.inputs) {
    const got = select({ table, settings, strategies, inputs: d.inputs, at: d.at }), rec = { rule: d.rule, strategy: d.strategy, build: d.build, reason: d.reason, evaluated: d.evaluated, unknown: d.unknown };
    if (canon(got) !== canon(rec)) add(`records ${canon(rec).slice(0, 160)}, the selector derives ${canon(got).slice(0, 160)}: refused`, 161);
  }
  return out;
}

// ---- SHIP-WM-173: a table change is a new declared version (S1)
export function tableChangeFindings({ from, to }) {
  const out = [], add = (m) => out.push(`table change ${from?.version} -> ${to?.version}: ${m} (SHIP-WM-173)`);
  if (canon(digestOf(from)) === canon(digestOf(to))) return out;
  if (!nonEmpty(to?.version) || from.version === to.version) { add('the content changed under the same version: a silent edit, refused'); return out; }
  if (!to.supersedes || to.supersedes.version !== from.version || canon(to.supersedes.digest) !== canon(digestOf(from))) add('the new version does not name the version and digest it supersedes: refused');
  return out;
}

// ---- the golden replay: decision points, each with its candidates, order and expected outputs
export function replayFindings({ table, settings, points, strategies = STRATEGY_EFFECTS }) {
  const out = [];
  for (const p of points) {
    const order = candidateOrder(p.candidates);
    if (canon(order) !== canon(p.expected.order)) out.push(`${p.at}: order ${canon(order)}, expected ${canon(p.expected.order)} (SHIP-WM-163)`);
    for (const c of p.candidates) {
      const got = select({ table, settings, strategies, inputs: c.inputs, at: p.at }), want = p.expected.outputs[c.id];
      for (const k of ['strategy', 'reason', 'rule']) if (got[k] !== want?.[k]) out.push(`${p.at} ${c.id}: ${k} ${got[k]}, expected ${want?.[k]} (SHIP-WM-160)`);
    }
  }
  return out;
}
