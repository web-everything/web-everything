#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-clone-lock.mjs
 * @description Card 4041/x3ecgta — the per-CLONE reader/writer lock that lets several daemons and one-shot
 *   operator CLIs safely share ONE daemon clone while `daemon-rebuild.mjs` (card 4044) moves it under them.
 *   Ruling: docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle (clauses 2-5).
 *
 * WHY a reader/writer lock, not just the per-path lock `scripts/readiness/file-locks.mjs` already has: that
 * module guards individual FILES inside the shared central checkout so two lanes never edit the same path.
 * Here the unit under contention is an entire CLONE'S WORKING TREE moving out from under a running tick — a
 * rebuild does `git reset --hard` to a brand-new commit while ticks (readers) are mid-flight reading files off
 * disk. A rebuild that runs concurrently with a tick can hand that tick a torn, half-old-half-new tree; a tick
 * that starts reading while a rebuild is mid-`reset --hard` sees the same. So: many readers may run at once
 * (ticks never contend with each other — the object DB move in `daemon-rebuild.mjs` is what actually mutates
 * the tree, not a tick), but a writer (a rebuild) needs EXCLUSIVE access — no readers in flight, and no other
 * writer. Classic single-writer/many-readers, built with ZERO new fs primitives: `file-locks.mjs`'s
 * atomic-mkdir + heartbeat-TTL-lease + same-host-pid-fast-path primitives already solve "one key, one
 * true owner, reclaim a dead one" — this module only adds the READER/WRITER SHAPE (two key spaces under one
 * per-clone root, plus the Dekker-ordered handshake between them) on top.
 *
 * Lock home is DELIBERATELY OUTSIDE any git tree (`~/.claude/daemon-clone-locks` by default, overridable via
 * `WE_DAEMON_CLONE_LOCK_ROOT`): a lock file living INSIDE the clone would itself be wiped/moved by the very
 * `git reset --hard` it is meant to guard, and would show up as clone-dirty state to every git status check.
 * Per-clone dirs are keyed by `lockIdFor(canonicalCloneRoot(root))`: realpath first (falling back if it doesn't
 * exist yet / realpath throws), then logical clone mapping, so different spellings of the same clone
 * (a symlink, a relative vs. absolute invocation) collide on the same lock — exactly the property `daemon-overlays.mjs`'s `cloneKey`
 * independently needs for its own per-clone state file, and exactly why both use `realpath`-first.
 *
 * Reclaim: liveness of ANY entry here (a writer or a reader) is `!isLeaseExpired(...) && probe(entry) !== 'dead'`
 * — the SAME two-tier floor `file-locks.mjs#reclaimDecision` encodes (TTL lease is the correctness floor,
 * same-host PID-liveness is a fast path layered on top, never primary, since PIDs get reused). We don't call
 * `reclaimDecision` directly for the reader/writer semantics because ITS single-owner-per-path shape assumes
 * exactly one contender at a time; the writer-vs-readers handshake below needs to reason about a WHOLE SET of
 * reader entries relative to one writer, so we use the lower primitives (`reserve` for the atomic
 * acquire-or-reclaim of one key, `readLockEntry`/`releaseLockDir`/`heartbeat`/`isLeaseExpired` for the rest) and
 * compose the reader/writer protocol ourselves.
 */

import { hostname, homedir } from 'node:os';
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { canonicalCloneRoot } from './daemon-clone-layout.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  reserve,
  readLockEntry,
  releaseLockDir,
  heartbeat,
  parseLockEntry,
  isLeaseExpired,
  lockIdFor,
} from '../readiness/file-locks.mjs';

/** Default lease for a clone lock entry (writer or reader) before it is considered stale and reclaimable.
 *  Shorter than `file-locks.mjs`'s own 15-minute default: a clone-lock holder is a single tick or a single
 *  rebuild pass, not a whole lane's reserve→edit→commit→push window, so a much shorter lease still comfortably
 *  outlasts a normal hold while freeing a crashed holder's slot sooner. */
export const DEFAULT_LEASE_MINUTES = 10;

/** How often a live holder should refresh its heartbeat while it holds the lock (`withReadLock`/`withWriteLock`
 *  do this automatically). Advisory; the lock logic itself only ever reads `heartbeatAt`. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** The single fixed key every writer reservation is made under — there is only ever ONE writer slot per
 *  clone, unlike readers (one key per owner), so `writer/` never has more than one lock dir inside it. */
const WRITER_KEY = '<clone:writer>';

