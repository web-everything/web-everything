#!/usr/bin/env node
// Writes ONE fix-ready record for prototype-load. The shape is exactly what readyEvidence() in prototype-load.mjs reads:
// NOT WEAKENED needs ref + 40-hex sha + tests green; WEAKENED additionally needs auditRuling (R<n>) and a non-empty
// auditDisclosed array of non-empty strings. A record identical to the latest one for that ref+sha is refused; a different
// one supersedes it (the reader lets the latest record per sha win). The append is one write under a lock file.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  // The reader matches ref with ===, so surrounding whitespace would write a record nothing ever finds.
  if (ref !== ref.trim()) return { ok: false, error: 'ref must not have surrounding whitespace' };
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

const LOCK_STALE_MS = 30_000;

/** Reads the ledger text; a missing file is an empty ledger. Returns {text} or {error}. */
function readLedger(file, fsApi) {
  try { return { text: String(fsApi.readFileSync(file, 'utf8')) }; }
  catch (e) { return e?.code === 'ENOENT' ? { text: '' } : { error: `cannot read ${file}: ${e.message}` }; }
}

/** Takes `<file>.lock` (exclusive create, holding this writer's unique token). A lock older than LOCK_STALE_MS is a
 *  dead writer's: it is moved aside by an atomic rename (so two takers cannot both remove it), and if the moved file
 *  turns out to be a fresh lock a third writer just created, it is put back and this writer reports busy. */
function takeLock(lock, token, fsApi, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = fsApi.openSync(lock, 'wx'); try { fsApi.writeFileSync(fd, token); } finally { fsApi.closeSync(fd); } return true; } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age;
      try { age = now() - fsApi.statSync(lock).mtimeMs; } catch { continue; }
      if (age <= LOCK_STALE_MS) return false;
      const aside = `${lock}.stale-${token}`;
      try { fsApi.renameSync(lock, aside); } catch { continue; /* another taker moved it first: retry the create */ }
      let moved = 0;
      try { moved = now() - fsApi.statSync(aside).mtimeMs; } catch { /* unreadable: treat as stale */ }
      if (moved <= LOCK_STALE_MS) { // we moved someone's fresh lock: restore it (link fails if one already exists) and stand down
        try { fsApi.linkSync(aside, lock); } catch { /* a newer lock exists: theirs wins */ }
        try { fsApi.unlinkSync(aside); } catch { /* best effort */ }
        return false;
      }
      try { fsApi.unlinkSync(aside); } catch { /* best effort */ }
    }
  }
  return false;
}

/** Removes the lock only if it still holds this writer's token: a slow writer whose lock was taken over must not
 *  delete the new holder's lock. */
function releaseLock(lock, token, fsApi) {
  try { if (String(fsApi.readFileSync(lock, 'utf8')) === token) fsApi.unlinkSync(lock); } catch { /* best effort: a stale lock expires */ }
}

/** The latest record for ref+sha (the reader's "latest per sha wins" rule), or undefined. */
function latestFor(text, ref, sha) {
  // Match lines exactly as the reader does: a string, valid sha. A hand-edited line the reader ignores must not count.
  return jsonLines(text).filter((r) => r && r.ref === ref && typeof r.sha === 'string' && validSha(r.sha) && r.sha.toLowerCase() === sha).pop();
}

/** Validates, then appends one record with a single write, under a lock so two writers cannot both pass the check.
 *  A later record may supersede an earlier one for the same ref+sha (the reader lets the latest win); only a record
 *  identical to the latest existing one is refused as a duplicate. */
export function writeReadyRecord(input, { file = readyRecordPath(), fsApi = fs, now = Date.now } = {}) {
  const built = buildReadyRecord(input);
  if (!built.ok) return built;
  const { ref, sha } = built.record;
  const line = JSON.stringify(built.record);
  const canon = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))));
  const want = canon(built.record);
  // Key order and sha case in a hand-written ledger line must not hide an identical record.
  const isDuplicate = (text) => { const prior = latestFor(text, ref, sha); return !!prior && canon({ ...prior, sha }) === want; };
  const duplicate = { ok: false, error: `duplicate: an identical latest record for ${ref}@${sha} already exists` };
  // Fail fast on an unreadable ledger, before touching the filesystem at all.
  const first = readLedger(file, fsApi);
  if (first.error) return { ok: false, error: first.error };
  if (isDuplicate(first.text)) return duplicate;
  const lock = `${file}.lock`;
  const token = `${process.pid}-${randomUUID()}`;
  try {
    fsApi.mkdirSync(dirname(file), { recursive: true });
    if (!takeLock(lock, token, fsApi, now)) return { ok: false, error: `locked: another writer holds ${lock}; retry shortly` };
  } catch (e) { return { ok: false, error: `cannot lock ${file}: ${e.message}` }; }
  try {
    // Re-read under the lock: a writer that finished between the first read and the lock is now visible.
    const locked = readLedger(file, fsApi);
    if (locked.error) return { ok: false, error: locked.error };
    if (isDuplicate(locked.text)) return duplicate;
    // A hand-edited ledger may lack a final newline; without this the new record would fuse onto the last line.
    const prefix = locked.text && !locked.text.endsWith('\n') ? '\n' : '';
    const fd = fsApi.openSync(file, 'a');
    try { fsApi.writeSync(fd, `${prefix}${line}\n`); } finally { fsApi.closeSync(fd); }
    return { ok: true, record: built.record, file };
  } finally {
    releaseLock(lock, token, fsApi);
  }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
