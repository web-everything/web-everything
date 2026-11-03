import { evaluateSoakReplayGate } from './soak-replay-gate.mjs';

export const SOAK_PRECHECK_ENV = 'WE_PR_OPEN_SOAK_PRECHECK';
export const OPERATOR_ACTOR = 'chalbert';
export const WAIVER_NOT_OPERATOR = 'soak-waiver-not-operator';

export function soakPrecheckEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env[SOAK_PRECHECK_ENV] ?? ''));
}

// A waiver carries an operator signature when the operator is the acting author, or its reason cites a ruling
// id (R<n>) that exists in the operator rulings digest. Anything unknown fails closed.
function waiverIsOperatorSigned({ waiver, actor, rulingsText }) {
  if (String(actor || '').trim().toLowerCase() === OPERATOR_ACTOR) return true;
  const text = String(rulingsText || '');
  if (!text) return false;
  for (const m of String(waiver).matchAll(/\bR(\d+)\b/g)) {
    if (new RegExp(`^\\W*R${m[1]}\\b`, 'm').test(text)) return true;
  }
  return false;
}

export function soakPrecheckAtOpen({ title, body, files, env, actor = '', rulingsText = '' }) {
  if (!soakPrecheckEnabled(env)) return { ok: true, skipped: 'disabled' };
  let { ok, applicable, reason, waiver } = evaluateSoakReplayGate({ title, body, files });
  if (ok && waiver && !waiverIsOperatorSigned({ waiver, actor, rulingsText })) {
    ok = false;
    reason = `${WAIVER_NOT_OPERATOR}: the body's soak-waiver line carries no operator signature`;
  } else if (!ok) {
    reason = 'this PR touches daemon-soak scope and reads as a bug fix, but adds/changes no file under ' +
      'scripts/conveyor/soak/breaks/';
  }
  const message = ok ? reason
    : `soak precheck (${SOAK_PRECHECK_ENV}): ${reason}. The soak-replay-gate CI check WILL go red. ` +
      'Fix: add a soak break under scripts/conveyor/soak/breaks/ ' +
      '(module + its .soak.test.mjs, registered in breaks/index.mjs; see an existing break for the shape) and commit it. ' +
      `Then re-run. (Set ${SOAK_PRECHECK_ENV}=0 to skip this local check; CI still enforces it.)`;
  return { ok, applicable, reason, message };
}
