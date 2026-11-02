/**
 * @file scripts/lib/atomic-json-file.mjs
 * @description Small, generic write-temp-then-rename-then-validate helper for a JSON file multiple processes may
 *   read concurrently (e.g. `~/.claude.json`, the CLI's own per-directory trust registry) — a bare
 *   `writeFileSync` on the real path lets a concurrent reader observe a half-written file if it races the
 *   write; a `rename` on the SAME filesystem is atomic, so a reader only ever sees the old file or the new one,
 *   never a partial one. Built for card #4188 (bornAs `x5qketq`, epic #4075): the session reaper's
 *   dispatch-scratch trust revoke needed exactly this guarantee for a file that already holds every OTHER
 *   repo's per-project CLI state too, so corrupting it on a bad write is a much bigger blast radius than losing
 *   one script's own sidecar record.
 *
 * VALIDATES TWICE: once against the in-memory string before ever touching disk (a caller that handed this a
 * value `JSON.stringify` cannot render faithfully — a BigInt, a cyclic object — fails LOUD, before any write),
 * and once against the bytes actually read back off the temp file after `writeFileSync` returns (catches a
 * filesystem-level truncation the in-memory check can never see). Only then does the rename happen, so a
 * validation failure never leaves a corrupt temp file where a caller might mistake it for the real target, and
 * the real target path is never touched by a write that didn't fully verify first.
 *
 * NEVER SWALLOWS AN ERROR ITSELF — every failure here throws. A caller that wants this repo's usual
 * "best-effort, never blocks the caller" discipline (e.g. `grantDispatchTrust`'s own convention) wraps the call
 * in its own try/catch, exactly as that function already does for its writer.
 *
 * LOCK-SAFE, VIA {@link withFileLock} — LIVE-CAUGHT (2026-09-26): atomicity alone (temp+rename) prevents a
 * concurrent READER from ever seeing a torn file, but it does NOT prevent a LOST UPDATE between two concurrent
 * WRITERS each doing "read whole file, modify, write whole file" with no mutual exclusion. Proved live on this
 * exact machine: a real dispatch-scratch revoke pass reported 81 trust entries removed, but a re-read of
 * `~/.claude.json` moments later still carried every one of them — a concurrent `grantDispatchTrust` call (the
 * live daemon dispatching new sessions throughout the same window) had read its OWN stale pre-revoke snapshot
 * and written it straight back, silently reverting the revoke. {@link withFileLock} closes that gap for any
 * caller that wraps its read-modify-write in it.
 */
import fs, {
  writeFileSync, renameSync, readFileSync, unlinkSync, writeSync, closeSync, statSync, realpathSync,
  existsSync,
} from 'node:fs';
import { sleepSyncMs } from '../readiness/drain-lock.mjs';

/**
 * Write `data` to `path` as pretty JSON, atomically (temp file + rename), validating the JSON both before and
 * after the write.
 *
 * RESOLVES A SYMLINKED TARGET FIRST (PR #2735 red-team finding 3, epic #4075): `renameSync(tmp, path)` onto a
 * path that is itself a symlink does not "write through" it — it unlinks the symlink and puts a plain file at
 * that path instead, silently severing the link (e.g. an operator's `~/.claude.json` symlinked elsewhere by a
 * dotfile manager would stop being a symlink at all after the very first atomic write). `realpathSyncFn`
 * resolves `path` to its real target before the temp file is even named, so both the temp file and the final
 * rename land on the SAME real file the symlink already pointed at — the symlink itself is never touched. A
 * `path` that does not exist yet, or that `realpathSyncFn` otherwise cannot resolve, falls back to writing
 * `path` directly (unchanged pre-existing behavior for the common "new file" case).
 *
 * NEVER LEAVES A `.tmp` FILE BEHIND ON A RENAME FAILURE (PR #2735 finding 4): a `renameSync` failure (EXDEV
 * across filesystems, ENOSPC, a permission error) used to leave the temp file on disk forever, next to the
 * real target, once the caller's own error handling moved on. The rename is now itself wrapped exactly like the
 * post-write validation above it — clean up the temp file, then re-throw the ORIGINAL error, never swallow it.
 * @param {string} path
 * @param {unknown} data
 * @param {{
 *   writeFileSyncFn?: Function, renameSyncFn?: Function, readFileSyncFn?: Function, unlinkSyncFn?: Function,
 *   realpathSyncFn?: Function, mode?: number,
 * }} [io] - injectable fs calls, same DI seam this repo's other IO-shell functions already use; only ever
 *   exercised by tests. Optional mode sets temporary-file creation permissions (preserved by rename);
 *   omitted mode retains the default write behavior and process umask.
 */
