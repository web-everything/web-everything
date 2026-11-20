/**
 * @file scripts/lib/memory-available.mjs
 * One shared memory-free measurement. `os.freemem()` on macOS counts only never-used pages (live 2026-11-04: 6.9%
 * while `memory_pressure` said 73%), so a gate using it throttles on a false signal. `available` = free + inactive +
 * purgeable + speculative pages over total RAM; `free` keeps the old os.freemem reading. Setting:
 * host.capacity.memoryMetric ("available" | "free"). Pure parser first, injectable IO after.
 */
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

export const MEMORY_METRICS = ['available', 'free'];
export const DEFAULT_MEMORY_METRIC = 'available';

/** Available bytes from `vm_stat` text; null when unparseable. Pure. */
export function parseVmStatAvailableBytes(text) {
  const t = String(text ?? '');
  const page = Number(/page size of (\d+) bytes/.exec(t)?.[1]);
  const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(t)?.[1] ?? NaN);
  const free = pages('free'); const inactive = pages('inactive'); const spec = pages('speculative');
  const purge = pages('purgeable');
  if (![page, free, inactive].every(Number.isFinite) || page <= 0) return null;
  return (free + inactive + (Number.isFinite(spec) ? spec : 0) + (Number.isFinite(purge) ? purge : 0)) * page;
}

/** Memory-available bytes under `metric`. Throws on unreadable evidence. */
export function memoryAvailableBytes({ metric = DEFAULT_MEMORY_METRIC, exec = execFileSync, platform = process.platform,
  freemem = os.freemem, strict = false } = {}) {
  let bytes = null;
  if (metric === 'available' && platform === 'darwin') {
    // A failed or unparseable vm_stat degrades to the stricter os.freemem reading, never to "unknown".
    try { bytes = parseVmStatAvailableBytes(exec('vm_stat', [], { encoding: 'utf8', timeout: 5000 })); } catch { bytes = null; }
    // strict (the hard floor): an unreadable vm_stat is unreadable evidence, never a quiet substitute reading.
    if (strict && bytes === null) throw Error('vm_stat unreadable');
  }
  if (bytes === null) bytes = freemem(); // 'free', or no vm_stat (non-darwin: freemem is MemAvailable on Linux)
  if (!Number.isFinite(bytes) || bytes < 0) throw Error('invalid memory totals');
  return bytes;
}

/** Memory-free percent (0-100) under `metric`. Throws on unreadable evidence. */
export function memoryFreePct({ metric = DEFAULT_MEMORY_METRIC, exec = execFileSync, platform = process.platform,
  freemem = os.freemem, totalmem = os.totalmem } = {}) {
  return Math.round(memoryFreePctUnrounded({ metric, exec, platform, freemem, totalmem }) * 10) / 10;
}

/** Unrounded bytes ratio for admission comparisons; display rounding must not admit below a threshold. */
export function memoryFreePctUnrounded({ totalmem = os.totalmem, ...options } = {}) {
  const total = totalmem();
  if (!Number.isFinite(total) || total <= 0) throw Error('invalid memory totals');
  const bytes = memoryAvailableBytes(options);
  return Math.min(100, bytes / total * 100);
}

/** Available memory in whole MB (rounded down). Throws on unreadable evidence. */
export function memoryAvailableMb(opts = {}) { return Math.floor(memoryAvailableBytes({ strict: true, ...opts }) / (1024 * 1024)); }

export const DEFAULT_MEM_AVAILABLE_FLOOR_MB = 2048;

// Preserve the measurement module's existing exports for callers.
export { decideMemoryPressure, decideMemoryFloor, DEFAULT_WARN_MIN_FREE_PCT, DEFAULT_WARN_SWAP_GROWTH_MB }
  from './memory-warn-corroboration.mjs';
