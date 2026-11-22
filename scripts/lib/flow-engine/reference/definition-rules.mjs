// Cross-field rules for flow/definition v0.1. Each returns [] (ok) or a list of problems; every problem names its
// requirement as (FLOW-DEF-0NN). Names match the "rule:<name>" targets in vectors/vectors.json. Ported from
// standards/drafts/tools/flow-rules.mjs (decision-lifecycle v0) and made recursive over compound states (FLOW-DEF-014).
// Rules never throw on malformed input (tools/lint.mjs runs them on unconverted v0 files). Read-only.
const NONADV = new Set(['wait', 'retry', 'escalate', 'fail']);
const STEP = new Set(['compute', 'judge', 'confirm', 'effect']);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const arr = (x) => (Array.isArray(x) ? x : []);
const ons = (s) => arr(s?.on);

// every state in the tree: { name, state, scope (sibling map), parent (compound name or null), depth }
function walk(f) {
  const out = [];
  (function rec(states, parent) { for (const [name, state] of Object.entries(obj(states))) { out.push({ name, state: obj(state), scope: states, parent }); if (state?.kind === 'compound') rec(state.states, name); } })(f?.states, null);
  return out;
}
const scopes = (f) => [{ states: obj(f?.states), initial: f?.initial, owner: null }, ...walk(f).filter((x) => x.state.kind === 'compound').map((x) => ({ states: obj(x.state.states), initial: x.state.initial, owner: x.name }))];
const findState = (f, name) => walk(f).find((x) => x.name === name);

// successor graph inside one scope: transitions, timeout targets, and retry exhaustion (top scope only)
function graph(f, sc) {
  const succ = new Map(Object.keys(sc.states).map((k) => [k, []]));
  const add = (k, t, route) => { if (succ.has(t)) succ.get(k).push({ to: t, route }); };
  for (const [k, s] of Object.entries(sc.states)) {
    for (const t of ons(s)) add(k, t?.target, t?.route);
    if (s?.timeout?.onTimeout) add(k, s.timeout.onTimeout.target, s.timeout.onTimeout.route);
    const retries = ons(s).some((t) => t?.route === 'retry') || s?.timeout?.onTimeout?.route === 'retry';
    if (retries && sc.owner === null && f?.retry?.onExhausted) add(k, f.retry.onExhausted, 'exhausted');
  }
  return succ;
}
const reach = (from, nb) => { const seen = new Set(from), st = [...from]; while (st.length) for (const m of nb(st.pop()) ?? []) if (!seen.has(m)) { seen.add(m); st.push(m); } return seen; };

