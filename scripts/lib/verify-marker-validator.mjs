import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

export const MARKER_PAYLOAD_LIMIT = 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/i, HASH = /^[a-f0-9]{64}$/i;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const nullableHash = value => value === null || typeof value === 'string' && HASH.test(value);
export const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const canonicalJson = value => JSON.stringify(canonical(value));
export const validGatePlan = value => object(value) && ['command', 'mode', 'selectionMode'].every(k => text(value[k]))
  && (value.deltaBase === null || typeof value.deltaBase === 'string' && SHA.test(value.deltaBase));

/** One bounded positional snapshot. Never reopen the path to construct the receipt. */
export function readMarkerSnapshot(path, { io = fs } = {}) {
  let fd, used = 0;
  const refused = reason => ({ record: { corrupt: true }, source: 'local', bytesDigest: null,
    retainedBytes: Math.min(used, MARKER_PAYLOAD_LIMIT), detail: `${reason}; re-run verification or inspect/quarantine the marker.` });
  try {
    fd = io.openSync(path, 'r');
    const buffer = Buffer.alloc(MARKER_PAYLOAD_LIMIT + 1);
    while (used < buffer.length) {
      const n = io.readSync(fd, buffer, used, buffer.length - used, used);
      if (!Number.isInteger(n) || n < 0 || n > buffer.length - used) return refused('invalid marker read');
      if (!n) break;
      used += n;
    }
    if (used > MARKER_PAYLOAD_LIMIT) return refused('marker exceeds 1 MiB');
    const bytes = buffer.subarray(0, used);
    const bytesDigest = createHash('sha256').update(bytes).digest('hex');
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { return refused('corrupt marker'); }
    if (!object(record)) return refused('corrupt marker');
    return { record, source: 'local', bytesDigest, retainedBytes: used };
  } catch (error) {
    return error?.code === 'ENOENT' && fd === undefined
      ? { record: null, source: 'local', bytesDigest: null, retainedBytes: 0 }
      : refused('unreadable marker');
  } finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { /* read result already bounded */ } } }
}

const failure = reason => ({ ok: false, status: reason.split(':')[0], reason,
  detail: `${reason}; re-run verification or inspect/quarantine the marker.` });

/** Consistency applies to legacy records too, before any fallback may be considered. */
export function validateMarkerSchema(rec) {
  if (!object(rec) || rec.corrupt) return failure('corrupt');
  if (typeof rec.sha !== 'string' || !SHA.test(rec.sha)
    || !['running', 'green', 'red', 'infrastructure-failure'].includes(rec.status)) return failure('invalid:record');
  if (rec.status === 'infrastructure-failure' && !object(rec.infrastructure)) return failure('invalid:record');
  const integer = Number.isInteger(rec.exitCode);
  if (rec.status === 'green' && (!integer || rec.exitCode !== 0 || rec.signal || rec.infrastructure)
    || rec.status === 'running' && rec.exitCode !== null
    || rec.status === 'red' && !(integer && rec.exitCode !== 0 || text(rec.signal))
    || rec.status === 'infrastructure-failure' && !(integer || rec.exitCode === null)) return failure('invalid:exit-status');
  if (!Object.hasOwn(rec, 'v')) return failure('stale:legacy');
  if (rec.v !== 2) return failure('invalid:version');
  if (!['v', 'writer', 'runId', 'policyKey', 'policyInputs', 'gatePlan', 'treeHash'].every(k => Object.hasOwn(rec, k))) return failure('invalid:schema');
  if (!['verify-lane', 'verify-dispatch'].includes(rec.writer)) return failure('invalid:writer');
  if (!text(rec.runId) || !nullableHash(rec.policyKey) || !nullableHash(rec.treeHash)
    || !(rec.policyInputs === null || validPolicyInputs(rec.policyInputs))
    || !(rec.gatePlan === null || validGatePlan(rec.gatePlan))) return failure('invalid:schema');
  return { ok: true };
}

export function validPolicyInputs(value) {
  return object(value) && value.v === 2 && object(value.verify) && object(value.verifier)
    && typeof value.verifier.sha === 'string' && SHA.test(value.verifier.sha)
    && typeof value.verifier.scriptsClean === 'boolean' && Array.isArray(value.aliases)
    && HASH.test(value.environmentDigest) && object(value.sources)
    && text(value.finalGate) && text(value.finalGateStandards) && ['0', '1'].includes(value.diffTestSelection);
}

/** Landing only: WIP/cache/wait consumers deliberately do not call this contract. */
export function validateLandingMarker(record, { headSha, policyKey, gatePlan, treeHash, cleanTree, source = 'local' } = {}) {
  if (!record) return failure('absent');
  const schema = validateMarkerSchema(record);
  if (!schema.ok) return schema;
  if (source !== 'local') return failure('stale:source');
  const authority = record.status === 'green' || record.status === 'red' && record.redCause === 'pre-existing-on-main'
    && object(record.redCauseEvidence) && typeof record.redCauseEvidence.baseSha === 'string'
    && SHA.test(record.redCauseEvidence.baseSha);
  if (!authority) return { ok: false, status: record.status, reason: record.status === 'running' ? 'verify-unfinished' : record.status === 'red' ? 'verify-red' : 'verify-infrastructure', detail: 'Local verification did not establish a passing result; re-run verification.' };
  if (record.policyKey === null) return failure('stale:producer-key-null');
  if (typeof policyKey !== 'string' || !HASH.test(policyKey)) return failure('stale:consumer-key-unavailable');
  if (record.policyKey !== policyKey) return failure('stale:key-mismatch');
  if (!validGatePlan(gatePlan) || !record.gatePlan || canonicalJson(record.gatePlan) !== canonicalJson(gatePlan)) {
    return failure(record.gateExplicit && record.gatePlan?.command !== gatePlan?.command ? 'stale:gate-explicit' : 'stale:gate-mismatch');
  }
  if (record.sha !== headSha) return failure('stale:other-head');
  if (!record.treeHash || !treeHash || record.treeHash !== treeHash || cleanTree !== true) return failure('stale:tree-mismatch');
  return { ok: true, status: record.status, reason: record.status === 'green' ? 'verified' : 'verify-red-preexisting', detail: 'Local own-run verification matches the committed landing inputs.' };
}
