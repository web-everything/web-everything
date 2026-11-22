/** Canonical, exact-head evidence for standing overlay admission and inspection. */
import { readFileSync } from 'node:fs';
import { readAuditSettings, resolveAuditRecordPath } from '../operations/codex-audit-io.mjs';
import { readStore, storePath } from '../operations/ruled-weakened-store.mjs';
import { jsonLines } from '../operations/prototype-load.mjs';

const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value);
/** Name the evidence an operator must supply. */
export function describeMissing(sha) {
  return `no NOT WEAKENED canonical audit record and no waiver in ruled-weakened.jsonl for ${typeof sha === 'string' ? sha : 'invalid SHA'}`;
}

/** Judge exact-head records in ledger order; every base's latest verdict must be green. Pure. */
export function auditEvidenceFor(sha, { auditRecords = [], waivers = [] } = {}) {
  const missing = { ok: false, kind: null, detail: describeMissing(sha) };
  if (!fullSha(sha)) return missing;
  const matches = value => fullSha(value) && value.toLowerCase() === sha.toLowerCase();
  const latest = new Map();
  for (const record of auditRecords) {
    if (matches(record?.head) && fullSha(record.base)) latest.set(record.base.toLowerCase(), record);
  }
  if (latest.size && [...latest.values()].every(record => record.verdict === 'NOT WEAKENED'))
    return { ok: true, kind: 'audit', detail: `NOT WEAKENED canonical audit record for ${sha}` };
  if (waivers.some(entry => matches(entry?.sha)))
    return { ok: true, kind: 'waiver', detail: `waiver in ruled-weakened.jsonl for ${sha}` };
  return missing;
}

/** Read the shared ledgers using their existing readers/resolvers. Unreadable evidence grants nothing. */
export function loadAuditEvidence({ env = process.env } = {}) {
  let auditRecords = [], waivers = [];
  if (typeof env.HOME !== 'string' || !env.HOME.trim()) return { auditRecords, waivers };
  try {
    const path = resolveAuditRecordPath(readAuditSettings(), { home: env.HOME, cwd: process.cwd() });
    const body = readFileSync(path, 'utf8');
    const records = jsonLines(body);
    if (records.length === body.split(/\r?\n/).filter(line => line.trim()).length) auditRecords = records;
  } catch { /* Missing, corrupt or unreadable audit ledger: no audit evidence. */ }
  try {
    let damaged = false;
    const store = readStore({ path: storePath(env), warn: () => { damaged = true; } });
    if (!store.error && !damaged) waivers = store.entries;
  } catch { /* Missing or unreadable waiver ledger: no waiver evidence. */ }
  return { auditRecords, waivers };
}
