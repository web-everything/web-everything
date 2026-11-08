/**
 * @file scripts/operations/run-store.mjs
 * @description THE THIN IO SHELL over {@link ./run-record.mjs} (#3032, under epic #3029).
 *
 * The pure core — what a run record IS, how it validates, parses and serializes — lives next door in
 * `run-record.mjs` and is re-exported here so a caller has one import. This file adds only the boundary:
 * where the record lives on disk, and how it is read, written, listed and deleted.
 *
 * WHERE RUNS LIVE, AND WHY. A **gitignored machine-local sidecar** — ONE shared folder,
 * `<workspace>/.operations/runs/<id>.json` ({@link sharedRunsDir}, D6 of 128 / #xyloz19), no longer one
 * folder per daemon clone, so every daemon sees every other daemon's history. That
 * is clause 1 of
 * [#state-lives-where-its-nature-dictates](../../docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates)
 * (#2615/#2617): a half-finished run is transient operator/session intent, not durable repo readiness, so it
 * belongs in a sidecar the card-mutation guard does not police — never committed frontmatter. It is
 * emphatically **not** the verdict ledger (#3007); see the `run-record.mjs` header for that distinction and
 * {@link ./effect-executor.mjs} for the seam the ledger lands behind.
 *
 * PURE-CORE / IO-SHELL, the `we:scripts/conveyor/queue-store.mjs` discipline (#2613): the core injects
 * everything, the shell owns fs, and **the shell is the only thing #2626 replaces**. When that decision's
 * product trigger fires, a shared DO/D1 store implements {@link createFileRunStore}'s four methods and
 * nothing above the seam changes.
 */

import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { assertRunRecord, isValidRunId, parseRunRecord, serializeRunRecord } from './run-record.mjs';

export {
  EFFECT_STATUSES,
  RUN_RECORD_VERSION,
  assertRunRecord,
  effectKey,
  isValidRunId,
  newJobRunRecord,
  newRunRecord,
  parseRunRecord,
  serializeRunRecord,
  validateRunRecord,
} from './run-record.mjs';

// Resolved by SCRIPT LOCATION, never CWD — the same reason `queue-store.mjs` does it (#2613 review, nit 4):
// a run written from one worktree and read from another must resolve to the SAME sidecar, or a resume
// silently sees no run at all. `OPERATION_RUNS_DIR` overrides it (tests, and any out-of-tree caller).
const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNS_ROOT = resolve(HERE, '..', '..');

/** `<root>/.operations/runs` — the sidecar directory. */
export function runsDir(root = RUNS_ROOT) {
  return join(root, '.operations', 'runs');
}

/** Env override for the ONE shared runs folder (D6 of 128, #xyloz19). `OPERATION_RUNS_DIR` still wins over it. */
export const SHARED_RUNS_DIR_ENV = 'WE_SHARED_RUNS_DIR';

/**
 * THE ONE SHARED RUNS FOLDER (D6 of 128, #xyloz19): `<workspace>/.operations/runs` — the sibling of the
 * coordination root every checkout already shares (`coordination-root.mjs`), so the review, fix, control and
 * health-watch daemon clones all read and write the SAME run history instead of one private folder each.
 * `WE_SHARED_RUNS_DIR` moves it. Record ids carry a UUID (`newRunId`), so two daemons never mint the same name.
 */
export function sharedRunsDir(env = process.env) {
  const v = env?.[SHARED_RUNS_DIR_ENV];
  if (v && String(v).trim()) return resolve(String(v).trim());
  return join(dirname(resolveCoordinationRoot({ env })), 'runs');
}

/**
 * ONE-TIME MOVE of records written before the shared folder existed. Moves every `*.json` run record in
 * `legacyDir` (a clone's old `.operations/runs`) into `sharedDir`: copy to a temp name, atomic no-clobber link into
 * place, then remove the source. A record that already exists in the shared folder wins (it is newer by
 * construction) and the stale source is just removed. Best-effort per file; never throws. No hand migration.
 * @returns {{moved:string[], skipped:string[]}}
 */
