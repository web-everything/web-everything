/**
 * @file scripts/operations/completion-store.mjs
 * @description THE THIN IO SHELL over {@link ./completion-record.mjs} (#3436) — same split as
 * `we:scripts/operations/run-store.mjs`, re-exported here so a caller has one import.
 *
 * WHERE COMPLETIONS LIVE, AND WHY. A **gitignored session-local sidecar** — `we:.operations/completions/
 * <session>.json` — same directory family as `we:.operations/runs/`, already excluded wholesale by
 * `.gitignore`. Clause 1 of
 * [#state-lives-where-its-nature-dictates](../../docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates):
 * a dispatched agent's own outcome is transient session state, not durable repo readiness, and belongs in a
 * sidecar the card-mutation guard never polices.
 *
 * Resolved by SCRIPT LOCATION, never CWD — same reasoning as `run-store.mjs#RUNS_ROOT` (a record written from
 * one lane clone and read from the primary checkout, or vice versa, must resolve to the SAME sidecar).
 * `OPERATION_COMPLETIONS_DIR` overrides it, for tests and any out-of-tree caller.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { assertCompletionRecord, isValidSessionSlug, parseCompletionRecord, serializeCompletionRecord } from './completion-record.mjs';
import { envelopeFromLegacy } from './worker-result-router.mjs';
import { tryReadDeliveryReport } from './delivery-report-store.mjs';
import { tryReadFixReport } from './fix-report-store.mjs';
import { reserve, releaseLockDir } from '../readiness/file-locks.mjs';
import { sleepSyncMs } from '../readiness/drain-lock.mjs';

export {
  COMPLETION_KINDS,
  COMPLETION_RECORD_VERSION,
  COMPLETION_RECORD_V2,
  COMPLETION_READ_VERSIONS,
  ENVELOPE_ROLES,
  ENVELOPE_LAUNCHERS,
  ENVELOPE_SOURCES,
  newEnvelopeRecord,
  finishEnvelopeRecord,
  COMPLETION_STATUSES,
  applyCompletionUpdate,
  assertCompletionRecord,
  isForeignCompletionSessionId,
  isValidSessionSlug,
  newCompletionRecord,
  parseCompletionRecord,
  serializeCompletionRecord,
  validateCompletionRecord,
} from './completion-record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const COMPLETIONS_ROOT = resolve(HERE, '..', '..');

/** `<root>/.operations/completions` — the sidecar directory. */
export function completionsDir(root = COMPLETIONS_ROOT) {
  return join(root, '.operations', 'completions');
}

/** The canonical completions directory every consumer resolves to; `OPERATION_COMPLETIONS_DIR` wins when set. */
export function resolveCompletionsDir() {
  const env = process.env.OPERATION_COMPLETIONS_DIR;
  return env && env.trim() ? resolve(env.trim()) : completionsDir();
}

/** The on-disk path of one session's completion record. Refuses a slug that is not filename-safe. */
export function completionPath(session, dir = resolveCompletionsDir()) {
  if (!isValidSessionSlug(session)) throw new TypeError(`operations: invalid completion session slug ${JSON.stringify(session)}`);
  return join(dir, `${session}.json`);
}

/**
 * #4306 (epic #3383/#4075) — the per-completion-NAME lock root, NESTED inside the completions dir itself (never
 * a sibling of it, and never `we:scripts/operations/coordination-root.mjs`'s cross-checkout root — a completion
 * record is checkout-local, see this file's own header) so it always resolves under whichever `dir` is active —
 * the real sidecar, or a TEST's own `OPERATION_COMPLETIONS_DIR` override, which mints a fresh unique directory
 * per test; a sibling-of-`dir` root would instead collapse to the shared OS temp root for every test process,
 * risking a real cross-test lock collision on a session name two suites happen to share. `listCompletionSessions`
 * already filters by `.json` extension, so this subdirectory is never mistaken for a stray completion record.
 */
export function completionLockRoot(dir = resolveCompletionsDir()) {
  return join(dir, '.locks');
}

/** Bounded wait before {@link withCompletionLock} gives up — "a short wait with a clear error, never an
 *  unbounded wait" (`we:backlog/4306-*.md`'s own Risks section: lock contention here is negligible — one read
 *  and one rename, a few `report` calls per session). */
