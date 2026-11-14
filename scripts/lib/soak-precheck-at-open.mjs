import { evaluateSoakReplayGate } from './soak-replay-gate.mjs';
import { loadTimings } from '../ci/shard-assign.mjs';

export const SOAK_PRECHECK_ENV = 'WE_PR_OPEN_SOAK_PRECHECK';

export function soakPrecheckEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env[SOAK_PRECHECK_ENV] ?? ''));
}

export function soakPrecheckAtOpen({ title, body, files, env, timings }) {
  if (!soakPrecheckEnabled(env)) return { ok: true, skipped: 'disabled' };
  const gate = evaluateSoakReplayGate({ title, body, files });
  const { ok, applicable } = gate;
  // The gate's own reason offers a waiver; an agent actor is never told about one (only the break fix).
  const reason = ok ? gate.reason
    : 'this PR touches daemon-soak scope and reads as a bug fix, but adds/changes no file under scripts/conveyor/soak/breaks/';
  const message = ok ? reason
    : `soak precheck (${SOAK_PRECHECK_ENV}): ${reason}. The soak-replay-gate CI check WILL go red. ` +
      'Fix: add a soak break under scripts/conveyor/soak/breaks/ ' +
      '(module + its .soak.test.mjs, registered in breaks/index.mjs; see an existing break for the shape) and commit it. ' +
      `Then re-run. (Set ${SOAK_PRECHECK_ENV}=0 to skip this local check; CI still enforces it.)`;
  const verdict = { ok, applicable, reason, message };
  const addedBreakTests = (Array.isArray(files) ? files : [])
    .filter(file => /^(ADDED|RENAMED)$/i.test(String(file?.changeType)) &&
      /^scripts\/conveyor\/soak\/breaks\/[^/]+\.soak\.test\.mjs$/.test(file?.path))
    .map(file => file.path);
  if (!addedBreakTests.length) return verdict;
  if (timings === undefined) {
    try { timings = loadTimings().soak; }
    catch { return verdict; } // Unreadable timings skip only this local check.
  }
  const missingTimings = [...new Set(addedBreakTests.filter(path => !Object.hasOwn(timings, path)))];
  if (!missingTimings.length) return verdict;
  const timingReason = 'added soak break tests have no shard timing entries';
  const timingMessage = `soak precheck (${SOAK_PRECHECK_ENV}): ${timingReason}. Fix: add ` +
    missingTimings.map(path => `${JSON.stringify(path)}: 2`).join(', ') +
    ' inside the "soak" object of scripts/ci/test-timings.json. ' +
    `Then re-run. (Set ${SOAK_PRECHECK_ENV}=0 to skip this local check; CI still enforces it.)`;
  return { ...verdict, ok: false, reason: ok ? timingReason : reason,
    message: ok ? timingMessage : message, missingTimings };
}