// Tarjan SCC; returns the set of nodes on a cycle (ignoring wait/retry self-edges: same visit)
function cyclic(succ) {
  let i = 0; const idx = new Map(), low = new Map(), on = new Set(), st = [], out = new Set();
  const edges = (v) => succ.get(v).filter((e) => !(e.to === v && ['wait', 'retry'].includes(e.route))).map((e) => e.to);
  const sc = (v) => {
    idx.set(v, i); low.set(v, i); i++; st.push(v); on.add(v);
    for (const w of edges(v)) { if (!idx.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
    if (low.get(v) === idx.get(v)) { const comp = []; let w; do { w = st.pop(); on.delete(w); comp.push(w); } while (w !== v); if (comp.length > 1 || edges(v).includes(v)) comp.forEach((c) => out.add(c)); }
  };
  for (const v of succ.keys()) if (!idx.has(v)) sc(v);
  return out;
}
const partsOf = (key) => [...String(key ?? '').matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]);
const advanceTargets = (s) => new Set(ons(s).filter((t) => t?.route === 'advance' && t?.outcome !== 'unknown').map((t) => t.target));
const EXPR = [/\$\{/, /\$\(/, /^\s*\.[A-Za-z_$][\w.$]*\s*(==|!=|<=|>=|<|>|\||and\b|or\b)/, /\|\s*(select|map|length|test|any|all)\b/, /\b(select|map)\s*\(\s*\./];
const EXPR_KEYS = new Set(['if', 'when', 'unless', 'expression', 'expr', 'condition', 'exceptWhen']);

export function makeRules() {
  const r = {
    // FLOW-DEF-002 (+014 recursion)
    targetsResolve: (f) => {
      const out = [], all = walk(f), seen = new Map();
      for (const x of all) { if (seen.has(x.name)) out.push(`state name ${x.name} used twice (in ${seen.get(x.name) ?? 'top'} and ${x.parent ?? 'top'}); run records name states, so names are unique (FLOW-DEF-002)`); seen.set(x.name, x.parent); }
      for (const sc of scopes(f)) if (!sc.states[sc.initial]) out.push(`initial ${sc.initial} is not a state of ${sc.owner ?? 'the flow'} (FLOW-DEF-002${sc.owner ? ', FLOW-DEF-014' : ''})`);
      for (const x of all) {
        const tag = x.parent ? 'FLOW-DEF-002, FLOW-DEF-014' : 'FLOW-DEF-002';
        for (const t of ons(x.state)) {
          if (!x.scope[t?.target]) out.push(`${x.name} -> ${t?.target}: no such state in its scope (${tag})`);
          if (t?.guard && !obj(f?.guards)[t.guard]) out.push(`${x.name}: guard ${t.guard} not declared (${tag})`);
        }
        const to = x.state.timeout?.onTimeout?.target; if (to !== undefined && !x.scope[to]) out.push(`${x.name}: timeout target ${to} not in its scope (${tag})`);
        const cs = x.state.compensate?.step; if (cs !== undefined && !obj(f?.compensation?.steps)[cs]) out.push(`${x.name}: compensation step ${cs} not declared (${tag})`);
      }
      if (f?.retry?.onExhausted !== undefined && !obj(f?.states)[f.retry.onExhausted]) out.push(`retry.onExhausted ${f.retry.onExhausted} is not a top-level state (FLOW-DEF-002)`);
      return out;
    },
    // FLOW-DEF-004, FLOW-DEF-005
    outcomesRouted: (f) => {
      const out = [];
      for (const { name: k, state: s } of walk(f)) {
        const byEv = new Map(); for (const t of ons(s)) { const e = t?.event ?? 'done'; (byEv.get(e) ?? byEv.set(e, []).get(e)).push(t); }
        for (const [e, ts] of byEv) {
          for (const t of ts) if (!t?.route) out.push(`${k}/${e}: transition to ${t?.target} has no route (FLOW-DEF-005)`);
          const gs = new Set(ts.map((t) => t?.guard)); if (gs.size > 1) { out.push(`${k}/${e}: mixed guards (FLOW-DEF-004)`); continue; }
          const g = [...gs][0];
          if (!g) { if (ts.length > 1) out.push(`${k}/${e}: ${ts.length} unguarded transitions (FLOW-DEF-004)`); continue; }
          const decl = arr(obj(f?.guards)[g]?.outcomes);
          for (const o of decl) { const n = ts.filter((t) => t?.outcome === o).length; if (n !== 1) out.push(`${k}/${e}: guard ${g} outcome ${o} routed ${n} times (FLOW-DEF-004)`); }
          for (const t of ts) {
            if (!decl.includes(t?.outcome)) out.push(`${k}/${e}: outcome ${t?.outcome} not declared by ${g} (FLOW-DEF-004)`);
            if (t?.outcome === 'unknown' && !NONADV.has(t?.route)) out.push(`${k}/${e}: unknown routed as ${t?.route ?? 'none'} (FLOW-DEF-005)`);
          }
        }
      }
      return out;
    },
    // FLOW-DEF-006, FLOW-DEF-007 (+014: each compound scope on its own)
    reachableAndLive: (f) => {
      const out = [];
      for (const sc of scopes(f)) {
        const succ = graph(f, sc), names = Object.keys(sc.states), where = sc.owner ? ` in ${sc.owner} (FLOW-DEF-014)` : '';
        const fwd = reach(sc.states[sc.initial] ? [sc.initial] : [], (n) => succ.get(n)?.map((e) => e.to));
        for (const k of names) if (!fwd.has(k)) out.push(`unreachable: ${k}${where} (FLOW-DEF-006)`);
        const exits = names.filter((k) => sc.states[k]?.kind === 'final' || (sc.owner && (ons(sc.states[k]).some((t) => t?.route === 'retry') || sc.states[k]?.timeout?.onTimeout?.route === 'retry')));
        const pred = new Map(names.map((k) => [k, []])); for (const [k, es] of succ) for (const e of es) pred.get(e.to)?.push(k);
        const live = reach(exits, (n) => pred.get(n));
        for (const k of names) if (!live.has(k)) out.push(`dead end (cannot reach a final state): ${k}${where} (FLOW-DEF-007)`);
        if (!names.some((k) => sc.states[k]?.kind === 'final')) out.push(`no final state${where || ' in the flow'} (FLOW-DEF-007)`);
      }
      return out;
    },
    // FLOW-DEF-018
    retryBounded: (f) => {
      const uses = walk(f).some((x) => ons(x.state).some((t) => t?.route === 'retry') || x.state.timeout?.onTimeout?.route === 'retry');
      if (!uses) return [];
      if (!f?.retry) return ['retry routes are used but the flow declares no retry bound and onExhausted (FLOW-DEF-018)'];
      return obj(f.states)[f.retry.onExhausted] ? [] : [`retry.onExhausted ${f.retry.onExhausted} is not a state (FLOW-DEF-018)`];
    },
    // FLOW-DEF-009
    keysDeclared: (f) => {
      const out = [], parts = obj(f?.keys?.parts), seen = new Map();
      if (!f?.keys) out.push('the flow declares no step key shape (keys) (FLOW-DEF-009)');
      const steps = [...walk(f).filter((x) => STEP.has(x.state.kind)).map((x) => [x.name, x.state.key]), ...Object.entries(obj(f?.compensation?.steps)).map(([n, s]) => [`compensation ${n}`, s?.key])];
      for (const [n, key] of steps) {
        if (typeof key !== 'string') { out.push(`${n}: step has no key (FLOW-DEF-009)`); continue; }
        for (const p of partsOf(key)) if (!parts[p]) out.push(`${n}: key part {${p}} is not declared in keys.parts (FLOW-DEF-009)`);
        if (seen.has(key)) out.push(`${n}: key ${key} is also the key of ${seen.get(key)}; step keys are unique (FLOW-DEF-009)`); seen.set(key, n);
      }
      return out;
    },
    // FLOW-DEF-010
    visitInKeyOnCycle: (f) => {
      const out = [], parts = obj(f?.keys?.parts), hot = new Set();
      for (const sc of scopes(f)) for (const n of cyclic(graph(f, sc))) hot.add(n);
      for (const x of walk(f)) if (x.parent && hot.has(x.parent)) hot.add(x.name); // children of a re-entered compound are re-entered
      for (const x of walk(f)) {
        if (!STEP.has(x.state.kind) || !hot.has(x.name)) continue;
        if (!partsOf(x.state.key).some((p) => parts[p]?.kind === 'visit')) out.push(`${x.name}: can be re-entered but its key ${x.state.key ?? '(none)'} has no visit part (FLOW-DEF-010)`);
      }
      return out;
    },
    // FLOW-DEF-011
    waitsTimed: (f) => {
      const out = [], need = new Map(), all = walk(f);
      const want = (n, why) => { if (!need.has(n)) need.set(n, why); };
      for (const x of all) {
        if (x.state.kind === 'confirm') want(x.name, 'confirm step');
        for (const t of ons(x.state)) {
          if (t?.route === 'wait') want(t.target, t.target === x.name ? 'waits on itself' : `wait target of ${x.name}`);
          if (t?.outcome === 'unknown' && t?.route !== 'retry') want(t.target, `entered on unknown from ${x.name}`);
        }
      }
      for (const [n, why] of need) { const x = findState(f, n); if (x && x.state.kind !== 'final' && !x.state.timeout) out.push(`${n} (${why}) has no timer with an owner and a routed timeout (FLOW-DEF-011)`); }
      for (const x of all) if (x.state.timeout && !(x.state.timeout.owner?.uri && x.state.timeout.owner?.digest)) out.push(`${x.name}: timer has no owner by URI and digest (FLOW-DEF-011)`);
      return out;
    },
    // FLOW-DEF-012
    timeoutNeverApproves: (f) => {
      const out = [];
      for (const x of walk(f)) {
        const to = x.state.timeout?.onTimeout; if (!to) continue;
        if (!NONADV.has(to.route)) out.push(`${x.name}: timeout routes as ${to.route ?? 'none'}; a timeout is unknown(not-run) and never advances (FLOW-DEF-012)`);
        if (advanceTargets(x.state).has(to.target)) out.push(`${x.name}: timeout goes to ${to.target}, where a passing result goes; a timeout never approves (FLOW-DEF-012)`);
      }
      return out;
    },
    // FLOW-DEF-013 (+004 for confirm events)
    approvalRouted: (f) => {
      const out = [];
      for (const x of walk(f)) {
        if (x.state.kind !== 'confirm') continue;
        const c = obj(x.state.confirm), k = x.name, g = c.approvalCheck, outs = arr(c.outcomes);
        if (!(c.approvers?.uri && c.approvers?.digest)) out.push(`${k}: approvers not declared by governance URI and digest (FLOW-DEF-013)`);
        if (!(arr(c.excludes).includes('author') && arr(c.excludes).includes('preparers'))) out.push(`${k}: approvers must exclude the author and the preparers (FLOW-DEF-013)`);
        if (c.bindsSubjectVersion !== true) out.push(`${k}: approval does not bind the exact version (FLOW-DEF-013)`);
        if (c.onSilence !== 'stay-blocked') out.push(`${k}: silence must stay blocked (FLOW-DEF-013)`);
        if (!g || !obj(f?.guards)[g]) { out.push(`${k}: no approvalCheck naming a declared guard (FLOW-DEF-013)`); continue; }
        const go = arr(f.guards[g].outcomes); for (const o of ['pass', 'fail', 'unknown']) if (!go.includes(o)) out.push(`${k}: approval check ${g} has no ${o} outcome (FLOW-DEF-013)`);
        for (const t of ons(x.state)) {
          const m = /^confirm\.(.+)$/.exec(t?.event ?? '');
          if (!m) out.push(`${k}: transition on ${t?.event ?? 'done'}; a confirm step advances only on a decider outcome (FLOW-DEF-013)`);
          else if (!outs.includes(m[1])) out.push(`${k}: ${t.event} is not a declared outcome (FLOW-DEF-013)`);
          if (t?.guard !== g) out.push(`${k}: ${t?.event} not guarded by the approval check ${g} (FLOW-DEF-013)`);
        }
        for (const o of outs) for (const v of ['pass', 'fail', 'unknown']) if (ons(x.state).filter((t) => t?.event === `confirm.${o}` && t?.outcome === v).length !== 1) out.push(`${k}: confirm.${o} / ${v} not routed exactly once (FLOW-DEF-013)`);
      }
      return out;
    },
    // FLOW-DEF-015
    subflowPinned: (f) => {
      const out = [], invs = [...walk(f).map((x) => [x.name, x.state.invoke]), ...Object.entries(obj(f?.compensation?.steps)).map(([n, s]) => [`compensation ${n}`, s?.invoke])];
      for (const [n, inv] of invs) {
        if (!inv) continue;
        if (inv.where === 'subflow' && !inv.flow) out.push(`${n}: sub-flow invoked without its id (FLOW-DEF-015)`);
        if ((inv.where === 'subflow' || inv.flow) && !(inv.digest && Object.keys(inv.digest).length)) out.push(`${n}: sub-flow invoked without a digest (FLOW-DEF-015)`);
        if (inv.flow && !/^\d+\.\d+\.\d+/.test(String(inv.flow.version ?? ''))) out.push(`${n}: sub-flow version ${inv.flow.version ?? '(none)'} is not exact; never latest (FLOW-DEF-015)`);
      }
      return out;
    },
    // FLOW-DEF-003
    noExpressions: (f) => {
      const out = [];
      (function scan(v, p) {
        if (typeof v === 'string') { if (EXPR.some((re) => re.test(v))) out.push(`${p || '/'}: "${v.slice(0, 60)}" is an expression; flows name checks instead (FLOW-DEF-003)`); return; }
        if (Array.isArray(v)) return v.forEach((x, i) => scan(x, `${p}/${i}`));
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (EXPR_KEYS.has(k)) out.push(`${p}/${k}: condition field; flows name checks instead (FLOW-DEF-003)`); scan(x, `${p}/${k}`); }
      })(f, '');
      return out;
    },
    // FLOW-DEF-017: replay a compensation log. input { onFailure?, completed: [{step, dependsOn?}], undo: [{step, outcome}] }
    compensationReverse: (log) => {
      const out = [], mode = log?.onFailure ?? 'halt-dependents', done = arr(log?.completed), undo = arr(log?.undo);
      const deps = new Map(done.map((c) => [c.step, arr(c.dependsOn)]));
      const want = [], halted = new Set(), got = new Map(undo.map((u) => [u.step, u.outcome]));
      for (const c of [...done].reverse()) {
        if (halted.has(c.step)) continue;
        want.push(c.step);
        const o = got.get(c.step); if (o === 'pass') continue; // unknown or missing counts as failed
        if (mode === 'halt') break;
        if (mode === 'halt-dependents') { const st = [...(deps.get(c.step) ?? [])]; while (st.length) { const d = st.pop(); if (!halted.has(d)) { halted.add(d); st.push(...(deps.get(d) ?? [])); } } }
      }
      const seq = undo.map((u) => u.step);
      if (JSON.stringify(seq) !== JSON.stringify(want)) out.push(`undo ran [${seq}], expected [${want}] (reverse completion order, ${mode}; an unknown undo counts as failed) (FLOW-DEF-017)`);
      for (const u of undo) if (!['pass', 'fail', 'unknown'].includes(u.outcome)) out.push(`undo of ${u.step}: outcome ${u.outcome} is not pass, fail or unknown (FLOW-DEF-017)`);
      return out;
    },
    // FLOW-DEF-020 (+005, 012, 013, 009): input { definition, records }
    runConforms: ({ definition: f, records }) => {
      const out = [], trs = arr(records).filter((x) => x?.predicate?.kind === 'x-flow-transition'), bodies = new Map();
      const leaf = (n) => { let x = findState(f, n); while (x?.state.kind === 'compound') x = findState(f, x.state.initial); return x?.name; };
      let prev = null;
      trs.forEach((rec, i) => {
        const n = obj(rec.predicate.native), at = `record seq ${n.seq}`;
        if (n.seq !== i + 1) out.push(`${at}: expected seq ${i + 1}; seq goes up by 1 (FLOW-DEF-020)`);
        if (n.flow !== f?.id) out.push(`${at}: flow ${n.flow} is not ${f?.id} (FLOW-DEF-020)`);
        const exp = prev === null ? leaf(f?.initial) : leaf(prev.to);
        const parentOfPrev = prev && findState(f, prev.to)?.state.kind === 'final' ? findState(f, prev.to)?.parent : null;
        if (n.from !== exp && n.from !== parentOfPrev) out.push(`${at}: from ${n.from}, but the run is in ${exp} (FLOW-DEF-020)`);
        const x = findState(f, n.from);
        if (!n.route) out.push(`${at}: no route recorded (FLOW-DEF-005)`);
        if (n.outcome === 'unknown' && n.route === 'advance') out.push(`${at}: unknown advanced (FLOW-DEF-005)`);
        if (!x) out.push(`${at}: state ${n.from} is not in the definition (FLOW-DEF-020)`);
        else if (n.event === 'timeout') {
          const to = x.state.timeout?.onTimeout;
          if (!to) out.push(`${at}: ${n.from} has no timer (FLOW-DEF-020)`);
          else if (to.target !== n.to || to.route !== n.route) out.push(`${at}: timeout went ${n.route} to ${n.to}, the definition says ${to.route} to ${to.target} (FLOW-DEF-020)`);
          if (n.outcome !== 'unknown' || n.reason !== 'not-run') out.push(`${at}: a timeout is recorded as unknown(not-run) (FLOW-DEF-012)`);
        } else {
          const ok = ons(x.state).some((t) => t.event === n.event && t.guard === n.guard && t.outcome === n.outcome && t.route === n.route && (t.target === n.to || (t.route === 'retry' && n.to === f?.retry?.onExhausted)));
          if (!ok) out.push(`${at}: ${n.from} --${n.event}/${n.guard ?? '-'}:${n.outcome ?? '-'}/${n.route}--> ${n.to} is not a transition of the definition (FLOW-DEF-020)`);
        }
        if (/^confirm\./.test(n.event ?? '') && !n.subjectVersion) out.push(`${at}: approval does not name the exact subject version (FLOW-DEF-013)`);
        const body = rec.predicate.result?.digest; const bk = `${n.key}#${n.attempt ?? 1}`;
        if (body) { const b = JSON.stringify(body); if (bodies.has(bk) && bodies.get(bk) !== b) out.push(`${at}: key ${n.key} (attempt ${n.attempt ?? 1}) already has a different body (FLOW-DEF-009, FLOW-DEF-020)`); bodies.set(bk, b); }
        prev = n;
      });
      return out;
    },
    // FLOW-DEF-016: input { log: [{ op, digest, definition }] } in publish order
    supersedeOnly: ({ log }) => {
      const out = [], last = new Map();
      for (const [i, e] of arr(log).entries()) {
        if (e?.op !== 'publish') { out.push(`entry ${i}: op ${e?.op}; a flow version is superseded, never deleted or edited in place (FLOW-DEF-016)`); continue; }
        const d = obj(e.definition), name = `${d.document?.namespace}/${d.document?.name}`, p = last.get(name);
        if (p) {
          if (d.id === p.definition.id || d.document?.version === p.definition.document?.version) out.push(`entry ${i}: ${name} republished under the same id or version (FLOW-DEF-016)`);
          if (!d.supersedes) out.push(`entry ${i}: new version of ${name} does not name what it supersedes (FLOW-DEF-016)`);
          else if (d.supersedes.id !== p.definition.id || JSON.stringify(d.supersedes.digest) !== JSON.stringify(p.digest)) out.push(`entry ${i}: supersedes ${d.supersedes.id} does not match the previous version's id and digest (FLOW-DEF-016)`);
        }
        last.set(name, e);
      }
      return out;
    },
    // FLOW-DEF-023 (SHOULD)
    interopExactListed: (p) => {
      const out = [], feats = arr(p?.features), diag = arr(p?.lossReport?.diagnostics);
      for (const x of arr(p?.exact)) if (!feats.includes(x)) out.push(`exact feature ${x} is not in the listed features (FLOW-DEF-023)`);
      for (const x of feats) if (!arr(p?.exact).includes(x) && !diag.some((d) => d.feature === x)) out.push(`feature ${x} is not exact and has no loss-report row (FLOW-DEF-023)`);
      for (const d of diag) if (arr(p?.exact).includes(d.feature) && d.disposition !== 'native') out.push(`feature ${d.feature} is listed exact but reported ${d.disposition} (FLOW-DEF-023)`);
      return out;
    },
  };
  // the definition-level rules, in order (tools/lint.mjs and rule:sound)
  r.sound = (f) => DEF_RULES.flatMap((n) => r[n](f));
  return r;
}
export const DEF_RULES = ['targetsResolve', 'outcomesRouted', 'reachableAndLive', 'retryBounded', 'keysDeclared', 'visitInKeyOnCycle', 'waitsTimed', 'timeoutNeverApproves', 'approvalRouted', 'subflowPinned', 'noExpressions'];
