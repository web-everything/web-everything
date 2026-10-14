/** Optional operator-card metadata; shared by filing and the standards gate. Pure. */
export const EDGE_CLONE_NAMES = Object.freeze(['review', 'fix', 'control', 'drain', 'health-watch']);
// Same shape as dispatch-lane BRIEF_TOKEN_RE: the composed brief is filled again, which would rewrite or refuse it.
export const BRIEF_TOKEN_SHAPE = /\{\{\s*[^{}\n]*?\s*\}\}/;
export function validateOperatorTask(item) {
  const errors = [];
  if (item.operatorTask !== undefined && typeof item.operatorTask !== 'boolean') errors.push('operatorTask must be a boolean');
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
export function operatorTaskFields(input) {
  const fields = {};
  if (input.operatorTask === true) fields.operatorTask = true;
  if (input.edgeClone) fields.edgeClone = input.edgeClone;
  if (input['liveProof-command'] || input['liveProof-expect']) fields.liveProof = { command: input['liveProof-command'], expect: input['liveProof-expect'] };
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
