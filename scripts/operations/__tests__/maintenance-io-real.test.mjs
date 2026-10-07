/**
 * @file scripts/operations/__tests__/maintenance-io-real.test.mjs
 * @description Fidelity qualifier (#2949) for `maintenance-io.mjs`: the pause file, kill file and marker are REAL
 *   files on disk (env-redirected into a temp dir), and the login test is a REAL subprocess (an executable
 *   stand-in for `claude`). Never touches the live daemons' files.
 */
import { it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createMaintenanceIo, createMaintenanceSinks, runTestSession } from '../maintenance-io.mjs';
import { runMaintenance } from '../maintenance.mjs';
import { readMaintenanceMarker } from '../../conveyor/maintenance-marker.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';

const KEYS = ['WE_DISPATCH_PAUSE_FILE', 'WE_FIX_DISPATCH_KILL_FILE', 'WE_MAINTENANCE_MARKER'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function fakeClaude(tmp, body, name) {
  const bin = join(tmp, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return (_cmd, args, opts) => execFileSync(bin, args, opts);
}

it('start then end against real files: pauses, then lifts only after a passing real login test', async () => {
  await withRealRepo(({ tmp }) => {
    process.env.WE_DISPATCH_PAUSE_FILE = join(tmp, 'pause.json');
    process.env.WE_FIX_DISPATCH_KILL_FILE = join(tmp, 'fix.kill');
    process.env.WE_MAINTENANCE_MARKER = join(tmp, 'maint.json');
    const ok = fakeClaude(tmp, 'echo OK', 'claude-ok');
    const io = { ...createMaintenanceIo(), listSessions: () => [], testSession: () => runTestSession({ exec: ok }) };
    runMaintenance({ action: 'start', reason: 'swap', by: 't' }, io);
    expect(existsSync(process.env.WE_FIX_DISPATCH_KILL_FILE)).toBe(true);
    expect(io.readPause().paused).toBe(true);
    expect(readMaintenanceMarker().reason).toBe('swap');

    const bad = fakeClaude(tmp, 'echo "Login expired" >&2; exit 1', 'claude-bad');
    const failing = { ...io, testSession: () => runTestSession({ exec: bad }) };
    expect(() => runMaintenance({ action: 'end' }, failing)).toThrow(/login test FAILED.*Login expired/s);
    expect(io.readPause().paused).toBe(true);
    expect(existsSync(process.env.WE_FIX_DISPATCH_KILL_FILE)).toBe(true);

    runMaintenance({ action: 'end' }, io);
    expect(io.readPause().paused).toBe(false);
    expect(existsSync(process.env.WE_FIX_DISPATCH_KILL_FILE)).toBe(false);
    expect(readMaintenanceMarker()).toBeNull();
  });
});

it('the effect sink is bound to runMaintenance', () => {
  expect(typeof createMaintenanceSinks().maintenance).toBe('function');
});
