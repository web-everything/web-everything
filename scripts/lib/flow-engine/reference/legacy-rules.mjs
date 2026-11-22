// Soundness and human-task rules for flow/decision-lifecycle v0. Each returns [] or problems.
const NONADV = new Set(['wait', 'retry', 'escalate', 'fail']);
function graph(f) { const succ = new Map(Object.keys(f.states).map((k) => [k, new Set()])); for (const [k, s] of Object.entries(f.states)) for (const t of s.on ?? []) succ.get(k).add(t.target); if (f.retry && succ.has(f.retry.onExhausted)) for (const [k, s] of Object.entries(f.states)) if ((s.on ?? []).some((t) => t.route === 'retry')) succ.get(k).add(f.retry.onExhausted); return succ; }
const reach = (from, nb) => { const seen = new Set(from), st = [...from]; while (st.length) for (const m of nb(st.pop()) ?? []) if (!seen.has(m)) { seen.add(m); st.push(m); } return seen; };
export const flowRules = {
  targetsResolve: (f) => { const out = []; if (!f.states[f.initial]) out.push(`initial ${f.initial} not a state (FLOW-DL-002)`); for (const [k, s] of Object.entries(f.states)) for (const t of s.on ?? []) { if (!f.states[t.target]) out.push(`${k} -> ${t.target}: no such state (FLOW-DL-002)`); if (t.guard && !f.guards[t.guard]) out.push(`${k}: guard ${t.guard} not declared (FLOW-DL-013)`); } return out; },
  outcomesRouted: (f) => { const out = []; for (const [k, s] of Object.entries(f.states)) { const byEv = new Map(); for (const t of s.on ?? []) { const e = t.event ?? 'done'; (byEv.get(e) ?? byEv.set(e, []).get(e)).push(t); }
    for (const [e, ts] of byEv) { const gs = new Set(ts.map((t) => t.guard)); if (gs.size > 1) { out.push(`${k}/${e}: mixed guards (FLOW-DL-004)`); continue; } const g = [...gs][0]; if (!g) { if (ts.length > 1) out.push(`${k}/${e}: ${ts.length} unguarded transitions (FLOW-DL-004)`); continue; } const decl = f.guards[g]?.outcomes ?? [];
      for (const o of decl) { const n = ts.filter((t) => t.outcome === o).length; if (n !== 1) out.push(`${k}/${e}: guard ${g} outcome ${o} routed ${n} times (FLOW-DL-004)`); }
      for (const t of ts) { if (!decl.includes(t.outcome)) out.push(`${k}/${e}: outcome ${t.outcome} not declared by ${g} (FLOW-DL-004)`); if (t.outcome === 'unknown' && !NONADV.has(t.route)) out.push(`${k}/${e}: unknown routed as ${t.route ?? 'none'} (FLOW-DL-005)`); } } } return out; },
  reachableAndLive: (f) => { const out = [], succ = graph(f); const fwd = reach([f.initial], (n) => succ.get(n)); for (const k of Object.keys(f.states)) if (!fwd.has(k)) out.push(`unreachable: ${k} (FLOW-DL-006)`);
    const finals = Object.keys(f.states).filter((k) => f.states[k].kind === 'final'); const pred = new Map(Object.keys(f.states).map((k) => [k, []])); for (const [k, ss] of succ) for (const m of ss) pred.get(m)?.push(k);
    const live = reach(finals, (n) => pred.get(n)); for (const k of Object.keys(f.states)) if (!live.has(k)) out.push(`dead end (cannot reach a final): ${k} (FLOW-DL-007)`); if (!finals.length) out.push('no final state (FLOW-DL-007)'); return out; },
  humanTask: (f) => { const out = []; for (const [k, s] of Object.entries(f.states)) { if (s.kind !== 'confirm') continue; const c = s.confirm;
    for (const t of s.on) { const m = /^confirm\.(.+)$/.exec(t.event ?? ''); if (!m) out.push(`${k}: transition on ${t.event ?? 'done'} — a human task advances only on a decider outcome (FLOW-DL-008)`); else if (!c.outcomes.includes(m[1])) out.push(`${k}: ${t.event} not a declared outcome (FLOW-DL-008)`); }
    for (const o of c.outcomes) if (!s.on.some((t) => t.event === `confirm.${o}`)) out.push(`${k}: outcome ${o} has no route (FLOW-DL-004)`);
    if (c.role === 'decider' && !(c.excludes.includes('preparers') && c.excludes.includes('author'))) out.push(`${k}: decider task must exclude preparers and author (FLOW-DL-009)`);
    if (c.role === 'decider' && !s.on.filter((t) => /^confirm\.(ratify|reject)$/.test(t.event)).every((t) => t.guard === 'approval-valid')) out.push(`${k}: ratify/reject must pass guard approval-valid (FLOW-DL-009)`); } return out; },
  recordEmits: (f) => Object.values(f.states).some((s) => ['https://everstandards.dev/governance/ruling-record/v0.1', 'https://everstandards.dev/governance/ruling-record/v0'].includes(s.emits)) ? [] : ['no state emits a governance/ruling-record (FLOW-DL-010)'],
  retryBounded: (f) => { const uses = Object.values(f.states).some((s) => (s.on ?? []).some((t) => t.route === 'retry')); return uses && !(f.retry && f.states[f.retry.onExhausted]) ? ['retry routes without a bound and an onExhausted state (FLOW-DL-011)'] : []; },
  compensationSafe: (f) => (f.compensations ?? []).filter((c) => !f.states[c.for]).map((c) => `compensation for unknown state ${c.for} (FLOW-DL-012)`),
};
export const allFlowRules = Object.keys(flowRules);
flowRules.sound = (f) => allFlowRules.flatMap((r) => flowRules[r](f));
