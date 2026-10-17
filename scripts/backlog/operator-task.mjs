/** Optional operator-card metadata; shared by filing and the standards gate. Pure. Verified operator-task
 *  authority (a recorded operator instruction, and what it gates) is card #xqqmw6g, not this module. */

export const EDGE_CLONE_NAMES = Object.freeze(['review', 'fix', 'control', 'drain', 'health-watch']);
// Same shape as dispatch-lane BRIEF_TOKEN_RE: the composed brief is filled again, which would rewrite or refuse it.
export const BRIEF_TOKEN_SHAPE = /\{\{\s*[^{}\n]*?\s*\}\}/;

/** Shape errors of the operator-card fields. */
export function validateOperatorTask(item) {
  const errors = [];
  if (item.operatorTask !== undefined && typeof item.operatorTask !== 'boolean') errors.push('operatorTask must be a boolean');
  // Post-build fields never take effect without the flag, so refuse them rather than ignore them silently.
  if (item.operatorTask !== true && (item.edgeClone !== undefined || item.liveProof !== undefined || item.report === true)) errors.push('edgeClone, liveProof and report require operatorTask: true');
  if (item.edgeClone !== undefined && !EDGE_CLONE_NAMES.includes(item.edgeClone)) errors.push('edgeClone must be a daemon name: ' + EDGE_CLONE_NAMES.join(', ') + '; paths are refused');
  if (item.report !== undefined && typeof item.report !== 'boolean') errors.push('report must be a boolean');
  if (item.liveProof !== undefined) {
    const p = item.liveProof;
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.command !== 'string' || !p.command.trim() || typeof p.expect !== 'string' || !p.expect.trim()) errors.push('liveProof requires nonempty command and expect strings');
    else if (BRIEF_TOKEN_SHAPE.test(p.command) || BRIEF_TOKEN_SHAPE.test(p.expect)) errors.push('liveProof must not contain {{...}} brief tokens');
    else if (p.expect.startsWith('/')) {
      const match = /^\/(.*)\/([imsu]*)$/s.exec(p.expect);
      try { if (!match) throw new Error(); new RegExp(match[1], match[2]); } catch { errors.push('liveProof.expect has an invalid /regex/flags'); }
    }
  }
  return errors;
}
export function operatorTaskFields(input, { role } = {}) {
  const fields = {};
  if (input.operatorTask === true) {
    // Trust boundary (the pre-PR bypass rule, we:scripts/lib/pre-pr-review.mjs#authoriseBypass): a dispatched
    // worker never files an operator task, and an unknown or absent session role fails closed.
    if (role !== 'orchestrator') {
      throw new Error(`operatorTask is refused for session role "${role ?? 'unknown'}": only an interactive operator session (no WE_CONVEYOR_WORKER marker) filing through file-item may file an operator task`);
    }
    fields.operatorTask = true;
  }
  // Edge-load and live-proof steps are off for every card (we:scripts/operations/operator-task-brief.mjs
  // #planOperatorPostBuild), so filing them would record a step that never runs: refuse rather than ignore.
  if (input.edgeClone || input['liveProof-command'] || input['liveProof-expect']) {
    throw new Error('--edgeClone and --liveProof-* are refused: edge-load and live-proof post-build steps are off for every card until operator-task authority is verified (#xqqmw6g)');
  }
  if (input.report !== undefined && input.report !== '') {
    if (![true, false, 'true', 'false'].includes(input.report)) throw new Error('report must be a boolean');
    if (input.report === true || input.report === 'true') fields.report = true;
  }
  const errors = validateOperatorTask(fields);
  if (errors.length) throw new Error(errors.join('; '));
  return fields;
}
export const OPERATOR_TASK_INPUT = Object.freeze({
  operatorTask: { type: 'boolean', required: false, default: false },
  edgeClone: { type: 'string', required: false, default: '' },
  'liveProof-command': { type: 'string', required: false, default: '' },
  'liveProof-expect': { type: 'string', required: false, default: '' },
  report: { type: 'boolean', required: false, default: false },
});
export const OPERATOR_TASK_READS = Object.keys(OPERATOR_TASK_INPUT).map(k => `input.${k}`);