export function writeJsonAtomic(path, data, {
  writeFileSyncFn = writeFileSync,
  renameSyncFn = renameSync,
  readFileSyncFn = readFileSync,
  unlinkSyncFn = unlinkSync,
  realpathSyncFn = realpathSync,
  mode,
} = {}) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  JSON.parse(text); // validate the in-memory render before any disk write — throws loud on unserializable input
  let realPath = path;
  try { realPath = realpathSyncFn(path); } catch { /* doesn't exist yet, or unresolvable — write `path` directly */ }
  const tmp = `${realPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSyncFn(tmp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  try {
    JSON.parse(readFileSyncFn(tmp, 'utf8')); // validate the BYTES ON DISK, not just the string still in memory
  } catch (e) {
    try { unlinkSyncFn(tmp); } catch { /* best-effort cleanup of the now-useless temp file */ }
    throw e;
  }
  try {
    renameSyncFn(tmp, realPath); // same-filesystem rename — atomic; a concurrent reader never sees a partial file
  } catch (e) {
    try { unlinkSyncFn(tmp); } catch { /* best-effort — the original rename failure is what the caller needs to see */ }
    throw e;
  }
}

/** How long {@link withFileLock} waits for a contended lock before giving up — generous for a `~/.claude.json`
 *  read-modify-write (a handful of small sync fs calls), never meant to cover a genuinely hung holder. */
const LOCK_TIMEOUT_MS_DEFAULT = 5_000;

/** Backoff between acquire attempts — short, since the critical section this guards is itself short. */
const LOCK_POLL_MS_DEFAULT = 25;

/** A lock file older than this is assumed ABANDONED (its holder crashed or was killed mid-section) and is
 *  stolen rather than honored forever — the same "never let one dead holder wedge every future writer"
 *  discipline this repo's own lease locks (`we:scripts/readiness/file-locks.mjs`) apply, scaled down for a
 *  section this short. */
const LOCK_STALE_MS_DEFAULT = 30_000;

/** Same-host pid-liveness probe for a lock's recorded holder (PR #2735 red-team finding 2) — mirrors
 *  `we:scripts/readiness/drain-lock.mjs#probeNumberingHolderLiveness`'s own `process.kill(pid, 0)` convention:
 *  `'dead'` ONLY on a proven `ESRCH` (no such process on this host); `'alive'`/`'unknown'` otherwise. A
 *  stale-BY-AGE lock whose recorded holder is still genuinely running (a slow critical section, never a crash)
 *  must not be stolen just because it outlived `staleMs`. No pid recorded at all (an older/foreign lock shape,
 *  or unreadable content) answers `'unknown'` — falls back to the age-only heuristic this repo shipped before
 *  this fix, never worse than that.
 * @param {string} lockPath
 * @param {Function} readFileSyncFn
 * @returns {'dead'|'alive'|'unknown'}
 */
