#!/usr/bin/env node
// Writes ONE fix-ready record for prototype-load. The shape is exactly what readyEvidence() in prototype-load.mjs reads:
// NOT WEAKENED needs ref + 40-hex sha + tests green; WEAKENED additionally needs auditRuling (R<n>) and a non-empty
// auditDisclosed array of non-empty strings. A duplicate ref+sha is refused. The append is one atomic write.
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validSha, jsonLines } from './prototype-load.mjs';

const RULING = /^R\d+(?:\+R\d+)*$/;
const here = dirname(fileURLToPath(import.meta.url));

/** The same path the reader uses: settings readyRecordPath, `~/` expanded against HOME. */
export function readyRecordPath({ env = process.env, settingsFile = join(here, '..', 'settings', 'prototype-load.json') } = {}) {
  const p = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).readyRecordPath;
  if (typeof p !== 'string' || !p) throw new Error('prototype-load settings have no readyRecordPath');
  return p.startsWith('~/') ? join(env.HOME || homedir(), p.slice(2)) : p;
}

/** Pure: returns {ok:true, record} or {ok:false, error}. */
export function buildReadyRecord({ ref, sha, tests, audit, auditRuling, auditDisclosed } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, error: 'ref is required' };
  if (!validSha(sha)) return { ok: false, error: 'sha must be a full 40-hex sha' };
  if (tests !== 'green') return { ok: false, error: 'tests must be green' };
  if (audit === 'NOT WEAKENED') {
    if (auditRuling !== undefined || auditDisclosed !== undefined) return { ok: false, error: 'auditRuling/auditDisclosed only belong on a WEAKENED record' };
    return { ok: true, record: { ref, sha: sha.toLowerCase(), tests: 'green', audit: 'NOT WEAKENED' } };
  }
  if (audit !== 'WEAKENED') return { ok: false, error: 'audit must be NOT-WEAKENED or WEAKENED' };
  if (typeof auditRuling !== 'string' || !RULING.test(auditRuling)) return { ok: false, error: 'WEAKENED needs auditRuling like R816' };
  if (!Array.isArray(auditDisclosed) || !auditDisclosed.length || !auditDisclosed.every((f) => typeof f === 'string' && f.trim())) {
    return { ok: false, error: 'WEAKENED needs a non-empty auditDisclosed array of non-empty strings' };
  }
  return { ok: true, record: { ref, sha: sha.toLowerCase(), tests: 'green', audit: 'WEAKENED', auditRuling, auditDisclosed } };
}

/** Validates, refuses a duplicate ref+sha, appends one line with a single write. */
export function writeReadyRecord(input, { file = readyRecordPath(), fsApi = fs } = {}) {
  const built = buildReadyRecord(input);
  if (!built.ok) return built;
  let existing = [];
  try { existing = jsonLines(fsApi.readFileSync(file, 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') return { ok: false, error: `cannot read ${file}: ${e.message}` }; }
  const { ref, sha } = built.record;
  if (existing.some((r) => r && r.ref === ref && String(r.sha).toLowerCase() === sha)) return { ok: false, error: `duplicate: a record for ${ref}@${sha} already exists` };
  fsApi.mkdirSync(dirname(file), { recursive: true });
  const fd = fsApi.openSync(file, 'a');
  try { fsApi.writeSync(fd, `${JSON.stringify(built.record)}\n`); } finally { fsApi.closeSync(fd); }
  return { ok: true, record: built.record, file };
}

export function parseArgs(argv) {
  const a = {};
  for (const arg of argv) { const m = /^--([^=]+)=(.*)$/s.exec(arg); if (m) a[m[1]] = m[2]; }
  return a;
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const a = parseArgs(argv);
  let auditDisclosed;
  if (a['auditDisclosed-file'] !== undefined) {
    try { auditDisclosed = JSON.parse(fs.readFileSync(a['auditDisclosed-file'], 'utf8')); }
    catch (e) { console.error(`fix-ready-record: cannot read auditDisclosed-file: ${e.message}`); return 2; }
  }
  const audit = a.audit === 'NOT-WEAKENED' ? 'NOT WEAKENED' : a.audit;
  const out = writeReadyRecord({ ref: a.ref, sha: a.sha, tests: a.tests, audit, auditRuling: a.auditRuling, auditDisclosed }, deps);
  if (!out.ok) { console.error(`fix-ready-record: refused: ${out.error}`); return 1; }
  console.log(`fix-ready-record: wrote ${out.record.ref}@${out.record.sha} (${out.record.audit}) to ${out.file}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