export const COMPLETION_LOCK_WAIT_MS = 5_000;
export const COMPLETION_LOCK_POLL_MS = 25;

/**
 * we:scripts/operations/completion-store.mjs#withCompletionLock — THE PRIMITIVE REUSED, NOT REINVENTED: the
 * same `we:scripts/readiness/file-locks.mjs` O_EXCL-mkdir / heartbeat-TTL-lease design
 * `we:scripts/conveyor/fix-dispatch-claim.mjs#acquireFixDispatchClaim` already uses for its own synthetic
 * resource key, here keyed `completion:<name>` — a completion record's NAME, never a real file on disk.
 * Guards the read-decide-write critical section every writer of one session's completion record must share:
 * the CLI `report` command wraps its WHOLE existing/decide/write sequence in this (so two concurrent `started`
 * reports for the same name never race), and {@link writeCompletion}'s own `expectPrior` conditional write
 * takes it internally so the reaper's single backstop write is equally race-free without its caller needing to
 * know the lock exists at all.
 * @param {string} name - the completion-record session slug (the lock key, not validated here — a caller with
 *   an invalid slug will fail at `completionPath` regardless).
 * @param {() => *} fn - the critical section; its return value is this function's own return value.
 * @param {{dir?:string, lockRoot?:string, waitMs?:number, pollMs?:number, now?:() => number, sleep?:(ms:number) => void}} [o]
 * @returns {*} whatever `fn()` returns.
 */
