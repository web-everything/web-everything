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
 *   · A failure surfaces: a flusher whose push fails withdraws ITS OWN entry and throws (thrown still means "not
 *     recorded", as before); an outbox whose oldest entry is older than `outboxStaleMs` logs a loud
 *     `ledger-write-miss` line and refuses new rows while the lock is held, so callers raise their existing miss.
 *
 * Settings cascade (standard → repo `verdictLedger.*` → env), logged once per process with each value's source:
 *   outbox (on; OFF in CI — an ephemeral runner would lose its outbox), flushBudgetMs, outboxStaleMs.
 *
 * IMPURE (git, fs); every side effect is a parameter.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { retryTransientGit } from './git-fetch-retry.mjs';
import { assertPushRef, trackingRefspec, withGitError, worktreeGitEnv } from './git-transport-branch.mjs';
import { parseLedgerEvents, ledgerEventId } from './verdict-ledger.mjs';
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

/**
 * The outbox directory for `board`: env override, else `<workspace>/.operations/verdict-ledger-outbox/<origin-key>`.
 * Keyed by the board's ORIGIN URL so two clones of the same remote share one outbox (and one flusher), and two
 * different remotes never mix rows.
 */
export function outboxDirFor({ board, env = process.env, run = defaultGit } = {}) {
  if (env?.[OUTBOX_DIR_ENV]) return resolve(env[OUTBOX_DIR_ENV]);
  const url = String(withGitError(run)(['remote', 'get-url', 'origin'], { cwd: board })).trim();
  if (!url) throw new Error(`verdict-ledger-outbox: ${board} has no origin URL`);
  const key = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return join(workspaceFor(resolve(board)), '.operations', 'verdict-ledger-outbox', key);
}

/** Queued entry names, oldest first. A missing dir is an empty outbox. */
export function listOutboxEntries(dir) {
  try { return readdirSync(dir).filter((n) => ENTRY_RE.test(n)).sort(); }
  catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
}

/** Write one entry atomically (tmp + rename). Returns its name. */
export function enqueueOutboxEntry(dir, entry, { now = Date.now } = {}) {
  mkdirSync(dir, { recursive: true });
  const t = now();
  const name = `${String(Math.max(0, Math.trunc(t))).padStart(15, '0')}-${process.pid}-${randomBytes(6).toString('hex')}.json`;
  const tmp = join(dir, `.tmp-${name}`);
  writeFileSync(tmp, `${JSON.stringify({ v: 1, createdAt: t, pid: process.pid, host: hostname(), ...entry })}\n`, { flag: 'wx' });
  renameSync(tmp, join(dir, name));
  return name;
}

/** Age of the oldest queued entry (its own recorded `createdAt`), or 0 for an empty outbox. */
function oldestAgeMs(dir, nowMs) {
  const names = listOutboxEntries(dir);
  if (!names.length) return { count: 0, ageMs: 0 };
  const created = Number(names[0].slice(0, 15));
  return { count: names.length, ageMs: Math.max(0, nowMs - created) };
}

function staleLine(dir, { count, ageMs }, why) {
  return `ledger-write-miss: verdict-ledger outbox ${dir} holds ${count} entr${count === 1 ? 'y' : 'ies'}, oldest ${Math.round(ageMs / 60_000)}m old (${why})`;
}

function readEntry(dir, name, log) {
  try {
    const e = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (!isPlainObject(e) || typeof e.path !== 'string' || !Array.isArray(e.lines) || !Array.isArray(e.ids) || e.lines.length !== e.ids.length) {
      throw new Error('malformed entry');
    }
    return e;
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // flushed by a reclaiming flusher meanwhile
    // Never silently dropped, never allowed to wedge the queue: set aside under a name the lister ignores.
    try { renameSync(join(dir, name), join(dir, `.corrupt-${name}`)); } catch { /* best effort */ }
    log(`ledger-write-miss: verdict-ledger outbox entry ${join(dir, name)} is unreadable (${err.message}); set aside as .corrupt-${name}`);
    return null;
  }
}

const probeLiveness = (entry) => {
  const pid = entry?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; } catch (e) { return e?.code === 'ESRCH' ? 'dead' : 'unknown'; }
};

function tryLock(dir, budgetMs) {
  const lockRoot = outboxLockRoot(dir);
  mkdirSync(lockRoot, { recursive: true });
  const owner = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  const t = Date.now();
  const r = reserve(lockRoot, OUTBOX_LOCK_PATH, owner, t, new Date(t).toISOString(), process.pid, probeLiveness, leaseMinutesFor(budgetMs));
  return r.ok ? owner : null;
}

