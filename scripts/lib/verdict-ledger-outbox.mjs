/**
 * @file scripts/lib/verdict-ledger-outbox.mjs
 * @description THE LEDGER OUTBOX + PLUMBING FLUSH — how many same-host writers share ONE push to `ops/review-requests`.
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
 *   3. PLUMBING, NO WORKTREE. read the tip blob, append, `hash-object -w`, a temp `GIT_INDEX_FILE` (`read-tree <tip>`
 *      + `update-index --cacheinfo`), `write-tree`, `commit-tree -p <tip>`, and a NON-FORCE push of `<sha>:<ref>`. No
 *      checkout, no local branch ref moved, no worktree to strand.
 *   4. OFF-HOST WRITERS (the CI applier) still race the remote. A rejection that says `fetch first`/`non-fast-forward`
 *      is retried on a refetched tip with jitter, on a TIME budget (setting); anything else fails at once.
 *
 * INVARIANTS (the audit focus).
 *   · No row is lost: an entry is deleted only after a push that contains it succeeded, or after a fetched tip
 *     already holds every one of its ids.
 *   · No row is duplicated: each flush dedups against the tip it builds on, by event id, exactly as the old append
 *     did; a crash between push and delete is therefore a no-op replay on the next flush.
 *   · Never forced: the remote arbitrates every push; the lock is an efficiency, not the correctness mechanism.
 *   · A failure surfaces: a flusher whose push provably failed withdraws ITS OWN entry under a freshly refreshed
 *     lease and throws (thrown still means "not recorded"); when it cannot prove that (push outcome unknown, lease
 *     lost, withdrawal failed) the entry stays durably queued and the call says `queued`. An outbox whose oldest
 *     entry is older than `outboxStaleMs` logs a loud `ledger-write-miss` line (on every append that meets it and on
 *     every backstop flush, lock held or not) and refuses new rows while the lock is held.
 *   · Entries carry an integrity sum and their origin key: a corrupt entry is set aside loudly, never pushed; an
 *     entry for another remote is never pushed by this board. Entry files and their directory are fsynced.
 *   · Bounded: one overall deadline per flush, every git call has a timeout, the daemon backstop never throws.
 *
 * Settings cascade (standard → repo `verdictLedger.*` → env), logged once per process with each value's source:
 *   outbox (on; OFF in CI — an ephemeral runner would lose its outbox), flushBudgetMs, outboxStaleMs.
 *
 * IMPURE (git, fs); every side effect is a parameter.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { retryTransientGit } from './git-fetch-retry.mjs';
import { assertPushRef, trackingRefspec, withGitError, worktreeGitEnv } from './git-transport-branch.mjs';
import { parseLedgerEvents, ledgerEventId } from './verdict-ledger.mjs';
import { ledgerGitPath } from './verdict-ledger-path.mjs';
import { workspaceFor } from './lane-pool-paths.mjs';
import { readSettings } from './settings-files.mjs';
import { reserve, readLockEntry, releaseLockDirIf, heartbeatOwn } from '../readiness/file-locks.mjs';

export const OUTBOX_ENV = 'WE_VERDICT_LEDGER_OUTBOX';
export const OUTBOX_DIR_ENV = 'WE_VERDICT_LEDGER_OUTBOX_DIR';
export const FLUSH_BUDGET_ENV = 'WE_VERDICT_LEDGER_FLUSH_BUDGET_MS';
export const OUTBOX_STALE_ENV = 'WE_VERDICT_LEDGER_OUTBOX_STALE_MS';
export const DEFAULT_FLUSH_BUDGET_MS = 120_000;
export const DEFAULT_OUTBOX_STALE_MS = 600_000;
/** The one lock "path" every flusher of one outbox reserves. */
export const OUTBOX_LOCK_PATH = 'verdict-ledger-flusher';
/** Same blob cap as the reader (`verdict-ledger-io.mjs#DEFAULT_LEDGER_READ_MAX_BYTES`). */
const BLOB_MAX_BYTES = 64 * 1024 * 1024;
const ENTRY_RE = /^\d{15}-\d+-[0-9a-f]+\.json$/;
const CONTENTION_RE = /fetch first|non-fast-forward|cannot lock ref|incorrect old value|stale info/i;
/** The remote ANSWERED and refused this push: proof it did not land (a lost race, a hook, protection, permissions). */
const DEFINITIVE_REJECTION_RE = /\[(remote )?rejected\]/i;

/** A push-phase failure of the flush. `results` holds the entries that DID land before it. */
export class OutboxFlushError extends Error {
  constructor(message, { errors = [], attempts = 0, results = new Map(), kind = 'flush' } = {}) {
    super(message);
    this.name = 'OutboxFlushError';
    this.errors = errors;
    this.attempts = attempts;
    this.results = results;
    this.kind = kind;
  }
}

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