/** Default clone-lock home — OUTSIDE any git tree (see file header for why). */
function defaultLockRoot() {
  return process.env.WE_DAEMON_CLONE_LOCK_ROOT || join(homedir(), '.claude', 'daemon-clone-locks');
}

/** Default owner identity: `<host>:<pid>` — same shape `daemon-self-sync.mjs`/`file-locks.mjs` entries use,
 *  so a reused PID on a different host never collides and {@link defaultProbePidLiveness} can parse it back. */
export function defaultOwner(pid = process.pid) {
  return `${hostname()}:${pid}`;
}

/** Stable per-clone key: realpath-or-resolve, then the logical identity shared by every version. */
export function cloneLockKey(root) {
  return lockIdFor(canonicalCloneRoot(root));
}

/** The three directories a clone's lock lives under: a per-clone `base`, its single-key `writer/`, and its
 *  one-key-per-owner `readers/`. Exported so the CLI / tests can point straight at them without recomputing. */
export function cloneLockDirs(root, lockRoot = defaultLockRoot()) {
  const base = join(lockRoot, cloneLockKey(root));
  return { base, writerRoot: join(base, 'writer'), readersRoot: join(base, 'readers'), starvedRoot: join(base, 'starved') };
}

// ── reader fairness (live 2026-10-05 20:18-20:37 ET) ─────────────────────────────────────────────────────────
// The review and fix-dispatch daemons share one clone and BOTH start every tick with a rebuild that reserves the
// writer and then waits (60s, 180s, up to 900s when "starved") for the other's reader to drain — refusing every
// NEW read for that whole wait. With main moving every few minutes the writer slot was almost never free when the
// review daemon's tick began: 11 ticks in a row skipped `writer-active`, CI-green PRs got no review. Nothing
// tracked a refused reader, so nothing ever yielded to it. Now a refused reader records a starvation claim; once
// it has been refused READER_PRIORITY_AFTER times in a row, every writer still in its DRAIN wait (it has not
// moved anything yet) backs off with `reader-priority`, and no new writer reserves until that reader gets in.
// A writer that already holds the clone (drain done, moving the tree) is never interrupted, so the #4044
// never-read-a-tree-mid-move guarantee is untouched: a reader still only ever gets in when no writer key exists.

/** Setting: consecutive refused read attempts after which a reader has priority over waiting writers.
 *  Default 3; `0` turns reader priority off (the old writer-preferring behaviour). */
export const READER_PRIORITY_AFTER_ENV = 'WE_DAEMON_CLONE_LOCK_READER_PRIORITY_AFTER';
export const DEFAULT_READER_PRIORITY_AFTER = 3;

/** PURE: the reader-priority threshold from env (a non-negative integer, else the default; 0 = off). */
export function resolveReaderPriorityAfter(env = process.env) {
  const raw = env?.[READER_PRIORITY_AFTER_ENV];
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_READER_PRIORITY_AFTER;
}

function starvedFile(starvedRoot, readerKey) {
  return join(starvedRoot, `${lockIdFor(readerKey)}.json`);
}

function readStarvedRecords(starvedRoot) {
  let names;
  try { names = readdirSync(starvedRoot); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(join(starvedRoot, name), 'utf8'));
      if (rec && typeof rec.owner === 'string' && Number.isInteger(rec.count)) out.push({ ...rec, file: join(starvedRoot, name) });
    } catch { /* corrupt/half-written — ignored */ }
  }
  return out;
}

/** Record one more consecutive refusal for `readerKey`; returns the new count. Best-effort (a lost write only
 *  delays priority by a tick). */