function unlock(dir, owner) {
  const lockRoot = outboxLockRoot(dir);
  const entry = readLockEntry(lockRoot, OUTBOX_LOCK_PATH);
  if (entry?.owner === owner) releaseLockDirIf(lockRoot, OUTBOX_LOCK_PATH, entry);
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
    if (fresh.length) changes.push({ path, mode, content: `${base}${base && !base.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n` });
  }
  if (!changes.length) return { pushed: false, counts };

  const tmp = mkdtempSync(join(tmpdir(), 'we-ledger-index-'));
  try {
    const idx = boardEnv(board, { GIT_INDEX_FILE: join(tmp, 'index') });
    run(['read-tree', tip], { cwd: board, env: idx });
    for (const c of changes) {
      const blob = String(run(['hash-object', '-w', '--stdin'], { cwd: board, env: idx, input: c.content })).trim();
      run(['update-index', '--add', '--cacheinfo', `${c.mode},${blob},${c.path}`], { cwd: board, env: idx });
    }
    const tree = String(run(['write-tree'], { cwd: board, env: idx })).trim();
    const message = entries.length === 1 ? entries[0].entry.message
      : `verdict-ledger: append ${entries.length} queued appends (${[...new Set(entries.map((e) => e.entry.repo))].join(', ')})`;
    const commit = String(run(['commit-tree', tree, '-p', tip, '-m', message || 'verdict-ledger: append'], { cwd: board, env: idx })).trim();
    // A FULL ref, never forced, never a local branch: the remote alone decides whether this lands.
    run(['push', '--quiet', 'origin', `${commit}:${ref}`], { cwd: board, env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { pushed: true, counts };
}

/**
 * Flush while holding the lock: batch everything queued, push, delete what landed, repeat until empty.
 * THROWS `OutboxFlushError` (with the partial `results`) on a non-contention failure or an exhausted budget.
 * Any OTHER throw (e.g. the delete itself) propagates raw — it is a crash, not a push failure.
 */
function flushHeld({ board, branch, dir, owner, run, now, sleep, random, log, budgetMs, onRetry, removeEntry, allowRef }) {
  const results = new Map();
  const errors = [];
  let attempts = 0;
  let pushed = false;
  const deadline = now() + budgetMs;
  for (;;) {
    const names = listOutboxEntries(dir);
    if (!names.length) break;
    const entries = names.map((name) => ({ name, entry: readEntry(dir, name, log) })).filter((e) => e.entry);
    if (!entries.length) continue;
    for (let retry = 1; ; retry += 1) {
      if (!heartbeatOwn(outboxLockRoot(dir), OUTBOX_LOCK_PATH, owner, new Date(Date.now()).toISOString())) {
        // Lease lost (stalled past it): the reclaimer owns the queue now. Stop touching it.
        log(`verdict-ledger-outbox: flusher lease lost on ${dir}; leaving the queue to its new holder`);
        return { results, attempts, pushed, lostLease: true };
      }
      attempts += 1;
      let out;
      try {
        out = pushBatch({ board, branch, entries, run, allowRef });
      } catch (e) {
        errors.push(e);
        const text = `${e?.message ?? e}\n${e?.stderr ?? ''}`;
        if (!CONTENTION_RE.test(text) || now() >= deadline) {
          const why = CONTENTION_RE.test(text) ? `flush budget ${budgetMs}ms exhausted` : 'non-retryable';
          throw new OutboxFlushError(`verdict-ledger-outbox: flush of ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} failed (${why}): ${String(e?.message ?? e).split('\n')[0]}`,
            { errors, attempts, results });
        }
        if (onRetry) onRetry({ attempt: attempts, error: e });
        log(`verdict-ledger-outbox: push lost a race, refetching (${String(e?.message ?? e).split('\n')[0].slice(0, 300)})`);
        sleep(Math.min(250 * 2 ** (retry - 1), 4000) + Math.floor(random() * 500));
        continue;
      }
      pushed = pushed || out.pushed;
      for (const { name } of entries) {
        removeEntry(join(dir, name)); // only after the push (or the tip) proved every row of it is on the remote
        results.set(name, out.counts.get(name));
      }
      break;
    }
  }
  return { results, attempts, pushed };
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
 * The BACKSTOP (and the post-release re-check): flush whatever is queued if no one else is. Never throws for a
 * push failure — it logs and reports `ok: false`; a stale outbox logs the loud `ledger-write-miss` line.
 * @returns {{ok: boolean, held?: boolean, flushed: number, pushed: boolean, attempts: number, error?: string}}
 */
export function flushLedgerOutbox(o = {}) {
  const c = common({ branch: 'ops/review-requests', ...o });
  let flushed = 0;
  let pushed = false;
  let attempts = 0;
  for (let round = 0; round < 50; round += 1) {
    if (!listOutboxEntries(c.dir).length) break;
    const owner = tryLock(c.dir, c.budgetMs);
    if (!owner) return { ok: true, held: true, flushed, pushed, attempts };
    try {
      const r = flushHeld({ ...c, owner });
      flushed += r.results.size;
      pushed = pushed || r.pushed;
      attempts += r.attempts;
      if (r.lostLease) break;
    } catch (e) {
      if (!(e instanceof OutboxFlushError)) throw e;
      flushed += e.results.size;
      const age = oldestAgeMs(c.dir, c.now());
      c.log(age.ageMs > c.staleMs ? staleLine(c.dir, age, e.message) : e.message);
      return { ok: false, flushed, pushed, attempts: attempts + e.attempts, error: e.message };
    } finally {
      unlock(c.dir, owner);
    }
  }
  return { ok: true, flushed, pushed, attempts };
}

/**
 * THE DAEMON BACKSTOP for one board: flush its outbox (settings from the cascade). Nothing queued, or another
 * flusher holding the lock, is a quiet no-op. Never throws for a push failure (see {@link flushLedgerOutbox}).
 */
export function flushBoardLedgerOutbox({ board, env = process.env, log, run } = {}) {
  if (!board) return { ok: true, flushed: 0, pushed: false, attempts: 0, skipped: 'no-board' };
  const settings = resolveOutboxSettings({ repo: readSettings(), env });
  const dir = outboxDirFor({ board, env, ...(run ? { run } : {}) });
  return { ...flushLedgerOutbox({ board, dir, settings, log, run, allowRef: 'refs/heads/ops/review-requests' }), dir };
}

/**
 * The append side: enqueue, then flush if no one else is. See the header for the full contract.
 * @returns {{status: 'appended', queued: boolean, rows: number, duplicates: number, attempts: number, outboxDir: string}}
 * @throws {OutboxFlushError} the flush this call ran failed (its own entry withdrawn), or the outbox is stale.
 */
export function appendViaOutbox(o) {
  const c = common(o);
  const { lines, ids, path, repo, message } = o;
  const entry = { board: resolve(c.board), branch: c.branch, path, repo, message, lines, ids };
  let owner = tryLock(c.dir, c.budgetMs);
  let name;
  if (!owner) {
    const age = oldestAgeMs(c.dir, c.now());
    if (age.count && age.ageMs > c.staleMs) {
      const held = readLockEntry(outboxLockRoot(c.dir), OUTBOX_LOCK_PATH)?.owner ?? 'unknown';
      const line = staleLine(c.dir, age, `flusher lock held by ${held}; this append was NOT queued`);
      c.log(line);
      throw new OutboxFlushError(line, { errors: [new Error(line)], attempts: 0, kind: 'stale' });
    }
    name = enqueueOutboxEntry(c.dir, entry, { now: c.now });
    owner = tryLock(c.dir, c.budgetMs);
    if (!owner) return { status: 'appended', queued: true, rows: lines.length, duplicates: 0, attempts: 0, outboxDir: c.dir };
  } else {
    name = enqueueOutboxEntry(c.dir, entry, { now: c.now });
  }

  let result;
  try {
    result = flushHeld({ ...c, owner });
  } catch (e) {
    if (!(e instanceof OutboxFlushError)) throw e;
    const mine = e.results.get(name);
    if (!mine) {
      // We hold the lock, so no one else is pushing our entry: withdrawing it keeps "thrown ⇒ not recorded" true.
      c.removeEntry(join(c.dir, name));
      const age = oldestAgeMs(c.dir, c.now());
      if (age.count && age.ageMs > c.staleMs) c.log(staleLine(c.dir, age, e.message));
      throw e;
    }
    c.log(`${e.message} (this append's own rows had already landed)`);
    result = { results: e.results, attempts: e.attempts, pushed: true };
  } finally {
    unlock(c.dir, owner);
  }
  // A row queued after our last empty check but before the release would otherwise wait for the next writer.
  if (listOutboxEntries(c.dir).length) {
    const again = flushLedgerOutbox({ ...o, settings: undefined, budgetMs: c.budgetMs, staleMs: c.staleMs });
    if (!again.ok) c.log(`verdict-ledger-outbox: post-release flush failed: ${again.error}`);
  }
  const mine = result.results.get(name);
  if (!mine) {
    // Lease lost before our entry was flushed: it is durable in the outbox and the new holder pushes it.
    return { status: 'appended', queued: true, rows: lines.length, duplicates: 0, attempts: result.attempts, outboxDir: c.dir };
  }
  return { status: 'appended', queued: false, rows: mine.rows, duplicates: mine.duplicates, attempts: result.attempts, outboxDir: c.dir };
}

function defaultGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
    ...opts,
  });
}
function defaultLog(line) { try { process.stderr.write(`${line}\n`); } catch { /* never fails a write */ } }
function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
