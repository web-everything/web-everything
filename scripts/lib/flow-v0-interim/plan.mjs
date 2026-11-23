import { assertFlow, canonicalJSON } from './load.mjs';

const uri = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(value);
function replayIdentity(record, p) {
  const r = record?.predicate, [subject, diff] = record?.subject ?? [];
  if (record?._type !== 'https://in-toto.io/Statement/v1' || record.predicateType !== 'https://github.com/web-everything/web-everything/blob/main/schemas/flow-v0-interim/v0.1/transition'
    || record.subject.length !== 2 || !/^[^/#]+\/[^/#]+#[1-9][0-9]*$/.test(subject?.name ?? '')
    || subject.uri !== `https://github.com/${subject.name.replace('#', '/pull/')}`
    || !/^[a-f0-9]{40}$/.test(subject.digest?.gitCommit ?? '') || diff?.name !== 'net-diff' || !/^[a-f0-9]{64}$/.test(diff.digest?.sha256 ?? '')
    || !Array.isArray(r?.inputs) || !r.inputs.length || !r.inputs.every(uri)
    || !Number.isFinite(Date.parse(r.at)) || !/^https:\/\/github.com\/web-everything\/web-everything\/blob\/[a-f0-9]{40}\/scripts\/lib\/flow-v0-interim\/plan.mjs$/.test(r.executor ?? '')
    || subject.annotations?.['we.idempotencyKey'] !== `tr:${subject.name}:${r.seq}`
    || subject.annotations?.['we.id'] !== `tag:everstandards.dev,${r.at.slice(0, 10)}:flow-run/we/${subject.name.replace('#', '/')}/t${r.seq}`) throw Error('Invalid replay statement/subject/version/evidence; operator review required');
  if ((p.parts?.Subject !== undefined && String(p.parts.Subject) !== subject.name)
    || (p.repo !== undefined && p.pr !== undefined && `${p.repo}#${p.pr}` !== subject.name)
    || (p.head !== undefined && p.head !== subject.digest.gitCommit) || (p.netDiff !== undefined && p.netDiff !== diff.digest.sha256)
    || (/^confirm\./.test(r.event ?? '') && r.subjectVersion !== subject.digest.gitCommit)) throw Error('Invalid replay subject/version binding; operator review required');
  return canonicalJSON([subject.name, subject.digest, diff.digest]);
}
function checkKey(template, key, subject) {
  const names = [], escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = '', offset = 0;
  for (const m of template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
    pattern += escape(template.slice(offset, m.index)) + '(.+?)'; names.push(m[1]); offset = m.index + m[0].length;
  }
  const match = typeof key === 'string' && new RegExp(`^${pattern}${escape(template.slice(offset))}$`).exec(key), parts = {};
  if (!match) throw Error('Invalid replay key template');
  for (const [i, name] of names.entries()) {
    let value;
    try { value = decodeURIComponent(match[i + 1]); } catch { throw Error('Invalid replay key encoding'); }
    if (encodeURIComponent(value) !== match[i + 1] || (Object.hasOwn(parts, name) && parts[name] !== value)
      || (name === 'Subject' && value !== subject)) throw Error('Invalid replay key binding');
    parts[name] = value;
  }
}
function retryContinuity(previous, key, attempt, limit, exhausted) {
  if (previous?.route !== 'retry') return;
  const next = (previous.attempt ?? 1) + 1;
  if (limit !== undefined && next > limit) throw Error(`Retry exhausted: actor must escalate to ${exhausted}`);
  if (key !== previous.key || attempt !== next) throw Error('Retry continuity: key/attempt already recorded or changed; preserve key and supply the next retry attempt');
}

// Projection: {flowDigest, seq, records: Transition[], event?, outcome?, parts, attempt?}.
// Only records through seq are evidence; time and guard results are caller inputs.
export function plan(flow, projection) {
  assertFlow(flow);
  const p = JSON.parse(canonicalJSON(projection)), def = flow.definition;
  if (p.flowDigest !== flow.digest || !Number.isSafeInteger(p.seq) || p.seq < 0 || !Array.isArray(p.records)) throw Error('Pinned digest and projection@seq required');
  const records = p.records.filter(r => (r.predicate?.seq ?? r.seq) <= p.seq);
  if (records.length !== p.seq) throw Error('Incomplete projection: supply contiguous transition records or escalate to operator');
  let from = def.initial, identity, previous;
  const bodies = new Map();
  const limit = def.retry?.maxAttempts ?? def.retry?.limit?.attempt?.count;
  for (const [i, record] of records.entries()) {
    const current = replayIdentity(record, p), r = record.predicate;
    if (identity !== undefined && identity !== current) throw Error('Invalid replay subject/version continuity');
    identity = current;
    if (r.seq !== i + 1 || r.flow !== def.id || r.flowDigest?.sha256 !== flow.digest || r.from !== from) throw Error('Invalid replay sequence/digest/state');
    const t = def.states[from].on?.find(t => t.event === r.event && (t.guard ?? null) === r.guard && (t.outcome ?? null) === r.outcome && t.route === r.route && t.target === r.to);
    if (!t || (r.outcome === 'unknown' && r.route === 'advance') || typeof r.key !== 'string') throw Error('Undeclared replay transition');
    checkKey(def.states[from].key, r.key, record.subject[0].name);
    const attempt = r.attempt === undefined ? 1 : r.attempt; // Historical records were first attempts.
    if (!Number.isSafeInteger(attempt) || attempt < 1 || (limit !== undefined && attempt > limit)) throw Error('Invalid replay attempt; operator review required');
    const execution = canonicalJSON([r.key, attempt]), body = canonicalJSON(r);
    if (bodies.has(execution) && bodies.get(execution) !== body) throw Error('Step key/attempt has a second body; operator review required');
    retryContinuity(previous, r.key, attempt, limit, def.retry?.onExhausted);
    bodies.set(execution, body);
    if (r.route === 'advance') from = r.to;
    previous = r;
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
  retryContinuity(previous, key, attempt, limit, def.retry?.onExhausted);
  if (bodies.has(canonicalJSON([key, attempt]))) throw Error('Step key/attempt already recorded; supply the next retry attempt or a new declared visit');
  return [{ key, from, event: t.event, guard: t.guard ?? null, outcome, route: t.route, to: t.target, attempt }];
}