export function withCompletionLock(name, fn, {
  dir = resolveCompletionsDir(), lockRoot = completionLockRoot(dir),
  waitMs = COMPLETION_LOCK_WAIT_MS, pollMs = COMPLETION_LOCK_POLL_MS, now = Date.now, sleep = sleepSyncMs,
} = {}) {
  const resource = `completion:${name}`;
  const owner = `${process.pid}:${now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = now() + waitMs;
  const tryOnce = () => reserve(lockRoot, resource, owner, now(), new Date(now()).toISOString());
  let acq = tryOnce();
  while (!acq.ok && now() < deadline) {
    sleep(pollMs);
    acq = tryOnce();
  }
  if (!acq.ok) {
    throw new Error(`operations: could not acquire completion lock for ${JSON.stringify(name)} within ${waitMs}ms (held by ${acq.heldBy ?? 'unknown'})`);
  }
  try {
    return fn();
  } finally {
    releaseLockDir(lockRoot, resource);
  }
}

/**
 * Read a completion record. Returns `null` ONLY when the file genuinely does not exist. THROWS on a corrupt
 * record — a torn record must never be mistaken for "nothing was ever reported" (mirrors
 * `run-store.mjs#tryReadRun`).
 * @returns {object|null}
 */
export function tryReadCompletion(session, dir = resolveCompletionsDir()) {
  const path = completionPath(session, dir);
  if (!existsSync(path)) return null;
  const parsed = parseCompletionRecord(readFileSync(path, 'utf8'));
  if (!parsed.ok) {
    throw new Error(
      `operations: refusing to read completion record for ${session} — ${parsed.reason} (${path}). ` +
      'Fix or delete the file; a corrupt record is never treated as one that was never written.',
    );
  }
  return parsed.record;
}

/** {@link tryReadCompletion}, but a missing record is a refusal too. */
export function readCompletion(session, dir = resolveCompletionsDir()) {
  const record = tryReadCompletion(session, dir);
  if (!record) throw new Error(`operations: no completion record for ${JSON.stringify(session)} at ${completionPath(session, dir)}`);
  return record;
}

/**
 * The per-outcome STREAK fields {@link writeCompletion} maintains: `outcome → [countField, sinceField]`. One row
 * per self-reported "blocked" outcome the reconciler caps (`INFRA_RETRY_CAP`, `PERMISSION_RETRY_CAP`).
 */
const STREAK_FIELDS = {
  'blocked-on-infra': ['infraStreak', 'infraStreakSince'],
  'blocked-on-permission': ['permissionStreak', 'permissionStreakSince'],
};

const positiveStreak = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

/**
 * we:scripts/operations/completion-store.mjs#writeCompletion — persist a completion record. ATOMIC (temp file +
 * rename), so a reader mid-write never sees partial JSON.
 *
 * #xilx617 (epic #4075/#3383) — ALSO maintains the durable per-SESSION `blocked-on-infra` STREAK here, in the
 * store's OWN write path, so every writer (the `report` CLI's started/done paths, any future caller) gets it
 * with no per-caller logic (`we:backlog/xilx617-*.md`'s own brief: "do it in the store's write path so every
 * writer gets it"). A session slug (`review-<pr>`/`fix-<pr>`) is REUSED across dispatch generations
 * (`we:scripts/operations/completion-cli.mjs#runReport`'s own `started` path mints a brand-new record from
 * scratch on a fresh generation), which would otherwise wipe any `infraStreak`/`infraStreakSince` the PREVIOUS
 * generation's `done` record carried — so this path carries it forward across a `started` write and only
 * mutates it on a `done` write:
 *   - `status:'done'` + `outcome:'blocked-on-infra'` — increments the PREVIOUS on-disk record's streak
 *     (defaulting to 0 when there was none), keeping ITS OWN first timestamp (`infraStreakSince`).
 *   - `status:'done'` + any OTHER outcome — drops both fields; the streak is over.
 *   - `status:'started'` — carries the previous on-disk streak through UNCHANGED (this write represents no
 *     outcome at all), so it survives to the NEXT `done` write.
 * `blocked-on-permission` keeps its own `permissionStreak`/`permissionStreakSince` the same way (PR #3990
 * review: it fed no counter, so a permission-walled PR was re-dispatched forever); a `done` write of one
 * blocked outcome ends the other's streak.
 * The previous record is read straight out of this SAME directory/file about to be overwritten — one extra
 * small JSON read, not a new fact source — so this needs no new IO wiring.
 * {@link ../conveyor/reconcile-core.mjs#markSelfReportedDone} is the reader: it uses the persisted
 * `infraStreak` to decide between {@link ../conveyor/reconcile-core.mjs#INFRA_RETRY_COOLOFF_MS} and
 * {@link ../conveyor/reconcile-core.mjs#INFRA_RETRY_CAPPED_COOLOFF_MS}.
 *
 * #4306 (epic #3383/#4075) — `{expectPrior}` is the OPT-IN conditional-write guard: when given (even
 * `expectPrior: null`, meaning "I planned this against no existing record at all"), the write happens under
 * {@link withCompletionLock} and only proceeds if a FRESH re-read of the on-disk record still matches
 * `expectPrior` on `status`/`startedAt`/`updatedAt`/`sessionId` — otherwise nothing is written and this
 * returns `{written:false, reason:'changed'}` instead. This is what lets a `started` report that lands between
 * the reaper's read and its write WIN: the reaper plans its backstop against the record it read, and the
 * conditional write refuses to clobber a DIFFERENT record that landed in between. Omitting `expectPrior`
 * (every pre-existing caller) is BYTE-IDENTICAL to before this option existed — no lock, no compare, the bare
 * on-disk `path` returned exactly as always.
 * @param {object} record
 * @param {string} [dir]
 * @param {{expectPrior?:object|null}} [o]
 * @returns {string|{written:boolean, path?:string, reason?:string}}
 */
export function writeCompletion(record, dir = resolveCompletionsDir(), { expectPrior } = {}) {
  assertCompletionRecord(record, 'completion record being written');
  const conditional = expectPrior !== undefined;

  const doWrite = () => {
    const path = completionPath(record.session, dir);
    let prev = null;
    try { prev = tryReadCompletion(record.session, dir); } catch { prev = null; }
    if (conditional && !completionRecordMatches(prev, expectPrior)) {
      return { written: false, reason: 'changed' };
    }
    mkdirSync(dir, { recursive: true });
    let toWrite = record;
    if (record.status === 'done') {
      // A `done` write ends every streak but its OWN outcome's — "consecutive" means the same outcome again.
      // `outcome` is agent-supplied free text: `Object.hasOwn`, so `constructor`/`__proto__` cannot reach the prototype.
      const own = Object.hasOwn(STREAK_FIELDS, record.outcome) ? STREAK_FIELDS[record.outcome] : null;
      const rest = { ...record };
      for (const [count, since] of Object.values(STREAK_FIELDS)) { delete rest[count]; delete rest[since]; }
      toWrite = rest;
      if (own) {
        const [count, since] = own;
        const prevStreak = positiveStreak(prev?.[count]);
        toWrite = { ...rest, [count]: prevStreak + 1, [since]: prevStreak > 0 && prev?.[since] ? prev[since] : record.updatedAt };
      }
    } else {
      const carried = {};
      for (const [count, since] of Object.values(STREAK_FIELDS)) {
        const prevStreak = positiveStreak(prev?.[count]);
        if (prevStreak > 0) { carried[count] = prevStreak; carried[since] = prev[since] ?? prev.updatedAt; }
      }
      toWrite = { ...record, ...carried };
    }

    // #4314 (prevention guard owed by web-everything/web-everything#2831's independent review, finding 4) —
    // the write is temp-file-then-rename for atomicity, but a failure between the two (a real EISDIR/ENOTDIR
    // from a corrupted or concurrently-modified completions dir, a full disk, a permission error) used to leave
    // the `.tmp` file on disk forever: nothing else in this module, or any reader (`listCompletionSessions`),
    // ever reaps it. The `finally` block is the cleanup guard: on ANY throw from the write-then-rename pair, the
    // temp file is removed (best effort — a failure to remove it must never mask the ORIGINAL error) before the
    // original error propagates.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    let renamed = false;
    try {
      writeFileSync(tmp, serializeCompletionRecord(toWrite));
      renameSync(tmp, path);
      renamed = true;
    } finally {
      if (!renamed) { try { rmSync(tmp, { force: true }); } catch { /* best effort; the original error wins */ } }
    }
    return conditional ? { written: true, path } : path;
  };

  return conditional ? withCompletionLock(record.session, doWrite, { dir }) : doWrite();
}

/** Do two completion-record snapshots (or `null`s) agree on the four fields {@link writeCompletion}'s
 *  `expectPrior` guard cares about? Pure. `null`/`null` matches (both "nothing was ever written"). */
function completionRecordMatches(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.status === b.status && a.startedAt === b.startedAt && a.updatedAt === b.updatedAt
    && (a.sessionId ?? null) === (b.sessionId ?? null);
}

/** Every session slug with a completion record on disk (sorted). Temp files and stray names are ignored. */
export function listCompletionSessions(dir = resolveCompletionsDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isValidSessionSlug)
    .sort();
}

