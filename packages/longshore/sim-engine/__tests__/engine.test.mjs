// @vitest-environment node
// Engine-only tests: run the engine module in Node, no browser, no DOM.
//   node tests/engine.node.mjs
// 1) the engine reproduces tests/baseline-C3.json (v30.3-C.3 outputs, captured from the C.3 page) to 1e-9:
//    the four plan dates + today, default and Conservative; the 3rd Claude and 2nd Codex dates; Forge B with/without; every placed lever date;
//    saved states of older versions migrate to the same state.
// 2) properties that must hold: Forge B never lowers velocity, levers are placed after their cause, nothing in the engine needs a DOM.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMainThread} from 'node:worker_threads';
import {test as vtest, expect, beforeAll, afterAll} from 'vitest';
import * as E from '../engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), SIM = path.join(HERE, 'fixtures');
const base0 = JSON.parse(fs.readFileSync(path.join(SIM, 'baseline-C3.json'), 'utf8'));
const noClock = fn => { const keep = Date.now; Date.now = () => { throw new Error('the engine read Date.now()'); }; try { return fn(); } finally { Date.now = keep; } };
const test = (name, fn) => vtest(name, () => { const f = []; noClock(() => fn({ok: (c, m) => { if (!c) f.push(m); }})); expect(f.slice(0, 8).join('\n')).toBe(''); });

