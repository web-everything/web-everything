#!/usr/bin/env node
/** Read-only fix-load probe and dry-run report. Never fetches or modifies daemon clones. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';
import { workspaceOf } from '../lib/automation-home.mjs';
import { parseFlags, readFixReadyRecords, resolveFixReadyStore } from '../fix-ready.mjs';
import smell, { appliedFixClones, FIX_NOT_LOADED_BUILT_IN, resolveFixNotLoadedSettings } from './health-smells/fix-not-loaded.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { fmtAge } from './health-watch-core.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (cmd, args, { timeoutMs }) => execFileSync(cmd, args, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
let settings = FIX_NOT_LOADED_BUILT_IN;
try { settings = resolveFixNotLoadedSettings(readSettings()); } catch { /* built-in */ }

export function probeFixReady({ storePath, roots = daemonCloneRoots(workspaceOf(REPO_ROOT)), exec = run, timeoutMs = 5000,
  now = Date.now(), lookbackDays = settings.lookbackDays, budgetMs = settings.probeBudgetMs, nowFn = Date.now,
  rotation } = {}) {
  const deadline = nowFn() + budgetMs;
  const remainingTimeout = () => Math.min(5000, timeoutMs, deadline - nowFn());
  const store = resolveFixReadyStore(storePath);
  const records = readFixReadyRecords(store.path).filter((r) => {
    const ageMs = now - Date.parse(r.at);
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= lookbackDays * 24 * 60 * 60_000;
  });
  if (!records.length) return [];
  // Probe oldest first, rotating each minute so a bounded tick cannot starve later fixes.
  // Keep indices so the returned report retains the store's original record order.
  const order = records.map((_, i) => i).sort((a, b) => Date.parse(records[a].at) - Date.parse(records[b].at));
  // Default start is a hashed minute (Knuth multiplicative), so a fixed tick cadence that is a multiple of the
  // record count cannot keep landing on the same record.
  const start = ((rotation ?? (Math.imul(Math.floor(nowFn() / 60_000), 2654435761) >>> 0)) % order.length + order.length) % order.length;
  const liveHeads = [];
  for (const root of roots) {
    const callTimeoutMs = remainingTimeout();
    if (callTimeoutMs <= 0) break;
    try {
      const result = exec('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: callTimeoutMs });
      if (result?.status !== undefined && result.status !== 0) continue;
      const head = String(result?.stdout ?? result).trim();
      if (/^[a-f0-9]{7,}$/i.test(head)) liveHeads.push(head);
    } catch { /* unavailable live head */ }
  }
  function probeRecord(r) {
    const ancestorOf = [];
    for (const root of roots) {
      const callTimeoutMs = remainingTimeout();
      if (callTimeoutMs <= 0) return { ...r, liveHeads, ancestorOf: null, unknown: true };
      try {
        const result = exec('git', ['-C', root, 'merge-base', '--is-ancestor', r.sha, 'HEAD'], { timeoutMs: callTimeoutMs });
        // execFileSync-style runners throw on failure; also accept status-bearing injected runners.
        if (result?.status === undefined || result.status === 0) {
          ancestorOf.push(root);
          return { ...r, liveHeads, ancestorOf };
        }
      } catch { /* no ancestry evidence */ }
      // An over-budget call cannot establish a fully checked record.
      if (remainingTimeout() <= 0) return { ...r, liveHeads, ancestorOf: null, unknown: true };
    }
    return { ...r, liveHeads, ancestorOf };
  }
  const results = new Array(records.length);
  for (let offset = 0; offset < order.length; offset++) {
    const index = order[(start + offset) % order.length];
    results[index] = probeRecord(records[index]);
  }
  return results;
}

/** Only the rebuild data used by this smell, read as probeSelfSync does. Avoid the health-watch IO graph. */
function readSelfSyncRebuilds(dir) {
  let files;
  try { files = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter((f) => f.endsWith('.rebuild.json')).sort().map((f) => {
    let rebuild = null;
    try { rebuild = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { /* unreadable rebuild */ }
    if (rebuild?.adopted) rebuild.adopted.at = Date.parse(rebuild.adopted.at || '') || null;
    return { cloneKey: f.slice(0, -'.rebuild.json'.length), rebuild };
  });
}

export function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const now = flags.now === undefined ? Date.now() : Date.parse(flags.now);
  if (!Number.isFinite(now)) throw new Error('--now must be an ISO timestamp');
  const store = resolveFixReadyStore(flags.store);
  console.error(`fix-ready-probe: store ${store.path} (source: ${store.source}); dry run`);
  const records = probeFixReady({ storePath: store.path, now });
  const selfSync = readSelfSyncRebuilds(flags['self-sync-dir'] || process.env.HEALTH_WATCH_SELF_SYNC_DIR || join(homedir(), '.claude', 'daemon-self-sync-state'));
  const report = {
    records: records.map((r) => {
      const appliedOn = appliedFixClones(r, selfSync);
      return { ...r, ageMs: now - Date.parse(r.at), loaded: r.ancestorOf?.length || appliedOn.length ? true : r.unknown ? 'unknown' : false, appliedOn };
    }),
    smells: smell.evaluate({ fixReady: records, selfSync }, { now }),
  };
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const r of report.records) console.log(`${r.ref} ${r.sha} age=${fmtAge(r.ageMs)} loaded=${r.loaded === 'unknown' ? 'unknown' : r.loaded ? 'yes' : 'no'}${(r.ancestorOf || []).map((root) => ` ancestor-of ${root}`).join('')}${r.appliedOn.map((key) => ` applied-on ${key}`).join('')}`);
    console.log(JSON.stringify(report.smells, null, 2));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`fix-ready-probe: ${e.message}`); process.exitCode = 1; }
}
