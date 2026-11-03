#!/usr/bin/env node
/**
 * @file scripts/disk-cleanup.mjs
 * @description R498 — automatic disk cleanup CLI. Thin I/O shell over `scripts/lib/disk-cleanup.mjs`.
 *   node scripts/disk-cleanup.mjs [--dry-run] [--force] [--if-due] [--steps=a,b,c] [--json]
 *     [--keep=N] [--rebuild-max-age-hours=H] [--lane-cap=N] [--min-gb=G] [--jobs-dir=P] [--state-dir=P]
 *   Settings: `diskCleanup` block of the health config.json (defaults in lib), `health.diskFreeMinGb` for the
 *   threshold; flags override. Runs when free space < threshold, or with --force, or --if-due once per
 *   `dailyCadenceHours`. Step (c) removes lanes through `lane-pool.mjs remove` only while still under the threshold.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISK_CLEANUP_DEFAULTS, runDiskCleanup } from './lib/disk-cleanup.mjs';
import { LEASE_FILENAME } from './lib/lane-lease.mjs';
import { DEFAULT_HEALTH_CONFIG } from './conveyor/health-watch-core.mjs';
import { healthDir } from './conveyor/health-watch-section.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseFlags(argv) {
  const f = {};
  for (const a of argv) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) f[m[1]] = m[2] ?? true; }
  return f;
}
function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
const num = (v, d) => (v !== undefined && v !== true && Number.isFinite(Number(v)) ? Number(v) : d);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'], ...opts });
const sizeOf = (p) => { try { return Number(sh('du', ['-sk', p]).split('\t')[0]) * 1024; } catch { return 0; } };
const isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// null = unknown: the library then refuses every delete that depends on it.
const processCommands = () => { try { return sh('ps', ['-axo', 'command=']).split('\n'); } catch { return null; } };
const freeGb = () => { const s = statfsSync(homedir()); return Number(s.bavail) * Number(s.bsize) / 1024 ** 3; };

function liveCwds() { // read fresh for every inspection: a process may enter a lane after an earlier look
  try { return sh('lsof', ['-a', '-d', 'cwd', '-Fn']).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)); } catch { return null; }
}
function git(dir, args) { try { return sh('git', ['-C', dir, ...args]); } catch { return null; }
}
/** Conservative: anything unreadable counts as NOT idle. */
function makeInspect() {
  return (lane) => {
    const cwds = liveCwds();
    const dir = lane.dir;
    // Refresh every remote's tracking refs first so a stale ref can never prove a commit is pushed; a failed fetch = not idle.
    const fetched = git(dir, ['fetch', '--all', '--prune', '--quiet']) !== null;
    const unpushedOut = git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    const porcelain = git(dir, ['status', '--porcelain']);
    const stashOut = git(dir, ['stash', 'list']);
    return {
      lease: existsSync(join(dir, '.git', LEASE_FILENAME)),
      cwdInUse: cwds === null || cwds.some((c) => c === dir || c.startsWith(`${dir}/`)),
      unpushed: !fetched || unpushedOut === null || Number(unpushedOut.trim()) > 0,
      stash: stashOut === null || stashOut.trim() !== '',
      dirty: porcelain === null || porcelain.trim() !== '',
    };
  };
}

function listLanes() {
  let out;
  try { out = JSON.parse(sh('node', [join(HERE, 'lane-pool.mjs'), 'list', '--json'], { timeout: 300_000 })); } catch { return []; }
  return out.map((dir) => ({ dir, n: Number(/lane-(\d+)$/.exec(dir)?.[1]) })).filter((l) => Number.isInteger(l.n));
}
const removeLane = (lane) => sh('node', [join(HERE, 'lane-pool.mjs'), 'remove', `--lane=${lane.n}`], { timeout: 600_000 });

const gib = (b) => (b / 1024 ** 3).toFixed(2);

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const hdir = healthDir(flags['state-root']);
  const cfg = readJson(join(hdir, 'config.json'), {});
  const settings = { ...DISK_CLEANUP_DEFAULTS, ...(cfg.diskCleanup || {}) };
  if (flags.keep !== undefined) settings.keepSnapshots = num(flags.keep, settings.keepSnapshots);
  if (flags['rebuild-max-age-hours'] !== undefined) settings.rebuildMaxAgeHours = num(flags['rebuild-max-age-hours'], settings.rebuildMaxAgeHours);
  if (flags['lane-cap'] !== undefined) settings.laneCap = num(flags['lane-cap'], settings.laneCap);
  const minGb = num(flags['min-gb'], cfg.health?.diskFreeMinGb ?? DEFAULT_HEALTH_CONFIG.health.diskFreeMinGb);
  const dryRun = !!flags['dry-run'];
  const steps = new Set(String(flags.steps || 'a,b,c').split(','));
  if (!settings.enabled && !flags.force) { console.log('disk-cleanup: disabled (diskCleanup.enabled=false)'); return; }

  const statePath = join(hdir, 'disk-cleanup-state.json');
  const last = readJson(statePath, {}).lastRunAt || 0;
  const due = Date.now() - last >= settings.dailyCadenceHours * 3_600_000;
  if (!dryRun && !flags.force && Date.now() - last < 15 * 60_000) { console.log('disk-cleanup: ran under 15 min ago, skipping'); return; }
  const force = !!flags.force || (!!flags['if-due'] && due);

  const jobsDir = flags['jobs-dir'] || join(homedir(), '.claude', 'daemon-jobs');
  const stateDir = flags['state-dir'] || join(homedir(), '.claude', 'daemon-self-sync-state');
  const events = [];
  const log = (e) => { events.push(e); if (!flags.json) console.log(`${e.dryRun ? 'would delete' : 'deleted'} ${e.action} ${e.path} ${gib(e.bytes)} GiB — ${e.reason}`); };
  const wantLanes = steps.has('c');
  const summary = runDiskCleanup({
    freeGb, minGb, settings, dryRun, force, jobsDir, stateDir, processCommands: processCommands(), sizeOf, isPidAlive,
    steps, lanes: wantLanes ? listLanes() : [], inspectLane: wantLanes ? makeInspect() : () => ({}), removeLane, log,
  });
  if (summary.ran && !dryRun) { mkdirSync(hdir, { recursive: true }); writeFileSync(statePath, JSON.stringify({ lastRunAt: Date.now() })); }
  const totalBytes = summary.removed.reduce((n, e) => n + e.bytes, 0);
  if (flags.json) console.log(JSON.stringify({ ...summary, events, totalBytes, dryRun, minGb }, null, 2));
  else console.log(`disk-cleanup: ${summary.ran ? 'ran' : 'skipped (free above threshold, not due)'}${dryRun ? ' [dry-run]' : ''}; free ${summary.beforeGb.toFixed(1)} -> ${summary.afterGb.toFixed(1)} GiB (min ${minGb}); ${summary.removed.length} item(s), ${gib(totalBytes)} GiB ${dryRun ? 'reclaimable' : 'reclaimed'}; ${summary.refused.length} refused`);
}

main();
