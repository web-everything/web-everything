/**
 * @file scripts/lib/verdict-ledger-outbox-spool.mjs
 * @description Layer 1 of THE LEDGER OUTBOX + PLUMBING FLUSH (the outbox spool + the flusher lock) — how many same-host writers share ONE push to `ops/review-requests`.
 *
 * WHY (live 2026-10-21). Every ledger append used to fetch, check out the WHOLE transport branch into a throwaway
 * worktree (7122 files, 57 MB), rewrite the 10.4 MB jsonl, commit and push: ~9 s per attempt. Three or more review
 * writers on this host started within seconds of each other, each push lost to the one before it, five attempts with
 * 100–1600 ms backoff ran out, and referral holds and rulings never persisted (#5502 #5530 #5773 #5742 #5768). A wider
 * retry would only have queued the same 9-second races; the shape of the write was the defect.
 *
 * THE SHAPE NOW.
 *   1. OUTBOX. The append first writes its rows to a host-local outbox directory (one file per append, tmp + rename,
 *      under the workspace's shared `.operations/`, never inside a clone). That is the durable point: push contention
 *      can no longer lose a row.
 *   2. ONE FLUSHER. It then tries a NON-BLOCKING host-wide lock (`we:scripts/readiness/file-locks.mjs`: atomic mkdir,
 *      dead-pid fast reclaim, lease TTL floor). Lock held → return `queued`: the current holder will push these rows.
 *      Lock won → flush EVERYTHING queued as ONE commit, delete only what was flushed, repeat until empty, release,
 *      and re-check once more (a row queued after the last empty check but before the release is never stranded).
 *   3-4. The PLUMBING push and the off-host race retry: see verdict-ledger-plumbing.mjs.
 *
 * INVARIANTS (the audit focus).
 *   · No row is lost: an entry is deleted only after a push that contains it succeeded, or after a fetched tip
 *     already holds every one of its ids.
 *   · A failure surfaces: a flusher whose push provably failed withdraws ITS OWN entry under a freshly refreshed
 *     lease and throws (thrown still means "not recorded"); when it cannot prove that (push outcome unknown, lease
 *     lost, withdrawal failed) the entry stays durably queued and the call says `queued`. An outbox whose oldest
 *     entry is older than `outboxStaleMs` logs a loud `ledger-write-miss` line (on every append that meets it and on
 *     every backstop flush, lock held or not) and refuses new rows while the lock is held.
 *   · Entries carry an integrity sum and their origin key: a corrupt entry is set aside loudly, never pushed; an
 *     entry for another remote is never pushed by this board. Entry files and their directory are fsynced.
 *
 * Settings cascade (standard → repo `verdictLedger.*` → env), logged once per process with each value's source:
 *   outbox (on; OFF in CI — an ephemeral runner would lose its outbox), flushBudgetMs, outboxStaleMs.
 *
 * IMPURE (git, fs); every side effect is a parameter.
 * Layer 1b: verdict-ledger-git.mjs — remote identity + push verdict.
 * Layer 2: verdict-ledger-plumbing.mjs — plumbing commit + direct append.
 * Layer 3: verdict-ledger-outbox.mjs — locked flush + outbox append.
 * Layer 4: verdict-ledger-outbox-backstop.mjs — daemon backstop + CLI.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ledgerEventId } from './verdict-ledger.mjs';
import { ledgerGitPath } from './verdict-ledger-path.mjs';
import { reserve, readLockEntry, releaseLockDirIf, heartbeatOwn, DEFAULT_LEASE_MINUTES } from '../readiness/file-locks.mjs';

export const OUTBOX_ENV = 'WE_VERDICT_LEDGER_OUTBOX';
export const OUTBOX_DIR_ENV = 'WE_VERDICT_LEDGER_OUTBOX_DIR';
export const FLUSH_BUDGET_ENV = 'WE_VERDICT_LEDGER_FLUSH_BUDGET_MS';
export const OUTBOX_STALE_ENV = 'WE_VERDICT_LEDGER_OUTBOX_STALE_MS';
export const DEFAULT_FLUSH_BUDGET_MS = 120_000;
export const DEFAULT_OUTBOX_STALE_MS = 600_000;
/** The one lock "path" every flusher of one outbox reserves. */
export const OUTBOX_LOCK_PATH = 'verdict-ledger-flusher';
const ENTRY_RE = /^\d{15}-\d+-[0-9a-f]+\.json$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validMs = (v) => Number.isSafeInteger(v) && v > 0;
const parseBool = (raw) => (/^(1|true|on|yes)$/i.test(raw) ? true : /^(0|false|off|no)$/i.test(raw) ? false : null);

