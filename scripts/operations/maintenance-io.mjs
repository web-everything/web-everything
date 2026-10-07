/**
 * @file scripts/operations/maintenance-io.mjs
 * @description Card 105 — the REAL io for `maintenance.mjs`. Bound only from `run.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPauseState, writePauseState, setPause, clearPause } from '../readiness/dispatch-pause.mjs';
import { fixDispatchKillFile } from '../conveyor/fix-loop-ledger.mjs';
import { readMaintenanceMarker, writeMaintenanceMarker, clearMaintenanceMarker } from '../conveyor/maintenance-marker.mjs';
import { defaultListAgents } from './dispatch-lane-io.mjs';
import { MAINTENANCE_EFFECT, runMaintenance } from './maintenance.mjs';

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'maintenance-policy.json');
const DEFAULT_TEST = { prompt: 'Reply with exactly the single word: OK', expect: 'OK', timeoutSeconds: 120, model: 'haiku' };

export function loadMaintenancePolicy({ path = POLICY_PATH } = {}) {
  try {
    const t = JSON.parse(readFileSync(path, 'utf8'))?.testSession ?? {};
    return { ...DEFAULT_TEST, ...Object.fromEntries(Object.entries(t).filter(([k, v]) => k in DEFAULT_TEST && typeof v === typeof DEFAULT_TEST[k])) };
  } catch { return { ...DEFAULT_TEST }; }
}

export function runTestSession({ exec = execFileSync, policy = loadMaintenancePolicy() } = {}) {
  try {
    const out = String(exec('claude', ['-p', policy.prompt, '--model', policy.model], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: policy.timeoutSeconds * 1000, killSignal: 'SIGKILL',
    }));
    return out.includes(policy.expect) ? { ok: true, detail: out.trim().slice(0, 200) } : { ok: false, detail: `unexpected reply: ${out.trim().slice(0, 200)}` };
  } catch (e) {
    return { ok: false, detail: String(e?.stderr || e?.stdout || e?.message || e).trim().slice(0, 300) };
  }
}

export function createMaintenanceIo({ env = process.env } = {}) {
  const kill = () => fixDispatchKillFile(env);
  return {
    readMarker: () => readMaintenanceMarker(),
    writeMarker: (m) => writeMaintenanceMarker(m),
    clearMarker: () => clearMaintenanceMarker(),
    readPause: () => readPauseState(),
    setPause: ({ reason, by }) => writePauseState(setPause({ reason, by })),
    clearPause: () => writePauseState(clearPause()),
    killExists: () => existsSync(kill()),
    touchKill: () => { mkdirSync(dirname(kill()), { recursive: true }); writeFileSync(kill(), `maintenance ${new Date().toISOString()}\n`); },
    removeKill: () => rmSync(kill(), { force: true }),
    listSessions: () => { try { return defaultListAgents({ all: false }).filter((a) => a?.kind === 'background'); } catch { return []; } },
    testSession: () => runTestSession(),
    now: () => new Date().toISOString(),
  };
}

/** The effect sink `run.mjs` binds. Throws (halting the run, everything still paused) when `end`'s login test fails. */
export function createMaintenanceSinks({ io = createMaintenanceIo() } = {}) {
  return { [MAINTENANCE_EFFECT]: async (payload) => runMaintenance(payload, io) };
}
