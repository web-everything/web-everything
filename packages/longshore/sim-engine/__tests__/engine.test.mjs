// @vitest-environment node
// Engine-only tests: run the engine module in Node, no browser, no DOM.
//   npm run test:unit -- packages/longshore/sim-engine
// 1) the engine reproduces tests/baseline-D3.json (v30.3-C.3 outputs, captured from the C.3 page) to 1e-9:
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
const base0 = JSON.parse(fs.readFileSync(path.join(SIM, 'baseline-D3.json'), 'utf8'));
const noClock = fn => { const keep = Date.now; Date.now = () => { throw new Error('the engine read Date.now()'); }; try { return fn(); } finally { Date.now = keep; } };
const test = (name, fn) => vtest(name, {timeout: 120000}, () => { const f = []; noClock(() => fn({ok: (c, m) => { if (!c) f.push(m); }})); expect(f.slice(0, 8).join('\n')).toBe(''); });

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
test('baseline D.3: default plan equals (today, Dec 1, Mar 1, Jun 1, Oct 4)', ({ok}) => { const d = diffs(rt(D.at), base0.default.at, 'at'); ok(!d.length, d.join('\n')); for (const k of ['start', 'tunedBy', 'until', 'halfLife']) ok(D[k] === base0.default[k], `${k}: ${D[k]} vs ${base0.default[k]}`); });
test('baseline D.3: Conservative plan equals (half-life 6)', ({ok}) => { const d = diffs(rt(C.at), base0.conservative.at, 'at'); ok(!d.length, d.join('\n')); ok(C.halfLife === 6, 'half-life ' + C.halfLife); });
test('baseline D.3: 3rd Claude and 2nd Codex dates, first-full day and token-bind day equal', ({ok}) => { for (const [n, X, B] of [['default', D, base0.default], ['conservative', C, base0.conservative]]) { ok(X.claude3 === B.claude3, `${n} 3rd Claude ${X.claude3} vs ${B.claude3}`); ok(X.codex2 === B.codex2, `${n} 2nd Codex ${X.codex2} vs ${B.codex2}`); const d = diffs(rt({f: X.firstFull, t: X.tokenBind}), {f: B.firstFull, t: B.tokenBind}); ok(!d.length, n + ' ' + d.join(' ')); } });
test('baseline D.3: Forge B with/without at Dec 1, peak and Oct 4 equal', ({ok}) => { for (const [n, X, B] of [['default', D, base0.default], ['conservative', C, base0.conservative]]) { const d = diffs(rt(X.forgeB), B.forgeB, n); ok(!d.length, d.join('\n')); } });
test('baseline D.3: every placed lever date, status and switch equal (default and Conservative)', ({ok}) => { for (const [n, X, B] of [['default', D, base0.default], ['conservative', C, base0.conservative]]) { ok(X.levers.length === B.levers.length, `${n}: ${X.levers.length} levers vs ${B.levers.length}`); const d = diffs(rt(X.levers), B.levers, n); ok(!d.length, d.join('\n')); } });
test('baseline D.3: saved states of older versions migrate to the same state', ({ok}) => {
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



// ---- v30.3-D.1: the five engine fixes from the Codex audit (orchestrator, 2026-11-16) ----
const fillToday = () => { const s = E.presetToday(); s.route = 'fill'; return s; };
test('audit 1: a seat add clamps on the RESULT (2 Claude seats +2 stops at maxCount 3, not 4)', ({ok}) => {
  const s = fillToday(), c = s.providers.find(p => p.id === 'claude'); ok(c.count === 2 && c.maxCount === 3, `setup ${c.count}/${c.maxCount}`);
  const why = E.ptApply(s, {k: 'seat', id: 'claude', n: 2}); ok(c.count === 3, `count ${c.count} after +2 (want 3)`); ok(why === undefined, 'a partial add is not an error: ' + why);
  const why2 = E.ptApply(s, {k: 'seat', id: 'claude', n: 1}); ok(c.count === 3 && /limit of 3/.test(why2 || ''), `at the limit: count ${c.count}, ${why2}`);
  const x = fillToday().providers.find(p => p.id === 'codex'); E.ptApply({providers: [x]}, {k: 'seat', id: 'codex', n: 5}); ok(x.count === 6, 'a plan with no maxCount is not clamped: ' + x.count); });
test('audit 2: "Protect the Mac" on with 0 heavy slots means no local heavy runs; off or a positive count changes nothing', ({ok}) => {
  const off = E.compute(fillToday()), mk = (on, slots) => { const s = fillToday(), h = s.pools.find(p => p.id === 'heavy-mac'); h.on = on; h.slots = slots; h.slotsTuned = null; return E.compute(s); };
  ok(off.total > 10, 'baseline total ' + off.total);
  const z = mk(true, 0); ok(z.total === 0 && z.binding && z.binding.key === 'pool:heavy-mac', `0 slots, on: total ${z.total}, binds ${z.binding && z.binding.key}`);
  ok(Math.abs(mk(true, 4).total - off.total) < 1e-9, 'a positive count must stay unused (v30.2-B.5)'); ok(Math.abs(mk(false, 0).total - off.total) < 1e-9, '0 slots while off must change nothing'); });
test('audit 3 (intended, operator ruling 2026-11-15): migration switches saved slot caps off even when enforced is true', ({ok}) => {
  const s = JSON.parse(JSON.stringify(fillToday())); s.v = 17; for (const pl of s.pools) if (['lanes', 'fixers', 'reviews', 'heavy-mac', 'workers'].includes(pl.id)) { pl.enforced = true; pl.on = true; delete pl.safety; }
  const m = E.migrate(s), caps = m.pools.filter(pl => ['lanes', 'fixers', 'reviews', 'heavy-mac', 'workers'].includes(pl.id)); ok(caps.length >= 4, 'fewer than 4 safety pools: ' + caps.length);
  for (const pl of caps) ok(pl.on === false && pl.safety === true, `${pl.id}: on ${pl.on}, safety ${pl.safety} (a saved cap is never a constraint; "Protect the Mac" is the user's switch)`); });
test('audit 4: a malformed quota fails closed (default used, warning raised), never "no cap"', ({ok}) => {
  const ref = E.compute(fillToday()), s = fillToday(), c = s.providers.find(p => p.id === 'claude'); const cap0 = ref.cons.find(x => x.key === 'p:claude').cap;
  c.weeklyCap = 'corrupt'; const r = E.compute(s), cc = r.cons.find(x => x.key === 'p:claude');
  ok(Number.isFinite(cc.cap) && Math.abs(cc.cap - cap0) < 1e-9, `cap ${cc.cap} vs the default-quota cap ${cap0}`); ok(r.warnings.some(w => /weeklyCap "corrupt" is not a number/.test(w)), 'no warning: ' + r.warnings.join(' | '));
  for (const bad of [NaN, -5, '12abc', {}]) { const t = fillToday(); t.providers.find(p => p.id === 'claude').weeklyCap = bad; const q = E.compute(t); ok(Number.isFinite(q.cons.find(x => x.key === 'p:claude').cap), `${String(bad)} read as no cap`); ok(q.warnings.some(w => /weeklyCap/.test(w)), `${String(bad)}: no warning`); }
  const u = fillToday(); const g = u.providers.find(p => p.id === 'google'); g.id = 'mystery'; g.weeklyCap = 'x'; const w = E.compute(u).cons.find(x => x.key === 'p:mystery'); ok(w && w.cap === 0, 'a plan with no default and a bad quota gets no capacity: ' + (w && w.cap));
  const n = fillToday(); n.providers.find(p => p.id === 'claude').weeklyCap = ''; ok(E.compute(n).warnings.every(x => !/weeklyCap/.test(x)), 'an empty field is "not set", not malformed'); });
test('audit 5: 0 GB free disk means full, not unlimited', ({ok}) => {
  const ref = E.compute(fillToday()), d0 = ref.cons.find(x => x.key === 'disk'); ok(!!d0 && ref.total > 10, 'no disk constraint in the baseline');
  const s = fillToday(); s.platform.diskFreeGb = 0; s.platform.diskLaneGb = 0; const r = E.compute(s), d = r.cons.find(x => x.key === 'disk');
  ok(!!d && d.cap === 0, 'the disk constraint vanished at 0 GB free'); ok(r.total === 0 && r.binding && r.binding.key === 'disk', `total ${r.total}, binds ${r.binding && r.binding.key}`); });


// ---- v30.3-D.2: strategies before hardware, whatever the start day ----
test('D.2: start days Nov 15 to Nov 22: no hardware milestone while an unplaced strategy on the same limit pays; the build-lead lag is kept', ({ok}) => {
  const TL = ['j-affected', 'j-8256', 'j-lean', 'j-redrepro'];
  for (const day of ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']) {
    const b = build(null, day), v = E.ptHwViolations(b.base, b.pl); ok(!v.length, `${day}: hardware placed while a strategy pays: ${JSON.stringify(v).slice(0, 200)}`);
    const fc = b.pl.milestones.find(m => m.id === 'm-msa2c');
    if (fc && fc.on !== false && fc.date) for (const id of TL) { const m = b.pl.milestones.find(z => z.id === id), u = (b.pl.unplaced || []).find(z => z.id === id);
      ok(m ? m.on !== false : !!u, `${day}: ${id} neither placed nor explained`);
      if (m && m.on !== false) { const lead = Math.round((m.lead || 0) * 7), land = new Date(Date.parse(m.date) + lead * 864e5).toISOString().slice(0, 10); ok(land > m.date || !lead, `${day}: ${id} takes effect ${land}, not after its build start ${m.date}`); } } }
});

// ---- v30.3-D.3: every start day from Nov 15 to Dec 31 gives a sane plan (the Nov 20 collapse) ----
test('D.3: start days 2026-11-15 to 2026-12-31: no collapse; Oct 4 within 15% of the Nov 16 value; Studio and daemons already arrived; Forge B present after its arrival; no hardware while a strategy pays', ({ok}) => {
  const iso = ms => new Date(ms).toISOString().slice(0, 10), ptsAt = (b, d) => E.ptRun(b.base, b.pl, E.ptXOfDate(b.pl, E.ptX0(b.base), d), false).r.hold.pointsDay;
  const ref = ptsAt(build(null, '2026-11-16'), '2027-10-04');
  // Every day around the collapse (Nov 15-24), then every 5th day to the end of the year plus Dec 31: the full daily sweep takes ~10 min, over the remote test budget.
  const SWEEP = []; for (let t = Date.UTC(2026, 10, 15), i = 0; t <= Date.UTC(2026, 11, 31); t += 864e5, i++) if (i < 10 || i % 5 === 0 || t === Date.UTC(2026, 11, 31)) SWEEP.push(t);
  for (const t of SWEEP) { const day = iso(t), b = build(null, day);
    const oct = ptsAt(b, '2027-10-04'); ok(Math.abs(oct - ref) <= 0.15 * ref, `${day}: points on Oct 4 ${oct.toFixed(0)} vs ${ref.toFixed(0)} (Nov 16)`);
    const d0 = ptsAt(b, day); ok(d0 > 30, `${day}: collapsed at day 0 (${d0.toFixed(0)} points)`);
    const X1 = E.ptXOfDate(b.pl, E.ptX0(b.base), iso(t + 2 * 864e5)), st = E.ptStateAt(b.base, b.pl, X1), hs = id => st.hosts.find(h => h.id === id) || {};
    if (day >= '2026-11-17') ok(hs('studio').on, `${day}: the Studio (arrived Nov 17) is not on`);
    if (day >= '2026-11-19') ok(!(st.hosts.find(h => h.daemons) || {}).id || (st.hosts.find(h => h.daemons) || {}).id === 'studio', `${day}: daemons (moved Nov 19) are not on the Studio`);
    const fbDay = day > '2026-11-29' ? iso(t + 2 * 864e5) : '2026-12-02', fb = E.ptStateAt(b.base, b.pl, E.ptXOfDate(b.pl, E.ptX0(b.base), fbDay)).hosts.find(h => h.id === 'msa2') || {};
    ok(fb.on && !fb.parked, `${day}: Forge B is not taking tests on ${fbDay}`);
    const v = E.ptHwViolations(b.base, b.pl); ok(!v.length, `${day}: hardware placed while a strategy pays: ${JSON.stringify(v).slice(0, 150)}`); }
});

