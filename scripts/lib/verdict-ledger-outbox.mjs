/**
 * @file scripts/lib/verdict-ledger-outbox.mjs
 * @description Layer 3 of the ledger outbox (see verdict-ledger-outbox-spool.mjs): the locked flush — batch
 *   everything queued, push it as ONE plumbing commit, delete only what landed, repeat inside one deadline.
 *   Re-exports the lower layers so callers import one module.
 */
import { join } from 'node:path';
import { assertPushRef } from './git-transport-branch.mjs';
import {
  listOutboxEntries, readEntry, reportIfStale, stillOwn, tryLock, unlock,
} from './verdict-ledger-outbox-spool.mjs';
import { classifyPushFailure, originKeyFor, OutboxFlushError } from './verdict-ledger-git.mjs';
import { common, deadlineBound, pushBatch, reconcilePush } from './verdict-ledger-plumbing.mjs';

export {
  OUTBOX_ENV, OUTBOX_DIR_ENV, FLUSH_BUDGET_ENV, OUTBOX_STALE_ENV, DEFAULT_FLUSH_BUDGET_MS, DEFAULT_OUTBOX_STALE_MS,
  OUTBOX_LOCK_PATH, resolveOutboxSettings, formatOutboxSettings, outboxLockRoot,
  listOutboxEntries, enqueueOutboxEntry,
} from './verdict-ledger-outbox-spool.mjs';
export {
  originKeyFor, ORIGIN_LOOKUP_TIMEOUT_MS, canonicalRemote, outboxDirFor, GIT_CALL_TIMEOUT_MS,
  classifyPushFailure, OutboxFlushError,
} from './verdict-ledger-git.mjs';
export { appendDirect } from './verdict-ledger-plumbing.mjs';

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
  // ONE absolute deadline bounds every git call and every retry (audit round 4): no call starts once it has passed,
  // and none may run past it.
  const hardDeadline = Date.now() + budgetMs;
  const { run, clampedSleep } = deadlineBound(rawRun, sleep, hardDeadline, budgetMs);
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
    const entries = [];
    let ioError = null;
    let blockedAt = null; // the first unreadable entry: nothing that sorts after it may pass it (round 8)
    for (const name of names) {
      const r = readEntry(dir, name, log);
      if (r.io) { ioError = ioError ?? r.io; blockedAt = blockedAt ?? name; continue; }
      if (!r.entry) continue;
      if (originKey && r.entry.originKey && r.entry.originKey !== originKey) {
        if (!skippedForeign.has(name)) log(`verdict-ledger-outbox: entry ${name} is for another remote (${r.entry.originKey}); left for its own flusher`);
        skippedForeign.add(name);
        continue;
      }
      entries.push({ name, entry: r.entry });
    }
    // ROUND 7: rows land in APPEND order, whatever their source. The ledger fold is order-sensitive (a later verdict
    // supersedes an earlier one), so this caller's own in-memory rows must never jump ahead of rows queued before
    // its call. Names start with the append time, so one sort orders disk and memory entries alike.
    entries.push(...memory);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Round 8: an entry we cannot read right now still holds its place in the order. Everything after it waits
    // (memory rows included), so a recovered older verdict can never land after, and supersede, a newer one.
    if (blockedAt) {
      const keep = entries.filter((e) => e.name < blockedAt);
      if (keep.length < entries.length) log(`verdict-ledger-outbox: ${entries.length - keep.length} entr${entries.length - keep.length === 1 ? 'y waits' : 'ies wait'} behind unreadable ${blockedAt} in ${dir}`);
      entries.length = 0;
      entries.push(...keep);
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
        landed = pushBatch({ board, branch, entries, run, allowRef, sleep: clampedSleep });
        break;
      } catch (e) {
        errors.push(e);
        const verdictOf = e?.phase === 'publish' ? classifyPushFailure(e, assertPushRef(branch, allowRef)) : 'pre-push';
        const race = verdictOf === 'race';
        if (e?.budget && e?.phase !== 'publish') {
          throw new OutboxFlushError(`verdict-ledger-outbox: flush budget ${budgetMs}ms spent before the push (${String(e.message).split('\n')[0]})`, { errors, attempts, results, kind: 'budget' });
        }
        if (verdictOf === 'unknown') {
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
        const spent = now() >= deadline || Date.now() >= hardDeadline;
        if (!race || spent) {
          const why = race ? `flush budget ${budgetMs}ms exhausted` : (verdictOf === 'refused' ? 'refused by the remote' : 'non-retryable');
          throw new OutboxFlushError(`verdict-ledger-outbox: flush of ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} failed (${why}): ${String(e?.message ?? e).split('\n')[0]}`,
            { errors, attempts, results, kind: race ? 'budget' : 'flush' });
        }
        if (onRetry) { try { onRetry({ attempt: attempts, error: e }); } catch (cbErr) { log(`verdict-ledger-outbox: onRetry callback failed (ignored): ${cbErr?.message ?? cbErr}`); } }
        log(`verdict-ledger-outbox: push lost a race, refetching (${String(e?.message ?? e).split('\n')[0].slice(0, 300)})`);
        const pause = Math.min(250 * 2 ** (retry - 1), 4000) + Math.floor(random() * 500);
        sleep(Math.max(0, Math.min(pause, hardDeadline - Date.now())));
        if (now() >= deadline || Date.now() >= hardDeadline) {
          throw new OutboxFlushError(`verdict-ledger-outbox: flush budget ${budgetMs}ms exhausted after a lost race`, { errors, attempts, results, kind: 'budget' });
        }
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
    // Round 9: only what was just PUBLISHED leaves memory; a row held back behind an unreadable entry stays in order.
    memory = memory.filter((m) => !entries.some((e) => e.name === m.name));
    if (removeFailed) {
      log(`verdict-ledger-outbox: flushed entries could not be removed from ${dir} (${removeFailed.message}); the next flush replays them as a no-op`);
      stopped = 'remove-failed';
      break;
    }
  }
  return { results, attempts, pushed, stopped };
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
