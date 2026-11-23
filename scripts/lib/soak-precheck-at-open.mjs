import { execFileSync } from 'node:child_process';
import { evaluateSoakReplayGate } from './soak-replay-gate.mjs';

export const SOAK_PRECHECK_ENV = 'WE_PR_OPEN_SOAK_PRECHECK';

export function soakPrecheckEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env[SOAK_PRECHECK_ENV] ?? ''));
}

// The bot-owned shared timing map is optional; per-test sidecars supply admission evidence.
export function soakPrecheckAtOpen({ title, body, files, env, refSha, repoRoot = process.cwd() }) {
  if (!soakPrecheckEnabled(env)) return { ok: true, skipped: 'disabled' };
  const gate = evaluateSoakReplayGate({ title, body, files });
  const refuseMetadata = reason => ({ ok: false, applicable: gate.applicable, reason,
    message: `soak precheck (${SOAK_PRECHECK_ENV}): ${reason}. Fix: supply a complete diff with canonical, unquoted paths and known change types, then retry.` });
  if (!Array.isArray(files)) return refuseMetadata('unavailable file list');
  // Admission evidence belongs to the test, not the bot-owned shared sharding map.
  // Check all added/renamed soak tests, including test-only PRs and waived fixes.
  for (const file of files) {
    const path = typeof file === 'string' ? file : file?.path;
    // Git's C-quoted paths must never fall through the prefix/suffix filter.
    if (typeof path !== 'string' || path.startsWith('"') || /[\\\x00-\x1f\x7f]/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..')) {
      return refuseMetadata('invalid or Git-quoted file path');
    }
    const changeType = typeof file === 'string' ? 'ADDED'
      : typeof file.changeType === 'string' ? file.changeType.toUpperCase() : '';
    if (!['ADDED', 'RENAMED', 'MODIFIED', 'DELETED'].includes(changeType)) {
      return refuseMetadata('unknown file change type');
    }
    if (!path.startsWith('scripts/conveyor/soak/') || !path.endsWith('.soak.test.mjs')) continue;
    if (changeType === 'MODIFIED' || changeType === 'DELETED') continue;
    const sidecar = `${path}.timing.json`;
    try {
      if (typeof refSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(refSha)) {
        throw new Error('missing or invalid ref sha');
      }
      // Read the immutable commit being published; uncommitted working files are not evidence.
      const timing = JSON.parse(execFileSync('git', ['show', `${refSha}:${sidecar}`], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000, maxBuffer: 64 * 1024,
      }));
      if (!timing || typeof timing !== 'object' || Array.isArray(timing) ||
          Object.keys(timing).length !== 1 || !Object.hasOwn(timing, 'seconds') ||
          !Number.isFinite(timing.seconds) || timing.seconds <= 0) {
        throw new Error('invalid timing schema');
      }
    } catch {
      const reason = `missing, unreadable or invalid soak timing sidecar: ${sidecar}`;
      return { ok: false, applicable: gate.applicable, reason,
        message: `soak precheck (${SOAK_PRECHECK_ENV}): ${reason}. ` +
          'Fix: measure the soak test and commit its sidecar containing only {"seconds": <positive finite number>}. ' +
          'The test author owns this measurement and refreshes it when runtime changes.' };
    }
  }
  const { ok, applicable } = gate;
  // The gate's own reason offers a waiver; an agent actor is never told about one (only the break fix).
  const reason = ok ? gate.reason
    : 'this PR touches daemon-soak scope and reads as a bug fix, but adds/changes no file under scripts/conveyor/soak/breaks/';
  const message = ok ? reason
    : `soak precheck (${SOAK_PRECHECK_ENV}): ${reason}. The soak-replay-gate CI check WILL go red. ` +
      'Fix: add a soak break under scripts/conveyor/soak/breaks/ ' +
      '(module + its .soak.test.mjs, registered in breaks/index.mjs; see an existing break for the shape) and commit it. ' +
      `Then re-run. (Set ${SOAK_PRECHECK_ENV}=0 to skip this local check; CI still enforces it.)`;
  return { ok, applicable, reason, message };
}
