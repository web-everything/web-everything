/** R247: a declared, single-PR manual daemon pass. All effects live in the IO shell. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

export const MANUAL_DAEMON_PASS_OP = 'manual-daemon-pass';
export const MANUAL_DAEMON_PASS_EFFECT = 'manual-daemon-pass.run';
export const MANUAL_DAEMONS = Object.freeze(['review', 'red-team', 'fix', 'verify']);

export function validateManualPass(input = {}) {
  if (!MANUAL_DAEMONS.includes(input.daemon)) throw new Error('manual-daemon-pass: --daemon must be review|red-team|fix|verify');
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0) throw new Error('manual-daemon-pass: --pr must be a positive safe integer');
  if (typeof input.repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repo)) {
    throw new Error('manual-daemon-pass: --repo must be owner/name');
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || /[\p{Cc}\p{Cf}]/u.test(input.reason)) {
    throw new Error('manual-daemon-pass: --reason must be nonempty text without control characters');
  }
  return { ...input, reason: input.reason.trim() };
}

/** Red-team seats are owned by the review daemon, including its redTeamOnly dispatch. */
export function assertManualPassAllowed(input, snapshot) {
  const kind = input.daemon === 'fix' ? 'fix-dispatch-daemon' : 'review-daemon';
  const rows = snapshot?.daemons?.filter(row => row.kind === kind);
  if (!rows?.length || rows.some(row => row.state === 'unreadable' || row.rebuild?.corrupt
    || row.rebuild?.available !== true || !['down', 'alive', 'alive-and-stalled', 'alive-and-refusing'].includes(row.state))) {
    throw new Error('manual-daemon-pass: daemon health/quarantine evidence unavailable; inspect daemon-status and repair its readers before retrying');
  }
  if (!input['force-while-healthy'] && rows.some(row => row.state === 'alive' && !row.rebuild.state?.quarantine)) {
    throw new Error('manual-daemon-pass: target daemon is healthy and not quarantined; use --force-while-healthy for an intentional R247 override');
  }
}

export function manualDaemonPassOperation() {
  return op(MANUAL_DAEMON_PASS_OP, {
    input: {
      daemon: { type: 'string', enum: [...MANUAL_DAEMONS] },
      pr: 'number', repo: 'string', reason: 'string',
      'force-while-healthy': { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input.daemon', 'input.pr', 'input.repo', 'input.reason', 'input.force-while-healthy'],
      fn: ({ input }) => validateManualPass(input) }),
    run: effect({ reads: ['verdict'], effects: ({ verdict }) => [{
      type: MANUAL_DAEMON_PASS_EFFECT, idempotent: false, payload: verdict,
    }] }),
  });
}