/** Delete a session's completion record. A no-op when it is already gone. */
export function deleteCompletion(session, dir = resolveCompletionsDir()) {
  rmSync(completionPath(session, dir), { force: true });
}

/**
 * THE STORE HANDLE — mirrors `run-store.mjs#createFileRunStore`'s four methods, the #2626 swap point.
 * @param {string} [dir]
 */
export function createFileCompletionStore(dir = resolveCompletionsDir()) {
  return {
    read: (session) => tryReadCompletion(session, dir),
    write: (record) => { writeCompletion(record, dir); return record; },
    delete: (session) => deleteCompletion(session, dir),
    list: () => listCompletionSessions(dir),
  };
}

/**
 * Item 117 S2 (D2) — THE ONE READER. Looks a session up in the completion store first (v1 or v2), then in the two
 * folded stores (delivery-report, fix-report), and returns it AS A v2 ENVELOPE (`{found, ...envelope}` shape is the
 * CLI's job). A v1 record is mapped, never rewritten on disk. `null` when no store has the session.
 * `dirs` overrides each store's directory (tests, and the build wrapper's lane-scoped delivery-reports dir).
 * @param {string} session
 * @param {{completions?: string, deliveryReports?: string, fixReports?: string}} [dirs]
 * @returns {object|null}
 */
export function readEnvelope(session, dirs = {}) {
  const rec = tryReadCompletion(session, dirs.completions ?? resolveCompletionsDir());
  if (rec) return rec.v === COMPLETION_RECORD_V2_VALUE ? rec : envelopeFromLegacy(rec, 'legacy-completion');
  const delivery = dirs.deliveryReports === null ? null : tryReadDeliveryReport(session, dirs.deliveryReports);
  if (delivery) return envelopeFromLegacy(delivery, 'legacy-delivery-report');
  const fix = dirs.fixReports === null ? null : tryReadFixReport(session, dirs.fixReports);
  if (fix) return envelopeFromLegacy(fix, 'legacy-fix-report');
  return null;
}
const COMPLETION_RECORD_V2_VALUE = 2;