export function migrateLegacyRuns(legacyDir, sharedDir) {
  const moved = [];
  const skipped = [];
  if (!legacyDir || !existsSync(legacyDir) || resolve(legacyDir) === resolve(sharedDir)) return { moved, skipped };
  let names;
  try { names = readdirSync(legacyDir).filter((f) => f.endsWith('.json') && isValidRunId(f.slice(0, -5))); } catch { return { moved, skipped }; }
  if (!names.length) return { moved, skipped };
  try { mkdirSync(sharedDir, { recursive: true }); } catch { return { moved, skipped: names }; }
  for (const f of names) {
    const src = join(legacyDir, f);
    const dest = join(sharedDir, f);
    try {
      if (!existsSync(dest)) {
        const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
        try {
          copyFileSync(src, tmp);
          try {
            linkSync(tmp, dest); // A destination created during the copy always wins.
            moved.push(f.slice(0, -5));
          } catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { rmSync(tmp, { force: true }); }
      }
      rmSync(src, { force: true });
    } catch { skipped.push(f.slice(0, -5)); }
  }
  return { moved, skipped };
}

const migrated = new Set();

/**
 * The canonical runs directory every consumer resolves to. `OPERATION_RUNS_DIR` wins when set (tests, a daemon
 * job child). Otherwise it is the {@link sharedRunsDir}, and the FIRST resolve in a process moves this clone's
 * old per-clone `.operations/runs` records in ({@link migrateLegacyRuns}) — so each daemon clone migrates its
 * own history on boot. Skipped under test (`WE_UNDER_TEST`), where the tests call the migration explicitly.
 */
export function resolveRunsDir() {
  const env = process.env.OPERATION_RUNS_DIR;
  if (env && env.trim()) return resolve(env.trim());
  const dir = sharedRunsDir();
  if (process.env.WE_UNDER_TEST !== '1' && !migrated.has(dir)) {
    migrated.add(dir);
    try { migrateLegacyRuns(runsDir(), dir); } catch { /* best-effort */ }
  }
  return dir;
}

/**
 * WHERE DAEMON JOB RECORDS LIVE (#4125 — the open detail statute `#daemon-jobs` left to this slice, settled
 * here as the ratify-time suggestion): ONE parent folder, `~/.claude/daemon-jobs/<daemon>/`, so the health
 * daemon scans one place instead of each daemon's scattered state folder. `WE_DAEMON_JOBS_ROOT` moves the
 * parent (tests, a VM with a different home). Outside every git tree on purpose — a job record must survive
 * the clone rebuild that `reset --hard`s the daemon's own tree.
 *
 * The daemon passes this directory to each job child as `OPERATION_RUNS_DIR`, so the child's run store
 * ({@link resolveRunsDir}) resolves to the same folder with no job-specific lookup.
 */
export const DAEMON_JOBS_ROOT_ENV = 'WE_DAEMON_JOBS_ROOT';

/** `<WE_DAEMON_JOBS_ROOT || ~/.claude/daemon-jobs>` — the parent of every daemon's job folder. */
export function daemonJobsRoot(env = process.env) {
  const v = env?.[DAEMON_JOBS_ROOT_ENV];
  return v && String(v).trim() ? resolve(String(v).trim()) : join(homedir(), '.claude', 'daemon-jobs');
}

/** `<daemonJobsRoot>/<daemon>` — one daemon's job records. Refuses a daemon name that is not filename-safe. */
export function daemonJobsDir(daemon, env = process.env) {
  if (!isValidRunId(daemon)) throw new TypeError(`operations: invalid daemon name ${JSON.stringify(daemon)}`);
  return join(daemonJobsRoot(env), daemon);
}

/** The on-disk path of one run. Refuses an id that is not filename-safe. */
export function runPath(id, dir = resolveRunsDir()) {
  if (!isValidRunId(id)) throw new TypeError(`operations: invalid run id ${JSON.stringify(id)}`);
  return join(dir, `${id}.json`);
}

/** Mint a fresh run id. Lives in the SHELL because it reads randomness; the pure core never does. */
export function newRunId(prefix = 'run') {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Read a run. Returns `null` ONLY when the file genuinely does not exist. THROWS on a corrupt record —
 * refusing is the point: a torn record must never be mistaken for a run that never began, which would
 * restart work whose effects may already be half-applied.
 * @returns {object|null}
 */
export function tryReadRun(id, dir = resolveRunsDir()) {
  const path = runPath(id, dir);
  if (!existsSync(path)) return null;
  const parsed = parseRunRecord(readFileSync(path, 'utf8'));
  if (!parsed.ok) {
    throw new Error(
      `operations: refusing to read run ${id} — ${parsed.reason} (${path}). ` +
      'Fix or delete the file; a corrupt record is never treated as a run that does not exist.',
    );
  }
  return parsed.record;
}

/** {@link tryReadRun}, but a missing run is a refusal too. Use this when the caller is about to act. */
export function readRun(id, dir = resolveRunsDir()) {
  const record = tryReadRun(id, dir);
  if (!record) throw new Error(`operations: no run record for ${JSON.stringify(id)} at ${runPath(id, dir)}`);
  return record;
}

/**
 * Persist a run. ATOMIC (temp file + rename), so a reader mid-write never sees partial JSON — which, given
 * the refusal policy above, would wedge the run rather than silently degrade.
 */
export function writeRun(record, dir = resolveRunsDir(), opts = {}) {
  persistRun(record, dir, opts);
  return runPath(record.id, dir);
}

// Return this write's stamped record directly; a later read could observe another writer.
function persistRun(record, dir, opts = {}) {
  assertRunRecord(record, 'run record being written');
  const path = runPath(record.id, dir);
  const persist = () => {
    let diskRev = 0, generation;
    try {
      const disk = tryReadRun(record.id, dir);
      diskRev = revision(disk);
      generation = runGeneration(disk);
    } catch { /* Plain writes intentionally recover corrupt records; CAS never does. */ }
    const rev = nextRevision(Math.max(revision(record), diskRev));
    // A new incarnation gets a fresh token, even if the caller supplies a deleted snapshot.
    const persisted = { ...record, rev, generation: generation ?? randomUUID() };
    writeJsonAtomic(path, persisted); // plain writes also invalidate earlier CAS snapshots
    return persisted;
  };
  return withRecordLock(record.id, dir, opts, persist, () => {
    throw new Error(`operations: run lock timed out for ${record.id}; retry later or inspect the retained lock`);
  });
}

// Older records have no revision. Invalid present revisions must never pass a CAS comparison.
function revision(record) {
  const rev = record != null && Object.hasOwn(record, 'rev') ? record.rev : 0;
  if (!Number.isSafeInteger(rev) || rev < 0 || rev > Number.MAX_SAFE_INTEGER) {
    throw new TypeError('operations: invalid run revision');
  }
  return rev;
}

// Rev-less legacy writers can change content without advancing the CAS counters.
function canonicalJson(record) {
  return JSON.stringify(record, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

function matchesRunSnapshot(fresh, expected) {
  return revision(fresh) === revision(expected) && runGeneration(fresh) === runGeneration(expected) &&
    (Object.hasOwn(fresh, 'rev') || canonicalJson(fresh) === canonicalJson(expected));
}

// Refuse overflow before mutation or persistence on every write path.
function nextRevision(rev) {
  if (rev === Number.MAX_SAFE_INTEGER) throw new Error('operations: run revision exhausted; cannot increment past MAX_SAFE_INTEGER');
  return rev + 1;
}

// Missing generation is the legacy incarnation; malformed evidence cannot authorize CAS.
function runGeneration(record) {
  if (record == null || !Object.hasOwn(record, 'generation')) return undefined;
  if (typeof record.generation !== 'string' || !record.generation.length) {
    throw new TypeError('operations: invalid run generation');
  }
  return record.generation;
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM/unknown are not evidence of death
}

function readLock(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function createRunLock(path, owner) {
  let fd;
  try {
    fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify(owner));
    return true;
  } catch (error) {
    if (fd === undefined && error.code === 'EEXIST') return false;
    if (fd !== undefined) rmSync(path, { force: true }); // Remove only our own partial acquisition.
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Atomically claim stale evidence, verifying it still belongs to the inspected owner.
// A replacement must be restored without clobbering anyone who acquired in the meantime.
function reclaimRunLock(path, owner, probe) {
  const seen = readLock(path);
  if (seen?.host !== owner.host || !Number.isSafeInteger(seen.pid) || seen.pid <= 0 ||
      typeof seen.token !== 'string' || !seen.token.length || !Number.isFinite(seen.at)) return false;
  try { if (probe(seen.pid) !== false) return false; } catch { return false; }
  const claimed = `${path}.stale.${owner.token}`;
  try { renameSync(path, claimed); }
  catch { return false; }
  const moved = readLock(claimed);
  if (moved?.pid !== seen.pid || moved?.token !== seen.token || moved?.host !== seen.host) {
    try { linkSync(claimed, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    rmSync(claimed);
    return false;
  }
  rmSync(claimed);
  return true;
}

// Lamport bakery admission protects guard recovery itself. Each contender owns a UUID path
// that is never reused: deleting a proven-dead contender cannot displace a replacement.
// Ticket 0 means choosing; readers wait until its ticket is atomically published.
function runLockContenders(path, owner, probe) {
  const prefix = `${basename(path)}.claim.waiter.`;
  const contenders = [];
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const entry = join(dirname(path), name);
    let other;
    try { other = JSON.parse(readFileSync(entry, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; return null; }
    if (other?.host !== owner.host || !Number.isSafeInteger(other.pid) || other.pid <= 0 ||
        typeof other.token !== 'string' || !other.token.length ||
        other.token !== name.slice(prefix.length) || !Number.isFinite(other.at) ||
        !Number.isSafeInteger(other.ticket) || other.ticket < 0) return null;
    if (other.token === owner.token) continue;
    let dead = false;
    try { dead = probe(other.pid) === false; } catch { /* unknown liveness retains admission */ }
    if (dead) rmSync(entry, { force: true });
    else contenders.push(other);
  }
  return contenders;
}

/** Bounded synchronous acquisition; only a proven dead, same-host holder can be reclaimed. */
function acquireRunLock(path, owner, { waitMs = 5000, pollMs = 15, isPidAlive: probe = isPidAlive }) {
  if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError('operations: lock wait/poll must be finite non-negative/positive milliseconds');
  }
  const deadline = Date.now() + waitMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // Hold bakery admission through guard recovery, record-lock recovery and guard release.
  const claimPath = `${path}.claim`;
  const waiterPath = `${claimPath}.waiter.${owner.token}`;
  if (!createRunLock(waiterPath, { ...owner, ticket: 0 })) return false;
  let ticket = 0;
  try {
    for (;;) {
      const others = runLockContenders(path, owner, probe);
      if (others && ticket === 0) {
        let highest = 0;
        for (const other of others) highest = Math.max(highest, other.ticket);
        if (highest === Number.MAX_SAFE_INTEGER) return false;
        ticket = highest + 1;
        writeJsonAtomic(waiterPath, { ...owner, ticket });
        continue; // Re-scan after publication; a concurrent chooser may have the same ticket.
      }
      const turn = others && ticket > 0 && others.every(other =>
        other.ticket > ticket || (other.ticket === ticket && other.token > owner.token));
      if (turn && (createRunLock(claimPath, owner) ||
          (reclaimRunLock(claimPath, owner, probe) && createRunLock(claimPath, owner)))) {
        try {
          if (createRunLock(path, owner)) return true;
          if (reclaimRunLock(path, owner, probe) && createRunLock(path, owner)) return true;
        } finally {
          if (readLock(claimPath)?.token === owner.token) rmSync(claimPath, { force: true });
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false; // caller can retry later or inspect the retained lock
      Atomics.wait(sleeper, 0, 0, Math.min(remaining, Math.max(10, Math.min(25, pollMs))));
    }
  } finally {
    rmSync(waiterPath, { force: true });
  }
}

function withRecordLock(id, dir, opts, action, onLocked) {
  const lockPath = join(dir, `${id}.lock`);
  const owner = { pid: process.pid, host: hostname(), token: randomUUID(), at: Date.now() };
  mkdirSync(dir, { recursive: true });
  if (!acquireRunLock(lockPath, owner, opts)) return onLocked();
  try {
    return action();
  } finally {
    if (readLock(lockPath)?.token === owner.token) rmSync(lockPath, { force: true });
  }
}

// Shared by file and memory CAS; mutate receives a detached record and cannot change its id.
function mutateRun(id, fresh, mutate) {
  const rev = nextRevision(revision(fresh));
  const next = mutate(structuredClone(fresh));
  assertRunRecord(next, 'mutated run record');
  if (next.id !== id) throw new TypeError('operations: mutation must keep the same run id');
  const record = { ...next, rev, generation: runGeneration(fresh) };
  if (record.generation === undefined) delete record.generation;
  return record;
}

/**
 * Compare and swap under a per-record lock. Missing means changed; unreadable evidence is never
 * overwritten. Plain writeRun shares the lock and throws if its bounded wait expires.
 * @returns {{applied:true, record:object}|{applied:false, reason:'changed'|'locked'|'unreadable'}}
 */
export function updateRunIf(id, expected, mutate, dir = resolveRunsDir(), opts = {}) {
  const path = runPath(id, dir);
  return withRecordLock(id, dir, opts, () => {
    let fresh;
    try {
      // Read directly so ENOENT is distinct from corrupt JSON and other IO failures.
      const parsed = parseRunRecord(readFileSync(path, 'utf8'));
      if (!parsed.ok) return { applied: false, reason: 'unreadable' };
      fresh = parsed.record;
      revision(fresh);
      runGeneration(fresh);
      if (fresh.id !== id) return { applied: false, reason: 'unreadable' };
    } catch (error) {
      return { applied: false, reason: error.code === 'ENOENT' ? 'changed' : 'unreadable' };
    }
    if (!matchesRunSnapshot(fresh, expected)) return { applied: false, reason: 'changed' };
    const record = mutateRun(id, fresh, mutate);
    writeJsonAtomic(path, record); // do not call writeRun: CAS stamps exactly once
    return { applied: true, record };
  }, () => ({ applied: false, reason: 'locked' }));
}

/** Every run id currently on disk (sorted). Temp files and stray names are ignored. */
export function listRunIds(dir = resolveRunsDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isValidRunId)
    .sort();
}

/** Delete under the shared record lock; a missing record is a no-op, a lock timeout throws. */
export function deleteRun(id, dir = resolveRunsDir(), opts = {}) {
  const path = runPath(id, dir);
  return withRecordLock(id, dir, opts, () => {
    rmSync(path, { force: true });
  }, () => {
    throw new Error(`operations: run lock timed out deleting ${id}; retry later or inspect the retained lock`);
  });
}

/**
 * #4089 (epic #3383/#4075, statute `#conveyor-session-lifecycle-policy` clause 1) — IS A RUN RECORD SAFE TO
 * PRUNE? A run with `pending` still set, or any effect still `pending`/`in-flight`, is mid-flight: this file's
 * own header says a run record "dies when the run is done" — pruning one that is NOT done would discard the
 * cursor/effects state a resume needs, exactly the loss the `pending`/`in-flight` distinction ({@link
 * ./run-record.mjs}'s own doc) exists to prevent. `declared`/`applied`/`failed` effects carry no live external
 * work to lose, so a record whose effects are ALL one of those (or empty) is terminal. A malformed record
 * (missing `effects`) is treated as NOT terminal — never prune on an unreadable shape.
 * @param {object} record
 * @returns {boolean}
 */
export function isRunRecordTerminal(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.pending !== null && record.pending !== undefined) return false;
  if (!Array.isArray(record.effects)) return false;
  return !record.effects.some((e) => e && (e.status === 'pending' || e.status === 'in-flight'));
}

/**
 * #4089 — THE ROOT-CAUSE FIX for the gap `#4082`'s own card named verbatim: "Delete helpers exist but nothing
 * calls them" (`we:scripts/operations/run-store.mjs:121`, i.e. {@link deleteRun} itself) — measured live at 92
 * `.operations/runs/` entries with nothing ever pruning them. Deletes every TERMINAL ({@link isRunRecordTerminal})
 * run record WITHOUT a PR result whose file is at least `maxAgeMs` old (by mtime — a run record has no `finishedAt` field of its
 * own to read instead). This is deliberately NOT scoped to any one conveyor session — unlike a completion
 * record or a delivery report (both keyed 1:1 by session slug), a run record's `id` is minted by whichever
 * declared operation started it (`newRunId(op)` — `we:scripts/operations/run.mjs`, `land-advance-cli.mjs`,
 * `backlog.mjs`'s `claim`, …) and carries no reliable back-reference to a conveyor session name, so there is no
 * honest way to answer "is this run THIS session's run" — see this file's own PR for that reasoning. Pruning by
 * terminal-state + age is the safe, generic axis this module CAN answer correctly, and it is exactly the axis
 * the statute's own ceiling setting already describes as a safety valve for state that "dies when the run is
 * done" — never touches a record still doing anything, and a `maxAgeMs` of `null` (the 'never' setting) turns
 * this into a no-op read-only pass rather than an implicit always-off default.
 * `dryRun` (#4089) reports exactly what WOULD be pruned without deleting anything — the same convention
 * `session-reaper.mjs`'s own `runSessionReaperPass`/`runRetentionSweepPass` use, load-bearing for THAT
 * caller's own `--dry-run` to stay honest rather than pruning run records unconditionally underneath a
 * caller that asked for a preview.
 * @param {{dir?:string, maxAgeMs:number|null, now?:number, statFn?:Function, dryRun?:boolean}} o
 * @returns {{scanned:number, pruned:string[], kept:string[], corrupt:string[]}}
 */
export function pruneTerminalRuns({ dir = resolveRunsDir(), maxAgeMs, now = Date.now(), statFn = statSync, dryRun = false } = {}) {
  const pruned = [];
  const kept = [];
  const corrupt = [];
  const ids = listRunIds(dir);
  if (maxAgeMs === null || maxAgeMs === undefined) return { scanned: ids.length, pruned, kept: ids, corrupt };
  for (const id of ids) {
    let record;
    try {
      record = tryReadRun(id, dir);
    } catch {
      corrupt.push(id); // a torn record — never silently deleted, see tryReadRun's own refusal policy
      continue;
    }
    // PR evidence outlives the cursor. Without confirmed closure, retain conservatively forever.
    if (!record || !isRunRecordTerminal(record) || record.effects.some(e => e?.result?.pr)) {
      kept.push(id);
      continue;
    }
    let ageMs;
    try {
      ageMs = now - statFn(runPath(id, dir)).mtimeMs;
    } catch {
      kept.push(id); // file vanished mid-sweep, or an unreadable stat — leave it for the next pass
      continue;
    }
    if (ageMs >= maxAgeMs) {
      if (!dryRun) deleteRun(id, dir);
      pruned.push(id);
    } else {
      kept.push(id);
    }
  }
  return { scanned: ids.length, pruned, kept, corrupt };
}

/**
 * THE STORE HANDLE the effect executor and every adapter take, so nothing above this line imports `fs`.
 * THIS is the #2626 swap point: a shared DO/D1-backed store implements the same methods and no caller
 * changes.
 *
 * @param {string} [dir]
 * @returns {{read:Function, write:Function, updateIf:Function, delete:Function, list:Function}}
 */
export function createFileRunStore(dir = resolveRunsDir()) {
  return {
    read: (id) => tryReadRun(id, dir),
    write: (record, opts) => persistRun(record, dir, opts),
    updateIf: (id, expected, mutate, opts) => updateRunIf(id, expected, mutate, dir, opts),
    delete: (id, opts) => deleteRun(id, dir, opts),
    list: () => listRunIds(dir),
  };
}

/**
 * An in-memory store with the same methods — for tests, and for a caller that wants a run to live and
 * die inside one process. It SERIALIZES on write and re-parses on read, so it catches the same shape bugs
 * the file store would instead of quietly sharing a mutable object.
 */
export function createMemoryRunStore() {
  const map = new Map();
  return {
    read: (id) => {
      const text = map.get(id);
      if (text === undefined) return null;
      const parsed = parseRunRecord(text);
      if (!parsed.ok) throw new Error(`operations: refusing to read run ${id} — ${parsed.reason}`);
      return parsed.record;
    },
    write: (record) => {
      assertRunRecord(record);
      const disk = map.has(record.id) ? JSON.parse(map.get(record.id)) : null;
      const rev = nextRevision(Math.max(revision(record), revision(disk)));
      const persisted = { ...record, rev, generation: runGeneration(disk) ?? randomUUID() };
      map.set(record.id, serializeRunRecord(persisted));
      return persisted;
    },
    updateIf: (id, expected, mutate) => {
      const text = map.get(id);
      if (text === undefined) return { applied: false, reason: 'changed' };
      const parsed = parseRunRecord(text);
      if (!parsed.ok) return { applied: false, reason: 'unreadable' };
      if (!matchesRunSnapshot(parsed.record, expected)) {
        return { applied: false, reason: 'changed' };
      }
      const record = mutateRun(id, parsed.record, mutate);
      map.set(id, serializeRunRecord(record));
      return { applied: true, record };
    },
    delete: (id) => { map.delete(id); },
    list: () => [...map.keys()].sort(),
  };
}
