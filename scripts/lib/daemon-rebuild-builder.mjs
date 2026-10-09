#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-rebuild-builder.mjs
 * @description x44lnnt — the detached BUILDER process (ruled event-daemon design E5: "a separate builder process").
 *   Runs ONE gated `rebuildClone` for a daemon clone — the exact same lease, unlocked candidate smoke, locked
 *   finalize and guards the daemon used to run inline at the start of every tick — then records the outcome in
 *   `<stateDir>/<cloneKey>.builder.json` and exits. The daemon keeps ticking meanwhile and swaps onto the adopted
 *   build only between ticks (see `daemon-background-build.mjs`). Started by `withSelfSync`, never by hand.
 *
 *   node scripts/lib/daemon-rebuild-builder.mjs --root=<clone> [--entry=<daemon script>]... [--main-only]
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { rebuildClone } from './daemon-rebuild.mjs';
import { readBuilderState, writeBuilderState } from './daemon-background-build.mjs';

/** PURE: the small, log-safe summary of a `rebuildClone` result kept in the builder state. */
export function summarizeRebuildResult(r) {
  if (!r || typeof r !== 'object') return { moved: false, adopted: false, reason: 'no-result' };
  return {
    moved: !!r.moved, adopted: !!r.adopted, reason: r.reason ?? (r.moved && r.adopted ? 'adopted' : null),
    head: r.head ?? r.headSha ?? null,
  };
}

export function parseBuilderArgs(argv) {
  const out = { root: null, entries: [], mainOnly: false, maxAgeMs: 0 };
  for (const a of argv) {
    if (a.startsWith('--root=')) out.root = a.slice('--root='.length);
    else if (a.startsWith('--entry=')) out.entries.push(a.slice('--entry='.length));
    else if (a === '--main-only') out.mainOnly = true;
    // Clamped to the largest delay `setTimeout` honours: above 2^31-1 ms Node fires it after ~1 ms, which would make
    // every builder record `builder-deadline` and exit at once.
    else if (a.startsWith('--max-age-ms=')) { const n = Number(a.slice('--max-age-ms='.length)); if (Number.isSafeInteger(n) && n > 0) out.maxAgeMs = Math.min(n, MAX_TIMER_MS); }
  }
  return out;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The record the deadline timer writes. It must keep the fail-closed `recloned` marker the run has set so far
 * (`recloned` is the live local, `base.recloned` the one carried in): the deadline can fire after the re-clone and
 * before the final write, and a record that dropped the flag would let a restarted daemon run children on the
 * never-smoked re-cloned checkout.
 */
export function deadlineRecord(base, { recloned = false, nowMs = Date.now() } = {}) {
  return { ...base, recloned: !!(recloned || base.recloned), finishedAt: new Date(nowMs).toISOString(), result: { moved: false, adopted: false, reason: 'builder-deadline' } };
}

/**
 * Write the builder record ONLY while it is still ours (its pid is this process's). Once the daemon stops trusting an
 * old record (the max-age bound) it may spawn a successor that owns the record; a late finish from the old builder
 * must not mark the successor's record finished (last write wins would let a third builder start under a live one).
 * @returns {boolean} whether the write happened
 */
export function writeBuilderStateIfOwner(root, state, { pid = process.pid, read = readBuilderState, write = writeBuilderState } = {}) {
  const cur = read(root);
  if (cur && cur.pid != null && cur.pid !== pid) return false;
  write(root, state);
  return true;
}

async function main() {
  try {
    const { installDaemonLog } = await import('../../skills-src/conveyor/daemon-log.mjs');
    installDaemonLog({ logPath: null, timers: false }); // stamp lines; the daemon owns rotation of the shared log
  } catch { /* unstamped lines are still lines */ }
  const { root, entries, mainOnly, maxAgeMs } = parseBuilderArgs(process.argv.slice(2));
  if (!root) { console.error('daemon-rebuild-builder: --root=<clone> is required'); process.exit(2); }
  const startedMs = Date.now();
  const prev = readBuilderState(root) || {};
  const base = { ...prev, pid: process.pid, host: hostname(), startedAt: prev.pid === process.pid && prev.startedAt ? prev.startedAt : new Date(startedMs).toISOString(), finishedAt: null, result: null };
  try { writeBuilderState(root, base); } catch { /* the spawner already wrote a record */ }
  // Deadline = the age after which the daemon stops trusting this record. Past it a successor may own the record, so
  // this process must not keep running (and writing) behind its back: record the timeout (if still ours) and exit.
  let recloned = false; // set below the moment a re-clone happens; the deadline record reads it live
  if (maxAgeMs > 0) {
    setTimeout(() => {
      try { writeBuilderStateIfOwner(root, deadlineRecord(base, { recloned })); } catch { /* best-effort */ }
      console.error(`daemon-rebuild-builder: exceeded its ${Math.round(maxAgeMs / 60_000)} min deadline — exiting (x44lnnt)`);
      process.exit(1);
    }, maxAgeMs).unref();
  }
  console.error(`daemon-rebuild-builder: building the next version of ${root} off the tick path (pid ${process.pid}) (x44lnnt)`);
  let result;
  // A re-clone replaces the checkout with plain origin/main (never smoked): flag it so the daemon runs no children
  // on it, and rebuild once more right away (the inline path's "the next tick rebuilds from the fresh clone").
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = summarizeRebuildResult(await rebuildClone({ root, entries: entries.length ? entries : undefined, mainOnly }));
    } catch (e) {
      result = { moved: false, adopted: false, reason: `threw: ${String((e && e.message) || e).split('\n')[0]}` };
    }
    if (result.reason !== 'clone-recloned') break;
    recloned = true;
    try { writeBuilderStateIfOwner(root, { ...base, recloned }); } catch { /* best-effort */ }
  }
  // The rebuild ON the fresh clone has finished (whatever its verdict) — exactly when the inline path ticked again.
  recloned = result.reason === 'clone-recloned';
  const finishedMs = Date.now();
  try { writeBuilderStateIfOwner(root, { ...base, recloned, finishedAt: new Date(finishedMs).toISOString(), ms: finishedMs - startedMs, result }); } catch { /* best-effort */ }
  console.error(`daemon-rebuild-builder: done in ${Math.round((finishedMs - startedMs) / 1000)}s — ${result.moved && result.adopted ? `adopted ${result.head}; the daemon swaps onto it between ticks` : `not adopted (${result.reason})`} (x44lnnt)`);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main().then(() => process.exit(0), (e) => { console.error(`daemon-rebuild-builder: fatal: ${String((e && e.message) || e)}`); process.exit(1); });
