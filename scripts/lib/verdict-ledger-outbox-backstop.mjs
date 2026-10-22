/**
 * @file scripts/lib/verdict-ledger-outbox-backstop.mjs
 * @description Layer 4 of the ledger outbox (see verdict-ledger-outbox-spool.mjs): the daemon backstop. Every append
 *   already flushes the queue it joins; this pushes what a crashed or failed flusher left behind when no new append
 *   comes. The tick does no git: at most once per interval it starts ONE detached flusher (this file's CLI).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceFor } from './lane-pool-paths.mjs';
import { isUnderTest } from './under-test.mjs';
import { readSettings } from './settings-files.mjs';
import {
  defaultLog, listOutboxEntries, oldestAgeMs, OUTBOX_DIR_ENV,
  resolveOutboxSettings, safeLog, staleLine,
} from './verdict-ledger-outbox-spool.mjs';
import { defaultGit, outboxDirFor } from './verdict-ledger-git.mjs';
import { flushLedgerOutbox } from './verdict-ledger-outbox.mjs';

/**
 * THE DAEMON BACKSTOP for one board: flush its outbox (settings from the cascade). Nothing queued, or another
 * flusher holding the lock, is a quiet no-op. Never throws (see {@link flushLedgerOutbox}).
 */
export function flushBoardLedgerOutbox({ board, env = process.env, log: rawLog = defaultLog, run } = {}) {
  const log = safeLog(rawLog);
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

/**
 * THE DAEMON TICK BACKSTOP (audit round 4: board discovery itself probed git synchronously in the tick). The tick does
 * NO git and NO discovery: at most once per `intervalMs` it starts ONE detached child that resolves the ledger boards
 * and flushes each board's outbox. Overlapping children are harmless (the flusher lock is non-blocking). Never throws.
 */
export const DEFAULT_BACKSTOP_INTERVAL_MS = 5 * 60_000;
let lastBackstopAt = -Infinity;
export function spawnLedgerOutboxBackstop({ repos = [], intervalMs = DEFAULT_BACKSTOP_INTERVAL_MS, now = Date.now, spawnFn, log = defaultLog, env = process.env } = {}) {
  // Never a REAL detached process from a test run (a daemon-tick test would otherwise spawn one per tick).
  if (!spawnFn && isUnderTest(env)) return { ok: true, flushed: 0, skipped: 'under-test' };
  spawnFn = spawnFn ?? spawn;
  const t = now();
  if (t - lastBackstopAt < intervalMs) return { ok: true, flushed: 0, skipped: 'throttled' };
  lastBackstopAt = t;
  try {
    const child = spawnFn(process.execPath, [THIS_FILE, 'flush-repos', `--repos=${repos.join(',')}`], { detached: true, stdio: ['ignore', 'ignore', 'inherit'], env });
    child.on?.('error', (e) => {
      try { log(`ledger-write-miss: verdict-ledger outbox backstop failed to start (${e?.message ?? e}); queued entries wait for the next append or tick`); } catch { /* never throws */ }
    });
    child.unref?.();
    return { ok: true, flushed: 0, spawned: true, pid: child.pid ?? null, repos: repos.length };
  } catch (e) {
    const msg = `ledger-write-miss: verdict-ledger outbox backstop could not start (${String(e?.message ?? e).split('\n')[0]})`;
    try { log(msg); } catch { /* never throws */ }
    return { ok: false, flushed: 0, error: msg };
  }
}
/** The outbox root the backstop always scans for THIS checkout (its workspace's shared `.operations`). */
export function defaultOutboxRoot(moduleFile = THIS_FILE) {
  return join(workspaceFor(resolve(dirname(moduleFile), '..', '..')), '.operations', 'verdict-ledger-outbox');
}
/** Test seam: forget the throttle. */
export function resetLedgerOutboxBackstopThrottle() { lastBackstopAt = -Infinity; }

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
export function spawnBoardLedgerOutboxFlush({ board, env = process.env, log: rawLog = defaultLog, spawnFn = spawn } = {}) {
  const log = safeLog(rawLog);
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

const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * The detached backstop flusher. Always exits 0.
 *   `node verdict-ledger-outbox.mjs flush --board=<checkout>`
 *   `node verdict-ledger-outbox.mjs flush-repos --repos=<owner/name,…>` (resolves each repo's ledger board first)
 */
async function runBackstopCli(argv) {
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(k.length + 3);
  let boards = [];
  try {
    if (argv[2] === 'flush') boards = [arg('board')].filter(Boolean);
    else {
      const { resolveLedgerBoard } = await import('./verdict-ledger.mjs');
      boards = [...new Set(arg('repos').split(',').filter(Boolean).map((r) => { try { return resolveLedgerBoard(r); } catch { return null; } }).filter(Boolean))];
    }
  } catch (e) { defaultLog(`ledger-write-miss: verdict-ledger outbox backstop could not resolve its boards (${e?.message ?? e})`); }
  const visited = new Set();
  // Roots known independently of board resolution: this checkout's workspace and the env override's parent.
  const roots = new Set([defaultOutboxRoot()]);
  if (process.env[OUTBOX_DIR_ENV]) roots.add(dirname(resolve(process.env[OUTBOX_DIR_ENV])));
  if (!boards.length) defaultLog(`verdict-ledger-outbox: backstop resolved NO ledger board${argv[2] === 'flush-repos' ? ` for ${arg('repos') || '(no repos)'}` : ''}; reporting queued outboxes only`);
  for (const board of boards) {
    const r = flushBoardLedgerOutbox({ board });
    if (r.dir) { visited.add(resolve(r.dir)); roots.add(dirname(resolve(r.dir))); }
    if (r.flushed || r.ok === false) defaultLog(`verdict-ledger-outbox: backstop flush ${JSON.stringify(r)}`);
  }
  // Round 5: a queue NO resolved board maps to is never silently skipped — it is reported, loudly once stale.
  for (const root of roots) {
    let subdirs = [];
    try { subdirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)); } catch { continue; }
    for (const d of subdirs) {
      if (visited.has(resolve(d))) continue;
      const age = oldestAgeMs(d, Date.now());
      if (!age.count) continue;
      const settings = resolveOutboxSettings({ repo: readSettings(), env: process.env });
      defaultLog(age.ageMs > settings.staleMs
        ? staleLine(d, age, 'no local board for this remote; nothing on this host can flush it')
        : `verdict-ledger-outbox: ${d} holds ${age.count} entr${age.count === 1 ? 'y' : 'ies'} for a remote no resolved board matches`);
    }
  }
}
// No top-level await: this module is imported by the io-shell, and must stay a plain synchronous module.
if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE && ['flush', 'flush-repos'].includes(process.argv[2])) {
  runBackstopCli(process.argv).catch((e) => defaultLog(`ledger-write-miss: verdict-ledger outbox backstop crashed (${e?.message ?? e})`));
}