// same comparison the baseline wants: strings/booleans/null equal, numbers within 1e-9 (absolute, or relative for big values)
const TOL = 1e-9;
function diffs(a, b, p = '', out = []) {
  if (out.length > 20) return out;
  if (typeof a === 'number' && typeof b === 'number') { if (!(Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b)))) out.push(`${p}: ${a} vs ${b}`); }
  else if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b && !(a == null && b == null)) out.push(`${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); }
  else if (Array.isArray(a) !== Array.isArray(b)) out.push(`${p}: array vs object`);
  else { const ks = new Set([...Object.keys(a), ...Object.keys(b)]); for (const k of ks) { if (!(k in a)) out.push(`${p}.${k}: missing in engine`); else if (!(k in b)) out.push(`${p}.${k}: missing in baseline`); else diffs(a[k], b[k], p + '.' + k, out); } }
  return out;
}

// ---- boot the engine the way the page does ----
// v30.3-D.1: the engine reads no clock. Date.now throws here, so any hidden clock read fails a test. The baseline's clock is passed in as `today`.
const BASE_TODAY = '2026-11-16'; const realNow = Date.now;
E.setPS(JSON.parse(fs.readFileSync(path.join(SIM, 'project-settings.json'), 'utf8'))); // the project-settings snapshot, beside the page
const DATES = Object.keys(base0.default.at);

function build(prev, today) {
  // prev given: the page switches to Conservative efficiency on the plan it already has (half-life 6, then renderPlan again): the placed levers carry over
  const s = prev ? prev.s : E.presetToday(); if (!prev) s.route = 'fill';       // page boot with no saved state
  const pl = E.ensurePlan(s, today || BASE_TODAY);
  if (prev) { pl.halfLife = E.PT_HL_CONS; pl.show = 'all'; }                      // the page's Conservative efficiency option
  const base = E.ptBase(s);
  E.ptPrepare(base, pl); E.ptSettle(base, pl, {});                                // renderPlan: prepare, then settle the just-in-time levers
  return {s, pl, base};
}
const snapshot = ({pl, base}) => {
  const at = d => { const X = E.ptXOfDate(pl, E.ptX0(base), d), {r, s} = E.ptRun(base, pl, X, false), h = r.hold || {};
    return {total: r.total, pts: h.pointsDay, plan: r.planTotal, bind: E.limitName(r.binding), tied: (r.tied || []).map(c => E.limitName(c)), H: h.H, H0: h.H0, month: r.month, perPr: r.perPr, waste: s.waste}; };
  const ms = id => (pl.milestones.find(m => m.id === id) || {}).date || null;
  return {start: pl.start, tunedBy: pl.tunedBy, until: E.ptUntil(pl), halfLife: E.ptHL(pl),
    at: Object.fromEntries(DATES.map(d => [d, at(d)])), claude3: ms('m-claude3'), codex2: ms('m-tokens'),
    firstFull: E.ptFirstFull(base, pl), tokenBind: E.ptTokenBind(base, pl), forgeB: E.ptForgeBEffect(base, pl),
    levers: pl.milestones.map(m => ({id: m.id, name: m.name, date: m.date, status: m.status, on: m.on, active: E.ptActive(pl, m), ramp: !!m.ramp, jit: !!m.jit, hw: !!m.hw, lead: m.lead ?? null, buildPts: m.buildPts ?? null}))};
};
const rt = o => JSON.parse(JSON.stringify(o));                                    // JSON round trip: undefined dropped, as in the baseline file
// v30.3-D.1: no module plan state. The plan carries its own context, so plans can be built and read in any order (see the interleave test).
// The C.3 capture used Toronto local midnights, including the spring DST transition.
// Pin that input in this suite's fork; changing TZ in a Vitest worker thread has no effect on Date.
const previousTZ = process.env.TZ;
let def, D, C; beforeAll(() => { process.env.TZ = 'America/Toronto'; noClock(() => { def = build(); D = snapshot(def); C = snapshot(build(def)); }); });
afterAll(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });

test('baseline timezone: Toronto winter and summer offsets are active', ({ok}) => {
  ok(isMainThread, 'the baseline suite must run in a process fork so TZ changes affect Date');
  ok(new Date(2027, 0, 1).getTimezoneOffset() === 300, 'winter offset is not Toronto EST');
  ok(new Date(2027, 6, 1).getTimezoneOffset() === 240, 'summer offset is not Toronto EDT');
});

test('no DOM: the engine ran in Node (no window, document or storage)', ({ok}) => { ok(typeof window === 'undefined' && typeof document === 'undefined' && typeof localStorage === 'undefined', 'a DOM global exists'); ok(typeof E.compute === 'function' && typeof E.ptStateAt === 'function', 'API missing'); });
test('baseline C.3: default plan equals (today, Dec 1, Mar 1, Jun 1, Oct 4)', ({ok}) => { const d = diffs(rt(D.at), base0.default.at, 'at'); ok(!d.length, d.join('\n')); for (const k of ['start', 'tunedBy', 'until', 'halfLife']) ok(D[k] === base0.default[k], `${k}: ${D[k]} vs ${base0.default[k]}`); });
test('baseline C.3: Conservative plan equals (half-life 6)', ({ok}) => { const d = diffs(rt(C.at), base0.conservative.at, 'at'); ok(!d.length, d.join('\n')); ok(C.halfLife === 6, 'half-life ' + C.halfLife); });
test('baseline C.3: 3rd Claude and 2nd Codex dates, first-full day and token-bind day equal', ({ok}) => { for (const [n, X, B] of [['default', D, base0.default], ['conservative', C, base0.conservative]]) { ok(X.claude3 === B.claude3, `${n} 3rd Claude ${X.claude3} vs ${B.claude3}`); ok(X.codex2 === B.codex2, `${n} 2nd Codex ${X.codex2} vs ${B.codex2}`); const d = diffs(rt({f: X.firstFull, t: X.tokenBind}), {f: B.firstFull, t: B.tokenBind}); ok(!d.length, n + ' ' + d.join(' ')); } });
test('baseline C.3: Forge B with/without at Dec 1, peak and Oct 4 equal', ({ok}) => { for (const [n, X, B] of [['default', D, base0.default], ['conservative', C, base0.conservative]]) { const d = diffs(rt(X.forgeB), B.forgeB, n); ok(!d.length, d.join('\n')); } });
test('baseline C.3: every placed lever date, status and switch equal (default and Conservative)', ({ok}) => { for (const [n, X, B] of [['default', D, base0.default], ['conservative', C, base0.conservative]]) { ok(X.levers.length === B.levers.length, `${n}: ${X.levers.length} levers vs ${B.levers.length}`); const d = diffs(rt(X.levers), B.levers, n); ok(!d.length, d.join('\n')); } });
test('baseline C.3: saved states of older versions migrate to the same state', ({ok}) => {
  const names = Object.keys(base0.migrated); ok(names.length >= 4, 'fewer than 4 fixtures in the baseline');
  for (const n of names) {
    const s = JSON.parse(fs.readFileSync(path.join(SIM, n), 'utf8'));
    const fresh = E.applyProject({pools: [], stages: [], providers: [], hosts: [], platform: {}}).pools;           // the page's boot merge once the settings load
    if (!(s.pools || []).length) s.pools = fresh; else for (const q of s.pools) { const f = fresh.find(x => x.id === q.id); if (f && q.slotsTuned === undefined) q.slotsTuned = f.slotsTuned; }
    for (const f of fresh) if (!s.pools.find(x => x.id === f.id)) s.pools.push(f);
    const m = E.migrate(s); delete m.plan; const d = diffs(rt(m), base0.migrated[n], n); ok(!d.length, d.join('\n'));
  } });
test('Forge B: with it, never fewer merged PRs or points a day than without it (Dec 1, peak, Oct 4)', ({ok}) => { for (const k of ['dec', 'peak', 'end']) ok(D.forgeB[k].dpts >= -0.005 * D.forgeB[k].with, `${k} ${D.forgeB[k].date}: ${D.forgeB[k].with} with vs ${D.forgeB[k].without} without`); ok(D.forgeB.dn >= 0 && D.forgeB.dpts >= 0, `end: dn ${D.forgeB.dn}, dpts ${D.forgeB.dpts}`); });
test('levers: the 3rd Claude lands in the week tokens first bind, the 2nd Codex follows it by Feb 28; every active lever is dated inside the plan', ({ok}) => {
  const dd = (new Date(D.claude3) - new Date(D.tokenBind.date)) / 864e5; ok(dd >= 0 && dd <= 7, `3rd Claude ${D.claude3} vs tokens bind ${D.tokenBind.date}`);
  ok(D.codex2 >= D.claude3 && D.codex2 <= '2027-02-28', `2nd Codex ${D.codex2} (3rd Claude ${D.claude3})`);
  for (const m of D.levers) if (m.active && m.date) ok(m.date >= '2026-11-15' && m.date <= D.until, `${m.id} dated ${m.date}, outside the plan ${D.start} to ${D.until}`); });
test('levers: a just-in-time lever is dated after the date it answers (not before the plan starts) and Studio-first holds (Studio before cancel Forge A)', ({ok}) => { const g = id => (D.levers.find(m => m.id === id) || {}).date; ok(g('m-studio') <= g('m-cancel-forge'), `Studio ${g('m-studio')} vs cancel Forge A ${g('m-cancel-forge')}`); for (const m of D.levers) if (m.jit && m.date) ok(m.date >= D.start, `${m.id} ${m.date} before ${D.start}`); });
test('compute is pure: same inputs give identical results, and the input is not changed', ({ok}) => { const s = E.presetToday(); s.route = 'fill'; const j = JSON.stringify(s), a = E.compute(s), b = E.compute(E.clone(s)); ok(JSON.stringify(s) === j, 'compute changed its input'); ok(a.total === b.total && a.total > 0, `${a.total} vs ${b.total}`); });

test('clock is an input: ensurePlan/newPlan need `today`, take it from the caller, and never read Date.now', ({ok}) => {
  let threw = false; try { E.ensurePlan(E.presetToday()); } catch (e) { threw = /today/.test(String(e)); } ok(threw, 'ensurePlan without today did not throw');
  for (const t of ['2026-11-15', '2026-12-31', '2027-03-01']) { const s = E.presetToday(); s.route = 'fill'; const pl = E.ensurePlan(s, t); ok(pl.start === t && pl.milestones[0].date === t, `start ${pl.start} for today ${t}`); }
  const ms = new Date(2026, 10, 15, 23, 59).getTime(); const s2 = E.presetToday(); ok(E.ensurePlan(s2, ms).start === '2026-11-15', 'ms input'); });
test('plan input is explicit: two plans built and read interleaved give the same numbers as read one at a time', ({ok}) => {
  const A = build(), dA = snapshot(A), B = build({s: JSON.parse(JSON.stringify(A.s))}), dB = snapshot(B), dA2 = snapshot(A);   // B is a separate plan (a copy of A's state turned Conservative); A is read again after B was built
  const d1 = diffs(rt(dA2.at), rt(dA.at), 'A'); ok(!d1.length, d1.join('\n')); const d2 = diffs(rt(dB.at), base0.conservative.at, 'B'); ok(!d2.length, d2.join('\n')); ok(!('_cx' in JSON.parse(JSON.stringify(A.pl))), 'the plan context leaked into JSON'); });
test('real date: a plan started on any real day builds and settles (nothing depends on the day the suite runs)', ({ok}) => {
  const today = new Date(realNow()), iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  for (const t of [iso, '2026-12-20', '2027-02-10']) { const b = build(null, t); const r = E.ptRun(b.base, b.pl, E.ptXOfDate(b.pl, E.ptX0(b.base), t)).r; ok(b.pl.start === t && r.total > 0, `${t}: start ${b.pl.start}, total ${r.total}`); ok(b.pl.milestones.every(m => !m.date || (m.date >= '2026-11-01')), t + ' dated before the model'); } });



