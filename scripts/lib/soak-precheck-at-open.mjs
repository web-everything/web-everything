import { evaluateSoakReplayGate } from './soak-replay-gate.mjs';
import { isDaemonSoakScopePath } from './daemon-soak-scope.mjs';

export const SOAK_PRECHECK_ENV = 'WE_PR_OPEN_SOAK_PRECHECK';

export function soakPrecheckEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env[SOAK_PRECHECK_ENV] ?? ''));
}

/** Parse raw `git diff --name-status -z` output without quoting or whitespace loss. */
export function parseSoakNameStatus(diff) {
  if (typeof diff !== 'string' || (diff && !diff.endsWith('\0'))) {
    throw new Error('incomplete name-status output');
  }
  const fields = diff ? diff.slice(0, -1).split('\0') : [];
  const types = { A: 'ADDED', M: 'MODIFIED', D: 'DELETED', T: 'MODIFIED', U: 'UNMERGED', X: 'UNKNOWN' };
  const files = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++];
    // Git pads similarity scores to three digits; accept both padded and short scores.
    const paired = /^[RC][0-9]{1,3}$/.test(code) && Number(code.slice(1)) <= 100;
    if (!paired && !Object.hasOwn(types, code)) throw new Error('unknown name-status code');
    const source = fields[i++];
    const path = paired ? fields[i++] : source;
    if (!source || !path) throw new Error('missing name-status path');
    files.push({ path, changeType: paired ? (code[0] === 'R' ? 'RENAMED' : 'ADDED') : types[code] });
  }
  return files;
}

// Timing metadata is bot-owned; admission only enforces replay coverage.
export function soakPrecheckAtOpen({ title, body, files, env }) {
  if (!soakPrecheckEnabled(env)) return { ok: true, skipped: 'disabled' };
  const gate = evaluateSoakReplayGate({ title, body, files });
  const refuseMetadata = reason => ({ ok: false, applicable: gate.applicable, reason,
      message: `soak precheck (${SOAK_PRECHECK_ENV}): ${reason}. Fix: supply a complete NUL-delimited diff with known daemon-soak change types, then retry.` });
  if (!Array.isArray(files)) return refuseMetadata('unavailable file list');
  // Unknown metadata must not fabricate replay evidence. Unrelated files do not
  // participate in this gate; valid Git filenames may contain quotes or whitespace.
  for (const file of files) {
    const path = typeof file === 'string' ? file : file?.path;
    if (typeof path !== 'string' || !path || path.includes('\0')) return refuseMetadata('invalid file path');
    if (!isDaemonSoakScopePath(path)) continue;
    if (path.split('/').some(part => !part || part === '.' || part === '..')) return refuseMetadata('non-canonical daemon-soak path');
    const changeType = typeof file === 'string' ? 'ADDED'
      : typeof file.changeType === 'string' ? file.changeType.toUpperCase() : '';
    if (!['ADDED', 'RENAMED', 'MODIFIED', 'DELETED'].includes(changeType)) {
      return refuseMetadata('unknown file change type');
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