function probeLockHolderLiveness(lockPath, readFileSyncFn) {
  let pid;
  try { pid = parseInt(String(readFileSyncFn(lockPath, 'utf8')).trim(), 10); } catch { return 'unknown'; }
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (pid === process.pid) return 'alive'; // can't be our own dead holder
  try { process.kill(pid, 0); return 'alive'; }
  catch (e) { return e && e.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

/**
 * Run `fn` while holding an exclusive, cross-process lock on `lockPath` (a sibling `<path>.lock` file, by
 * convention) — the mutual-exclusion half {@link writeJsonAtomic}'s atomicity does NOT provide (see this file's
 * own header for the live incident that proved the gap). Acquisition is `open(path, 'wx')` — the one atomic
 * "create-if-absent" primitive `node:fs` offers — so two concurrent callers can never both believe they hold
 * it. A caller that cannot acquire within `timeoutMs` gets a loud throw, never a silent skip of the critical
 * section it asked to protect.
 *
 * STALE-LOCK TAKEOVER: a lock file older than `staleMs`, whose recorded holder pid is not provably alive
 * ({@link probeLockHolderLiveness}), is assumed abandoned and is reclaimed before retrying — without this, one
 * process crashing mid-section (between acquire and release) would wedge every future writer forever.
 *
 * THE TAKEOVER ITSELF IS RENAME-BASED, NEVER A PLAIN `unlinkSync` (PR #2735 red-team finding 2, epic #4075/
 * #4188): a same-filesystem `renameSync` on a single source path is atomic at the OS level — of any two
 * concurrent callers racing to move the SAME still-stale file, at most one call ever succeeds; the other gets
 * `ENOENT` (the source is already gone) rather than "succeeding" a second time against a file the first caller
 * already replaced. AND VERIFIED AFTER THE MOVE, never trusted from the earlier read alone: a caller can be
 * descheduled (real risk under heavy CPU load, this machine's own measured condition) between deciding "stale"
 * and acting on it, long enough for a DIFFERENT sibling to have already fully stolen the SAME original file and
 * re-acquired a fresh, genuinely live one of its own at the identical path — a plain rename would happily move
 * that fresh file away too, since rename never checks what it is moving. So the moved-aside file's OWN mtime
 * and recorded pid are re-checked immediately after the rename; if it turns out not to have actually been
 * stale/dead after all, it is put straight back and this caller backs off to retry normally, never proceeding
 * into `fn()` on a bad steal.
 * `holderText` and `probeHolderLiveness` opt a caller into richer process identity. The probe runs
 * both before and after takeover; it must preserve live or unreadable identities as 'alive'.
 * @param {string} lockPath
 * @param {() => any} fn
 * @param {{timeoutMs?: number, pollMs?: number, staleMs?: number, onBeforeStaleTakeover?: (() => void)|null,
 *   holderText?: string, probeHolderLiveness?: Function}} [o]
 * @returns {any} whatever `fn` returns
 */
export function withFileLock(lockPath, fn, {
  timeoutMs = LOCK_TIMEOUT_MS_DEFAULT, pollMs = LOCK_POLL_MS_DEFAULT, staleMs = LOCK_STALE_MS_DEFAULT,
  onBeforeStaleTakeover = null,
  holderText = `${process.pid}\n`, probeHolderLiveness = probeLockHolderLiveness,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // Resolve through the shared fs object so runtime instrumentation sees acquisition.
      const fd = fs.openSync(lockPath, 'wx');
      try { writeSync(fd, holderText); } finally { closeSync(fd); }
      break; // acquired
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // any other failure (no permission, bad path) — never silently proceed unlocked
      let claimed = false;
      try {
        const isStale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
        const holderLiveness = isStale ? probeHolderLiveness(lockPath, readFileSync) : 'alive';
        if (isStale && holderLiveness !== 'alive') {
          // TEST-ONLY SYNCHRONIZATION SEAM (never used by a real caller): lets a test simulate the exact
          // decide-then-act gap PR #2735 finding 2 needs to reproduce. A no-op by default.
          if (typeof onBeforeStaleTakeover === 'function') { try { onBeforeStaleTakeover(); } catch { /* never let a test hook break a real caller */ } }
          const stolenPath = `${lockPath}.stolen.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
          try {
            renameSync(lockPath, stolenPath); // atomic claim — at most one concurrent racer's rename ever succeeds
          } catch (renameErr) {
            if (renameErr?.code !== 'ENOENT') throw renameErr; // someone else already claimed it an instant ago — fall through, retry acquire
          }
          if (existsSync(stolenPath)) {
            // POST-MOVE VERIFICATION: re-check what we ACTUALLY moved, never the earlier (possibly now-stale)
            // decision — closes the gap a plain rename does not (see this function's own doc).
            let genuinelyStale = false;
            try {
              genuinelyStale = Date.now() - statSync(stolenPath).mtimeMs > staleMs
                && probeHolderLiveness(stolenPath, readFileSync) !== 'alive';
            } catch { genuinelyStale = false; }
            if (genuinelyStale) {
              try { unlinkSync(stolenPath); } catch { /* best-effort cleanup of the now-confirmed-dead lock's own file */ }
              claimed = true;
            } else {
              // Not our steal to make — a sibling's genuinely live lock landed at this path in the gap. Put it
              // straight back and back off to retry normally, never proceeding on a bad steal.
              try { renameSync(stolenPath, lockPath); } catch { /* best-effort restore — see doc for the safety
                argument if this itself fails: the path is left momentarily unlocked, never worse than pre-fix */ }
            }
          }
        }
      } catch { /* lock vanished between our stat and our takeover attempt, or between EEXIST and our stat — just retry acquire */ }
      if (claimed) continue; // genuinely reclaimed a dead holder's lock — retry openSync immediately
      if (Date.now() >= deadline) throw new Error(`withFileLock: timed out waiting for ${lockPath} (held by another process)`);
      sleepSyncMs(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* best-effort release — a takeover after a crash still self-heals */ }
  }
}
