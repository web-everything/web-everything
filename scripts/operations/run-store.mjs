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

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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
 * `legacyDir` (a clone's old `.operations/runs`) into `sharedDir`: copy to a temp name, atomic rename into
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
        copyFileSync(src, tmp);
        renameSync(tmp, dest);
        moved.push(f.slice(0, -5));
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
export function writeRun(record, dir = resolveRunsDir()) {
  assertRunRecord(record, 'run record being written');
  const path = runPath(record.id, dir);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path, record); // temp file + validate + same-fs rename: safe across daemon processes
  return path;
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

/** Delete a run's record. A no-op when it is already gone. */
export function deleteRun(id, dir = resolveRunsDir()) {
  rmSync(runPath(id, dir), { force: true });
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
 * THIS is the #2626 swap point: a shared DO/D1-backed store implements the same four methods and no caller
 * changes.
 *
 * @param {string} [dir]
 * @returns {{read(id: string): (object|null), write(record: object): object, delete(id: string): void, list(): string[]}}
 */
export function createFileRunStore(dir = resolveRunsDir()) {
  return {
    read: (id) => tryReadRun(id, dir),
    write: (record) => { writeRun(record, dir); return record; },
    delete: (id) => deleteRun(id, dir),
    list: () => listRunIds(dir),
  };
}

/**
 * An in-memory store with the same four methods — for tests, and for a caller that wants a run to live and
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
    write: (record) => { assertRunRecord(record); map.set(record.id, serializeRunRecord(record)); return record; },
    delete: (id) => { map.delete(id); },
    list: () => [...map.keys()].sort(),
  };
}
