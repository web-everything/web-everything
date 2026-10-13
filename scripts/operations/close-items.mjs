/** Declared batch retirement. Pure plans; IO and guarded writes live in close-items-io. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { applyTransition } from '../backlog/frontmatter.mjs';
import { isTerminalStatus } from '../lib/backlog-status.cjs';
import { buildPriorityPlacement } from '../lib/build-queue.mjs';
import { normNum, removeFromQueue } from '../conveyor/queue-store.mjs';

export const CLOSE_ITEMS_OP = 'close-items';
export const CLOSE_ITEMS_EFFECT = 'close-items.write';
export const CLOSED_REASONS = ['duplicate', 'fixed-elsewhere', 'obsolete', 'wont-do'];
export const CATEGORIES = { DUPLICATE: 'duplicate', 'ALREADY-FIXED': 'fixed-elsewhere', OBSOLETE: 'obsolete', 'LOW-VALUE': 'wont-do' };
export const CLOSE_ITEMS_REFUSALS = Object.freeze(['not-found', 'on-priority', 'in-flight', 'already-terminal',
  'open-pr', 'live-dependent', 'open-children', 'bad-pointer', 'pack-not-fold', 'transition-refused', 'open-pr-check-unavailable']);
const fail = (reason, detail) => { throw Object.assign(new Error(detail), { reason }); };
export const splitIds = (ids) => [...new Set(String(ids ?? '').split(',').map(normNum).filter(Boolean))];
export function cardIndex(cards) {
  return new Map(cards.flatMap(c => [c.id, c.num, c.bornAs].filter(x => x != null && x !== '').map(x => [normNum(x), c])));
}
export function closeRequests(input, triage) {
  if (input.triage) {
    if (input.ids || input.reason || input.into || input.by) fail('invalid-input', 'triage/category and ids/reason/into/by are exclusive modes');
    if (!Object.hasOwn(CATEGORIES, input.category)) fail('invalid-category', 'category must be DUPLICATE, ALREADY-FIXED, OBSOLETE or LOW-VALUE; KEEP cannot close');
    if (!Array.isArray(triage?.rows)) fail('invalid-input', 'triage must contain rows');
    const rows = triage.rows.filter(r => r.bucket === input.category);
    const seen = new Set();
    return rows.filter(r => { const id = normNum(r.num); if (!id) fail('invalid-input', 'triage row needs num'); if (seen.has(id)) return false; seen.add(id); return true; }).map(r => ({
      id: normNum(r.num), reason: CATEGORIES[input.category],
      into: input.category === 'DUPLICATE' ? r.dupOf : undefined,
      by: input.category === 'ALREADY-FIXED' ? evidencePointer(r.evidence) : undefined,
      refusal: input.category === 'DUPLICATE' && r.outcome !== 'fold' ? (r.outcome === 'pack' ? 'pack-not-fold' : 'transition-refused') : undefined,
    }));
  }
  if (input.category || !splitIds(input.ids).length || !CLOSED_REASONS.includes(input.reason)) fail('invalid-input', 'ids and a valid close reason are required');
  return splitIds(input.ids).map(id => ({ id, reason: input.reason, into: input.into || undefined, by: input.by || undefined }));
}
export function evidencePointer(evidence) {
  return String(evidence ?? '').trim().match(/^(?:[0-9a-f]{7,40}(?![0-9a-f])|#\d+\b|PR\s*#?\d+\b|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\b)/i)?.[0];
}
export function planCloseItems(read, input = {}) {
  const requests = closeRequests(input, read.triage);
  const unavailable = read.openPrs?.unavailable || read.openPrs?.partial?.length;
  if (input.apply && unavailable) fail('open-pr-check-unavailable', 'Cannot apply: open PR check unavailable or incomplete');
  const index = cardIndex(read.cards);
  const priority = new Map((read.priority ?? []).map((x, i) => [normNum(x), i]));
  const openPrs = new Set((read.openPrs?.nums ?? []).map(normNum));
  const requestedCards = new Set(requests.map(r => index.get(r.id)).filter(Boolean));
  const refused = [], candidates = new Map();
  const refuse = (r, refusal, detail) => refused.push({ id: r.id, refusal, detail });
  for (const r of requests) {
    const c = index.get(r.id), target = index.get(normNum(r.into));
    let why = r.refusal;
    if (!why && !c) why = 'not-found';
    if (!why && buildPriorityPlacement(c, priority, index).buildPriorityIndex !== null) why = 'on-priority';
    if (!why && ['active', 'preparing'].includes(c.status)) why = 'in-flight';
    if (!why && isTerminalStatus(c.status)) why = 'already-terminal';
    if (!why && openPrs.has(normNum(c.num))) why = 'open-pr';
    if (!why && r.reason === 'duplicate' && (!target || target === c || target.status === 'closed' || requestedCards.has(target))) why = 'bad-pointer';
    if (why) { refuse(r, why, `Cannot close ${r.id}: ${why}`); continue; }
    const into = r.into == null ? undefined : String(target?.num ?? r.into);
    const res = applyTransition(c.content, 'close', { today: read.today, reason: r.reason, into, by: r.by });
    if (res.error) { refuse(r, 'transition-refused', res.error); continue; }
    candidates.set(c, { r, c, content: res.content, into });
  }
  // A refused member is outside the effective batch. Cascade until every survivor is safe.
  let changed;
  do {
    changed = false;
    for (const [c, entry] of candidates) {
      const outside = read.cards.filter(x => !isTerminalStatus(x.status) && !candidates.has(x));
      const dependent = outside.find(x => (x.blockedBy ?? []).some(id => index.get(normNum(id)) === c));
      const child = outside.find(x => index.get(normNum(x.parent)) === c);
      if (dependent || child) {
        refuse(entry.r, dependent ? 'live-dependent' : 'open-children', `Live card ${dependent?.num ?? child.num} remains outside the batch`);
        candidates.delete(c); changed = true;
      }
    }
  } while (changed);
  const writes = [...candidates.values()].map(({ c, content }) => ({ abs: c.abs, rel: c.file, content, ids: [c.num, c.bornAs].filter(Boolean) }));
  let queue = read.queue ?? [];
  for (const w of writes) for (const id of w.ids) queue = removeFromQueue(queue, id);
  const byRefusal = {};
  for (const r of refused) byRefusal[r.refusal] = (byRefusal[r.refusal] ?? 0) + 1;
  const output = { dryRun: !input.apply, ...(input.category ? { category: input.category } : {}),
    reason: input.reason || CATEGORIES[input.category],
    counts: { requested: requests.length, [input.apply ? 'closed' : 'wouldClose']: writes.length, refused: refused.length, byRefusal },
    closed: [...candidates.values()].map(({ r, c, into }) => ({ id: r.id, file: c.file, closedReason: r.reason,
      ...(into !== undefined ? { closedInto: into } : {}), ...(r.by !== undefined ? { closedBy: r.by } : {}) })), refused,
    queueRemoved: (read.queue ?? []).filter(e => !queue.some(q => normNum(q.num) === normNum(e.num))).map(e => e.num),
    ...(unavailable ? { warnings: ['open-pr-check-unavailable'] } : {}),
  };
  return { output, writes, audit: { actor: read.actor, channel: read.channel, reason: output.reason, ids: requests.map(r => r.id), note: input.note || '' } };
}
export function closeItemsOperation({ readCloseItemsContext } = {}) {
  return batchOperation(CLOSE_ITEMS_OP, CLOSE_ITEMS_EFFECT, readCloseItemsContext, planCloseItems, {
    ids: optionalString(), reason: { type: 'string', required: false, enum: CLOSED_REASONS }, triage: optionalString(),
    category: { type: 'string', required: false, enum: Object.keys(CATEGORIES) }, into: optionalString(), by: optionalString(), note: optionalString(),
  });
}
export const optionalString = () => ({ type: 'string', required: false, default: '' });
export function batchOperation(name, effectType, reader, planner, fields) {
  if (typeof reader !== 'function') throw new TypeError(`${name}: needs an injected context reader`);
  const input = { ...fields, apply: { type: 'boolean', required: false, default: false } };
  const reads = Object.keys(input).map(k => `input.${k}`);
  return op(name, { input, verdictFrom: 'result',
    read: compute({ reads, fn: v => reader(v.input) }),
    plan: compute({ reads: [...reads, 'findings.read'], fn: v => planner(v.findings.read, v.input) }),
    result: compute({ reads: ['findings.plan'], fn: v => v.findings.plan.output }),
    write: effect({ reads: ['input.apply', 'findings.plan'], effects: v => v.input.apply && v.findings.plan.writes.length
      ? [{ type: effectType, idempotent: true, payload: v.findings.plan }] : [] }),
  });
}
