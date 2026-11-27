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

/** Parse an entire vm_stat page field; absent optional fields stay absent, malformed ones fail. */
export function parseVmStatPages(text, name) {
  const lines = String(text ?? '').split(/\r?\n/).filter(line => line.startsWith(`Pages ${name}:`));
  if (!lines.length) return undefined;
  if (lines.length !== 1) return NaN;
  const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`).exec(lines[0]);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : NaN;
}

/** Available bytes from `vm_stat` text; null when unparseable. Pure. */
export function parseVmStatAvailableBytes(text) {
  const page = Number(/page size of (\d+) bytes/.exec(String(text ?? ''))?.[1]);
  const counts = ['free', 'inactive', 'speculative', 'purgeable'].map(name => parseVmStatPages(text, name));
  if (!Number.isSafeInteger(page) || page <= 0 || !counts.slice(0, 2).every(Number.isSafeInteger)
    || counts.some(value => value !== undefined && !Number.isSafeInteger(value))) return null;
  const bytes = counts.reduce((sum, value) => sum + (value ?? 0), 0) * page;
  return Number.isSafeInteger(bytes) ? bytes : null;
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
