/** @file Durable delivery state outside the checkout; unreadable evidence must never reset deduplication. */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
export { notifyDesktopChecked } from '../conveyor/branch-sync.mjs';

export const DEFAULT_STATE_PATH = process.env.OPERATOR_NOTIFY_STATE || join(homedir(), 'workspace/.operations/operator-notify-state.json');
export function readState(path = DEFAULT_STATE_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { notified: {} }; throw error; }
}
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
function isIncompleteReport(stdout) {
  try { return JSON.parse(stdout)?.incomplete === true; } catch { return false; }
}
export function readQueue({ spawnSyncFn = spawnSync } = {}) {
  const result = spawnSyncFn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'operator-queue.mjs'), '--json'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A partial read (some repo failed) exits 1 but still prints the rows it did read, flagged `incomplete: true`;
  // those rows must still be notified, so only an exit without that flagged JSON is a total failure.
  if (result.error || (result.status !== 0 && !isIncompleteReport(result.stdout))) {
    throw new Error(`operator-queue failed: ${result.error?.message ?? `exit ${result.status}`} ${result.stderr ?? ''}`);
  }
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`operator-queue invalid JSON: ${error.message} ${result.stderr ?? ''}`); }
}
