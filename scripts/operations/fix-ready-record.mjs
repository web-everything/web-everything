#!/usr/bin/env node
// Writes ONE fix-ready record for prototype-load. The shape is exactly what readyEvidence() in prototype-load.mjs reads:
// NOT WEAKENED needs ref + 40-hex sha + tests green; WEAKENED additionally needs auditRuling (R<n>) and a non-empty
// auditDisclosed array of non-empty strings. A record identical to the latest one for that ref+sha is refused; a different
// one supersedes it (the reader lets the latest record per sha win). Each written record also carries `at` (ISO write
// time), which the adoption matrix reader requires; `at` is ignored when deciding whether a record is a duplicate. The append is written until complete under a lock file; if it fails part-way the ledger is not truncated (that could delete another writer's record), the torn bytes are closed off with a newline so they sit on their own malformed line (prototype-load drops it; the adoption matrix notes a malformed line until it leaves its 1 MiB tail), and the failure is reported.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validSha, jsonLines } from './prototype-load.mjs';
import { loadAdoptionMatrixSettingsFile } from '../lib/adoption-matrix-settings.mjs';

const RULING = /^R\d+(?:\+R\d+)*$/;
const here = dirname(fileURLToPath(import.meta.url));

/** The same path the reader uses: settings readyRecordPath, `~/` expanded against HOME. */
export function readyRecordPath({ env = process.env, settingsFile = join(here, '..', 'settings', 'prototype-load.json') } = {}) {
  const p = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).readyRecordPath;
  if (typeof p !== 'string' || !p) throw new Error('prototype-load settings have no readyRecordPath');
  return p.startsWith('~/') ? join(env.HOME || homedir(), p.slice(2)) : p;
}

/** The file the adoption matrix reads fix-ready records from (adoption-matrix-io.mjs): WE_FIX_READY_PATH, then the
 *  adoption-matrix `fixReadyPath` setting, then the shipped default; `~/` expanded against home. A test pins this to
 *  the real reader, so a drift in either one fails loudly. `settings` (parsed) or `settingsFile` may be injected. */
