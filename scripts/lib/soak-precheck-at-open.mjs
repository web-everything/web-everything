import { evaluateSoakReplayGate } from './soak-replay-gate.mjs';

export const SOAK_PRECHECK_ENV = 'WE_PR_OPEN_SOAK_PRECHECK';

export function soakPrecheckEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env[SOAK_PRECHECK_ENV] ?? ''));
}

export function soakPrecheckAtOpen({ title, body, files, env }) {
  if (!soakPrecheckEnabled(env)) return { ok: true, skipped: 'disabled' };
  const { ok, applicable, reason } = evaluateSoakReplayGate({ title, body, files });
  const message = ok ? reason
    : `soak precheck (${SOAK_PRECHECK_ENV}): ${reason}. The soak-replay-gate CI check WILL go red. ` +
      'Fix ONE of: (a) add a break scenario under scripts/conveyor/soak/breaks/ ' +
      '(module + its .soak.test.mjs, registered in breaks/index.mjs — e.g. daemon-overlay-lock-wait) and commit it; ' +
      'or (b) add a line `soak-waiver: <why this fix needs no replay>` to the PR body file passed via --body-file. ' +
      `Then re-run. (Set ${SOAK_PRECHECK_ENV}=0 to skip this local check; CI still enforces it.)`;
  return { ok, applicable, reason, message };
}