/** PURE settings cascade. CI turns the outbox off (between repo and env): its runner disappears with the job. */
export function resolveOutboxSettings({ repo, env } = {}) {
  const out = { enabled: true, flushBudgetMs: DEFAULT_FLUSH_BUDGET_MS, staleMs: DEFAULT_OUTBOX_STALE_MS };
  const sources = { enabled: 'standard', flushBudgetMs: 'standard', staleMs: 'standard' };
  const invalid = [];
  const layer = isPlainObject(repo?.verdictLedger) ? repo.verdictLedger : {};
  if (Object.hasOwn(layer, 'outbox')) {
    if (typeof layer.outbox === 'boolean') { out.enabled = layer.outbox; sources.enabled = 'repo'; } else invalid.push('repo.verdictLedger.outbox');
  }
  for (const [key, name] of [['flushBudgetMs', 'flushBudgetMs'], ['staleMs', 'outboxStaleMs']]) {
    if (!Object.hasOwn(layer, name)) continue;
    if (validMs(layer[name])) { out[key] = layer[name]; sources[key] = 'repo'; } else invalid.push(`repo.verdictLedger.${name}`);
  }
  const e = isPlainObject(env) ? env : {};
  if (e.GITHUB_ACTIONS === 'true' || e.CI === 'true') { out.enabled = false; sources.enabled = 'ci'; }
  if (e[OUTBOX_ENV] !== undefined && e[OUTBOX_ENV] !== '') {
    const b = parseBool(String(e[OUTBOX_ENV]).trim());
    if (b === null) invalid.push(`env.${OUTBOX_ENV}`); else { out.enabled = b; sources.enabled = 'env'; }
  }
  for (const [key, name] of [['flushBudgetMs', FLUSH_BUDGET_ENV], ['staleMs', OUTBOX_STALE_ENV]]) {
    const raw = e[name];
    if (raw === undefined || raw === '') continue;
    const n = /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
    if (validMs(n)) { out[key] = n; sources[key] = 'env'; } else invalid.push(`env.${name}`);
  }
  return { ...out, sources, invalid };
}

export function formatOutboxSettings(s) {
  const tail = s.invalid?.length ? `, ignored invalid: ${s.invalid.join(', ')}` : '';
  return `verdict-ledger-outbox: verdictLedger.outbox=${s.enabled} (${s.sources.enabled}), `
    + `verdictLedger.flushBudgetMs=${s.flushBudgetMs} (${s.sources.flushBudgetMs}), `
    + `verdictLedger.outboxStaleMs=${s.staleMs} (${s.sources.staleMs})${tail}`;
}

/** The lock root of one outbox. Inside the outbox dir, so one outbox ⇔ one flusher lock. */
export function outboxLockRoot(dir) { return join(dir, '.locks'); }

/** Lease long enough to outlast a full flush budget between heartbeats (heartbeat runs every attempt). */
const leaseMinutesFor = (budgetMs) => Math.max(5, Math.ceil((2 * budgetMs) / 60_000));

/** Queued entry names, oldest first. A missing dir is an empty outbox. */
export function listOutboxEntries(dir) {
  try { return readdirSync(dir).filter((n) => ENTRY_RE.test(n)).sort(); }
  catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
}

/** fsync a directory so a rename/create in it survives a host crash. Only "not supported here" is ignored. */
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EBADF']);
function fsyncDir(dir) {
  let fd = null;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); }
  catch (e) { if (!FSYNC_UNSUPPORTED.has(e?.code)) throw e; }
  finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

/** `dir` and every ancestor of it, innermost first, up to the filesystem root. */
function ancestry(dir) {
  const out = [];
  let d = resolve(dir);
  for (;;) { out.push(d); const up = dirname(d); if (up === d) return out; d = up; }
}