export function adoptionReaderPath({ env = process.env, home = env.HOME || homedir(), settings, settingsFile } = {}) {
  const config = settings ?? loadAdoptionMatrixSettingsFile(settingsFile);
  const p = env.WE_FIX_READY_PATH || config.fixReadyPath || join(home, 'workspace', '.operations', 'coordination', 'fix-ready.jsonl');
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** The canonical spelling of a ledger path, so two names for one file compare equal: made absolute (against the working
 *  directory, as both readers do), then walked one component at a time the way the kernel does: each existing
 *  component is resolved through its symlinks, and `..` steps out of the directory resolved so far (so `link/..` leaves
 *  the symlink's TARGET, not the link's parent; `path.resolve` would wrongly collapse it textually). Components that do
 *  not exist yet (a ledger not written yet) are appended as written.
 *
 *  Returns null when the kernel itself would refuse the name, so a spelling that only LOOKS like another file is never
 *  accepted as it: `..` after a component that does not exist (ENOENT), after a regular file (ENOTDIR) or after a
 *  dangling symlink; any component below a regular file or a dangling symlink; a name that ends in `/`, `/.` or `/..`
 *  (it names a directory, so a ledger file cannot be opened through it: ENOTDIR); a `.` after a regular file; and any
 *  lookup error other than "does not exist" (permission, symlink loop, name too long), which is treated as unopenable,
 *  never as a missing file. */
export function canonicalPath(p, fsApi = fs) {
  const abs = isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`;
  let cur = parse(abs).root;
  let exists = true;
  let dangling = false; // the last component is a symlink whose target is missing: nothing can be looked up below it
  const parts = abs.slice(cur.length).split(sep);
  // A name that ends in `/`, `/.` or `/..` names a DIRECTORY: the kernel refuses to open a regular file through it
  // (ENOTDIR), so no reader can open a ledger by that spelling, however the rest of it resolves.
  const last = parts[parts.length - 1];
  if (last === '' || last === '.' || last === '..') return null;
  for (const part of parts) {
    if (part === '') continue; // redundant slashes (a//b) are one separator
    if (dangling) return null;
    if (part === '.') {
      // `.` is looked up in the directory resolved so far: it must exist and be a directory (`file/./x` is ENOTDIR)
      if (!exists) continue; // not written yet: the writer creates these directories, nothing to check
      try { if (!fsApi.statSync(cur).isDirectory()) return null; } catch { return null; }
      continue;
    }
    if (part === '..') {
      if (!exists) return null; // the kernel must look up the missing directory before it can step out of it
      try { if (!fsApi.statSync(cur).isDirectory()) return null; } catch { return null; }
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    if (exists) {
      try { cur = fsApi.realpathSync(next); continue; } catch (e) {
        if (e?.code !== 'ENOENT') return null;
        exists = false;
        try { fsApi.lstatSync(next); dangling = true; } catch (l) { if (l?.code !== 'ENOENT') return null; }
      }
    }
    cur = next;
  }
  return cur;
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
const MAX_RECORD_BYTES = 64 * 1024;

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
    try {
      const fd = fsApi.openSync(lock, 'wx');
      try {
        try { fsApi.writeFileSync(fd, token); } catch (w) {
          // A failed token write must not leave an empty lock that blocks every writer until it goes stale.
          try { fsApi.unlinkSync(lock); } catch { /* best effort */ }
          throw w;
        }
      } finally { fsApi.closeSync(fd); }
      return true;
    } catch (e) {
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

/** Writes every byte of `buf` to an append handle. writeSync may accept fewer bytes than asked, so loop on its return
 *  value. If a write throws or makes no progress, the ledger is NOT truncated (a cut-back is not atomic with another
 *  writer's append and could delete that writer's record). Instead one newline is appended, best effort, so the torn
 *  bytes become an isolated malformed line, and the failure is reported (saying whether the newline landed). The
 *  prototype-load reader's jsonLines() drops that line; the adoption matrix reader counts it as a 'fix-ready log
 *  malformed' note until it leaves its 1 MiB tail, a known cost of never deleting another writer's data. */
function appendAll(fd, buf, fsApi) {
  let off = 0;
  try {
    while (off < buf.length) {
      const n = fsApi.writeSync(fd, buf, off, buf.length - off);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`short write: ${off} of ${buf.length} bytes`);
      off += n;
    }
    return { ok: true };
  } catch (e) {
    let isolated = false;
    try { isolated = fsApi.writeSync(fd, Buffer.from('\n')) === 1; } catch { /* best effort: the next writer also starts a new line if the file lacks a final newline */ }
    const tail = isolated
      ? 'the partial line is isolated with a newline (jsonLines drops it; the adoption matrix reports it as a malformed fix-ready line until it leaves the reader\'s 1 MiB tail)'
      : 'the isolating newline could not be written either, so the partial line stays unterminated until the next writer starts a new line';
    return { ok: false, error: `write failed: ${e.message}; ledger NOT cut back, ${tail}` };
  }
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
  // The adoption matrix reader (parseFixReadyLines) drops any line without a parseable `at`, so every record carries
  // the write time. `at` is not part of the record's identity: it is left out of the duplicate comparison below.
  // A clock value `Date` cannot represent (NaN, or finite but out of range) would throw in toISOString: refuse it first.
  const clockMs = new Date(now()).getTime();
  if (!Number.isFinite(clockMs)) return { ok: false, error: 'cannot stamp the record: the clock returned no usable time' };
  // The final `at` is chosen under the lock (stampUnderLock); this provisional line only sizes the record.
  const line = JSON.stringify({ ...built.record, at: new Date(clockMs).toISOString() });
  // The adoption matrix reads only the last 1 MiB of the ledger; a record near that size would be written, reported as
  // success, then cut by the reader's tail slice. Refuse it instead.
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return { ok: false, error: `record is ${Buffer.byteLength(line)} bytes; the limit is ${MAX_RECORD_BYTES} (the reader keeps only the last 1 MiB of the ledger)` };
  const canon = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))));
  const want = canon(built.record);
  // Key order and sha case in a hand-written ledger line must not hide an identical record.
  const isDuplicate = (text) => {
    const prior = latestFor(text, ref, sha);
    if (!prior) return false;
    const { at: _at, ...rest } = prior; // the write time never makes two records differ
    return canon({ ...rest, sha }) === want;
  };
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
    // The reader keeps, per ref, the line with the greatest `at` (a tie goes to the later line). Stamp under the lock
    // and never go below the ref's latest `at` already in the ledger, so a clock step back, skew between machines or
    // two writers racing cannot make this newer record lose to an older one.
    // A running maximum, never `Math.max(...all)`: the ledger is append-only, so a ref's history has no size limit
    // and spreading it into arguments overflows the call stack.
    let priorAt = -Infinity;
    for (const r of jsonLines(locked.text)) {
      if (!r || r.ref !== ref || typeof r.at !== 'string') continue;
      const t = Date.parse(r.at);
      if (Number.isFinite(t) && t > priorAt) priorAt = t;
    }
    const record = { ...built.record, at: new Date(Math.max(clockMs, priorAt)).toISOString() };
    const fd = fsApi.openSync(file, 'a');
    try {
      const written = appendAll(fd, Buffer.from(`${prefix}${JSON.stringify(record)}\n`), fsApi);
      if (!written.ok) return { ok: false, error: written.error };
    } finally { fsApi.closeSync(fd); }
    return { ok: true, record, file };
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
  // The default ledger must be the file the adoption matrix reads; otherwise the record is written where nothing looks.
  let file = deps.file;
  if (file === undefined) {
    const env = deps.env ?? process.env;
    let readerPath;
    try {
      file = readyRecordPath({ env, ...(deps.settingsFile ? { settingsFile: deps.settingsFile } : {}) });
      readerPath = adoptionReaderPath({ env, settings: deps.adoptionSettings, settingsFile: deps.adoptionSettingsFile });
    } catch (e) { console.error(`fix-ready-record: cannot resolve the ledger path / adoption-matrix settings: ${e.message}`); return 2; }
    // A name the filesystem cannot open (null) is never the same file as anything: refuse it like a split.
    const readerCanon = canonicalPath(readerPath);
    const writerCanon = canonicalPath(file);
    if (readerCanon === null || writerCanon === null || readerCanon !== writerCanon) {
      console.error(`fix-ready-record: refused: the adoption matrix reads ${readerPath} (WE_FIX_READY_PATH / fixReadyPath) but this writer would append to ${file} (readyRecordPath); make them the same file`);
      return 1;
    }
  }
  const out = writeReadyRecord({ ref: a.ref, sha: a.sha, tests: a.tests, audit, auditRuling: a.auditRuling, auditDisclosed }, { ...deps, file });
  if (!out.ok) { console.error(`fix-ready-record: refused: ${out.error}`); return 1; }
  console.log(`fix-ready-record: wrote ${out.record.ref}@${out.record.sha} (${out.record.audit}) to ${out.file}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
