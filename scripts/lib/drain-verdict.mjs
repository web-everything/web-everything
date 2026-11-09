import { createHash } from 'node:crypto';
import { GATE_IDS } from './merge-gate-inventory.mjs';

export const SCHEMA = 'drain-verdict/1';
export const LOCAL_REQUIRED = Object.freeze(['red-main-freeze', 'card-group']);
const DECISIONS = ['enqueue', 'hold', 'local'];
const BINDINGS = ['headSha', 'mainSha', 'gateTree', 'settingsDigest', 'inputsDigest'];

/** Canonical JSON for JSON values only; unsupported evidence must never disappear silently. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new TypeError('non-JSON verdict evidence');
}

export const digest = obj => createHash('sha256').update(canonicalJson(obj)).digest('hex');

/** Tamper evidence over the decision-bearing body: decision, gates, localRequired, actions. */
export const verdictDigest = v => digest({ decision: v.decision, gates: v.gates, localRequired: v.localRequired, actions: v.actions });

export function build(inputs) {
  if (!DECISIONS.includes(inputs?.decision)) throw new TypeError('invalid decision');
  for (const field of ['repo', 'codeSha', 'computedAt', ...BINDINGS]) {
    if (typeof inputs[field] !== 'string' || !inputs[field].trim()) throw new TypeError(`missing ${field}`);
  }
  if (!Number.isSafeInteger(inputs.pr) || inputs.pr <= 0) throw new TypeError('invalid pr');
  if (!Number.isFinite(Date.parse(inputs.computedAt))) throw new TypeError('invalid computedAt');
  if (!Array.isArray(inputs.gates) || !Array.isArray(inputs.actions)) throw new TypeError('missing gates/actions');
  const seen = new Set();
  for (const gate of inputs.gates) {
    if (!GATE_IDS.includes(gate.id) || seen.has(gate.id) || typeof gate.result !== 'string' ||
      !gate.result || typeof gate.evidence !== 'string') throw new TypeError('invalid gates');
    seen.add(gate.id);
  }
  const gates = inputs.gates.filter(g => !LOCAL_REQUIRED.includes(g.id));
  for (const id of LOCAL_REQUIRED) gates.push({ id, result: 'unknown', evidence: 'not evaluable remotely; local evaluation required' });
  const verdict = { schema: SCHEMA, repo: inputs.repo, pr: inputs.pr, headSha: inputs.headSha,
    mainSha: inputs.mainSha, codeSha: inputs.codeSha, gateTree: inputs.gateTree,
    settingsDigest: inputs.settingsDigest, inputsDigest: inputs.inputsDigest, decision: inputs.decision,
    gates, localRequired: [...LOCAL_REQUIRED], actions: inputs.actions, computedAt: inputs.computedAt };
  verdict.verdictDigest = verdictDigest(verdict);
  // Validate and detach the supplied evidence.
  return JSON.parse(canonicalJson(verdict));
}

export function verify(verdict, live, { maxAgeMinutes = 10, now = Date.now() } = {}) {
  const refuse = reason => ({ ok: false, reason });
  if (verdict?.schema !== SCHEMA) return refuse('schema');
  if (!DECISIONS.includes(verdict.decision)) return refuse('decision');
  if (!Array.isArray(verdict.localRequired) || !verdict.localRequired.length ||
      !LOCAL_REQUIRED.every(id => verdict.localRequired.includes(id))) return refuse('localRequired');
  if (typeof verdict.repo !== 'string' || !verdict.repo.trim() || verdict.repo !== live?.repo) return refuse('repo');
  if (!Number.isSafeInteger(verdict.pr) || verdict.pr <= 0 || verdict.pr !== live?.pr) return refuse('pr');
  for (const field of BINDINGS) {
    if (typeof verdict[field] !== 'string' || !verdict[field] || verdict[field] !== live?.[field]) return refuse(field);
  }
  if (typeof verdict.codeSha !== 'string' || !verdict.codeSha) return refuse('codeSha');
  if (typeof verdict.verdictDigest !== 'string' || verdict.verdictDigest !== verdictDigest(verdict)) return refuse('verdictDigest');
  if (!Array.isArray(verdict.gates) || !verdict.gates.length || !Array.isArray(verdict.actions)) return refuse('gates');
  if (live?.decision !== undefined && live.decision !== verdict.decision) return refuse('decision');
  if (verdict.decision === 'enqueue' && (verdict.gates.some(g => g.result === 'fail') ||
      !verdict.actions.some(x => x?.type === 'enqueue' && x.pr === verdict.pr && x.headSha === verdict.headSha))) return refuse('actions');
  // codeSha is informational (every main commit changes it); gateTree is the binding. It must still be present.
  const age = Number(new Date(now)) - Date.parse(verdict.computedAt);
  if (!Number.isFinite(age) || age < 0 || !Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0 || age > maxAgeMinutes * 60_000) return refuse('computedAt');
  return { ok: true, reason: 'verified' };
}
