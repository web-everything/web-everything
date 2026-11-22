import { assertFlow, canonicalJSON } from './load.mjs';

// Projection: {flowDigest, seq, records: Transition[], event?, outcome?, parts, attempt?}.
// Only records through seq are evidence; time and guard results are caller inputs.
export function plan(flow, projection) {
  assertFlow(flow);
  const p = JSON.parse(canonicalJSON(projection)), def = flow.definition;
  if (p.flowDigest !== flow.digest || !Number.isSafeInteger(p.seq) || p.seq < 0 || !Array.isArray(p.records)) throw Error('Pinned digest and projection@seq required');
  const records = p.records.map(r => r.predicate ?? r).filter(r => r.seq <= p.seq);
  if (records.length !== p.seq) throw Error('Incomplete projection: supply contiguous transition records or escalate to operator');
  let from = def.initial;
  const bodies = new Map();
  const limit = def.retry?.maxAttempts ?? def.retry?.limit?.attempt?.count;
  for (const [i, r] of records.entries()) {
    if (r.seq !== i + 1 || r.flow !== def.id || r.flowDigest?.sha256 !== flow.digest || r.from !== from) throw Error('Invalid replay sequence/digest/state');
    const t = def.states[from].on?.find(t => t.event === r.event && (t.guard ?? null) === r.guard && (t.outcome ?? null) === r.outcome && t.route === r.route && t.target === r.to);
    if (!t || (r.outcome === 'unknown' && r.route === 'advance') || typeof r.key !== 'string') throw Error('Undeclared replay transition');
    const attempt = r.attempt === undefined ? 1 : r.attempt; // Historical records were first attempts.
    if (!Number.isSafeInteger(attempt) || attempt < 1 || (limit !== undefined && attempt > limit)) throw Error('Invalid replay attempt; operator review required');
    const execution = canonicalJSON([r.key, attempt]), body = canonicalJSON(r);
    if (bodies.has(execution) && bodies.get(execution) !== body) throw Error('Step key/attempt has a second body; operator review required');
    bodies.set(execution, body);
    from = r.to;
  }
  const state = def.states[from];
  if (state.kind === 'final' || !p.event) return [];
  const candidates = (state.on ?? []).filter(t => t.event === p.event);
  if (!candidates.length) throw Error('Undeclared event');
  const guarded = !!candidates[0].guard;
  const outcome = guarded ? (p.outcome ?? 'unknown') : null;
  const t = candidates.find(t => (t.outcome ?? null) === outcome);
  if (!t) throw Error('Undeclared outcome');
  if (p.attempt !== undefined && (!Number.isSafeInteger(p.attempt) || p.attempt < 1)) throw Error('Invalid attempt');
  const attempt = p.attempt ?? 1;
  // Exhaustion is handled by the existing actor; never invent an undeclared route.
  if (limit !== undefined && attempt > limit) throw Error(`Retry exhausted: actor must escalate to ${def.retry.onExhausted}`);
  const key = state.key.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name) => {
    if (!Object.hasOwn(p.parts ?? {}, name) || !['string', 'number'].includes(typeof p.parts[name]) || String(p.parts[name]).length === 0) throw Error(`Missing key part ${name}`);
    return encodeURIComponent(String(p.parts[name]));
  });
  if (bodies.has(canonicalJSON([key, attempt]))) throw Error('Step key/attempt already recorded; supply the next retry attempt or a new declared visit');
  return [{ key, from, event: t.event, guard: t.guard ?? null, outcome, route: t.route, to: t.target, attempt }];
}
