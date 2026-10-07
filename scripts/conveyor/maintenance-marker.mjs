/**
 * @file scripts/conveyor/maintenance-marker.mjs
 * @description Card 105 — the durable "maintenance is on" marker the `maintenance` operation writes and the two
 *   Claude-dispatching daemons (review, fix/ci-heal) read through `claude-auth-health.mjs#planClaudeAuthDispatchGate`.
 *   One small JSON file beside `fix-dispatch.kill`. Reads FAIL OPEN (missing/corrupt = not in maintenance), the same
 *   discipline as `dispatch-pause.mjs`: a damaged marker must never wedge dispatch shut with no way out.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const maintenanceMarkerPath = (env = process.env) =>
  env.WE_MAINTENANCE_MARKER || join(homedir(), '.claude', 'conveyor', 'maintenance.json');

/** @returns {{startedAt:string, by:string, reason:string}|null} */
export function readMaintenanceMarker({ path = maintenanceMarkerPath() } = {}) {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    return m && typeof m === 'object' && m.active === true ? m : null;
  } catch { return null; }
}

export function writeMaintenanceMarker(marker, { path = maintenanceMarkerPath() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...marker, active: true }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearMaintenanceMarker({ path = maintenanceMarkerPath() } = {}) {
  rmSync(path, { force: true });
}
