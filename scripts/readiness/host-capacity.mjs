/** R258: macOS load averages count IO/lock waiters, so they can throttle an idle host.
 * Measure CPU idle and memory free instead; load is reference only. IO is bounded and injectable.
 * Unknown evidence holds new workers; operators should inspect probes or restore host.capacitySignal=load.
 */
import { renderHostCapacity } from './host-capacity-render.mjs';
export { renderHostCapacity } from './host-capacity-render.mjs';
import { execFileSync } from 'node:child_process';
import * as nodeOs from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedText, hostStateRoot, loadHostOverloadSettings } from '../lib/host-overload-settings.mjs';
import { collectHeavyQueue } from '../operations/heavy-queue-io.mjs';

const percent = n => Number.isFinite(n) && n >= 0 && n <= 100;
const formatPercent = n => percent(n) ? Number(n.toFixed(1)) : 'unknown';
export function parseTop(text) {
  const samples = [...String(text).matchAll(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/g)];
  const values = samples[1]?.slice(1).map(Number);
  return values?.every(percent) && Math.abs(values.reduce((a, b) => a + b, 0) - 100) <= 1 ? values[2] : null;
}
export function parseMemoryPressure(text) {
  const n = Number(/System-wide memory free percentage:\s*([\d.]+)%/.exec(String(text))?.[1]);
  return percent(n) ? n : null;
}
export function parseSwap(text) {
  const m = /used\s*=\s*([\d.]+)([KMGT])\b/.exec(String(text));
  const n = m ? Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024, T: 1048576 })[m[2]] : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function parseCompressor(text) {
  const m = /(?:Pages occupied by compressor|Pages used by compressor):\s*(\d+)/i.exec(String(text));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function capacityBand(idle, free, bands) {
  if (!percent(idle) || !percent(free)) return 'unknown';
  if (idle < bands.cpuIdleLowPct || free < bands.memFreeLowPct) return 'low';
  if (idle < bands.cpuIdleMediumPct || free < bands.memFreeMediumPct) return 'medium';
  return 'high';
}
export function parseForge(text) {
  const f = JSON.parse(text);
  if (!Number.isFinite(f.loadPerCore) || f.loadPerCore < 0 || !percent(f.freeRamPct)
    || !Number.isSafeInteger(f.activeRuns) || f.activeRuns < 0
    || !Number.isSafeInteger(f.maxConcurrent) || f.maxConcurrent < 1) throw Error('unknown forge telemetry');
  return { reachable: true, loadPerCore: f.loadPerCore, freeRamPct: f.freeRamPct,
    activeRuns: f.activeRuns, maxConcurrent: f.maxConcurrent };
}
// Reuse forge-exec-run's protected worker-active semaphore (one worker across all profiles).
// One SSH, no preliminary reachability call. Missing permissions/evidence never imply free capacity.
export const FORGE_PROBE = `sudo -n -u ops python3 -c 'import os,json
from pathlib import Path
m=dict((k,int(v.split()[0])) for k,v in (l.split(":",1) for l in Path("/proc/meminfo").read_text().splitlines()))
p=Path("/srv/forge-receipts")
entries=list(p.iterdir())
print(json.dumps(dict(loadPerCore=os.getloadavg()[0]/os.cpu_count(),freeRamPct=100*m["MemAvailable"]/m["MemTotal"],activeRuns=int(any(e.name=="worker-active" for e in entries)),maxConcurrent=1)))'`;
export function readForge({ exec = execFileSync, clock = Date.now, stateRoot = hostStateRoot(),
  readCache = boundedText, writeCache = (file, value) => { mkdirSync(stateRoot, { recursive: true }); writeFileSync(file, value); } } = {}) {
  const file = join(stateRoot, 'host-capacity-forge.json');
  const now = clock();
  try {
    const cached = JSON.parse(readCache(file));
    if (Number.isFinite(cached.at) && now >= cached.at && now - cached.at < 60000) {
      return cached.forge?.reachable === false ? { reachable: false } : parseForge(JSON.stringify(cached.forge));
    }
  } catch { /* missing, oversized or invalid cache: probe once */ }
  let forge;
  try { forge = parseForge(String(exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'forge', FORGE_PROBE],
    { encoding: 'utf8', timeout: 8000, maxBuffer: 65536 }))); }
  catch { forge = { reachable: false }; }
  try { writeCache(file, JSON.stringify({ at: now, forge })); } catch { /* cache is optional */ }
  return forge;
}
export function collectHostCapacity({ exec = execFileSync, os = nodeOs, clock = Date.now,
  policy, env = process.env, log, queue = collectHeavyQueue, forge = readForge,
  includeQueue = true, includeForge = true, stateRoot } = {}) {
  policy ??= loadHostOverloadSettings({ env, log });
  const probe = (file, args) => { try { return String(exec(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 262144 })); } catch { return ''; } };
  const cores = os.cpus().length;
  const idlePct = os.platform() === 'darwin' ? parseTop(probe('top', ['-l', '2', '-n', '0', '-s', '1'])) : null;
  const freePct = os.platform() === 'darwin' ? parseMemoryPressure(probe('memory_pressure', [])) : null;
  const swapUsedMb = parseSwap(probe('sysctl', ['vm.swapusage']));
  const compressorPages = parseCompressor(probe('vm_stat', []));
  let heavyQueue = null;
  if (includeQueue) { try { const q = queue({ env, now: clock }); heavyQueue = { held: q.heldCount, cap: q.cap, waiting: q.waiting.length }; } catch { /* unknown queue */ } }
  let remote = { reachable: false };
  if (includeForge) { try { remote = forge({ exec, clock, stateRoot }); } catch { /* unknown remote */ } }
  const bands = policy.settings.host.capacity;
  const macBand = capacityBand(idlePct, freePct, bands);
  const unknown = macBand === 'unknown' || !Number.isInteger(cores) || cores < 1 || swapUsedMb === null || compressorPages === null;
  const mac = unknown ? 'low' : macBand;
  const forgeBand = remote.reachable ? (remote.activeRuns >= remote.maxConcurrent || remote.loadPerCore > 0.85 || remote.freeRamPct < bands.memFreeLowPct ? 'low'
    : remote.loadPerCore > 0.7 || remote.freeRamPct < bands.memFreeMediumPct ? 'medium' : 'high') : 'unknown';
  return { observedAt: new Date(clock()).toISOString(),
    mac: { cores, idlePct, busyCores: percent(idlePct) ? cores * (100 - idlePct) / 100 : null,
      loadAverage: os.loadavg(), loadLabel: 'reference only', freePct, swapUsedMb, compressorPages },
    heavyQueue, forge: remote, headroom: { mac, forge: forgeBand }, admitNewWorkers: !unknown && mac !== 'low',
    reason: `CPU idle ${formatPercent(idlePct)}%; memory free ${formatPercent(freePct)}%; ${unknown ? 'unknown mac reading; inspect top/memory_pressure/sysctl/vm_stat or restore host.capacitySignal=load' : `mac headroom ${mac}`}`,
    thresholds: bands, sources: policy.sources };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const r = collectHostCapacity(); process.stdout.write((process.argv.includes('--json') ? JSON.stringify(r) : renderHostCapacity(r)) + '\n'); }
  catch {
    const failure = { admitNewWorkers: false, reason: 'unknown host capacity reading or policy; inspect probes and host-overload settings' };
    process.stdout.write((process.argv.includes('--json') ? JSON.stringify(failure) : `Admit new workers: false; ${failure.reason}`) + '\n');
    process.exitCode = 1;
  }
}
