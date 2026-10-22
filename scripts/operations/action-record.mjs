/** #3383 — Pure resource identity and action lifecycle. Expiry is suspicion, never proof of death. */
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Read, not `import … with { type: 'json' }`: on Node 22.1 a JSON-module import prints an ExperimentalWarning on
// every process that loads this module, ahead of a daemon's own output (build-dispatch-daemon's boot test).
const sweptRepos = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/swept-repos.json'), 'utf8'));
export class CoordinationUnavailableError extends Error {
  constructor(path, cause) {
    super(`Coordination unavailable at ${path}: ${cause?.message ?? cause}`, { cause });
    this.name = 'CoordinationUnavailableError';
    this.code = 'COORDINATION_UNAVAILABLE';
  }
}
export const ACTION_STATES = ['intent', 'dispatching', 'observed', 'terminal'];
export const LEASE_MS = 10 * 60_000;
export const ABSENCE_GRACE_MS = 15 * 60_000;
export const milliseconds = (value) => typeof value === 'function' ? milliseconds(value()) : value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number(value);
/** Preserve synchronous shell callers while allowing asynchronous injected readers. */
export function withResult(value, onValue, onError = (error) => { throw error; }) {
  try {
    return value && typeof value.then === 'function' ? value.then(onValue).catch(onError) : onValue(value);
  } catch (error) { return onError(error); }
}
/** The operator CLI alone supplies this explicit, audited exception to normal terminal outcomes. */
export function isOperatorResolution(evidence) {
  return typeof evidence?.operatorResolved?.reason === 'string' && !!evidence.operatorResolved.reason.trim()
    && Number.isFinite(evidence.operatorResolved.at);
}
export function normalizeRepo(repo) {
  const value = String(repo ?? '').trim();
  const meta = CONSTELLATION_REPOS[value] ?? Object.values(CONSTELLATION_REPOS).find((r) => r.slug === value || r.dirs.includes(value));
  const slug = sweptRepos.find((r) => r === value || (meta && (r === meta.slug || r.split('/')[1] === meta.slug)));
  if (!slug) throw new TypeError(`Unknown coordination repo: ${value}`);
  return slug;
}
function normalizeSubject(subject) {
  let id = String(subject?.id ?? '').trim().replace(/^#\s*/, '').toLowerCase();
  if (!['item', 'pr'].includes(subject?.type) || !/^[\w.-]+$/.test(id)) throw new TypeError('Invalid action subject');
  if (/^\d+$/.test(id)) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new TypeError('Invalid numeric subject');
    id = String(Number(id));
  } else if (subject.type === 'pr') throw new TypeError('PR subject must be a positive integer');
  return { type: subject.type, id };
}
export function actionResource(repo, subject) {
  const canonical = normalizeSubject(subject);
  return `${normalizeRepo(repo)}#${canonical.type}:${canonical.id}`;
}
export function parseResource(resource) {
  const match = String(resource).match(/^(.+)#(item|pr):([\w.-]+)$/);
  if (!match) throw new TypeError(`Invalid action resource: ${resource}`);
  const subject = normalizeSubject({ type: match[2], id: match[3] });
  const repo = normalizeRepo(match[1]);
  return { resource: actionResource(repo, subject), repo, subject };
}
export function isExpired(record, now) {
  const age = milliseconds(now) - milliseconds(record.heartbeatAt);
  return age >= 0 && age > record.leaseMs;
}
export function transitionRecord(record, { token, from, to, patch = {}, rev = record.rev }, now) {
  if (record.ownerToken !== token) return { ok: false, reason: 'owner-lost' };
  if (record.rev !== rev) return { ok: false, reason: 'stale-rev' };
  if (record.state !== from) return { ok: false, reason: 'wrong-state' };
  const legal = { intent: ['dispatching', 'terminal'], dispatching: ['observed', 'terminal'], observed: ['terminal'], terminal: [] };
  if (!legal[from]?.includes(to)) return { ok: false, reason: 'illegal-transition' };
  if (to === 'terminal' && !(isOperatorResolution(patch.evidence) && ['settled', 'abandoned-absent'].includes(patch.outcome)) && !({ intent: ['abandoned-absent', 'not-started'], dispatching: ['abandoned-absent', 'not-started'], observed: ['settled'] }[from]?.includes(patch.outcome))) return { ok: false, reason: 'illegal-outcome' };
  if (to === 'observed' && (typeof patch.handle !== 'string' || !patch.handle.trim())) return { ok: false, reason: 'missing-handle' };
  const at = milliseconds(now);
  return { ok: true, record: { ...record, ...patch, state: to, rev: record.rev + 1, updatedAt: at,
    history: [...record.history, { state: to, at, owner: patch.owner ?? record.owner }] } };
}
export function assertActionRecord(record) {
  const identity = parseResource(record?.resource);
  if (record.version !== 1 || identity.resource !== record.resource || identity.repo !== record.repo
    || JSON.stringify(identity.subject) !== JSON.stringify(record.subject)
    || !Number.isInteger(record.attempt) || record.attempt < 1 || !Number.isInteger(record.rev) || record.rev < 1
    || !ACTION_STATES.includes(record.state) || !record.ownerToken || !record.owner || !record.kind
    || !Number.isFinite(record.heartbeatAt) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
    || !Number.isFinite(record.leaseMs) || !(record.leaseMs > 0) || !Array.isArray(record.history) || !record.history.length
    || record.history.some((h) => !ACTION_STATES.includes(h.state) || !Number.isFinite(h.at) || !h.owner)
    || record.history[0]?.state !== 'intent' || record.rev < record.history.length
    || record.history.at(-1)?.state !== record.state
    || (record.state === 'terminal' && !isOperatorResolution(record.evidence) && ((record.outcome === 'settled') !== (record.history.at(-2)?.state === 'observed')))
    || !Object.hasOwn(record, 'evidence') || !Object.hasOwn(record, 'handle') || !Object.hasOwn(record, 'outcome')
    || (record.state !== 'terminal' && record.outcome !== null)
    || (record.state === 'intent' && record.dispatchingSince !== null)
    || (record.state === 'dispatching' && !Number.isFinite(record.dispatchingSince))
    || (record.state === 'observed' && (typeof record.handle !== 'string' || !record.handle.trim()))
    || (record.state === 'terminal' && !['settled', 'not-started', 'abandoned-absent'].includes(record.outcome))) throw new TypeError('Invalid action record');
  return record;
}
/** Ports answer arrays of matching agents and { found:boolean, handle? }; unusable evidence holds. */
export function reconcile(record, { listAgents, findEffect, now, absenceGraceMs = ABSENCE_GRACE_MS }) {
  if (!isExpired(record, now)) return { outcome: 'indeterminate' };
  if (record.state === 'intent' && record.dispatchingSince === null) return { outcome: 'effect-absent', evidence: { neverDispatching: true } };
  try {
    return withResult(listAgents(record), (agents) => withResult(findEffect(record), (effect) => {
      if (!Array.isArray(agents) || agents.some((a) => !a || typeof a !== 'object' || !(a.handle || a.sessionId || a.resource || a.name))
        || typeof effect?.found !== 'boolean') return { outcome: 'indeterminate' };
      const found = agents.find((a) => a.resource === record.resource || (record.handle && [a.handle, a.sessionId].includes(record.handle)) || (record.evidence?.sessionSlug && a.name === record.evidence.sessionSlug));
      const handle = [effect.found ? effect.handle : null, found?.handle, found?.sessionId].find((h) => typeof h === 'string' && h.trim());
      if (handle) return { outcome: 'effect-found', handle, evidence: { agents, effect } };
      if (found || effect.found || record.state === 'observed') return { outcome: 'indeterminate' };
      const age = milliseconds(now) - milliseconds(record.dispatchingSince);
      return Number.isFinite(record.dispatchingSince) && age >= absenceGraceMs
        ? { outcome: 'effect-absent', evidence: { agents, effect, absenceGraceMs } } : { outcome: 'indeterminate' };
    }), () => ({ outcome: 'indeterminate' }));
  } catch { return { outcome: 'indeterminate' }; }
}