function noteReaderRefused(starvedRoot, { readerKey, owner, pid, nowMs, heldBy }) {
  const file = starvedFile(starvedRoot, readerKey);
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const count = (Number.isInteger(prev?.count) ? prev.count : 0) + 1;
  const nowIso = new Date(nowMs).toISOString();
  const rec = {
    readerKey, owner, pid, count, heldBy: heldBy ?? null, firstRefusedAt: prev?.firstRefusedAt ?? nowIso, lastRefusedAt: nowIso,
  };
  try {
    mkdirSync(starvedRoot, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(rec)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch { /* best-effort */ }
  return count;
}

function clearReaderStarved(starvedRoot, readerKey) {
  try { rmSync(starvedFile(starvedRoot, readerKey), { force: true }); } catch { /* best-effort */ }
}

/** The live starved reader (if any, other than `owner`) that writers must yield to. A claim lapses with the same
 *  lease as a lock entry (`lastRefusedAt` older than `leaseMinutes`) or when its same-host pid is dead — those
 *  are removed on sight, so a crashed reader can never hold writers off. */
function findPriorityReader(starvedRoot, { owner, nowMs, leaseMinutes, probe, after }) {
  if (!(after > 0)) return null;
  for (const rec of readStarvedRecords(starvedRoot)) {
    const asEntry = { owner: rec.owner, pid: rec.pid, heartbeatAt: rec.lastRefusedAt };
    if (!entryIsLive(asEntry, nowMs, leaseMinutes, probe)) {
      try { rmSync(rec.file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    if (rec.owner === owner) continue;
    if (rec.count >= after) return rec;
  }
  return null;
}

// ── writer fairness (live 2026-10-06 01:50-07:20 ET) ─────────────────────────────────────────────────────────
// The mirror image of reader fairness above. The fix-dispatch daemon ticks back-to-back (event-driven wakes) and
// each tick holds its read slot for minutes; the review daemon only tries to move the clone once per ITS tick
// start, waits up to 900s for that read slot, gives up, ticks itself, and tries again — finding the sibling
// mid-tick every time. Between attempts no writer key exists, so the sibling's next tick always got straight in:
// the clone did not move for 5.5 h. Now a writer that gave up `tick-in-progress` WRITER_PRIORITY_AFTER times in a
// row leaves a writer-priority claim; while it is live, NEW reads by anyone else are refused `writer-priority`
// (ticks already in flight are never touched, so #4044 never-read-mid-move holds trivially), so the in-flight ticks
// drain and the next writer gets the clone. Any writer that gets the clone clears the claim (the clone is moving).
// No mutual back-off: the OLDER claim wins — a writer only yields to a starved reader whose starvation began
// before the writer's claim, and a reader only ignores a writer claim younger than its own starvation. Refusals
// by a writer claim never count toward reader starvation, so they can never re-trigger reader priority.

/** Setting: consecutive `tick-in-progress` give-ups after which a writer's claim blocks NEW reads. Default 1;
 *  `0` turns writer priority off (the pre-fix behaviour). */
export const WRITER_PRIORITY_AFTER_ENV = 'WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_AFTER';
export const DEFAULT_WRITER_PRIORITY_AFTER = 1;
/** Setting: how long a writer claim stays live without being refreshed by another attempt (its owner's next tick
 *  start re-tries; a claim never outlives a dead owner pid). Default 30 min — longer than one sibling tick. */
export const WRITER_CLAIM_TTL_ENV = 'WE_DAEMON_CLONE_LOCK_WRITER_CLAIM_TTL_MS';
export const DEFAULT_WRITER_CLAIM_TTL_MS = 30 * 60_000;

/** PURE: the writer-priority threshold from env (a non-negative integer, else the default; 0 = off). */
export function resolveWriterPriorityAfter(env = process.env) {
  const raw = env?.[WRITER_PRIORITY_AFTER_ENV];
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WRITER_PRIORITY_AFTER;
}

/** PURE: the writer-claim TTL from env (a positive number, else the default). */
export function resolveWriterClaimTtlMs(env = process.env) {
  const n = Number(env?.[WRITER_CLAIM_TTL_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WRITER_CLAIM_TTL_MS;
}

function writerClaimFile(starvedRoot) {
  // Beside `starved/`, never inside it: every `.json` in there is read as a starved-reader record.
  return join(starvedRoot, '..', 'writer-claim.json');
}

function readWriterClaim(starvedRoot) {
  try {
    const rec = JSON.parse(readFileSync(writerClaimFile(starvedRoot), 'utf8'));
    return rec && typeof rec.owner === 'string' && Number.isInteger(rec.count) ? rec : null;
  } catch { return null; }
}

/** Record one more consecutive `tick-in-progress` give-up by `owner`. A claim by a DIFFERENT live owner is kept
 *  (first come keeps its age); our own is bumped. Best-effort. */
function noteWriterGaveUp(starvedRoot, { owner, pid, nowMs, heldBy, ttlMs, probe }) {
  const prev = readWriterClaim(starvedRoot);
  if (prev && prev.owner !== owner && writerClaimIsLive(prev, nowMs, ttlMs, probe)) return prev;
  const same = prev && prev.owner === owner;
  const nowIso = new Date(nowMs).toISOString();
  const rec = {
    owner, pid, count: (same ? prev.count : 0) + 1, heldBy: heldBy ?? null, since: same ? prev.since : nowIso, lastAt: nowIso,
  };
  try {
    const file = writerClaimFile(starvedRoot);
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(rec)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch { /* best-effort */ }
  return rec;
}

function clearWriterClaim(starvedRoot) {
  try { rmSync(writerClaimFile(starvedRoot), { force: true }); } catch { /* best-effort */ }
}

function writerClaimIsLive(rec, nowMs, ttlMs, probe) {
  if (!rec) return false;
  const last = Date.parse(rec.lastAt || '');
  if (!Number.isFinite(last) || nowMs - last > ttlMs) return false;
  return probe({ owner: rec.owner, pid: rec.pid }) !== 'dead';
}

/** The live, effective writer claim (count ≥ `after`) other than `owner`'s own, else null. A lapsed one is
 *  removed on sight. */
function findPriorityWriter(starvedRoot, { owner, nowMs, ttlMs, probe, after }) {
  if (!(after > 0)) return null;
  const rec = readWriterClaim(starvedRoot);
  if (!rec) return null;
  if (!writerClaimIsLive(rec, nowMs, ttlMs, probe)) { clearWriterClaim(starvedRoot); return null; }
  if (rec.owner === owner || rec.count < after) return null;
  return rec;
}

const isoMs = (s) => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : Infinity; };

/**
 * Copy of `defaultProbePidLiveness` semantics (file header / #1936 Fork 2): a same-host PID probe is a FAST
 * PATH layered on top of the TTL lease, never primary (PIDs get reused). `kill(pid, 0)` throwing `ESRCH` means
 * the OS has no such process on THIS host — `dead`. Any other outcome (still running, `EPERM` meaning it
 * exists under another user, a different host, or an unparseable owner/pid) is NOT provably dead, so it stays
 * `alive`/`unknown` and only the lease-expiry floor can reclaim it.
 * @param {{owner?:string, pid?:number|null}|null} entry
 * @returns {'dead'|'alive'|'unknown'}
 */
export function defaultProbePidLiveness(entry) {
  if (!entry || !entry.owner) return 'unknown';
  const sep = entry.owner.lastIndexOf(':');
  if (sep === -1) return 'unknown';
  const host = entry.owner.slice(0, sep);
  if (host !== hostname()) return 'unknown'; // another host — PID space isn't ours to probe
  const pidFromOwner = Number(entry.owner.slice(sep + 1));
  const pid = Number.isInteger(entry.pid) ? entry.pid : (Number.isInteger(pidFromOwner) ? pidFromOwner : null);
  if (!Number.isInteger(pid)) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    if (e && e.code === 'ESRCH') return 'dead';
    return 'alive'; // e.g. EPERM: the process exists, we just can't signal it
  }
}

/** Is `entry` LIVE at `nowMs`? Live unless its lease is expired OR `probe` says the same-host owner is
 *  provably `dead` — the two-tier floor the file header describes. `null`/missing entries are never live. */
function entryIsLive(entry, nowMs, leaseMinutes, probe) {
  if (!entry) return false;
  if (isLeaseExpired(entry, nowMs, leaseMinutes)) return false;
  if (probe(entry) === 'dead') return false;
  return true;
}

/** List every reader entry currently on disk under `readersRoot`. NOT a new lock primitive — `readLockEntry`
 *  only knows how to read ONE already-known path's entry, and readers need to be enumerated (their key is the
 *  owner string, unknown to us up front), so this walks the directory and reuses {@link parseLockEntry} to
 *  interpret each `lock.json` it finds. A missing/unreadable/corrupt entry is skipped, never thrown. */
function listReaderEntries(readersRoot) {
  let names;
  try {
    names = readdirSync(readersRoot);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(readersRoot, name, 'lock.json'), 'utf8');
    } catch {
      continue;
    }
    const entry = parseLockEntry(text);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Acquire a READ slot on `root`'s clone lock. Many readers may hold this at once; a reader is only ever
 * refused by a LIVE writer (never by other readers). Dekker ordering (kept deliberately, see design spec):
 *   (1) if a live writer NOT owned by us exists → refuse immediately, never reserve.
 *   (2) reserve our own reader key (`readers/<owner>` — always ours, so this never itself blocks).
 *   (3) RE-CHECK the writer: a writer that started reserving between (1) and (2) would otherwise race us in —
 *       if a live foreign writer now exists, release the reader key we just took and refuse.
 * @param {string} root  the clone's working-tree path
 * @param {{owner?:string, lockRoot?:string, nowMs?:number, pid?:number, leaseMinutes?:number,
 *   probe?:(entry:object|null)=>('dead'|'alive'|'unknown')}} [opts]
 * A refusal is recorded as a reader-starvation claim (see "reader fairness" above) and its result carries
 * `starved` — this reader's consecutive refusal count; a successful acquire clears the claim.
 * @returns {{ok:true}|{ok:false, reason:'writer-active', heldBy:string, starved?:number}}
 */
export function acquireRead(root, opts = {}) {
  const {
    owner = defaultOwner(opts.pid),
    lockRoot = defaultLockRoot(),
    nowMs = Date.now(),
    pid = process.pid,
    leaseMinutes = DEFAULT_LEASE_MINUTES,
    probe = defaultProbePidLiveness,
    // Reader fairness: `readerKey` names this reader across restarts (a daemon passes its entry script, so a
    // restart keeps its refusal count); `trackStarvation: false` makes a refusal not count (a same-tick retry).
    readerKey = owner,
    trackStarvation = true,
    writerPriorityAfter = resolveWriterPriorityAfter(),
    writerClaimTtlMs = resolveWriterClaimTtlMs(),
  } = opts;
  const { writerRoot, readersRoot, starvedRoot } = cloneLockDirs(root, lockRoot);
  const nowIso = new Date(nowMs).toISOString();

  // Writer fairness: a starved writer's claim refuses NEW reads (never counted as reader starvation) — unless
  // this reader's own starvation is OLDER than the claim (older claim wins, so the two never both back off).
  const claim = findPriorityWriter(starvedRoot, {
    owner, nowMs, ttlMs: writerClaimTtlMs, probe, after: writerPriorityAfter,
  });
  if (claim) {
    const mine = readStarvedRecords(starvedRoot).find((r) => r.readerKey === readerKey);
    if (!(mine && isoMs(mine.firstRefusedAt) < isoMs(claim.since))) {
      return { ok: false, reason: 'writer-priority', heldBy: claim.owner, writerStarved: claim.count, claimSince: claim.since };
    }
  }

  const checkWriter = () => {
    const w = readLockEntry(writerRoot, WRITER_KEY);
    if (w && w.owner !== owner && entryIsLive(w, nowMs, leaseMinutes, probe)) {
      return { ok: false, reason: 'writer-active', heldBy: w.owner };
    }
    return null;
  };
  const refuse = (r) => {
    if (!trackStarvation) return r;
    return { ...r, starved: noteReaderRefused(starvedRoot, { readerKey, owner, pid, nowMs, heldBy: r.heldBy }) };
  };

  const refusedBefore = checkWriter();
  if (refusedBefore) return refuse(refusedBefore);

  const currentOwnEntry = readLockEntry(readersRoot, owner);
  reserve(readersRoot, owner, owner, nowMs, nowIso, pid, probe(currentOwnEntry), leaseMinutes);

  const refusedAfter = checkWriter();
  if (refusedAfter) {
    releaseLockDir(readersRoot, owner);
    return refuse(refusedAfter);
  }
  // In: our reader slot now holds any writer off by itself, so the priority claim has done its job.
  clearReaderStarved(starvedRoot, readerKey);
  return { ok: true };
}

/** Release a previously-acquired read slot. Idempotent — releasing a slot that isn't held (or was already
 *  reclaimed away) is a no-op, never an error. */
export function releaseRead(root, opts = {}) {
  const { owner = defaultOwner(opts.pid), lockRoot = defaultLockRoot() } = opts;
  const { readersRoot } = cloneLockDirs(root, lockRoot);
  releaseLockDir(readersRoot, owner);
  return { ok: true };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire the WRITE slot on `root`'s clone lock. Exactly one writer at a time; once reserved, NEW readers are
 * refused (their own `acquireRead` re-check step (3) above), and this call then waits for every already-live
 * reader other than itself to drain (or its lease to lapse) before returning ok.
 *   (1) reserve the writer key — a LIVE writer owned by someone else ⇒ `concurrent-mover` (never ours to take);
 *       a dead/expired one is reclaimed by {@link reserve} itself, same as any other stale key.
 *   (2) poll `readers/` until no LIVE entry other than `owner` remains, or `waitMs` elapses. Any dead/expired
 *       reader entry seen along the way is removed on sight (reclaim) rather than left to rot.
 *       Timeout ⇒ release the writer key we took and report `tick-in-progress` (a live tick is still running).
 * @param {string} root
 * @param {{owner?:string, lockRoot?:string, waitMs?:number, pollMs?:number, sleep?:(ms:number)=>Promise<void>,
 *   now?:()=>number, pid?:number, leaseMinutes?:number, probe?:(entry:object|null)=>('dead'|'alive'|'unknown')}} [opts]
 * Reader fairness: before reserving, and on every drain poll, a live starved reader (refused
 * `readerPriorityAfter` times in a row) makes this writer back off — `reader-priority`, writer key released. Only
 * ever during the drain wait, before anything moved; a writer that returned ok is never interrupted.
 * @returns {Promise<{ok:true}|{ok:false, reason:'concurrent-mover'|'tick-in-progress'|'reader-priority', heldBy:string|null, starved?:number}>}
 */
export async function acquireWrite(root, opts = {}) {
  const {
    owner = defaultOwner(opts.pid),
    lockRoot = defaultLockRoot(),
    waitMs = Number(process.env.WE_DAEMON_CLONE_LOCK_WAIT_MS) || 600_000,
    pollMs = 1000,
    sleep = defaultSleep,
    now = () => Date.now(),
    pid = process.pid,
    leaseMinutes = DEFAULT_LEASE_MINUTES,
    probe = defaultProbePidLiveness,
    onBlocked = null,
    readerPriorityAfter = resolveReaderPriorityAfter(),
    writerPriorityAfter = resolveWriterPriorityAfter(),
    writerClaimTtlMs = resolveWriterClaimTtlMs(),
  } = opts;
  const { writerRoot, readersRoot, starvedRoot } = cloneLockDirs(root, lockRoot);

  const startMs = now();
  const startIso = new Date(startMs).toISOString();
  // Writer fairness: our own live, effective claim (we already starved). Older claim wins — we only yield to a
  // starved reader whose starvation began BEFORE our claim (see "writer fairness" above).
  const ownClaim = () => {
    if (!(writerPriorityAfter > 0)) return null;
    const c = readWriterClaim(starvedRoot);
    return c && c.owner === owner && c.count >= writerPriorityAfter
      && writerClaimIsLive(c, now(), writerClaimTtlMs, probe) ? c : null;
  };
  // Reader fairness: a starved reader has priority — never even reserve while one is waiting to get in.
  const priorityFor = (nowMsN) => {
    const r = findPriorityReader(starvedRoot, {
      owner, nowMs: nowMsN, leaseMinutes, probe, after: readerPriorityAfter,
    });
    if (!r) return null;
    const mine = ownClaim();
    return mine && isoMs(mine.since) <= isoMs(r.firstRefusedAt) ? null : r;
  };
  const yieldTo = priorityFor(startMs);
  if (yieldTo) return { ok: false, reason: 'reader-priority', heldBy: yieldTo.owner, starved: yieldTo.count };
  const currentWriter = readLockEntry(writerRoot, WRITER_KEY);
  const writerReserve = reserve(writerRoot, WRITER_KEY, owner, startMs, startIso, pid, probe(currentWriter), leaseMinutes);
  if (!writerReserve.ok) {
    return { ok: false, reason: 'concurrent-mover', heldBy: writerReserve.heldBy };
  }

  const deadline = startMs + waitMs;
  let lastBlockers = [];
  let reportedBlocked = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const nowMsN = now();
    const blockers = [];
    for (const entry of listReaderEntries(readersRoot)) {
      if (entry.owner === owner) continue;
      if (entryIsLive(entry, nowMsN, leaseMinutes, probe)) {
        blockers.push(entry.owner);
      } else {
        releaseLockDir(readersRoot, entry.owner); // dead/expired reader — reclaim its slot now
      }
    }
    lastBlockers = blockers;
    // Still draining — nothing moved yet — so backing off to a starved reader is always safe.
    const starvedReader = priorityFor(nowMsN);
    if (starvedReader) {
      releaseLockDir(writerRoot, WRITER_KEY);
      return { ok: false, reason: 'reader-priority', heldBy: starvedReader.owner, starved: starvedReader.count };
    }
    if (blockers.length === 0) {
      clearWriterClaim(starvedRoot); // the clone is ours to move — any writer claim has done its job
      return { ok: true };
    }
    // #4044: a wait that blocks this process's own ticks is never silent — report it once, with who and how long.
    if (typeof onBlocked === 'function' && !reportedBlocked) {
      reportedBlocked = true;
      try { onBlocked({ blockers, waitMs }); } catch { /* reporting never breaks the lock */ }
    }
    if (nowMsN >= deadline) {
      releaseLockDir(writerRoot, WRITER_KEY);
      // Writer fairness: leave (or bump) a claim so NEW reads yield until a writer gets the clone.
      const claim = writerPriorityAfter > 0
        ? noteWriterGaveUp(starvedRoot, {
          owner, pid, nowMs: nowMsN, heldBy: lastBlockers[0] || null, ttlMs: writerClaimTtlMs, probe,
        })
        : null;
      return {
        ok: false, reason: 'tick-in-progress', heldBy: lastBlockers[0] || null,
        ...(claim && claim.owner === owner ? { writerStarved: claim.count } : {}),
      };
    }
    await sleep(pollMs);
  }
}

/** Release a previously-acquired write slot. Idempotent, and only actually clears the key when `owner`
 *  matches the current holder — releasing a slot you no longer hold (already reclaimed away) is a safe no-op,
 *  never a seize of whatever is there now. */
export function releaseWrite(root, opts = {}) {
  const { owner = defaultOwner(opts.pid), lockRoot = defaultLockRoot() } = opts;
  const { writerRoot } = cloneLockDirs(root, lockRoot);
  const current = readLockEntry(writerRoot, WRITER_KEY);
  if (current && current.owner === owner) {
    releaseLockDir(writerRoot, WRITER_KEY);
  }
  return { ok: true };
}

/**
 * Run `fn` while holding the READ lock on `root`, keeping the heartbeat fresh for as long as `fn` runs
 * (`setInterval` every {@link HEARTBEAT_INTERVAL_MS}, `.unref()`'d so it never keeps the process alive, always
 * cleared in `finally`). Refused ⇒ `fn` is never called. Always releases the slot before returning/throwing.
 * @template T
 * @param {string} root
 * @param {() => (T|Promise<T>)} fn
 * @param {object} [opts]  same shape as {@link acquireRead}
 * @returns {Promise<{ok:true, value:T}|{ok:false, reason:string, heldBy:string}>}
 */
export async function withReadLock(root, fn, opts = {}) {
  const owner = opts.owner || defaultOwner(opts.pid);
  const lockRoot = opts.lockRoot || defaultLockRoot();
  const pid = opts.pid ?? process.pid;
  const acquired = acquireRead(root, { ...opts, owner, lockRoot, pid });
  if (!acquired.ok) return acquired;

  const { readersRoot } = cloneLockDirs(root, lockRoot);
  const timer = setInterval(() => {
    try { heartbeat(readersRoot, owner, owner, new Date().toISOString(), pid); } catch { /* best-effort */ }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    clearInterval(timer);
    releaseRead(root, { owner, lockRoot });
  }
}

/**
 * Run `fn` while holding the WRITE lock on `root` (see {@link acquireWrite} for the wait/timeout semantics).
 * Same heartbeat-while-held / always-release-in-finally shape as {@link withReadLock}.
 * @template T
 * @param {string} root
 * @param {() => (T|Promise<T>)} fn
 * @param {object} [opts]  same shape as {@link acquireWrite}
 * @returns {Promise<{ok:true, value:T}|{ok:false, reason:string, heldBy:string|null}>}
 */
export async function withWriteLock(root, fn, opts = {}) {
  const owner = opts.owner || defaultOwner(opts.pid);
  const lockRoot = opts.lockRoot || defaultLockRoot();
  const pid = opts.pid ?? process.pid;
  const acquired = await acquireWrite(root, { ...opts, owner, lockRoot, pid });
  if (!acquired.ok) return acquired;

  const { writerRoot } = cloneLockDirs(root, lockRoot);
  const timer = setInterval(() => {
    try { heartbeat(writerRoot, WRITER_KEY, owner, new Date().toISOString(), pid); } catch { /* best-effort */ }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    clearInterval(timer);
    releaseWrite(root, { owner, lockRoot });
  }
}

/**
 * Read-only snapshot of `root`'s clone lock — never acquires, releases, or reclaims anything. For the CLI's
 * `status` subcommand and for any caller (e.g. a health check) that wants to know what's held without
 * disturbing it.
 * @param {string} root
 * @param {{lockRoot?:string, nowMs?:number, leaseMinutes?:number,
 *   probe?:(entry:object|null)=>('dead'|'alive'|'unknown')}} [opts]
 * @returns {{writer:object|null, writerLive:boolean, readers:Array<object & {live:boolean}>, starved:Array<object>}}
 */
export function inspectCloneLock(root, opts = {}) {
  const {
    lockRoot = defaultLockRoot(),
    nowMs = Date.now(),
    leaseMinutes = DEFAULT_LEASE_MINUTES,
    probe = defaultProbePidLiveness,
  } = opts;
  const { writerRoot, readersRoot } = cloneLockDirs(root, lockRoot);
  const writer = readLockEntry(writerRoot, WRITER_KEY);
  const writerLive = entryIsLive(writer, nowMs, leaseMinutes, probe);
  const readers = listReaderEntries(readersRoot).map((entry) => ({
    ...entry,
    live: entryIsLive(entry, nowMs, leaseMinutes, probe),
  }));
  const starved = readStarvedRecords(cloneLockDirs(root, lockRoot).starvedRoot).map((rec) => {
    const out = { ...rec };
    delete out.file;
    return out;
  });
  const writerClaim = readWriterClaim(cloneLockDirs(root, lockRoot).starvedRoot);
  return { writer, writerLive, readers, starved, writerClaim };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
// `node scripts/lib/daemon-clone-lock.mjs status --clone=<path> [--json]`
// `node scripts/lib/daemon-clone-lock.mjs hold --clone=<path> [--wait-ms=N] -- <cmd> [args...]`
// The `hold` form is how a person/orchestrator doing a hand operation on a daemon clone serializes with the
// daemons: it takes the WRITE lock, runs the given command with the clone as its cwd (inheriting stdio, so the
// operator sees the command's own output live), releases the lock, and exits with the command's own exit code.

function parseCliArgs(argv) {
  const subcommand = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const rest = subcommand ? argv.slice(1) : argv;
  const dashDash = rest.indexOf('--');
  const flagArgs = dashDash === -1 ? rest : rest.slice(0, dashDash);
  const command = dashDash === -1 ? [] : rest.slice(dashDash + 1);
  const flags = {};
  for (const a of flagArgs) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return { subcommand, flags, command };
}

async function runCli(argv) {
  const { subcommand, flags, command } = parseCliArgs(argv);
  const clone = typeof flags.clone === 'string' ? flags.clone : null;
  if (!clone) {
    process.stderr.write('daemon-clone-lock: --clone=<path> is required\n');
    process.exitCode = 2;
    return;
  }
  const root = resolvePath(clone);

  if (subcommand === 'status') {
    const snapshot = inspectCloneLock(root);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    } else {
      const w = snapshot.writer ? `${snapshot.writer.owner} (${snapshot.writerLive ? 'live' : 'stale'})` : 'none';
      process.stdout.write(`daemon-clone-lock status: ${root}\n  writer: ${w}\n  readers: ${snapshot.readers.length}\n`);
      for (const r of snapshot.readers) {
        process.stdout.write(`    - ${r.owner} (${r.live ? 'live' : 'stale'})\n`);
      }
      if (snapshot.writerClaim) {
        const c = snapshot.writerClaim;
        process.stdout.write(`  writer claim: ${c.owner} gave up ${c.count} time(s) in a row since ${c.since} (last ${c.lastAt}) — new reads yield\n`);
      }
      for (const r of snapshot.starved) {
        process.stdout.write(`  starved reader: ${r.readerKey} (${r.owner}) refused ${r.count} time(s) in a row since ${r.firstRefusedAt}\n`);
      }
    }
    return;
  }

  if (subcommand === 'hold') {
    if (!command.length) {
      process.stderr.write('daemon-clone-lock: hold requires -- <cmd> [args...]\n');
      process.exitCode = 2;
      return;
    }
    const waitMs = flags['wait-ms'] !== undefined ? Number(flags['wait-ms']) : undefined;
    const result = await withWriteLock(root, () => {
      const res = spawnSync(command[0], command.slice(1), { cwd: root, stdio: 'inherit' });
      return res.status ?? (res.signal ? 1 : 0);
    }, waitMs !== undefined ? { waitMs } : {});
    if (!result.ok) {
      process.stderr.write(`daemon-clone-lock: could not take the write lock (${result.reason})\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = result.value;
    return;
  }

  process.stderr.write('daemon-clone-lock: usage: status --clone=<path> [--json] | hold --clone=<path> [--wait-ms=N] -- <cmd> [args...]\n');
  process.exitCode = 2;
}

const IS_CLI = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (IS_CLI) {
  runCli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`daemon-clone-lock: fatal: ${String((e && e.message) || e)}\n`);
    process.exitCode = 1;
  });
}
