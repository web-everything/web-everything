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
  const out = { root: null, entries: [], mainOnly: false };
  for (const a of argv) {
    if (a.startsWith('--root=')) out.root = a.slice('--root='.length);
    else if (a.startsWith('--entry=')) out.entries.push(a.slice('--entry='.length));
    else if (a === '--main-only') out.mainOnly = true;
  }
  return out;
}

async function main() {
  try {
    const { installDaemonLog } = await import('../../skills-src/conveyor/daemon-log.mjs');
    installDaemonLog({ logPath: null, timers: false }); // stamp lines; the daemon owns rotation of the shared log
  } catch { /* unstamped lines are still lines */ }
  const { root, entries, mainOnly } = parseBuilderArgs(process.argv.slice(2));
  if (!root) { console.error('daemon-rebuild-builder: --root=<clone> is required'); process.exit(2); }
  const startedMs = Date.now();
  const prev = readBuilderState(root) || {};
  const base = { ...prev, pid: process.pid, host: hostname(), startedAt: prev.pid === process.pid && prev.startedAt ? prev.startedAt : new Date(startedMs).toISOString(), finishedAt: null, result: null };
  try { writeBuilderState(root, base); } catch { /* the spawner already wrote a record */ }
  console.error(`daemon-rebuild-builder: building the next version of ${root} off the tick path (pid ${process.pid}) (x44lnnt)`);
  let result;
  // A re-clone replaces the checkout with plain origin/main (never smoked): flag it so the daemon runs no children
  // on it, and rebuild once more right away (the inline path's "the next tick rebuilds from the fresh clone").
  let recloned = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = summarizeRebuildResult(await rebuildClone({ root, entries: entries.length ? entries : undefined, mainOnly }));
    } catch (e) {
      result = { moved: false, adopted: false, reason: `threw: ${String((e && e.message) || e).split('\n')[0]}` };
    }
    if (result.reason !== 'clone-recloned') break;
    recloned = true;
    try { writeBuilderState(root, { ...base, recloned }); } catch { /* best-effort */ }
  }
  // The rebuild ON the fresh clone has finished (whatever its verdict) — exactly when the inline path ticked again.
  recloned = result.reason === 'clone-recloned';
  const finishedMs = Date.now();
  try { writeBuilderState(root, { ...base, recloned, finishedAt: new Date(finishedMs).toISOString(), ms: finishedMs - startedMs, result }); } catch { /* best-effort */ }
  console.error(`daemon-rebuild-builder: done in ${Math.round((finishedMs - startedMs) / 1000)}s — ${result.moved && result.adopted ? `adopted ${result.head}; the daemon swaps onto it between ticks` : `not adopted (${result.reason})`} (x44lnnt)`);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main().then(() => process.exit(0), (e) => { console.error(`daemon-rebuild-builder: fatal: ${String((e && e.message) || e)}`); process.exit(1); });