/** mkdir -p that also fsyncs every directory it created (and the parent of the topmost), so a crash keeps them. */
function ensureDurableDir(dir) {
  const created = [];
  let d = resolve(dir);
  while (!existsSync(d)) { created.push(d); const up = dirname(d); if (up === d) break; d = up; }
  if (!created.length) return;
  mkdirSync(dir, { recursive: true });
  for (const c of created) fsyncDir(dirname(c));
}

/** The integrity sum an entry carries over its payload: a flipped id, line, path or repo fails it. */
const entrySum = (e) => createHash('sha256').update(JSON.stringify([e.path, e.repo, e.originKey ?? null, e.lines, e.ids])).digest('hex');

/**
 * Write one entry DURABLY and atomically: the tmp file is written in full, fsynced, READ BACK and validated, then
 * renamed and its directory fsynced. Until the rename no flusher can see it, so a short or corrupt write throws
 * here with nothing queued (audit 2026-10-21). Returns its name.
 * A failure of the final directory fsync is logged, not thrown: the entry is already visible to flushers, so
 * reporting "not queued" would be the one wrong answer.
 */
export function enqueueOutboxEntry(dir, entry, { now = Date.now, log: rawLog = defaultLog } = {}) {
  const log = safeLog(rawLog);
  ensureDurableDir(dir);
  const t = now();
  const name = `${String(Math.max(0, Math.trunc(t))).padStart(15, '0')}-${process.pid}-${randomBytes(6).toString('hex')}.json`;
  const tmp = join(dir, `.tmp-${name}`);
  const text = `${JSON.stringify({ v: 1, createdAt: t, pid: process.pid, host: hostname(), ...entry, sum: entrySum(entry) })}\n`;
  try {
    const fd = openSync(tmp, 'wx');
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    const back = readFileSync(tmp, 'utf8');
    const why = back === text ? validateEntry(JSON.parse(back)) : 'read-back differs from what was written';
    if (why) throw new Error(`verdict-ledger-outbox: entry failed its write check (${why})`);
    renameSync(tmp, join(dir, name));
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  // Visible to flushers from the rename on, so it can no longer be reported "not queued"; a crash before the next
  // flush could still lose it, which is a write miss and is said so.
  // EVERY enqueue syncs the entry's directory AND EVERY ancestor up to the filesystem root (rounds 4-5: another writer
  // may have created any level of the hierarchy and not synced it yet; existence proves nothing about durability).
  try { for (const d of ancestry(dir)) fsyncDir(d); }
  catch (e) { log(`ledger-write-miss: verdict-ledger outbox directory fsync under ${dir} failed after queuing ${name} (${e?.message ?? e}); the entry is queued but may not survive a host crash`); }
  return name;
}

/** Age of the oldest queued entry (from its name's timestamp), or 0 for an empty outbox. */
export function oldestAgeMs(dir, nowMs) {
  const names = listOutboxEntries(dir);
  if (!names.length) return { count: 0, ageMs: 0 };
  const created = Number(names[0].slice(0, 15));
  return { count: names.length, ageMs: Math.max(0, nowMs - created) };
}

export function staleLine(dir, { count, ageMs }, why) {
  return `ledger-write-miss: verdict-ledger outbox ${dir} holds ${count} entr${count === 1 ? 'y' : 'ies'}, oldest ${Math.round(ageMs / 60_000)}m old (${why})`;
}

/** Log the stale line when the oldest entry is past `staleMs`. Never throws. Returns whether it was stale. */
export function reportIfStale(c, why) {
  try {
    const age = oldestAgeMs(c.dir, c.now());
    if (age.count && age.ageMs > c.staleMs) { c.log(staleLine(c.dir, age, why)); return true; }
  } catch (e) {
    c.log(`ledger-write-miss: verdict-ledger outbox ${c.dir} cannot be inspected (${e?.message ?? e}); ${why}`);
    return true;
  }
  return false;
}

/** Content checks: the serialized events, their ids, their repo and the path must all agree with the sum. */
function validateEntry(e) {
  if (!isPlainObject(e) || typeof e.path !== 'string' || typeof e.repo !== 'string' || !Array.isArray(e.lines)
    || !Array.isArray(e.ids) || !e.lines.length || e.lines.length !== e.ids.length) return 'malformed entry';
  if (e.sum !== entrySum(e)) return 'integrity sum mismatch';
  if (e.path !== ledgerGitPath(e.repo)) return `path ${e.path} is not the ledger path of ${e.repo}`;
  for (let i = 0; i < e.lines.length; i += 1) {
    // JSON.parse accepts pretty-printed JSON and coerces non-strings; a JSONL consumer cannot.
    if (typeof e.lines[i] !== 'string' || /[\r\n]/u.test(e.lines[i])) return `line ${i} must be a single-line JSON string`;
    let row;
    try { row = JSON.parse(e.lines[i]); } catch { return `line ${i} is not JSON`; }
    if (!isPlainObject(row) || row.id !== e.ids[i]) return `line ${i} does not carry id ${e.ids[i]}`;
    if (row.repo !== e.repo) return `line ${i} is for ${row.repo}, not ${e.repo}`;
    try { if (ledgerEventId(row) !== e.ids[i]) return `line ${i} id mismatch`; } catch (err) { return `line ${i} invalid: ${err.message}`; }
  }
  return null;
}

/**
 * Read one entry. `{entry}` usable; `{gone}` flushed meanwhile; `{io}` an I/O error (LEFT IN PLACE: retryable, never
 * quarantined, audit 2026-10-21); `{corrupt}` malformed content, set aside as `.corrupt-<name>` with a loud line.
 */
export function readEntry(dir, name, log) {
  let text;
  try { text = readFileSync(join(dir, name), 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return { gone: true };
    return { io: err };
  }
  let e = null;
  let why;
  try { e = JSON.parse(text); why = validateEntry(e); } catch (err) { why = `not JSON (${err.message})`; }
  if (!why) return { entry: e };
  try { renameSync(join(dir, name), join(dir, `.corrupt-${name}`)); } catch (err) { return { io: err }; }
  log(`ledger-write-miss: verdict-ledger outbox entry ${join(dir, name)} is corrupt (${why}); set aside as .corrupt-${name}`);
  return { corrupt: true };
}

const probeLiveness = (entry) => {
  const pid = entry?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; } catch (e) { return e?.code === 'ESRCH' ? 'dead' : 'unknown'; }
};

export function tryLock(dir, budgetMs) {
  const lockRoot = outboxLockRoot(dir);
  ensureDurableDir(lockRoot);
  const owner = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  const t = Date.now();
  // The holder's budget governs reclaim, even when repo/env settings differ between writers. Legacy or
  // malformed metadata uses the shared lock default, never the contender's budget. Heartbeats preserve meta.
  const heldLeaseMinutes = (entry) => validMs(entry?.meta?.leaseMinutes) ? entry.meta.leaseMinutes : DEFAULT_LEASE_MINUTES;
  const r = reserve(lockRoot, OUTBOX_LOCK_PATH, owner, t, new Date(t).toISOString(), process.pid, probeLiveness,
    heldLeaseMinutes, { leaseMinutes: leaseMinutesFor(budgetMs) });
  return r.ok ? owner : null;
}

/** Refresh our lease; false when the lock is no longer ours. */
export const stillOwn = (dir, owner) => {
  try { return heartbeatOwn(outboxLockRoot(dir), OUTBOX_LOCK_PATH, owner, new Date().toISOString()); } catch { return false; }
};

/**
 * Release OUR lock. The lease is refreshed first, so the read-then-rename inside `releaseLockDirIf` runs with a
 * full lease ahead of it: no live-owner reclaim can land in that window (residual: a process stalled for a whole
 * lease between the two calls — the same window every file-locks consumer has). Never throws.
 */
export function unlock(dir, owner, log) {
  try {
    if (!stillOwn(dir, owner)) return;
    const lockRoot = outboxLockRoot(dir);
    const entry = readLockEntry(lockRoot, OUTBOX_LOCK_PATH);
    if (entry?.owner === owner) releaseLockDirIf(lockRoot, OUTBOX_LOCK_PATH, entry);
  } catch (e) {
    log(`verdict-ledger-outbox: releasing the flusher lock on ${dir} failed (${e?.message ?? e}); its lease expires on its own`);
  }
}

/**
 * A logger that can never throw (round 12): a diagnostic sink failing must never replace a publication outcome
 * (landed, queued or unknown) with an exception.
 */
export function safeLog(log) {
  return (line) => { try { log(line); } catch { /* a log sink failure is never an outcome */ } };
}

export function defaultLog(line) { try { process.stderr.write(`${line}\n`); } catch { /* never fails a write */ } }
export function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