/** The origin key of `board`: its origin URL, hashed. Run with repo selectors scrubbed, so cwd alone decides. */
export function originKeyFor({ board, run = defaultGit } = {}) {
  const url = String(withGitError(run)(['remote', 'get-url', 'origin'], { cwd: board, env: boardEnv(board) })).trim();
  if (!url) throw new Error(`verdict-ledger-outbox: ${board} has no origin URL`);
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/**
 * The outbox directory for `board`: env override, else `<workspace>/.operations/verdict-ledger-outbox/<origin-key>`.
 * Keyed by the board's ORIGIN URL so two clones of the same remote share one outbox (and one flusher). Each entry
 * ALSO records its origin key, and a flusher pushes only entries whose key matches its own board, so a row can never
 * reach a different remote even through a misconfigured override or an inherited `GIT_DIR` (audit 2026-10-21).
 */
export function outboxDirFor({ board, env = process.env, run = defaultGit } = {}) {
  if (env?.[OUTBOX_DIR_ENV]) return resolve(env[OUTBOX_DIR_ENV]);
  return join(workspaceFor(resolve(board)), '.operations', 'verdict-ledger-outbox', originKeyFor({ board, run }));
}

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
export function enqueueOutboxEntry(dir, entry, { now = Date.now, log = defaultLog } = {}) {
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
  try { fsyncDir(dir); } catch (e) { log(`ledger-write-miss: verdict-ledger outbox directory fsync of ${dir} failed after queuing ${name} (${e?.message ?? e}); the entry is queued but may not survive a host crash`); }
  return name;
}

/** Age of the oldest queued entry (from its name's timestamp), or 0 for an empty outbox. */
function oldestAgeMs(dir, nowMs) {
  const names = listOutboxEntries(dir);
  if (!names.length) return { count: 0, ageMs: 0 };
  const created = Number(names[0].slice(0, 15));
  return { count: names.length, ageMs: Math.max(0, nowMs - created) };
}

function staleLine(dir, { count, ageMs }, why) {
  return `ledger-write-miss: verdict-ledger outbox ${dir} holds ${count} entr${count === 1 ? 'y' : 'ies'}, oldest ${Math.round(ageMs / 60_000)}m old (${why})`;
}

/** Log the stale line when the oldest entry is past `staleMs`. Never throws. Returns whether it was stale. */
function reportIfStale(c, why) {
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
function readEntry(dir, name, log) {
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

function tryLock(dir, budgetMs) {
  const lockRoot = outboxLockRoot(dir);
  ensureDurableDir(lockRoot);
  const owner = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  const t = Date.now();
  const r = reserve(lockRoot, OUTBOX_LOCK_PATH, owner, t, new Date(t).toISOString(), process.pid, probeLiveness, leaseMinutesFor(budgetMs));
  return r.ok ? owner : null;
}

/** Refresh our lease; false when the lock is no longer ours. */
const stillOwn = (dir, owner) => {
  try { return heartbeatOwn(outboxLockRoot(dir), OUTBOX_LOCK_PATH, owner, new Date().toISOString()); } catch { return false; }
};

/**
 * Release OUR lock. The lease is refreshed first, so the read-then-rename inside `releaseLockDirIf` runs with a
 * full lease ahead of it: no live-owner reclaim can land in that window (residual: a process stalled for a whole
 * lease between the two calls — the same window every file-locks consumer has). Never throws.
 */
function unlock(dir, owner, log) {
  try {
    if (!stillOwn(dir, owner)) return;
    const lockRoot = outboxLockRoot(dir);
    const entry = readLockEntry(lockRoot, OUTBOX_LOCK_PATH);
    if (entry?.owner === owner) releaseLockDirIf(lockRoot, OUTBOX_LOCK_PATH, entry);
  } catch (e) {
    log(`verdict-ledger-outbox: releasing the flusher lock on ${dir} failed (${e?.message ?? e}); its lease expires on its own`);
  }
}

/** The board-side git env: no inherited repo selectors, the LEDGER app role for the push credential. */
function boardEnv(board, extra = {}) {
  const env = worktreeGitEnv(join(board, '.git'));
  delete env.GIT_CEILING_DIRECTORIES; // the board is the repo here; discovery from its root is what we want
  return { ...env, ...extra };
}

function readBlobAt(run, board, tip, path, env) {
  const listed = String(run(['ls-tree', tip, '--', path], { cwd: board, env })).trim();
  if (!listed) return { text: '', mode: '100644' };
  const [meta] = listed.split('\t');
  const [mode, type, oid] = meta.split(/\s+/);
  if (type !== 'blob') throw new Error(`verdict-ledger-outbox: ${path} at ${tip} is a ${type}, not a blob`);
  const size = Number(String(run(['cat-file', '-s', oid], { cwd: board, env })).trim());
  if (!Number.isSafeInteger(size)) throw new Error(`verdict-ledger-outbox: unreadable size for ${path}`);
  if (size > BLOB_MAX_BYTES) throw new Error(`verdict-ledger-outbox: ${path} is ${size} bytes, over the ${BLOB_MAX_BYTES}-byte cap`);
  return { text: String(run(['cat-file', 'blob', oid], { cwd: board, env, maxBuffer: size + 64 * 1024 })), mode };
}

/**
 * ONE attempt: fetch, compute every entry's fresh rows against the fetched tip, and push them as ONE commit.
 * Returns per-entry counts; `pushed: false` when the tip already held every row (a replay after a crash).
 * A failure of the PUSH command itself carries `phase: 'publish'` and the `commit`, so the caller can reconcile:
 * a push can land on the remote and still report failure (a dropped connection after the remote accepted it).
 */
function pushBatch({ board, branch, entries, run, allowRef }) {
  const ref = assertPushRef(branch, allowRef);
  const env = boardEnv(board);
  retryTransientGit(() => run(['fetch', '--quiet', 'origin', trackingRefspec(branch)], { cwd: board, env }));
  const tip = String(run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { cwd: board, env })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error(`verdict-ledger-outbox: origin/${branch} did not resolve to a commit`);

  const byPath = new Map();
  for (const e of entries) {
    if (!byPath.has(e.entry.path)) byPath.set(e.entry.path, []);
    byPath.get(e.entry.path).push(e);
  }
  const counts = new Map();
  const changes = [];
  for (const [path, group] of byPath) {
    const { text: base, mode } = readBlobAt(run, board, tip, path, env);
    const seen = new Set(parseLedgerEvents(base).map(ledgerEventId));
    const fresh = [];
    for (const { name, entry } of group) {
      let rows = 0;
      entry.lines.forEach((line, i) => {
        if (seen.has(entry.ids[i])) return;
        seen.add(entry.ids[i]);
        fresh.push(line);
        rows += 1;
      });
      counts.set(name, { rows, duplicates: entry.lines.length - rows });
    }
    if (fresh.length) changes.push({ path, mode, base, content: `${base}${base && !base.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n` });
  }
  if (!changes.length) return { pushed: false, counts };

  const tmp = mkdtempSync(join(tmpdir(), 'we-ledger-index-'));
  try {
    const idx = boardEnv(board, { GIT_INDEX_FILE: join(tmp, 'index') });
    run(['read-tree', tip], { cwd: board, env: idx });
    for (const [i, c] of changes.entries()) {
      // From a FILE, never stdin: a runner that spawns git with stdin ignored would silently hash an EMPTY blob
      // (seen in a test seam) and the push would replace the whole ledger with nothing. `--no-filters`: the bytes
      // are stored exactly as computed, whatever attributes apply to the temp path.
      const src = join(tmp, `blob-${i}`);
      writeFileSync(src, c.content);
      const blob = String(run(['hash-object', '-w', '--no-filters', '--', src], { cwd: board, env: idx })).trim();
      if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new Error(`verdict-ledger-outbox: hash-object returned no object id for ${c.path}`);
      run(['update-index', '--add', '--cacheinfo', `${c.mode},${blob},${c.path}`], { cwd: board, env: idx });
    }
    const tree = String(run(['write-tree'], { cwd: board, env: idx })).trim();
    const message = entries.length === 1 ? entries[0].entry.message
      : `verdict-ledger: append ${entries.length} queued appends (${[...new Set(entries.map((e) => e.entry.repo))].join(', ')})`;
    const commit = String(run(['commit-tree', tree, '-p', tip, '-m', message || 'verdict-ledger: append'], { cwd: board, env: idx })).trim();
    try {
      // A FULL ref, never forced, never a local branch: the remote alone decides whether this lands.
      run(['push', '--quiet', '--no-follow-tags', 'origin', `${commit}:${ref}`], { cwd: board, env });
    } catch (e) {
      e.phase = 'publish';
      e.commit = commit;
      throw e;
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp dir left behind never undoes a push */ }
  }
  return { pushed: true, counts };
}

/**
 * After a push command FAILED for a non-race reason: did the commit land anyway? `true` landed, `false` provably
 * not (the refetched tip does not contain it), `null` unknown (the remote cannot be read now).
 */
function reconcilePush({ board, branch, run, commit }) {
  if (!commit) return false;
  const env = boardEnv(board);
  try {
    run(['fetch', '--quiet', 'origin', trackingRefspec(branch)], { cwd: board, env });
  } catch { return null; }
  try {
    run(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`], { cwd: board, env });
    return true;
  } catch (e) {
    return e?.status === 1 ? false : null;
  }
}

/**
 * Flush while holding the lock: batch everything queued, push, delete what landed, repeat until empty — inside ONE
 * overall deadline (audit 2026-10-21: a steady stream of successful batches must stop too). Entries are recorded in
 * `results` BEFORE they are deleted, so a failed delete never reverses a recorded row; it only leaves a replay
 * (deduped to a no-op) for the next flush.
 * THROWS `OutboxFlushError` (with the partial `results`; `ambiguous` when a push may have landed) on a
 * non-race failure or an exhausted budget.
 */
function flushHeld(o) {
  const results = new Map();
  try { return flushHeldInner({ ...o, results }); } catch (e) {
    // Whatever threw, the rows that DID land are never forgotten (audit 2026-10-21).
    if (e && typeof e === 'object' && !(e.results instanceof Map)) { try { e.results = results; } catch { /* frozen */ } }
    throw e;
  }
}

function flushHeldInner({ board, branch, dir, owner, run: rawRun, now, sleep, random, log, budgetMs, onRetry, removeEntry, allowRef, originKey, results, inMemory = [] }) {
  // ONE deadline bounds every git call too: no single fetch or push may outlive the flush budget.
  const hardDeadline = Date.now() + budgetMs;
  const run = (args, opts = {}) => rawRun(args, { timeout: Math.max(5_000, Math.min(GIT_CALL_TIMEOUT_MS, hardDeadline - Date.now())), ...opts });
  const errors = [];
  let attempts = 0;
  let pushed = false;
  let stopped = null;
  const deadline = now() + budgetMs;
  const skippedForeign = new Set();
  let memory = [...inMemory]; // this caller's own rows, never on disk: nobody else can ever publish them
  for (;;) {
    if (now() >= deadline) { stopped = 'budget'; break; }
    const names = listOutboxEntries(dir);
    if (!names.length && !memory.length) break;
    const entries = [...memory];
    let ioError = null;
    for (const name of names) {
      const r = readEntry(dir, name, log);
      if (r.io) { ioError = ioError ?? r.io; continue; }
      if (!r.entry) continue;
      if (originKey && r.entry.originKey && r.entry.originKey !== originKey) {
        if (!skippedForeign.has(name)) log(`verdict-ledger-outbox: entry ${name} is for another remote (${r.entry.originKey}); left for its own flusher`);
        skippedForeign.add(name);
        continue;
      }
      entries.push({ name, entry: r.entry });
    }
    if (ioError) log(`verdict-ledger-outbox: some entries in ${dir} are unreadable right now (${ioError.message}); left in place for a later flush`);
    if (!entries.length) { stopped = ioError ? 'io' : 'nothing-flushable'; break; }
    let landed = null;
    for (let retry = 1; ; retry += 1) {
      if (!stillOwn(dir, owner)) {
        // Lease lost (stalled past it): the reclaimer owns the queue now. Stop touching it.
        log(`verdict-ledger-outbox: flusher lease lost on ${dir}; leaving the queue to its new holder`);
        return { results, attempts, pushed, stopped: 'lost-lease' };
      }
      attempts += 1;
      try {
        landed = pushBatch({ board, branch, entries, run, allowRef });
        break;
      } catch (e) {
        errors.push(e);
        const text = `${e?.message ?? e}\n${e?.stderr ?? ''}`;
        const race = CONTENTION_RE.test(text);
        if (!race && e?.phase === 'publish' && !DEFINITIVE_REJECTION_RE.test(text)) {
          // A TRANSPORT failure during the push (no answer from the remote): it may have landed, or may still land
          // (audit round 2: a negative reconcile right now proves nothing). Only a positive reconcile is a verdict.
          const verdict = reconcilePush({ board, branch, run, commit: e.commit });
          if (verdict === true) {
            log(`verdict-ledger-outbox: push reported failure but ${e.commit} is on the remote; counted as landed (${String(e?.message ?? e).split('\n')[0]})`);
            landed = { pushed: true, counts: null };
            break;
          }
          throw new OutboxFlushError(`verdict-ledger-outbox: push outcome UNKNOWN (no answer from the remote): ${String(e?.message ?? e).split('\n')[0]}`,
            { errors, attempts, results, kind: 'ambiguous' });
        }
        if (!race || now() >= deadline) {
          const why = race ? `flush budget ${budgetMs}ms exhausted` : 'non-retryable';
          throw new OutboxFlushError(`verdict-ledger-outbox: flush of ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} failed (${why}): ${String(e?.message ?? e).split('\n')[0]}`,
            { errors, attempts, results });
        }
        if (onRetry) onRetry({ attempt: attempts, error: e });
        log(`verdict-ledger-outbox: push lost a race, refetching (${String(e?.message ?? e).split('\n')[0].slice(0, 300)})`);
        sleep(Math.min(250 * 2 ** (retry - 1), 4000) + Math.floor(random() * 500));
      }
    }
    pushed = pushed || landed.pushed;
    let removeFailed = null;
    for (const { name, entry } of entries) {
      // Recorded FIRST: the push (or the tip) proved every row of it is on the remote.
      results.set(name, landed.counts?.get(name) ?? { rows: entry.lines.length, duplicates: 0 });
      if (memory.some((m) => m.name === name)) continue; // in memory only: nothing to remove
      try { removeEntry(join(dir, name)); } catch (e) { removeFailed = removeFailed ?? e; }
    }
    memory = [];
    if (removeFailed) {
      log(`verdict-ledger-outbox: flushed entries could not be removed from ${dir} (${removeFailed.message}); the next flush replays them as a no-op`);
      stopped = 'remove-failed';
      break;
    }
  }
  return { results, attempts, pushed, stopped };
}

const defaultRemove = (abs) => rmSync(abs, { force: true });

function common(o) {
  const settings = o.settings ?? resolveOutboxSettings({ repo: {}, env: o.env ?? process.env });
  return {
    board: o.board,
    branch: o.branch,
    dir: o.dir,
    run: withGitError(o.run ?? defaultGit),
    now: o.now ?? Date.now,
    sleep: o.sleep ?? defaultSleep,
    random: o.random ?? Math.random,
    log: o.log ?? defaultLog,
    budgetMs: o.budgetMs ?? settings.flushBudgetMs,
    staleMs: o.staleMs ?? settings.staleMs,
    onRetry: o.onRetry ?? null,
    removeEntry: o.removeEntry ?? defaultRemove,
    allowRef: o.allowRef ?? null,
  };
}

/**
 * The BACKSTOP (and the post-release re-check): flush whatever is queued if no one else is. NEVER THROWS: every
 * failure — a push, the lock directory, the filesystem — is logged and reported `ok: false`, and a stale outbox logs
 * the loud `ledger-write-miss` line whether or not this call got the lock (audit 2026-10-21).
 * @returns {{ok: boolean, held?: boolean, flushed: number, pushed: boolean, attempts: number, error?: string}}
 */
export function flushLedgerOutbox(o = {}) {
  const c = common({ branch: 'ops/review-requests', ...o });
  let flushed = 0;
  let pushed = false;
  let attempts = 0;
  try {
    const originKey = o.originKey ?? originKeyFor({ board: c.board, run: c.run });
    const deadline = c.now() + c.budgetMs;
    for (let round = 0; round < 50 && c.now() < deadline; round += 1) {
      if (!listOutboxEntries(c.dir).length) break;
      const owner = tryLock(c.dir, c.budgetMs);
      if (!owner) {
        reportIfStale(c, 'the flusher lock is held and the backlog is not draining');
        return { ok: true, held: true, flushed, pushed, attempts };
      }
      let r;
      try {
        r = flushHeld({ ...c, owner, originKey, budgetMs: Math.max(1, deadline - c.now()) });
      } catch (e) {
        flushed += e?.results?.size ?? 0;
        const msg = String(e?.message ?? e).split('\n')[0];
        if (!reportIfStale(c, msg)) c.log(msg);
        return { ok: false, flushed, pushed, attempts: attempts + (e?.attempts ?? 0), error: msg };
      } finally {
        unlock(c.dir, owner, c.log);
      }
      flushed += r.results.size;
      pushed = pushed || r.pushed;
      attempts += r.attempts;
      if (r.stopped) break;
    }
    reportIfStale(c, 'entries remain after this flush');
    return { ok: true, flushed, pushed, attempts };
  } catch (e) {
    const msg = `verdict-ledger-outbox: flush of ${c.dir} failed: ${String(e?.message ?? e).split('\n')[0]}`;
    if (!reportIfStale(c, msg)) c.log(msg);
    return { ok: false, flushed, pushed, attempts, error: msg };
  }
}

/**
 * THE DAEMON BACKSTOP for one board: flush its outbox (settings from the cascade). Nothing queued, or another
 * flusher holding the lock, is a quiet no-op. Never throws (see {@link flushLedgerOutbox}).
 */
export function flushBoardLedgerOutbox({ board, env = process.env, log = defaultLog, run } = {}) {
  if (!board) return { ok: true, flushed: 0, pushed: false, attempts: 0, skipped: 'no-board' };
  let dir = null;
  try {
    const settings = resolveOutboxSettings({ repo: readSettings(), env });
    dir = outboxDirFor({ board, env, ...(run ? { run } : {}) });
    if (!listOutboxEntries(dir).length) return { ok: true, flushed: 0, pushed: false, attempts: 0, dir };
    return { ...flushLedgerOutbox({ board, dir, settings, log, run, allowRef: 'refs/heads/ops/review-requests' }), dir };
  } catch (e) {
    const msg = `ledger-write-miss: verdict-ledger outbox backstop for ${board} failed: ${String(e?.message ?? e).split('\n')[0]}`;
    log(msg);
    return { ok: false, flushed: 0, pushed: false, attempts: 0, dir, error: msg };
  }
}

/** The tick's origin lookup: memoized per board, and bounded to a few seconds (audit round 3: it ran every tick). */
const tickDirMemo = new Map();
export const TICK_ORIGIN_TIMEOUT_MS = 5_000;
function tickOutboxDir(board, env) {
  if (env?.[OUTBOX_DIR_ENV]) return resolve(env[OUTBOX_DIR_ENV]);
  const key = resolve(board);
  if (!tickDirMemo.has(key)) {
    const run = (args, opts = {}) => defaultGit(args, { ...opts, timeout: TICK_ORIGIN_TIMEOUT_MS });
    tickDirMemo.set(key, outboxDirFor({ board, env, run }));
  }
  return tickDirMemo.get(key);
}

/**
 * THE TICK-SIDE BACKSTOP (audit 2026-10-21: a synchronous flush could hold the daemon tick for minutes). The tick only
 * looks whether the board's outbox has entries; if so it starts ONE detached flusher process and returns at once.
 * Overlapping spawns are harmless: the flusher lock is non-blocking, so a second one exits as a no-op.
 * Never throws.
 */
export function spawnBoardLedgerOutboxFlush({ board, env = process.env, log = defaultLog, spawnFn = spawn } = {}) {
  if (!board) return { ok: true, flushed: 0, skipped: 'no-board' };
  let dir = null;
  try {
    dir = tickOutboxDir(board, env);
    const pending = listOutboxEntries(dir).length;
    if (!pending) return { ok: true, flushed: 0, dir };
    const child = spawnFn(process.execPath, [THIS_FILE, 'flush', `--board=${board}`], { detached: true, stdio: ['ignore', 'ignore', 'inherit'], env });
    // A spawn can fail LATER (EAGAIN under process exhaustion) as an 'error' event; unhandled, it would crash the
    // daemon (audit round 3). Logged as a write miss instead; the next tick tries again.
    child.on?.('error', (e) => {
      try { log(`ledger-write-miss: verdict-ledger outbox backstop flusher for ${board} failed to start (${e?.message ?? e}); ${pending} entr${pending === 1 ? 'y' : 'ies'} still queued in ${dir}`); } catch { /* never throws */ }
    });
    child.unref?.();
    return { ok: true, flushed: 0, spawned: true, pending, pid: child.pid ?? null, dir };
  } catch (e) {
    const msg = `ledger-write-miss: verdict-ledger outbox backstop for ${board} could not start (${String(e?.message ?? e).split('\n')[0]})`;
    log(msg);
    return { ok: false, flushed: 0, dir, error: msg };
  }
}

/**
 * The append side. See the header for the full contract.
 *
 * OUTCOMES (audit 2026-10-21, round 3 — nothing visible to another flusher is EVER withdrawn):
 *   · LOCK WON at once: this call's rows ride the flush IN MEMORY, never written to the outbox, so no other process
 *     can ever hold a copy. Landed → `{queued: false}`. A refused push, or a failure before any push → THROWS
 *     (truthfully "not recorded": PR 4311, a failed git write never lets a clearing verdict through). A push with
 *     no answer (outcome UNKNOWN), a lost lease or a spent budget → the rows are THEN queued durably → `{queued: true}`.
 *   · LOCK HELD: the rows are queued durably (fsynced, read back) → `{queued: true}`; if the lock frees up meanwhile
 *     this call flushes them itself. From here on the entry is never withdrawn; a failure is logged loudly at once and
 *     a backlog older than `outboxStaleMs` raises `ledger-write-miss`. Rows carry event ids: a retry never duplicates.
 *   · THROWS before anything is queued: the stale-outbox refusal, a failed enqueue, or the own entry set aside corrupt.
 */
export function appendViaOutbox(o) {
  const c = common(o);
  const { lines, ids, path, repo, message } = o;
  const originKey = o.originKey ?? originKeyFor({ board: c.board, run: c.run });
  const entry = { board: resolve(c.board), branch: c.branch, path, repo, message, lines, ids, originKey };
  const queued = (attempts = 0) => ({ status: 'appended', queued: true, rows: lines.length, duplicates: 0, attempts, outboxDir: c.dir });
  const recheck = () => {
    // A row queued after our last empty check but before the release would otherwise wait for the next writer.
    try {
      if (listOutboxEntries(c.dir).length) {
        const again = flushLedgerOutbox({ ...o, settings: undefined, originKey, budgetMs: c.budgetMs, staleMs: c.staleMs });
        if (!again.ok) c.log(`verdict-ledger-outbox: post-release flush failed: ${again.error}`);
      }
    } catch (e) { c.log(`verdict-ledger-outbox: post-release flush failed: ${e?.message ?? e}`); }
  };

  let owner = tryLock(c.dir, c.budgetMs);
  if (owner) {
    // ── LOCK WON: our rows stay in memory. ──
    const SELF = '(this append)';
    let result = null;
    let failure = null;
    try { result = flushHeld({ ...c, owner, originKey, inMemory: [{ name: SELF, entry }] }); } catch (e) { failure = e; }
    const res = (result ?? failure)?.results;
    const mine = res instanceof Map ? res.get(SELF) : undefined;
    const attempts = (result ?? failure)?.attempts ?? 0;
    let outcome = null;
    let toThrow = null;
    if (mine) {
      if (failure) c.log(`${String(failure?.message ?? failure).split('\n')[0]} (this append's own rows had already landed)`);
      outcome = { status: 'appended', queued: false, rows: mine.rows, duplicates: mine.duplicates, attempts, outboxDir: c.dir };
    } else if (failure && failure?.kind !== 'ambiguous') {
      // Refused, or failed before any push: provably not on the remote, and never visible to anyone else.
      toThrow = failure instanceof OutboxFlushError ? failure : new OutboxFlushError(String(failure?.message ?? failure).split('\n')[0], { errors: [failure], attempts });
    } else {
      // Unknown push outcome, lease lost, or budget spent: keep the rows — durably — for a later flush.
      try {
        enqueueOutboxEntry(c.dir, entry, { now: c.now, log: c.log });
        const why = failure ? String(failure?.message ?? failure).split('\n')[0] : `flush stopped (${result?.stopped ?? 'unknown'})`;
        c.log(`verdict-ledger-outbox: ${why}; this append is queued in ${c.dir}`);
        outcome = queued(attempts);
      } catch (e) {
        toThrow = new OutboxFlushError(`verdict-ledger-outbox: push outcome unknown AND the rows could not be queued (${e?.message ?? e})`, { errors: [failure, e].filter(Boolean), attempts, kind: 'ambiguous' });
      }
    }
    unlock(c.dir, owner, c.log);
    if (toThrow) { reportIfStale(c, toThrow.message); throw toThrow; }
    recheck();
    return outcome;
  }

  // ── LOCK HELD: queue durably. A throw before the entry exists truthfully means "not recorded". ──
  const age = oldestAgeMs(c.dir, c.now());
  if (age.count && age.ageMs > c.staleMs) {
    const held = readLockEntry(outboxLockRoot(c.dir), OUTBOX_LOCK_PATH)?.owner ?? 'unknown';
    const line = staleLine(c.dir, age, `flusher lock held by ${held}; this append was NOT queued`);
    c.log(line);
    throw new OutboxFlushError(line, { errors: [new Error(line)], attempts: 0, kind: 'stale' });
  }
  const name = enqueueOutboxEntry(c.dir, entry, { now: c.now, log: c.log });

  // ── The entry is visible now: never withdrawn. Every path answers landed or queued (or corrupt-own). ──
  const own = join(c.dir, name);
  let outcome = queued();
  let corrupt = null;
  try {
    owner = tryLock(c.dir, c.budgetMs);
    if (owner) {
      let result = null;
      let failure = null;
      try { result = flushHeld({ ...c, owner, originKey }); } catch (e) { failure = e; }
      const res = (result ?? failure)?.results;
      const mine = res instanceof Map ? res.get(name) : undefined;
      const attempts = (result ?? failure)?.attempts ?? 0;
      if (mine) {
        outcome = { status: 'appended', queued: false, rows: mine.rows, duplicates: mine.duplicates, attempts, outboxDir: c.dir };
      } else if (existsSync(own)) {
        if (failure) {
          const msg = String(failure?.message ?? failure).split('\n')[0];
          if (!reportIfStale(c, msg)) c.log(`verdict-ledger-outbox: flush FAILED, this append stays queued in ${c.dir} (${msg})`);
        }
        outcome = queued(attempts);
      } else if (existsSync(join(c.dir, `.corrupt-${name}`))) {
        corrupt = new OutboxFlushError(`verdict-ledger-outbox: this append's own entry ${name} was found corrupt and set aside; it will never be pushed`, { errors: failure ? [failure] : [], attempts });
      } else {
        outcome = { status: 'appended', queued: false, rows: lines.length, duplicates: 0, attempts, outboxDir: c.dir }; // pushed by another flusher
      }
    }
  } catch (e) {
    c.log(`verdict-ledger-outbox: after queuing ${name}: ${String(e?.message ?? e).split('\n')[0]}; the entry stays queued`);
  } finally {
    if (owner) unlock(c.dir, owner, c.log);
  }
  if (corrupt) { c.log(`ledger-write-miss: ${corrupt.message}`); throw corrupt; }
  if (owner) recheck();
  return outcome;
}

/**
 * THE DIRECT PATH (CI, where an outbox would die with the runner, and unit seams): the SAME plumbing commit and the
 * SAME push site as the flusher, for this call's rows only, retried on a fetched tip up to `attempts` times. The
 * ledger therefore has ONE push shape; the worktree stager in `git-transport-branch.mjs` no longer carries ledger
 * rows at all. A push that reports failure is reconciled against the remote first. THROWS `OutboxFlushError` when
 * every attempt failed.
 * @returns {{status: 'appended', attempts: number, rows: number, duplicates: number}}
 */
export function appendDirect(o) {
  const c = common(o);
  const attempts = Math.max(1, o.attempts ?? 5);
  const entry = { path: o.path, repo: o.repo, message: o.message, lines: o.lines, ids: o.ids };
  const errors = [];
  let unresolved = false; // ANY earlier push without an answer keeps the outcome indeterminate, whatever follows
  for (let attempt = 1; ; attempt += 1) {
    try {
      const out = pushBatch({ board: c.board, branch: c.branch, entries: [{ name: 'direct', entry }], run: c.run, allowRef: c.allowRef });
      const mine = out.counts.get('direct');
      return { status: 'appended', attempts: attempt, rows: mine.rows, duplicates: mine.duplicates };
    } catch (e) {
      errors.push(e);
      const etext = `${e?.message ?? e}\n${e?.stderr ?? ''}`;
      if (e?.phase === 'publish' && !CONTENTION_RE.test(etext) && !DEFINITIVE_REJECTION_RE.test(etext)) {
        if (reconcilePush({ board: c.board, branch: c.branch, run: c.run, commit: e.commit }) === true) {
          c.log(`verdict-ledger: push reported failure but ${e.commit} is on the remote; counted as landed`);
          return { status: 'appended', attempts: attempt, rows: entry.lines.length, duplicates: 0 };
        }
        unresolved = true;
      }
      if (attempt >= attempts) {
        const unknown = unresolved;
        // CI has no durable queue to fall back on: a transport failure DURING the push is reported as an UNKNOWN
        // outcome, never as a proven miss. Rows carry event ids, so the caller's retry can never duplicate.
        throw new OutboxFlushError(`verdict-ledger: direct append failed after ${attempt} attempts${unknown ? ' (push outcome UNKNOWN: the remote may hold it)' : ''}: ${String(e?.message ?? e).split('\n')[0]}`,
          { errors, attempts: attempt, kind: unknown ? 'ambiguous' : 'flush' });
      }
      if (c.onRetry) c.onRetry({ attempt, error: e });
      c.sleep(Math.min(250 * 2 ** (attempt - 1), 4000) + Math.floor(c.random() * 500));
    }
  }
}

/** Every git call is bounded (audit 2026-10-21): a hung push must not hold the flusher lock or the daemon tick. */
export const GIT_CALL_TIMEOUT_MS = 120_000;
function defaultGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
    timeout: GIT_CALL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...opts,
  });
}
const THIS_FILE = fileURLToPath(import.meta.url);

/** `node verdict-ledger-outbox.mjs flush --board=<checkout>` — the detached backstop flusher. Always exits 0. */
if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE && process.argv[2] === 'flush') {
  const board = (process.argv.find((a) => a.startsWith('--board=')) ?? '').slice('--board='.length);
  const r = flushBoardLedgerOutbox({ board });
  if (r.flushed || r.ok === false) defaultLog(`verdict-ledger-outbox: backstop flush ${JSON.stringify(r)}`);
}

function defaultLog(line) { try { process.stderr.write(`${line}\n`); } catch { /* never fails a write */ } }
function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
