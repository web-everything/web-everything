/** Canonical, exact-head evidence for standing overlay admission and inspection. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readAuditSettings, resolveAuditRecordPath } from '../operations/codex-audit-io.mjs';
import { readStore, storePath, validateEntry, withdrawnRevocations } from '../operations/ruled-weakened-store.mjs';
import { jsonLines, canonicalAuditEvidence } from '../operations/prototype-load.mjs';

const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value);
/** Name the evidence an operator must supply. */
export function describeMissing(sha) {
  return `no NOT WEAKENED canonical audit record and no waiver in ruled-weakened.jsonl for ${typeof sha === 'string' ? sha : 'invalid SHA'}`;
}

/** Read-only canonical coverage; unknown Git state grants no coverage. Never fetches. */
export function mainCovers(base, { cwd = process.cwd(), env = process.env } = {}) {
  if (!fullSha(base)) return false;
  try {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', base, 'origin/main'], {
      cwd, env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    return !result.error && result.status === 0;
  } catch { return false; }
}

/** Canonical evaluation. Supplying covers keeps evaluation pure; default IO is read-only Git. */
export function auditEvidenceFor(sha, { auditRecords = [], waivers = [], ref, covers = mainCovers } = {}) {
  const missing = { ok: false, kind: null, detail: describeMissing(sha) };
  if (!fullSha(sha)) return missing;
  const covered = base => { try { return !!covers(base); } catch { return false; } };
  const evaluate = ruledWeakened => canonicalAuditEvidence(auditRecords, sha, covered, null, { ruledWeakened });
  if (evaluate().ok) return { ok: true, kind: 'audit', detail: `NOT WEAKENED canonical audit record for ${sha}` };
  for (const entry of waivers) {
    if (!validateEntry(entry) || entry.ref !== ref || entry.sha.toLowerCase() !== sha.toLowerCase()) continue;
    if (evaluate({ record: entry, ruledWeakened: entry }).ok)
      return { ok: true, kind: 'waiver', detail: `waiver in ruled-weakened.jsonl for ${ref} ${sha}` };
  }
  return missing;
}

/** Read the shared ledgers using their existing readers/resolvers. Unreadable evidence grants nothing. */
export function loadAuditEvidence({ env = process.env, fs = { readFileSync }, cwd = process.cwd() } = {}) {
  let auditRecords = [], waivers = [];
  if (typeof env.HOME !== 'string' || !env.HOME.trim()) return { auditRecords, waivers };
  try {
    const path = resolveAuditRecordPath(readAuditSettings((path, encoding) => fs.readFileSync(path, encoding)), { home: env.HOME, cwd });
    const body = fs.readFileSync(path, 'utf8');
    const records = jsonLines(body);
    if (records.length === body.split(/\r?\n/).filter(line => line.trim()).length) auditRecords = records;
  } catch { /* Missing, corrupt or unreadable audit ledger: no audit evidence. */ }
  try {
    let damaged = false;
    const store = readStore({ path: storePath(env), fs, warn: () => { damaged = true; } });
    const revoked = withdrawnRevocations({ env, fs, warn: message => {
      damaged = true;
      console.warn(`${message}; no waiver evidence admitted until the request log is repaired.`);
    } });
    if (!store.error && !damaged) waivers = store.entries.filter(entry => !revoked(entry));
  } catch { /* Missing or unreadable waiver ledger: no waiver evidence. */ }
  return { auditRecords, waivers };
}
